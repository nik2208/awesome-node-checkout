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
  /**
   * True only when the outcome reported by this event was authenticated, either by a
   * provider signature/MAC checked by the library or by an authenticated server-to-server
   * read from the provider API. Always false for `payment.created` (no outcome exists yet)
   * and for any outcome built from unauthenticated input. When false on
   * `payment.completed` / `payment.failed` / `webhook.received`, `paymentId` and `orderId`
   * are omitted.
   */
  verified: boolean;
  data?: any;
  raw?: unknown;
  timestamp: Date;
}

/**
 * Wraps an error thrown (or a value rejected) by a consumer event listener.
 * The consumer's original value is never mutated: it is available unchanged as `cause`,
 * and `message` is copied from it (or `String(value)` for non-Error values).
 */
export class CheckoutListenerError extends Error {
  /** The original value thrown by the listener, untouched */
  readonly cause: unknown;
  /** The event whose listener threw */
  readonly event: CheckoutEventName;

  constructor(event: CheckoutEventName, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CheckoutListenerError';
    this.cause = cause;
    this.event = event;
    Object.setPrototypeOf(this, CheckoutListenerError.prototype);
  }
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
    await Promise.all(
      handlers.map(async (h) => {
        try {
          await h(fullPayload);
        } catch (err) {
          // Never mutate the consumer's error (it may be frozen): wrap it instead.
          throw new CheckoutListenerError(event, err);
        }
      }),
    );
  }
}
