/** Unified result returned by all payment operations */
export interface PaymentResult {
  success: boolean;

  /** Provider-specific payment identifier */
  paymentId?: string;

  /** Redirect URL for the user (redirect-flow providers: PayPal, Nexi) */
  approvalUrl?: string;

  /** Current payment status (provider-specific string, e.g. 'COMPLETED', 'ACCEPTED') */
  status?: string;

  /** Amount reported by the provider, major units (same unit as PaymentRequest.amount) */
  amount?: number;

  /** ISO 4217 alpha code reported by the provider (e.g. 'EUR') */
  currency?: string;

  /** Order identifier associated with the payment if tracked */
  orderId?: string;

  /** Error message if success is false */
  error?: string;

  /** Raw provider response — useful for debugging or provider-specific fields */
  raw?: any;
}

/** Result returned by handleWebhook() */
export interface WebhookResult {
  success: boolean;
  paymentId?: string;
  orderId?: string;
  status?: string;

  /** Amount reported by the provider, major units (same unit as PaymentRequest.amount) */
  amount?: number;

  /** ISO 4217 alpha code reported by the provider (e.g. 'EUR') */
  currency?: string;

  error?: string;
  raw?: any;
}
