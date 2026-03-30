import { IPaymentProvider } from './interfaces/payment-provider.interface';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult, WebhookResult } from './models/payment-result.model';
import { CheckoutConfig } from './models/checkout-config.model';
import { CheckoutEventBus } from './events/checkout-event-bus';
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
export declare class CheckoutConfigurator {
    private readonly config;
    private readonly providers;
    /** Event bus — subscribe to payment lifecycle events */
    readonly events: CheckoutEventBus;
    constructor(config?: CheckoutConfig);
    /**
     * Register a payment provider. Chainable.
     * @throws CheckoutError if a provider with the same name is already registered.
     */
    registerProvider(provider: IPaymentProvider): this;
    /**
     * Retrieve a registered provider by name.
     * @throws CheckoutError if the provider is not found.
     */
    getProvider(name: string): IPaymentProvider;
    /** Returns the names of all registered providers */
    getRegisteredProviders(): string[];
    /** Create a new payment via the specified provider */
    createPayment(providerName: string, request: PaymentRequest): Promise<PaymentResult>;
    /** Execute/capture a previously created payment */
    executePayment(providerName: string, paymentId: string, data?: any): Promise<PaymentResult>;
    /** Retrieve the current status and details of a payment */
    getPaymentDetails(providerName: string, paymentId: string): Promise<PaymentResult>;
    /** Issue a full or partial refund */
    refundPayment(providerName: string, paymentId: string, amount?: number): Promise<PaymentResult>;
    /**
     * Handle an incoming webhook from the provider.
     * @throws CheckoutError if the provider does not support webhooks.
     */
    handleWebhook(providerName: string, body: any, headers: Record<string, string>): Promise<WebhookResult>;
    /**
     * Handle the redirect callback from the provider (query params).
     * @throws CheckoutError if the provider does not support redirect handling.
     */
    handleRedirect(providerName: string, query: Record<string, any>): Promise<PaymentResult>;
}
//# sourceMappingURL=checkout-configurator.d.ts.map