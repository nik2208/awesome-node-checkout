# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
