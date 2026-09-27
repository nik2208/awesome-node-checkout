import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { CheckoutConfigurator, CheckoutError, PayPalProvider, NexiProvider, SatispayProvider } from 'awesome-node-checkout';
import { createCheckoutRouter } from 'awesome-node-checkout/express';
import { SqliteTransactionStore } from './sqlite-store';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');
const hbs = require('hbs');
hbs.registerPartials(path.join(__dirname, 'views', 'layouts'));
hbs.registerHelper('eq', function (a: any, b: any) {
  return a === b;
});

// Setup static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Satispay private key configuration (from env or local PEM file)
const satispayPrivateKey =
  process.env.SATISPAY_PRIVATE_KEY ||
  (fs.existsSync(path.join(__dirname, 'private.pem'))
    ? fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8')
    : 'mockKey');

// Configure Checkout library
const checkout = new CheckoutConfigurator();
const sqliteStore = new SqliteTransactionStore(path.join(process.cwd(), 'database.sqlite'));

checkout
  .registerProvider(new PayPalProvider({
    clientId: process.env.PAYPAL_CLIENT_ID || 'Af6Z0rKqW0G0j3S1t07m9Mh8s1z7G7J0jPj1Y7K3r8jP0O5',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || 'EH2N-G4Xn5H7b9P2g4D4H8K5j2n1T0e7p6B5a9S1v2K9E0n',
    environment: (process.env.PAYPAL_ENVIRONMENT as 'sandbox' | 'live') || 'sandbox',
  }))
  .registerProvider(new NexiProvider({
    merchantId: process.env.NEXI_MERCHANT_ID || 'ALIAS_WEB_00069046',
    macKey: process.env.NEXI_MAC_KEY || 'NEXI_MAC_KEY',
    environment: (process.env.NEXI_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox',
  }))
  .registerProvider(new SatispayProvider({
    keyId: process.env.SATISPAY_KEY_ID || 'SATISPAY_KEY_ID',
    privateKey: satispayPrivateKey,
    environment: (process.env.SATISPAY_ENVIRONMENT as 'sandbox' | 'production') || 'sandbox',
    serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`,
    transactionStore: sqliteStore,
    webhookPublicKey: process.env.SATISPAY_WEBHOOK_PUBLIC_KEY || undefined,
  }));

const getBaseTemplateData = () => {
    return {
        apiKeyHeader: process.env.API_KEY_HEADER || 'X-API-Key',
        apiKey: process.env.API_KEYS?.split(',')[0] || 'test-key-1'
    };
};

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// --- Satispay Webhook Callback --- //
// Delegates to the library's handleWebhook which verifies the HTTP Signature
// when webhookPublicKey is configured in SatispayProvider.
const handleSatispayWebhook = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
  res: express.Response,
) => {
  try {
    const result = await checkout.handleWebhook('satispay', body, headers);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    if (err instanceof CheckoutError) {
      const statusMap: Record<string, number> = {
        PROVIDER_NOT_FOUND: 404,
        WEBHOOK_NOT_SUPPORTED: 422,
      };
      const { code, message } = err;
      res.status(statusMap[code] ?? 500).json({ success: false, error: message, code });
    } else {
      const message = err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ success: false, error: message });
    }
  }
};

// Satispay calls callback_url via POST with JSON body + HTTP Signature
app.post('/checkout/satispay/webhook', async (req, res) => {
  await handleSatispayWebhook(req.body, req.headers as Record<string, string>, res);
});

// Also handle GET callbacks (browser redirect from Satispay app)
app.get('/checkout/satispay/webhook', async (req, res) => {
  await handleSatispayWebhook(req.query as Record<string, unknown>, req.headers as Record<string, string>, res);
});


// --- Web Routes --- //

app.get('/', (req, res) => {
    const providers = ['paypal', 'satispay', 'nexi'];

    const testCredentials = {
        personal: {
            accountId: 'HFJNV6UGFUF6W',
            email: 'sb-pjqtv38394077@personal.example.com',
            password: 'VAQ7!eon'
        },
        business: {
            accountId: '7BBAYJTZW8F38',
            email: 'sb-dbuth38393939@business.example.com',
            password: 'O-=ab_N8'
        }
    };

    res.render('payment-form', {
        ...getBaseTemplateData(),
        title: 'Test Payment Gateway (Express)',
        providers,
        testCredentials,
        testPayment: {
            amount: 10.00,
            currency: 'EUR',
            description: 'Test payment',
            returnUrl: `${SERVER_URL}/success?provider=__provider__`,
            cancelUrl: `${SERVER_URL}/cancel?provider=__provider__`,
            orderId: 'ORD-' + Date.now(),
            metadata: {
                customerId: testCredentials.personal.accountId,
                source: 'web'
            }
        }
    });
});

app.get('/success', async (req, res) => {
    console.log('Payment callback received:', req.query);

    try {
        const provider = req.query.provider as string;
        if (!provider) {
            throw new Error('Provider not specified in query parameters');
        }

        // Delegate to the library's handleRedirect which:
        // - PayPal: captures the payment via token
        // - Nexi: verifies the MAC in the POST-back response
        // - Satispay: looks up the transaction in the store and verifies status
        const result = await checkout.handleRedirect(provider, req.query as Record<string, string>);

        res.render('payment-result', {
            ...getBaseTemplateData(),
            title: result.success ? 'Payment Successful' : 'Payment Failed',
            status: result.success ? 'success' : 'error',
            message: result.success
              ? 'Your payment has been processed successfully!'
              : (result.error || 'There was an error processing your payment'),
            paymentDetails: {
                provider,
                paymentId: result.paymentId || '',
                status: result.status || 'UNKNOWN',
                transactionDetails: req.query
            }
        });
    } catch (error: unknown) {
        console.error('Payment execution error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.render('payment-result', {
            ...getBaseTemplateData(),
            title: 'Payment Failed',
            status: 'error',
            message: 'There was an error processing your payment: ' + message
        });
    }
});

app.get('/cancel', (req, res) => {
    res.render('payment-result', {
        ...getBaseTemplateData(),
        title: 'Payment Cancelled',
        status: 'cancelled',
        message: 'The payment has been cancelled.'
    });
});

// --- API Routes (via Adapter) --- //
app.use(
  '/payments',
  createCheckoutRouter(checkout, {
    // Server-side PaymentRequest builder to ensure amounts and details are secure
    buildPaymentRequest: (req: express.Request) => {
      const { amount, currency, description, orderId, returnUrl, cancelUrl, metadata } = req.body;
      return {
        amount: Number(amount) || 10.0,
        currency: currency || 'EUR',
        description: description || 'Demo Payment',
        orderId: orderId || `ORD-${Date.now()}`,
        returnUrl: returnUrl || `${SERVER_URL}/success?provider=__provider__`,
        cancelUrl: cancelUrl || `${SERVER_URL}/cancel?provider=__provider__`,
        metadata,
      };
    },
    refund: {
      middleware: [], // Protect refund route with admin/auth middleware in production
    },
  }),
);

app.listen(PORT, () => {
  console.log(`Test Express Server listening on ${SERVER_URL}`);
});
