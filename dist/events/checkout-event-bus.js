"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckoutEventBus = void 0;
/**
 * Simple event bus for checkout lifecycle events.
 *
 * Usage:
 * ```typescript
 * checkout.events.on('payment.completed', ({ provider, paymentId }) => {
 *   console.log(`Payment ${paymentId} completed via ${provider}`);
 * });
 * ```
 */
class CheckoutEventBus {
    constructor() {
        this.listeners = new Map();
    }
    on(event, listener) {
        const handlers = this.listeners.get(event) ?? [];
        this.listeners.set(event, [...handlers, listener]);
        return this;
    }
    off(event, listener) {
        const handlers = this.listeners.get(event);
        if (handlers) {
            this.listeners.set(event, handlers.filter((h) => h !== listener));
        }
        return this;
    }
    async emit(event, payload) {
        const handlers = this.listeners.get(event) ?? [];
        const fullPayload = { ...payload, timestamp: new Date() };
        await Promise.all(handlers.map((h) => h(fullPayload)));
    }
}
exports.CheckoutEventBus = CheckoutEventBus;
//# sourceMappingURL=checkout-event-bus.js.map