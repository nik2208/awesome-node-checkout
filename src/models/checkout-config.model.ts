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
}
