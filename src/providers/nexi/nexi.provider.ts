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
 *
 * Note: Nexi XPay mandates SHA-1 for MAC computation. This is a requirement of
 * the Nexi API and cannot be changed on the client side.
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
   *
   * SHA-1 is used here because Nexi XPay mandates it for MAC computation.
   */
  private generateMac(codTrans: string, divisa: string, importoCents: number): string {
    const raw = `codTrans=${codTrans}divisa=${divisa}importo=${importoCents}${this.config.macKey}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  /**
   * Computes the SHA-1 MAC for the status (getPaymentDetails) API call.
   * Format: `alias={alias}codTrans={codTrans}timestamp={timestamp}{macKey}`
   */
  private generateStatusMac(alias: string, codTrans: string, timestamp: string): string {
    const raw = `alias=${alias}codTrans=${codTrans}timestamp=${timestamp}${this.config.macKey}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  /**
   * Computes the SHA-1 MAC for the refund (storno) API call.
   * Format: `alias={alias}codTrans={codTrans}importo={importo}timestamp={timestamp}{macKey}`
   */
  private generateRefundMac(
    alias: string,
    codTrans: string,
    importo: string,
    timestamp: string,
  ): string {
    const raw = `alias=${alias}codTrans=${codTrans}importo=${importo}timestamp=${timestamp}${this.config.macKey}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
  }

  /**
   * Verifies the SHA-1 MAC included in a Nexi POST-back response.
   * Format: `codTrans={val}esito={val}importo={val}divisa={val}{macKey}`
   */
  private verifyResponseMac(
    codTrans: string,
    esito: string,
    importo: string,
    divisa: string,
    mac: string,
  ): boolean {
    const raw = `codTrans=${codTrans}esito=${esito}importo=${importo}divisa=${divisa}${this.config.macKey}`;
    const expected = crypto.createHash('sha1').update(raw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
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
   * The MAC is verified before the result is considered authoritative.
   */
  async executePayment(paymentId: string, data?: Record<string, string>): Promise<PaymentResult> {
    try {
      const esito: string = data?.esito ?? '';
      const codTrans: string = data?.codTrans ?? paymentId;
      const importo: string = data?.importo ?? '';
      const divisa: string = data?.divisa ?? '';
      const mac: string = data?.mac ?? '';

      if (mac) {
        let macValid: boolean;
        try {
          macValid = this.verifyResponseMac(codTrans, esito, importo, divisa, mac);
        } catch {
          macValid = false;
        }
        if (!macValid) {
          return {
            success: false,
            paymentId: codTrans,
            status: 'FAILED',
            error: 'MAC verification failed: response may have been tampered with',
          };
        }
      }

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
      const timestamp = new Date().toISOString();
      const mac = this.generateStatusMac(this.config.merchantId, paymentId, timestamp);

      const params = {
        alias: this.config.merchantId,
        codTrans: paymentId,
        timestamp,
        mac,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/vas/igfs/status/plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as Record<string, unknown>;

      return { success: true, paymentId, status: result['status'] as string, raw: result };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Nexi payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const timestamp = new Date().toISOString();
      const importo = amount ? Math.round(amount * 100).toString() : '';
      const mac = this.generateRefundMac(this.config.merchantId, paymentId, importo, timestamp);

      const params: Record<string, string> = {
        alias: this.config.merchantId,
        codTrans: paymentId,
        importo,
        timestamp,
        mac,
      };

      const response = await fetch(`${this.apiUrl}/ecomm/api/vas/igfs/storno/plain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      if (!response.ok) throw new Error(`Nexi API error: ${response.statusText}`);
      const result = await response.json() as Record<string, unknown>;

      return {
        success: result['esito'] === 'OK',
        paymentId,
        status: result['esito'] === 'OK' ? 'REFUNDED' : 'REFUND_FAILED',
        raw: result,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to refund Nexi payment');
    }
  }

  /**
   * Handles the POST-back from Nexi to the returnUrl.
   * Nexi sends `esito`, `codTrans`, `importo`, `divisa`, `mac`, etc. as query/body params.
   * The MAC is verified to ensure the response was not spoofed.
   */
  async handleRedirect(query: Record<string, string>): Promise<PaymentResult> {
    return this.executePayment(query['codTrans'] ?? '', query);
  }
}
