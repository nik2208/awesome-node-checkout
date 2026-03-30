"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PayPalProvider = void 0;
const paypal_server_sdk_1 = require("@paypal/paypal-server-sdk");
const base_payment_provider_abstract_1 = require("../../abstract/base-payment-provider.abstract");
/**
 * PayPal Checkout provider.
 * Flow: `redirect` — creates an order, redirects the user to PayPal,
 * then captures the payment on return via `handleRedirect`.
 */
class PayPalProvider extends base_payment_provider_abstract_1.BasePaymentProvider {
    constructor(config) {
        super();
        this.config = config;
        this.name = 'paypal';
        this.flow = 'redirect';
        const { clientId, clientSecret, environment = 'sandbox' } = config;
        this.client = new paypal_server_sdk_1.Client({
            clientCredentialsAuthCredentials: {
                oAuthClientId: clientId,
                oAuthClientSecret: clientSecret,
            },
            environment: environment === 'live' ? paypal_server_sdk_1.Environment.Production : paypal_server_sdk_1.Environment.Sandbox,
            logging: {
                logLevel: paypal_server_sdk_1.LogLevel.Error,
            },
        });
        this.ordersController = new paypal_server_sdk_1.OrdersController(this.client);
    }
    async createPayment(request) {
        try {
            const { result: order } = await this.ordersController.createOrder({
                body: {
                    intent: 'CAPTURE',
                    purchaseUnits: [
                        {
                            amount: {
                                currencyCode: request.currency,
                                value: request.amount.toFixed(2),
                            },
                            description: request.description,
                        },
                    ],
                    paymentSource: {
                        paypal: {
                            experienceContext: {
                                returnUrl: request.returnUrl,
                                cancelUrl: request.cancelUrl,
                            },
                        },
                    },
                },
                prefer: 'return=representation',
            });
            const approvalUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
            return {
                success: true,
                paymentId: order.id,
                approvalUrl,
                status: order.status,
                raw: order,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to create PayPal payment');
        }
    }
    async executePayment(paymentId) {
        try {
            const { result: order } = await this.ordersController.captureOrder({
                id: paymentId,
                body: {},
            });
            return {
                success: order.status === 'COMPLETED',
                paymentId: order.id,
                status: order.status,
                raw: order,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to execute PayPal payment');
        }
    }
    async getPaymentDetails(paymentId) {
        try {
            const { result: order } = await this.ordersController.getOrder({
                id: paymentId,
            });
            return {
                success: true,
                paymentId: order.id,
                status: order.status,
                raw: order,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to get PayPal payment details');
        }
    }
    async refundPayment(paymentId) {
        // Full refund via PayPal requires the capture ID, not the order ID.
        // Retrieve order details first, extract the capture ID, then POST to
        // /v2/payments/captures/{captureId}/refund.
        // This is left as a note since it requires additional API calls.
        return {
            success: false,
            error: 'PayPal refund requires the capture ID. ' +
                'Retrieve it from getPaymentDetails(), then call the PayPal Refunds API directly.',
            paymentId,
            status: 'REFUND_REQUIRES_CAPTURE_ID',
        };
    }
    /**
     * Handles the redirect from PayPal after the user approves the payment.
     * PayPal appends `token` (order ID) and `PayerID` to the returnUrl.
     */
    async handleRedirect(query) {
        const paymentId = query.token;
        if (!paymentId) {
            return {
                success: false,
                error: 'Missing token in PayPal redirect query',
            };
        }
        return this.executePayment(paymentId);
    }
}
exports.PayPalProvider = PayPalProvider;
//# sourceMappingURL=paypal.provider.js.map