import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  PaymentsController,
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
  private paymentsController: PaymentsController;

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
    this.paymentsController = new PaymentsController(this.client);
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

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      // Retrieve order to find the capture ID and currency
      const { result: order } = await this.ordersController.getOrder({ id: paymentId });

      // The PayPal SDK types nested objects as `any`; extract with explicit guards
      const purchaseUnit = Array.isArray((order as any)?.purchaseUnits)
        ? (order as any).purchaseUnits[0]
        : undefined;
      const captureId: string | undefined =
        Array.isArray(purchaseUnit?.payments?.captures) && purchaseUnit.payments.captures.length > 0
          ? String(purchaseUnit.payments.captures[0].id)
          : undefined;

      if (!captureId) {
        return {
          success: false,
          error: 'No capture found for this order. Ensure the payment has been captured before refunding.',
          paymentId,
          status: 'REFUND_FAILED',
        };
      }

      const refundBody: Record<string, unknown> = {};
      if (amount !== undefined) {
        const currencyCode = typeof purchaseUnit?.amount?.currencyCode === 'string'
          ? purchaseUnit.amount.currencyCode
          : undefined;
        if (!currencyCode) {
          return {
            success: false,
            error: 'Cannot determine currency code from order. Refund a specific amount is not possible.',
            paymentId,
            status: 'REFUND_FAILED',
          };
        }
        refundBody['amount'] = { value: amount.toFixed(2), currencyCode };
      }

      const { result: refund } = await this.paymentsController.refundCapturedPayment({
        captureId,
        body: refundBody as any,
      });

      return {
        success: (refund as any)?.status === 'COMPLETED',
        paymentId: String((refund as any)?.id ?? ''),
        status: String((refund as any)?.status ?? ''),
        raw: refund,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to refund PayPal payment');
    }
  }

  /**
   * Handles the redirect from PayPal after the user approves the payment.
   * PayPal appends `token` (order ID) and `PayerID` to the returnUrl.
   */
  async handleRedirect(query: Record<string, string>): Promise<PaymentResult> {
    const paymentId = query['token'];
    if (!paymentId) {
      return {
        success: false,
        error: 'Missing token in PayPal redirect query',
      };
    }
    return this.executePayment(paymentId);
  }
}
