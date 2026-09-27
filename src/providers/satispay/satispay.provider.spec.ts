import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { SatispayProvider } from './satispay.provider';
import { PaymentRequest } from '../../models/payment-request.model';
import { ITransactionStore } from '../../interfaces/transaction-store.interface';
import * as crypto from 'crypto';

// Mock InMemoryStore
class MockTransactionStore implements ITransactionStore {
    private store = new Map();
    async save(id: string, data: any) { this.store.set(id, data); }
    async get(id: string) { return this.store.get(id); }
    async delete(id: string) { this.store.delete(id); }
}

describe('SatispayProvider', () => {
    let provider: SatispayProvider;
    let store: MockTransactionStore;
    let validFakePrivateKey: string;
    let validFakePublicKey: string;

    beforeAll(() => {
        // Generate a fast valid RSA key pair
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        } as any);
        validFakePrivateKey = privateKey as string;
        validFakePublicKey = publicKey as string;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        store = new MockTransactionStore();
        provider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            environment: 'sandbox',
            serverUrl: 'http://localhost',
            transactionStore: store,
        });

        // Mock global fetch
        global.fetch = vi.fn();
    });

    it('should successfully create a payment and format callback_url with default path and encoded orderId', async () => {
        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-123',
                status: 'PENDING',
                redirect_url: 'https://satispay.com/pay/SAT-123'
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const req: PaymentRequest = {
            amount: 15.00,
            currency: 'EUR',
            returnUrl: 'http://loc/ret',
            cancelUrl: 'http://loc/can',
            orderId: 'ORD-1'
        };

        const result = await provider.createPayment(req);

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-123');
        expect(result.approvalUrl).toBe('https://satispay.com/pay/SAT-123');
        
        // Assert transaction was saved
        const saved = await store.get('ORD-1');
        expect(saved.paymentId).toBe('SAT-123');

        // Check fetch body sent callback_url
        const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
        const sentBody = JSON.parse(options.body as string);
        expect(sentBody.callback_url).toBe('http://localhost/checkout/satispay/webhook?order_id=ORD-1&payment_id={uuid}');
    });

    it('should use custom callbackPath in createPayment when configured', async () => {
        const customProvider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            environment: 'sandbox',
            serverUrl: 'http://localhost',
            callbackPath: '/api/pay/satispay/webhook',
            transactionStore: store,
        });

        (global.fetch as any).mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({ id: 'SAT-CUSTOM', status: 'PENDING' })),
        });

        await customProvider.createPayment({
            amount: 10,
            currency: 'EUR',
            orderId: 'ORD-SPECIAL/1',
            returnUrl: '',
            cancelUrl: '',
        });

        const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
        const sentBody = JSON.parse(options.body as string);
        expect(sentBody.callback_url).toBe('http://localhost/api/pay/satispay/webhook?order_id=ORD-SPECIAL%2F1&payment_id={uuid}');
    });

    it('should handle fetch errors gracefully', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network error'));

        const result = await provider.createPayment({ amount: 10, currency: 'EUR', returnUrl: 'http://loc/ret', cancelUrl: 'http://loc/can' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error');
    });

    it('should execute/get payment details with amount and currency', async () => {
        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-123',
                status: 'ACCEPTED',
                amount_unit: 1999,
                currency: 'EUR',
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.executePayment('SAT-123');

        expect(result.success).toBe(true);
        expect(result.status).toBe('ACCEPTED');
        expect(result.amount).toBe(19.99);
        expect(result.currency).toBe('EUR');
    });

    it('should leave amount undefined when amount_unit is missing', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-NO-AMOUNT',
                status: 'ACCEPTED',
            }))
        });

        const result = await provider.getPaymentDetails('SAT-NO-AMOUNT');
        expect(result.success).toBe(true);
        expect(result.amount).toBeUndefined();
    });

    it('should handle incoming webhook with payment_id in query and undefined body', async () => {
        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-123',
                status: 'ACCEPTED',
                amount_unit: 1999,
                currency: 'EUR',
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.handleWebhook(undefined, {}, { payment_id: 'SAT-123' });

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-123');
        expect(result.status).toBe('ACCEPTED');
        expect(result.amount).toBe(19.99);
        expect(result.currency).toBe('EUR');

        const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://staging.authservices.satispay.com/g_business/v1/payments/SAT-123');
        expect(options).toMatchObject({ method: 'GET' });
    });

    it('should reject webhook without Authorization when webhookPublicKey is configured', async () => {
        const secureProvider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            webhookPublicKey: validFakePublicKey,
            serverUrl: 'http://localhost',
        });

        const result = await secureProvider.handleWebhook(undefined, {}, { payment_id: 'SAT-123' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('Webhook signature verification failed');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return missing payment_id error when webhook body and query have no payment id', async () => {
        const result = await provider.handleWebhook(undefined, {});

        expect(result.success).toBe(false);
        expect(result.error).toBe('Missing payment_id in webhook body or query');
    });

    it('should handle redirects correctly fetching from store and forwarding amount/currency', async () => {
        await store.save('ORD-2', { paymentId: 'SAT-456' });

        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-456',
                status: 'ACCEPTED',
                amount_unit: 1999,
                currency: 'EUR',
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.handleRedirect({ order_id: 'ORD-2' });

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-456');
        expect(result.amount).toBe(19.99);
        expect(result.currency).toBe('EUR');

        // Check if transaction was deleted upon successful resolution
        const saved = await store.get('ORD-2');
        expect(saved).toBeUndefined();
    });

    it('should return error on redirect if order is not in store', async () => {
        const result = await provider.handleRedirect({ order_id: 'UNKNOWN' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Transaction not found');
    });

    // -------------------------------------------------------------------------
    // HTTP Signatures tests (Issue #11)
    // -------------------------------------------------------------------------
    describe('HTTP Signatures verification (Issue #11)', () => {
        it('verifies signatures over (request-target) host date digest and rejects wrong path or key', () => {
            const secureProvider = new SatispayProvider({
                keyId: 'test-key',
                privateKey: validFakePrivateKey,
                webhookPublicKey: validFakePublicKey,
            });

            const headers: Record<string, string> = {
                host: 'example.test',
                date: new Date().toUTCString(),
                digest: 'SHA-256=abc',
            };

            const sign = (list: string[], method = 'post', path = '/checkout/satispay/webhook', privKey = validFakePrivateKey) => {
                const s = crypto.createSign('RSA-SHA256');
                const msg = list.map(h => h === '(request-target)' ? `(request-target): ${method} ${path}` : `${h}: ${headers[h]}`).join('\n');
                s.update(msg);
                return s.sign(privKey, 'base64');
            };

            // Valid signature with (request-target)
            const sigWithTarget = sign(['(request-target)', 'host', 'date', 'digest'], 'post', '/checkout/satispay/webhook');
            const validAuthHeader = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sigWithTarget}"`;

            // Should verify with matching context
            const ok = secureProvider.verifyWebhookSignature({}, { ...headers, authorization: validAuthHeader }, { method: 'POST', path: '/checkout/satispay/webhook' });
            expect(ok).toBe(true);

            // Same signature with different method or path should be rejected
            const badMethod = secureProvider.verifyWebhookSignature({}, { ...headers, authorization: validAuthHeader }, { method: 'GET', path: '/checkout/satispay/webhook' });
            expect(badMethod).toBe(false);

            const badPath = secureProvider.verifyWebhookSignature({}, { ...headers, authorization: validAuthHeader }, { method: 'POST', path: '/other/path' });
            expect(badPath).toBe(false);

            // Signature over host date digest (no request-target) still verifies without context
            const sigNoTarget = sign(['host', 'date', 'digest']);
            const authNoTarget = `Signature keyId="test-key",algorithm="rsa-sha256",headers="host date digest",signature="${sigNoTarget}"`;
            const okNoTarget = secureProvider.verifyWebhookSignature({}, { ...headers, authorization: authNoTarget });
            expect(okNoTarget).toBe(true);

            // Wrong RSA key is rejected
            const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            } as any);
            const wrongSig = sign(['host', 'date', 'digest'], 'post', '', wrongPrivateKey as string);
            const authWrongKey = `Signature keyId="test-key",algorithm="rsa-sha256",headers="host date digest",signature="${wrongSig}"`;
            const rejectedWrongKey = secureProvider.verifyWebhookSignature({}, { ...headers, authorization: authWrongKey });
            expect(rejectedWrongKey).toBe(false);
        });
    });
});
