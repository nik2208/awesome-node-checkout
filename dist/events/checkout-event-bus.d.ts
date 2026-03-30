export type CheckoutEventName = 'payment.created' | 'payment.completed' | 'payment.failed' | 'payment.refunded' | 'webhook.received';
export interface CheckoutEventPayload {
    provider: string;
    paymentId?: string;
    orderId?: string;
    status?: string;
    error?: string;
    data?: any;
    timestamp: Date;
}
type EventListener = (payload: CheckoutEventPayload) => void | Promise<void>;
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
export declare class CheckoutEventBus {
    private readonly listeners;
    on(event: CheckoutEventName, listener: EventListener): this;
    off(event: CheckoutEventName, listener: EventListener): this;
    emit(event: CheckoutEventName, payload: Omit<CheckoutEventPayload, 'timestamp'>): Promise<void>;
}
export {};
//# sourceMappingURL=checkout-event-bus.d.ts.map