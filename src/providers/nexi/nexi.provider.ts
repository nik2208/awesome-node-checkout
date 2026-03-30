import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';

export interface NexiProviderConfig {
  merchantId: string;
  macKey: string;
  /** Optional group identifier */
  group?: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'production';
}

/**
 * Nexi eCommerce provider.
 * Flow: `redirect` — builds a signed checkout URL, redirects the user to Nexi,
 * then handles the POST-back via `handleRedirect`.
 */
export class NexiProvider extends BasePaymentProvider {
  readonly name = 'nexi';
  readonly flow = 'redirect' as const;

  private readonly apiUrl: string;

  constructor(private readonly config: NexiProviderConfig) {
    super();
    this.apiUrl =
      config.environment === 'production'
        ? 'https://ecommerce.nexi.it'
        : 'https://int-ecommerce.nexi.it';
  }

  /**
   * Computes the SHA-1 MAC required by Nexi to authenticate the payment request.
   * Format: `codTrans={val}divisa={val}importo={val}{macKey}`
   */
  private generateMac(codTrans: string, divisa: string, importoCents: number): string {
    const raw = `codTrans=${codTrans}divisa=${divisa}importo=${importoCents}${this.config.macKey}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const amountCents = Math.round(request.amount * 100);
      const orderId = request.orderId ?? `ORD-${Date.now()}`;
      const mac = this.generateMac(orderId, request.currency, amountCents);

      const params: Record<string, string> = {
        alias: this.config.merchantId,
        importo: amountCents.toString(),
        divisa: request.currency,
        codTrans: orderId,
        url: request.returnUrl,
        url_back: request.cancelUrl,
        mac,
      };

      if (this.config.group) {
        params.gruppo = this.config.group;
      }

      const approvalUrl = `${this.apiUrl}/ecomm/ecomm/DispatcherServlet?${new URLSearchParams(params)}`;

      return {
        success: true,
        paymentId: orderId,
        approvalUrl,
        status: 'CREATED',
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to create Nexi payment');
    }
  }

  /**
   * Validates the POST-back data from Nexi.
   * `data` is the query/body object sent by Nexi to the returnUrl.
   */
  async executePayment(paymentId: string, data?: any): Promise<PaymentResult> {
    try {
      const esito: string = data?.esito ?? '';
      const codTrans: string = data?.codTrans ?? paymentId;
      return {
        success: esito === 'OK',
        paymentId: codTrans,
        status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
        raw: data,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to execute Nexi payment');
    }
  }

  async getPaymentDetails(paymentId: string): Promise<PaymentResult> {
    try {
      const params = {
        alias: this.config.merchantId,
        codTrans: paymentId,
        timestamp: new Date().toISOString(),
        mac: this.config.macKey,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/vas/igfs/status/plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as any;

      return { success: true, paymentId, status: result.status, raw: result };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Nexi payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const params: Record<string, string> = {
        alias: this.config.merchantId,
        codTrans: paymentId,
        importo: amount ? Math.round(amount * 100).toString() : '',
        timestamp: new Date().toISOString(),
        mac: this.config.macKey,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/vas/igfs/storno/plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as any;

      return {
        success: result.esito === 'OK',
        paymentId,
        status: result.esito === 'OK' ? 'REFUNDED' : 'REFUND_FAILED',
        raw: result,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to refund Nexi payment');
    }
  }

  /**
   * Handles the POST-back from Nexi to the returnUrl.
   * Nexi sends `esito`, `codTrans`, `importo`, `mac`, etc. as query/body params.
   */
  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    return this.executePayment(query.codTrans as string, query);
  }
}
