import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { createCheckoutRouter, isPathPublic } from './index';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import { PaymentRequest } from '../../models/payment-request.model';
import { NexiProvider } from '../../providers/nexi/nexi.provider';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';

describe('Express Adapter (createCheckoutRouter)', () => {
    let app: Express;
    let checkout: CheckoutConfigurator;

    beforeEach(() => {
        vi.clearAllMocks();
        // Mount-time warnings and the default 500 logger are expected noise here
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});

        checkout = new CheckoutConfigurator({ emitEvents: false });
        
        vi.spyOn(checkout, 'createPayment').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'CREATED', raw: {}
        });
        vi.spyOn(checkout, 'executePayment').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'COMPLETED', raw: {}
        });
        vi.spyOn(checkout, 'refundPayment').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'REFUNDED', raw: {}
        });
        vi.spyOn(checkout, 'handleWebhook').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'WEBHOOK', raw: {}
        });
        vi.spyOn(checkout, 'handleRedirect').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'REDIRECT', raw: {}
        });
        vi.spyOn(checkout, 'getPaymentDetails').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'DETAILS', raw: {}
        });

        app = express();
        app.use(express.json());
        // Client-body router with the details route: covers the opt-in paths on purpose
        app.use('/payments', createCheckoutRouter(checkout, { allowClientPaymentRequest: true, details: {} }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('POST /:provider - should map to createPayment and return 201 on success', async () => {
        const response = await request(app)
            .post('/payments/dummy')
            .send({ amount: 10, currency: 'EUR' });

        expect(response.status).toBe(201);
        expect(response.body.paymentId).toBe('PAY-123');
        expect(response.body.raw).toBeUndefined();
        expect(checkout.createPayment).toHaveBeenCalledWith('dummy', { amount: 10, currency: 'EUR' });
    });

    it('POST /:provider/execute - should map to executePayment and return 200 on success (stripping raw)', async () => {
        vi.spyOn(checkout, 'executePayment').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'COMPLETED', raw: { secretPayer: 'confidential' }
        });

        const response = await request(app)
            .post('/payments/dummy/execute')
            .send({ paymentId: 'PAY-123', data: { payerId: 'user-1' } });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('COMPLETED');
        expect(response.body.raw).toBeUndefined();
        expect(checkout.executePayment).toHaveBeenCalledWith('dummy', 'PAY-123', { payerId: 'user-1' });
    });

    it('POST /:provider/webhook - should map to handleWebhook', async () => {
        const response = await request(app)
            .post('/payments/dummy/webhook')
            .send({ eventId: 'evt-1' });

        expect(response.status).toBe(200);
        expect(checkout.handleWebhook).toHaveBeenCalledWith(
            'dummy',
            { eventId: 'evt-1' },
            expect.any(Object),
            {},
            expect.objectContaining({ method: 'POST', path: '/payments/dummy/webhook' }),
        );
    });

    it('POST /:provider/webhook - should strip raw from the HTTP response JSON', async () => {
        vi.spyOn(checkout, 'handleWebhook').mockResolvedValue({
            success: true,
            paymentId: 'PAY-123',
            status: 'COMPLETED',
            raw: { sensitiveInternalData: 'secret-123' },
        });

        const response = await request(app)
            .post('/payments/dummy/webhook')
            .send({ eventId: 'evt-1' });

        expect(response.status).toBe(200);
        expect(response.body.paymentId).toBe('PAY-123');
        expect(response.body.status).toBe('COMPLETED');
        expect(response.body.raw).toBeUndefined();
    });

    it('GET /:provider/webhook - should map to handleWebhook passing query parameters', async () => {
        const response = await request(app)
            .get('/payments/dummy/webhook?payment_id=X');

        expect(response.status).toBe(200);
        expect(checkout.handleWebhook).toHaveBeenCalledWith(
            'dummy',
            undefined,
            expect.any(Object),
            { payment_id: 'X' },
            expect.objectContaining({ method: 'GET', path: '/payments/dummy/webhook?payment_id=X' }),
        );
        expect(checkout.getPaymentDetails).not.toHaveBeenCalled();
    });

    it('GET /:provider/redirect - should map to handleRedirect and strip raw in JSON mode', async () => {
        vi.spyOn(checkout, 'handleRedirect').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'REDIRECT', raw: { sensitive: 'foo' }
        });

        const response = await request(app)
            .get('/payments/dummy/redirect?order_id=ORD-1');

        expect(response.status).toBe(200);
        expect(response.body.paymentId).toBe('PAY-123');
        expect(response.body.raw).toBeUndefined();
        expect(checkout.handleRedirect).toHaveBeenCalledWith('dummy', { order_id: 'ORD-1' });
    });

    it('GET /:provider/:id - should map to getPaymentDetails and strip raw', async () => {
        vi.spyOn(checkout, 'getPaymentDetails').mockResolvedValue({
            success: true, paymentId: 'PAY-123', status: 'DETAILS', raw: { payerCard: '1234' }
        });

        const response = await request(app)
            .get('/payments/dummy/PAY-123');

        expect(response.status).toBe(200);
        expect(response.body.paymentId).toBe('PAY-123');
        expect(response.body.raw).toBeUndefined();
        expect(checkout.getPaymentDetails).toHaveBeenCalledWith('dummy', 'PAY-123');
    });

    describe('Security & buildPaymentRequest (Issues #3 and #12)', () => {
        it('should pass req and ctx to buildPaymentRequest and use server-side values', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            let receivedReq: Request | null = null;
            let receivedCtx: any = null;
            const buildPaymentRequest = vi.fn((req: Request, ctx: any): PaymentRequest => {
                receivedReq = req;
                receivedCtx = ctx;
                return {
                    amount: 19.99,
                    currency: 'EUR',
                    orderId: 'ord-1',
                    returnUrl: 'http://return',
                    cancelUrl: 'http://cancel',
                };
            });

            secureApp.use('/payments', createCheckoutRouter(checkout, { buildPaymentRequest }));

            const response = await request(secureApp)
                .post('/payments/dummy')
                .send({ amount: 0.01, currency: 'USD', orderId: 'other' });

            expect(response.status).toBe(201);
            expect(buildPaymentRequest).toHaveBeenCalledTimes(1);
            expect(receivedReq).not.toBeNull();
            expect(receivedCtx).toMatchObject({ provider: 'dummy' });
            expect(checkout.createPayment).toHaveBeenCalledWith('dummy', {
                amount: 19.99,
                currency: 'EUR',
                orderId: 'ord-1',
                returnUrl: 'http://return',
                cancelUrl: 'http://cancel',
            });
        });

        it('should return 400 INVALID_PAYMENT_REQUEST when buildPaymentRequest returns null or invalid object', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            secureApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: (() => null as any),
            }));

            const response = await request(secureApp)
                .post('/payments/dummy')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                success: false,
                code: 'INVALID_PAYMENT_REQUEST',
                error: expect.stringContaining('Invalid payment request returned by buildPaymentRequest'),
            });
            expect(checkout.createPayment).not.toHaveBeenCalled();
        });

        it('should allow buildPaymentRequest to send response directly via ctx.res without triggering 400 or double response', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            secureApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: ((req: Request, ctx: any) => {
                    ctx.res.status(403).json({ error: 'Direct response from hook' });
                    return null as any;
                }),
            }));

            const response = await request(secureApp)
                .post('/payments/dummy')
                .send({});

            expect(response.status).toBe(403);
            expect(response.body).toEqual({ error: 'Direct response from hook' });
            expect(checkout.createPayment).not.toHaveBeenCalled();
        });

        it('should return error and NOT call provider when buildPaymentRequest throws CheckoutError', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            secureApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => {
                    throw new CheckoutError('Order not found', 'TRANSACTION_NOT_FOUND');
                }
            }));

            const response = await request(secureApp)
                .post('/payments/dummy')
                .send({ orderId: 'unknown' });

            expect(response.status).toBe(400);
            expect(response.body.code).toBe('TRANSACTION_NOT_FOUND');
            expect(response.body.error).toBe('Order not found');
            expect(checkout.createPayment).not.toHaveBeenCalled();
        });

        it('should return 500 when buildPaymentRequest throws generic Error', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            secureApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => {
                    throw new Error('Database connection failed');
                },
                exposeErrorMessages: true,
            }));

            const response = await request(secureApp)
                .post('/payments/dummy')
                .send({ orderId: '123' });

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Database connection failed');
            expect(checkout.createPayment).not.toHaveBeenCalled();
        });

        describe('Body validation when buildPaymentRequest is not set', () => {
            it('should return 400 when amount is missing or not a positive finite number', async () => {
                const resMissing = await request(app).post('/payments/dummy').send({ currency: 'EUR' });
                expect(resMissing.status).toBe(400);
                expect(resMissing.body.error).toContain('amount must be a positive number');

                const resNegative = await request(app).post('/payments/dummy').send({ amount: -10, currency: 'EUR' });
                expect(resNegative.status).toBe(400);

                const resZero = await request(app).post('/payments/dummy').send({ amount: 0, currency: 'EUR' });
                expect(resZero.status).toBe(400);

                const resString = await request(app).post('/payments/dummy').send({ amount: '10' as any, currency: 'EUR' });
                expect(resString.status).toBe(400);

                expect(checkout.createPayment).not.toHaveBeenCalled();
            });

            it('should return 400 when currency is missing or empty', async () => {
                const resMissing = await request(app).post('/payments/dummy').send({ amount: 10 });
                expect(resMissing.status).toBe(400);
                expect(resMissing.body.error).toContain('currency is required');

                const resEmpty = await request(app).post('/payments/dummy').send({ amount: 10, currency: '   ' });
                expect(resEmpty.status).toBe(400);

                expect(checkout.createPayment).not.toHaveBeenCalled();
            });
        });
    });

    describe('Browser Redirect Flows (Issue #12)', () => {
        it('should respond with 302 to onSuccess URL on successful redirect callback', async () => {
            const redirectApp = express();
            redirectApp.use(express.json());

            redirectApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                redirect: {
                    onSuccess: (result, req) => `https://shop.test/success?paymentId=${result.paymentId}&ref=${req.query.ref}`,
                    onFailure: (result) => `https://shop.test/fail?status=${result.status}`,
                },
            }));

            const response = await request(redirectApp)
                .get('/payments/dummy/redirect?ref=user1');

            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('https://shop.test/success?paymentId=PAY-123&ref=user1');
        });

        it('should respond with 302 to onFailure URL on failed redirect callback', async () => {
            vi.spyOn(checkout, 'handleRedirect').mockResolvedValue({
                success: false,
                status: 'FAILED',
                error: 'User cancelled',
            });

            const redirectApp = express();
            redirectApp.use(express.json());

            redirectApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                redirect: {
                    onSuccess: (result) => `https://shop.test/success?paymentId=${result.paymentId}`,
                    onFailure: (result) => `https://shop.test/fail?status=${result.status}`,
                },
            }));

            const response = await request(redirectApp)
                .get('/payments/dummy/redirect');

            expect(response.status).toBe(302);
            expect(response.headers.location).toBe('https://shop.test/fail?status=FAILED');
        });
    });

    describe('Details Route Configuration (Issue #12)', () => {
        it('should return 404 when details.enabled is false (deprecated, same as omitted)', async () => {
            const noDetailsApp = express();
            noDetailsApp.use(express.json());
            noDetailsApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                details: { enabled: false },
            }));

            const response = await request(noDetailsApp).get('/payments/dummy/PAY-123');
            expect(response.status).toBe(404);
            expect(checkout.getPaymentDetails).not.toHaveBeenCalled();
        });

        it('should execute details.middleware before getPaymentDetails', async () => {
            const detailsApp = express();
            detailsApp.use(express.json());

            const authGuard = (req: Request, res: Response, next: NextFunction) => {
                if (req.headers['x-admin'] !== 'true') {
                    return res.status(403).json({ error: 'Admin only' });
                }
                next();
            };

            detailsApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                details: { middleware: [authGuard] },
            }));

            const blocked = await request(detailsApp).get('/payments/dummy/PAY-123');
            expect(blocked.status).toBe(403);
            expect(checkout.getPaymentDetails).not.toHaveBeenCalled();

            const allowed = await request(detailsApp)
                .get('/payments/dummy/PAY-123')
                .set('x-admin', 'true');
            expect(allowed.status).toBe(200);
            expect(checkout.getPaymentDetails).toHaveBeenCalledWith('dummy', 'PAY-123');
        });
    });

    describe('Refund gating (Issue #3)', () => {
        it('POST /:provider/refund - should return 404 when options.refund is not set', async () => {
            const response = await request(app)
                .post('/payments/dummy/refund')
                .send({ paymentId: 'PAY-123', amount: 5.00 });

            expect(response.status).toBe(404);
            expect(checkout.refundPayment).not.toHaveBeenCalled();
        });

        it('POST /:provider/refund - should succeed when options.refund is set', async () => {
            const refundApp = express();
            refundApp.use(express.json());
            refundApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                refund: {}
            }));

            const response = await request(refundApp)
                .post('/payments/dummy/refund')
                .send({ paymentId: 'PAY-123', amount: 5.00 });

            expect(response.status).toBe(200);
            expect(response.body.raw).toBeUndefined();
            expect(checkout.refundPayment).toHaveBeenCalledWith('dummy', 'PAY-123', 5.00);
        });

        it('POST /:provider/refund - should execute refund middleware and block with 403 when guard rejects', async () => {
            const refundApp = express();
            refundApp.use(express.json());

            const adminGuard = (req: Request, res: Response, next: NextFunction) => {
                res.status(403).json({ error: 'Forbidden: admin only' });
            };

            refundApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                refund: {
                    middleware: [adminGuard]
                }
            }));

            const response = await request(refundApp)
                .post('/payments/dummy/refund')
                .send({ paymentId: 'PAY-123', amount: 5.00 });

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Forbidden: admin only');
            expect(checkout.refundPayment).not.toHaveBeenCalled();
        });

        it('POST /:provider/refund - should execute refund middleware and proceed when guard passes', async () => {
            const refundApp = express();
            refundApp.use(express.json());

            const passGuard = vi.fn((req: Request, res: Response, next: NextFunction) => next());

            refundApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                refund: {
                    middleware: [passGuard]
                }
            }));

            const response = await request(refundApp)
                .post('/payments/dummy/refund')
                .send({ paymentId: 'PAY-123', amount: 5.00 });

            expect(response.status).toBe(200);
            expect(passGuard).toHaveBeenCalled();
            expect(checkout.refundPayment).toHaveBeenCalledWith('dummy', 'PAY-123', 5.00);
        });
    });

    describe('Execute gating and onBeforeExecute (Issue #3)', () => {
        it('POST /:provider/execute - should invoke onBeforeExecute before executePayment', async () => {
            const execApp = express();
            execApp.use(express.json());

            const onBeforeExecute = vi.fn(async (req: Request, paymentId: string) => {
                expect(paymentId).toBe('PAY-123');
            });

            execApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                execute: { onBeforeExecute }
            }));

            const response = await request(execApp)
                .post('/payments/dummy/execute')
                .send({ paymentId: 'PAY-123', data: { extra: true } });

            expect(response.status).toBe(200);
            expect(onBeforeExecute).toHaveBeenCalled();
            expect(checkout.executePayment).toHaveBeenCalledWith('dummy', 'PAY-123', { extra: true });
        });

        it('POST /:provider/execute - should reject capture if onBeforeExecute throws CheckoutError', async () => {
            const execApp = express();
            execApp.use(express.json());

            const onBeforeExecute = vi.fn(async () => {
                throw new CheckoutError('Payment already settled or invalid', 'PAYMENT_FAILED');
            });

            execApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                execute: { onBeforeExecute }
            }));

            const response = await request(execApp)
                .post('/payments/dummy/execute')
                .send({ paymentId: 'PAY-123' });

            expect(response.status).toBe(400);
            expect(response.body.code).toBe('PAYMENT_FAILED');
            expect(checkout.executePayment).not.toHaveBeenCalled();
        });

        it('POST /:provider/execute - should execute middleware in options.execute', async () => {
            const execApp = express();
            execApp.use(express.json());

            const execGuard = (req: Request, res: Response, next: NextFunction) => {
                res.status(401).json({ error: 'Execute unauthorized' });
            };

            execApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                execute: {
                    middleware: [execGuard]
                }
            }));

            const response = await request(execApp)
                .post('/payments/dummy/execute')
                .send({ paymentId: 'PAY-123' });

            expect(response.status).toBe(401);
            expect(checkout.executePayment).not.toHaveBeenCalled();
        });
    });

    describe('Error handling', () => {
        it('should return 400 if checkout methods return success=false', async () => {
            vi.spyOn(checkout, 'createPayment').mockResolvedValue({
                success: false, error: 'Validation failed', status: 'FAILED'
            });

            const response = await request(app)
                .post('/payments/dummy')
                .send({ amount: 10, currency: 'EUR' });

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Validation failed');
        });

        it('should return 404 for CheckoutError with PROVIDER_NOT_FOUND', async () => {
            vi.spyOn(checkout, 'createPayment').mockImplementation(() => {
                throw new CheckoutError('Provider not found', 'PROVIDER_NOT_FOUND', 'missing');
            });

            const response = await request(app)
                .post('/payments/missing')
                .send({ amount: 10, currency: 'EUR' });
            
            expect(response.status).toBe(404);
            expect(response.body.error).toBe('Provider not found');
            expect(response.body.code).toBe('PROVIDER_NOT_FOUND');
        });

        it('should return 422 for CheckoutError with WEBHOOK_NOT_SUPPORTED', async () => {
            vi.spyOn(checkout, 'handleWebhook').mockImplementation(() => {
                throw new CheckoutError('Unsupported', 'WEBHOOK_NOT_SUPPORTED', 'dummy');
            });

            const response = await request(app).post('/payments/dummy/webhook').send({});
            
            expect(response.status).toBe(422);
            expect(response.body.code).toBe('WEBHOOK_NOT_SUPPORTED');
        });

        it('should return a generic 500 for unhandled generic Errors', async () => {
            vi.spyOn(checkout, 'executePayment').mockImplementation(() => {
                throw new Error('Database crash');
            });

            const response = await request(app).post('/payments/dummy/execute').send({ paymentId: '1' });

            expect(response.status).toBe(500);
            expect(response.body).toEqual({ success: false, error: 'Internal server error' });
        });

        it('should return the message of unhandled generic Errors with exposeErrorMessages', async () => {
            vi.spyOn(checkout, 'executePayment').mockImplementation(() => {
                throw new Error('Database crash');
            });
            const exposingApp = express();
            exposingApp.use(express.json());
            exposingApp.use('/payments', createCheckoutRouter(checkout, { buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }), exposeErrorMessages: true }));

            const response = await request(exposingApp).post('/payments/dummy/execute').send({ paymentId: '1' });

            expect(response.status).toBe(500);
            expect(response.body.error).toBe('Database crash');
        });
    });

    describe('Public Paths & Segment Matching (Issue #13)', () => {
        it('isPathPublic unit tests with segment-based matching', () => {
            const publicPatterns = [':provider/webhook', ':provider/redirect'];

            // Should match:
            expect(isPathPublic('/x/webhook', publicPatterns)).toBe(true);
            expect(isPathPublic('/x/redirect', publicPatterns)).toBe(true);
            expect(isPathPublic('/paypal/webhook', publicPatterns)).toBe(true);

            // Should NOT match (substring vectors):
            expect(isPathPublic('/webhook/execute', publicPatterns)).toBe(false);
            expect(isPathPublic('/redirect/execute', publicPatterns)).toBe(false);
            expect(isPathPublic('/x/webhooks', publicPatterns)).toBe(false);
            expect(isPathPublic('/x/redirect/extra', publicPatterns)).toBe(false);
            expect(isPathPublic('/x/y', publicPatterns)).toBe(false);

            // Patterns without :provider match exact segments:
            expect(isPathPublic('/health', ['health'])).toBe(true);
            expect(isPathPublic('/health/check', ['health'])).toBe(false);
            expect(isPathPublic('/my/health', ['health'])).toBe(false);

            // Segment array format:
            const segmentPatterns: any = [[':provider', 'webhook'], [':provider', 'redirect']];
            expect(isPathPublic('/x/webhook', segmentPatterns)).toBe(true);
            expect(isPathPublic('/x/redirect', segmentPatterns)).toBe(true);
            expect(isPathPublic('/x/webhooks', segmentPatterns)).toBe(false);
            expect(isPathPublic('/x/other', segmentPatterns)).toBe(false);
        });

        it('applies middleware and verifies publicPaths acceptance criteria table', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
                res.status(401).json({ error: 'Auth required' });
            };

            secureApp.use('/checkout', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                middleware: [authMiddleware],
                publicPaths: [':provider/webhook', ':provider/redirect'],
                execute: {
                    onBeforeExecute: async () => {},
                },
            }));

            // Public paths: skip middleware (200)
            const resPostWebhook = await request(secureApp).post('/checkout/x/webhook').send({});
            expect(resPostWebhook.status).toBe(200);

            const resGetRedirect = await request(secureApp).get('/checkout/x/redirect');
            expect(resGetRedirect.status).toBe(200);

            // Protected paths: must run middleware (401)
            const resWebhookExec = await request(secureApp).post('/checkout/webhook/execute').send({});
            expect(resWebhookExec.status).toBe(401);

            const resRedirectExec = await request(secureApp).post('/checkout/redirect/execute').send({});
            expect(resRedirectExec.status).toBe(401);

            const resWebhooks = await request(secureApp).post('/checkout/x/webhooks').send({});
            expect(resWebhooks.status).toBe(401);

            const resRedirectExtra = await request(secureApp).get('/checkout/x/redirect/extra');
            expect(resRedirectExtra.status).toBe(401);

            const resXY = await request(secureApp).get('/checkout/x/y');
            expect(resXY.status).toBe(401);
        });
    });

    describe('Unmocked NexiProvider in Express Adapter (Issues #6 and #8)', () => {
        const nexiConfig = {
            merchantId: 'TEST_MERCHANT',
            macKey: 'super-secret-mac-key',
            environment: 'sandbox' as const,
        };

        function sha1(raw: string): string {
            return crypto.createHash('sha1').update(raw).digest('hex');
        }

        it('GET /payments/nexi/redirect?codTrans=ORD-42&esito=OK returns 400 with FAILED status when mac is absent (Issue #6)', async () => {
            const realCheckout = new CheckoutConfigurator({ emitEvents: false });
            realCheckout.registerProvider(new NexiProvider(nexiConfig));

            const nexiApp = express();
            nexiApp.use(express.json());
            nexiApp.use('/payments', createCheckoutRouter(realCheckout, { buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }) }));

            const res = await request(nexiApp).get('/payments/nexi/redirect?codTrans=ORD-42&esito=OK');
            expect(res.status).toBe(400);
            expect(res.body.status).toBe('FAILED');
            expect(res.body.error).toBe('MAC missing');
        });

        it('POST /payments/nexi/webhook with urlencoded parser accepts valid MAC and rejects missing MAC (Issue #8)', async () => {
            const realCheckout = new CheckoutConfigurator({ emitEvents: false });
            realCheckout.registerProvider(new NexiProvider(nexiConfig));

            const nexiApp = express();
            nexiApp.use(express.urlencoded({ extended: false }));
            nexiApp.use('/payments', createCheckoutRouter(realCheckout, { buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }) }));

            const codTrans = 'ORD-001';
            const esito = 'OK';
            const importo = '1999';
            const divisa = 'EUR';
            const dataStr = '20260927';
            const orario = '120000';
            const codAut = 'AUTH123';
            const mac = sha1(`codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}data=${dataStr}orario=${orario}codAut=${codAut}${nexiConfig.macKey}`);

            // Valid notification
            const resOk = await request(nexiApp)
                .post('/payments/nexi/webhook')
                .type('form')
                .send({ codTrans, esito, importo, divisa, data: dataStr, orario, codAut, mac });

            expect(resOk.status).toBe(200);
            expect(resOk.body.status).toBe('COMPLETED');
            expect(resOk.body.amount).toBe(19.99);

            // Missing MAC
            const resNoMac = await request(nexiApp)
                .post('/payments/nexi/webhook')
                .type('form')
                .send({ codTrans, esito, importo, divisa });

            expect(resNoMac.status).toBe(400);
            expect(resNoMac.body.error).toBe('MAC verification failed');
        });

        it('should handle HEAD /payments/:provider/webhook without errors', async () => {
            const headApp = express();
            headApp.use('/payments', createCheckoutRouter(checkout, { buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }) }));

            const res = await request(headApp)
                .head('/payments/dummy/webhook?payment_id=dummy-123');

            expect(res.status).toBe(200);
        });

        it('should sanitize unhandled SyntaxError / JSON parse errors to Invalid provider response', async () => {
            vi.spyOn(checkout, 'getPaymentDetails').mockImplementation(() => {
                throw new SyntaxError('Unexpected token < in JSON at position 0: <html><body>Error body</body></html>');
            });
            const exposingApp = express();
            exposingApp.use('/payments', createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://r', cancelUrl: 'https://c' }),
                details: {},
                exposeErrorMessages: true,
            }));

            const res = await request(exposingApp).get('/payments/dummy/err-id');

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Invalid provider response');
            expect(res.body.error).not.toContain('<html>');
            expect(res.body.error).not.toContain('Error body');
        });
    });
});

