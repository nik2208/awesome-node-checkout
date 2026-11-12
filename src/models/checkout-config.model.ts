import type { CheckoutEventName } from '../events/checkout-event-bus';

/**
 * Global configuration for CheckoutConfigurator.
 */
export interface CheckoutConfig {
  /**
   * When `true`, the event bus emits lifecycle events for every payment
   * operation (payment.created, payment.completed, payment.failed, etc.).
   * @default true
   */
  emitEvents?: boolean;

  /**
   * Receives an error raised while emitting an event after a mandate provider call has completed
   * (`mandate.created`, `mandate.setup_failed` and the first `charge.*` from `confirmMandate`,
   * `charge.*` from `chargeMandate`, `mandate.revoked` from `revokeMandate`). Usually a
   * `CheckoutListenerError` (original value in `cause`).
   *
   * Those methods never reject because of a listener: money may already have moved, so the
   * normalized result always reaches the caller and the error comes here instead. When this
   * hook is not set, the error is logged with `console.error('[awesome-node-checkout]', err)`.
   * An error thrown by the hook itself is logged and never rejects the method.
   *
   * Every other event, `mandate.setup_started` included, still propagates listener errors to the
   * caller.
   */
  onListenerError?: (err: unknown, event: CheckoutEventName) => void | Promise<void>;
}
