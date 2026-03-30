import { IPaymentProvider, PaymentFlow } from '../interfaces/payment-provider.interface';
import { PaymentRequest } from '../models/payment-request.model';
import { PaymentResult } from '../models/payment-result.model';
/**
 * Convenience base class for building custom payment providers.
 * Provides the `errorResult` helper to normalize error handling.
 *
 * Usage:
 * ```typescript
 * export class MyProvider extends BasePaymentProvider {
 *   readonly name = 'myprovider';
 *   readonly flow = 'redirect' as const;
 *   // ... implement abstract methods
 * }
 * ```
 */
export declare abstract class BasePaymentProvider implements IPaymentProvider {
    abstract readonly name: string;
    abstract readonly flow: PaymentFlow;
    abstract createPayment(request: PaymentRequest): Promise<PaymentResult>;
    abstract executePayment(paymentId: string, data?: any): Promise<PaymentResult>;
    abstract getPaymentDetails(paymentId: string): Promise<PaymentResult>;
    abstract refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
    /**
     * Helper to produce a normalized error PaymentResult.
     * Extracts message from Error instances automatically.
     */
    protected errorResult(error: unknown, fallback?: string): PaymentResult;
}
//# sourceMappingURL=base-payment-provider.abstract.d.ts.map