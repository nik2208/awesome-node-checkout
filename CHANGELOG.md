# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
