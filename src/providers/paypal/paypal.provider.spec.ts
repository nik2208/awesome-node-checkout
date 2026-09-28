import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PayPalProvider } from './paypal.provider';
import * as PayPalSDK from '@paypal/paypal-server-sdk';
import { PaymentRequest } from '../../models/payment-request.model';

// Mock of PayPal Server SDK v2
const mockCaptureOrder = vi.fn().mockResolvedValue({
    result: {
        id: 'PAYPAL-ORD-123',
        status: 'COMPLETED',
        purchaseUnits: [{
            payments: {
                captures: [{
                    id: 'CAPTURE-123',
                    status: 'COMPLETED',
                    amount: { currencyCode: 'EUR', value: '50.00' }
                }]
            }
        }]
    }
});

const mockGetOrder = vi.fn().mockResolvedValue({
    result: {
        id: 'PAYPAL-ORD-123',
        status: 'COMPLETED',
        purchaseUnits: [{
            payments: {
                captures: [{
                    id: 'CAPTURE-123',
                    status: 'COMPLETED',
                    amount: { currencyCode: 'EUR', value: '50.00' }
                }]
            }
        }]
    }
});

const mockCreateOrder = vi.fn().mockResolvedValue({
    result: {
        id: 'PAYPAL-ORD-123',
        status: 'CREATED',
        links: [
            { rel: 'approve', href: 'https://sandbox.paypal.com/checkout?token=PAYPAL-ORD-123' }
        ]
    }
});

const mockRefundCapturedPayment = vi.fn().mockResolvedValue({
    result: {
        id: 'REFUND-123',
        status: 'COMPLETED'
    }
});

vi.mock('@paypal/paypal-server-sdk', () => {
    return {
        Environment: {
            Sandbox: class { constructor() {} },
            Production: class { constructor() {} }
        },
        LogLevel: { Error: 'error' },
        Client: class { constructor() {} },
        OrdersController: class {
            createOrder = mockCreateOrder;
            captureOrder = mockCaptureOrder;
            getOrder = mockGetOrder;
        },
        PaymentsController: class {
            refundCapturedPayment = mockRefundCapturedPayment;
        }
    };
});

