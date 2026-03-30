import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { ITransactionStore } from '../../interfaces/transaction-store.interface';
export interface SatispayProviderConfig {
    keyId: string;
    /**
     * RSA private key in PEM format (string content, not a file path).
     * Load with: `fs.readFileSync('private.pem', 'utf8')`
     */
    privateKey: string;
    /** @default 'sandbox' */
    environment?: 'sandbox' | 'production';
    /**
     * Base URL of the host application.
     * Used to build the `callback_url` sent to Satispay.
     * Example: 'https://myapp.com'
     */
    serverUrl?: string;
    /**
     * Custom transaction store for correlating webhooks with orders.
     * Defaults to InMemoryTransactionStore.
     * Use a persistent store (Redis, DB) in multi-instance deployments.
     */
    transactionStore?: ITransactionStore;
}
/**
 * Satispay Business API provider.
 * Flow: `webhook` — creates a MATCH_CODE payment, user pays via Satispay app,
 * Satispay calls the `callback_url` webhook, which is correlated to the order
 * via the `ITransactionStore`. The redirect is then verified via `handleRedirect`.
 */
export declare class SatispayProvider extends BasePaymentProvider {
    private readonly config;
    readonly name = "satispay";
    readonly flow: "webhook";
    private readonly apiUrl;
    private readonly transactionStore;
    constructor(config: SatispayProviderConfig);
    private buildSignatureHeaders;
    private request;
    createPayment(request: PaymentRequest): Promise<PaymentResult>;
    /** For Satispay, execute is equivalent to a status check */
    executePayment(paymentId: string): Promise<PaymentResult>;
    getPaymentDetails(paymentId: string): Promise<PaymentResult>;
    refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
    /**
     * Handles the async webhook notification from Satispay.
     * Satispay calls this URL with `payment_id` (the Satispay payment UUID).
     * We verify the current payment status via an API call.
     */
    handleWebhook(body: any, _headers: Record<string, string>): Promise<WebhookResult>;
    /**
     * Handles the redirect back to the merchant app after the Satispay flow.
     * Looks up the transaction by `order_id` in the store, then verifies status.
     */
    handleRedirect(query: Record<string, any>): Promise<PaymentResult>;
}
//# sourceMappingURL=satispay.provider.d.ts.map