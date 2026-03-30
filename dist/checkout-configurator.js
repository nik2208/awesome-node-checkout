"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckoutConfigurator = void 0;
const errors_1 = require("./models/errors");
const checkout_event_bus_1 = require("./events/checkout-event-bus");
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
class CheckoutConfigurator {
    constructor(config = {}) {
        this.config = config;
        this.providers = new Map();
        /** Event bus — subscribe to payment lifecycle events */
        this.events = new checkout_event_bus_1.CheckoutEventBus();
    }
    /**
     * Register a payment provider. Chainable.
     * @throws CheckoutError if a provider with the same name is already registered.
     */
    registerProvider(provider) {
        const key = provider.name.toLowerCase();
        if (this.providers.has(key)) {
            throw new errors_1.CheckoutError(`Provider '${provider.name}' is already registered`, 'PROVIDER_ALREADY_REGISTERED', provider.name);
        }
        this.providers.set(key, provider);
        return this;
    }
    /**
     * Retrieve a registered provider by name.
     * @throws CheckoutError if the provider is not found.
     */
    getProvider(name) {
        const provider = this.providers.get(name.toLowerCase());
        if (!provider) {
            throw new errors_1.CheckoutError(`Payment provider '${name}' not found. Did you call registerProvider()?`, 'PROVIDER_NOT_FOUND', name);
        }
        return provider;
    }
    /** Returns the names of all registered providers */
    getRegisteredProviders() {
        return Array.from(this.providers.keys());
    }
    /** Create a new payment via the specified provider */
    async createPayment(providerName, request) {
        const provider = this.getProvider(providerName);
        const result = await provider.createPayment(request);
        await this.events.emit(result.success ? 'payment.created' : 'payment.failed', {
            provider: providerName,
            paymentId: result.paymentId,
            orderId: request.orderId,
            status: result.status,
            error: result.error,
        });
        return result;
    }
    /** Execute/capture a previously created payment */
    async executePayment(providerName, paymentId, data) {
        const provider = this.getProvider(providerName);
        const result = await provider.executePayment(paymentId, data);
        await this.events.emit(result.success ? 'payment.completed' : 'payment.failed', {
            provider: providerName,
            paymentId,
            status: result.status,
            error: result.error,
        });
        return result;
    }
    /** Retrieve the current status and details of a payment */
    async getPaymentDetails(providerName, paymentId) {
        const provider = this.getProvider(providerName);
        return provider.getPaymentDetails(paymentId);
    }
    /** Issue a full or partial refund */
    async refundPayment(providerName, paymentId, amount) {
        const provider = this.getProvider(providerName);
        const result = await provider.refundPayment(paymentId, amount);
        await this.events.emit('payment.refunded', {
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
    async handleWebhook(providerName, body, headers) {
        const provider = this.getProvider(providerName);
        if (!provider.handleWebhook) {
            throw new errors_1.CheckoutError(`Provider '${providerName}' does not support webhook handling`, 'WEBHOOK_NOT_SUPPORTED', providerName);
        }
        const result = await provider.handleWebhook(body, headers);
        await this.events.emit('webhook.received', {
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
    async handleRedirect(providerName, query) {
        const provider = this.getProvider(providerName);
        if (!provider.handleRedirect) {
            throw new errors_1.CheckoutError(`Provider '${providerName}' does not support redirect handling`, 'REDIRECT_NOT_SUPPORTED', providerName);
        }
        const result = await provider.handleRedirect(query);
        await this.events.emit(result.success ? 'payment.completed' : 'payment.failed', {
            provider: providerName,
            paymentId: result.paymentId,
            status: result.status,
            error: result.error,
        });
        return result;
    }
}
exports.CheckoutConfigurator = CheckoutConfigurator;
//# sourceMappingURL=checkout-configurator.js.map