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
    environment: 'sandbox',
    serverUrl: 'https://myapp.com',
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
app.use(express.json());

// Mount checkout routes with secure server-side request builder
app.use(
  '/checkout',
  createCheckoutRouter(checkout, {
    // Recommended: verify order and compute amount on the server
    buildPaymentRequest: async (req) => {
      const order = await myOrderService.getOrder(req.body.orderId);
      return {
        amount: order.totalAmount,
        currency: order.currency, // e.g. 'EUR'
        orderId: order.id,
        returnUrl: 'https://myapp.com/payment/success',
        cancelUrl: 'https://myapp.com/payment/cancel',
        description: `Order #${order.id}`,
      };
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

fastify.post('/checkout/:provider/webhook', async (req, reply) => {
  const result = await checkout.handleWebhook(req.params.provider, req.body, req.headers);
  reply.send(result);
});
```

---

## Example Application

A full-featured reference implementation using Express 5, SQLite (`ITransactionStore`), and Handlebars is available in [examples/express](./examples/express).

---

## Routes (Express adapter)

| Method | Path                        | Description                                                    |
|--------|-----------------------------|----------------------------------------------------------------|
| POST   | `/:provider`                | Create a payment (server-built or validated)                  |
| POST   | `/:provider/execute`        | Execute/capture a payment (supports `onBeforeExecute`)         |
| GET    | `/:provider/redirect`       | Handle provider redirect callback                             |
| GET    | `/:provider/:id`            | Get payment details                                            |
| POST   | `/:provider/refund`         | Refund a payment (*opt-in*: mounted only when `refund` option is set)|
| POST   | `/:provider/webhook`        | Handle provider webhook                                        |

---

## Payment Flows

| Flow       | Providers        | Description                                              |
|------------|------------------|----------------------------------------------------------|
| `redirect` | PayPal, Nexi     | User is redirected to provider, returns with query params|
| `webhook`  | Satispay         | Provider calls a webhook URL after async confirmation    |
| `direct`   | *(future)*       | Synchronous processing (card tokenization, etc.)         |

---

## Events

```typescript
checkout.events
  .on('payment.created',   ({ provider, paymentId }) => { /* ... */ })
  .on('payment.completed', ({ provider, paymentId }) => { /* ... */ })
  .on('payment.failed',    ({ provider, error })     => { /* ... */ })
  .on('payment.refunded',  ({ provider, paymentId }) => { /* ... */ })
  .on('webhook.received',  ({ provider, data })      => { /* ... */ });
```

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
    // ... handle Stripe redirect
  }
}

checkout.registerProvider(new StripeProvider({ secretKey: '...' }));
```

---

## Built-in Providers

| Provider  | Flow      | Notes                                      |
|-----------|-----------|--------------------------------------------|
| PayPal    | redirect  | Orders API v2                              |
| Nexi      | redirect  | eCommerce DispatcherServlet + MAC SHA-1    |
| Satispay  | webhook   | Business API v1, RSA-SHA256 signature      |

---

## License

MIT