// ---------------------------------------------------------------------------
// Issue #29 — secure defaults (2.0.0)
// ---------------------------------------------------------------------------

class DummyProvider extends BasePaymentProvider {
    name = 'dummy';
    flow = 'redirect' as const;

    async createPayment(req: PaymentRequest): Promise<PaymentResult> {
        return { success: true, paymentId: 'dummy-123', status: 'CREATED', raw: req };
    }
    async executePayment(id: string, data?: any): Promise<PaymentResult> {
        return { success: true, verified: true, paymentId: id, status: 'COMPLETED', raw: data };
    }
    async getPaymentDetails(id: string): Promise<PaymentResult> {
        return { success: true, paymentId: id, status: 'DETAILS', raw: {} };
    }
    async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
        return { success: true, paymentId: id, status: 'REFUNDED', raw: { amount } };
    }
    async handleWebhook(body?: any, _headers: Record<string, string> = {}, query?: Record<string, string>): Promise<WebhookResult> {
        return { success: true, verified: true, paymentId: 'dummy-123', status: 'WEBHOOK', raw: body ?? query };
    }
    async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
        return { success: true, verified: true, paymentId: query.id, status: 'REDIRECT', raw: query };
    }
}

describe('Secure defaults (Issue #29)', () => {
    let c: CheckoutConfigurator;
    let dummy: DummyProvider;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    const buildPaymentRequest = (): PaymentRequest => ({
        amount: 19.99,
        currency: 'EUR',
        orderId: 'ord-1',
        returnUrl: 'https://shop.test/return',
        cancelUrl: 'https://shop.test/cancel',
    });

    const deny403 = (_req: Request, res: Response) => {
        res.status(403).json({ error: 'Forbidden' });
    };
    const pass = (_req: Request, _res: Response, next: NextFunction) => next();

    function mount(options: Parameters<typeof createCheckoutRouter>[1]): Express {
        const app = express();
        app.use(express.json());
        app.use('/checkout', createCheckoutRouter(c, options));
        return app;
    }

    beforeEach(() => {
        c = new CheckoutConfigurator({ emitEvents: false });
        dummy = new DummyProvider();
        c.registerProvider(dummy);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('1-2. buildPaymentRequest is mandatory', () => {
        it('createCheckoutRouter(c) throws CheckoutError INSECURE_CONFIGURATION', () => {
            let thrown: unknown;
            try {
                createCheckoutRouter(c);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(CheckoutError);
            expect((thrown as CheckoutError).code).toBe('INSECURE_CONFIGURATION');
            expect((thrown as CheckoutError).message).toContain('buildPaymentRequest');
            expect((thrown as CheckoutError).message).toContain('allowClientPaymentRequest: true');
        });

        it('throws for options without a builder, and for a non-true allowClientPaymentRequest', () => {
            expect(() => createCheckoutRouter(c, {})).toThrow(CheckoutError);
            expect(() => createCheckoutRouter(c, { details: {}, refund: {} })).toThrow(CheckoutError);
            expect(() => createCheckoutRouter(c, { allowClientPaymentRequest: 'yes' as any })).toThrow(CheckoutError);
        });

        it('allowClientPaymentRequest: true does not throw and warns exactly once', () => {
            expect(() => createCheckoutRouter(c, { allowClientPaymentRequest: true })).not.toThrow();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain('allowClientPaymentRequest');
        });

        it('allowClientPaymentRequest: true keeps the client-body path and its validation', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const app = mount({ allowClientPaymentRequest: true });

            const ok = await request(app).post('/checkout/dummy').send({ amount: 10, currency: 'EUR', returnUrl: 'r', cancelUrl: 'c' });
            expect(ok.status).toBe(201);
            expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 10, currency: 'EUR' }));

            const bad = await request(app).post('/checkout/dummy').send({ amount: -1, currency: 'EUR' });
            expect(bad.status).toBe(400);
            expect(createSpy).toHaveBeenCalledTimes(1);
        });

        it('with buildPaymentRequest set, console.warn is never called at mount', () => {
            createCheckoutRouter(c, { buildPaymentRequest });
            createCheckoutRouter(c, { buildPaymentRequest, allowClientPaymentRequest: true });
            createCheckoutRouter(c, { buildPaymentRequest, details: { middleware: [pass] }, refund: {} });
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('with buildPaymentRequest set, the client body never reaches the provider', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const app = mount({ buildPaymentRequest });
            const res = await request(app)
                .post('/checkout/dummy')
                .send({ amount: 0.01, currency: 'EUR', orderId: 'ord-19-99' });
            expect(res.status).toBe(201);
            expect(createSpy).toHaveBeenCalledWith(buildPaymentRequest());
        });
    });

    describe('3-4. details route is opt-in', () => {
        it('without details, GET /checkout/dummy/any-id answers 404 and getPaymentDetails is not called', async () => {
            const detailsSpy = vi.spyOn(dummy, 'getPaymentDetails');
            const res = await request(mount({ buildPaymentRequest })).get('/checkout/dummy/any-id');
            expect(res.status).toBe(404);
            expect(res.body.paymentId).toBeUndefined();
            expect(detailsSpy).not.toHaveBeenCalled();
        });

        it('with details: { middleware: [deny403] } it answers 403', async () => {
            const detailsSpy = vi.spyOn(dummy, 'getPaymentDetails');
            const res = await request(mount({ buildPaymentRequest, details: { middleware: [deny403] } })).get('/checkout/dummy/any-id');
            expect(res.status).toBe(403);
            expect(detailsSpy).not.toHaveBeenCalled();
        });

        it('with a passing middleware it answers 200 as before', async () => {
            const detailsSpy = vi.spyOn(dummy, 'getPaymentDetails');
            const res = await request(mount({ buildPaymentRequest, details: { middleware: [pass] } })).get('/checkout/dummy/any-id');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, paymentId: 'any-id', status: 'DETAILS' });
            expect(detailsSpy).toHaveBeenCalledWith('any-id');
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it.each([
            ['details omitted', {}],
            ['details mounted', { details: { middleware: [pass] } }],
            ['details mounted without middleware', { details: {} }],
        ])('GET /checkout/dummy/redirect?id=x reaches handleRedirect, not details (%s)', async (_label, extra) => {
            const redirectSpy = vi.spyOn(dummy, 'handleRedirect');
            const detailsSpy = vi.spyOn(dummy, 'getPaymentDetails');
            const res = await request(mount({ buildPaymentRequest, ...extra })).get('/checkout/dummy/redirect?id=x');
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, paymentId: 'x', status: 'REDIRECT' });
            expect(redirectSpy).toHaveBeenCalledWith({ id: 'x' });
            expect(detailsSpy).not.toHaveBeenCalled();
        });

        it('details: {} without middleware mounts the route and warns once', async () => {
            const app = mount({ buildPaymentRequest, details: {} });
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toBe(
                '[awesome-node-checkout] details route mounted without middleware: payment status and amount are readable by anyone who knows a payment id',
            );
            const res = await request(app).get('/checkout/dummy/any-id');
            expect(res.status).toBe(200);
            expect(res.body.paymentId).toBe('any-id');
        });

        it('details: { enabled: false } compiles and the route answers 404', async () => {
            const detailsSpy = vi.spyOn(dummy, 'getPaymentDetails');
            const app = mount({ buildPaymentRequest, details: { enabled: false } });
            const res = await request(app).get('/checkout/dummy/any-id');
            expect(res.status).toBe(404);
            expect(detailsSpy).not.toHaveBeenCalled();
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('9. INVALID_AMOUNT through the router', () => {
        it('buildPaymentRequest returning amount 19.999 answers 400 INVALID_AMOUNT and the provider is not called', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const app = mount({ buildPaymentRequest: () => ({ ...buildPaymentRequest(), amount: 19.999 }) });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ success: false, code: 'INVALID_AMOUNT' });
            expect(res.body.error).toContain('amount');
            expect(createSpy).not.toHaveBeenCalled();
        });

        it('buildPaymentRequest returning a JPY amount with decimals answers 400 INVALID_AMOUNT', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const app = mount({ buildPaymentRequest: () => ({ ...buildPaymentRequest(), amount: 10.5, currency: 'JPY' }) });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_AMOUNT');
            expect(createSpy).not.toHaveBeenCalled();
        });

        it('the client-body path (allowClientPaymentRequest) answers 400 INVALID_AMOUNT for excess decimals', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const app = mount({ allowClientPaymentRequest: true });
            const res = await request(app).post('/checkout/dummy').send({ amount: 19.999, currency: 'EUR' });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ success: false, code: 'INVALID_AMOUNT' });
            expect(createSpy).not.toHaveBeenCalled();
        });

        it('a valid 19.99 EUR passes through unchanged', async () => {
            const createSpy = vi.spyOn(dummy, 'createPayment');
            const res = await request(mount({ buildPaymentRequest })).post('/checkout/dummy').send({});
            expect(res.status).toBe(201);
            expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 19.99 }));
        });
    });

    describe('10. generic 500 bodies, exposeErrorMessages and onError', () => {
        it('a buildPaymentRequest throwing Error("secret detail") gives a generic body and calls onError once', async () => {
            const secret = new Error('secret detail');
            const onError = vi.fn();
            const app = mount({ buildPaymentRequest: () => { throw secret; }, onError });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'Internal server error' });
            expect(JSON.stringify(res.body)).not.toContain('secret detail');
            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0]).toBe(secret);
            expect(onError.mock.calls[0][1]).toHaveProperty('method', 'POST');
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('without onError the error is logged with console.error', async () => {
            const secret = new Error('secret detail');
            const res = await request(mount({ buildPaymentRequest: () => { throw secret; } })).post('/checkout/dummy').send({});
            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Internal server error');
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith('[awesome-node-checkout]', secret);
        });

        it('with exposeErrorMessages: true the message is returned', async () => {
            const onError = vi.fn();
            const app = mount({ buildPaymentRequest: () => { throw new Error('secret detail'); }, exposeErrorMessages: true, onError });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'secret detail' });
            expect(onError).toHaveBeenCalledTimes(1);
        });

        it('a CheckoutError from the hook keeps its 4xx status, message and code', async () => {
            const onError = vi.fn();
            const app = mount({
                buildPaymentRequest: () => { throw new CheckoutError('Order not found', 'TRANSACTION_NOT_FOUND'); },
                onError,
            });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ success: false, error: 'Order not found', code: 'TRANSACTION_NOT_FOUND' });
            expect(onError).not.toHaveBeenCalled();
        });

        it('onBeforeExecute and redirect hooks throwing generic errors are masked too', async () => {
            const onError = vi.fn();
            const app = mount({
                buildPaymentRequest,
                onError,
                execute: { onBeforeExecute: () => { throw new Error('Mongo timeout at db-3.internal:27017'); } },
                redirect: {
                    onSuccess: () => { throw new Error('redirect secret'); },
                    onFailure: () => '/fail',
                },
            });
            const exec = await request(app).post('/checkout/dummy/execute').send({ paymentId: 'p1' });
            expect(exec.status).toBe(500);
            expect(exec.body).toEqual({ success: false, error: 'Internal server error' });

            const redir = await request(app).get('/checkout/dummy/redirect?id=x');
            expect(redir.status).toBe(500);
            expect(redir.body).toEqual({ success: false, error: 'Internal server error' });
            expect(onError).toHaveBeenCalledTimes(2);
        });

        it('a throwing onError does not prevent the generic response', async () => {
            const app = mount({
                buildPaymentRequest: () => { throw new Error('secret detail'); },
                onError: () => { throw new Error('logger down'); },
            });
            const res = await request(app).post('/checkout/dummy').send({});
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ success: false, error: 'Internal server error' });
        });
    });

    describe('11. POST /:provider/execute stays mounted by default', () => {
        it('captures through the provider with only buildPaymentRequest set', async () => {
            const execSpy = vi.spyOn(dummy, 'executePayment');
            const res = await request(mount({ buildPaymentRequest })).post('/checkout/dummy/execute').send({ paymentId: 'p1', data: { a: 1 } });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, verified: true, paymentId: 'p1', status: 'COMPLETED' });
            expect(execSpy).toHaveBeenCalledWith('p1', { a: 1 });
        });
    });
});
