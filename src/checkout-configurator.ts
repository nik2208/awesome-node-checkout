import { IPaymentProvider } from './interfaces/payment-provider.interface';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult, WebhookResult } from './models/payment-result.model';
import { CheckoutConfig } from './models/checkout-config.model';
import { CheckoutError } from './models/errors';
import { CheckoutEventBus, CheckoutEventName, CheckoutEventPayload } from './events/checkout-event-bus';
import { IMandateProvider, isMandateProvider } from './interfaces/mandate-provider.interface';
import { isChargeLookupProvider } from './interfaces/charge-lookup-provider.interface';
import {
  CHARGE_REF_PATTERN,
  ChargeErrorCode,
  ChargeLookupOptions,
  ChargeLookupResult,
  ChargeLookupStatus,
  ChargeRequest,
  ChargeResult,
  ChargeStatus,
  MANDATE_REF_PATTERN,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from './models/mandate.model';
import { RefundOptions, isRefundIdempotencyKey } from './models/refund.model';
import { toMinorUnits } from './utils/money';
import { redactSecret } from './utils/redact';

const CHARGE_STATUSES: ReadonlySet<string> = new Set<ChargeStatus>([
  'succeeded',
  'failed',
  'unknown',
  'requires_action',
]);

/** Since 2.2.0. Every `ChargeErrorCode`: any other `errorCode` a provider sets is dropped. */
const CHARGE_ERROR_CODES: ReadonlySet<unknown> = new Set<ChargeErrorCode>(['AMOUNT_MISMATCH']);

const CHARGE_EVENTS: Record<ChargeStatus, CheckoutEventName> = {
  succeeded: 'charge.succeeded',
  failed: 'charge.failed',
  unknown: 'charge.unknown',
  requires_action: 'charge.requires_action',
};

const SETUP_MISMATCH = 'Mandate outcome does not match the pending setup';
const AMOUNT_MISMATCH = 'Charged amount does not match the request';

const LOOKUP_STATUSES: ReadonlySet<string> = new Set<ChargeLookupStatus>([
  'succeeded',
  'failed',
  'pending',
  'absent',
  'unknown',
]);

/** The payment facts of a lookup result: never on an `unknown` one. */
const LOOKUP_FACTS = [
  'providerPaymentId',
  'amount',
  'currency',
  'providerStatus',
  'providerState',
  'refundedAmount',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Lookup normalization (fail closed). Returns a new object, never mutates the provider's:
 * - a non-object result, or a status outside the five, is `unknown`;
 * - `verified` is `true` only when the provider set exactly `true`, and never with `unknown`;
 * - any status other than `unknown` without `verified: true` becomes `unknown` with
 *   'Charge lookup could not be verified';
 * - an `unknown` result carries no payment facts (`LOOKUP_FACTS`);
 * - `refundedAmount` is kept only on a verified `succeeded`, as a finite number >= 0;
 * - `chargeRef` is always the request's.
 */
function normalizeLookup(result: unknown, chargeRef: string): ChargeLookupResult {
  if (!isObject(result)) {
    return { status: 'unknown', verified: false, chargeRef, error: 'Provider returned no lookup result' };
  }
  const source = result as Partial<ChargeLookupResult>;
  const known = typeof source.status === 'string' && LOOKUP_STATUSES.has(source.status);
  const normalized: ChargeLookupResult = {
    ...source,
    status: known ? (source.status as ChargeLookupStatus) : 'unknown',
    verified: source.verified === true,
    chargeRef,
  };
  if (!known) {
    normalized.error = normalized.error ?? 'Provider returned an unrecognised lookup status';
  } else if (normalized.status !== 'unknown' && !normalized.verified) {
    normalized.status = 'unknown';
    normalized.error = 'Charge lookup could not be verified';
  }
  if (normalized.status === 'unknown') {
    normalized.verified = false;
    for (const key of LOOKUP_FACTS) delete normalized[key];
  }
  const refunded = normalized.refundedAmount;
  if (
    'refundedAmount' in normalized &&
    (normalized.status !== 'succeeded' || typeof refunded !== 'number' || !Number.isFinite(refunded) || refunded < 0)
  ) {
    delete normalized.refundedAmount;
  }
  return normalized;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** An absolute `http:` or `https:` URL (what `appendMandateRef` and the providers need). */
function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Same amount in minor units (and same currency, when reported). Only present fields are compared. */
function chargedAmountMatches(result: ChargeResult, amount: number, currency: string): boolean {
  if (result.currency != null) {
    const expected = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
    if (typeof result.currency !== 'string' || expected === '') return false;
    if (result.currency.trim().toUpperCase() !== expected) return false;
  }
  if (result.amount != null) {
    try {
      return toMinorUnits(result.amount, currency) === toMinorUnits(amount, currency);
    } catch {
      // An invalid reported amount never matches; never throw after money may have moved
      return false;
    }
  }
  return true;
}

/**
 * `pending.amount` / `pending.currency` (returned by the provider) equal the setup request's.
 * Unlike `chargedAmountMatches`, both fields are required: a missing or invalid one is a mismatch.
 */
function pendingAmountMatches(pending: MandatePendingState, request: MandateSetupRequest): boolean {
  if (typeof pending.currency !== 'string') return false;
  const currency = pending.currency.trim().toUpperCase();
  if (currency === '' || currency !== request.currency.trim().toUpperCase()) return false;
  try {
    return toMinorUnits(pending.amount, currency) === toMinorUnits(request.amount, currency);
  } catch {
    return false;
  }
}

/**
 * The ids scrubbed from every event of a terminal setup outcome (`mandate.created` or
 * `mandate.setup_failed`, and the first charge's `charge.*`):
 * - the mandate's `providerMandateId`, taken from the provider's outcome (a dropped mandate's id
 *   may still be inside `raw`);
 * - `pending.providerRef`, which is the providerMandateId itself for Satispay (token id) and can
 *   reach `raw` or `error` even when the setup failed and no mandate is returned. It is kept when
 *   it is the app's own `orderId` or `mandateRef` (Nexi `codTrans`), or the verified first
 *   charge's `providerPaymentId` (the PayPal order id, which refunds the charge), unless it is
 *   also the providerMandateId.
 */
function setupEventSecrets(
  pending: MandatePendingState,
  providerOutcome: MandateSetupOutcome | undefined,
  outcome: MandateSetupOutcome,
): string[] {
  const secrets: string[] = [];
  const providerMandateId =
    isObject(providerOutcome) && isObject(providerOutcome.mandate)
      ? providerOutcome.mandate.providerMandateId
      : undefined;
  if (isNonEmptyString(providerMandateId)) secrets.push(providerMandateId);
  const providerRef = pending.providerRef;
  if (
    isNonEmptyString(providerRef) &&
    providerRef !== pending.orderId &&
    providerRef !== pending.mandateRef &&
    providerRef !== outcome.firstCharge.providerPaymentId
  ) {
    secrets.push(providerRef);
  }
  return secrets;
}

/**
 * Main entry point for awesome-node-checkout.
 *
 * Usage (framework-agnostic):
 * ```typescript
 * const checkout = new CheckoutConfigurator();
 * checkout
 *   .registerProvider(new PayPalProvider({ clientId, clientSecret }))
 *   .registerProvider(new NexiProvider({ merchantId, macKey }))
 *   .registerProvider(new SatispayProvider({ keyId, privateKey }));
 *
 * // Use directly in any framework
 * const result = await checkout.createPayment('paypal', request);
 * ```
 *
 * Usage with Express adapter:
 * ```typescript
 * import { createCheckoutRouter } from 'awesome-node-checkout/express';
 * app.use('/checkout', createCheckoutRouter(checkout));
 * ```
 */
export class CheckoutConfigurator {
  private readonly providers: Map<string, IPaymentProvider> = new Map();
  private readonly maxPaymentOrders = 10000;
  private readonly paymentOrders: Map<string, string> = new Map();

  /** Event bus — subscribe to payment lifecycle events */
  readonly events: CheckoutEventBus = new CheckoutEventBus();

  constructor(private readonly config: CheckoutConfig = {}) {}

  /** Stores a paymentId -> orderId mapping with bounded capacity to prevent memory leaks */
  private setPaymentOrder(paymentId: string, orderId: string): void {
    if (this.paymentOrders.size >= this.maxPaymentOrders) {
      const firstKey = this.paymentOrders.keys().next().value;
      if (firstKey) {
        this.paymentOrders.delete(firstKey);
      }
    }
    this.paymentOrders.set(paymentId, orderId);
  }

  /** Emits an event only when `config.emitEvents` is not explicitly `false`. */
  private async emit(
    event: CheckoutEventName,
    data: Omit<CheckoutEventPayload, 'timestamp'>,
  ): Promise<void> {
    if (this.config.emitEvents !== false) {
      await this.events.emit(event, data);
    }
  }

  /**
   * Register a payment provider. Chainable.
   * @throws CheckoutError if a provider with the same name is already registered.
   */
  registerProvider(provider: IPaymentProvider): this {
    const key = provider.name.toLowerCase();
    if (this.providers.has(key)) {
      throw new CheckoutError(
        `Provider '${provider.name}' is already registered`,
        'PROVIDER_ALREADY_REGISTERED',
        provider.name,
      );
    }
    this.providers.set(key, provider);
    return this;
  }

  /**
   * Retrieve a registered provider by name.
   * @throws CheckoutError if the provider is not found.
   */
  getProvider(name: string): IPaymentProvider {
    const provider = this.providers.get(name.toLowerCase());
    if (!provider) {
      throw new CheckoutError(
        `Payment provider '${name}' not found. Did you call registerProvider()?`,
        'PROVIDER_NOT_FOUND',
        name,
      );
    }
    return provider;
  }

  /** Returns the names of all registered providers */
  getRegisteredProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Normalizes a callback / redirect / execute outcome according to the single meaning of
   * `verified` ("the outcome was authenticated by a signature/MAC or by an authenticated
   * read from the provider API"):
   * - `verified` is `true` only when the provider explicitly set it to `true` (fail closed);
   * - an unverified outcome never reports `success: true`, and carries no `paymentId` / `orderId`;
   * - a verified outcome takes `orderId` from the local paymentId -> orderId map (keyed on the
   *   provider-authenticated `paymentId`) or from the provider's own `orderId`, never from the
   *   request query or from unsigned body fields, whatever name the provider is registered under.
   */
  private normalizeOutcome<T extends PaymentResult | WebhookResult>(result: T): T & { verified: boolean } {
    const verified = result.verified === true;
    if (!verified) {
      result.paymentId = undefined;
      result.orderId = undefined;
      if (result.success) {
        result.success = false;
        result.error = result.error ?? 'Payment outcome could not be verified';
      }
    } else {
      result.orderId =
        (result.paymentId ? this.paymentOrders.get(result.paymentId) : undefined) ?? result.orderId;
    }
    result.verified = verified;
    return result as T & { verified: boolean };
  }

  /** Create a new payment via the specified provider */
  async createPayment(providerName: string, request: PaymentRequest): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    const result = await provider.createPayment(request);
    if (result.paymentId && request.orderId) {
      this.setPaymentOrder(result.paymentId, request.orderId);
      result.orderId = request.orderId;
    }
    await this.emit(result.success ? 'payment.created' : 'payment.failed', {
      provider: providerName,
      paymentId: result.paymentId,
      orderId: request.orderId,
      status: result.status,
      error: result.error,
      // Creation reports no payment outcome: nothing has been authenticated yet.
      verified: false,
      raw: result.raw,
    });
    return result;
  }

  /**
   * Execute/capture a previously created payment.
   * The result and the emitted event are keyed on the `paymentId` authenticated by the
   * provider (e.g. the MAC-covered Nexi `codTrans`), never on the caller's argument.
   * When a non-empty `paymentId` argument differs from the authenticated one, the call fails
   * with `success: false`, `verified: false`, error `'Payment id does not match the outcome'`.
   */
  async executePayment(
    providerName: string,
    paymentId: string,
    data?: Record<string, string>,
  ): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    let result = await provider.executePayment(paymentId, data);
    if (
      result.verified === true &&
      typeof paymentId === 'string' &&
      paymentId !== '' &&
      result.paymentId !== paymentId
    ) {
      result = {
        success: false,
        verified: false,
        status: 'FAILED',
        error: 'Payment id does not match the outcome',
        raw: result.raw,
      };
    }
    this.normalizeOutcome(result);
    await this.emit(result.success ? 'payment.completed' : 'payment.failed', {
      provider: providerName,
      paymentId: result.paymentId,
      orderId: result.orderId,
      status: result.status,
      error: result.error,
      verified: result.verified === true,
      raw: result.raw,
    });
    return result;
  }

  /** Retrieve the current status and details of a payment */
  async getPaymentDetails(providerName: string, paymentId: string): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    return provider.getPaymentDetails(paymentId);
  }

  /**
   * Issue a full (`amount` omitted) or partial refund.
   *
   * `options.idempotencyKey` (since 2.2.0, see `RefundOptions`) makes a retry of the same refund safe while the
   * provider keeps the key. The options are validated first, without calling the provider and without emitting an
   * event (fail closed: a refund asked to be idempotent is never sent without its key):
   * - `options` that are not an object, or a key that is not a string matching `REFUND_IDEMPOTENCY_KEY_PATTERN` →
   *   `CheckoutError('INVALID_REFUND_REQUEST')`;
   * - a key on a provider whose `supportsRefundIdempotency` is not `true` (Nexi, a provider written for 2.1) →
   *   `CheckoutError('REFUND_IDEMPOTENCY_NOT_SUPPORTED')` (HTTP 422 through the router).
   * Without `options` (or with `null`) the provider is called with `(paymentId, amount)`, exactly as in 2.1; with
   * them, with `(paymentId, amount, { idempotencyKey })` (the known field only). Emits `payment.refunded`, unchanged.
   */
  async refundPayment(
    providerName: string,
    paymentId: string,
    amount?: number,
    options?: RefundOptions,
  ): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    const providerOptions = this.refundOptions(providerName, provider, options);
    const result =
      providerOptions === undefined
        ? await provider.refundPayment(paymentId, amount)
        : await provider.refundPayment(paymentId, amount, providerOptions);
    const orderId = this.paymentOrders.get(paymentId);
    if (orderId && !result.orderId) {
      result.orderId = orderId;
    }
    await this.emit('payment.refunded', {
      provider: providerName,
      paymentId,
      orderId,
      status: result.status,
      error: result.error,
      verified: result.verified === true,
      raw: result.raw,
    });
    return result;
  }

  /**
   * Since 2.2.0. Validates the options of `refundPayment` and returns a copy with the known field only, or undefined
   * for no options. The key is read once: the provider gets exactly the value that was checked.
   */
  private refundOptions(
    providerName: string,
    provider: IPaymentProvider,
    options: RefundOptions | undefined,
  ): RefundOptions | undefined {
    if (options === undefined || options === null) return undefined;
    if (typeof options !== 'object') {
      throw new CheckoutError('Invalid refund options', 'INVALID_REFUND_REQUEST', providerName);
    }
    const idempotencyKey: unknown = options.idempotencyKey;
    if (idempotencyKey === undefined) return {};
    if (!isRefundIdempotencyKey(idempotencyKey)) {
      throw new CheckoutError(
        'Invalid idempotencyKey: expected /^[A-Za-z0-9_-]{8,64}$/',
        'INVALID_REFUND_REQUEST',
        providerName,
      );
    }
    if (provider.supportsRefundIdempotency !== true) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support refund idempotency keys`,
        'REFUND_IDEMPOTENCY_NOT_SUPPORTED',
        providerName,
      );
    }
    return { idempotencyKey };
  }

  /**
   * Handle an incoming webhook from the provider.
   * @throws CheckoutError if the provider does not support webhooks.
   */
  async handleWebhook(
    providerName: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
    query?: Record<string, string>,
    context?: { method?: string; path?: string; rawBody?: Buffer | string },
  ): Promise<WebhookResult> {
    const provider = this.getProvider(providerName);
    if (!provider.handleWebhook) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support webhook handling`,
        'WEBHOOK_NOT_SUPPORTED',
        providerName,
      );
    }
    const result = await provider.handleWebhook(body, headers, query, context);
    this.normalizeOutcome(result);

    await this.emit('webhook.received', {
      provider: providerName,
      paymentId: result.paymentId,
      orderId: result.orderId,
      status: result.status,
      error: result.error,
      verified: result.verified,
      data: body ?? query,
      raw: result.raw,
    });
    return result;
  }

  /**
   * Handle the redirect callback from the provider (query params).
   * @throws CheckoutError if the provider does not support redirect handling.
   */
  async handleRedirect(
    providerName: string,
    query: Record<string, string>,
  ): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    if (!provider.handleRedirect) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support redirect handling`,
        'REDIRECT_NOT_SUPPORTED',
        providerName,
      );
    }
    const result = await provider.handleRedirect(query);
    this.normalizeOutcome(result);

    await this.emit(result.success ? 'payment.completed' : 'payment.failed', {
      provider: providerName,
      paymentId: result.paymentId,
      orderId: result.orderId,
      status: result.status,
      error: result.error,
      verified: result.verified === true,
      raw: result.raw,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Recurring payments (mandates)
  // ---------------------------------------------------------------------------

  /**
   * True when the provider implements `IMandateProvider`.
   * @throws CheckoutError('PROVIDER_NOT_FOUND') if the provider is not registered.
   */
  supportsMandates(providerName: string): boolean {
    return isMandateProvider(this.getProvider(providerName));
  }

  /** Resolves a provider that implements mandates, or throws MANDATES_NOT_SUPPORTED. */
  private getMandateProvider(providerName: string): IPaymentProvider & IMandateProvider {
    const provider = this.getProvider(providerName);
    if (!isMandateProvider(provider)) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support recurring payments (mandates)`,
        'MANDATES_NOT_SUPPORTED',
        providerName,
      );
    }
    return provider;
  }

  private invalidMandate(message: string, providerName: string): CheckoutError {
    return new CheckoutError(message, 'INVALID_MANDATE_REQUEST', providerName);
  }

  /** A persisted mandate passed back by the app: it must belong to this provider. */
  private assertMandate(providerName: string, mandate: Mandate): void {
    if (!isObject(mandate) || mandate.provider !== providerName) {
      throw this.invalidMandate(`Mandate does not belong to provider '${providerName}'`, providerName);
    }
    if (!isNonEmptyString(mandate.mandateRef)) {
      throw this.invalidMandate('Mandate has no mandateRef', providerName);
    }
    if (!isNonEmptyString(mandate.providerMandateId)) {
      throw this.invalidMandate('Mandate has no providerMandateId', providerName);
    }
  }

  /**
   * Event payloads never carry the credential-like `providerMandateId`, nor a setup's
   * `pending.providerRef` (the future Satispay token id): every `secrets` entry is scrubbed from
   * the whole payload (`raw`, `data`, `error`). Nexi's contract number is the app's own
   * `mandateRef`, which is not a credential and is part of every payload, so it is never scrubbed.
   *
   * Used only after a mandate provider call has completed (confirm, charge, revoke): an error
   * raised while emitting (a throwing listener) never rejects the caller, because money may
   * already have moved. It goes to `config.onListenerError` instead (see `reportListenerError`).
   */
  private async emitMandateEvent(
    event: CheckoutEventName,
    payload: Omit<CheckoutEventPayload, 'timestamp'>,
    secrets: readonly (string | undefined)[],
    mandateRef: string,
  ): Promise<void> {
    try {
      await this.emit(event, redactSecret(payload, secrets.filter((s) => s !== mandateRef)));
    } catch (err) {
      await this.reportListenerError(err, event);
    }
  }

  /** `config.onListenerError`, or `console.error` without it. Never throws. */
  private async reportListenerError(err: unknown, event: CheckoutEventName): Promise<void> {
    const hook = this.config.onListenerError;
    if (typeof hook === 'function') {
      try {
        await hook(err, event);
        return;
      } catch (hookErr) {
        console.error('[awesome-node-checkout] onListenerError threw', hookErr);
      }
    }
    console.error('[awesome-node-checkout]', err);
  }

  private async emitChargeEvent(
    providerName: string,
    mandateRef: string,
    result: ChargeResult,
    secrets: readonly (string | undefined)[],
  ): Promise<void> {
    await this.emitMandateEvent(
      CHARGE_EVENTS[result.status],
      {
        provider: providerName,
        paymentId: result.providerPaymentId,
        orderId: result.chargeRef,
        status: result.status,
        error: result.error,
        verified: result.verified,
        data: {
          mandateRef,
          amount: result.amount,
          currency: result.currency,
          providerCode: result.providerCode,
          mandateUnusable: result.mandateUnusable,
          // Since 2.2.0: a refunded or partly captured charge (only on verified results)
          providerState: result.providerState,
          // Since 2.2.0: the stable reason (e.g. 'AMOUNT_MISMATCH': never retry such a charge)
          errorCode: result.errorCode,
        },
        raw: result.raw,
      },
      secrets,
      mandateRef,
    );
  }

  /**
   * Charge normalization (fail closed). Returns a new object, never mutates the provider's:
   * - `chargeRef` is always the request's;
   * - an unknown status becomes `unknown`;
   * - `succeeded` without `verified: true` becomes `unknown` (never `failed`: an unauthenticated
   *   "success" means we do not know);
   * - a verified `succeeded` whose reported amount or currency differs from the request becomes
   *   `unknown` with error 'Charged amount does not match the request' and (since 2.2.0)
   *   `errorCode: 'AMOUNT_MISMATCH'`. Absent fields are not compared (Nexi's charge response
   *   carries no amount). `providerState` and `providerStatus` survive that check: the state is
   *   the more specific fact;
   * - `providerState` and `providerStatus` (since 2.2.0) are dropped from any result that is not
   *   `verified: true` (an unauthenticated state is not a fact), and never change `status`;
   * - `errorCode` (since 2.2.0): a final `succeeded` never carries one, nor does an unverified
   *   "success" turned `unknown`; on any other status a provider's code is kept only when it is a
   *   known `ChargeErrorCode`.
   */
  private normalizeCharge(
    result: ChargeResult | undefined,
    chargeRef: string,
    amount: number,
    currency: string,
  ): ChargeResult {
    const normalized: ChargeResult = isObject(result)
      ? { ...result }
      : { status: 'unknown', verified: false, chargeRef, error: 'Provider returned no charge result' };
    normalized.chargeRef = chargeRef;
    normalized.verified = normalized.verified === true;
    if (!normalized.verified) {
      delete normalized.providerState;
      delete normalized.providerStatus;
    }
    if (!CHARGE_STATUSES.has(normalized.status)) {
      normalized.status = 'unknown';
    }
    if (normalized.status === 'succeeded' || !CHARGE_ERROR_CODES.has(normalized.errorCode)) {
      delete normalized.errorCode;
    }
    if (normalized.status === 'succeeded') {
      if (!normalized.verified) {
        normalized.status = 'unknown';
        normalized.error = normalized.error ?? 'Charge outcome could not be verified';
      } else if (!chargedAmountMatches(normalized, amount, currency)) {
        normalized.status = 'unknown';
        normalized.error = AMOUNT_MISMATCH;
        normalized.errorCode = 'AMOUNT_MISMATCH';
      }
    }
    return normalized;
  }

  /**
   * Starts a mandate setup (customer present). The setup always includes the first charge
   * (`chargeRef = request.orderId`).
   *
   * Validates the request first and throws `CheckoutError('INVALID_MANDATE_REQUEST')` (or
   * `'INVALID_AMOUNT'` from `toMinorUnits`) without calling the provider. `returnUrl` and
   * `cancelUrl` (and `notifyUrl`, when set) must be absolute http(s) URLs. A successful start whose
   * `pending` does not match the request (provider, mandateRef, orderId, amount in minor units,
   * currency) is returned as `success: false`. Persist `pending` before sending the customer to
   * `approvalUrl`. Emits `mandate.setup_started` (`verified: false`) when the start succeeded, with
   * `pending.providerRef` scrubbed from its payload (unless it is the orderId or the mandateRef).
   * A listener error on that event propagates: no money has moved yet.
   *
   * @throws CheckoutError('MANDATES_NOT_SUPPORTED') if the provider does not implement mandates.
   */
  async createMandate(providerName: string, request: MandateSetupRequest): Promise<MandateSetupStart> {
    const provider = this.getMandateProvider(providerName);
    if (!isObject(request)) {
      throw this.invalidMandate('Invalid mandate setup request', providerName);
    }
    if (typeof request.mandateRef !== 'string' || !MANDATE_REF_PATTERN.test(request.mandateRef)) {
      throw this.invalidMandate('Invalid mandateRef: expected /^[A-Za-z0-9_-]{5,30}$/', providerName);
    }
    if (typeof request.orderId !== 'string' || !CHARGE_REF_PATTERN.test(request.orderId)) {
      throw this.invalidMandate('Invalid orderId: expected /^[A-Za-z0-9-]{2,30}$/', providerName);
    }
    if (!isNonEmptyString(request.currency)) {
      throw this.invalidMandate('currency is required', providerName);
    }
    toMinorUnits(request.amount, request.currency);
    if (
      typeof request.description !== 'string' ||
      request.description.length < 1 ||
      request.description.length > 127
    ) {
      throw this.invalidMandate('Invalid description: 1-127 characters are required', providerName);
    }
    if (!isNonEmptyString(request.returnUrl) || !isNonEmptyString(request.cancelUrl)) {
      throw this.invalidMandate('returnUrl and cancelUrl are required', providerName);
    }
    if (!isAbsoluteHttpUrl(request.returnUrl) || !isAbsoluteHttpUrl(request.cancelUrl)) {
      throw this.invalidMandate('returnUrl and cancelUrl must be absolute http(s) URLs', providerName);
    }
    if (request.notifyUrl != null && !isAbsoluteHttpUrl(request.notifyUrl)) {
      throw this.invalidMandate('notifyUrl must be an absolute http(s) URL', providerName);
    }

    const start = await provider.createMandate(request);
    let result: MandateSetupStart;
    if (!isObject(start) || start.success !== true) {
      result = {
        ...(isObject(start) ? start : {}),
        success: false,
        approvalUrl: undefined,
        pending: undefined,
        error: (isObject(start) ? start.error : undefined) ?? 'Mandate setup could not be started',
      };
    } else {
      const pending = start.pending;
      // The first charge's amount check in confirmMandate trusts `pending`: bind it to the request
      const matches =
        isObject(pending) &&
        pending.provider === providerName &&
        pending.mandateRef === request.mandateRef &&
        pending.orderId === request.orderId &&
        pendingAmountMatches(pending, request);
      result = matches
        ? { ...start, pending: { ...pending } }
        : {
            ...start,
            success: false,
            approvalUrl: undefined,
            pending: undefined,
            error: 'Mandate setup does not match the request',
          };
    }

    if (result.success) {
      // `pending.providerRef` may become the credential-like providerMandateId (Satispay token
      // id): scrub it from the event's payload. Not when it is the app's own orderId or
      // mandateRef (Nexi), which are part of every payload anyway.
      const providerRef = result.pending?.providerRef;
      const secret =
        isNonEmptyString(providerRef) && providerRef !== request.orderId && providerRef !== request.mandateRef
          ? providerRef
          : undefined;
      // No money has moved yet: a throwing listener propagates, like every non-mandate event
      await this.emit(
        'mandate.setup_started',
        redactSecret(
          {
            provider: providerName,
            orderId: request.orderId,
            status: 'started',
            // A setup start reports no outcome: nothing has been authenticated yet
            verified: false,
            data: { mandateRef: request.mandateRef },
            raw: result.raw,
          },
          secret,
        ),
      );
    }
    return result;
  }

  /**
   * Confirms a mandate setup from a provider callback (redirect or server notification), against
   * the persisted `pending` state. Idempotent: it may be called twice for the same setup.
   *
   * Normalization (fail closed):
   * - an unverified outcome is `success: false`, `terminal: false`, has no `mandate`, and a first
   *   charge reported `succeeded` becomes `unknown`;
   * - a verified outcome whose `firstCharge.chargeRef` is not `pending.orderId`, or whose `mandate`
   *   does not match `pending` (mandateRef, provider), becomes an unverified, non-terminal failure
   *   'Mandate outcome does not match the pending setup';
   * - `terminal` is the provider's value AND `verified`; it is always `true` with `success: true`.
   *
   * Events are emitted only for terminal outcomes: `mandate.created` (success) or
   * `mandate.setup_failed`, then `charge.*` for the first charge. A non-terminal outcome emits
   * nothing, so a forged callback never looks like a failed setup. Events can repeat for the
   * same setup (redirect and notification, replays): listeners must be idempotent on `orderId`.
   * A throwing listener never rejects this method: the error goes to `config.onListenerError`
   * and the outcome is returned, so `onOutcome` can persist it.
   *
   * A terminal outcome can carry a first charge reported `unknown` (even with `success: true`).
   * Resolve it by calling this method again from a job with the persisted (consumed) `pending` and
   * an empty `input` (`{}`), never with `chargeMandate` and `chargeRef = pending.orderId`. The
   * re-run is terminal again, so its events repeat.
   *
   * @throws CheckoutError('INVALID_MANDATE_REQUEST') if `pending.provider` is not `providerName`.
   */
  async confirmMandate(
    providerName: string,
    pending: MandatePendingState,
    input: MandateCallbackInput = {},
  ): Promise<MandateSetupOutcome> {
    const provider = this.getMandateProvider(providerName);
    if (!isObject(pending) || pending.provider !== providerName) {
      throw this.invalidMandate(
        `Pending mandate setup does not belong to provider '${providerName}'`,
        providerName,
      );
    }
    if (typeof pending.mandateRef !== 'string' || !MANDATE_REF_PATTERN.test(pending.mandateRef)) {
      throw this.invalidMandate('Invalid pending mandateRef', providerName);
    }
    if (typeof pending.orderId !== 'string' || !CHARGE_REF_PATTERN.test(pending.orderId)) {
      throw this.invalidMandate('Invalid pending orderId', providerName);
    }

    const providerOutcome = await provider.confirmMandate(pending, input ?? {});
    const outcome = this.normalizeSetupOutcome(providerName, pending, providerOutcome);

    if (outcome.terminal) {
      const secrets = setupEventSecrets(pending, providerOutcome, outcome);
      await this.emitMandateEvent(
        outcome.success ? 'mandate.created' : 'mandate.setup_failed',
        {
          provider: providerName,
          orderId: pending.orderId,
          status: outcome.success ? 'active' : 'failed',
          error: outcome.error,
          verified: outcome.verified,
          data: { mandateRef: pending.mandateRef },
          raw: outcome.raw,
        },
        secrets,
        pending.mandateRef,
      );
      await this.emitChargeEvent(providerName, pending.mandateRef, outcome.firstCharge, secrets);
    }
    return outcome;
  }

  private normalizeSetupOutcome(
    providerName: string,
    pending: MandatePendingState,
    out: MandateSetupOutcome | undefined,
  ): MandateSetupOutcome {
    const source: Partial<MandateSetupOutcome> = isObject(out) ? out : {};
    const providerCharge = isObject(source.firstCharge) ? source.firstCharge : undefined;

    if (source.verified !== true) {
      // Like normalizeOutcome: an unauthenticated callback provides no identities, no amounts, no
      // provider state and no error code (since 2.2.0)
      const firstCharge: ChargeResult = providerCharge
        ? {
            ...providerCharge,
            chargeRef: pending.orderId,
            verified: false,
            providerPaymentId: undefined,
            amount: undefined,
            currency: undefined,
          }
        : { status: 'unknown', verified: false, chargeRef: pending.orderId };
      delete firstCharge.providerState;
      delete firstCharge.providerStatus;
      delete firstCharge.errorCode;
      if (!CHARGE_STATUSES.has(firstCharge.status)) firstCharge.status = 'unknown';
      if (firstCharge.status === 'succeeded') {
        firstCharge.status = 'unknown';
        firstCharge.error = firstCharge.error ?? 'Charge outcome could not be verified';
      }
      return {
        ...source,
        success: false,
        verified: false,
        terminal: false,
        mandate: undefined,
        firstCharge,
        error: source.error ?? 'Mandate outcome could not be verified',
      };
    }

    const mismatch = (): MandateSetupOutcome => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId, error: SETUP_MISMATCH },
      error: SETUP_MISMATCH,
      raw: source.raw,
    });

    if (!providerCharge || providerCharge.chargeRef !== pending.orderId) return mismatch();
    const mandate = source.mandate;
    if (mandate !== undefined && mandate !== null) {
      if (!isObject(mandate) || mandate.mandateRef !== pending.mandateRef || mandate.provider !== providerName) {
        return mismatch();
      }
    }
    const success = source.success === true;
    if (
      success &&
      (!isObject(mandate) || mandate.status !== 'active' || !isNonEmptyString(mandate.providerMandateId))
    ) {
      // success: true means an active mandate: anything else is a provider bug
      return mismatch();
    }

    const firstCharge = this.normalizeCharge(providerCharge, pending.orderId, pending.amount, pending.currency);
    return {
      ...source,
      success,
      verified: true,
      terminal: success || source.terminal === true,
      mandate: success && isObject(mandate) ? { ...mandate } : undefined,
      firstCharge,
    };
  }

  /**
   * Merchant-initiated charge on an active mandate (customer absent). Never mounted as a route.
   *
   * Validates `chargeRef` (/^[A-Za-z0-9-]{2,30}$/, `INVALID_MANDATE_REQUEST`) and the amount
   * (`INVALID_AMOUNT`). A `revoked` mandate returns `failed` with `mandateUnusable: true` without
   * calling the provider. A provider that throws gives `unknown`, with `raw` reduced to the error's
   * `{ name, message }`. See `normalizeCharge` for the rest. Emits `charge.succeeded`,
   * `charge.failed`, `charge.unknown` or `charge.requires_action`; a throwing listener never
   * rejects this method (the error goes to `config.onListenerError`), so a charge that moved
   * money always returns its result.
   *
   * Retry an `unknown` charge with the SAME `chargeRef`, except one with `errorCode:
   * 'AMOUNT_MISMATCH'` (since 2.2.0): a retry gets the same answer, so review it instead. A
   * dunning retry after `failed` is a new charge with a NEW `chargeRef`. The library never retries
   * on its own. Never pass a setup's `orderId` as `chargeRef`: an `unknown` first charge is
   * resolved with `confirmMandate(provider, pending, {})`, since this method starts a new charge
   * (on PayPal, a new order).
   */
  async chargeMandate(providerName: string, mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    const provider = this.getMandateProvider(providerName);
    this.assertMandate(providerName, mandate);
    if (!isObject(charge) || typeof charge.chargeRef !== 'string' || !CHARGE_REF_PATTERN.test(charge.chargeRef)) {
      throw this.invalidMandate('Invalid chargeRef: expected /^[A-Za-z0-9-]{2,30}$/', providerName);
    }
    if (!isNonEmptyString(charge.currency)) {
      throw this.invalidMandate('currency is required', providerName);
    }
    toMinorUnits(charge.amount, charge.currency);

    let result: ChargeResult;
    if (mandate.status === 'revoked') {
      result = {
        status: 'failed',
        verified: false,
        chargeRef: charge.chargeRef,
        error: 'Mandate is revoked',
        mandateUnusable: true,
      };
    } else {
      let providerResult: ChargeResult | undefined;
      try {
        providerResult = await provider.chargeMandate(mandate, charge);
      } catch (err) {
        // The request may or may not have reached the provider: we do not know.
        // Only name and message of the thrown value reach `raw` (and the charge.unknown event):
        // SDK errors carry the request, its headers (bearer token) and its body as own properties
        providerResult = {
          status: 'unknown',
          verified: false,
          chargeRef: charge.chargeRef,
          error: 'Charge outcome unknown: the provider call failed',
          raw: err instanceof Error ? { name: err.name, message: err.message } : undefined,
        };
      }
      result = this.normalizeCharge(providerResult, charge.chargeRef, charge.amount, charge.currency);
    }

    await this.emitChargeEvent(providerName, mandate.mandateRef, result, [mandate.providerMandateId]);
    return result;
  }

  /** Re-reads the mandate's usability from the provider (`verified: false` when it cannot). */
  async getMandate(providerName: string, mandate: Mandate): Promise<MandateStatusResult> {
    const provider = this.getMandateProvider(providerName);
    this.assertMandate(providerName, mandate);
    const result = await provider.getMandate(mandate);
    return { ...result, verified: result?.verified === true };
  }

  /**
   * Revokes the mandate at the provider, when the provider supports it, and emits
   * `mandate.revoked` with `data: { mandateRef, revokedAtProvider }` (a throwing listener goes to
   * `config.onListenerError` and never rejects). Mark your own copy revoked whatever the
   * provider answers.
   */
  async revokeMandate(providerName: string, mandate: Mandate): Promise<MandateRevokeResult> {
    const provider = this.getMandateProvider(providerName);
    this.assertMandate(providerName, mandate);
    const providerResult = await provider.revokeMandate(mandate);
    const result: MandateRevokeResult = {
      ...(isObject(providerResult) ? providerResult : {}),
      revokedAtProvider: isObject(providerResult) && providerResult.revokedAtProvider === true,
    };
    await this.emitMandateEvent(
      'mandate.revoked',
      {
        provider: providerName,
        status: 'revoked',
        error: result.error,
        // The revoke result carries no authentication flag
        verified: false,
        data: { mandateRef: mandate.mandateRef, revokedAtProvider: result.revokedAtProvider },
        raw: result.raw,
      },
      [mandate.providerMandateId],
      mandate.mandateRef,
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // Charge lookup (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Since 2.2.0. True when the provider implements `IChargeLookupProvider` (`isChargeLookupProvider`): Nexi and
   * PayPal, not Satispay.
   * @throws CheckoutError('PROVIDER_NOT_FOUND') if the provider is not registered.
   */
  supportsChargeLookup(providerName: string): boolean {
    return isChargeLookupProvider(this.getProvider(providerName));
  }

  /**
   * Since 2.2.0. Read-only lookup of a charge by its `chargeRef` ("did money move for it?"), for an `unknown` charge
   * that may not be retried (the subscription closed meanwhile, the replay window has passed, manual resolution).
   * Never charges, never refunds, and emits no event. Never mounted as a route.
   *
   * Validates first, without calling the provider (`INVALID_MANDATE_REQUEST`): `chargeRef` must match
   * `CHARGE_REF_PATTERN`; `options.since` and `options.until`, when present, must be strings with a finite
   * `Date.parse`, and `until >= since`; `options.mandate`, when present, must belong to this provider. A provider that
   * throws gives `unknown`, with `raw` reduced to the error's `{ name, message }`. See `normalizeLookup` for the rest:
   * only a verified answer is `succeeded`, `failed`, `pending` or `absent`.
   *
   * A lookup made while a request with this chargeRef may still be in flight proves nothing: `absent` can be followed
   * by that request taking the money. Look up only once no such request can still complete.
   *
   * @throws CheckoutError('CHARGE_LOOKUP_NOT_SUPPORTED') if the provider does not implement `IChargeLookupProvider`.
   */
  async getCharge(
    providerName: string,
    chargeRef: string,
    options?: ChargeLookupOptions,
  ): Promise<ChargeLookupResult> {
    const provider = this.getProvider(providerName);
    if (!isChargeLookupProvider(provider)) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support charge lookups`,
        'CHARGE_LOOKUP_NOT_SUPPORTED',
        providerName,
      );
    }
    if (typeof chargeRef !== 'string' || !CHARGE_REF_PATTERN.test(chargeRef)) {
      throw this.invalidMandate('Invalid chargeRef: expected /^[A-Za-z0-9-]{2,30}$/', providerName);
    }
    const lookupOptions = this.lookupOptions(providerName, options);

    let providerResult: unknown;
    try {
      providerResult = await provider.getCharge(chargeRef, lookupOptions);
    } catch (err) {
      // Same rule as chargeMandate: only name and message of the thrown value, never the object itself (SDK errors
      // carry the request and its headers)
      providerResult = {
        status: 'unknown',
        verified: false,
        chargeRef,
        error: 'Charge lookup failed: the provider call failed',
        ...(err instanceof Error ? { raw: { name: err.name, message: err.message } } : {}),
      };
    }
    return normalizeLookup(providerResult, chargeRef);
  }

  /**
   * Validates the options of `getCharge` (`INVALID_MANDATE_REQUEST`) and returns a copy with the known fields only.
   * `undefined` (or `null`) means no constraint.
   */
  private lookupOptions(
    providerName: string,
    options: ChargeLookupOptions | undefined,
  ): ChargeLookupOptions | undefined {
    if (options === undefined || options === null) return undefined;
    if (typeof options !== 'object') {
      throw this.invalidMandate('Invalid charge lookup options', providerName);
    }
    const time = (field: 'since' | 'until'): number | undefined => {
      const value: unknown = options[field];
      if (value === undefined) return undefined;
      const ms = typeof value === 'string' ? Date.parse(value) : NaN;
      if (!Number.isFinite(ms)) {
        throw this.invalidMandate(`Invalid ${field}: expected an ISO 8601 date and time`, providerName);
      }
      return ms;
    };
    const since = time('since');
    const until = time('until');
    if (since !== undefined && until !== undefined && until < since) {
      throw this.invalidMandate('Invalid until: it is earlier than since', providerName);
    }
    if (options.mandate !== undefined) this.assertMandate(providerName, options.mandate);

    const copy: ChargeLookupOptions = {};
    if (options.since !== undefined) copy.since = options.since;
    if (options.until !== undefined) copy.until = options.until;
    if (options.mandate !== undefined) copy.mandate = options.mandate;
    return copy;
  }
}
