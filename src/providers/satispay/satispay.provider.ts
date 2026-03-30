import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { ITransactionStore } from '../../interfaces/transaction-store.interface';
import { InMemoryTransactionStore } from '../../stores/in-memory-transaction.store';

export interface SatispayProviderConfig {
  keyId: string;
  /**
   * RSA private key in PEM format (string content, not a file path).
   * Load with: `fs.readFileSync('private.pem', 'utf8')`
   */
  privateKey: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'production';
  /**
   * Base URL of the host application.
   * Used to build the `callback_url` sent to Satispay.
   * Example: 'https://myapp.com'
   */
  serverUrl?: string;
  /**
   * Custom transaction store for correlating webhooks with orders.
   * Defaults to InMemoryTransactionStore.
   * Use a persistent store (Redis, DB) in multi-instance deployments.
   */
  transactionStore?: ITransactionStore;
}

/**
 * Satispay Business API provider.
 * Flow: `webhook` — creates a MATCH_CODE payment, user pays via Satispay app,
 * Satispay calls the `callback_url` webhook, which is correlated to the order
 * via the `ITransactionStore`. The redirect is then verified via `handleRedirect`.
 */
export class SatispayProvider extends BasePaymentProvider {
  readonly name = 'satispay';
  readonly flow = 'webhook' as const;

  private readonly apiUrl: string;
  private readonly transactionStore: ITransactionStore;

  constructor(private readonly config: SatispayProviderConfig) {
    super();
    this.apiUrl =
      config.environment === 'production'
        ? 'https://authservices.satispay.com/g_business/v1'
        : 'https://staging.authservices.satispay.com/g_business/v1';
    this.transactionStore = config.transactionStore ?? new InMemoryTransactionStore();
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  private buildSignatureHeaders(
    method: string,
    path: string,
    host: string,
    body?: unknown,
  ): Record<string, string> {
    const bodyString = body ? JSON.stringify(body) : '';
    const digest =
      'SHA-256=' + crypto.createHash('sha256').update(bodyString).digest('base64');
    const date = new Date().toUTCString();
    const requestTarget = `${method.toLowerCase()} ${path}`;

    const message =
      `(request-target): ${requestTarget}\n` +
      `host: ${host}\n` +
      `date: ${date}\n` +
      `digest: ${digest}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    const signature = sign.sign(this.config.privateKey, 'base64');

    const authorization =
      `Signature keyId="${this.config.keyId}", algorithm="rsa-sha256", ` +
      `headers="(request-target) host date digest", signature="${signature}"`;

    return {
      'Content-Type': 'application/json',
      'Host': host,
      'Date': date,
      'Digest': digest,
      'Authorization': authorization,
    };
  }

  private async request<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const parsed = new URL(url);
    const headers = this.buildSignatureHeaders(method, parsed.pathname, parsed.host, body);

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Satispay API ${response.status}: ${text}`);
    }

    return JSON.parse(text) as T;
  }

  // ---------------------------------------------------------------------------
  // IPaymentProvider implementation
  // ---------------------------------------------------------------------------

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const orderId = request.orderId ?? `ORD-${Date.now()}`;
      const baseUrl = this.config.serverUrl ?? '';

      // Satispay replaces {uuid} at runtime with the actual payment ID
      const callbackUrl =
        `${baseUrl}/checkout/satispay/webhook?order_id=${orderId}&payment_id={uuid}`;

      const body = {
        flow: 'MATCH_CODE',
        amount_unit: Math.round(request.amount * 100),
        currency: request.currency,
        external_code: orderId,
        callback_url: callbackUrl,
        redirect_url: request.returnUrl,
        metadata: request.metadata,
      };

      const payment = await this.request<any>('POST', `${this.apiUrl}/payments`, body);

      // Persist the mapping orderId → paymentId for later webhook correlation
      await this.transactionStore.save(orderId, {
        provider: 'satispay',
        orderId,
        paymentId: payment.id,
        createdAt: new Date().toISOString(),
      });

      return {
        success: true,
        paymentId: payment.id,
        approvalUrl: payment.redirect_url ?? payment.url_checkout,
        status: payment.status,
        raw: payment,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to create Satispay payment');
    }
  }

  /** For Satispay, execute is equivalent to a status check */
  async executePayment(paymentId: string): Promise<PaymentResult> {
    return this.getPaymentDetails(paymentId);
  }

  async getPaymentDetails(paymentId: string): Promise<PaymentResult> {
    try {
      const payment = await this.request<any>('GET', `${this.apiUrl}/payments/${paymentId}`);
      return {
        success: true,
        paymentId: payment.id,
        status: payment.status,
        raw: payment,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Satispay payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const body = amount ? { amount_unit: Math.round(amount * 100) } : {};
      const refund = await this.request<any>(
        'POST',
        `${this.apiUrl}/payments/${paymentId}/refunds`,
        body,
      );
      return {
        success: true,
        paymentId: refund.id,
        status: refund.status,
        raw: refund,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to refund Satispay payment');
    }
  }

  /**
   * Handles the async webhook notification from Satispay.
   * Satispay calls this URL with `payment_id` (the Satispay payment UUID).
   * We verify the current payment status via an API call.
   */
  async handleWebhook(body: any, _headers: Record<string, string>): Promise<WebhookResult> {
    const paymentId: string | undefined = body.payment_id ?? body.id;
    if (!paymentId) {
      return { success: false, error: 'Missing payment_id in webhook body' };
    }
    try {
      const payment = await this.request<any>('GET', `${this.apiUrl}/payments/${paymentId}`);
      return {
        success: payment.status === 'ACCEPTED',
        paymentId: payment.id,
        status: payment.status,
        raw: payment,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Webhook handling failed';
      return { success: false, paymentId, error: msg };
    }
  }

  /**
   * Handles the redirect back to the merchant app after the Satispay flow.
   * Looks up the transaction by `order_id` in the store, then verifies status.
   */
  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    const orderId = query.order_id as string | undefined;
    if (!orderId) {
      return { success: false, error: 'Missing order_id in redirect query' };
    }

    const transaction = await this.transactionStore.get(orderId);
    if (!transaction?.paymentId) {
      return {
        success: false,
        error: `Transaction not found for order '${orderId}'. ` +
          'Ensure the webhook was received before the redirect.',
      };
    }

    const details = await this.getPaymentDetails(transaction.paymentId);

    if (details.success && details.status === 'ACCEPTED') {
      await this.transactionStore.delete(orderId);
    }

    return {
      success: details.success && details.status === 'ACCEPTED',
      paymentId: details.paymentId,
      status: details.status,
      raw: details.raw,
    };
  }
}
