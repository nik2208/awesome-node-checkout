export type CheckoutErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PAYMENT_FAILED'
  | 'WEBHOOK_NOT_SUPPORTED'
  | 'REDIRECT_NOT_SUPPORTED'
  | 'TRANSACTION_NOT_FOUND'
  | 'INSECURE_CONFIGURATION'
  | 'INVALID_AMOUNT'
  | 'MANDATES_NOT_SUPPORTED'
  | 'INVALID_MANDATE_REQUEST'
  /** Since 2.2.0: `getCharge` on a provider without `IChargeLookupProvider` (HTTP 422 through the router). */
  | 'CHARGE_LOOKUP_NOT_SUPPORTED'
  /**
   * Since 2.2.0: `refundPayment` with invalid `options`, such as an `idempotencyKey` that is not a string matching
   * `REFUND_IDEMPOTENCY_KEY_PATTERN` (HTTP 400 through the router).
   */
  | 'INVALID_REFUND_REQUEST'
  /**
   * Since 2.2.0: `refundPayment` with an `idempotencyKey` on a provider whose `supportsRefundIdempotency` is not
   * `true`, such as Nexi (HTTP 422 through the router).
   */
  | 'REFUND_IDEMPOTENCY_NOT_SUPPORTED';

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly code: CheckoutErrorCode,
    public readonly provider?: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CheckoutError);
    }
  }
}
