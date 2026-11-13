import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  PaymentsController,
  TransactionSearchController,
  VaultController,
} from '@paypal/paypal-server-sdk';
import type {
  CapturedPayment,
  CheckoutPaymentIntent,
  Order,
  OrderRequest,
  PaymentInitiator,
  PaypalExperienceUserAction,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  SearchResponse,
  StoredPaymentSourceUsageType,
  StoreInVaultInstruction,
  TransactionDetails,
  UsagePattern,
} from '@paypal/paypal-server-sdk';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { IMandateProvider } from '../../interfaces/mandate-provider.interface';
import { IChargeLookupProvider } from '../../interfaces/charge-lookup-provider.interface';
import {
  ChargeLookupOptions,
  ChargeLookupResult,
  ChargeLookupStatus,
  ChargeProviderState,
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
import { RefundOptions, isRefundIdempotencyKey } from '../../models/refund.model';
import { parseAmount } from '../../utils/parsing.util';
import { currencyExponent, isInvalidAmountError, toMajorString, toMinorUnits } from '../../utils/money';
import { appendMandateRef } from '../../utils/url';
import { redactSecret } from '../../utils/redact';

export interface PayPalProviderConfig {
  clientId: string;
  clientSecret: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'live';
  /** Vault customer type of the payment tokens saved by `createMandate`. @default 'CONSUMER' */
  customerType?: 'CONSUMER' | 'BUSINESS';
  /**
   * Since 2.2.0. Timeout of every PayPal API call made by this provider, the OAuth token request included, in ms. It is
   * passed to the SDK `Client` as `timeout`. A call that exceeds it fails like a network error:
   * - `chargeMandate` → `unknown`;
   * - `confirmMandate` → unverified, non-terminal, with an `unknown` first charge;
   * - `getMandate` → `unknown`;
   * - `revokeMandate` → `revokedAtProvider: false`;
   * - `getCharge` → `unknown`;
   * - `createMandate`, `createPayment`, `executePayment`, `getPaymentDetails`, `refundPayment` → `success: false`
   *   without `verified` (the outcome is unknown: a capture or a refund may have happened; retry a refund only with
   *   the same `RefundOptions.idempotencyKey`).
   * A token request that times out fails only the calls waiting for that token, with nothing sent: the provider then
   * replaces its SDK client, and the next call requests a new token (since 2.2.0, for any failed token request).
   * Not set (default): no timeout, as in 2.1. A request PayPal never answers then waits forever, and a token request
   * that never answers stalls every later call of the provider. 30000 is a sensible value. This is the SDK's (axios)
   * inactivity timeout: a response that keeps trickling bytes is not cut off.
   * Only a finite number > 0 is used: any other value (`0`, negative, `NaN`, `Infinity`, a string) behaves as not set.
   */
  timeoutMs?: number;
}

const SETUP_NOT_MATCHING = 'Outcome does not match the pending setup';
const ORDER_NOT_MATCHING = 'Order does not match the pending setup';
const CAPTURED_AMOUNT_MISMATCH = 'Captured amount does not match';
const DUPLICATE_CHARGE =
  'A charge with this chargeRef was already submitted; reconcile it in PayPal';

// Charge lookup by invoice_id (Transaction Search, since 2.2.0)
const HOUR_MS = 60 * 60 * 1000;
/** Margin added on each side of `since` / `until` in the search window. */
const SEARCH_MARGIN_MS = HOUR_MS;
/** Longest `until - since`: with both margins the window stays within PayPal's 31-day maximum. */
const LOOKUP_MAX_SPAN_MS = 30 * 24 * HOUR_MS;
/** `absent` only this long after `until`: the 1-hour margin plus PayPal's 3-hour indexing delay. */
const LOOKUP_ABSENT_AFTER_MS = 4 * HOUR_MS;
/** `page_size` is 1-500 (Transaction Search schema). */
const SEARCH_PAGE_SIZE = 500;
const SEARCH_MAX_PAGES = 10;
/** More records with the invoice_id than this is ambiguous. */
const LOOKUP_MAX_RECORDS = 5;
const CAPTURE_NOT_MATCHING = 'PayPal capture does not match the charge';
const UNEXPECTED_SEARCH = 'Unexpected PayPal transaction search response';
const NOT_LISTED_YET = 'PayPal transaction search may not list this charge yet';

/** Capture status → lookup status and state. Any other value is `pending`: fail safe, like Nexi's unknown `stato`. */
const CAPTURE_LOOKUP = new Map<string, { status: ChargeLookupStatus; providerState?: ChargeProviderState }>([
  ['COMPLETED', { status: 'succeeded' }],
  ['PARTIALLY_REFUNDED', { status: 'succeeded', providerState: 'partially_refunded' }],
  ['REFUNDED', { status: 'succeeded', providerState: 'refunded' }],
  ['PENDING', { status: 'pending' }],
  ['DECLINED', { status: 'failed' }],
  ['FAILED', { status: 'failed' }],
]);

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
 * Since 2.2.0. Total of the `COMPLETED` refunds of an order's first purchase unit, in major units of `currency`,
 * summed in minor units (5.00 + 4.99 = 999 minor units = 9.99). Refunds are listed per purchase unit, not per
 * capture, so with more than one capture the total is not one capture's: undefined. A missing refunds list counts
 * as no refund (0). A `PENDING` refund is not counted: it may still complete. Undefined, never a guess, when a
 * counted refund has another currency (compared case-insensitively) or a value that is not a positive amount of
 * `currency`.
 */
function completedRefundTotal(order: unknown, currency: unknown): number | undefined {
  if (typeof currency !== 'string' || currency.trim() === '') return undefined;
  const payments = firstPurchaseUnit(order)?.payments;
  const captures = payments?.captures;
  if (Array.isArray(captures) && captures.length > 1) return undefined;
  const refunds = payments?.refunds ?? [];
  if (!Array.isArray(refunds)) return undefined;
  const code = currency.trim().toUpperCase();
  let minor = 0;
  for (const refund of refunds) {
    if (refund?.status !== 'COMPLETED') continue;
    const refundCurrency = refund?.amount?.currencyCode;
    if (typeof refundCurrency !== 'string' || refundCurrency.trim().toUpperCase() !== code) return undefined;
    const value = parseAmount(refund?.amount?.value);
    if (value === undefined || value <= 0) return undefined;
    try {
      minor += toMinorUnits(value, code);
    } catch {
      // More decimals than the currency allows
      return undefined;
    }
  }
  return minor / 10 ** currencyExponent(code);
}

/** Capture statuses that say part or all of the capture was refunded. */
const REFUNDED_CAPTURE_STATUSES: ReadonlySet<unknown> = new Set(['REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * The `refundedAmount` of a capture with `captureStatus`: `completedRefundTotal`, except that a `REFUNDED` or
 * `PARTIALLY_REFUNDED` capture whose order lists no COMPLETED refund (no refunds list, or only PENDING ones) gives
 * undefined. `0` would say "no refund" against the capture's own status: the total is not known.
 */
function captureRefundTotal(order: unknown, captureStatus: unknown, currency: unknown): number | undefined {
  const total = completedRefundTotal(order, currency);
  return total === 0 && REFUNDED_CAPTURE_STATUSES.has(captureStatus) ? undefined : total;
}

/**
 * PayPal Checkout provider.
 * Flow: `redirect` — creates an order, redirects the user to PayPal,
 * then captures the payment on return via `handleRedirect`.
 *
 * Charge lookup (`IChargeLookupProvider`, since 2.2.0): `getCharge` locates a charge by `invoice_id` with the
 * Transaction Search API and re-reads its capture.
 */
export class PayPalProvider extends BasePaymentProvider implements IMandateProvider, IChargeLookupProvider {
  readonly name = 'paypal';
  readonly flow = 'redirect' as const;
  /** Since 2.2.0: `refundPayment` sends `options.idempotencyKey` as `PayPal-Request-Id` (kept 45 days by PayPal). */
  readonly supportsRefundIdempotency = true;

  // Assigned by `connect`, from the constructor and again after a failed OAuth token request
  private client!: Client;
  private ordersController!: OrdersController;
  private paymentsController!: PaymentsController;
  private vaultController!: VaultController;
  /** Built on the first `getCharge` of each client, never in `connect` (see `transactionSearch`). */
  private transactionSearchController?: TransactionSearchController;

  constructor(private readonly config: PayPalProviderConfig) {
    super();
    this.connect();
  }

  /**
   * Builds the SDK client and its controllers: in the constructor, and again, since 2.2.0, after a failed OAuth token
   * request. The SDK keeps the token request of a client and makes every later call of that client wait for it, so
   * once that request has failed (a timeout, a network error, an HTTP error of `/v1/oauth2/token`), every later call
   * would fail at once with the same error, without being sent, for the life of the provider. The token provider
   * below is the SDK default (`updateToken`) plus a reconnection: on a failure it replaces the client, then rethrows,
   * so the calls waiting for that token fail exactly as in 2.1 and the next call requests a new token. Only the
   * failure of the current client's token request replaces it: a late failure on a client already replaced (a
   * concurrent call) does nothing.
   */
  private connect(): void {
    const { clientId, clientSecret, environment = 'sandbox', timeoutMs } = this.config;
    // Since 2.2.0, opt-in: without a valid timeoutMs the SDK default stays (no timeout, as in 2.1)
    const timeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;

    const client: Client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
        oAuthTokenProvider: (lastToken, authManager) =>
          authManager.updateToken(lastToken).catch((error: unknown) => {
            if (this.client === client) this.connect();
            throw error;
          }),
      },
      environment:
        environment === 'live' ? Environment.Production : Environment.Sandbox,
      logging: {
        logLevel: LogLevel.Error,
      },
      ...(timeout !== undefined ? { timeout } : {}),
    });

    this.client = client;
    this.ordersController = new OrdersController(client);
    this.paymentsController = new PaymentsController(client);
    this.vaultController = new VaultController(client);
    this.transactionSearchController = undefined;
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
      // Since 2.2.0: the order's COMPLETED refunds, from the same read (no extra API call)
      const refundedAmount = capture ? captureRefundTotal(order, captureStatus, currency) : undefined;

      return {
        success: isCaptureCompleted,
        // Outcome read from the PayPal API over the OAuth-authenticated server-to-server channel
        verified: true,
        paymentId: order.id as string,
        status,
        captureStatus,
        amount,
        currency,
        ...(refundedAmount !== undefined ? { refundedAmount } : {}),
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

  /**
   * Refunds the first capture of the order `paymentId`, in full (`amount` omitted) or in part. Since 2.2.0,
   * `options.idempotencyKey` is sent as `PayPal-Request-Id` (PayPal keeps it 45 days): a retry with the same key gets
   * PayPal's original answer. Without a key the request is exactly the 2.1 one. A key that does not match
   * `REFUND_IDEMPOTENCY_KEY_PATTERN` is refused (`REFUND_FAILED`) without any request.
   */
  async refundPayment(paymentId: string, amount?: number, options?: RefundOptions): Promise<PaymentResult> {
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey !== undefined && !isRefundIdempotencyKey(idempotencyKey)) {
      return { success: false, paymentId, status: 'REFUND_FAILED', error: 'Invalid refund idempotency key' };
    }
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
        // Only when given: without a key the call is exactly `{ captureId, body }`, as in 2.1
        ...(idempotencyKey !== undefined ? { paypalRequestId: idempotencyKey } : {}),
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

  /**
   * Maps the first capture of a setup order (`chargeRef = pending.orderId`). A `COMPLETED` capture of other money
   * than `pending` (or with no valid amount) is `unknown`; since 2.2.0 it carries `errorCode: 'AMOUNT_MISMATCH'`, the
   * order id (`refundPayment` takes it: the money was captured) and the amount and currency PayPal reported, when it
   * reported them.
   */
  private mapSetupCapture(order: Order, pending: MandatePendingState): ChargeResult {
    const chargeRef = pending.orderId;
    const cap = firstCapture(order);
    const capStatus = typeof cap?.status === 'string' ? cap.status : undefined;
    switch (capStatus) {
      case 'COMPLETED':
        if (!sameMoney(cap?.amount?.value, cap?.amount?.currencyCode, pending.amount, pending.currency)) {
          // `cap.amount` may be missing or malformed here: every read is guarded, money was taken
          const amount = parseAmount(cap?.amount?.value);
          const currency: unknown = cap?.amount?.currencyCode;
          return {
            status: 'unknown',
            verified: true,
            chargeRef,
            errorCode: 'AMOUNT_MISMATCH',
            error: CAPTURED_AMOUNT_MISMATCH,
            ...(typeof order?.id === 'string' && order.id !== '' ? { providerPaymentId: order.id } : {}),
            ...(amount !== undefined ? { amount } : {}),
            ...(typeof currency === 'string' ? { currency } : {}),
          };
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

  // -------------------------------------------------------------------------
  // Charge lookup by invoice_id (IChargeLookupProvider, since 2.2.0)
  // -------------------------------------------------------------------------

  /**
   * The Transaction Search controller, built on the first use: an eager one in the constructor would require every
   * SDK mock to define `TransactionSearchController`.
   */
  private get transactionSearch(): TransactionSearchController {
    if (this.transactionSearchController === undefined) {
      this.transactionSearchController = new TransactionSearchController(this.client);
    }
    return this.transactionSearchController;
  }

  /**
   * Read-only lookup of a charge by `chargeRef`: renewal orders carry `invoice_id = chargeRef` (and a setup's first
   * charge `invoice_id = orderId`). Orders v2 has no search, so the Transaction Search API **locates** the capture
   * (`GET /v1/reporting/transactions`, which needs "Transaction search" enabled on the REST app), and the answer
   * comes from the authenticated re-read of that capture. Never charges, never refunds, never throws.
   *
   * - `options.since` is required (`until` defaults to `since`, at most 30 days later). The search window is
   *   `since - 1 h` .. `min(now, until + 1 h)`, read in pages of 500, at most 10 pages (`total_pages: 0` on an empty
   *   first page is an empty window).
   * - No record with this invoice_id: `absent` once `now - until >= 4 h` (the 1-hour margin plus PayPal's 3-hour
   *   indexing delay), `unknown` before.
   * - Every matching record is re-read with `getCapturedPayment`; a 404 (not a capture, e.g. a refund of the same
   *   invoice) is skipped. One capture maps its status: `COMPLETED` `succeeded`, `PARTIALLY_REFUNDED` / `REFUNDED`
   *   `succeeded` with that `providerState`, `PENDING` `pending`, `DECLINED` / `FAILED` `failed`, anything else
   *   `pending`. `providerPaymentId` is the order id (`refundPayment` takes it) and `raw` the captured payment.
   * - Before that 4-hour horizon a later attempt may not be listed yet: a `DECLINED` / `FAILED` capture is then
   *   `unknown` like no record, and the double-charge check below only sees the captures already listed (a
   *   `succeeded` or `pending` capture is still reported: money moved, or may).
   * - `unknown`: a capture of another invoice_id or (with `options.mandate`) another `custom_id`, more than one
   *   distinct capture (a possible double charge: reconcile it in PayPal), more than 5 matching records, more than
   *   10 pages, any error. Error results carry only PayPal's error body, never the SDK error (it carries the bearer
   *   token), and never a search page (it lists other customers' transactions).
   */
  async getCharge(chargeRef: string, options: ChargeLookupOptions = {}): Promise<ChargeLookupResult> {
    const unknown = (error: string): ChargeLookupResult => ({ status: 'unknown', verified: false, chargeRef, error });
    try {
      // 1. Arguments
      const since = options?.since;
      if (since === undefined || since === null) return unknown('PayPal charge lookup requires options.since');
      const until = options?.until ?? since;
      const sinceMs = typeof since === 'string' ? Date.parse(since) : NaN;
      const untilMs = typeof until === 'string' ? Date.parse(until) : NaN;
      if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs) {
        return unknown('Invalid PayPal charge lookup window');
      }
      if (untilMs - sinceMs > LOOKUP_MAX_SPAN_MS) return unknown('PayPal charge lookup window exceeds 31 days');
      const mandate = options?.mandate;

      // 2. Window
      const now = Date.now();
      const startMs = sinceMs - SEARCH_MARGIN_MS;
      const endMs = Math.min(now, untilMs + SEARCH_MARGIN_MS);
      if (startMs >= endMs) return unknown('PayPal charge lookup window has not started yet');
      const startDate = new Date(startMs).toISOString();
      const endDate = new Date(endMs).toISOString();

      // 3. Search. It has no invoice_id filter, and no amount or currency filter is set on purpose: a charge taken
      // for another amount must still be found
      const records: TransactionDetails[] = [];
      for (let page = 1, totalPages = 1; page <= totalPages; page++) {
        let response: SearchResponse;
        try {
          ({ result: response } = await this.transactionSearch.searchTransactions({
            startDate,
            endDate,
            fields: 'transaction_info',
            balanceAffectingRecordsOnly: 'N',
            pageSize: SEARCH_PAGE_SIZE,
            page,
          }));
        } catch (error) {
          return this.lookupFailure(chargeRef, 'PayPal transaction search failed', error);
        }
        const pages: unknown = response?.totalPages ?? 1;
        const details: unknown = response?.transactionDetails ?? [];
        if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 0 || !Array.isArray(details)) {
          return unknown(UNEXPECTED_SEARCH);
        }
        // PayPal's schema allows total_pages 0 (total_items 0 divided into pages): an empty window. Only an empty
        // first page can say so; anything else is inconsistent
        if (pages === 0 && (page !== 1 || details.length > 0)) return unknown(UNEXPECTED_SEARCH);
        if (pages > SEARCH_MAX_PAGES) return unknown('Too many PayPal transactions in the lookup window');
        totalPages = pages;
        // 4. Matching records
        for (const detail of details as TransactionDetails[]) {
          if (detail?.transactionInfo?.invoiceId === chargeRef) records.push(detail);
        }
        if (records.length > LOOKUP_MAX_RECORDS) {
          return unknown(`More than ${LOOKUP_MAX_RECORDS} PayPal transactions have this invoice_id: reconcile it in PayPal`);
        }
      }

      // 5. No matching record. PayPal lists a transaction up to 3 hours after it executed
      const indexed = now - untilMs >= LOOKUP_ABSENT_AFTER_MS;
      if (records.length === 0) {
        return indexed ? { status: 'absent', verified: true, chargeRef } : unknown(NOT_LISTED_YET);
      }

      // 6. Re-read every matching record (a capture can be listed more than once: one read per id)
      const captures = new Map<string, CapturedPayment>();
      for (const id of new Set(records.map((r) => r.transactionInfo?.transactionId))) {
        if (typeof id !== 'string' || id === '') return unknown(UNEXPECTED_SEARCH);
        let capture: CapturedPayment;
        try {
          ({ result: capture } = await this.paymentsController.getCapturedPayment({ captureId: id }));
        } catch (error) {
          // Not a capture (e.g. a refund of the same invoice)
          if (this.apiIssue(error).status === 404) continue;
          return this.lookupFailure(chargeRef, 'PayPal capture could not be read', error);
        }
        if (
          capture === null ||
          typeof capture !== 'object' ||
          capture.id !== id ||
          capture.invoiceId !== chargeRef ||
          (mandate !== undefined && mandate !== null && capture.customId !== mandate.mandateRef)
        ) {
          return unknown(CAPTURE_NOT_MATCHING);
        }
        captures.set(id, capture);
      }
      if (captures.size === 0) return unknown('PayPal lists this invoice_id but no capture was found');
      if (captures.size > 1) {
        // A possible double charge: never pick one
        return unknown('More than one PayPal capture has this invoice_id: reconcile it in PayPal');
      }

      // 7. One capture
      const [capture] = captures.values();
      const result = await this.captureLookup(chargeRef, capture);
      // "Every attempt was refused" relies on no other attempt being listed, like `absent`: before the indexing
      // horizon a later attempt (a new order after the request-id window) may not be listed yet. A `succeeded` or
      // `pending` capture is a fact about money either way
      if (result.status === 'failed' && !indexed) return unknown(NOT_LISTED_YET);
      return result;
    } catch {
      return unknown('PayPal charge lookup failed');
    }
  }

  /**
   * Maps the one capture found by `getCharge`. `raw` is the captured payment, never a search page.
   *
   * `refundedAmount` (`succeeded` only): `0` for a `COMPLETED` capture, with no other API call; for `REFUNDED` and
   * `PARTIALLY_REFUNDED`, the COMPLETED refunds of its order (`getOrder` on the order id), only when that order's
   * first capture is this one. Absent when the order id is missing, `getOrder` fails, the order lists no COMPLETED
   * refund (a refunded capture is never `0`), or the total is not certain.
   */
  private async captureLookup(chargeRef: string, capture: CapturedPayment): Promise<ChargeLookupResult> {
    const captureStatus: string | undefined = typeof capture.status === 'string' ? capture.status : undefined;
    const mapped = (captureStatus !== undefined ? CAPTURE_LOOKUP.get(captureStatus) : undefined) ?? {
      status: 'pending' as const,
    };
    const amount = parseAmount(capture.amount?.value);
    const currency = typeof capture.amount?.currencyCode === 'string' ? capture.amount.currencyCode : undefined;
    const orderId = capture.supplementaryData?.relatedIds?.orderId;
    const providerPaymentId = typeof orderId === 'string' && orderId !== '' ? orderId : undefined;
    let refundedAmount: number | undefined;
    if (captureStatus === 'COMPLETED') {
      refundedAmount = 0;
    } else if (REFUNDED_CAPTURE_STATUSES.has(captureStatus) && providerPaymentId !== undefined) {
      refundedAmount = await this.orderRefundTotal(providerPaymentId, capture.id, captureStatus, currency);
    }
    return {
      status: mapped.status,
      verified: true,
      chargeRef,
      ...(providerPaymentId !== undefined ? { providerPaymentId } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(captureStatus !== undefined ? { providerStatus: captureStatus } : {}),
      ...(mapped.providerState !== undefined ? { providerState: mapped.providerState } : {}),
      ...(refundedAmount !== undefined ? { refundedAmount } : {}),
      raw: capture,
    };
  }

  /**
   * The COMPLETED refunds of `orderId` (`captureRefundTotal` for a capture of `captureStatus`), when its first capture
   * is `captureId`; undefined on any doubt. Never throws.
   */
  private async orderRefundTotal(
    orderId: string,
    captureId: string | undefined,
    captureStatus: string | undefined,
    currency: string | undefined,
  ): Promise<number | undefined> {
    try {
      const { result: order } = await this.ordersController.getOrder({ id: orderId });
      if (captureId === undefined || firstCapture(order)?.id !== captureId) return undefined;
      return captureRefundTotal(order, captureStatus, currency);
    } catch {
      return undefined;
    }
  }

  /** An `unknown` lookup for a failed SDK call: the HTTP status in `error`, only PayPal's error body in `raw`. */
  private lookupFailure(chargeRef: string, what: string, error: unknown): ChargeLookupResult {
    const { status } = this.apiIssue(error);
    const raw = this.apiErrorRaw(error);
    return {
      status: 'unknown',
      verified: false,
      chargeRef,
      error: status !== undefined ? `${what} (HTTP ${status})` : what,
      ...(raw !== undefined ? { raw } : {}),
    };
  }
}
