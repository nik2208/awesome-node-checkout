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

// Use directly — no HTTP framework needed
const result = await checkout.createPayment('paypal', {
  amount: 49.99,
  currency: 'EUR',
  description: 'Order #1234',
  returnUrl: 'https://myapp.com/payment/success',
  cancelUrl: 'https://myapp.com/payment/cancel',
  orderId: 'ORD-1234',
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
    // Recommended: verify order and compute amount on the server
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
    // Optional: gate or disable public access to GET /:provider/:id
    details: {
      enabled: false, // or provide middleware: [requireAuth]
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
  }),
);

app.listen(3000);
```

> **Security Note**: Never trust client-sent amounts directly. Always define `buildPaymentRequest` so the payment amount and order parameters are derived server-side. If `buildPaymentRequest` is omitted, the router will issue a warning at mount time and validate that client bodies contain positive finite amounts and valid currencies.

### With Fastify (or any other framework)

Use the `CheckoutConfigurator` methods directly in your own routes:

```typescript
fastify.post('/checkout/:provider', async (req, reply) => {
  const result = await checkout.createPayment(req.params.provider, req.body);
  reply.status(result.success ? 201 : 400).send(result);
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
| POST        | `/:provider`                | Create a payment (server-built or validated)                  |
| POST        | `/:provider/execute`        | Execute/capture a payment (supports `onBeforeExecute`)         |
| GET         | `/:provider/redirect`       | Handle provider redirect callback (supports 302 via `redirect`)|
| GET         | `/:provider/:id`            | Get payment details (*configurable*: can disable or protect via `details`)|
| POST        | `/:provider/refund`         | Refund a payment (*opt-in*: mounted only when `refund` option is set)|
| GET / POST  | `/:provider/webhook`        | Handle provider webhook (POST for Nexi/Satispay, GET for Satispay)|

---

## Security: A Redirect Is Not Proof of Payment

Relying solely on front-end browser redirects (`GET /:provider/redirect`) to fulfill orders introduces significant risk:
- **Drop-off**: Shoppers may close the tab, lose connectivity, or navigate away before reaching your redirect URL.
- **Tampering**: Unless protected by cryptographic signatures (such as Nexi's mandatory outcome MAC), client-controlled URL parameters can be manipulated.
- **Amount Mismatch**: Always verify that the captured payment amount matches your order ledger before fulfilling goods or services. In `awesome-node-checkout`, `success: true` strictly requires that a payment is confirmed with a valid amount.

To ensure safe fulfillment:
1. **Verify Amount & Currency**: `PaymentResult` and `WebhookResult` return `amount` and `currency` extracted directly from the provider. Compare amounts in minor units (cents) or with rounding to prevent floating-point discrepancies:
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
```

An error thrown by a listener propagates to the caller wrapped in a `CheckoutListenerError` (exported): its `message` is the original message (or `String(value)` for non-Error values), `cause` is the original value, untouched (frozen errors are fine), and `event` is the event name. The Express adapter answers `500` with that message.

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
