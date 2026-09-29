import { IPaymentProvider } from './interfaces/payment-provider.interface';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult, WebhookResult } from './models/payment-result.model';
import { CheckoutConfig } from './models/checkout-config.model';
import { CheckoutError } from './models/errors';
import { CheckoutEventBus, CheckoutEventName, CheckoutEventPayload } from './events/checkout-event-bus';

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

  /** Issue a full or partial refund */
  async refundPayment(
    providerName: string,
    paymentId: string,
    amount?: number,
  ): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    const result = await provider.refundPayment(paymentId, amount);
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
}
