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

    it('should leave amount undefined when amount_unit is missing and return success: false', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-NO-AMOUNT',
                status: 'ACCEPTED',
            }))
        });

        const result = await provider.getPaymentDetails('SAT-NO-AMOUNT');
        expect(result.success).toBe(false);
        expect(result.amount).toBeUndefined();
        expect(result.error).toContain('Payment amount is missing or invalid');
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

    it('should accept unsigned GET webhook callback as API re-read trigger even when webhookPublicKey is configured', async () => {
        const secureProvider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            webhookPublicKey: validFakePublicKey,
            serverUrl: 'http://localhost',
        });
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

        const result = await secureProvider.handleWebhook(
            undefined,
            {},
            { payment_id: 'SAT-123' },
            { method: 'GET', path: '/checkout/satispay/webhook?payment_id=SAT-123' },
        );

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-123');
        expect(result.amount).toBe(19.99);
        expect(result.currency).toBe('EUR');
        expect(global.fetch).toHaveBeenCalled();
    });

    it('should NOT leak provider response body in error message on API failure', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false,
            status: 404,
            text: vi.fn().mockResolvedValue(JSON.stringify({ secret: 'PROVIDER_SECRET_BODY' })),
        });

        const result = await provider.handleWebhook(undefined, {}, { payment_id: 'SAT-123' });

        expect(result.success).toBe(false);
        expect(result.error).not.toContain('PROVIDER_SECRET_BODY');
        expect(result.error).not.toContain('secret');
        expect(result.error).toContain('404');
    });

    it('should reject webhook without Authorization when webhookPublicKey is configured and method is not GET', async () => {
        const secureProvider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            webhookPublicKey: validFakePublicKey,
            serverUrl: 'http://localhost',
        });

        const result = await secureProvider.handleWebhook(
            { event: 'payment' },
            {},
            { payment_id: 'SAT-123' },
            { method: 'POST', path: '/checkout/satispay/webhook' },
        );

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
    describe('HTTP Signatures verification (Issues #11 and #16)', () => {
        it('verifies signatures over (request-target) host date digest with raw body and rejects tampered body, wrong path or expired date', () => {
            const secureProvider = new SatispayProvider({
                keyId: 'test-key',
                privateKey: validFakePrivateKey,
                webhookPublicKey: validFakePublicKey,
                signatureMaxAgeMs: 300_000,
            });

            const rawBody = JSON.stringify({ id: 'SAT-123' });
            const body = JSON.parse(rawBody);
            const validDigest = 'SHA-256=' + crypto.createHash('sha256').update(rawBody).digest('base64');

            const headers: Record<string, string> = {
                host: 'example.test',
                date: new Date().toUTCString(),
                digest: validDigest,
            };

            const sign = (list: string[], method = 'post', path = '/checkout/satispay/webhook', privKey = validFakePrivateKey, customHeaders = headers) => {
                const s = crypto.createSign('RSA-SHA256');
                const msg = list.map(h => h === '(request-target)' ? `(request-target): ${method} ${path}` : `${h}: ${customHeaders[h]}`).join('\n');
                s.update(msg);
                return s.sign(privKey, 'base64');
            };

            // Valid signature with (request-target) and matching rawBody
            const sigWithTarget = sign(['(request-target)', 'host', 'date', 'digest'], 'post', '/checkout/satispay/webhook');
            const validAuthHeader = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sigWithTarget}"`;

            // Should verify with matching context and rawBody
            const ok = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: validAuthHeader }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(ok).toBe(true);

            // 1. Same request with one byte of body changed should be rejected
            const tamperedRawBody = JSON.stringify({ id: 'SAT-124' });
            const tamperedBody = JSON.parse(tamperedRawBody);
            const rejectedTamperedBody = secureProvider.verifyWebhookSignature(tamperedBody, { ...headers, authorization: validAuthHeader }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody: tamperedRawBody });
            expect(rejectedTamperedBody).toBe(false);

            // 2. A Digest header that does not match the raw body should be rejected
            const badDigestHeaders = { ...headers, digest: 'SHA-256=invalid' };
            const sigBadDigest = sign(['(request-target)', 'host', 'date', 'digest'], 'post', '/checkout/satispay/webhook', validFakePrivateKey, badDigestHeaders);
            const authBadDigest = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sigBadDigest}"`;
            const rejectedBadDigest = secureProvider.verifyWebhookSignature(body, { ...badDigestHeaders, authorization: authBadDigest }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(rejectedBadDigest).toBe(false);

            // 3. Body containing signature/authorization is never read as headers (must be rejected if headers has no Signature)
            const fakeBodyWithHeaders = {
                authorization: validAuthHeader,
                host: 'example.test',
                date: new Date().toUTCString(),
                digest: validDigest,
            };
            const rejectedBodyAsHeaders = secureProvider.verifyWebhookSignature(fakeBodyWithHeaders, {}, { method: 'POST', path: '/checkout/satispay/webhook' });
            expect(rejectedBodyAsHeaders).toBe(false);

            // 4. Same signature with different method or path should be rejected
            const badMethod = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: validAuthHeader }, { method: 'GET', path: '/checkout/satispay/webhook', rawBody });
            expect(badMethod).toBe(false);

            const badPath = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: validAuthHeader }, { method: 'POST', path: '/other/path', rawBody });
            expect(badPath).toBe(false);

            // 5. Expired Date header outside window is rejected
            const oldDate = new Date(Date.now() - 600_000).toUTCString(); // 10 minutes ago
            const expiredHeaders = { ...headers, date: oldDate };
            const sigExpired = sign(['(request-target)', 'host', 'date', 'digest'], 'post', '/checkout/satispay/webhook', validFakePrivateKey, expiredHeaders);
            const authExpired = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sigExpired}"`;
            const rejectedExpired = secureProvider.verifyWebhookSignature(body, { ...expiredHeaders, authorization: authExpired }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(rejectedExpired).toBe(false);

            // 6. Signature lacking (request-target) is rejected
            const sigNoTarget = sign(['host', 'date', 'digest']);
            const authNoTarget = `Signature keyId="test-key",algorithm="rsa-sha256",headers="host date digest",signature="${sigNoTarget}"`;
            const okNoTarget = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: authNoTarget }, { rawBody });
            expect(okNoTarget).toBe(false);

            // 7. Signature lacking date is rejected
            const sigNoDate = sign(['(request-target)', 'host', 'digest'], 'post', '/checkout/satispay/webhook');
            const authNoDate = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host digest",signature="${sigNoDate}"`;
            const okNoDate = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: authNoDate }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(okNoDate).toBe(false);

            // 8. Request lacking Date HTTP header is rejected
            const headersNoDate = { ...headers };
            delete (headersNoDate as any).date;
            delete (headersNoDate as any).Date;
            const okMissingDateHeader = secureProvider.verifyWebhookSignature(body, { ...headersNoDate, authorization: validAuthHeader }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(okMissingDateHeader).toBe(false);

            // 9. Request with body where signed headers lack digest is rejected
            const sigNoDigest = sign(['(request-target)', 'host', 'date'], 'post', '/checkout/satispay/webhook');
            const authNoDigest = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="${sigNoDigest}"`;
            const okNoDigest = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: authNoDigest }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(okNoDigest).toBe(false);

            // 10. Wrong RSA key is rejected
            const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            } as any);
            const wrongSig = sign(['(request-target)', 'host', 'date', 'digest'], 'post', '/checkout/satispay/webhook', wrongPrivateKey as string);
            const authWrongKey = `Signature keyId="test-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${wrongSig}"`;
            const rejectedWrongKey = secureProvider.verifyWebhookSignature(body, { ...headers, authorization: authWrongKey }, { method: 'POST', path: '/checkout/satispay/webhook', rawBody });
            expect(rejectedWrongKey).toBe(false);
        });

        it('rejects path traversal and invalid payment_id formats', async () => {
            const result = await provider.getPaymentDetails('../../v1/consumers/k');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid payment ID format');

            const webhookResult = await provider.handleWebhook(undefined, {}, { payment_id: '../malicious/path' });
            expect(webhookResult.success).toBe(false);
            expect(webhookResult.error).toContain('Invalid payment ID format');

            const refundResult = await provider.refundPayment('path/traversal');
            expect(refundResult.success).toBe(false);
            expect(refundResult.error).toContain('Invalid payment ID format');
        });

        describe('Issue #21 residuals', () => {
            it('should return Invalid provider response on non-JSON 200 without leaking response text', async () => {
                (global.fetch as any).mockResolvedValue({
                    ok: true,
                    status: 200,
                    text: vi.fn().mockResolvedValue('<html><head><title>502 Bad Gateway</title></head><body>upstream error body</body></html>'),
                });

                const result = await provider.getPaymentDetails('SAT-123');
                expect(result.success).toBe(false);
                expect(result.error).toBe('Invalid provider response');
                expect(result.error).not.toContain('upstream error body');
                expect(result.error).not.toContain('<html>');
            });

            it('should treat HEAD webhook like GET without requiring signature and only read payment_id from query', async () => {
                const secureProvider = new SatispayProvider({
                    keyId: 'test-key',
                    privateKey: validFakePrivateKey,
                    webhookPublicKey: validFakePublicKey,
                    serverUrl: 'http://localhost',
                });

                (global.fetch as any).mockResolvedValue({
                    ok: true,
                    text: vi.fn().mockResolvedValue(JSON.stringify({
                        id: 'SAT-HEAD-1',
                        status: 'ACCEPTED',
                        amount_unit: 5000,
                        currency: 'EUR',
                        external_code: 'REAL-ORD-1',
                    })),
                });

                // HEAD with payment_id in query and a spoofed body
                const result = await secureProvider.handleWebhook(
                    { payment_id: 'SPOOFED-BODY-ID' },
                    {},
                    { payment_id: 'SAT-HEAD-1', order_id: 'SPOOFED-QUERY-ORD' },
                    { method: 'HEAD', path: '/checkout/satispay/webhook?payment_id=SAT-HEAD-1' },
                );

                expect(result.success).toBe(true);
                expect(result.paymentId).toBe('SAT-HEAD-1');
                expect(result.orderId).toBe('REAL-ORD-1');
                expect(result.amount).toBe(50.0);
            });

            it('should ignore body payment_id on GET webhook and require payment_id in query', async () => {
                const result = await provider.handleWebhook(
                    { payment_id: 'SAT-IN-BODY' },
                    {},
                    {},
                    { method: 'GET', path: '/checkout/satispay/webhook' },
                );

                expect(result.success).toBe(false);
                expect(result.error).toBe('Missing payment_id in webhook body or query');
            });

            it('should return success: false when amount_unit is 0 or negative', async () => {
                // amount_unit = 0
                (global.fetch as any).mockResolvedValueOnce({
                    ok: true,
                    text: vi.fn().mockResolvedValue(JSON.stringify({
                        id: 'SAT-ZERO',
                        status: 'ACCEPTED',
                        amount_unit: 0,
                        currency: 'EUR',
                    })),
                });

                const resZero = await provider.getPaymentDetails('SAT-ZERO');
                expect(resZero.success).toBe(false);
                expect(resZero.amount).toBe(0);
                expect(resZero.error).toBe('Payment amount is missing or invalid');

                // amount_unit = -100
                (global.fetch as any).mockResolvedValueOnce({
                    ok: true,
                    text: vi.fn().mockResolvedValue(JSON.stringify({
                        id: 'SAT-NEG',
                        status: 'ACCEPTED',
                        amount_unit: -100,
                        currency: 'EUR',
                    })),
                });

                const resNeg = await provider.getPaymentDetails('SAT-NEG');
                expect(resNeg.success).toBe(false);
                expect(resNeg.amount).toBeUndefined();
                expect(resNeg.error).toBe('Payment amount is missing or invalid');
            });

            it('should return success: false when currency is missing or empty string', async () => {
                (global.fetch as any).mockResolvedValueOnce({
                    ok: true,
                    text: vi.fn().mockResolvedValue(JSON.stringify({
                        id: 'SAT-NOCURR',
                        status: 'ACCEPTED',
                        amount_unit: 1000,
                        currency: '',
                    })),
                });

                const result = await provider.getPaymentDetails('SAT-NOCURR');
                expect(result.success).toBe(false);
                expect(result.error).toBe('Payment currency is missing or invalid');
            });
        });
    });
});
