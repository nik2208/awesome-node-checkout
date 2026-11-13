import { IPaymentProvider } from './payment-provider.interface';
import { ChargeLookupOptions, ChargeLookupResult } from '../models/mandate.model';

/**
 * Since 2.2.0. Optional capability of a payment provider: a read-only lookup of a charge by its `chargeRef` ("did
 * money move for this chargeRef?"), for a charge whose outcome is `unknown` when a retry is not allowed (the
 * subscription closed meanwhile, the replay window has passed, an operator resolves it by hand).
 *
 * Implemented next to `IPaymentProvider` (`class X extends BasePaymentProvider implements IChargeLookupProvider`);
 * `IPaymentProvider` and `IMandateProvider` are unchanged, so existing custom providers keep compiling. Call it
 * through `CheckoutConfigurator.getCharge`, which validates the inputs and normalizes the result (fail closed).
 *
 * Rules for implementers:
 * - `absent` only for an authenticated answer that the provider holds no transaction for `chargeRef`: a lookup that
 *   failed says nothing and is `unknown`;
 * - `verified: true` only for an answer authenticated by a MAC checked by the library or by an authenticated
 *   server-to-server read;
 * - `raw` never carries other customers' data, nor an SDK error (it carries the request and its bearer token).
 */
export interface IChargeLookupProvider {
  /** Read-only: never charges, never refunds. Never throws for provider errors: returns 'unknown'. */
  getCharge(chargeRef: string, options?: ChargeLookupOptions): Promise<ChargeLookupResult>;
}

/** True when `p` has a `getCharge` function. */
export function isChargeLookupProvider(p: unknown): p is IPaymentProvider & IChargeLookupProvider {
  if (p === null || (typeof p !== 'object' && typeof p !== 'function')) return false;
  return typeof (p as Record<string, unknown>)['getCharge'] === 'function';
}
