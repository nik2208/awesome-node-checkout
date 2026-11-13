import { PaymentRequest } from '../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../models/payment-result.model';
import { RefundOptions } from '../models/refund.model';

export type PaymentFlow = 'redirect' | 'webhook' | 'direct';

export interface IPaymentProvider {
  /** Unique provider name, lowercase (e.g. 'paypal', 'nexi', 'satispay') */
  readonly name: string;

  /**
   * Declares the confirmation flow used by this provider:
   * - `redirect`: user is redirected to provider and returns with query params
   * - `webhook`: provider calls a webhook URL asynchronously after payment
   * - `direct`: payment is processed synchronously (e.g. card tokenization)
   */
  readonly flow: PaymentFlow;

  /**
   * Since 2.2.0. `true` only when `refundPayment` sends `options.idempotencyKey` to the provider, so that a retry with
   * the same key never refunds twice. Omitted means `false`.
   */
  readonly supportsRefundIdempotency?: boolean;

  /** Create a new payment and return a result (may include an approvalUrl for redirect flow) */
  createPayment(request: PaymentRequest): Promise<PaymentResult>;

  /** Execute/capture a previously created payment */
  executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;

  /** Retrieve the current status and details of a payment */
  getPaymentDetails(paymentId: string): Promise<PaymentResult>;

  /**
   * Issue a full or partial refund on a completed payment.
   *
   * `options` since 2.2.0 (see `RefundOptions`). A provider written for 2.1 keeps the two-parameter form: it never
   * receives a key, since the configurator refuses one unless `supportsRefundIdempotency` is `true`.
   */
  refundPayment(paymentId: string, amount?: number, options?: RefundOptions): Promise<PaymentResult>;

  /**
   * Handle an incoming webhook or server-to-server outcome notification from the provider.
   * Optional — implement for providers that use the `webhook` flow or support
   * server-to-server notifications.
   */
  handleWebhook?(
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
    query?: Record<string, string>,
    context?: { method?: string; path?: string; rawBody?: Buffer | string },
  ): Promise<WebhookResult>;

  /**
   * Handle the redirect callback from the provider (query params from returnUrl).
   * Optional — implement only for providers that use the `redirect` flow.
   */
  handleRedirect?(query: Record<string, string>): Promise<PaymentResult>;
}

/**
 * Compile-time check only (`npm run typecheck`): ambient and not exported, so it emits no code and no declaration.
 * A provider written for 2.1, with the two-parameter `refundPayment` and no `supportsRefundIdempotency`, must keep
 * implementing `IPaymentProvider` in every 2.x release.
 */
declare class ProviderWrittenFor21 implements IPaymentProvider {
  readonly name: string;
  readonly flow: PaymentFlow;
  createPayment(request: PaymentRequest): Promise<PaymentResult>;
  executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;
  getPaymentDetails(paymentId: string): Promise<PaymentResult>;
  refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
}
