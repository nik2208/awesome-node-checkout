import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
} from '@paypal/paypal-server-sdk';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';

export interface PayPalProviderConfig {
  clientId: string;
  clientSecret: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'live';
}

/**
 * PayPal Checkout provider.
 * Flow: `redirect` — creates an order, redirects the user to PayPal,
 * then captures the payment on return via `handleRedirect`.
 */
export class PayPalProvider extends BasePaymentProvider {
  readonly name = 'paypal';
  readonly flow = 'redirect' as const;

  private client: Client;
  private ordersController: OrdersController;

  constructor(private readonly config: PayPalProviderConfig) {
    super();
    const { clientId, clientSecret, environment = 'sandbox' } = config;

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      environment:
        environment === 'live' ? Environment.Production : Environment.Sandbox,
      logging: {
        logLevel: LogLevel.Error,
      },
    });

    this.ordersController = new OrdersController(this.client);
  }

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const { result: order } = await this.ordersController.createOrder({
        body: {
          intent: 'CAPTURE' as any,
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

      const approvalUrl = order.links?.find(
        (l: any) => l.rel === 'payer-action' || l.rel === 'approve',
      )?.href;

      return {
        success: true,
        paymentId: order.id as string,
        approvalUrl,
        status: order.status as string,
        raw: order,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to create PayPal payment');
    }
  }

  async executePayment(paymentId: string): Promise<PaymentResult> {
    try {
      const { result: order } = await this.ordersController.captureOrder({
        id: paymentId,
        body: {},
      });

      return {
        success: order.status === 'COMPLETED',
        paymentId: order.id as string,
        status: order.status as string,
        raw: order,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to execute PayPal payment');
    }
  }

  async getPaymentDetails(paymentId: string): Promise<PaymentResult> {
    try {
      const { result: order } = await this.ordersController.getOrder({
        id: paymentId,
      });

      return {
        success: true,
        paymentId: order.id as string,
        status: order.status as string,
        raw: order,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get PayPal payment details');
    }
  }

  async refundPayment(paymentId: string): Promise<PaymentResult> {
    // Full refund via PayPal requires the capture ID, not the order ID.
    // Retrieve order details first, extract the capture ID, then POST to
    // /v2/payments/captures/{captureId}/refund.
    // This is left as a note since it requires additional API calls.
    return {
      success: false,
      error:
        'PayPal refund requires the capture ID. ' +
        'Retrieve it from getPaymentDetails(), then call the PayPal Refunds API directly.',
      paymentId,
      status: 'REFUND_REQUIRES_CAPTURE_ID',
    };
  }

  /**
   * Handles the redirect from PayPal after the user approves the payment.
   * PayPal appends `token` (order ID) and `PayerID` to the returnUrl.
   */
  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    const paymentId = query.token as string | undefined;
    if (!paymentId) {
      return {
        success: false,
        error: 'Missing token in PayPal redirect query',
      };
    }
    return this.executePayment(paymentId);
  }
}
