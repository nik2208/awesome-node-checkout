import { IPaymentProvider, PaymentFlow } from '../interfaces/payment-provider.interface';
import { PaymentRequest } from '../models/payment-request.model';
import { PaymentResult } from '../models/payment-result.model';
import type { RefundOptions } from '../models/refund.model';
import type { IRefundIdempotencyProvider } from '../interfaces/refund-idempotency-provider.interface';

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
export abstract class BasePaymentProvider implements IPaymentProvider {
  abstract readonly name: string;
  abstract readonly flow: PaymentFlow;

  abstract createPayment(request: PaymentRequest): Promise<PaymentResult>;
  abstract executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;
  abstract getPaymentDetails(paymentId: string): Promise<PaymentResult>;
  /**
   * Unchanged from 2.1.0. To take refund idempotency keys (since 2.2.0), also implement `IRefundIdempotencyProvider`:
   * `refundPayment(paymentId, amount?, options?: RefundOptions)` and `supportsRefundIdempotency`.
   */
  abstract refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;

  /**
   * Helper to produce a normalized error PaymentResult.
   * Extracts message from Error instances automatically.
   */
  protected errorResult(error: unknown, fallback = 'Unknown error'): PaymentResult {
    let message = error instanceof Error ? error.message : fallback;
    if (error instanceof SyntaxError || /JSON|Unexpected token/i.test(message)) {
      message = 'Invalid provider response';
    }
    return { success: false, error: message };
  }
}

/**
 * Compile-time check only (`npm run typecheck`): ambient and not exported, so it emits no code and no declaration.
 * A subclass written for 2.1, with the two-parameter `refundPayment`, must keep compiling in every 2.x release.
 */
declare class SubclassWrittenFor21 extends BasePaymentProvider {
  readonly name: string;
  readonly flow: PaymentFlow;
  createPayment(request: PaymentRequest): Promise<PaymentResult>;
  executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;
  getPaymentDetails(paymentId: string): Promise<PaymentResult>;
  refundPayment(paymentId: string, amount?: number): Promise<PaymentResult>;
}

/**
 * Compile-time check only, as above. A subclass written for 2.1 whose `refundPayment` declared a third parameter of
 * its own, of any type, must keep compiling unchanged (#44).
 */
declare class SubclassWithItsOwnThirdParameter extends BasePaymentProvider {
  readonly name: string;
  readonly flow: PaymentFlow;
  createPayment(request: PaymentRequest): Promise<PaymentResult>;
  executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;
  getPaymentDetails(paymentId: string): Promise<PaymentResult>;
  refundPayment(paymentId: string, amount?: number, reason?: 'duplicate' | 'fraudulent'): Promise<PaymentResult>;
}

/**
 * Compile-time check only, as above: a provider written for 2.2 that takes refund idempotency keys (README "Custom
 * Provider").
 */
declare class SubclassWithRefundKeys extends BasePaymentProvider implements IRefundIdempotencyProvider {
  readonly name: string;
  readonly flow: PaymentFlow;
  readonly supportsRefundIdempotency: boolean;
  createPayment(request: PaymentRequest): Promise<PaymentResult>;
  executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult>;
  getPaymentDetails(paymentId: string): Promise<PaymentResult>;
  refundPayment(paymentId: string, amount?: number, options?: RefundOptions): Promise<PaymentResult>;
}
