import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';
export interface PayPalProviderConfig {
    clientId: string;
    clientSecret: string;
    /** @default 'sandbox' */
    environment?: 'sandbox' | 'live';
}
/**
 * PayPal Checkout provider.
 * Flow: `redirect` — creates an order, redirects the user to PayPal,
 * then captures the payment on return via `handleRedirect`.
 */
export declare class PayPalProvider extends BasePaymentProvider {
    private readonly config;
    readonly name = "paypal";
    readonly flow: "redirect";
    private client;
    private ordersController;
    constructor(config: PayPalProviderConfig);
    createPayment(request: PaymentRequest): Promise<PaymentResult>;
    executePayment(paymentId: string): Promise<PaymentResult>;
    getPaymentDetails(paymentId: string): Promise<PaymentResult>;
    refundPayment(paymentId: string): Promise<PaymentResult>;
    /**
     * Handles the redirect from PayPal after the user approves the payment.
     * PayPal appends `token` (order ID) and `PayerID` to the returnUrl.
     */
    handleRedirect(query: Record<string, any>): Promise<PaymentResult>;
}
//# sourceMappingURL=paypal.provider.d.ts.map