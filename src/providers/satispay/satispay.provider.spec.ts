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

    beforeAll(() => {
        // Generate a fast valid RSA key for the Node crypto decoder to accept
        const { privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
        } as any);
        validFakePrivateKey = privateKey as string;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        store = new MockTransactionStore();
        provider = new SatispayProvider({
            keyId: 'test-key',
            privateKey: validFakePrivateKey,
            environment: 'sandbox',
            serverUrl: 'http://localhost',
            transactionStore: store
        });

        // Mock global fetch
        global.fetch = vi.fn();
    });

    it('should successfully create a payment', async () => {
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
    });

    it('should handle fetch errors gracefully', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network error'));

        const result = await provider.createPayment({ amount: 10, currency: 'EUR', returnUrl: 'http://loc/ret', cancelUrl: 'http://loc/can' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error');
    });

    it('should execute/get payment details', async () => {
        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-123',
                status: 'ACCEPTED'
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.executePayment('SAT-123');

        expect(result.success).toBe(true);
        expect(result.status).toBe('ACCEPTED');
    });

    it('should handle incoming webhook correctly', async () => {
        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-123',
                status: 'ACCEPTED'
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.handleWebhook({ payment_id: 'SAT-123' }, {});

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-123');
        expect(result.status).toBe('ACCEPTED');
    });

    it('should handle redirects correctly fetching from store', async () => {
        await store.save('ORD-2', { paymentId: 'SAT-456' });

        const mockResponse = {
            ok: true,
            text: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'SAT-456',
                status: 'ACCEPTED'
            }))
        };
        (global.fetch as any).mockResolvedValue(mockResponse);

        const result = await provider.handleRedirect({ order_id: 'ORD-2' });

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('SAT-456');

        // Check if transaction was deleted upon successful resolution
        const saved = await store.get('ORD-2');
        expect(saved).toBeUndefined();
    });

    it('should return error on redirect if order is not in store', async () => {
        const result = await provider.handleRedirect({ order_id: 'UNKNOWN' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Transaction not found');
    });
});
