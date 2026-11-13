import { IPaymentProvider } from './payment-provider.interface';
import { PaymentResult } from '../models/payment-result.model';
import { RefundOptions } from '../models/refund.model';

/**
 * Since 2.2.0. Optional capability of a payment provider: refunds deduplicated by an idempotency key
 * (`RefundOptions.idempotencyKey`), so that a retry of the same refund gets the provider's original answer instead of
 * a second refund. `PayPalProvider` and `SatispayProvider` implement it; `NexiProvider` does not.
 *
 * Implemented next to `IPaymentProvider` (`class X extends BasePaymentProvider implements IRefundIdempotencyProvider`).
 * `IPaymentProvider` and `BasePaymentProvider` are unchanged from 2.1.0, so every existing provider keeps compiling,
 * whatever its `refundPayment` declares. `CheckoutConfigurator.refundPayment` passes the options only to a provider
 * for which `isRefundIdempotencyProvider` is true, and refuses a key for any other (`REFUND_IDEMPOTENCY_NOT_SUPPORTED`).
 *
 * Rules for implementers:
 * - set `supportsRefundIdempotency` to `true` only when `refundPayment` sends `options.idempotencyKey` to the
 *   provider's API;
 * - declare `options` as a third parameter without a default value: `isRefundIdempotencyProvider` reads
 *   `refundPayment.length`, which counts only the parameters before the first one with a default value;
 * - the flag is inherited, but a key reaches the provider only through the `refundPayment` that is called: a subclass
 *   that overrides `refundPayment` must pass `options` on (`super.refundPayment(paymentId, amount, options)`) or set
 *   `supportsRefundIdempotency` to `false`.
 */
export interface IRefundIdempotencyProvider {
  /** `true` only when `refundPayment` sends `options.idempotencyKey` to the provider. */
  readonly supportsRefundIdempotency: boolean;

  /** `refundPayment` of `IPaymentProvider`, with `options.idempotencyKey` sent as the provider's idempotency key. */
  refundPayment(paymentId: string, amount?: number, options?: RefundOptions): Promise<PaymentResult>;
}

/**
 * True when `p` has `supportsRefundIdempotency: true` and a `refundPayment` that can receive the options: one that
 * declares three parameters or more, or none at all (`length` 0: a rest parameter, or a wrapper that passes every
 * argument on). A `refundPayment` that declares one or two parameters cannot receive a key, for example a 2.1
 * override `refundPayment(id, amount)` in a subclass of `PayPalProvider` or `SatispayProvider`, which inherits the
 * flag: this is then false, and the configurator refuses the key instead of sending the refund without it.
 */
export function isRefundIdempotencyProvider(p: unknown): p is IPaymentProvider & IRefundIdempotencyProvider {
  if (p === null || (typeof p !== 'object' && typeof p !== 'function')) return false;
  const record = p as Record<string, unknown>;
  const refund = record['refundPayment'];
  if (record['supportsRefundIdempotency'] !== true || typeof refund !== 'function') return false;
  return refund.length === 0 || refund.length >= 3;
}
