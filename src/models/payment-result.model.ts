/**
 * Since 2.3.0. Stable reason set by the library when the call failed to authenticate to the provider. Compare this,
 * never `error`. More codes may be added in minor releases: treat an unknown code like no code.
 * - 'PROVIDER_AUTH_FAILED': the provider rejected the merchant's credentials or access token (PayPal: the OAuth token
 *   request answered 400 or 401, or the API call itself answered 401). Check the credentials and the environment.
 * - 'PROVIDER_AUTH_UNAVAILABLE': the access token could not be obtained for another reason (PayPal: the token request
 *   answered another HTTP status, failed on the network or timed out). Transient.
 * Neither is a decline. When the token request failed (either code), this call sent nothing to the API: it charged,
 * captured, refunded, created and deleted nothing. After an API 401 the call was sent and refused, and its result keeps
 * the operation's usual meaning (a refund, for example, stays uncertain).
 */
export type ProviderErrorCode = 'PROVIDER_AUTH_FAILED' | 'PROVIDER_AUTH_UNAVAILABLE';

/** Unified result returned by all payment operations */
export interface PaymentResult {
  /** True when payment is confirmed/completed with a valid captured amount */
  success: boolean;

  /** Provider-specific payment identifier */
  paymentId?: string;

  /** Redirect URL for the user (redirect-flow providers: PayPal, Nexi) */
  approvalUrl?: string;

  /** Current payment status (provider-specific string, e.g. 'COMPLETED', 'ACCEPTED') */
  status?: string;

  /** Provider-specific capture status if distinct from overall order status (e.g. PayPal) */
  captureStatus?: string;

  /** Amount reported by the provider, major units (same unit as PaymentRequest.amount) */
  amount?: number;

  /** ISO 4217 alpha code reported by the provider (e.g. 'EUR') */
  currency?: string;

  /**
   * Since 2.2.0. Total refunded so far for this charge, in major units of the charge's currency, as the provider reports
   * it. `0` means the provider reports no refund. Absent (undefined) means the provider does not report it: never read
   * absence as 0.
   *
   * Set only by PayPal `getPaymentDetails` (the order's COMPLETED refunds); the other providers leave it undefined.
   */
  refundedAmount?: number;

  /** Order identifier associated with the payment if tracked */
  orderId?: string;

  /** Error message if success is false */
  error?: string;

  /**
   * Since 2.3.0. Set by a built-in provider when it could not authenticate (see `ProviderErrorCode`). With a failed
   * token request a PayPal refund is `status: 'REFUND_FAILED'` (nothing was sent); after an API 401 it has no `status`
   * and stays uncertain.
   */
  errorCode?: ProviderErrorCode;

  /**
   * True only when this outcome was authenticated: by a provider signature/MAC checked by
   * the library (e.g. the Nexi 7-field outcome MAC) or by an authenticated server-to-server
   * read from the provider API (e.g. PayPal capture, Satispay `GET /payments/{id}`).
   * `success: false` with `verified: true` is a genuine, authenticated failure (e.g. KO, CANCELED).
   * Providers that do not set it are treated as unverified (fail closed).
   * Not meaningful for `createPayment` (no outcome yet): the configurator does not trust it there.
   */
  verified?: boolean;

  /** Raw provider response — preserved in events and returned models, stripped from HTTP router responses */
  raw?: any;
}

/** Result returned by handleWebhook() */
export interface WebhookResult {
  /** True when payment is confirmed/completed with a valid captured amount */
  success: boolean;
  /**
   * True only when the notification's outcome was authenticated by a provider signature/MAC
   * or by an authenticated server-to-server read from the provider API. Anything other than
   * `true` is treated as unverified.
   */
  verified: boolean;
  paymentId?: string;
  orderId?: string;
  status?: string;
  captureStatus?: string;

  /** Amount reported by the provider, major units (same unit as PaymentRequest.amount) */
  amount?: number;

  /** ISO 4217 alpha code reported by the provider (e.g. 'EUR') */
  currency?: string;

  error?: string;
  raw?: any;
}

/**
 * Compile-time check only (`npm run typecheck`): ambient and not exported, so it emits no code and no declaration.
 * A `PaymentResult` written for 2.2.0, without `errorCode`, keeps compiling (#53).
 */
declare class PaymentResultWrittenFor22 implements PaymentResult {
  success: boolean;
  paymentId?: string;
  status?: string;
  error?: string;
  verified?: boolean;
  raw?: unknown;
}
