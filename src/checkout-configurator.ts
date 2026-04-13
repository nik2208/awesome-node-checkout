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

  /** Event bus — subscribe to payment lifecycle events */
  readonly events: CheckoutEventBus = new CheckoutEventBus();

  constructor(private readonly config: CheckoutConfig = {}) {}

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

  /** Create a new payment via the specified provider */
  async createPayment(providerName: string, request: PaymentRequest): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    const result = await provider.createPayment(request);
    await this.emit(result.success ? 'payment.created' : 'payment.failed', {
      provider: providerName,
      paymentId: result.paymentId,
      orderId: request.orderId,
      status: result.status,
      error: result.error,
    });
    return result;
  }

  /** Execute/capture a previously created payment */
  async executePayment(
    providerName: string,
    paymentId: string,
    data?: Record<string, string>,
  ): Promise<PaymentResult> {
    const provider = this.getProvider(providerName);
    const result = await provider.executePayment(paymentId, data);
    await this.emit(result.success ? 'payment.completed' : 'payment.failed', {
      provider: providerName,
      paymentId,
      status: result.status,
      error: result.error,
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
    await this.emit('payment.refunded', {
      provider: providerName,
      paymentId,
      status: result.status,
      error: result.error,
    });
    return result;
  }

  /**
   * Handle an incoming webhook from the provider.
   * @throws CheckoutError if the provider does not support webhooks.
   */
  async handleWebhook(
    providerName: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<WebhookResult> {
    const provider = this.getProvider(providerName);
    if (!provider.handleWebhook) {
      throw new CheckoutError(
        `Provider '${providerName}' does not support webhook handling`,
        'WEBHOOK_NOT_SUPPORTED',
        providerName,
      );
    }
    const result = await provider.handleWebhook(body, headers);
    await this.emit('webhook.received', {
      provider: providerName,
      paymentId: result.paymentId,
      status: result.status,
      error: result.error,
      data: body,
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
    await this.emit(result.success ? 'payment.completed' : 'payment.failed', {
      provider: providerName,
      paymentId: result.paymentId,
      status: result.status,
      error: result.error,
    });
    return result;
  }
}
