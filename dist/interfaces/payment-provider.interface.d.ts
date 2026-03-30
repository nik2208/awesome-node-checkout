import { PaymentRequest } from '../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../models/payment-result.model';
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
    /** Create a new payment and return a result (may include an approvalUrl for redirect flow) */
    createPayment(request: PaymentRequest): Promise<PaymentResult>;
    /** Execute/capture a previously created payment */
    executePayment(paymentId: string, data?: any): Promise<PaymentResult>;
    /** Retrieve the current status and details of a payment */
    getPaymentDetails(paymentId: string): Promise<PaymentResult>;
    /** Issue a full or partial refund on a completed payment */
    refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
    /**
     * Handle an incoming webhook notification from the provider.
     * Optional — implement only for providers that use the `webhook` flow.
     */
    handleWebhook?(body: any, headers: Record<string, string>): Promise<WebhookResult>;
    /**
     * Handle the redirect callback from the provider (query params from returnUrl).
     * Optional — implement only for providers that use the `redirect` flow.
     */
    handleRedirect?(query: Record<string, any>): Promise<PaymentResult>;
}
//# sourceMappingURL=payment-provider.interface.d.ts.map