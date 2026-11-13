# awesome-node-checkout

[![npm version](https://img.shields.io/npm/v/awesome-node-checkout.svg)](https://www.npmjs.com/package/awesome-node-checkout)
[![license](https://img.shields.io/npm/l/awesome-node-checkout.svg)](LICENSE)

A **framework-agnostic** payment checkout library for Node.js, written in TypeScript.  
Drop-in payment orchestration for Express, NestJS, Fastify and any other Node.js framework — connect any payment provider through a single interface.

> Inspired by [awesome-node-auth](https://github.com/nik2208/awesome-node-auth). Same philosophy: no framework lock-in, no DB lock-in, implement one interface and you're done.

---

## Installation

```bash
npm install awesome-node-checkout
```

---

## Quick Start

```typescript
import { CheckoutConfigurator, PayPalProvider, NexiProvider, SatispayProvider } from 'awesome-node-checkout';
import * as fs from 'fs';

const checkout = new CheckoutConfigurator();

checkout
  .registerProvider(new PayPalProvider({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    environment: 'sandbox',
    timeoutMs: 30000, // Optional (since 2.2.0): bounds every PayPal API call. Without it there is no timeout
  }))
  .registerProvider(new NexiProvider({
    merchantId: process.env.NEXI_MERCHANT_ID!,
    macKey: process.env.NEXI_MAC_KEY!,
    environment: 'sandbox',
  }))
  .registerProvider(new SatispayProvider({
    keyId: process.env.SATISPAY_KEY_ID!,
    privateKey: fs.readFileSync('private.pem', 'utf8'),
    webhookPublicKey: fs.readFileSync('satispay_public.pem', 'utf8'), // Required in production to verify incoming webhook signatures
    environment: 'sandbox',
    serverUrl: 'https://myapp.com', // Base URL for callbacks: serverUrl + callbackPath (must include router mount prefix, e.g. /checkout)
    callbackPath: '/checkout/satispay/webhook', // Optional: defaults to /checkout/satispay/webhook
  }));

// Use directly — no HTTP framework needed. The amount comes from your own order, never from the client.
const order = await myOrderService.getOrder('ORD-1234');
const result = await checkout.createPayment('paypal', {
  amount: order.totalAmount, // e.g. 49.99: at most as many decimals as the currency allows
  currency: order.currency,  // e.g. 'EUR'
  description: `Order #${order.id}`,
  returnUrl: 'https://myapp.com/payment/success',
  cancelUrl: 'https://myapp.com/payment/cancel',
  orderId: order.id,
});

if (result.approvalUrl) {
  // redirect the user to result.approvalUrl
}
```

### With Express adapter

```typescript
import express from 'express';
import { createCheckoutRouter } from 'awesome-node-checkout/express';

const app = express();
// Capture rawBody for webhook signature & digest verification (e.g. Satispay)
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));
// If using Nexi server notifications (urlpost), urlencoded parser is required:
app.use(express.urlencoded({ extended: false }));

// Mount checkout routes with secure server-side request builder and browser redirects
app.use(
  '/checkout',
  createCheckoutRouter(checkout, {
    // Required: verify the order and compute the amount on the server
    buildPaymentRequest: async (req, { provider }) => {
      const order = await myOrderService.getOrder(req.body.orderId);
      return {
        amount: order.totalAmount,
        currency: order.currency, // e.g. 'EUR'
        orderId: order.id,
        returnUrl: 'https://myapp.com/checkout/' + provider + '/redirect',
        cancelUrl: 'https://myapp.com/payment/cancel',
        notifyUrl: 'https://myapp.com/checkout/' + provider + '/webhook',
        description: `Order #${order.id}`,
      };
    },
    // Optional: automatic 302 redirects for browser-based flows
    redirect: {
      onSuccess: (result, req) => `/orders/${result.orderId}?status=success`,
      onFailure: (result, req) => `/orders/${result.orderId}?status=failed&error=${encodeURIComponent(result.error || '')}`,
    },
    // Opt-in: mount POST /:provider/refund protected by admin middleware
    refund: {
      middleware: [requireAdminAuth],
    },
    // Optional: guard execution before capturing payment
    execute: {
      onBeforeExecute: async (req, paymentId) => {
        // Verify payment belongs to current session or user
      },
    },
    // Public paths matching segments safely without substring bypasses (accepts strings or segment arrays)
    publicPaths: [
      ':provider/webhook',
      ':provider/redirect',
    ],
    // Optional: report unexpected (500) errors; the client only sees 'Internal server error'
    onError: (err, req) => logger.error({ err, path: req.path }, 'checkout error'),
  }),
);

app.listen(3000);
```

> **Security Note**: Never trust client-sent amounts. `buildPaymentRequest` derives the amount and order parameters server-side, and since 2.0.0 it is mandatory: `createCheckoutRouter` throws `CheckoutError('INSECURE_CONFIGURATION')` at mount without it. See [Secure defaults (2.0)](#secure-defaults-20).

To expose payment status to your own front end, mount the details route explicitly and protect it:

```typescript
createCheckoutRouter(checkout, {
  buildPaymentRequest,
  details: { middleware: [requireAuth] }, // GET /checkout/:provider/:id
});
```

### With Fastify (or any other framework)

Use the `CheckoutConfigurator` methods directly in your own routes:

```typescript
fastify.post('/checkout/:provider', async (req, reply) => {
  // Build the request from your own order: never pass req.body to createPayment
  const order = await myOrderService.getOrder(req.body.orderId);
  const result = await checkout.createPayment(req.params.provider, {
    amount: order.totalAmount,
    currency: order.currency,
    orderId: order.id,
    returnUrl: `https://myapp.com/checkout/${req.params.provider}/redirect`,
    cancelUrl: 'https://myapp.com/payment/cancel',
  });
  const { raw, ...safeResult } = result;
  reply.status(result.success ? 201 : 400).send(safeResult);
});

// Handle both POST and GET webhooks (e.g. Satispay GET callback vs Nexi/Satispay POST notification)
fastify.route({
  method: ['GET', 'POST'],
  url: '/checkout/:provider/webhook',
  handler: async (req, reply) => {
    const result = await checkout.handleWebhook(req.params.provider, req.body, req.headers, req.query, {
      method: req.method,
      path: req.url,
      rawBody: (req as any).rawBody,
    });
    // Strip internal raw data before responding
    const { raw, ...safeResult } = result;
    reply.status(result.success ? 200 : 400).send(safeResult);
  },
});
```

---

## Example Application

A full-featured reference implementation using Express 5, SQLite (`ITransactionStore`), and Handlebars is available in [examples/express](./examples/express).

---

## Routes (Express adapter)

| Method      | Path                        | Description                                                    |
|-------------|-----------------------------|----------------------------------------------------------------|
| POST        | `/:provider`                | Create a payment (built by `buildPaymentRequest`)              |
| POST        | `/:provider/execute`        | Execute/capture a payment (supports `onBeforeExecute`)         |
| GET         | `/:provider/redirect`       | Handle provider redirect callback (supports 302 via `redirect`)|
| GET         | `/:provider/:id`            | Get payment details (*opt-in*: mounted only when `details` option is set; protect it with `details.middleware`)|
| POST        | `/:provider/refund`         | Refund a payment (*opt-in*: mounted only when `refund` option is set). Body `{ paymentId, amount }`, no idempotency key: see [Refunds](#refunds)|
| GET / POST  | `/:provider/webhook`        | Handle provider webhook (POST for Nexi/Satispay, GET for Satispay)|
| POST        | `/:provider/mandate`        | Start a mandate setup (*opt-in*: mounted only when `mandates` is set; built by `buildMandateRequest`). See [Recurring payments](#recurring-payments-mandates)|
| GET         | `/:provider/mandate`        | `405` with `Allow: POST` (*opt-in*, with `mandates`): never falls through to the details route|
| GET / POST  | `/:provider/mandate/callback` | Confirm a mandate setup (*opt-in*, with `mandates`; always exempt from `middleware`)|

There is no route for mandate charges or revocations: call `chargeMandate` / `revokeMandate` from a server job.

---

## Refunds

`checkout.refundPayment(provider, paymentId, amount?, options?)` refunds a payment in full (`amount` omitted) or in part. `paymentId` is the id the provider refunds: the PayPal order id, the Nexi `codTrans`, the Satispay payment id (for a mandate charge, its `providerPaymentId`). A refund that times out or gets a 5xx may or may not have happened, so it must never be retried blindly.

**Idempotency key** (since 2.2.0). With `options.idempotencyKey`, the provider deduplicates the refund: a retry with the same key gets the provider's original answer instead of a second refund, for as long as the provider keeps the key.

```typescript
const key = `${charge.chargeRef}-R1`; // ONE key per intended refund; a second partial refund is -R2
const result = await checkout.refundPayment('paypal', charge.providerPaymentId, 9.9, { idempotencyKey: key });
if (!result.success) {
  // Not proof that nothing was refunded: read it with the provider's table below (the meaning of
  // `verified` differs). Until the table says nothing was refunded, retry only with the SAME key
}
```

- **One key per intended refund.** Unique for that refund, the same on every retry of it, never reused for another amount or another payment. It must match `REFUND_IDEMPOTENCY_KEY_PATTERN` (`/^[A-Za-z0-9_-]{8,64}$/`, exported).
- **Per provider** (`provider.supportsRefundIdempotency`):

| Provider | Sent as | Kept by the provider |
|----------|---------|----------------------|
| PayPal | `PayPal-Request-Id` | 45 days |
| Satispay | `Idempotency-Key` | not documented by Satispay: retry promptly |
| Nexi | not supported: the storno API has no key | the configurator refuses the call |

- **The configurator fails closed.** It validates the options before calling the provider and before emitting `payment.refunded`, so a refund you asked to be idempotent is never sent without its key:
  - options that are not an object, or a key that is not a string matching the pattern: `CheckoutError('INVALID_REFUND_REQUEST')` (HTTP 400 through the router);
  - a key on a provider whose `supportsRefundIdempotency` is not `true` (Nexi, or a custom provider written for 2.1): `CheckoutError('REFUND_IDEMPOTENCY_NOT_SUPPORTED')` (HTTP 422).
- **Without `options`** the provider is called with `(paymentId, amount)`, exactly as in 2.1, and `payment.refunded` is unchanged. A provider whose `supportsRefundIdempotency` is not `true` is always called that way: options without a key are not passed on to it, since its own third parameter, if it has one, may mean something else. The Express route `POST /:provider/refund` takes no key: its body stays `{ paymentId, amount }`.
- **Called directly**, without the configurator: `NexiProvider.refundPayment(id, amount, { idempotencyKey })` returns `{ success: false, status: 'REFUND_FAILED' }` without any request, and PayPal and Satispay do the same for a key that does not match the pattern.

**PayPal refunds** keep their 2.1 mapping, which is not Satispay's: on PayPal, `verified: true` with `success: false` is a refund that PayPal created but did not report `COMPLETED` (it may still complete), and a refusal comes back without `verified`.

| PayPal answer | Result |
|---------------|--------|
| A refund `COMPLETED` | `{ success: true, verified: true, paymentId: <refund id>, status: 'COMPLETED', raw }` |
| A refund with another status, such as `PENDING` | `{ success: false, verified: true, paymentId: <refund id>, status, raw }`: PayPal created the refund, and a `PENDING` one may still complete. Never refund again under a new key: re-read the order with `getPaymentDetails` (its `raw` lists the refunds with their status; `refundedAmount` counts the `COMPLETED` ones) |
| Any error of the order read or of the refund call: network error, timeout, HTTP 4xx or 5xx | `{ success: false, error }`, without `verified` or `status`. `error` is the SDK's message, and it is empty for some refusals (a 422 `REFUND_AMOUNT_EXCEEDED` gives `''`). The result does not tell a refusal from an unknown outcome: a retry with the same key never refunds twice while PayPal keeps the key (45 days), but a refusal answers the same every time, so bound the retries, then reconcile in the PayPal dashboard |
| No capture on the order, no currency for a partial refund, an invalid amount, or (called directly) an invalid key | `{ success: false, status: 'REFUND_FAILED', error }` (`'FAILED'` for an invalid amount), without `verified`: no refund request was sent |

**Satispay refunds** (since 2.2.0) follow Satispay's documented flow: a refund is a new payment, `POST /g_business/v1/payments` with `flow: 'REFUND'`, `parent_payment_uid` (the payment to refund), `amount_unit` and `currency: 'EUR'`. `amount_unit` is required, so a **full refund** first reads the payment (`GET /payments/{id}`): unless the read answers this id, `ACCEPTED` and an integer `amount_unit` greater than 0, the result is `{ success: false, status: 'REFUND_FAILED', error: 'Satispay payment could not be read: no refund was sent' }` and nothing is sent. After an earlier partial refund, a full refund of the original amount is refused (4xx): pass the remaining amount explicitly. The answer is mapped as follows:

| Satispay answer | Result |
|-----------------|--------|
| Network error or timeout | `{ success: false, error: 'Satispay refund outcome unknown (network error or timeout)' }`, no `verified`: the refund may exist |
| 2xx `ACCEPTED`, with an id, and a `type` absent or `REFUND_TO_BUSINESS` | `{ success: true, verified: true, paymentId: <refund id>, status: 'ACCEPTED', amount, currency, raw }` |
| Any other 2xx (another status or type, no id, no JSON) | `{ success: false, status: <status, or 'UNKNOWN'>, error: 'Satispay refund is <status>', raw }`, no `verified`: uncertain |
| HTTP 401, 403, 408, 409, 429, 5xx | `{ success: false, error: 'Satispay refund outcome unknown (HTTP <n>)', raw }`, no `verified`: merchant-side, or a same-key request still in flight |
| Any other 4xx | `{ success: false, verified: true, status: 'REFUND_FAILED', error: <Satispay's message, or 'Satispay refused the refund'>, raw }`: an authenticated refusal, nothing was refunded |

Satispay refunds have no timeout unless `SatispayProviderConfig.timeoutMs` is set, as in 2.1: a refund that times out without a key cannot be retried safely, so a default timeout would turn slow successes into apparent failures. With `timeoutMs`, both the read and the refund are bounded by it.

---

## Secure defaults (2.0)

Since 2.0.0 every permissive behaviour of `createCheckoutRouter` is an explicit, named opt-in that shows up in code review.

1. **`buildPaymentRequest` is mandatory.** Without it, `createCheckoutRouter` throws `CheckoutError` with code `INSECURE_CONFIGURATION` at mount. The opt-out is `allowClientPaymentRequest: true`: the client request body becomes the `PaymentRequest`, so **the browser chooses the amount**. Never use it for a shop. It prints one `console.warn` at mount.
2. **`GET /:provider/:id` is opt-in.** The details route returns `success`, `status`, `amount`, `currency` and `paymentId` for any id it is given (for Nexi, the id is your order code). It is mounted only when `details` is set: `details: { middleware: [requireAuth] }`. `details: {}` mounts it unprotected and prints one `console.warn`. The old `details: { enabled: false }` is deprecated and behaves as omitted.
3. **Generated order ids are unpredictable.** When `orderId` is omitted, Nexi (`codTrans`) and Satispay (`external_code`) use `ORD-` + 24 random hex chars instead of `ORD-<timestamp>`, so ids cannot be enumerated and do not collide.
4. **Amounts are exact, in the currency's minor units.** Amounts are checked against the ISO 4217 exponent (0 for JPY, KRW, CLP…; 3 for KWD, BHD, JOD…; 2 otherwise) and never rounded: `19.999 EUR` or `10.5 JPY` fails with `INVALID_AMOUNT` instead of charging a rounded amount. The router answers `400 { success: false, code: 'INVALID_AMOUNT', error }` without calling the provider; a provider called directly returns `{ success: false, status: 'FAILED', error }`. PayPal formats payment and refund amounts with the exponent of the order's currency: it receives `'1000'` for 1000 JPY and `'1.200'` for 1.2 KWD. Nexi and Satispay accept only currencies with 2 decimal places: `createPayment` in JPY, KWD or another 0- or 3-decimal currency (including Nexi numeric codes such as `392`) returns `{ success: false, status: 'FAILED', error }`, because their outcome amounts and refund amounts are in hundredths. A refund `amount` of `0` (or `null`) fails like any invalid amount; only an omitted amount refunds in full.
5. **500 bodies are generic.** An unexpected error (a throwing `buildPaymentRequest`, `onBeforeExecute`, `redirect.onSuccess`/`onFailure`, event listener (except the mandate events emitted after a provider call, see [Events](#events)), or provider) answers `500 { success: false, error: 'Internal server error' }`. The error goes to `onError(err, req)`, or to `console.error` when `onError` is not set. `exposeErrorMessages: true` restores the message in the body (for development). `CheckoutError` responses (4xx) keep their message and code and are not passed to `onError`.

| Option | Default | Effect |
|--------|---------|--------|
| `buildPaymentRequest` | — (required) | Server-side `PaymentRequest` |
| `allowClientPaymentRequest: true` | off | Client body decides the amount (insecure) |
| `details: { middleware }` | not mounted | Mounts `GET /:provider/:id` |
| `refund: { middleware }` | not mounted | Mounts `POST /:provider/refund` |
| `exposeErrorMessages: true` | off | Error messages in 500 bodies |
| `onError(err, req)` | `console.error` | Receives every 500 error |

**`POST /:provider/execute` stays mounted by default.** Capturing an approved payment only completes the payer's own payment, and since 1.3.0 the outcome is keyed on the provider-authenticated payment id (#27), so a forged `paymentId` cannot confirm another order. Use `execute.middleware` or `execute.onBeforeExecute` to tie the capture to the current session.

---

## Recurring payments (mandates)

*Since 2.1.0.* A **mandate** is the customer's saved consent to be charged again without being present: a monthly or yearly subscription that renews until the customer cancels. The core contract is `IMandateProvider` (optional, next to `IPaymentProvider`), the `CheckoutConfigurator` mandate methods and two Express routes.

### The model

1. **Primitives only.** The library creates, confirms, charges, reads and revokes mandates. **Your app owns** scheduling (renewal dates), retries and dunning, subscription state, prices, VAT and invoices. The library never stores a timer or a schedule and knows nothing of plans or tiers.
2. **Every later charge is merchant-initiated (MIT)**, for every provider: your app decides when and how much to charge. PayPal uses Vault, not PayPal Subscriptions or billing plans, so a price change needs no PayPal-side plan revision.
3. **No in-memory state.** Every method returns plain JSON objects that you persist (`MandatePendingState`, `Mandate`) and pass back later. A restart or a second instance loses nothing.
4. **Setup always includes the first charge** (Nexi first payment, PayPal vault-with-purchase, Satispay first `PRE_AUTHORIZED` payment). There are no zero-amount setups and no trials. `MandateSetupOutcome` reports the mandate (`success`, `mandate`) and the first charge (`firstCharge`) separately, because one can succeed without the other.
5. **Idempotency.**
   - Every charge carries a `chargeRef` that you derive, unique per intended charge and stable across retries, for example `` `${subscriptionId}-${periodStart}` `` (`/^[A-Za-z0-9-]{2,30}$/`, no underscore).
   - Retry an `unknown` charge **made by `chargeMandate`** with the **same** `chargeRef`. A **dunning retry** after a `failed` charge is a new intended charge with a **new** `chargeRef` (for example `…-r1`).
   - The first charge of a setup uses `chargeRef = orderId`, but it is **not** a `chargeMandate` charge: **never call `chargeMandate` with the setup's `orderId`.** On PayPal that creates a second order (the setup used the request ids `setup-<orderId>` and `capture-<orderId>`), so it either charges the customer twice or stays `unknown` forever with `DUPLICATE_INVOICE_ID`.
   - **An `unknown` first charge is resolved with `confirmMandate`.** A terminal outcome can carry `firstCharge.status === 'unknown'`, even with `success: true` and an active mandate: the PayPal capture is `PENDING`, or the Satispay first payment timed out or got a 5xx. Keep the consumed pending state, and re-run `checkout.confirmMandate(provider, pending, {})` from a server job until a **terminal** outcome reports a `firstCharge.status` other than `unknown`. Do this directly, not through the callback route, which keeps answering 404. See [Resolving an unknown first charge](#resolving-an-unknown-first-charge).
   - `mandateRef` (`/^[A-Za-z0-9_-]{5,30}$/`) and `orderId` are **fresh for every setup attempt**. After a failed or abandoned setup, start a new one with new values: reusing them would replay the provider's idempotency keys and order codes.
6. **Unknown outcomes are explicit.** A charge that times out, gets a 5xx or an unparseable body, or is refused for a reason that is not about the customer (HTTP 401, 403, 429, an authentication or MAC error, rate limiting) ends with `status: 'unknown'`, never `failed`: an expired credential must not push every subscriber into dunning. `failed` means an authoritative refusal of this specific charge. The library never retries on its own.
7. **Fail closed.** `verified` is `true` only for outcomes authenticated by a MAC or signature checked by the library, or by an authenticated server-to-server response. Identities (contract number, vault id, token id, order id) come from the persisted `MandatePendingState` / `Mandate` or from authenticated fields, never from query strings or unsigned callback fields. On the mandate, unsigned hints (card expiry, masked PAN, payer email) are only under `mandate.unverified`; the provider `raw` of outcomes and events may still contain them.
8. **Only creation and callbacks are routes.** `chargeMandate` and `revokeMandate` are never mounted: charges are a server job, and an HTTP route would be a charge-anyone endpoint. Creation requires the server-side `buildMandateRequest`, like `buildPaymentRequest`.

### What the configurator guarantees

| Method | Behaviour |
|--------|-----------|
| `supportsMandates(provider)` | `true` when the provider implements `IMandateProvider` (`isMandateProvider`). |
| `createMandate(provider, request)` | Validates first (`INVALID_MANDATE_REQUEST` for `mandateRef`, `orderId`, `description` of 1-127 chars, a `returnUrl`/`cancelUrl` (or a `notifyUrl`, when set) that is not an absolute `http(s)` URL; `INVALID_AMOUNT` from the amount) without calling the provider. A start whose `pending` does not match the request (`provider`, `mandateRef`, `orderId`, and `amount` and `currency`, compared in minor units and case-insensitively; a missing or invalid one never matches) is returned as `success: false`, since `confirmMandate` checks the first charge's amount against `pending`. Emits `mandate.setup_started` (`verified: false`) on success. |
| `confirmMandate(provider, pending, input)` | Unverified outcome → `success: false`, `terminal: false`, no `mandate`, a `succeeded` first charge becomes `unknown`. A verified outcome whose `firstCharge.chargeRef` or `mandate` does not match `pending` → unverified, non-terminal failure `'Mandate outcome does not match the pending setup'`. `terminal` is the provider's value AND `verified` (always `true` with `success: true`). Events **only for terminal outcomes**: `mandate.created` or `mandate.setup_failed`, then `charge.*` for the first charge. An unverified outcome's `firstCharge` carries no `providerPaymentId`, `amount`, `currency` or `errorCode`. A verified first charge taken for another amount or currency than `pending` is `unknown` with `errorCode: 'AMOUNT_MISMATCH'` (since 2.2.0; the configurator's `'Charged amount does not match the request'`, or PayPal's `'Captured amount does not match'`), with the reported `amount` and `currency`: **do not re-confirm it in a loop**, a re-confirm gets the same answer. Review it, and refund or keep the money. Re-callable with `{}` and the consumed `pending` to resolve an `unknown` first charge (see below). |
| `chargeMandate(provider, mandate, charge)` | Validates `chargeRef` and the amount. A `revoked` mandate returns `failed` with `mandateUnusable: true` without calling the provider. An unverified `succeeded` becomes `unknown` (never `failed`). A verified `succeeded` whose reported amount or currency differs from the request becomes `unknown` with `'Charged amount does not match the request'` and, since 2.2.0, `errorCode: 'AMOUNT_MISMATCH'`, keeping the reported `amount` and `currency`: **do not retry it**, a retry gets the same answer (a Nexi replay included). Review it, and refund or keep the money. Compare `errorCode`, never the `error` text. A final `succeeded` never carries an `errorCode`; on other statuses a provider's code survives only when it is a known `ChargeErrorCode`. A provider that throws gives `unknown`, whose `raw` (and the `charge.unknown` event's) is only the error's `{ name, message }`, never the SDK request, headers or body. `chargeRef` is always the request's. Since 2.2.0, `providerState` and `providerStatus` (a Nexi replay of a refunded or partly captured charge) **survive the amount check**, since the state is the more specific fact, and are **dropped from any unverified result**; they never change `status`. Emits `charge.succeeded`, `charge.failed`, `charge.unknown` or `charge.requires_action` (with `data.providerState` and `data.errorCode`); a throwing listener never rejects it (see below). |
| `getMandate(provider, mandate)` | Re-reads usability from the provider: `{ status: 'active' \| 'revoked' \| 'unknown', verified }`. Call it before charging when in doubt. |
| `revokeMandate(provider, mandate)` | Calls the provider and emits `mandate.revoked` with `data: { mandateRef, revokedAtProvider }`. **Mark your own copy revoked whatever the provider answers.** |
| `supportsChargeLookup(provider)` / `getCharge(provider, chargeRef, options?)` | Since 2.2.0. Read-only: did money move for this `chargeRef`? Validates first, normalizes fail closed, emits no event. See [Looking up a charge](#looking-up-a-charge). |

Mandate methods throw `CheckoutError('MANDATES_NOT_SUPPORTED')` (HTTP 422 through the router) for a provider without mandate support, and `INVALID_MANDATE_REQUEST` for a `pending` or `mandate` of another provider.

**Events.** For charge events `paymentId` is the `providerPaymentId` and `orderId` is the `chargeRef`; every mandate and charge event has `data.mandateRef`. The credential-like `providerMandateId` (PayPal vault id, Satispay token id) is **never** part of an event: it is scrubbed from the event's copy of the whole payload (`raw`, `error`, `data`), and binary values in that copy (`Buffer`, typed arrays, `ArrayBuffer`) become `'[binary]'`, since they cannot be scrubbed. Every setup event (`mandate.setup_started`, `mandate.created`, `mandate.setup_failed`) and the first charge's `charge.*` likewise scrub `pending.providerRef` (the Satispay token id, even when the setup failed and no mandate is returned; the PayPal order id), unless it is the `orderId` or `mandateRef` (Nexi `codTrans`) or the first charge's `providerPaymentId` (PayPal, where the order id refunds the charge) and not the `providerMandateId` itself. Nothing is scrubbed when the id is the app's own `mandateRef` (Nexi), so Nexi events keep binary `raw` as is. The values returned by the methods keep the full provider `raw`.

- **Events can repeat.** The redirect and the server notification (Nexi `urlpost`, Satispay callback) can confirm the same setup concurrently, and a replayed callback or a same-`chargeRef` retry runs again: `mandate.created`, `mandate.setup_failed` and `charge.*` can be emitted more than once for the same `orderId` (= `chargeRef`). Listeners that book revenue or extend a subscription must be idempotent on `orderId`, like `onOutcome`. An `unknown` charge that is later resolved emits `charge.unknown`, then `charge.succeeded` or `charge.failed`, for the same `orderId`: dedupe on the event name and `orderId`, not on `orderId` alone.
- **Listener errors never hide a result that moved money.** `confirmMandate`, `chargeMandate` and `revokeMandate` emit after the provider call; a listener that throws there does **not** reject the method: the normalized result is returned, the remaining events are still emitted, and the error (a `CheckoutListenerError`) goes to `new CheckoutConfigurator({ onListenerError: (err, event) => … })`, or to `console.error` without that hook. Through Express, the callback still runs `onOutcome`. `mandate.setup_started` keeps the general rule (the error propagates): no money has moved yet.

### Express

```typescript
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Nexi urlpost arrives as a form POST

app.use('/checkout', createCheckoutRouter(checkout, {
  buildPaymentRequest,
  middleware: [requireAuth], // never applied to /:provider/mandate/callback
  mandates: {
    // Server-side: price from your plan, ids from your DB, fresh for every attempt
    buildMandateRequest: async (req, { provider }) => {
      const sub = await subscriptions.startCheckout(req.user.id, req.body.planId);
      const callback = `https://myapp.com/checkout/${provider}/mandate/callback`;
      return {
        mandateRef: sub.mandateRef,          // e.g. 'MNDT' + 10 random digits
        orderId: sub.firstOrderId,           // e.g. `${sub.id}-INIT`
        amount: sub.plan.price,              // e.g. 19.9
        currency: 'EUR',
        description: `${sub.plan.name} subscription`,
        returnUrl: callback,                 // MUST be the callback route
        cancelUrl: callback,                 // MUST be the callback route
        notifyUrl: callback,                 // Nexi urlpost, Satispay callback_url
      };
    },
    // Persist the pending state BEFORE the response is sent
    onStarted: async (start, req) => {
      if (start.success && start.pending) await pendings.insert({ ...start.pending, state: 'pending' });
    },
    // Single-use: null once consumed (→ 404), so a replay never reaches the provider
    loadPending: (req, { provider, mandateRef }) =>
      pendings.findOne({ provider, mandateRef, state: 'pending' }),
    onOutcome: async (outcome, req, res) => {
      const mandateRef = String(req.query.mandate_ref);
      if (outcome.terminal) {
        // Atomic conditional update: act only if it matched
        const consumed = await pendings.updateOne(
          { mandateRef, state: 'pending' },
          { state: 'done', firstCharge: outcome.firstCharge.status, setupSuccess: outcome.success },
        );
        if (consumed && outcome.mandate) await mandates.save(outcome.mandate);
        if (consumed) await subscriptions.recordFirstCharge(mandateRef, outcome.firstCharge);
        // firstCharge 'unknown': keep the row; a job re-confirms it (never chargeMandate with orderId)
      }
      // A non-terminal outcome leaves the pending state in place for the genuine callback
      // Redirect only the customer's browser (GET). A server-to-server POST (Nexi urlpost) must get
      // HTTP 200: do not respond, and the route answers 200 { success }
      if (req.method === 'GET') {
        res.redirect(302, outcome.success ? '/account/billing?ok=1' : '/account/billing?error=1');
      }
    },
  },
}));
```

- `POST /checkout/:provider/mandate` (behind `options.middleware` and `mandates.middleware`) runs `buildMandateRequest`, `checkout.createMandate`, then **awaits `onStarted`**, then answers `201 { success: true, approvalUrl }` (never `pending`, never `raw`). Send the customer to `approvalUrl`. `onStarted` also receives failed starts (`start.success === false`). `GET /checkout/:provider/mandate` answers `405` (`Allow: POST`).
- `GET|POST /checkout/:provider/mandate/callback` is **exempt from the shared `middleware`, whatever `publicPaths` says**: Nexi `urlpost`, the Satispay callback and the customer's browser reach it without your credentials. **`returnUrl`, `cancelUrl` and `notifyUrl` must point to this route** (`<mount>/<provider>/mandate/callback`), as **absolute** `http(s)` URLs (a relative URL answers `400 INVALID_MANDATE_REQUEST`); the provider appends `mandate_ref`, which the route validates (400), passes to `loadPending` (`null` → 404), then calls `checkout.confirmMandate` and `onOutcome`. If `onOutcome` does not respond, the route answers `200 { success }`.
- All four hooks are required: without one, `createCheckoutRouter` throws `INSECURE_CONFIGURATION` at mount.

**Pending state is single-use.** When `outcome.terminal` is true, `onOutcome` must atomically mark the pending state consumed and persist the mandate (a conditional update such as `pending → done`, acting only if it matched). From then on `loadPending` must return `null`, so a replayed callback answers 404 and never reaches the provider again. This matters most for Satispay, where a replay would re-run the first charge, protected only by an idempotency key of undocumented retention. Non-terminal outcomes (unverified, still pending, network error) must not consume the pending state. Expire stale pending states after a TTL of your choice, for example 24 hours. **Consumed means closed to the callback route, not deleted:** keep the consumed record while its first charge is `unknown`, since that is the input to the re-confirm job below.

**Why an unsigned `mandate_ref` is safe.** `mandate_ref` comes from the query string and is used **only** as a lookup key. Every provider verifies the callback against the persisted `pending` (the MAC-covered Nexi `codTrans`, the PayPal order id, a server-to-server re-read of the Satispay token), never against the query. A forged `mandate_ref` therefore leads at most to confirming another customer's genuinely approved setup, idempotently.

Without Express, call the same methods from your own routes: `createMandate` then persist `pending`; on the callback, load `pending` by `mandate_ref` and call `confirmMandate(provider, pending, { query, body, headers, context: { method, path, rawBody } })`.

### Resolving an unknown first charge

A terminal setup outcome can report `firstCharge.status === 'unknown'`. With `success: true` the mandate is active and must be saved, but nobody knows yet whether the first payment was taken. With `success: false` (for example PayPal `MANDATE_NOT_VAULTED` after a `PENDING` capture) there is no mandate, and the money may still have been taken. Either way the callback route is closed (the pending state is consumed) and the library does not resolve the charge on its own. Your app does, with a server job:

```typescript
const toManual = async (mandateRef: string) => {
  // Leaves the query for good: the job never calls the provider for it again
  if (await pendings.updateOne({ mandateRef, firstCharge: 'unknown' }, { firstCharge: 'manual' })) {
    await subscriptions.reconcileManually(mandateRef);
  }
};

for (const { state, firstCharge, setupSuccess, ...pending } of await pendings.find({ state: 'done', firstCharge: 'unknown' })) {
  // Check the age BEFORE calling the provider. Per provider: PayPal can wait, Satispay cannot (see below)
  if (tooOld(pending)) { await toManual(pending.mandateRef); continue; }

  const outcome = await checkout.confirmMandate(pending.provider, pending, {}); // no callback input
  // Money taken for another amount (since 2.2.0): every re-confirm gets the same answer. Review it,
  // with outcome.firstCharge.amount / providerPaymentId, and refund or keep the money
  if (outcome.terminal && outcome.firstCharge.errorCode === 'AMOUNT_MISMATCH') { await toManual(pending.mandateRef); continue; }
  if (!outcome.terminal || outcome.firstCharge.status === 'unknown') continue; // try again on the next run
  // The setup itself changed since (e.g. Satispay authorization canceled): the saved mandate is gone
  if (outcome.success !== setupSuccess) { await toManual(pending.mandateRef); continue; }

  // Use firstCharge only: the mandate is already saved, the subscription already started
  const resolved = await pendings.updateOne(
    { mandateRef: pending.mandateRef, firstCharge: 'unknown' },
    { firstCharge: outcome.firstCharge.status },
  );
  if (resolved) await subscriptions.recordFirstCharge(pending.mandateRef, outcome.firstCharge);
}
```

- **Never** resolve it with `chargeMandate(provider, mandate, { chargeRef: orderId, … })`: `chargeMandate` starts a new merchant-initiated charge, and only some providers would recognise it as a replay of the first one. The rule "retry `unknown` with the same `chargeRef`" covers charges made by `chargeMandate` only.
- **Not every `unknown` first charge resolves.** One with `errorCode: 'AMOUNT_MISMATCH'` (since 2.2.0: the provider took money for another amount or currency than `pending`, for example a PayPal capture of another value) gets the same answer on every re-confirm. Hand it to manual review at once, as the job above does: `firstCharge.amount` and `currency` say what was taken, and `firstCharge.providerPaymentId` refunds it.
- A re-confirm that is terminal emits its events again (`mandate.created` or `mandate.setup_failed`, then the first charge's `charge.*`): the first run emitted `charge.unknown`, the resolving one emits `charge.succeeded` or `charge.failed`, for the same `orderId`. Dedupe on the event name and `orderId`, not on `orderId` alone, or you drop the resolution.
- Re-confirm with the persisted `pending`, verbatim, as for the callback. `{}` carries no callback fields, so a provider can only answer from a server-to-server re-read or by replaying its own idempotency keys, never from query values.
- Per provider, as specified in #31 to #33:
  - **Nexi XPay** never reports a terminal outcome with an `unknown` first charge: the MAC-verified callback is either OK (`succeeded`) or KO (`failed`). A re-confirm with `{}` is unverified and non-terminal, and moves no money.
  - **PayPal** re-reads the order (`getOrder`) and maps its existing capture. A `COMPLETED` order is never captured again, so the job can keep re-confirming a `PENDING` capture for as long as PayPal takes to settle it.
  - **Satispay** re-reads the authorization and replays the first payment with the same `Idempotency-Key` (= `orderId`), which returns Satispay's original response. That key's retention is not documented, so re-confirm promptly (minutes to hours, not days), and reconcile manually in the Satispay dashboard (`external_code` = `orderId`) once the setup is older than that. If the customer cancelled the authorization in the meantime, the re-read is `CANCELED` and the first payment is still replayed with the same key: Satispay's original `ACCEPTED` payment gives `success: false` with a `succeeded` first charge ('Authorization canceled after the first charge'), a 4xx (no payment exists for the key) gives a verified `failed` one, and anything else stays `unknown` and non-terminal. Both terminal cases differ from the first run's `success`, so the job above hands them to manual reconciliation, with `firstCharge` saying whether the money was taken (see the Satispay subsection below).
- When the job gives up, reconcile in the provider's dashboard by the setup's `orderId` (Nexi `codTrans`, PayPal `invoice_id`, Satispay `external_code`), then record the result yourself.

### Renewal job (no HTTP)

Charges are a server job. A daily run might look like this:

```typescript
for (const sub of await subscriptions.due(new Date())) {
  const mandate = await mandates.load(sub.mandateRef); // the persisted Mandate, verbatim
  const chargeRef = `${sub.id}-${sub.periodStart}`;     // same value on every retry of this period
  const result = await checkout.chargeMandate(mandate.provider, mandate, {
    chargeRef: sub.retry ? `${chargeRef}-r${sub.retry}` : chargeRef,
    amount: sub.plan.price,
    currency: 'EUR',
    description: `${sub.plan.name} ${sub.periodStart}`,
  });

  if (result.providerState) {
    // A Nexi replay of a charge since refunded or only partly captured: not a paid renewal. Check it
    // before the status: the amount check can turn such a replay into `unknown`, and a retry with the
    // same chargeRef would only replay the same report entry, run after run
    await subscriptions.review(sub, result.providerState);
    continue;
  }
  if (result.errorCode === 'AMOUNT_MISMATCH') {
    // Since 2.2.0: money taken for another amount or currency (result.amount, result.currency). Never
    // retry it: a retry with the same chargeRef gets the same answer. Review it, refund or keep the money
    await subscriptions.review(sub, result.errorCode);
    continue;
  }

  switch (result.status) {
    case 'succeeded':       // money taken: extend the period, issue the invoice
      await subscriptions.renew(sub, result.providerPaymentId);
      break;
    case 'unknown':         // do NOT count as a failure: retry with the SAME chargeRef next run
                            // (first charges of a setup are re-confirmed instead, see above;
                            // when a retry is no longer allowed, look the charge up, see below)
      await subscriptions.markUnknown(sub, result.error);
      break;
    case 'failed':          // authoritative refusal: dunning, next attempt gets a NEW chargeRef
      if (result.mandateUnusable) await mandates.markRevoked(sub.mandateRef);
      await subscriptions.dunning(sub, result.providerCode);
      break;
    case 'requires_action': // the customer must act: ask them to set up a new mandate
      await subscriptions.askForAction(sub);
      break;
  }
}
```

Only `failed` counts towards dunning. Refund a mandate charge with the existing `refundPayment(provider, result.providerPaymentId, amount)`; since 2.2.0, pass `{ idempotencyKey }` (for example `` `${chargeRef}-R1` ``) on PayPal and Satispay, so that a refund whose outcome is unknown can be retried with the same key instead of being reconciled by hand at once (Nexi takes no key). Read each result with the provider's table in [Refunds](#refunds), and bound the retries: a PayPal refusal looks like an unknown outcome and answers the same every time. To change the card, the customer creates a new mandate.

### Looking up a charge

Since 2.2.0. The documented way to resolve an `unknown` charge is a retry with the same `chargeRef`, but a retry is not always allowed: the subscription may have closed meanwhile (a retry would charge for a service no longer delivered), the replay window may have passed (PayPal keeps `PayPal-Request-Id` for 6 hours; Satispay does not document its retention), or an operator resolves the charge by hand. `getCharge` answers, **read-only**, "did money move for this `chargeRef`?". It never charges, never refunds, emits no event and is never mounted as a route.

```typescript
if (checkout.supportsChargeLookup(mandate.provider)) {
  const found = await checkout.getCharge(mandate.provider, chargeRef, {
    since: attempt.firstSentAt, // ISO 8601: the earliest time a request with this chargeRef may have been sent
    until: attempt.lastSentAt,  // the latest one (default: since)
    mandate,                    // optional: the charge found must belong to this mandate
  });
  switch (found.status) {
    case 'succeeded': /* money taken (found.providerState: refunded or partly captured since?) */ break;
    case 'failed':    /* every attempt refused: close it, dun with a NEW chargeRef */ break;
    case 'absent':    /* authoritatively no transaction: nothing taken, dun with a NEW chargeRef */ break;
    case 'pending':   /* an attempt that may still take money: look again later */ break;
    case 'unknown':   /* the lookup says nothing: look again later or reconcile by hand */ break;
  }
}
```

| `status` | Meaning |
|----------|---------|
| `succeeded` | Money was taken for `chargeRef`. It may have been refunded since: see `providerState` (`refunded`, `partially_refunded`, `partially_captured`) and `refundedAmount`. |
| `failed` | The provider holds `chargeRef` and every attempt was refused: no money was taken. |
| `pending` | An attempt exists that is not final (Nexi `In Corso` or an unrecognised `stato`, a PayPal capture `PENDING`): it may still take money. |
| `absent` | The provider reports, **authenticated**, that it holds no transaction for `chargeRef`. |
| `unknown` | The lookup says nothing: network error, timeout, HTTP error, bad or missing MAC, unparseable body, missing permission, data not indexed yet, ambiguous data. |

- **The in-flight rule.** A lookup made while a request with this `chargeRef` may still be in flight proves nothing: `absent` can be followed by that request taking the money. Look up only once no such request can still complete.
- **What the configurator guarantees.** `getCharge` validates first, without calling the provider (`INVALID_MANDATE_REQUEST`): `chargeRef` must match `CHARGE_REF_PATTERN`; `options.since` and `options.until`, when present, must be strings with a finite `Date.parse`, with `until >= since`; `options.mandate`, when present, must belong to the provider. Then it normalizes fail closed, into a new object: `verified` is `true` only when the provider said exactly `true`; any status other than `unknown` without it becomes `unknown` (`'Charge lookup could not be verified'`), and an `unknown` result is never verified and carries no `providerPaymentId`, `amount`, `currency`, `providerStatus`, `providerState` or `refundedAmount`; `chargeRef` is always the request's; a provider that throws gives `unknown` with `raw` reduced to the error's `{ name, message }`.
- **Not supported:** `getCharge` on a provider without the capability (Satispay in 2.2.0, which documents no search by `external_code`) throws `CheckoutError('CHARGE_LOOKUP_NOT_SUPPORTED')`, which the router maps to HTTP 422. Check `checkout.supportsChargeLookup(provider)` first.
- **`raw`** is the provider's answer (the Nexi `situazioneOrdine` JSON, the PayPal captured payment). It may contain personal data (masked PAN, payer account id): never log or persist it.
- **`refundedAmount`** is the provider's total refunded so far for the charge, in major units of its currency, only on a verified `succeeded`. `0` means the provider reports no refund; **absent means the provider does not report it: never read absence as `0`**. PayPal counts the order's `COMPLETED` refunds (a `PENDING` refund is not counted: it may still complete); a `REFUNDED` or `PARTIALLY_REFUNDED` capture whose order lists no `COMPLETED` refund gets no `refundedAmount`, never `0`, since `0` would contradict the capture's own status. Nexi reports `0` for a paid state without a refund and nothing for `Rimborsato` / `Rimborsato Parz.`, since `situazioneOrdine` documents no refunded amount: with Nexi, compare `providerState` only and reconcile partial refunds in the Nexi back office. PayPal `getPaymentDetails(orderId)` reports the same `refundedAmount` (from the order it already reads), and the other providers' `getPaymentDetails` leave it undefined.

**Nexi XPay** reads `situazioneOrdine` for the code (bounded by `timeoutMs`), classifying every report entry like the [replay guard](#nexi-xpay) of `chargeMandate`. `options` are ignored.

| `situazioneOrdine` | Result |
|--------------------|--------|
| An entry took the money (`Autorizzato`, `Contabilizzato`, `Catturato`, `Contabilizzato Parz.`, `Rimborsato`, `Rimborsato Parz.`) | `succeeded`, verified; `providerPaymentId` = `chargeRef`; `amount`, `currency` and `providerStatus` (the `stato`, trimmed) of the reported entry; `providerState` for the last three; `refundedAmount: 0` except for `Rimborsato` / `Rimborsato Parz.`. With several paid entries, the reported one is the most specific fact: the first refund or partial-capture entry, otherwise the first paid one (the replay guard of `chargeMandate` keeps reporting the first paid one, as in 2.1.0, and flags the state in `providerState`) |
| Every entry refused (`Negato`, `Annullato`, `Non Creato`) | `failed`, verified, with `providerStatus` |
| An entry `In Corso`, or with an unrecognised or missing `stato` (and none paid) | `pending`, verified |
| OK with no entry for the code, or a **MAC-signed** KO "not found" (2, 13) | `absent`, verified |
| A KO "not found" **without a MAC** | `unknown`, `'Nexi "not found" answer carries no MAC'` |
| HTTP, network, timeout, non-JSON, bad or missing MAC, no `report`, any other KO | `unknown` (the `error` never contains the response body) |

Whether XPay signs its KO answers is to be confirmed against `int-ecommerce.nexi.it`. If it never does, a Nexi "not found" is always `unknown` and only an "OK with no entry" gives `absent`: the fail-closed reading.

**PayPal** has no search on Orders v2. `getCharge` locates the capture with the **Transaction Search** API, by `invoice_id` (renewal orders carry `invoice_id = chargeRef` and `custom_id = mandateRef`; a setup's first charge carries `invoice_id = orderId`), then re-reads the capture with `getCapturedPayment`: the answer comes from that authenticated read. It needs "Transaction search" enabled on the REST app (see [Provider prerequisites](#provider-prerequisites)).

- **`options.since` is required** (without it: `unknown`, no API call); `until` defaults to `since` and may be at most 30 days later (otherwise `unknown`, `'PayPal charge lookup window exceeds 31 days'`). The search window is `since − 1 h` .. `min(now, until + 1 h)`: PayPal's maximum is 31 days. Pages of 500, at most 10 pages (more is `unknown`; `total_pages: 0` on an empty first page is an empty window), and no amount filter, so a charge taken for another amount is still found.
- **Indexing delay.** PayPal lists a transaction up to 3 hours after it executed. No record with the `invoice_id` is `absent` only once `now − until >= 4 h` (the 1-hour margin plus the 3-hour delay), and `unknown` before (`'PayPal transaction search may not list this charge yet'`). The same holds for `failed`, which also relies on no other attempt being listed: a `DECLINED` or `FAILED` capture found before then is `unknown` with that error, since a later attempt (for example a new order sent after the 6-hour request-id window) may not be listed yet. A `COMPLETED` or `PENDING` capture found before then is reported as usual: money moved, or may.
- **A double charge is `unknown`.** More than one distinct capture with the `invoice_id` gives `unknown` (`'More than one PayPal capture has this invoice_id: reconcile it in PayPal'`): the library never picks one. This check sees only the captures already listed, so it is reliable only once `now − until >= 4 h`: before then, a second capture made in the last hours may not be listed yet, and one capture reads `succeeded`. For a final answer, double charge included, look up again after that horizon. More than 5 matching records, and a capture whose `invoice_id` or (with `options.mandate`) `custom_id` does not match, are `unknown` too. A matching record that is not a capture (a 404 on the re-read, e.g. a refund of the same invoice) is skipped.

| Capture `status` | `status` | `providerState` |
|------------------|----------|-----------------|
| `COMPLETED` | `succeeded` (`refundedAmount: 0`) | none |
| `PARTIALLY_REFUNDED` | `succeeded` | `partially_refunded` |
| `REFUNDED` | `succeeded` | `refunded` |
| `PENDING` | `pending` | none |
| `DECLINED`, `FAILED` | `failed` (`unknown` before `now − until >= 4 h`) | none |
| any other value | `pending` (fail safe) | none |

Every row is verified, with `providerStatus` = the capture status, `amount` and `currency` of the capture, `providerPaymentId` = the order id (`capture.supplementary_data.related_ids.order_id`, the id `refundPayment` takes) and `raw` = the captured payment, never a search page (it lists other customers' transactions). For `REFUNDED` and `PARTIALLY_REFUNDED`, `refundedAmount` comes from one more read of the order (`getOrder`): it is left out, and the result stays `succeeded` with its state, when that read fails, the order's first capture is not this one, or the order lists no `COMPLETED` refund. Error results carry only PayPal's error body, with the HTTP status in `error` (for example `'PayPal transaction search failed (HTTP 403)'`), never the SDK error, which carries the bearer token.

### Provider prerequisites

- **Nexi XPay:** MIT/recurring must be enabled on the terminal profile by Nexi support. Scheduled and unscheduled contracts are not interchangeable: state which one you need.
- **PayPal:** "Save payment methods" (reference transactions) must be approved on the account. Turn on the payment receiving preference "Block accidental payments" (one payment per invoice ID): with it, a replay after PayPal's 6-hour request-id window cannot charge twice. For [`getCharge`](#looking-up-a-charge), enable **Transaction search** on the REST app (scope `https://uri.paypal.com/services/reporting/search/read`): without it the lookup answers `unknown`.
- **Satispay:** pre-authorized payments (Automatic Payments) must be enabled for the shop.

Use `checkout.supportsMandates(provider)` to check whether a registered provider implements `IMandateProvider`, and `checkout.supportsChargeLookup(provider)` for `IChargeLookupProvider`.

### Nexi XPay

`NexiProvider` implements `IMandateProvider` with XPay contracts ("Specifiche tecniche di integrazione con il gateway di pagamento XPay" v20.4): the setup is a hosted-page first payment that registers the contract (`num_contratto` = your `mandateRef`, `tipo_servizio=paga_multi`, `tipo_richiesta=PP`, `codTrans` = `orderId`), renewals use `POST /ecomm/api/recurring/pagamentoRicorrente` (`codiceTransazione` = `chargeRef`), `getMandate` reads `dettagliContratto` and `revokeMandate` calls `cancellaContratto`.

```typescript
const nexi = new NexiProvider({
  merchantId: process.env.NEXI_ALIAS!,
  macKey: process.env.NEXI_MAC_KEY!,
  environment: 'production',
  contractType: 'S', // only if the terminal does both scheduled and unscheduled contracts
  timeoutMs: 30000,  // recurring, contract and getCharge API calls (default 30000)
});
```

- **Terminal.** Recurring payments must be enabled on the terminal by XPay support, stating whether the contracts are **scheduled** or **unscheduled** (MIT): the two are not interchangeable. A merchant whose terminal does both sets `contractType: 'S'` or `'U'`, sent as `tipo_contratto` and included in the setup MAC. Two more terminal settings matter; agree them with XPay support too:
  - **One payment attempt per `codTrans`.** XPay can be configured for up to 3 attempts with the same transaction code, and such a terminal sends several notifications for the same order (manual, pp. 32-33). The library treats a MAC-verified `KO` as a terminal refusal, so the first KO consumes the pending setup; an OK from a later attempt with the same `codTrans` then answers 404, and the customer is charged and a contract exists while the app has no mandate. Use a terminal that allows a single attempt per `codTrans`.
  - **What happens when the `urlpost` notification fails.** XPay either keeps the transaction, leaving the merchant to recover the outcome from the back office, e-mail or API, or voids the authorization without charging the customer (manual, p. 17); the merchant tells support which one. The library requires only that the `urlpost` get HTTP 200 (see **Notification** below). On a terminal that voids, any other answer can void a first payment the app has already recorded as an active, paid mandate. On a terminal that keeps it, a missed `urlpost` is recovered only by the customer's redirect: if the customer never comes back, the first payment and the contract exist at Nexi with no mandate in the app, and a re-confirm with `{}` is non-terminal, so reconcile by `codTrans` in the back office.
- **Currency: EUR only.** `pagamentoRicorrente` accepts only `divisa=978`, so `createMandate` and `chargeMandate` with any other currency return a failure without calling Nexi.
- **Callback.** Nexi redirects the customer to `url` / `url_back` with the outcome in the query string, and sends the `urlpost` notification as a **form POST**: mount `express.urlencoded()` before the checkout router, or the notification body is empty and the outcome stays unverified. Both arrive at the callback route and are verified with the 7-field outcome MAC; the MAC-covered `codTrans`, `importo` and `divisa` must match the pending setup. The contract number is always the persisted `mandateRef`, never the query's `num_contratto`; an OK outcome must still echo `num_contratto` equal to it (without it, no contract may have been registered), and a `tipo_servizio` / `tipo_richiesta` other than `paga_multi` / `PP` is rejected; such outcomes are unverified and non-terminal. The validated card expiry (`scadenza_pan`) and masked PAN (`pan`) are copied to `mandate.unverified`; the unfiltered callback fields, these two included, remain in the outcome's `raw` and in the `raw` of the `mandate.created` / `mandate.setup_failed` events, so do not log or persist `raw` where card data must not appear. Only `KO`, `ANNULLO` and `ERRORE` are terminal refusals; any other `esito` (such as a pending one) is unverified and non-terminal, so the pending setup survives until the final outcome arrives. A Nexi first payment is never `unknown` on a terminal outcome.
- **Notification (`urlpost`) must get HTTP 200.** The manual requires the `urlpost` answer to be an "HTTP 200" to confirm receipt (pp. 22-23 and 33). Do not redirect the POST: the README `onOutcome` redirects only `GET` requests (the customer's browser) and lets the route answer `200 { success }` for the POST. On a terminal set to void on notification failure, every other answer must be assumed to count as a failed delivery: the `404` for a late or replayed `urlpost` whose pending setup was already consumed or expired, a `500` from a hook that throws, and a `302` too (whether XPay treats a 3xx as a failure is not documented; this follows the manual's "must be HTTP 200" wording). Whenever the `urlpost` is confirmed first, it consumes the pending setup, and the customer's browser then reaches the callback route with no pending state and gets the route's `404` JSON instead of your UI. That order is guaranteed on a terminal that voids on notification failure, where the redirect to `url` happens only after the `urlpost` answer (p. 33), and possible on any other.
- **Retries.** Before every charge the provider reads `situazioneOrdine` for the `chargeRef`: one that took the money (`Autorizzato`, `Contabilizzato`, `Contabilizzato Parz.`, and also `Rimborsato` / `Rimborsato Parz.`) is returned as `succeeded` without charging again, with the `stato` in `result.providerStatus` (trimmed) and, for `Rimborsato`, `Rimborsato Parz.` and `Contabilizzato Parz.`, `result.providerState` (`'refunded'`, `'partially_refunded'`, `'partially_captured'`); one that Nexi refused (`Negato`, `Annullato`, `Non Creato`) as `failed`; one still in progress (`In Corso`) or with any other `stato`, and a lookup that fails, as `unknown` (nothing is charged). A refunded `chargeRef` is `succeeded` because the charge did happen: check `result.providerState` before extending a subscription on a retried charge, and send a partly captured one to review, since the money taken may be less than the price. Both fields survive the configurator's amount check (a partly captured or refunded charge can report another amount, which makes the result `unknown`) and are dropped from unverified results, so act on `result.providerState` whatever the status, as the [renewal job](#renewal-job-no-http) does: retrying such an `unknown` with the same `chargeRef` only replays the same entry. `result.raw.stato` is still there, verbatim, but it is not the documented field. Retry an `unknown` charge with the same `chargeRef`; an `In Corso` one resolves once Nexi completes it. **A dunning retry after `failed` needs a new `chargeRef`**: Nexi would accept up to 2 retries of the same code after a KO, but the library does not use them. If several report entries share the `chargeRef`, any one that took the money makes it `succeeded` (`amount`, `currency`, `providerStatus` and `raw.stato` are the first such entry's, as in 2.1.0, and `providerState` is set when any of them is refunded or partly captured, so the two can come from different entries), otherwise any one not final makes it `unknown`, and it is `failed` only when every entry is a refusal. Since 2.2.0, `getPaymentDetails('nexi', code)` selects the entry the same way (it used to read only the first one): a code listed `Negato` then `Contabilizzato` is paid (`success: true`), while a report whose first entry is paid keeps its 2.1.0 result (a code listed `Autorizzato` then `Rimborsato` stays `success: true`, `status: 'Autorizzato'`; `getCharge` reports the refund). To read a charge without charging, use [`getCharge`](#looking-up-a-charge). Codes 8, 14 and 22 (invalid contract, card expired, card not chargeable) set `mandateUnusable`; credential, MAC and technical errors are `unknown`. An amount over 8 digits of cents (999999.99 EUR) is `failed` without calling Nexi.
- **12-month expiry (manual, p. 61).** Contracts unused for more than 12 months expire under card-scheme rules, so a **yearly** plan sits right at the limit. Nexi's remedy is a 1-cent recurring charge followed by a refund before the 12 months run out (`chargeMandate` with a 0.01 EUR charge, then `refundPayment('nexi', result.providerPaymentId, 0.01)`): your scheduler must plan for it.
- **Refunds.** `providerPaymentId` is the `codiceTransazione` (= `chargeRef`), so the existing `refundPayment` refunds a mandate charge. The storno API has no idempotency key: a refund with `{ idempotencyKey }` is refused (`REFUND_IDEMPOTENCY_NOT_SUPPORTED`, see [Refunds](#refunds)), so a Nexi refund whose outcome is unknown is still reconciled by hand.

### PayPal (Vault)

`PayPalProvider` implements `IMandateProvider` with **PayPal Vault, saving the PayPal wallet during the first purchase** (Orders v2). It uses no PayPal Subscriptions, billing plans or setup tokens. Requires `@paypal/paypal-server-sdk` `^2.5.0`.

**Prerequisites.**
- The account must be approved for **reference transactions** ("Save PayPal and Venmo payment methods" in the Payment Preferences). In the sandbox, enable *Vault* under the app's Advanced options. Without it, the setup order is refused or the wallet is not vaulted.
- Turn on the payment receiving preference **"Block accidental payments"** (one payment per invoice ID). The replay guarantee below depends on it.
- Optional: `new PayPalProvider({ clientId, clientSecret, customerType: 'BUSINESS' })` (default `'CONSUMER'`) sets the vault customer type.
- Recommended: `timeoutMs: 30000` (since 2.2.0). See **Timeout** below.

**Setup.** `createMandate` creates an order for the first charge with `store_in_vault: ON_SUCCESS` (`usage_type: MERCHANT`, `usage_pattern: SUBSCRIPTION_PREPAID`). The order's `invoice_id` and `reference_id` are your `orderId`, its `custom_id` is the `mandateRef`, and its request id is `setup-<orderId>`. `pending.providerRef` is the PayPal order id and `approvalUrl` is its `payer-action` link. `notifyUrl` is ignored: PayPal webhooks (`VAULT.PAYMENT-TOKEN.*`) are not used.

**Confirm.** `confirmMandate` ignores everything in the callback except `token`, which must be `pending.providerRef` (otherwise it is an unverified, non-terminal failure). It re-reads the order with `getOrder` **before** capturing, and checks `custom_id`, `invoice_id`, the amount and the currency against `pending`. An order that does not match is a terminal failure and is **never captured**. Then, by order status:
- `APPROVED`: captured once, with the request id `capture-<orderId>`. If a concurrent confirm captured it first (`ORDER_ALREADY_CAPTURED`), the order is re-read.
- `COMPLETED`: already captured. It is used as it is, so a re-confirm with `{}` never captures twice, even after PayPal's 6-hour request-id window.
- `CREATED`, `SAVED`, `PAYER_ACTION_REQUIRED`: the customer has not approved, or not yet. This is a verified, **non-terminal** failure (`ORDER_NOT_APPROVED`): a cancel link does not end the setup.
- `VOIDED`: a terminal failure.
- Any error reading the order (5xx, network, 401, 403, 429), or a capture call that errors with anything other than `ORDER_ALREADY_CAPTURED`: non-terminal, with the first charge `unknown`.

`firstCharge.providerPaymentId` is the **PayPal order id**, which `refundPayment` accepts. A capture still `PENDING` is `unknown`: re-confirm it with `{}` from a job (see [Resolving an unknown first charge](#resolving-an-unknown-first-charge)). A `COMPLETED` capture of another amount or currency than `pending` is `unknown` with `error: 'Captured amount does not match'` and, since 2.2.0, `errorCode: 'AMOUNT_MISMATCH'`, `providerPaymentId` (the order id: the money was captured, so `refundPayment('paypal', providerPaymentId, amount)` refunds it), and the captured `amount` and `currency` when PayPal reported them. The outcome is still a terminal success with the vaulted mandate, as in 2.1.0. Do not re-confirm it in a loop: review it, and refund or keep the money. Since the order id is the first charge's refundable id, it is no longer scrubbed from that setup's events. `providerMandateId` is the vault payment token id and `providerData.customerId` is the PayPal customer id; the payer email is only a hint under `mandate.unverified`.

**`MANDATE_NOT_VAULTED`.** If the order was captured but PayPal did not report the vault token as `VAULTED` (status `APPROVED`, `CREATED`, or no vault at all), the outcome is terminal with `success: false` and `error: 'MANDATE_NOT_VAULTED'`, and **`firstCharge` still reports the capture**: the customer may have paid. Check `firstCharge.status`. When it is `succeeded`, either refund it with `checkout.refundPayment('paypal', outcome.firstCharge.providerPaymentId)` or keep it as a one-off payment (for example, one paid period with no renewal), and ask the customer to set up a new mandate with a fresh `mandateRef` and `orderId`. The token id is scrubbed (`'[redacted]'`) from `outcome.raw` and from the `mandate.setup_failed` event, as it is from every outcome without a mandate: a token not yet `VAULTED` may still become usable.

**Charges and replays.** `chargeMandate` creates a merchant-initiated order paid with the vault token (`stored_credential`: `MERCHANT`, `SUBSEQUENT`, `SUBSCRIPTION_PREPAID`), whose request id and `invoice_id` are the `chargeRef`. `providerPaymentId` is the order id. An order that needs the customer (`PAYER_ACTION_REQUIRED`) is `requires_action`; a `DECLINED` or `FAILED` capture and any other 4xx are `failed` (`providerCode` is PayPal's issue, e.g. `PAYMENT_DENIED`); 401, 403 and 429 are `unknown` with `providerCode` `'401'`, `'403'` or `'429'`; 408, 409 and the issue `PREVIOUS_REQUEST_IN_PROGRESS` (whatever the status) are `unknown` with PayPal's issue, or the status, as `providerCode`; 5xx and network errors are `unknown`.
- **Within 6 hours**, a replay with the same `chargeRef` returns PayPal's original response (PayPal keeps request ids for 6 hours) **once the original request has finished**.
- **While the original is still in progress** (for example, a retry right after a client-side timeout), PayPal answers 409 `RESOURCE_CONFLICT` / `PREVIOUS_REQUEST_IN_PROGRESS`, which says nothing about the money: the original may still complete and charge. The result is `unknown`, never `failed`. Retry it later with the **same** `chargeRef`, never a new one: a new `chargeRef` is a new invoice id that `DUPLICATE_INVOICE_ID` cannot block, so it could charge the customer twice.
- **After 6 hours**, PayPal refuses the reused invoice id: the result is `unknown` with `providerCode: 'DUPLICATE_INVOICE_ID'` and `'A charge with this chargeRef was already submitted; reconcile it in PayPal'`. It never charges twice, **provided** "Block accidental payments" is on. Reconcile it in the PayPal dashboard by invoice id (= `chargeRef`).

**Status and revocation.** `getMandate` reads the vault token: present is `active`, 404 is `revoked` (both verified), anything else is `unknown` (unverified). `revokeMandate` **deletes the vault payment token** (`DELETE /v3/vault/payment-tokens/{id}`); a token already gone (404) also counts as revoked. Mark your own copy `revoked` whatever it returns: the configurator then refuses to charge it without calling PayPal, and PayPal itself refuses a charge on a deleted token.

**Refunds.** `refundPayment('paypal', orderId, amount?, { idempotencyKey })` sends the key as `PayPal-Request-Id`, which PayPal keeps for 45 days. Read the result with the PayPal table in [Refunds](#refunds): a `PENDING` refund is `success: false` with `verified: true` and may still complete, and a refusal (4xx) has no `verified`, like a timeout.

**Timeout** (since 2.2.0, opt-in). The PayPal SDK has no timeout by default, so a request that PayPal accepts but never answers keeps the caller waiting forever: a renewal job stalls on it, and a lease or claim held around the call is never released. `new PayPalProvider({ clientId, clientSecret, timeoutMs: 30000 })` passes `timeout` to the SDK `Client`, which bounds every PayPal API call of the provider, the OAuth token request and the `getCharge` Transaction Search included. A call that exceeds it fails like a network error: `chargeMandate` and `getCharge` are `unknown`, `confirmMandate` is unverified and non-terminal with an `unknown` first charge, `getMandate` is `unknown`, `revokeMandate` gives `revokedAtProvider: false`, and `createMandate`, `createPayment`, `executePayment`, `getPaymentDetails` and `refundPayment` give `success: false` without `verified` (a capture or a refund may have happened: retry a refund only with the same idempotency key). The thrown SDK error, which carries the request headers and so the bearer token, never reaches a result or an event.
- **Why opt-in in 2.x.** Without `timeoutMs` nothing changes: there is no timeout, exactly as in 2.1.0. A default timeout would turn a slow but successful capture or refund into an apparent failure for callers that do not treat that outcome as uncertain. A future 3.0.0 can make 30000 the default, as `timeoutMs` already is for Nexi and Satispay mandate calls.
- **Values.** 30000 is a sensible value. Only a finite number greater than 0 is used: `0`, a negative number, `NaN`, `Infinity` or a string behave as not set, as for `NexiProviderConfig.timeoutMs`.
- **Inactivity, not a deadline.** It is the SDK's (axios) socket inactivity timeout: a response that keeps trickling bytes is not cut off.
- **A failed OAuth token request.** The SDK requests a token on the first call (and again when it expires) and makes every call wait for that request. When it fails (a timeout, a reset connection, an HTTP error of `/v1/oauth2/token`), the calls waiting for it fail with that error, mapped as in 2.1.0 (a timeout like a network error, as above), with nothing sent to the API. Since 2.2.0 the provider then replaces its SDK client, so the next call requests a new token; in 2.1.0 every later call of that `PayPalProvider` failed at once with the same error, until the app built a new one. Without `timeoutMs`, a token request that never answers stalls every later call of the provider, not only the first.

### Satispay

`SatispayProvider` implements `IMandateProvider` with **Automatic Payments (pre-authorized payment tokens), web-redirect flow**: `createMandate` creates an authorization, the customer approves it in Satispay, and every charge (the first one included) is a synchronous `PRE_AUTHORIZED` payment.

- **Prerequisite:** pre-authorized payments (Automatic Payments) must be enabled for your shop by Satispay. Without it, `createMandate` fails.
- **EUR only.** `createMandate` and `chargeMandate` refuse any other currency without calling Satispay.
- **`redirect_url` must not be opened in a WebView.** `approvalUrl` is the authorization's `redirect_url`: send the customer there in the browser (or let the Satispay app open it), never inside an embedded WebView.
- **`cancelUrl` is unused:** Satispay has no cancel redirect. The customer always comes back to `returnUrl` (with `mandate_ref`), and a declined authorization is reported by the re-read as `CANCELED` (terminal, `success: false`, no mandate). `confirmMandate` then replays the first payment (same body, `Idempotency-Key` = `orderId`), because a re-confirm after an `unknown` first charge (see "Resolving an unknown first charge" above) can find the authorization canceled after that payment was taken:
  - a 4xx: no payment exists for that key (on a first confirm, the customer declined). The first charge is a verified `failed` ('Authorization canceled').
  - `ACCEPTED`: Satispay's original first payment. The outcome is `error: 'Authorization canceled after the first charge'` with a verified `succeeded` first charge: the customer paid once but there is no mandate. As for PayPal's `MANDATE_NOT_VAULTED`, refund it with `checkout.refundPayment('satispay', outcome.firstCharge.providerPaymentId, amount)` or keep it as a one-off payment, and ask for a new setup with a fresh `mandateRef` and `orderId`. Listeners see `mandate.setup_failed`, then `charge.succeeded`, for the `orderId`.
  - 401, 403, 408, 409, 429, 5xx, a timeout or a network error: unverified, non-terminal, `unknown` first charge, no events. Re-confirm later.
  - The replay is authoritative only while Satispay keeps the key, which is not documented: re-confirm promptly, and reconcile older setups in the Satispay dashboard (`external_code` = `orderId`).
- **Callback.** The authorization's `callback_url` is `notifyUrl`, or `serverUrl` + `mandateCallbackPath` (default `/checkout/satispay/mandate/callback`) when `notifyUrl` is not set, with `mandate_ref` and `token_id={uuid}` appended. Satispay calls it with an HTTP GET whenever the authorization changes, replacing `{uuid}` with the token id. The callback is unsigned: `confirmMandate` only checks that `token_id`, when present, equals the persisted `pending.providerRef`, then re-reads the token server-to-server. `PENDING` is a verified, **non-terminal** outcome (`error: 'AUTHORIZATION_PENDING'`): keep the pending state and wait for the next callback. `ACCEPTED` activates the mandate and makes the first charge.
- **Revocation is customer-side only.** Satispay documents no merchant-side revocation, so `revokeMandate` makes no network call and returns `revokedAtProvider: false`: stop charging the mandate and mark your copy revoked. The customer revokes it from the Satispay app; `getMandate` then reads `revoked`, and a later charge fails with `mandateUnusable: true`.
- **Charges and replay semantics.** Every `PRE_AUTHORIZED` payment carries `Idempotency-Key = chargeRef` (the first charge: `orderId`; the setup itself: `setup-<orderId>`), and a request with the same key gets Satispay's original response, so a retry with the same `chargeRef` never charges twice. Satispay does not document how long it keeps idempotency keys: retry an `unknown` charge **promptly (the same day)**, and resolve older ones manually in the Satispay dashboard (`external_code` = `chargeRef`). A refused charge is a 4xx (`failed`, `providerCode` = Satispay's `code`); 401, 403, 429, 5xx, timeouts and network errors are `unknown`. 408 and 409 are `unknown` too: they may answer a concurrent request with the same key still in flight (the redirect and Satispay's callback can confirm the same setup at once), and the original may succeed. The payment is created as `ACCEPTED` directly, and `providerPaymentId` is the Satispay payment id, so `refundPayment(provider, providerPaymentId, amount)` refunds a mandate charge.
- **Check on the sandbox before going live** (Satispay does not document them): that a charge on a canceled token answers 4xx and creates no payment (and with which `code`), which the first confirm of every declined authorization relies on; that a replayed `Idempotency-Key` returns the original payment, also once the token is `CANCELED`; which status answers a same-key request still in flight (treated as `unknown` for 408 and 409; any other 4xx would be read as `failed`). Since 2.2.0 refunds use the documented `flow: 'REFUND'` payment instead of the undocumented `POST /payments/{id}/refunds` that earlier versions called, so check also: that a `flow: 'REFUND'` payment answers `ACCEPTED` with `type: 'REFUND_TO_BUSINESS'`; that a replayed `Idempotency-Key` returns the original refund; that an over-refund (more than what is left of the payment) answers 4xx.
- **Refunds.** See [Refunds](#refunds): a refund is a new `flow: 'REFUND'` payment, reported as a success only when it is `ACCEPTED`; a refusal (4xx) is told apart from an unknown outcome; a full refund first reads the payment; `{ idempotencyKey }` is sent as `Idempotency-Key`.
- **Config.** `timeoutMs` (default `30000`) bounds every mandate API call, and the refund calls only when it is set (refunds have no default timeout, as in 2.1); `mandateCallbackPath` changes the default callback path.

---

## Security: A Redirect Is Not Proof of Payment

Relying solely on front-end browser redirects (`GET /:provider/redirect`) to fulfill orders introduces significant risk:
- **Drop-off**: Shoppers may close the tab, lose connectivity, or navigate away before reaching your redirect URL.
- **Tampering**: Unless protected by cryptographic signatures (such as Nexi's mandatory outcome MAC), client-controlled URL parameters can be manipulated.
- **Amount Mismatch**: Always verify that the captured payment amount matches your order ledger before fulfilling goods or services. In `awesome-node-checkout`, `success: true` strictly requires that a payment is confirmed with a valid amount.

To ensure safe fulfillment:
1. **Verify Amount & Currency**: `PaymentResult` and `WebhookResult` return `amount` and `currency` extracted directly from the provider. Compare amounts in minor units (cents) or with rounding to prevent floating-point discrepancies. The example below scales by 100, which is exact for currencies with at most 2 decimal places (every Nexi and Satispay payment created through this library); for a PayPal order in a 3-decimal currency such as KWD, scale by 1000:
   ```typescript
   const result = await checkout.handleRedirect(provider, req.query);
   if (result.success) {
     if (result.amount === undefined) {
       throw new Error('Payment reported success but amount is missing');
     }
     const orderCents = Math.round(order.totalAmount * 100);
     const resultCents = Math.round(result.amount * 100);
     if (resultCents !== orderCents || result.currency !== order.currency) {
       throw new Error('Authorized amount does not match order total');
     }
   }
   ```
2. **Use Server Notifications / Webhooks**:
   - For **Nexi**: Pass `notifyUrl` in `PaymentRequest` (e.g. `https://myapp.com/checkout/nexi/webhook`). Nexi sends a server-to-server POST notification (`urlpost`) with the 7-field outcome MAC. Ensure your app includes `app.use(express.urlencoded({ extended: false }))`.
   - For **Satispay**: Set `serverUrl` (and optionally `callbackPath`, default `/checkout/satispay/webhook`). Note that `serverUrl + callbackPath` must include the router mount prefix (e.g. if mounted at `/checkout`, use `/checkout/satispay/webhook`).
     - **Production Requirement**: Configure `webhookPublicKey` with Satispay's RSA public key (obtained via `GET /g_business/v1/consumers/{keyId}`) to enforce HTTP Signature verification. The verifier strictly requires at least `(request-target)`, `date`, and `digest` (when a body is present), as well as a valid `Date` header within the freshness window.
     - **Raw Body Requirement**: In Express, capture the raw body buffer using `express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } })`. Passing a re-serialized or pretty-printed JSON body will alter whitespace and fail SHA-256 digest validation.
     - **GET Callbacks vs POST Webhooks**:
       - **POST Webhooks**: Sent directly from Satispay servers with an HTTP `Signature` header. When `webhookPublicKey` is configured, signature validity, header completeness, and freshness are strictly verified before processing.
        - **GET Callbacks** (`?payment_id=...`): Satispay GET callbacks (e.g. user return/redirect) do not carry HTTP signatures. An unsigned GET callback is accepted solely as a trigger for a secure server-to-server re-read (`GET /payments/{id}`) authenticated with your merchant RSA private key. The `payment_id` is read from the query string and strictly sanitized to prevent traversal, while all other parameters from the query string are ignored.
3. **Idempotency**: Because both the redirect callback and the webhook notification may arrive for the same order, ensure your fulfillment handler is idempotent.

---

## Payment Flows

| Flow       | Providers        | Description                                              |
|------------|------------------|----------------------------------------------------------|
| `redirect` | PayPal, Nexi     | User is redirected to provider, returns with query params|
| `webhook`  | Satispay, Nexi   | Provider calls a webhook URL for async confirmation      |
| `direct`   | *(future)*       | Synchronous processing (card tokenization, etc.)         |

---

## Events

```typescript
checkout.events
  .on('payment.created',   ({ provider, paymentId, orderId, verified, raw }) => { /* ... */ })
  .on('payment.completed', ({ provider, paymentId, orderId, verified, raw }) => { /* ... */ })
  .on('payment.failed',    ({ provider, error, orderId, verified, raw })     => { /* ... */ })
  .on('payment.refunded',  ({ provider, paymentId, orderId, verified, raw }) => { /* ... */ })
  .on('webhook.received',  ({ provider, paymentId, orderId, status, error, verified, data, raw }) => { /* ... */ });

// Recurring payments (mandates): data.mandateRef on every event, never the providerMandateId
checkout.events
  .on('mandate.setup_started',  ({ provider, orderId, data }) => { /* verified: false */ })
  .on('mandate.created',        ({ provider, orderId, data }) => { /* terminal, verified */ })
  .on('mandate.setup_failed',   ({ provider, orderId, error, data }) => { /* terminal, verified */ })
  .on('mandate.revoked',        ({ provider, data }) => { /* data.revokedAtProvider */ })
  .on('charge.succeeded',       ({ paymentId, orderId /* = chargeRef */, verified, data }) => { /* data.providerState: refunded or partly captured since */ })
  .on('charge.failed',          ({ orderId, error, data }) => { /* data.mandateUnusable, data.providerCode */ })
  .on('charge.unknown',         ({ orderId, error, data }) => { /* data.errorCode 'AMOUNT_MISMATCH': never retry, review. Otherwise chargeMandate: retry with the same chargeRef; first charge: re-confirm */ })
  .on('charge.requires_action', ({ orderId }) => { /* ... */ });
// Mandate and charge events can repeat for the same orderId (= chargeRef): dedupe on event name + orderId
```

An error thrown by a listener is wrapped in a `CheckoutListenerError` (exported): its `message` is the original message (or `String(value)` for non-Error values), `cause` is the original value, untouched (frozen errors are fine), and `event` is the event name. It propagates to the caller, and the Express adapter answers `500` with a generic body (the message only with `exposeErrorMessages: true`) and passes the error to `onError`. The exception is the mandate events emitted after a provider call (`mandate.created`, `mandate.setup_failed`, `mandate.revoked`, `charge.*`): there the error goes to the `onListenerError` config hook (or `console.error`) and the method still returns its result, see [Recurring payments](#recurring-payments-mandates).

Currencies are validated against the ISO 4217 list of active alpha-3 codes (`ISO_4217_ALPHA3_CODES`, plus the mapped Nexi numeric codes such as `978`); shape-only codes like `'XYZ'` or `'ABC'` and non-monetary codes (`XXX`, `XTS`, precious metals) are rejected.

### Understanding `verified` vs `error` in Results and Events

`verified` has one meaning everywhere (`PaymentResult`, `WebhookResult` and every event payload):

> **`verified: true` means the outcome was authenticated**, either by a provider signature/MAC checked by the library (Nexi 7-field outcome MAC, Satispay HTTP Signature) or by an authenticated server-to-server read from the provider API (PayPal capture/order read with OAuth credentials, Satispay `GET /payments/{id}` signed with the merchant key). Anything else is `verified: false`.

- `success` and `verified` are independent: a genuine cancellation or failed payment (user canceled, card declined) is `verified: true, success: false` with `error: 'Payment is CANCELED'` or `error: 'Payment failed with outcome KO'`. This holds for webhooks, redirects and `executePayment` alike (e.g. a Nexi redirect or execute with `esito=KO` and a valid MAC emits `payment.failed` with `verified: true`).
- On a callback, redirect or execute outcome with `verified: false` (missing/tampered MAC or signature, failed API read, provider that does not assert `verified: true`), the result and the event carry **no `paymentId` and no `orderId`**, and `success` is always `false` (error e.g. `'MAC verification failed'`, `'Webhook signature verification failed'`, `'Payment outcome could not be verified'`).
- `orderId` is never taken from the query string of a redirect or callback, nor from unsigned body fields, for any provider and under any registration name. It comes from the local `paymentId → orderId` map filled by `createPayment` (keyed on the provider-authenticated `paymentId`), or from the provider's authenticated outcome (Nexi MAC-covered `codTrans`, Satispay API `external_code` / transaction store).
- `executePayment(provider, paymentId, data)` is keyed on the `paymentId` authenticated by the provider (for Nexi the MAC-covered `codTrans`), never on the argument. If a non-empty `paymentId` argument differs from the authenticated one, the call fails with `success: false, verified: false, error: 'Payment id does not match the outcome'` and emits `payment.failed` (never `payment.completed`).

| Event | `verified` |
|-------|------------|
| `payment.created` (and `payment.failed` from `createPayment`) | always `false`: creation reports no payment outcome. `paymentId`/`orderId` are the ones you just created. |
| `payment.completed` / `payment.failed` from `handleRedirect` / `executePayment` | `true` only for a MAC-verified (Nexi) or API-read (PayPal, Satispay) outcome, whatever its `success` |
| `webhook.received` | `true` only for a MAC/signature-verified notification or an authenticated API re-read |
| `payment.refunded` | `true` when the refund outcome comes from an authenticated provider API response: PayPal, for any refund it returned, `COMPLETED` or not (a `PENDING` one may still complete; a refusal has no `verified`); Satispay, since 2.2.0, only an `ACCEPTED` refund or a 4xx refusal, never an unknown outcome. `false` for Nexi, whose refund response carries no MAC checked by the library. See [Refunds](#refunds) |

Custom providers must set `verified: true` on the outcomes they have authenticated; an outcome without it is treated as unverified.

#### Satispay `verified` Semantics
- **With `webhookPublicKey` configured**: Inbound POST webhooks must carry a valid HTTP Signature matching Satispay's RSA public key, correct SHA-256 body digest, and fresh `Date` header. `verified: true` guarantees cryptographic authenticity.
- **Without `webhookPublicKey`**: Cryptographic signature checking of the incoming HTTP request is skipped. However, `verified: true` indicates that the payment details were verified directly against Satispay's API via an authenticated server-to-server GET request (`/payments/{id}`) signed with the merchant's RSA private key.


---

## Custom Transaction Store

By default, `SatispayProvider` uses an in-memory store to correlate webhooks with orders.  
For multi-instance deployments, implement `ITransactionStore`:

```typescript
import { ITransactionStore, TransactionData } from 'awesome-node-checkout';

class RedisTransactionStore implements ITransactionStore {
  async save(key: string, data: TransactionData): Promise<void> { /* ... */ }
  async get(key: string): Promise<TransactionData | null> { /* ... */ }
  async delete(key: string): Promise<void> { /* ... */ }
}

new SatispayProvider({
  keyId: '...',
  privateKey: '...',
  transactionStore: new RedisTransactionStore(),
});
```

---

## Custom Provider

Extend `BasePaymentProvider` to add any payment provider:

```typescript
import { BasePaymentProvider, PaymentRequest, PaymentResult } from 'awesome-node-checkout';

export class StripeProvider extends BasePaymentProvider {
  readonly name = 'stripe';
  readonly flow = 'redirect' as const;

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    // ... call Stripe API
  }
  // ... implement other methods

  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    // ... handle Stripe redirect: re-read the session from the Stripe API and
    // return { success, verified: true, paymentId, orderId, amount, currency }
    // only for an authenticated outcome (see "Understanding `verified`")
  }
}

checkout.registerProvider(new StripeProvider({ secretKey: '...' }));
```

**Refund idempotency** (since 2.2.0). `refundPayment(paymentId, amount?, options?)` has an optional third parameter, `RefundOptions`. A provider written for 2.1 keeps its two-parameter `refundPayment` and keeps compiling: it never receives a key, because the configurator refuses one (`REFUND_IDEMPOTENCY_NOT_SUPPORTED`) unless the provider declares `readonly supportsRefundIdempotency = true`. Declare it only when `refundPayment` sends `options.idempotencyKey` to the provider's API, so that a retry with the same key never refunds twice.

- **Caveat: a 2.1 `refundPayment` with a third parameter of its own.** A provider whose `refundPayment` already declared a third parameter of another type, for example `reason?: 'duplicate' | 'fraudulent'`, no longer compiles against 2.2: TS2416 for a `BasePaymentProvider` subclass or a class that implements `IPaymentProvider`, TS2322 for an object typed `IPaymentProvider`. Widen that parameter to accept `RefundOptions` too (`reason?: 'duplicate' | 'fraudulent' | RefundOptions`): it compiles again, and its own callers are unchanged. At runtime nothing changes for it: without `supportsRefundIdempotency`, the configurator always calls it with `(paymentId, amount)`.

To support [recurring payments](#recurring-payments-mandates), also implement `IMandateProvider` (`createMandate`, `confirmMandate`, `chargeMandate`, `getMandate`, `revokeMandate`): `isMandateProvider` detects the five methods, and the configurator validates inputs and normalizes outcomes as described there. Append `mandate_ref` to the setup URLs with `appendMandateRef(url, mandateRef)`. `confirmMandate(pending, {})`, with no callback input, must be safe to call again at any time, including after a terminal outcome: re-read the setup server-to-server or replay your own idempotency keys, never start a second first charge, and return an unverified, non-terminal outcome when you cannot re-read. Apps rely on it to [resolve an unknown first charge](#resolving-an-unknown-first-charge).

To support [charge lookups](#looking-up-a-charge) (since 2.2.0), also implement the optional `IChargeLookupProvider`: `getCharge(chargeRef, options?)` returning a `ChargeLookupResult`. `isChargeLookupProvider` detects the method (`checkout.supportsChargeLookup(provider)`), and `IPaymentProvider` and `IMandateProvider` are unchanged, so existing providers keep compiling. `getCharge` is read-only and never throws for provider errors: it returns `unknown`. Answer `absent` only for an authenticated "no transaction for this chargeRef" (a failed lookup is `unknown`), set `verified: true` only on authenticated answers, and never put other customers' data or an SDK error (it carries the request headers) in `raw`. The configurator validates the inputs and normalizes the result fail closed.

---

## Built-in Providers

| Provider  | Flow                | Notes                                                                                       |
|-----------|---------------------|---------------------------------------------------------------------------------------------|
| PayPal    | redirect            | Orders API v2 (`return=representation`, captures expose `amount` and `currency`)            |
| Nexi      | redirect + webhook  | eCommerce DispatcherServlet + MAC SHA-1 (mandatory 7-field outcome MAC, `urlpost`, BackOffice `situazioneOrdine` API) |
| Satispay  | webhook             | Business API v1, RSA-SHA256 HTTP signature, GET and POST callbacks, configurable `callbackPath` |

---

## License

MIT