describe('PayPalProvider', () => {
    let provider: PayPalProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new PayPalProvider({
            clientId: 'mock-client-id',
            clientSecret: 'mock-client-secret',
            environment: 'sandbox'
        });
    });

    it('should initialize with Sandbox environment', () => {
        expect(provider).toBeInstanceOf(PayPalProvider);
    });

    it('should successfully create a payment and return approvalUrl', async () => {
        const req: PaymentRequest = {
            amount: 50.00,
            currency: 'EUR',
            returnUrl: 'http://localhost/success',
            cancelUrl: 'http://localhost/cancel',
            description: 'Test purchase'
        };

        const result = await provider.createPayment(req);

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('PAYPAL-ORD-123');
        expect(result.status).toBe('CREATED');
        expect(result.approvalUrl).toBe('https://sandbox.paypal.com/checkout?token=PAYPAL-ORD-123');
    });

    it('should successfully execute/capture a payment with prefer: return=representation and return amount/currency', async () => {
        const result = await provider.executePayment('PAYPAL-ORD-123');

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('PAYPAL-ORD-123');
        expect(result.status).toBe('COMPLETED');
        expect(result.amount).toBe(50);
        expect(result.currency).toBe('EUR');

        expect(mockCaptureOrder).toHaveBeenCalledWith({
            id: 'PAYPAL-ORD-123',
            body: {},
            prefer: 'return=representation',
        });
    });

    it('should return amount and currency in getPaymentDetails via completed capture', async () => {
        const result = await provider.getPaymentDetails('PAYPAL-ORD-123');

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('PAYPAL-ORD-123');
        expect(result.status).toBe('COMPLETED');
        expect(result.amount).toBe(50);
        expect(result.currency).toBe('EUR');
    });

    it('should return success: false and amount: undefined when order has no capture', async () => {
        (provider as any).ordersController = {
            getOrder: vi.fn().mockResolvedValue({
                result: {
                    id: 'PAYPAL-ORD-NO-CAPTURE',
                    status: 'COMPLETED',
                    purchaseUnits: [{}]
                }
            })
        };

        const result = await provider.getPaymentDetails('PAYPAL-ORD-NO-CAPTURE');
        expect(result.success).toBe(false);
        expect(result.amount).toBeUndefined();
    });

    it('should return success: false when capture is PENDING or DECLINED despite order COMPLETED', async () => {
        (provider as any).ordersController = {
            captureOrder: vi.fn().mockResolvedValue({
                result: {
                    id: 'PAYPAL-ORD-PENDING',
                    status: 'COMPLETED',
                    purchaseUnits: [{
                        payments: {
                            captures: [{
                                id: 'CAPTURE-PENDING',
                                status: 'PENDING',
                                amount: { currencyCode: 'EUR', value: '50.00' }
                            }]
                        }
                    }]
                }
            })
        };

        const result = await provider.executePayment('PAYPAL-ORD-PENDING');
        expect(result.success).toBe(false);
        expect(result.status).toBe('PENDING');
        expect(result.amount).toBe(50);

        (provider as any).ordersController = {
            captureOrder: vi.fn().mockResolvedValue({
                result: {
                    id: 'PAYPAL-ORD-DECLINED',
                    status: 'COMPLETED',
                    purchaseUnits: [{
                        payments: {
                            captures: [{
                                id: 'CAPTURE-DECLINED',
                                status: 'DECLINED',
                                amount: { currencyCode: 'EUR', value: '50.00' }
                            }]
                        }
                    }]
                }
            })
        };

        const declinedResult = await provider.executePayment('PAYPAL-ORD-DECLINED');
        expect(declinedResult.success).toBe(false);
        expect(declinedResult.status).toBe('DECLINED');
        expect(declinedResult.amount).toBe(50);
    });

    it('should return undefined amount when capture value is empty string or whitespace', async () => {
        (provider as any).ordersController = {
            getOrder: vi.fn().mockResolvedValue({
                result: {
                    id: 'PAYPAL-ORD-EMPTY-STR',
                    status: 'COMPLETED',
                    purchaseUnits: [{
                        payments: {
                            captures: [{
                                id: 'CAPTURE-EMPTY',
                                status: 'COMPLETED',
                                amount: { currencyCode: 'EUR', value: '   ' }
                            }]
                        }
                    }]
                }
            })
        };

        const result = await provider.getPaymentDetails('PAYPAL-ORD-EMPTY-STR');
        expect(result.amount).toBeUndefined();
    });

    it('should gracefully handle order creation API failures', async () => {
        const errorProvider = new PayPalProvider({
            clientId: 'mock-client-id',
            clientSecret: 'mock-client-secret',
            environment: 'sandbox'
        });

        (errorProvider as any).ordersController = {
            createOrder: vi.fn().mockRejectedValue(new Error('Network error Paypal API'))
        };

        const req: PaymentRequest = {
            amount: 10.00,
            currency: 'USD',
            returnUrl: 'http://localhost/success',
            cancelUrl: 'http://localhost/cancel'
        };

        const result = await errorProvider.createPayment(req);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network error Paypal API');
    });

    it('should successfully refund a captured payment', async () => {
        const result = await provider.refundPayment('PAYPAL-ORD-123');

        expect(result.success).toBe(true);
        expect(result.paymentId).toBe('REFUND-123');
        expect(result.status).toBe('COMPLETED');
    });

    it('should return failure when no capture is found for the order', async () => {
        (provider as any).ordersController = {
            getOrder: vi.fn().mockResolvedValue({
                result: {
                    id: 'PAYPAL-ORD-NO-CAPTURE',
                    purchaseUnits: [{ payments: { captures: [] } }]
                }
            })
        };

        const result = await provider.refundPayment('PAYPAL-ORD-NO-CAPTURE');

        expect(result.success).toBe(false);
        expect(result.error).toContain('No capture found');
    });
});
