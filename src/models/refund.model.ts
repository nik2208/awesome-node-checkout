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
   * - Satispay: `Idempotency-Key` (retention not documented by Satispay: retry promptly). Refunds and charges share
   *   one key space there (each is a `POST /payments`), so a Satispay refund key must never equal a `chargeRef`, an
   *   `orderId` or `setup-<orderId>` of the same account: Satispay can answer with that charge instead of creating
   *   the refund, which is then reported uncertain, on every retry;
   * - Nexi: not supported (the storno API has no key): the configurator refuses the call.
   */
  idempotencyKey?: string;
}

/** True for a string matching REFUND_IDEMPOTENCY_KEY_PATTERN. */
export function isRefundIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && REFUND_IDEMPOTENCY_KEY_PATTERN.test(value);
}

/** Since 2.2.0, internal: what `readRefundOptions` read. */
export type RefundOptionsRead = { ok: true; idempotencyKey?: string } | { ok: false; error: string };

/**
 * Since 2.2.0, internal. Reads the `options` argument of a built-in provider's `refundPayment`, typed `unknown` there
 * so that a subclass written for 2.1 whose override declared a third parameter of its own keeps compiling. No key for
 * `undefined`, `null`, or an object without one. Anything else is an error, so the refund is refused without any
 * request: options that are not an object, a field other than `idempotencyKey` (a misspelt key is never ignored),
 * or a key that does not match REFUND_IDEMPOTENCY_KEY_PATTERN.
 */
export function readRefundOptions(options: unknown): RefundOptionsRead {
  if (options === undefined || options === null) return { ok: true };
  if (typeof options !== 'object' || Array.isArray(options)) return { ok: false, error: 'Invalid refund options' };
  const record = options as Record<string, unknown>;
  if (Object.keys(record).some((field) => field !== 'idempotencyKey')) {
    return { ok: false, error: 'Invalid refund options' };
  }
  const idempotencyKey = record['idempotencyKey'];
  if (idempotencyKey === undefined) return { ok: true };
  if (!isRefundIdempotencyKey(idempotencyKey)) return { ok: false, error: 'Invalid refund idempotency key' };
  return { ok: true, idempotencyKey };
}
