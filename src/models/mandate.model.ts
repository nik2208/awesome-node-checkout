/**
 * Recurring payments (mandates).
 *
 * The library provides mandate primitives only (create, confirm, charge, get, revoke). The app
 * owns scheduling, retries and dunning, subscription state, prices, VAT and invoices. Every
 * object below is plain JSON: the app persists it and passes it back later, so a restart or a
 * second instance loses nothing. The library keeps no mandate state in memory.
 */

/** `mandateRef`: 5-30 chars of `A-Z a-z 0-9 _ -` (Nexi `num_contratto` limits). */
export const MANDATE_REF_PATTERN = /^[A-Za-z0-9_-]{5,30}$/;

/**
 * `orderId` of a setup and `chargeRef` of a charge: 2-30 chars of `A-Z a-z 0-9 -`, no
 * underscore (Nexi `codiceTransazione` limits).
 */
export const CHARGE_REF_PATTERN = /^[A-Za-z0-9-]{2,30}$/;

export interface MandateSetupRequest {
  /** Fresh for EVERY setup attempt (never reuse one after a failed or abandoned setup). /^[A-Za-z0-9_-]{5,30}$/ (Nexi num_contratto limits). */
  mandateRef: string;
  /**
   * Order code of the FIRST charge; also its chargeRef. Fresh for every setup attempt.
   * /^[A-Za-z0-9-]{2,30}$/ (no underscore: Nexi codiceTransazione). Never pass it to
   * `chargeMandate`: an `unknown` first charge is resolved by re-running `confirmMandate`.
   */
  orderId: string;
  /** First charge, major units; validated with toMinorUnits(amount, currency). */
  amount: number;
  /** ISO 4217 alpha-3. A provider may restrict it (Nexi: EUR only). */
  currency: string;
  /** Shown to the payer (PayPal vault description, Satispay reason). 1-127 chars. */
  description: string;
  /**
   * Where the customer comes back after approving. With the Express adapter it must point to
   * `<mount>/<provider>/mandate/callback`; the provider appends `mandate_ref`.
   */
  returnUrl: string;
  /** Where the customer comes back after cancelling. Same rule as `returnUrl`. */
  cancelUrl: string;
  /** Server-to-server notification URL, where supported (Nexi urlpost, Satispay callback_url). */
  notifyUrl?: string;
}

/**
 * Persist verbatim; pass back to confirmMandate. JSON-serializable. Keep it after a terminal
 * outcome consumed it while that outcome's `firstCharge` is `unknown`: it is the input of
 * `confirmMandate(provider, pending, {})`, which resolves the first charge.
 */
export interface MandatePendingState {
  provider: string;
  mandateRef: string;
  orderId: string;
  amount: number;
  currency: string;
  /** Provider object created at setup: PayPal order id, Satispay authorization token id, Nexi codTrans. */
  providerRef: string;
  /** ISO 8601 */
  createdAt: string;
}

export interface MandateSetupStart {
  success: boolean;
  /** Where to send the customer. */
  approvalUrl?: string;
  pending?: MandatePendingState;
  error?: string;
  raw?: unknown;
}

export type MandateStatus = 'active' | 'revoked';

/** Persist verbatim; pass back to chargeMandate / getMandate / revokeMandate. JSON-serializable. */
export interface Mandate {
  provider: string;
  mandateRef: string;
  /**
   * Nexi: num_contratto (= mandateRef). PayPal: vault payment token id. Satispay: authorization
   * token id. Credential-like: never put it in logs, URLs or events (the library never does).
   */
  providerMandateId: string;
  status: MandateStatus;
  /** ISO 8601 */
  createdAt: string;
  /** Provider-specific extra the provider needs at charge time (e.g. PayPal customer id). Never secrets. */
  providerData?: Record<string, string>;
  /** Hints from unsigned fields. Never use for authorization decisions. */
  unverified?: { cardExpiry?: string; maskedPan?: string; payerEmail?: string };
}

/**
 * - `succeeded`: the charge was authoritatively accepted (only with `verified: true`).
 * - `failed`: the charge was authoritatively refused. Counts towards dunning; a retry is a NEW
 *   charge with a new `chargeRef`.
 * - `unknown`: timeout, 5xx, unparseable body, merchant-side refusal (401/403/429, auth/MAC
 *   error, rate limit) or an unauthenticated "success". A `chargeMandate` charge: retry with the
 *   SAME `chargeRef`. The first charge of a setup (`chargeRef = orderId`): re-run
 *   `confirmMandate(provider, pending, {})`, never `chargeMandate` with the setup's `orderId`.
 * - `requires_action`: the provider needs the customer (e.g. PayPal `PAYER_ACTION_REQUIRED`).
 */
export type ChargeStatus = 'succeeded' | 'failed' | 'unknown' | 'requires_action';

export interface ChargeRequest {
  /** Idempotency key, unique per intended charge, stable across retries. /^[A-Za-z0-9-]{2,30}$/ (no underscore: Nexi codiceTransazione) */
  chargeRef: string;
  /** Major units; validated with toMinorUnits(amount, currency). */
  amount: number;
  currency: string;
  description?: string;
}

export interface ChargeResult {
  status: ChargeStatus;
  /** true only for outcomes authenticated by MAC/signature or authenticated API response. */
  verified: boolean;
  chargeRef: string;
  providerPaymentId?: string;
  amount?: number;
  currency?: string;
  /** Set when the provider says the mandate is no longer usable (revoked, expired, contract KO). */
  mandateUnusable?: boolean;
  error?: string;
  /** Provider decline/error code when available. */
  providerCode?: string;
  raw?: unknown;
}

export interface MandateSetupOutcome {
  /** true when the mandate is active (first charge may still have failed: check firstCharge). */
  success: boolean;
  verified: boolean;
  /**
   * true only when this outcome is final for the pending setup: verified AND either the mandate is
   * active or the provider authoritatively refused it. Only a terminal outcome may consume the
   * pending state. A non-terminal outcome (unverified, still pending, network error) must leave it
   * in place so the genuine callback can still complete the setup.
   */
  terminal: boolean;
  mandate?: Mandate;
  /**
   * The first charge (`chargeRef = orderId`). It can be `unknown` on a terminal outcome, even with
   * `success: true` (e.g. a PayPal capture still `PENDING`, a Satispay first payment that timed
   * out). Resolve it by keeping the consumed pending state and re-running
   * `confirmMandate(provider, pending, {})` from a job, never with `chargeMandate` and the setup's
   * `orderId` (on PayPal that is a new order: a double charge or `DUPLICATE_INVOICE_ID`).
   */
  firstCharge: ChargeResult;
  error?: string;
  raw?: unknown;
}

export interface MandateCallbackInput {
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  context?: { method?: string; path?: string; rawBody?: Buffer | string };
}

/** Result of `getMandate`: `verified: false` when the provider cannot re-read the mandate. */
export interface MandateStatusResult {
  status: MandateStatus | 'unknown';
  verified: boolean;
  raw?: unknown;
}

/** Result of `revokeMandate`. Mark your own copy revoked whatever it says. */
export interface MandateRevokeResult {
  revokedAtProvider: boolean;
  error?: string;
  raw?: unknown;
}
