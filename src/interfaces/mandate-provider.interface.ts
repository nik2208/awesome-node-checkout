import { IPaymentProvider } from './payment-provider.interface';
import {
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from '../models/mandate.model';

/**
 * Optional capability of a payment provider: recurring payments (mandates).
 *
 * Implemented next to `IPaymentProvider` (`class X extends BasePaymentProvider implements
 * IMandateProvider`); `IPaymentProvider` itself is unchanged. Call these methods through
 * `CheckoutConfigurator`, which validates the inputs and normalizes the outcomes (fail closed).
 *
 * Rules for implementers:
 * - Stateless: everything needed later is in the returned `MandatePendingState` / `Mandate`.
 * - Identities (contract number, vault id, token id, order id) come from `pending` / `mandate` or
 *   from authenticated fields, never from query strings or unsigned callback fields.
 * - `verified: true` only for outcomes authenticated by a MAC/signature checked by the library or
 *   by an authenticated server-to-server response.
 * - Timeouts, 5xx, unparseable bodies and merchant-side refusals (401/403/429, auth/MAC errors,
 *   rate limiting) are `unknown`, never `failed`.
 * - Append `mandate_ref` to `returnUrl`, `cancelUrl` and `notifyUrl` with `appendMandateRef`.
 * - Never retry on your own.
 */
export interface IMandateProvider {
  /** Starts a setup (customer present). The setup always includes the first charge. */
  createMandate(request: MandateSetupRequest): Promise<MandateSetupStart>;
  /**
   * Idempotent: may be called twice (redirect + server notification) for the same pending state.
   * Must also be safe to call again with an empty `input` (`{}`) at any time, including after a
   * terminal outcome: apps re-run it from a job to resolve a first charge reported `unknown`. Re-read
   * the setup server-to-server or replay the same idempotency keys; never start a second first
   * charge. Without a way to re-read, return an unverified, non-terminal outcome.
   */
  confirmMandate(pending: MandatePendingState, input: MandateCallbackInput): Promise<MandateSetupOutcome>;
  /** Merchant-initiated charge (customer absent). Idempotent on `charge.chargeRef`. */
  chargeMandate(mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult>;
  /** Re-reads usability from the provider when it can; otherwise returns verified: false. */
  getMandate(mandate: Mandate): Promise<MandateStatusResult>;
  revokeMandate(mandate: Mandate): Promise<MandateRevokeResult>;
}

const MANDATE_METHODS = [
  'createMandate',
  'confirmMandate',
  'chargeMandate',
  'getMandate',
  'revokeMandate',
] as const;

/** True when `p` implements all five `IMandateProvider` methods. */
export function isMandateProvider(p: unknown): p is IPaymentProvider & IMandateProvider {
  if (p === null || (typeof p !== 'object' && typeof p !== 'function')) return false;
  const candidate = p as Record<string, unknown>;
  return MANDATE_METHODS.every((method) => typeof candidate[method] === 'function');
}
