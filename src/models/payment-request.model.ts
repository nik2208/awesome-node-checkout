/**
 * Unified payment request passed to any provider.
 * All monetary values are in major currency units (e.g. 9.99 for €9.99).
 */
export interface PaymentRequest {
  /** Amount in major currency units (e.g. 9.99) */
  amount: number;

  /** ISO 4217 currency code (e.g. 'EUR', 'USD') */
  currency: string;

  /** Human-readable description of the payment */
  description?: string;

  /** URL to redirect the user to after a successful payment */
  returnUrl: string;

  /** URL to redirect the user to if the payment is cancelled */
  cancelUrl: string;

  /** Optional webhook / server-to-server notification URL forwarded to providers that support it */
  notifyUrl?: string;

  /** External order identifier from the merchant's system */
  orderId?: string;

  /** Arbitrary key-value pairs forwarded to the provider when supported */
  metadata?: Record<string, any>;
}
