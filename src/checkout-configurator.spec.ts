import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult, WebhookResult } from './models/payment-result.model';
import { CheckoutError } from './models/errors';

class DummyProvider extends BasePaymentProvider {
  name = 'dummy';
  flow = 'redirect' as const;

  async createPayment(req: PaymentRequest): Promise<PaymentResult> {
    return { success: true, paymentId: 'dummy-123', status: 'CREATED', raw: req };
  }
  async executePayment(id: string, data?: any): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'COMPLETED', raw: data };
  }
  async getPaymentDetails(id: string): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'DETAILS', raw: {} };
  }
  async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'REFUNDED', raw: { amount } };
  }
  async handleWebhook(
    body?: any,
    headers: Record<string, string> = {},
    query?: Record<string, string>,
  ): Promise<WebhookResult> {
    return { success: true, paymentId: 'dummy-123', status: 'WEBHOOK', raw: body ?? query };
  }
  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    return { success: true, paymentId: query.id, status: 'REDIRECT', raw: query };
  }
}

describe('CheckoutConfigurator', () => {
    let configurator: CheckoutConfigurator;
    let provider: DummyProvider;

    beforeEach(() => {
        configurator = new CheckoutConfigurator({ emitEvents: true });
        provider = new DummyProvider();
        configurator.registerProvider(provider);
    });

    it('should register and retrieve a provider by name', () => {
        const found = configurator.getProvider('dummy');
        expect(found).toBe(provider);
    });

    it('should return all registered providers', () => {
        const providers = configurator.getRegisteredProviders();
        expect(providers).toHaveLength(1);
        expect(providers[0]).toBe('dummy');
    });

    it('should throw ProviderNotFound if provider is missing', () => {
        expect(() => configurator.getProvider('non-existent')).toThrowError(CheckoutError);
    });

    it('should delegate createPayment and emit events with orderId and raw', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const req: PaymentRequest = { amount: 10, currency: 'EUR', description: 'test', orderId: 'ord-123', returnUrl: 'http://ret', cancelUrl: 'http://can' };
        
        const result = await configurator.createPayment('dummy', req);
        
        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('dummy-123');
        expect(spyEmit).toHaveBeenCalledWith('payment.created', {
            provider: 'dummy',
            paymentId: 'dummy-123',
            orderId: 'ord-123',
            status: 'CREATED',
            error: undefined,
            verified: true,
            raw: req,
        });
    });

    it('should catch errors returned from providers and emit payment.failed', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const errorProvider = new DummyProvider();
        errorProvider.name = 'error-prov';
        vi.spyOn(errorProvider, 'createPayment').mockResolvedValue({
            success: false,
            error: 'Simulated failure',
            paymentId: 'err-id',
            status: 'FAILED'
        });
        configurator.registerProvider(errorProvider);

        const result = await configurator.createPayment('error-prov', { amount: 10, currency: 'EUR', returnUrl: '', cancelUrl: '' });
        
        expect(result.success).toBe(false);
        expect(result.error).toBe('Simulated failure');
        expect(spyEmit).toHaveBeenCalledWith('payment.failed', {
            provider: 'error-prov',
            paymentId: 'err-id',
            orderId: undefined,
            status: 'FAILED',
            error: 'Simulated failure',
            verified: false,
            raw: undefined,
        });
    });

    it('should delegate executePayment and emit events with remembered orderId and raw', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        await configurator.createPayment('dummy', {
            amount: 10,
            currency: 'EUR',
            orderId: 'ORD-REMEMBERED',
            returnUrl: '',
            cancelUrl: '',
        });

        const result = await configurator.executePayment('dummy', 'dummy-123', { data: '123' });
        
        expect(result.success).toBe(true);
        expect(result.status).toBe('COMPLETED');
        expect(spyEmit).toHaveBeenCalledWith('payment.completed', {
            provider: 'dummy',
            paymentId: 'dummy-123',
            orderId: 'ORD-REMEMBERED',
            status: 'COMPLETED',
            error: undefined,
            verified: true,
            raw: { data: '123' },
        });
    });

    it('should delegate webhook handling with body and headers', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const result = await configurator.handleWebhook('dummy', { id: 'evt-1' }, { sign: '123' });
        expect(result.success).toBe(true);
        expect(result.status).toBe('WEBHOOK');
        expect(spyEmit).toHaveBeenCalledWith('webhook.received', {
            provider: 'dummy',
            paymentId: 'dummy-123',
            orderId: undefined,
            status: 'WEBHOOK',
            error: undefined,
            verified: true,
            data: { id: 'evt-1' },
            raw: { id: 'evt-1' },
        });
    });

    it('should forward query in handleWebhook and emit data: body ?? query', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const spyHandleWebhook = vi.spyOn(provider, 'handleWebhook');

        await configurator.handleWebhook('dummy', { id: 'evt-1' }, { sign: '123' }, { payment_id: 'X' });
        expect(spyHandleWebhook).toHaveBeenCalledWith(
            { id: 'evt-1' },
            { sign: '123' },
            { payment_id: 'X' },
            undefined,
        );

        await configurator.handleWebhook('dummy', undefined, {}, { payment_id: 'X' });
        expect(spyEmit).toHaveBeenCalledWith('webhook.received', {
            provider: 'dummy',
            paymentId: 'dummy-123',
            orderId: undefined,
            status: 'WEBHOOK',
            error: undefined,
            verified: true,
            data: { payment_id: 'X' },
            raw: { payment_id: 'X' },
        });
    });

    it('should delegate redirect handling', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const result = await configurator.handleRedirect('dummy', { id: 'test-id', order_id: 'ORD-REDIR' });
        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('test-id');
        expect(spyEmit).toHaveBeenCalledWith('payment.completed', {
            provider: 'dummy',
            paymentId: 'test-id',
            orderId: 'ORD-REDIR',
            status: 'REDIRECT',
            error: undefined,
            verified: true,
            raw: { id: 'test-id', order_id: 'ORD-REDIR' },
        });
    });

    it('should evict oldest entry when paymentOrders exceeds max capacity (bounded map)', () => {
        // Pre-fill to 10,000 capacity
        for (let i = 0; i < 10000; i++) {
            (configurator as any).setPaymentOrder(`pay-${i}`, `ord-${i}`);
        }
        expect((configurator as any).paymentOrders.size).toBe(10000);
        expect((configurator as any).paymentOrders.has('pay-0')).toBe(true);

        // Add one more entry
        (configurator as any).setPaymentOrder('pay-10000', 'ord-10000');
        expect((configurator as any).paymentOrders.size).toBe(10000);
        expect((configurator as any).paymentOrders.has('pay-0')).toBe(false);
        expect((configurator as any).paymentOrders.has('pay-10000')).toBe(true);
    });

    it('should ignore query.order_id on GET and HEAD webhooks in handleWebhook', async () => {
        // GET request with query.order_id
        const resultGet = await configurator.handleWebhook(
            'dummy',
            undefined,
            {},
            { payment_id: 'dummy-123', order_id: 'SPOOFED-GET' },
            { method: 'GET', path: '/checkout/dummy/webhook' },
        );
        expect(resultGet.orderId).toBeUndefined();

        // HEAD request with query.order_id
        const resultHead = await configurator.handleWebhook(
            'dummy',
            undefined,
            {},
            { payment_id: 'dummy-123', order_id: 'SPOOFED-HEAD' },
            { method: 'HEAD', path: '/checkout/dummy/webhook' },
        );
        expect(resultHead.orderId).toBeUndefined();
    });
});

