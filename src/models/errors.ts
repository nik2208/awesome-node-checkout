export type CheckoutErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PAYMENT_FAILED'
  | 'WEBHOOK_NOT_SUPPORTED'
  | 'REDIRECT_NOT_SUPPORTED'
  | 'TRANSACTION_NOT_FOUND';

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
