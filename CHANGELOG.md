# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
