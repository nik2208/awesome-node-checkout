/** Since 2.2.0. */
export const REFUND_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Since 2.2.0. Options of `refundPayment`. */
export interface RefundOptions {
  /**
   * Since 2.2.0. Idempotency key of ONE intended refund: unique per refund, stable across the retries of that refund,
   * never reused for another amount or payment (derive it, e.g. `${chargeRef}-R1`). Matches
   * REFUND_IDEMPOTENCY_KEY_PATTERN. A retry with the same key gets the provider's original answer instead of a second
   * refund, while the provider keeps the key:
   * - PayPal: `PayPal-Request-Id` (kept 45 days);
   * - Satispay: `Idempotency-Key` (retention not documented by Satispay: retry promptly);
   * - Nexi: not supported (the storno API has no key): the configurator refuses the call.
   */
  idempotencyKey?: string;
}

/** True for a string matching REFUND_IDEMPOTENCY_KEY_PATTERN. */
export function isRefundIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && REFUND_IDEMPOTENCY_KEY_PATTERN.test(value);
}
