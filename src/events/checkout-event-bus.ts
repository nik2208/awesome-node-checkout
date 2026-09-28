export type CheckoutEventName =
  | 'payment.created'
  | 'payment.completed'
  | 'payment.failed'
  | 'payment.refunded'
  | 'webhook.received';

export interface CheckoutEventPayload {
  provider: string;
  paymentId?: string;
  orderId?: string;
  status?: string;
  error?: string;
  verified?: boolean;
  data?: any;
  raw?: unknown;
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
export class CheckoutEventBus {
  private readonly listeners: Map<CheckoutEventName, EventListener[]> = new Map();

  on(event: CheckoutEventName, listener: EventListener): this {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...handlers, listener]);
    return this;
  }

  off(event: CheckoutEventName, listener: EventListener): this {
    const handlers = this.listeners.get(event);
    if (handlers) {
      this.listeners.set(event, handlers.filter((h) => h !== listener));
    }
    return this;
  }

  async emit(
    event: CheckoutEventName,
    payload: Omit<CheckoutEventPayload, 'timestamp'>,
  ): Promise<void> {
    const handlers = this.listeners.get(event) ?? [];
    const fullPayload: CheckoutEventPayload = { ...payload, timestamp: new Date() };
    await Promise.all(handlers.map((h) => h(fullPayload)));
  }
}
