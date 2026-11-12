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
| POST        | `/:provider/refund`         | Refund a payment (*opt-in*: mounted only when `refund` option is set)|
| GET / POST  | `/:provider/webhook`        | Handle provider webhook (POST for Nexi/Satispay, GET for Satispay)|
| POST        | `/:provider/mandate`        | Start a mandate setup (*opt-in*: mounted only when `mandates` is set; built by `buildMandateRequest`). See [Recurring payments](#recurring-payments-mandates)|
| GET         | `/:provider/mandate`        | `405` with `Allow: POST` (*opt-in*, with `mandates`): never falls through to the details route|
| GET / POST  | `/:provider/mandate/callback` | Confirm a mandate setup (*opt-in*, with `mandates`; always exempt from `middleware`)|

There is no route for mandate charges or revocations: call `chargeMandate` / `revokeMandate` from a server job.

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
| `confirmMandate(provider, pending, input)` | Unverified outcome → `success: false`, `terminal: false`, no `mandate`, a `succeeded` first charge becomes `unknown`. A verified outcome whose `firstCharge.chargeRef` or `mandate` does not match `pending` → unverified, non-terminal failure `'Mandate outcome does not match the pending setup'`. `terminal` is the provider's value AND `verified` (always `true` with `success: true`). Events **only for terminal outcomes**: `mandate.created` or `mandate.setup_failed`, then `charge.*` for the first charge. An unverified outcome's `firstCharge` carries no `providerPaymentId`, `amount` or `currency`. Re-callable with `{}` and the consumed `pending` to resolve an `unknown` first charge (see below). |
| `chargeMandate(provider, mandate, charge)` | Validates `chargeRef` and the amount. A `revoked` mandate returns `failed` with `mandateUnusable: true` without calling the provider. An unverified `succeeded` becomes `unknown` (never `failed`). A verified `succeeded` whose reported amount or currency differs from the request becomes `unknown` with `'Charged amount does not match the request'`. A provider that throws gives `unknown`, whose `raw` (and the `charge.unknown` event's) is only the error's `{ name, message }`, never the SDK request, headers or body. `chargeRef` is always the request's. Emits `charge.succeeded`, `charge.failed`, `charge.unknown` or `charge.requires_action`; a throwing listener never rejects it (see below). |
| `getMandate(provider, mandate)` | Re-reads usability from the provider: `{ status: 'active' \| 'revoked' \| 'unknown', verified }`. Call it before charging when in doubt. |
| `revokeMandate(provider, mandate)` | Calls the provider and emits `mandate.revoked` with `data: { mandateRef, revokedAtProvider }`. **Mark your own copy revoked whatever the provider answers.** |

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
      res.redirect(302, outcome.success ? '/account/billing?ok=1' : '/account/billing?error=1');
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
  if (!outcome.terminal || outcome.firstCharge.status === 'unknown') continue; // try again on the next run
  // The setup itself changed since (e.g. Satispay authorization canceled): says nothing about the money
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
- A re-confirm that is terminal emits its events again (`mandate.created` or `mandate.setup_failed`, then the first charge's `charge.*`): the first run emitted `charge.unknown`, the resolving one emits `charge.succeeded` or `charge.failed`, for the same `orderId`. Dedupe on the event name and `orderId`, not on `orderId` alone, or you drop the resolution.
- Re-confirm with the persisted `pending`, verbatim, as for the callback. `{}` carries no callback fields, so a provider can only answer from a server-to-server re-read or by replaying its own idempotency keys, never from query values.
- Per provider, as specified in #31 to #33:
  - **Nexi XPay** never reports a terminal outcome with an `unknown` first charge: the MAC-verified callback is either OK (`succeeded`) or KO (`failed`). A re-confirm with `{}` is unverified and non-terminal, and moves no money.
  - **PayPal** re-reads the order (`getOrder`) and maps its existing capture. A `COMPLETED` order is never captured again, so the job can keep re-confirming a `PENDING` capture for as long as PayPal takes to settle it.
  - **Satispay** re-reads the authorization and replays the first payment with the same `Idempotency-Key` (= `orderId`), which returns Satispay's original response. That key's retention is not documented, so re-confirm promptly (minutes to hours, not days), and reconcile manually in the Satispay dashboard (`external_code` = `orderId`) once the setup is older than that. If the customer cancelled the authorization in the meantime, the re-confirm reports `success: false` with a `failed` first charge ('Authorization canceled') without re-reading the first payment: that says nothing about the money, so reconcile it manually too (the job above does, because `success` changed).
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

  switch (result.status) {
    case 'succeeded':       // money taken: extend the period, issue the invoice
      await subscriptions.renew(sub, result.providerPaymentId);
      break;
    case 'unknown':         // do NOT count as a failure: retry with the SAME chargeRef next run
                            // (first charges of a setup are re-confirmed instead, see above)
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

Only `failed` counts towards dunning. Refund a mandate charge with the existing `refundPayment(provider, result.providerPaymentId, amount)`. To change the card, the customer creates a new mandate.

### Provider prerequisites

- **Nexi XPay:** MIT/recurring must be enabled on the terminal profile by Nexi support. Scheduled and unscheduled contracts are not interchangeable: state which one you need.
- **PayPal:** "Save payment methods" (reference transactions) must be approved on the account. Turn on the payment receiving preference "Block accidental payments" (one payment per invoice ID): with it, a replay after PayPal's 6-hour request-id window cannot charge twice.
- **Satispay:** pre-authorized payments (Automatic Payments) must be enabled for the shop.

Use `checkout.supportsMandates(provider)` to check whether a registered provider implements `IMandateProvider`.

### Nexi XPay

`NexiProvider` implements `IMandateProvider` with XPay contracts ("Specifiche tecniche di integrazione con il gateway di pagamento XPay" v20.4): the setup is a hosted-page first payment that registers the contract (`num_contratto` = your `mandateRef`, `tipo_servizio=paga_multi`, `tipo_richiesta=PP`, `codTrans` = `orderId`), renewals use `POST /ecomm/api/recurring/pagamentoRicorrente` (`codiceTransazione` = `chargeRef`), `getMandate` reads `dettagliContratto` and `revokeMandate` calls `cancellaContratto`.

```typescript
const nexi = new NexiProvider({
  merchantId: process.env.NEXI_ALIAS!,
  macKey: process.env.NEXI_MAC_KEY!,
  environment: 'production',
  contractType: 'S', // only if the terminal does both scheduled and unscheduled contracts
  timeoutMs: 30000,  // recurring and contract API calls (default 30000)
});
```

- **Terminal.** Recurring payments must be enabled on the terminal by XPay support, stating whether the contracts are **scheduled** or **unscheduled** (MIT): the two are not interchangeable. A merchant whose terminal does both sets `contractType: 'S'` or `'U'`, sent as `tipo_contratto` and included in the setup MAC.
- **Currency: EUR only.** `pagamentoRicorrente` accepts only `divisa=978`, so `createMandate` and `chargeMandate` with any other currency return a failure without calling Nexi.
- **Callback.** Nexi redirects the customer to `url` / `url_back` with the outcome in the query string, and sends the `urlpost` notification as a **form POST**: mount `express.urlencoded()` before the checkout router, or the notification body is empty and the outcome stays unverified. Both arrive at the callback route and are verified with the 7-field outcome MAC; the MAC-covered `codTrans`, `importo` and `divisa` must match the pending setup. The contract number is always the persisted `mandateRef`, never the query's `num_contratto`; an OK outcome must still echo `num_contratto` equal to it (without it, no contract may have been registered), and a `tipo_servizio` / `tipo_richiesta` other than `paga_multi` / `PP` is rejected; such outcomes are unverified and non-terminal. The validated card expiry (`scadenza_pan`) and masked PAN (`pan`) are copied to `mandate.unverified`; the unfiltered callback fields, these two included, remain in the outcome's `raw` and in the `raw` of the `mandate.created` / `mandate.setup_failed` events, so do not log or persist `raw` where card data must not appear. Only `KO`, `ANNULLO` and `ERRORE` are terminal refusals; any other `esito` (such as a pending one) is unverified and non-terminal, so the pending setup survives until the final outcome arrives. A Nexi first payment is never `unknown` on a terminal outcome.
- **Retries.** Before every charge the provider reads `situazioneOrdine` for the `chargeRef`: an already paid one is returned as `succeeded` without charging again, an existing unpaid one as `failed`, and a lookup that fails as `unknown` (nothing is charged). Retry an `unknown` charge with the same `chargeRef`. **A dunning retry after `failed` needs a new `chargeRef`**: Nexi would accept up to 2 retries of the same code after a KO, but the library does not use them. If several report entries share the `chargeRef`, any paid one makes it `succeeded`. Codes 8, 14 and 22 (invalid contract, card expired, card not chargeable) set `mandateUnusable`; credential, MAC and technical errors are `unknown`. An amount over 8 digits of cents (999999.99 EUR) is `failed` without calling Nexi.
- **12-month expiry (manual, p. 61).** Contracts unused for more than 12 months expire under card-scheme rules, so a **yearly** plan sits right at the limit. Nexi's remedy is a 1-cent recurring charge followed by a refund before the 12 months run out (`chargeMandate` with a 0.01 EUR charge, then `refundPayment('nexi', result.providerPaymentId, 0.01)`): your scheduler must plan for it.
- **Refunds.** `providerPaymentId` is the `codiceTransazione` (= `chargeRef`), so the existing `refundPayment` refunds a mandate charge.

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
  .on('charge.succeeded',       ({ paymentId, orderId /* = chargeRef */, verified, data }) => { /* ... */ })
  .on('charge.failed',          ({ orderId, error, data }) => { /* data.mandateUnusable, data.providerCode */ })
  .on('charge.unknown',         ({ orderId, error }) => { /* chargeMandate: retry with the same chargeRef; first charge: re-confirm */ })
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
| `payment.refunded` | `true` when the refund outcome comes from an authenticated provider API response (PayPal, Satispay); `false` for Nexi, whose refund response carries no MAC checked by the library |

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

To support [recurring payments](#recurring-payments-mandates), also implement `IMandateProvider` (`createMandate`, `confirmMandate`, `chargeMandate`, `getMandate`, `revokeMandate`): `isMandateProvider` detects the five methods, and the configurator validates inputs and normalizes outcomes as described there. Append `mandate_ref` to the setup URLs with `appendMandateRef(url, mandateRef)`. `confirmMandate(pending, {})`, with no callback input, must be safe to call again at any time, including after a terminal outcome: re-read the setup server-to-server or replay your own idempotency keys, never start a second first charge, and return an unverified, non-terminal outcome when you cannot re-read. Apps rely on it to [resolve an unknown first charge](#resolving-an-unknown-first-charge).

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
