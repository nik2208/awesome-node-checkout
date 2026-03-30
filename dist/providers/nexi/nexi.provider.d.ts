import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';
export interface NexiProviderConfig {
    merchantId: string;
    macKey: string;
    /** Optional group identifier */
    group?: string;
    /** @default 'sandbox' */
    environment?: 'sandbox' | 'production';
}
/**
 * Nexi eCommerce provider.
 * Flow: `redirect` — builds a signed checkout URL, redirects the user to Nexi,
 * then handles the POST-back via `handleRedirect`.
 */
export declare class NexiProvider extends BasePaymentProvider {
    private readonly config;
    readonly name = "nexi";
    readonly flow: "redirect";
    private readonly apiUrl;
    constructor(config: NexiProviderConfig);
    /**
     * Computes the SHA-1 MAC required by Nexi to authenticate the payment request.
     * Format: `codTrans={val}divisa={val}importo={val}{macKey}`
     */
    private generateMac;
    createPayment(request: PaymentRequest): Promise<PaymentResult>;
    /**
     * Validates the POST-back data from Nexi.
     * `data` is the query/body object sent by Nexi to the returnUrl.
     */
    executePayment(paymentId: string, data?: any): Promise<PaymentResult>;
    getPaymentDetails(paymentId: string): Promise<PaymentResult>;
    refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
    /**
     * Handles the POST-back from Nexi to the returnUrl.
     * Nexi sends `esito`, `codTrans`, `importo`, `mac`, etc. as query/body params.
     */
    handleRedirect(query: Record<string, any>): Promise<PaymentResult>;
}
//# sourceMappingURL=nexi.provider.d.ts.map