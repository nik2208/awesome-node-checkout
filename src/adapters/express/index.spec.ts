import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { createCheckoutRouter, isPathPublic } from './index';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import { PaymentRequest } from '../../models/payment-request.model';
import { NexiProvider } from '../../providers/nexi/nexi.provider';

describe('Express Adapter (createCheckoutRouter)', () => {
    let app: Express;
    let checkout: CheckoutConfigurator;

    beforeEach(() => {
        vi.clearAllMocks();
        
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
        // Default router without options
        app.use('/payments', createCheckoutRouter(checkout));
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
        it('should warn at mount time when buildPaymentRequest is not set', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            createCheckoutRouter(checkout);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('the client body decides the amount; set buildPaymentRequest')
            );
            warnSpy.mockRestore();
        });

        it('should NOT warn at mount time when buildPaymentRequest is provided', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            createCheckoutRouter(checkout, {
                buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: '', cancelUrl: '' })
            });
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

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
                }
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
        it('should return 404 when details.enabled is false', async () => {
            const noDetailsApp = express();
            noDetailsApp.use(express.json());
            noDetailsApp.use('/payments', createCheckoutRouter(checkout, {
                details: { enabled: false },
            }));

            const response = await request(noDetailsApp).get('/payments/dummy/PAY-123');
            expect(response.status).toBe(404);
            expect(response.body.error).toContain('disabled');
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

        it('should return 500 for unhandled generic Errors', async () => {
            vi.spyOn(checkout, 'executePayment').mockImplementation(() => {
                throw new Error('Database crash');
            });

            const response = await request(app).post('/payments/dummy/execute').send({ paymentId: '1' });
            
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
            nexiApp.use('/payments', createCheckoutRouter(realCheckout));

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
            nexiApp.use('/payments', createCheckoutRouter(realCheckout));

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
            headApp.use('/payments', createCheckoutRouter(checkout));

            const res = await request(headApp)
                .head('/payments/dummy/webhook?payment_id=dummy-123');

            expect(res.status).toBe(200);
        });

        it('should sanitize unhandled SyntaxError / JSON parse errors to Invalid provider response', async () => {
            vi.spyOn(checkout, 'getPaymentDetails').mockImplementation(() => {
                throw new SyntaxError('Unexpected token < in JSON at position 0: <html><body>Error body</body></html>');
            });

            const res = await request(app).get('/payments/dummy/err-id');

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('Invalid provider response');
            expect(res.body.error).not.toContain('<html>');
            expect(res.body.error).not.toContain('Error body');
        });
    });
});
