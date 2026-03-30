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
  async handleWebhook(body: any, headers: Record<string, string>): Promise<WebhookResult> {
    return { success: true, paymentId: 'dummy-123', status: 'WEBHOOK', raw: body };
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

    it('should delegate createPayment and emit events', async () => {
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
            error: undefined
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
            error: 'Simulated failure'
        });
    });

    it('should delegate executePayment and emit events', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        
        const result = await configurator.executePayment('dummy', 'test-id', { data: '123' });
        
        expect(result.success).toBe(true);
        expect(result.status).toBe('COMPLETED');
        expect(spyEmit).toHaveBeenCalledWith('payment.completed', {
            provider: 'dummy',
            paymentId: 'test-id',
            status: 'COMPLETED',
            error: undefined
        });
    });

    it('should delegate webhook handling', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const result = await configurator.handleWebhook('dummy', { id: 'evt-1' }, { sign: '123' });
        expect(result.success).toBe(true);
        expect(result.status).toBe('WEBHOOK');
        expect(spyEmit).toHaveBeenCalledWith('webhook.received', {
            provider: 'dummy',
            paymentId: 'dummy-123',
            status: 'WEBHOOK',
            error: undefined,
            data: { id: 'evt-1' }
        });
    });

    it('should delegate redirect handling', async () => {
        const spyEmit = vi.spyOn(configurator.events, 'emit');
        const result = await configurator.handleRedirect('dummy', { id: 'test-id' });
        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('test-id');
        expect(spyEmit).toHaveBeenCalledWith('payment.completed', {
            provider: 'dummy',
            paymentId: 'test-id',
            status: 'REDIRECT',
            error: undefined
        });
    });
});
