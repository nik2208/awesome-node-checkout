import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  PaymentsController,
  VaultController,
} from '@paypal/paypal-server-sdk';
import type {
  CheckoutPaymentIntent,
  Order,
  OrderRequest,
  PaymentInitiator,
  PaypalExperienceUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  StoredPaymentSourceUsageType,
  StoreInVaultInstruction,
  UsagePattern,
} from '@paypal/paypal-server-sdk';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { IMandateProvider } from '../../interfaces/mandate-provider.interface';
import {
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from '../../models/mandate.model';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';
import { parseAmount } from '../../utils/parsing.util';
import { isInvalidAmountError, toMajorString, toMinorUnits } from '../../utils/money';
import { appendMandateRef } from '../../utils/url';
import { redactSecret } from '../../utils/redact';

export interface PayPalProviderConfig {
  clientId: string;
  clientSecret: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'live';
  /** Vault customer type of the payment tokens saved by `createMandate`. @default 'CONSUMER' */
  customerType?: 'CONSUMER' | 'BUSINESS';
}

const SETUP_NOT_MATCHING = 'Outcome does not match the pending setup';
const ORDER_NOT_MATCHING = 'Order does not match the pending setup';
const CAPTURED_AMOUNT_MISMATCH = 'Captured amount does not match';
const DUPLICATE_CHARGE =
  'A charge with this chargeRef was already submitted; reconcile it in PayPal';

/** True when `value` + `currency` (as PayPal reports them) are `amount` + `expectedCurrency`. */
function sameMoney(value: unknown, currency: unknown, amount: number, expectedCurrency: string): boolean {
  if (typeof currency !== 'string' || typeof expectedCurrency !== 'string') return false;
  if (currency.trim().toUpperCase() !== expectedCurrency.trim().toUpperCase()) return false;
  const parsed = parseAmount(value);
  if (parsed === undefined) return false;
  try {
    return toMinorUnits(parsed, expectedCurrency) === toMinorUnits(amount, expectedCurrency);
  } catch {
    return false;
  }
}

/** First purchase unit of an order, or undefined. */
function firstPurchaseUnit(order: unknown): any {
  const units = (order as any)?.purchaseUnits;
  return Array.isArray(units) ? units[0] : undefined;
}

/** First capture of an order's first purchase unit, or undefined. */
/**
 * The order with its vault token id scrubbed: used for every outcome that returns no mandate, since
 * the core redacts only `mandate.providerMandateId` from events. A token that is not `VAULTED`
 * (yet) may still become usable, so its id never goes out in `raw`.
 */
function withoutVaultId<T>(order: T): T {
  const id = (order as any)?.paymentSource?.paypal?.attributes?.vault?.id;
  return typeof id === 'string' && id !== '' ? redactSecret(order, id) : order;
}

function firstCapture(order: unknown): any {
  const captures = firstPurchaseUnit(order)?.payments?.captures;
  return Array.isArray(captures) ? captures[0] : undefined;
}

/**
 * PayPal Checkout provider.
 * Flow: `redirect` — creates an order, redirects the user to PayPal,
 * then captures the payment on return via `handleRedirect`.
 */
export class PayPalProvider extends BasePaymentProvider implements IMandateProvider {
  readonly name = 'paypal';
  readonly flow = 'redirect' as const;

  private client: Client;
  private ordersController: OrdersController;
  private paymentsController: PaymentsController;
  private vaultController: VaultController;

  constructor(private readonly config: PayPalProviderConfig) {
    super();
    const { clientId, clientSecret, environment = 'sandbox' } = config;

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      environment:
        environment === 'live' ? Environment.Production : Environment.Sandbox,
      logging: {
        logLevel: LogLevel.Error,
      },
    });

    this.ordersController = new OrdersController(this.client);
    this.paymentsController = new PaymentsController(this.client);
    this.vaultController = new VaultController(this.client);
  }

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const value = toMajorString(request.amount, request.currency);
      const { result: order } = await this.ordersController.createOrder({
        body: {
          intent: 'CAPTURE' as any,
          purchaseUnits: [
            {
              amount: {
                currencyCode: request.currency,
                value,
              },
              description: request.description,
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                returnUrl: request.returnUrl,
                cancelUrl: request.cancelUrl,
              },
            },
          },
        },
        prefer: 'return=representation',
      });

      const approvalUrl = order.links?.find(
        (l: any) => l.rel === 'payer-action' || l.rel === 'approve',
      )?.href;

      return {
        success: true,
        paymentId: order.id as string,
        approvalUrl,
        status: order.status as string,
        raw: order,
      };
    } catch (error) {
      if (isInvalidAmountError(error)) {
        return { success: false, error: error.message, status: 'FAILED' };
      }
      return this.errorResult(error, 'Failed to create PayPal payment');
    }
  }

  async executePayment(paymentId: string): Promise<PaymentResult> {
    try {
      const { result: order } = await this.ordersController.captureOrder({
        id: paymentId,
        body: {},
        prefer: 'return=representation',
      });

      const pu = Array.isArray((order as any)?.purchaseUnits)
        ? (order as any).purchaseUnits[0]
        : undefined;
      const capture = pu?.payments?.captures?.[0];
      const captureStatus = typeof capture?.status === 'string' ? capture.status : undefined;
      const amount = parseAmount(capture?.amount?.value);
      const currency = typeof capture?.amount?.currencyCode === 'string' ? capture.amount.currencyCode : undefined;
      const isCaptureCompleted = captureStatus === 'COMPLETED' && amount !== undefined && amount > 0 && !!currency && currency.trim() !== '';
      const status = captureStatus ?? 'NO_CAPTURE';

      return {
        success: isCaptureCompleted,
        // Outcome read from the PayPal API over the OAuth-authenticated server-to-server channel
        verified: true,
        paymentId: order.id as string,
        status,
        captureStatus,
        amount,
        currency,
        raw: order,
        ...(isCaptureCompleted
          ? {}
          : {
              error:
                !capture
                  ? 'Payment capture not found'
                  : captureStatus === 'COMPLETED'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment capture status is ${captureStatus ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to execute PayPal payment');
    }
  }

  async getPaymentDetails(paymentId: string): Promise<PaymentResult> {
    try {
      const { result: order } = await this.ordersController.getOrder({
        id: paymentId,
      });

      const pu = Array.isArray((order as any)?.purchaseUnits)
        ? (order as any).purchaseUnits[0]
        : undefined;
      const capture = pu?.payments?.captures?.[0];
      const captureStatus = typeof capture?.status === 'string' ? capture.status : undefined;
      const amount = parseAmount(capture?.amount?.value);
      const currency = typeof capture?.amount?.currencyCode === 'string' ? capture.amount.currencyCode : undefined;
      const isCaptureCompleted = captureStatus === 'COMPLETED' && amount !== undefined && amount > 0 && !!currency && currency.trim() !== '';
      const status = captureStatus ?? 'NO_CAPTURE';

      return {
        success: isCaptureCompleted,
        // Outcome read from the PayPal API over the OAuth-authenticated server-to-server channel
        verified: true,
        paymentId: order.id as string,
        status,
        captureStatus,
        amount,
        currency,
        raw: order,
        ...(isCaptureCompleted
          ? {}
          : {
              error:
                !capture
                  ? 'Payment capture not found'
                  : captureStatus === 'COMPLETED'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment capture status is ${captureStatus ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get PayPal payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      // Retrieve order to find the capture ID and currency
      const { result: order } = await this.ordersController.getOrder({ id: paymentId });

      // The PayPal SDK types nested objects as `any`; extract with explicit guards
      const purchaseUnit = Array.isArray((order as any)?.purchaseUnits)
        ? (order as any).purchaseUnits[0]
        : undefined;
      const captureId: string | undefined =
        Array.isArray(purchaseUnit?.payments?.captures) && purchaseUnit.payments.captures.length > 0
          ? String(purchaseUnit.payments.captures[0].id)
          : undefined;

      if (!captureId) {
        return {
          success: false,
          error: 'No capture found for this order. Ensure the payment has been captured before refunding.',
          paymentId,
          status: 'REFUND_FAILED',
        };
      }

      const refundBody: Record<string, unknown> = {};
      if (amount !== undefined) {
        const currencyCode = typeof purchaseUnit?.amount?.currencyCode === 'string'
          ? purchaseUnit.amount.currencyCode
          : undefined;
        if (!currencyCode) {
          return {
            success: false,
            error: 'Cannot determine currency code from order. Refund a specific amount is not possible.',
            paymentId,
            status: 'REFUND_FAILED',
          };
        }
        refundBody['amount'] = { value: toMajorString(amount, currencyCode), currencyCode };
      }

      const { result: refund } = await this.paymentsController.refundCapturedPayment({
        captureId,
        body: refundBody as any,
      });

      return {
        success: (refund as any)?.status === 'COMPLETED',
        verified: true,
        paymentId: String((refund as any)?.id ?? ''),
        status: String((refund as any)?.status ?? ''),
        raw: refund,
      };
    } catch (error) {
      if (isInvalidAmountError(error)) {
        return { success: false, error: error.message, status: 'FAILED' };
      }
      return this.errorResult(error, 'Failed to refund PayPal payment');
    }
  }

  /**
   * Handles the redirect from PayPal after the user approves the payment.
   * PayPal appends `token` (order ID) and `PayerID` to the returnUrl.
   */
  async handleRedirect(query: Record<string, string>): Promise<PaymentResult> {
    const paymentId = query['token'];
    if (!paymentId) {
      return {
        success: false,
        error: 'Missing token in PayPal redirect query',
      };
    }
    return this.executePayment(paymentId);
  }

  // -------------------------------------------------------------------------
  // Recurring payments (mandates): PayPal Vault, saved during the first purchase
  // -------------------------------------------------------------------------

  /**
   * HTTP status and PayPal issue of a failed SDK call: `statusCode` of the SDK `ApiError`, and
   * `details[0].issue` (or `name`) of its parsed `result` or JSON `body`. Both are undefined for
   * a network error. Never throws.
   */
  private apiIssue(err: unknown): { status?: number; issue?: string } {
    try {
      if (err === null || typeof err !== 'object') return {};
      const e = err as { statusCode?: unknown; result?: unknown; body?: unknown };
      const status =
        typeof e.statusCode === 'number' && Number.isInteger(e.statusCode) ? e.statusCode : undefined;
      let parsed: any = e.result;
      if ((parsed === null || typeof parsed !== 'object') && typeof e.body === 'string') {
        try {
          parsed = JSON.parse(e.body);
        } catch {
          parsed = undefined;
        }
      }
      let issue: string | undefined;
      if (parsed !== null && typeof parsed === 'object') {
        const detail = Array.isArray(parsed.details) ? parsed.details[0] : undefined;
        if (typeof detail?.issue === 'string' && detail.issue !== '') issue = detail.issue;
        else if (typeof parsed.name === 'string' && parsed.name !== '') issue = parsed.name;
      }
      return { status, issue };
    } catch {
      return {};
    }
  }

  /**
   * The PayPal error body only (name, message, debug_id, details): never the SDK error itself,
   * which carries the request and its headers (bearer token).
   */
  private apiErrorRaw(err: unknown): unknown {
    try {
      const result = (err as { result?: unknown } | null)?.result;
      return result !== null && typeof result === 'object' ? result : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Starts a setup: a PayPal order with the first charge that also saves the PayPal wallet in the
   * Vault (`store_in_vault: ON_SUCCESS`). `notifyUrl` is ignored (PayPal webhooks are out of scope).
   */
  async createMandate(request: MandateSetupRequest): Promise<MandateSetupStart> {
    try {
      const body: OrderRequest = {
        intent: 'CAPTURE' as CheckoutPaymentIntent,
        purchaseUnits: [
          {
            referenceId: request.orderId,
            invoiceId: request.orderId,
            customId: request.mandateRef,
            description: request.description,
            amount: {
              currencyCode: request.currency,
              value: toMajorString(request.amount, request.currency),
            },
          },
        ],
        paymentSource: {
          paypal: {
            attributes: {
              vault: {
                storeInVault: 'ON_SUCCESS' as StoreInVaultInstruction,
                usageType: 'MERCHANT' as PaypalPaymentTokenUsageType,
                customerType: (this.config.customerType ?? 'CONSUMER') as PaypalPaymentTokenCustomerType,
                usagePattern: 'SUBSCRIPTION_PREPAID' as UsagePattern,
                description: request.description,
                permitMultiplePaymentTokens: false,
              },
            },
            experienceContext: {
              returnUrl: appendMandateRef(request.returnUrl, request.mandateRef),
              cancelUrl: appendMandateRef(request.cancelUrl, request.mandateRef),
              shippingPreference: 'NO_SHIPPING' as PaypalWalletContextShippingPreference,
              userAction: 'PAY_NOW' as PaypalExperienceUserAction,
            },
          },
        },
      };
      const { result: order } = await this.ordersController.createOrder({
        body,
        paypalRequestId: `setup-${request.orderId}`,
        prefer: 'return=representation',
      });

      const orderId = typeof order?.id === 'string' && order.id !== '' ? order.id : undefined;
      if (!orderId) {
        return { success: false, error: 'PayPal did not return an order id', raw: order };
      }
      const approvalUrl = order.links?.find(
        (l: any) => l.rel === 'payer-action' || l.rel === 'approve',
      )?.href;

      return {
        success: true,
        approvalUrl,
        pending: {
          provider: this.name,
          mandateRef: request.mandateRef,
          orderId: request.orderId,
          amount: request.amount,
          currency: request.currency,
          providerRef: orderId,
          createdAt: new Date().toISOString(),
        },
        raw: order,
      };
    } catch (error) {
      if (isInvalidAmountError(error)) return { success: false, error: error.message };
      const { status } = this.apiIssue(error);
      return {
        success: false,
        error: status !== undefined ? `PayPal refused the setup (HTTP ${status})` : 'Failed to create PayPal mandate setup',
        raw: this.apiErrorRaw(error),
      };
    }
  }

  /**
   * Confirms a setup: re-reads the order server-to-server, checks it against `pending`, captures
   * it when approved (request id `capture-<orderId>`), then maps the first charge and the vault
   * token. The PayPal order id is always `pending.providerRef`, never a query value. Safe to
   * re-run with `{}`: a `COMPLETED` order is never captured again.
   */
  async confirmMandate(pending: MandatePendingState, input: MandateCallbackInput): Promise<MandateSetupOutcome> {
    const chargeRef = pending.orderId;
    const notTerminal = (error: string, raw?: unknown): MandateSetupOutcome => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'unknown', verified: false, chargeRef, error },
      error,
      ...(raw !== undefined ? { raw } : {}),
    });

    // 1. Binding: a return for another order must not touch this setup
    const token = input?.query?.token;
    if (token !== undefined && token !== null && token !== '' && token !== pending.providerRef) {
      return notTerminal(SETUP_NOT_MATCHING);
    }

    // 2. Read before capturing
    let order: Order;
    try {
      ({ result: order } = await this.ordersController.getOrder({ id: pending.providerRef }));
    } catch (error) {
      const { status } = this.apiIssue(error);
      return notTerminal(
        status !== undefined ? `PayPal order could not be read (HTTP ${status})` : 'PayPal order could not be read',
        this.apiErrorRaw(error),
      );
    }

    const pu = firstPurchaseUnit(order);
    const matches =
      pu?.customId === pending.mandateRef &&
      pu?.invoiceId === pending.orderId &&
      sameMoney(pu?.amount?.value, pu?.amount?.currencyCode, pending.amount, pending.currency);
    if (!matches) {
      // Never captured: no money is taken for an order that is not this setup's
      return {
        success: false,
        verified: true,
        terminal: true,
        firstCharge: { status: 'failed', verified: true, chargeRef, error: ORDER_NOT_MATCHING },
        error: ORDER_NOT_MATCHING,
        raw: withoutVaultId(order),
      };
    }

    // 3. Act on the order status
    const orderStatus = typeof order?.status === 'string' ? order.status : undefined;
    switch (orderStatus) {
      case 'APPROVED':
        try {
          ({ result: order } = await this.ordersController.captureOrder({
            id: pending.providerRef,
            paypalRequestId: `capture-${pending.orderId}`,
            prefer: 'return=representation',
          }));
        } catch (error) {
          const { status, issue } = this.apiIssue(error);
          if (status === undefined || issue !== 'ORDER_ALREADY_CAPTURED') {
            return notTerminal(
              status !== undefined
                ? `PayPal capture outcome unknown (HTTP ${status}${issue ? ` ${issue}` : ''})`
                : 'PayPal capture outcome unknown',
              this.apiErrorRaw(error),
            );
          }
          // A concurrent confirm captured it first: re-read its result
          try {
            ({ result: order } = await this.ordersController.getOrder({ id: pending.providerRef }));
          } catch (readError) {
            return notTerminal('PayPal order could not be read after capture', this.apiErrorRaw(readError));
          }
        }
        break;
      case 'COMPLETED':
        // Already captured by an earlier confirm: idempotent beyond the request-id window
        break;
      case 'CREATED':
      case 'SAVED':
      case 'PAYER_ACTION_REQUIRED':
        // Not approved (yet): the customer may still approve, a cancel link must not end the setup
        return {
          success: false,
          verified: true,
          terminal: false,
          firstCharge: { status: 'unknown', verified: true, chargeRef, error: 'ORDER_NOT_APPROVED' },
          error: 'ORDER_NOT_APPROVED',
          raw: withoutVaultId(order),
        };
      case 'VOIDED':
        return {
          success: false,
          verified: true,
          terminal: true,
          firstCharge: { status: 'failed', verified: true, chargeRef, error: 'ORDER_VOIDED' },
          error: 'ORDER_VOIDED',
          raw: withoutVaultId(order),
        };
      default:
        return notTerminal(`Unexpected PayPal order status ${orderStatus ?? 'missing'}`, withoutVaultId(order));
    }

    // 4. First charge
    const firstCharge = this.mapSetupCapture(order, pending);

    // 5. Mandate
    const vault = order?.paymentSource?.paypal?.attributes?.vault;
    if (vault?.status === 'VAULTED' && typeof vault.id === 'string' && vault.id !== '') {
      return {
        success: true,
        verified: true,
        terminal: true,
        mandate: {
          provider: this.name,
          mandateRef: pending.mandateRef,
          providerMandateId: vault.id,
          status: 'active',
          createdAt: new Date().toISOString(),
          providerData: { customerId: vault.customer?.id ?? '' },
          unverified: { payerEmail: order.paymentSource?.paypal?.emailAddress },
        },
        firstCharge,
        raw: order,
      };
    }
    // The money may have been captured: the app refunds it or treats it as a one-off payment.
    // No mandate, so the core has no id to redact: a token still APPROVED/CREATED may become
    // VAULTED later and must not reach the mandate.setup_failed event.
    return {
      success: false,
      verified: true,
      terminal: true,
      firstCharge,
      error: 'MANDATE_NOT_VAULTED',
      raw: withoutVaultId(order),
    };
  }

  /** Maps the first capture of a setup order (`chargeRef = pending.orderId`). */
  private mapSetupCapture(order: Order, pending: MandatePendingState): ChargeResult {
    const chargeRef = pending.orderId;
    const cap = firstCapture(order);
    const capStatus = typeof cap?.status === 'string' ? cap.status : undefined;
    switch (capStatus) {
      case 'COMPLETED':
        if (!sameMoney(cap?.amount?.value, cap?.amount?.currencyCode, pending.amount, pending.currency)) {
          return { status: 'unknown', verified: true, chargeRef, error: CAPTURED_AMOUNT_MISMATCH };
        }
        return {
          status: 'succeeded',
          verified: true,
          chargeRef,
          // The order id: refundPayment(order.id) resolves the capture from it
          providerPaymentId: order.id,
          amount: parseAmount(cap.amount.value),
          currency: cap.amount.currencyCode,
        };
      case 'PENDING':
        return { status: 'unknown', verified: true, chargeRef, providerPaymentId: order.id, error: 'CAPTURE_PENDING' };
      case 'DECLINED':
      case 'FAILED':
        return { status: 'failed', verified: true, chargeRef, providerCode: capStatus, error: `Capture ${capStatus}` };
      default:
        return {
          status: 'unknown',
          verified: true,
          chargeRef,
          error: cap ? `Unexpected capture status ${capStatus ?? 'missing'}` : 'Payment capture not found',
        };
    }
  }

  /**
   * Merchant-initiated charge on the vaulted PayPal wallet: a new order paid with the vault id,
   * request id and invoice id `chargeRef`. Within PayPal's 6-hour request-id window a replay gets
   * the original response; after it, PayPal refuses the duplicate invoice id (`unknown`,
   * `DUPLICATE_INVOICE_ID`) when the account blocks multiple payments per invoice id. A replay
   * while the original is still in progress (409 `PREVIOUS_REQUEST_IN_PROGRESS`), and a 408, are
   * `unknown` too: the original may still take the money, so they are never a final `failed`.
   */
  async chargeMandate(mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    const chargeRef = charge.chargeRef;
    let value: string;
    try {
      value = toMajorString(charge.amount, charge.currency);
    } catch (error) {
      // Nothing was sent to PayPal
      return {
        status: 'failed',
        verified: false,
        chargeRef,
        error: error instanceof Error ? error.message : 'Invalid amount',
      };
    }

    let order: Order;
    try {
      const body: OrderRequest = {
        intent: 'CAPTURE' as CheckoutPaymentIntent,
        purchaseUnits: [
          {
            referenceId: chargeRef,
            invoiceId: chargeRef,
            customId: mandate.mandateRef,
            description: charge.description,
            amount: { currencyCode: charge.currency, value },
          },
        ],
        paymentSource: {
          paypal: {
            vaultId: mandate.providerMandateId,
            storedCredential: {
              paymentInitiator: 'MERCHANT' as PaymentInitiator,
              usage: 'SUBSEQUENT' as StoredPaymentSourceUsageType,
              usagePattern: 'SUBSCRIPTION_PREPAID' as UsagePattern,
            },
          },
        },
      };
      ({ result: order } = await this.ordersController.createOrder({
        body,
        paypalRequestId: chargeRef,
        prefer: 'return=representation',
      }));
    } catch (error) {
      const { status, issue } = this.apiIssue(error);
      const raw = this.apiErrorRaw(error);
      if (status === undefined) {
        return { status: 'unknown', verified: false, chargeRef, error: 'PayPal charge outcome unknown (network error)', raw };
      }
      if (status === 422 && issue === 'DUPLICATE_INVOICE_ID') {
        return {
          status: 'unknown',
          verified: false,
          chargeRef,
          providerCode: 'DUPLICATE_INVOICE_ID',
          error: DUPLICATE_CHARGE,
          raw,
        };
      }
      if (status === 408 || status === 409 || issue === 'PREVIOUS_REQUEST_IN_PROGRESS') {
        // Timeout, or a conflict with a request still in progress on the same request id: the
        // original may complete and charge, so a new chargeRef here could charge twice
        return {
          status: 'unknown',
          verified: false,
          chargeRef,
          providerCode: issue ?? String(status),
          error: `PayPal charge outcome unknown (HTTP ${status}${issue ? ` ${issue}` : ''})`,
          raw,
        };
      }
      if (status === 401 || status === 403 || status === 429) {
        // Merchant-side (credentials, permissions, rate limit): says nothing about the customer
        return {
          status: 'unknown',
          verified: false,
          chargeRef,
          providerCode: String(status),
          error: `PayPal refused the request (HTTP ${status})`,
          raw,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          status: 'failed',
          verified: true,
          chargeRef,
          providerCode: issue,
          error: `PayPal refused the charge (HTTP ${status}${issue ? ` ${issue}` : ''})`,
          raw,
        };
      }
      return {
        status: 'unknown',
        verified: false,
        chargeRef,
        providerCode: issue,
        error: `PayPal charge outcome unknown (HTTP ${status})`,
        raw,
      };
    }

    const orderStatus = typeof order?.status === 'string' ? order.status : undefined;
    const cap = firstCapture(order);
    const capStatus = typeof cap?.status === 'string' ? cap.status : undefined;
    const providerPaymentId = typeof order?.id === 'string' && order.id !== '' ? order.id : undefined;

    if (orderStatus === 'COMPLETED' && capStatus === 'COMPLETED') {
      return {
        status: 'succeeded',
        verified: true,
        chargeRef,
        providerPaymentId,
        // Taken from the capture: the configurator compares them with the request
        amount: parseAmount(cap?.amount?.value),
        currency: typeof cap?.amount?.currencyCode === 'string' ? cap.amount.currencyCode : undefined,
        raw: order,
      };
    }
    if (orderStatus === 'PAYER_ACTION_REQUIRED') {
      return { status: 'requires_action', verified: true, chargeRef, providerPaymentId, providerCode: orderStatus, raw: order };
    }
    if (capStatus === 'PENDING') {
      return { status: 'unknown', verified: true, chargeRef, providerPaymentId, error: 'CAPTURE_PENDING', raw: order };
    }
    if (capStatus === 'DECLINED' || capStatus === 'FAILED') {
      return {
        status: 'failed',
        verified: true,
        chargeRef,
        providerPaymentId,
        providerCode: capStatus,
        error: `Capture ${capStatus}`,
        raw: order,
      };
    }
    return {
      status: 'unknown',
      verified: true,
      chargeRef,
      providerPaymentId,
      error: `Unexpected PayPal outcome (order ${orderStatus ?? 'missing'}, capture ${capStatus ?? 'missing'})`,
      raw: order,
    };
  }

  /** Re-reads the vault payment token: present → `active`, 404 → `revoked`, otherwise `unknown`. */
  async getMandate(mandate: Mandate): Promise<MandateStatusResult> {
    try {
      await this.vaultController.getPaymentToken(mandate.providerMandateId);
      return { status: 'active', verified: true };
    } catch (error) {
      if (this.apiIssue(error).status === 404) return { status: 'revoked', verified: true };
      return { status: 'unknown', verified: false, raw: this.apiErrorRaw(error) };
    }
  }

  /** Deletes the vault payment token. A token that is already gone (404) counts as revoked. */
  async revokeMandate(mandate: Mandate): Promise<MandateRevokeResult> {
    try {
      await this.vaultController.deletePaymentToken(mandate.providerMandateId);
      return { revokedAtProvider: true };
    } catch (error) {
      const { status, issue } = this.apiIssue(error);
      if (status === 404) return { revokedAtProvider: true };
      return {
        revokedAtProvider: false,
        error:
          status !== undefined
            ? `PayPal could not delete the vault token (HTTP ${status}${issue ? ` ${issue}` : ''})`
            : 'PayPal could not delete the vault token',
        raw: this.apiErrorRaw(error),
      };
    }
  }
}
