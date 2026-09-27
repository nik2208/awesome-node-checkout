import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createCheckoutRouter } from './index';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import { PaymentRequest } from '../../models/payment-request.model';

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
        expect(checkout.createPayment).toHaveBeenCalledWith('dummy', { amount: 10, currency: 'EUR' });
    });

    it('POST /:provider/execute - should map to executePayment and return 200 on success', async () => {
        const response = await request(app)
            .post('/payments/dummy/execute')
            .send({ paymentId: 'PAY-123', data: { payerId: 'user-1' } });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('COMPLETED');
        expect(checkout.executePayment).toHaveBeenCalledWith('dummy', 'PAY-123', { payerId: 'user-1' });
    });

    it('POST /:provider/webhook - should map to handleWebhook', async () => {
        const response = await request(app)
            .post('/payments/dummy/webhook')
            .send({ eventId: 'evt-1' });

        expect(response.status).toBe(200);
        expect(checkout.handleWebhook).toHaveBeenCalledWith('dummy', { eventId: 'evt-1' }, expect.any(Object));
    });

    it('GET /:provider/redirect - should map to handleRedirect (using query string)', async () => {
        const response = await request(app)
            .get('/payments/dummy/redirect?order_id=ORD-1');

        expect(response.status).toBe(200);
        expect(checkout.handleRedirect).toHaveBeenCalledWith('dummy', { order_id: 'ORD-1' });
    });

    it('GET /:provider/:id - should map to getPaymentDetails', async () => {
        const response = await request(app)
            .get('/payments/dummy/PAY-123');

        expect(response.status).toBe(200);
        expect(checkout.getPaymentDetails).toHaveBeenCalledWith('dummy', 'PAY-123');
    });

    describe('Security & buildPaymentRequest (Issue #3)', () => {
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

        it('should use buildPaymentRequest server-side values ignoring client body', async () => {
            const secureApp = express();
            secureApp.use(express.json());

            let receivedReq: Request | null = null;
            const buildPaymentRequest = vi.fn((req: Request): PaymentRequest => {
                receivedReq = req;
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
            expect(checkout.createPayment).toHaveBeenCalledWith('dummy', {
                amount: 19.99,
                currency: 'EUR',
                orderId: 'ord-1',
                returnUrl: 'http://return',
                cancelUrl: 'http://cancel',
            });
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

    describe('Middleware Options', () => {
        it('should apply custom middleware to protect routes', async () => {
            const protectedApp = express();
            protectedApp.use(express.json());
            const blockMiddleware = vi.fn((req, res, next) => {
                res.status(401).json({ error: 'Unauthorized' });
            });
            
            protectedApp.use('/api', createCheckoutRouter(checkout, {
                middleware: [blockMiddleware]
            }));

            const response = await request(protectedApp).get('/api/dummy/PAY-1');
            
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('Unauthorized');
            expect(checkout.getPaymentDetails).not.toHaveBeenCalled();
        });

        it('should skip middleware if publicPaths matches', async () => {
            const dynamicApp = express();
            dynamicApp.use(express.json());
            const blockMiddleware = vi.fn((req, res, next) => {
                res.status(401).json({ error: 'Unauthorized' });
            });
            
            dynamicApp.use('/api', createCheckoutRouter(checkout, {
                middleware: [blockMiddleware],
                publicPaths: ['/webhook']
            }));

            const blocked = await request(dynamicApp).get('/api/dummy/PAY-1');
            expect(blocked.status).toBe(401);

            const allowed = await request(dynamicApp).post('/api/dummy/webhook').send({});
            expect(allowed.status).toBe(200);
            expect(checkout.handleWebhook).toHaveBeenCalled();
        });
    });
});
