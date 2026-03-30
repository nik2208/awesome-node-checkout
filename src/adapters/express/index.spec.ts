import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createCheckoutRouter } from './index';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';

describe('Express Adapter (createCheckoutRouter)', () => {
    let app: Express;
    let checkout: CheckoutConfigurator;

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Usa una vera istanza di CheckoutConfigurator ma ne mockiamo i metodi
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
        // Montiamo il router nudo e crudo senza middleware customizati
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

    it('POST /:provider/refund - should map to refundPayment', async () => {
        const response = await request(app)
            .post('/payments/dummy/refund')
            .send({ paymentId: 'PAY-123', amount: 5.00 });

        expect(response.status).toBe(200);
        expect(checkout.refundPayment).toHaveBeenCalledWith('dummy', 'PAY-123', 5.00);
    });

    it('POST /:provider/webhook - should map to handleWebhook', async () => {
        const response = await request(app)
            .post('/payments/dummy/webhook')
            .send({ eventId: 'evt-1' });

        expect(response.status).toBe(200);
        // Ensure headers are injected (Supertest sends lowercase headers)
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

    describe('Error handling', () => {
        it('should return 400 if checkout methods return success=false', async () => {
            vi.spyOn(checkout, 'createPayment').mockResolvedValue({
                success: false, error: 'Validation failed', status: 'FAILED'
            });

            const response = await request(app)
                .post('/payments/dummy')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toBe('Validation failed');
        });

        it('should return 404 for CheckoutError with PROVIDER_NOT_FOUND', async () => {
            vi.spyOn(checkout, 'createPayment').mockImplementation(() => {
                throw new CheckoutError('Provider not found', 'PROVIDER_NOT_FOUND', 'missing');
            });

            const response = await request(app).post('/payments/missing').send({});
            
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

            // La route verrà bloccata prima di chiamare il configuratore
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
                publicPaths: ['/webhook'] // Any route ending with /webhook bypasses auth!
            }));

            // Verify a normal endpoint IS blocked
            const blocked = await request(dynamicApp).get('/api/dummy/PAY-1');
            expect(blocked.status).toBe(401);

            // Verify the webhook is ALLOWED to pass
            const allowed = await request(dynamicApp).post('/api/dummy/webhook').send({});
            expect(allowed.status).toBe(200);
            expect(checkout.handleWebhook).toHaveBeenCalled();
        });
    });
});
