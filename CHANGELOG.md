# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - Unreleased

Recurring payments (mandates): the core contract, configurator methods and Express routes. The built-in providers implement it in #31 (Nexi), #32 (PayPal) and #33 (Satispay). Resolves #30.

### Added
- **Mandate models** (`src/models/mandate.model.ts`, exported): `MandateSetupRequest`, `MandatePendingState`, `MandateSetupStart`, `Mandate`, `MandateStatus`, `ChargeRequest`, `ChargeResult`, `ChargeStatus`, `MandateSetupOutcome` (with `terminal`), `MandateCallbackInput`, `MandateStatusResult`, `MandateRevokeResult`, and the patterns `MANDATE_REF_PATTERN` (`/^[A-Za-z0-9_-]{5,30}$/`) and `CHARGE_REF_PATTERN` (`/^[A-Za-z0-9-]{2,30}$/`). All are plain JSON: the app persists them, the library keeps no mandate state in memory. Resolves #30.
- **`IMandateProvider`** (optional provider capability: `createMandate`, `confirmMandate`, `chargeMandate`, `getMandate`, `revokeMandate`) and **`isMandateProvider`**. `IPaymentProvider` is unchanged, so existing custom providers keep compiling. Resolves #30.
- **`CheckoutConfigurator`**: `supportsMandates`, `createMandate`, `confirmMandate`, `chargeMandate`, `getMandate`, `revokeMandate`. They validate inputs before calling the provider and normalize outcomes fail closed: an unverified outcome is never a success and never terminal; a verified outcome must match the pending setup (`firstCharge.chargeRef === pending.orderId`, `mandate.mandateRef`, `mandate.provider`); an unverified charge "success" and a verified one for another amount or currency become `unknown`, never `failed`; a revoked mandate is not charged; a provider that throws while charging gives `unknown`. Resolves #30.
- **Events** `mandate.setup_started`, `mandate.created`, `mandate.setup_failed`, `mandate.revoked`, `charge.succeeded`, `charge.failed`, `charge.unknown`, `charge.requires_action`. Setup events are emitted only for terminal outcomes, so a forged callback never looks like a failed setup. Charge events carry `orderId = chargeRef` and `paymentId = providerPaymentId`; `data.mandateRef` is on every mandate event; the credential-like `providerMandateId` is never part of an event (scrubbed from the event's copy of `raw`). Resolves #30.
- **`CheckoutErrorCode`** values `MANDATES_NOT_SUPPORTED` (HTTP 422 through the router) and `INVALID_MANDATE_REQUEST`. Resolves #30.
- **Express Adapter**: `mandates` option (`buildMandateRequest`, `onStarted`, `loadPending`, `onOutcome`, all required, else `INSECURE_CONFIGURATION` at mount; optional `middleware`) mounting `POST /:provider/mandate` and `GET|POST /:provider/mandate/callback`. The callback is always exempt from the shared `middleware`; `onStarted` runs before the response; the response never carries `pending` or `raw`; the pending state is single-use (documented contract of `loadPending` / `onOutcome`). `GET /:provider/mandate` answers 405 instead of reaching the details route. No route exists for charges or revocations. Exported type `ExpressMandateOptions`. Resolves #30.
- **`appendMandateRef(url, mandateRef)`** (exported): adds or replaces the `mandate_ref` query parameter, keeping the query and the hash. Resolves #30.

### Documentation
- README: "Recurring payments (mandates)" section (model, configurator guarantees, Express example, single-use pending state, `mandate_ref` rationale, renewal job example, provider prerequisites), mandate rows in the Routes table, mandate events. Resolves #30.

## [2.0.0] - 2026-11-12

Every permissive default of `createCheckoutRouter` becomes an explicit, named opt-in. Resolves #29.

### Breaking
Migration list:
- **The router throws at mount without `buildPaymentRequest`.** `createCheckoutRouter(checkout)` now throws `CheckoutError` with the new code `INSECURE_CONFIGURATION`. Set `buildPaymentRequest` (server-side amount), or, only where the client may choose the amount, `allowClientPaymentRequest: true` (prints one `console.warn` at mount). The old mount warning `the client body decides the amount; set buildPaymentRequest` is gone.
- **The details route `GET /:provider/:id` is not mounted by default.** Add `details: { middleware: [...] }` to mount it behind your auth. `details: {}` mounts it unprotected and prints one `console.warn`. `details.enabled` is deprecated: `enabled: false` behaves as omitted (Express 404 instead of the former JSON `'Payment details route is disabled'`).
- **`amount` values with excess decimals now fail instead of being rounded.** Through the router, an amount with more decimals than the currency allows (`19.999` EUR, `10.5` JPY) answers `400 { success: false, code: 'INVALID_AMOUNT', error }` (new `CheckoutErrorCode`) without calling the provider; `0`, negative and non-finite amounts keep their earlier 400 (`INVALID_PAYMENT_REQUEST` from `buildPaymentRequest`, uncoded on the client-body path). Called directly, Nexi, Satispay and PayPal `createPayment` reject all of these (excess decimals, `0`, negative, non-finite) with `INVALID_AMOUNT` and return `{ success: false, status: 'FAILED', error }`, and so does `refundPayment` for a partial amount with excess decimals, `0` or a negative value (only an omitted `amount` refunds in full; Nexi and Satispay previously treated `0` and `null` as a full refund, and now reject them like PayPal). Amounts are checked against the ISO 4217 exponent of the currency (0, 2 or 3). PayPal formats payment and refund amounts with that exponent, so it now receives `'1000'` for 1000 JPY (previously the rejected `'1000.00'`) and `'1.200'` for 1.2 KWD. **Nexi and Satispay `createPayment` now reject currencies whose exponent is not 2** (JPY, KWD, …, and Nexi numeric codes such as `392`) with `{ success: false, status: 'FAILED', error }`: their outcome amounts and refunds are in hundredths, so only 2-decimal currencies keep the created, reported and refunded amounts on the same scale.
- **500 response bodies are generic.** Unexpected errors answer `{ success: false, error: 'Internal server error' }`. Set `exposeErrorMessages: true` to get the previous messages (including the `'Invalid provider response'` masking). The error is passed to the new `onError(err, req)` option, or logged with `console.error('[awesome-node-checkout]', err)` when `onError` is not set. `CheckoutError` 4xx responses keep their message and code.
- **Generated order ids changed format.** Without `orderId`, Nexi `codTrans` and Satispay `external_code` are `ORD-` + 24 random hex chars (28 chars) instead of `ORD-<Date.now()>`.

### Security
- **Express Adapter**: the client body can no longer decide the amount unless `allowClientPaymentRequest: true` is set explicitly; previously a missing `buildPaymentRequest` only logged a warning and `POST /checkout/paypal {"amount":0.01,…}` created a 0.01 payment. Resolves #29.
- **Express Adapter**: `GET /:provider/:id` is opt-in, so status, amount and currency of a payment are no longer readable by anyone who knows (or, for Nexi, guesses) a payment id. Resolves #29.
- **Nexi, Satispay**: generated order ids come from `crypto.randomBytes` (96 bits) instead of a millisecond timestamp: they cannot be enumerated and do not collide across instances or within the same millisecond. Resolves #29.
- **Nexi, Satispay, PayPal**: amounts are converted to exact minor units for the currency (`toMinorUnits`/`toMajorString`, internal); an excess decimal is rejected instead of silently rounded. PayPal no longer formats zero/three-decimal currencies with two decimals; Nexi and Satispay reject them at `createPayment`, so for payments created through this library the created, reported and refunded amounts are on the same scale (outcome amounts are still read in hundredths, whatever the `divisa`/`currency`). A refund `amount` of `0` or `null` no longer turns into a full refund on Nexi and Satispay. Resolves #29.
- **Express Adapter**: internal error messages (including those thrown by `buildPaymentRequest`, `onBeforeExecute`, `redirect` handlers and event listeners) no longer reach the client in 500 responses by default. Resolves #29.

### Added
- `ExpressCheckoutOptions.allowClientPaymentRequest`, `exposeErrorMessages` and `onError`. Resolves #29.
- `CheckoutErrorCode` values `INSECURE_CONFIGURATION` and `INVALID_AMOUNT`. Resolves #29.

### Unchanged
- `POST /:provider/execute` stays mounted by default: capturing an approved payment only completes the payer's own payment, and since 1.3.0 the outcome is keyed on the provider-authenticated id (#27). Documented in the README.

### Documentation
- README: "Secure defaults (2.0)" section, details marked *opt-in* in the Routes table, Quick Start and Express examples always build the request server-side. Resolves #29.

## [1.3.0] - 2026-09-29

### Breaking
- **Custom `IPaymentProvider` implementations must authenticate their outcomes.** Redirect, webhook and execute outcomes from a provider that does not set `verified: true` now fail closed: `success: false`, `verified: false`, no `paymentId`/`orderId`, error `'Payment outcome could not be verified'`.
- **`orderId` is no longer read from the query or unsigned body fields.** The configurator no longer reads `query.order_id`, `raw.orderId` or `raw.external_code`: a provider that relied on this must return `orderId` itself.
- **Listener errors are wrapped.** Direct API callers now receive `CheckoutListenerError`; the original value is in `cause`.
- Released as a minor version because these paths were the security holes fixed here (#27). The built-in Nexi, PayPal and Satispay providers are updated.


### Security
- **Nexi Execute**: `executePayment` is keyed on the MAC-covered `codTrans`: result `paymentId`/`orderId`, the local order lookup and the emitted event no longer use the caller's `paymentId`. A non-empty `paymentId` argument different from the outcome's `codTrans` now fails (`success: false`, `verified: false`, error `'Payment id does not match the outcome'`) and emits `payment.failed`, never `payment.completed`. The configurator applies the same check to every provider's execute outcome. Resolves #27.
- **Core (orderId)**: No provider takes `orderId` from the query string of a redirect or callback, or from unsigned body fields (`orderId`, `order_id`, `external_code`): `orderId` comes only from the local `paymentId -> orderId` map (keyed on the provider-authenticated `paymentId`) or from the provider's authenticated outcome. Covers the PayPal redirect, Satispay unsigned POST without `webhookPublicKey`, and Nexi under any registration name (the rule no longer depends on the provider being registered as `nexi`). Resolves #27.
- **Core (verified)**: Unverified callback/redirect/execute outcomes carry no `paymentId`/`orderId` and never report `success: true`; a provider outcome counts as verified only when the provider sets `verified: true` (fail closed). Resolves #27.

### Changed
- **`verified` semantics**: one documented meaning on `PaymentResult`, `WebhookResult` and all events: the outcome was authenticated by a signature/MAC or by an authenticated read from the provider API. `payment.created` (and `payment.failed` from `createPayment`) is now always `verified: false`; redirect/execute outcomes with a valid MAC and `esito=KO` are `verified: true` with an error, like webhooks; `payment.refunded` reflects the provider's `verified` (PayPal/Satispay API response `true`, Nexi `false`). `PaymentResult` gains an optional `verified` field set by the built-in providers. Custom providers must now set `verified: true` on authenticated outcomes. Resolves #27.
- **Event bus**: errors thrown by listeners are wrapped in the new exported `CheckoutListenerError` (`message` copied, original value in `cause`, `event` name) instead of being mutated; direct API callers now receive the wrapper. Resolves #27.
- **Satispay Redirect**: `handleRedirect` returns `orderId` from the authenticated API `external_code` or the local transaction store (previously it was filled by the configurator from the query). Resolves #27.

### Fixed
- **Event bus**: frozen or non-extensible listener errors keep their message (previously replaced by `Cannot add property __isEventListenerError, object is not extensible`). Resolves #27.
- **Currency**: `parseIsoCurrency`/`parseNexiCurrency` (used by Satispay and Nexi) check alpha-3 codes against the ISO 4217 list of active currencies (`ISO_4217_ALPHA3_CODES`, from ISO 4217 List One published 2026-09-17, non-monetary codes excluded); `'XYZ'` and `'ABC'` are rejected. Resolves #27.
- **Documentation**: README `verified`/`paymentId`/`orderId` statements aligned with the behaviour, with a per-event `verified` table. Resolves #27.

## [1.2.5] - 2026-09-28

### Security
- **Nexi Redirect**: Prevented unsigned query parameter `order_id` from populating `orderId` during redirect handling; `orderId` is strictly resolved from MAC-covered `codTrans` or the local transaction map. On failed MAC verification, `orderId` and `paymentId` remain strictly `undefined` to prevent spoofing. Resolves #25.
- **Express Adapter**: Prevented consumer event listener errors containing "JSON" from being masked as `'Invalid provider response'`; consumer listener errors and strings bubble up cleanly with original error details. Resolves #25.
- **Nexi Outcome MAC**: Omitted unverified `paymentId` (set to `undefined`) in `handleWebhook` and `executePayment` when MAC verification fails. Resolves #25.

### Added
- **Types**: Made `verified: boolean` required on `WebhookResult` and `CheckoutEventPayload`, ensuring callers do not need an undefined check branch. Resolves #25.

### Fixed
- **Satispay Currency**: Enforced strict ISO-4217 validation across `createPayment`, `getPaymentDetails`, and `handleWebhook`, rejecting non-standard currency names (e.g. `'EURO'`). Resolves #25.
- **Documentation**: Documented `verified` vs `error` semantics in `WebhookResult` and event payload in README. Detailed Satispay `verified` guarantees both with and without `webhookPublicKey`. Resolves #25.

## [1.2.4] - 2026-09-28

### Security
- **Nexi**: Strictly prevented unsigned extra body fields (`orderId`/`order_id`) from overwriting `orderId` in webhook responses and `webhook.received` events; `orderId` is strictly resolved from MAC-covered `codTrans` or the local transaction map. Resolves #23.
- **Core**: Prevented untrusted query parameter `order_id` from populating `orderId` in webhook results and `webhook.received` events when callback verification fails. Resolves #23.
- **Nexi**: Removed HTTP reason phrase (`response.statusText`) from error responses in `getPaymentDetails` and `refundPayment` to prevent upstream provider status phrase leakage. Resolves #23.
- **Express Adapter**: Limited unhandled JSON parse error masking (`'Invalid provider response'`) strictly to provider errors, allowing consumer hook errors (`buildPaymentRequest`, `onBeforeExecute`, `options.redirect`) to bubble without alteration. Resolves #23.

### Added
- **Core & Events**: Added `verified: boolean` flag to `WebhookResult` and `webhook.received` event payload, distinguishing callbacks authenticated via cryptographic signature/MAC or server-to-server API re-read from unauthenticated callbacks or legitimate cancellations (e.g. genuine `CANCELED`). Resolves #23.

### Fixed
- **Satispay**: Safely handled numeric ISO-4217 currency codes (e.g. `978` -> `EUR`) without throwing `TypeError: currency.trim is not a function`. Resolves #23.
- **Documentation**: Clarified that `payment_id` is extracted from query parameters in GET callbacks while other query parameters are ignored, and documented all `webhook.received` event payload fields in README. Resolves #23.

## [1.2.3] - 2026-09-28

### Security
- **Providers**: Masked JSON parse syntax errors across all providers and Express adapter to return a generic `'Invalid provider response'`, ensuring no provider response body or syntax details leak to callers. Resolves #21.
- **Nexi**: Sanitized `getPaymentDetails` error handling when outcome is not OK (`esito !== 'OK'`), returning generic `'Payment details request failed'` instead of leaking provider internal message (`errore.messaggio`). Resolves #21.
- **Satispay**: Hardened unsigned GET/HEAD callbacks to extract `payment_id` strictly from query parameters and prevent untrusted query parameters from setting `orderId`. HEAD requests are now processed identically to GET. Resolves #21.

### Fixed
- **Core**: Hardened `parseAmount` and `parseAmountFromCents` to reject negative numbers (returning `undefined`). Resolves #21.
- **Providers**: Enforced that `success` is strictly `false` when amount is ≤ 0 or currency is missing across all providers (Satispay, Nexi, PayPal), returning `'Payment amount is missing or invalid'` or `'Payment currency is missing or invalid'`. Resolves #21.
- **Documentation**: Corrected README line 188 example to gate order fulfillment check directly on `result.success`. Resolves #21.

## [1.2.2] - 2026-09-28

### Security
- **Satispay**: Enforced minimum signed headers requirement in HTTP Signature verification: rejects any signature whose `headers` parameter omits `(request-target)`, `date`, or (when a request body is present) `digest`. Resolves #19.
- **Satispay**: Strictly enforced presence and freshness of the `Date` HTTP header; requests without a `Date` header are immediately rejected. Resolves #19.
- **Satispay**: Redacted provider API response bodies from user-facing error messages to prevent internal details or secrets from leaking to callers. Resolves #19.
- **Express Adapter**: Stripped `raw` provider payloads from all HTTP JSON route responses (`POST /:provider`, `POST /:provider/execute`, `POST /:provider/refund`, `GET /:provider/redirect`, `GET /:provider/:id`, `GET/POST /:provider/webhook`) to protect sensitive payer details. Resolves #19.
- **Core**: Hardened `parseAmount` and `parseAmountFromCents` to use strict decimal and integer regexes, rejecting hex (`0x10`), octal (`0o77`), binary (`0b10`), and scientific notation (`1e3`). Resolves #19.

### Fixed
- **Satispay**: Documented and implemented dedicated handling for GET callbacks (`?payment_id=...`): accepted as unsigned notification triggers for server-to-server API re-read authenticated with merchant private key; untrusted query parameters are ignored while POST webhooks strictly enforce HTTP Signature verification. Resolves #19.
- **Core**: Enforced that `success` is never `true` when `amount` is undefined or missing across all providers (PayPal, Satispay, Nexi). Confirmed payments without an amount now return `success: false` with `'Payment amount is missing or invalid'`. Resolves #19.
- **PayPal**: Exposed `captureStatus` separately in `PaymentResult` and `WebhookResult`. When an order has no capture, `status` is set to `'NO_CAPTURE'`, `captureStatus` is `undefined`, and `success` is `false`. Resolves #19.
- **Nexi**: Aligned `getPaymentDetails` to require paid/settled status (`'Contabilizzato'`, `'Autorizzato'`, `'Catturato'`) and valid amount for `success: true`. Resolves #19.
- **Documentation**: Documented `webhookPublicKey` requirement in production, raw body capture in Express, router mount prefix requirements, and fixed minor-unit status checking example. Resolves #19.

## [1.2.1] - 2026-09-28

### Security
- **Satispay**: Disallowed request body acting as headers during webhook signature verification. Resolves #16.
- **Satispay**: Enforced timestamp freshness window (`signatureMaxAgeMs`, default 5 minutes) on webhook signatures to prevent replay attacks. Resolves #16.
- **Satispay**: Strictly bound `Digest` header validation to the raw request body (`context.rawBody` or stringified body) verifying `SHA-256=<base64>`. Resolves #16.
- **Satispay**: Enforced `(request-target)` to be derived solely from trusted `context.method` and `context.path`. Resolves #16.
- **Satispay**: URL-encoded `payment_id` across API endpoints and strictly validated payment ID format (`/^[A-Za-z0-9_-]{1,64}$/`) rejecting directory traversal patterns. Resolves #16.
- **Nexi**: Enforced strict 40-character hexadecimal format validation on outcome MAC strings to prevent `RangeError` during timing-safe comparisons. Resolves #17.
- **Express Adapter**: Prevented sensitive internal provider payload data from being echoed in HTTP webhook JSON responses (strips `raw`). Resolves #17.

### Fixed
- **PayPal**: Payment `success` is now strictly derived from capture status (`capture.status === 'COMPLETED'`) in `executePayment` and `getPaymentDetails`. Payments with non-completed or missing captures evaluate to `success: false`. Resolves #17.
- **Nexi**: Removed `report[0]` fallback in `getPaymentDetails` when the requested transaction order ID is not present in the BackOffice report, returning `{ success: false, error: 'Report not found' }`. Resolves #17.
- **Nexi**: Mapped ISO-4217 numeric currency codes (e.g. `'978'` -> `'EUR'`, `'840'` -> `'USD'`) to uppercase alpha-3 codes, returning `undefined` for unrecognized numeric codes. Resolves #17.
- **Core**: Empty or whitespace-only amount strings are parsed to `undefined` rather than coercing to `0`. Resolves #17.
- **Core**: Bounded `paymentOrders` map capacity to 10,000 entries with FIFO eviction to prevent memory leaks in long-running processes. Resolves #17.
- **Express Adapter**: Handled `res.headersSent` when `buildPaymentRequest` sends a response directly via `ctx.res` and returns `null`, preventing `ERR_HTTP_HEADERS_SENT` / double response errors. Resolves #17.
- **Documentation**: Corrected `publicPaths` examples, clarified Satispay callback URL configuration, raw body middleware, and GET callback authentication. Resolves #17.

### Added
- **Core**: Added optional `orderId` to `PaymentResult` and `WebhookResult`. Resolves #17.
- **Core**: Added `rawBody` support to `context` parameter in `IPaymentProvider.handleWebhook`. Resolves #16.

## [1.2.0] - 2026-09-27

### Security
- **Nexi**: Fail-closed outcome MAC verification on redirect and webhook. Missing or invalid `mac` parameter rejects payment with status `FAILED` and error `'MAC missing'`. Verifies 7-field formula (`codTrans`, `esito`, `importo`, `divisa`, `data`, `orario`, `codAut`, `macKey`) using constant-time comparison `crypto.timingSafeEqual`. Resolves #6.
- **Express Adapter**: `publicPaths` now uses segment-based path matching rather than substring matching, preventing subpath bypasses such as `/webhook/execute` or `/redirect/execute` when `/webhook` or `/redirect` is marked public. Resolves #13.

### Fixed
- **Nexi**: Updated `getPaymentDetails` to query the official BackOffice endpoint `POST /ecomm/api/bo/situazioneOrdine` with JSON payload and response MAC verification instead of the non-existent IGFS endpoint. Resolves #7.
- **Satispay**: Fixed webhook handling for GET callbacks containing `payment_id` query parameter, ensuring callbacks routed to `handleWebhook` correctly extract payment details and verify signatures. Added configurable `callbackPath` (defaulting to `/checkout/satispay/webhook`). Resolves #10.
- **Satispay**: Fixed HTTP signature verification to support `(request-target)` pseudo-header via request context, signature header without `(request-target)`, flexible header key order, and body digest verification. Resolves #11.

### Added
- **Nexi**: Added server-to-server outcome notification support (`urlpost`) configured via `PaymentRequest.notifyUrl` in `createPayment`, and handled via `NexiProvider.handleWebhook`. Resolves #8.
- **Core**: Exposed `amount` and `currency` in `PaymentResult` and `WebhookResult` across all providers (Nexi, PayPal, Satispay) to enable post-payment amount verification. Resolves #9.
- **Core**: Propagated `orderId` and `raw` provider response data through `CheckoutConfigurator` event bus payloads (`payment.created`, `payment.completed`, `payment.failed`, `payment.refunded`, `webhook.received`). Resolves #12.
- **Express Adapter**: Added `options.redirect` for automatic 302 HTTP redirects to `onSuccess(result, req)` or `onFailure(result, req)` on browser return. Resolves #12.
- **Express Adapter**: Added `options.details` configuration to gate or disable `GET /:provider/:id` (`enabled: false` returns 404, or custom `middleware`). Resolves #12.
- **Express Adapter**: Added context argument `{ provider, res }` to `buildPaymentRequest(req, ctx)` and strict validation of returned `PaymentRequest`. Resolves #12.
- **Express Adapter**: Mounted both `GET` and `POST` routes for `/:provider/webhook`. Resolves #10.
- **Packaging**: Added `"types"` condition to `exports` in `package.json` for TypeScript package resolution under `node16`/`nodenext`. Resolves #12.

### Changed
- **Nexi**: Breaking change in outcome verification: previously `handleRedirect` accepted outcomes without a `mac` field. It is now strictly required (fail-closed). Any integration testing Nexi callbacks must supply a valid `mac`.

## [1.1.0] - 2026-09-27

### Added
- **Security**: Added `buildPaymentRequest` hook in `createCheckoutRouter` options to build payment requests securely server-side (preventing clients from tampering with amounts and order parameters). Resolves #3.
- **Security**: Added mount-time warning when `createCheckoutRouter` is used without `buildPaymentRequest`.
- **Validation**: Added input validation on `POST /:provider` when `buildPaymentRequest` is not configured (requires finite positive number `amount` and non-empty `currency`).
- **Gating**: Gated `POST /:provider/refund` behind `options.refund` (returns 404 unless explicitly configured with optional middleware).
- **Hooks**: Added `onBeforeExecute` and dedicated `middleware` support in `options.execute` for `POST /:provider/execute`.
- **Examples**: Added reference Express implementation under `examples/express` demonstrating SQLite store, Handlebars UI, and full checkout flow.

## [1.0.2] - 2026-04-23

### Changed
- Removed compiled `dist/` artifacts from git tracking.
- Added GitHub Actions publish workflow.
- Updated dependencies.

## [1.0.1] - 2026-04-13

### Fixed
- Satispay provider warning at construction time when `webhookPublicKey` is not configured.
- PayPal refund implementation and security improvements.

## [1.0.0] - 2026-03-30

### Added
- Initial release of `awesome-node-checkout`.
- Framework-agnostic `CheckoutConfigurator`.
- PayPal, Nexi, and Satispay providers.
- Express adapter with `createCheckoutRouter`.
