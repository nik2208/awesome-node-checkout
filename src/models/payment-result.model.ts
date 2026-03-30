/** Unified result returned by all payment operations */
export interface PaymentResult {
  success: boolean;

  /** Provider-specific payment identifier */
  paymentId?: string;

  /** Redirect URL for the user (redirect-flow providers: PayPal, Nexi) */
  approvalUrl?: string;

  /** Current payment status (provider-specific string, e.g. 'COMPLETED', 'ACCEPTED') */
  status?: string;

  /** Error message if success is false */
  error?: string;

  /** Raw provider response — useful for debugging or provider-specific fields */
  raw?: any;
}

/** Result returned by handleWebhook() */
export interface WebhookResult {
  success: boolean;
  paymentId?: string;
  status?: string;
  error?: string;
  raw?: any;
}
