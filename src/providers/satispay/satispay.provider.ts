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
  /**
   * Satispay RSA public key in PEM format, used to verify incoming webhook
   * HTTP Signatures. Obtain it by calling GET /g_business/v1/consumers/{keyId}
   * on Satispay's API for the keyId present in the webhook Authorization header.
   * When provided, every inbound webhook whose signature cannot be verified is
   * rejected before any business logic is executed.
   */
  webhookPublicKey?: string;
  /** @default 'sandbox' */
  environment?: 'sandbox' | 'production';
  /**
   * Base URL of the host application.
   * Used to build the `callback_url` sent to Satispay.
   * Example: 'https://myapp.com'
   */
  serverUrl?: string;
  /**
   * Path component for the callback webhook URL.
   * @default '/checkout/satispay/webhook'
   */
  callbackPath?: string;
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

    if (!config.webhookPublicKey) {
      console.warn(
        '[SatispayProvider] webhookPublicKey is not configured: ' +
        'incoming webhook signatures will NOT be verified. ' +
        'Anyone who knows the webhook URL can send fake payment notifications. ' +
        'Set webhookPublicKey in SatispayProviderConfig before deploying to production.',
      );
    }
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

  /**
   * Verifies the HTTP Signature in an inbound Satispay webhook request.
   * Satispay signs webhooks with their own RSA private key; we verify using
   * the corresponding public key supplied in `config.webhookPublicKey`.
   *
   * Supports (request-target) via context or headers, and verifies signature over
   * headers with constant-time security.
   */
  verifyWebhookSignature(
    bodyOrHeaders?: unknown,
    headersOrBody?: Record<string, string> | unknown,
    context?: { method?: string; path?: string },
  ): boolean {
    if (!this.config.webhookPublicKey) {
      return true; // verification skipped — no public key configured
    }

    try {
      let body = bodyOrHeaders;
      let headers = headersOrBody as Record<string, string> | undefined;

      // Handle argument order flexibility: verifyWebhookSignature(body, headers) or (headers, body)
      if (
        typeof body === 'object' &&
        body !== null &&
        (('authorization' in body) || ('Authorization' in body) || ('signature' in body) || ('Signature' in body)) &&
        (!headers || !('authorization' in headers || 'signature' in headers))
      ) {
        headers = body as Record<string, string>;
        body = headersOrBody;
      }

      if (!headers) return false;

      const authHeader =
        (headers['authorization'] ??
        headers['Authorization'] ??
        headers['signature'] ??
        headers['Signature']) as string | undefined;

      if (!authHeader) return false;

      // Parse the Signature params from the Authorization header.
      // Format: Signature keyId="...", algorithm="...", headers="...", signature="..."
      // Use indexOf-based parsing to avoid ReDoS-prone regexes on untrusted input.
      const sigParams: Record<string, string> = {};
      const schemePrefix = 'Signature ';
      const paramStr = authHeader.startsWith(schemePrefix)
        ? authHeader.slice(schemePrefix.length)
        : authHeader;

      for (const part of paramStr.split(',')) {
        const eqIdx = part.indexOf('="');
        if (eqIdx === -1) continue;
        const key = part.slice(0, eqIdx).trim();
        const valueStart = eqIdx + 2;
        const valueEnd = part.lastIndexOf('"');
        if (valueEnd <= valueStart) continue;
        const value = part.slice(valueStart, valueEnd);
        if (key) sigParams[key] = value;
      }

      const { signature, headers: signedHeaders = '(request-target) host date digest' } = sigParams;
      if (!signature) return false;

      // Reconstruct the signed message from the incoming headers
      const headerNames = signedHeaders.split(' ');
      const headerDigest = headers['digest'] ?? headers['Digest'];
      const bodyString =
        body !== undefined && body !== null
          ? (typeof body === 'string' ? body : JSON.stringify(body))
          : '';
      const computedDigest =
        'SHA-256=' + crypto.createHash('sha256').update(bodyString).digest('base64');
      const digest = headerDigest ?? computedDigest;

      const parts: string[] = [];
      for (const name of headerNames) {
        if (name === '(request-target)') {
          const target =
            headers['(request-target)'] ??
            (context?.method && context?.path ? `${context.method.toLowerCase()} ${context.path}` : undefined);
          if (!target) return false;
          parts.push(`(request-target): ${target}`);
        } else if (name === 'digest') {
          parts.push(`digest: ${digest}`);
        } else {
          const value =
            headers[name] ??
            headers[name.toLowerCase()] ??
            headers[name.toUpperCase()];
          if (value === undefined) return false;
          parts.push(`${name}: ${value}`);
        }
      }
      const message = parts.join('\n');

      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(message);
      return verify.verify(this.config.webhookPublicKey, signature, 'base64');
    } catch {
      return false;
    }
  }

  private async request<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<T> {
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
      const callbackPath = this.config.callbackPath ?? '/checkout/satispay/webhook';

      // Satispay replaces {uuid} at runtime with the actual payment ID
      const callbackUrl =
        `${baseUrl}${callbackPath}?order_id=${encodeURIComponent(orderId)}&payment_id={uuid}`;

      const body = {
        flow: 'MATCH_CODE',
        amount_unit: Math.round(request.amount * 100),
        currency: request.currency,
        external_code: orderId,
        callback_url: callbackUrl,
        redirect_url: request.returnUrl,
        metadata: request.metadata,
      };

      const payment = await this.request<Record<string, unknown>>('POST', `${this.apiUrl}/payments`, body);

      // Persist the mapping orderId → paymentId for later webhook correlation
      await this.transactionStore.save(orderId, {
        provider: 'satispay',
        orderId,
        paymentId: payment['id'] as string,
        createdAt: new Date().toISOString(),
      });

      return {
        success: true,
        paymentId: payment['id'] as string,
        approvalUrl: (payment['redirect_url'] ?? payment['url_checkout']) as string | undefined,
        status: payment['status'] as string,
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
      const payment = await this.request<Record<string, unknown>>('GET', `${this.apiUrl}/payments/${paymentId}`);
      const amountUnit = payment['amount_unit'];
      const amount =
        amountUnit != null && !isNaN(Number(amountUnit)) ? Number(amountUnit) / 100 : undefined;
      const currency = payment['currency'] as string | undefined;

      return {
        success: true,
        paymentId: payment['id'] as string,
        status: payment['status'] as string,
        amount,
        currency,
        raw: payment,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Satispay payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    try {
      const body = amount ? { amount_unit: Math.round(amount * 100) } : {};
      const refund = await this.request<Record<string, unknown>>(
        'POST',
        `${this.apiUrl}/payments/${paymentId}/refunds`,
        body,
      );
      return {
        success: true,
        paymentId: refund['id'] as string,
        status: refund['status'] as string,
        raw: refund,
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to refund Satispay payment');
    }
  }

  /**
   * Handles the async webhook notification from Satispay.
   * Satispay calls this URL with `payment_id` (the Satispay payment UUID).
   * The HTTP Signature in the Authorization header is verified against
   * `config.webhookPublicKey` (when configured) before processing.
   * We then confirm the payment status via an authenticated API call.
   */
  async handleWebhook(
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
    context?: { method?: string; path?: string },
  ): Promise<WebhookResult> {
    if (!this.verifyWebhookSignature(body, headers, context)) {
      return { success: false, error: 'Webhook signature verification failed' };
    }

    const b = body ?? {};
    const paymentId: string | undefined =
      (b['payment_id'] as string | undefined) ??
      (b['id'] as string | undefined) ??
      query['payment_id'];
    if (!paymentId) {
      return { success: false, error: 'Missing payment_id in webhook body or query' };
    }
    try {
      const payment = await this.request<Record<string, unknown>>('GET', `${this.apiUrl}/payments/${paymentId}`);
      const amountUnit = payment['amount_unit'];
      const amount =
        amountUnit != null && !isNaN(Number(amountUnit)) ? Number(amountUnit) / 100 : undefined;
      const currency = payment['currency'] as string | undefined;

      return {
        success: payment['status'] === 'ACCEPTED',
        paymentId: payment['id'] as string,
        status: payment['status'] as string,
        amount,
        currency,
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
  async handleRedirect(query: Record<string, string>): Promise<PaymentResult> {
    const orderId = query['order_id'];
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
      amount: details.amount,
      currency: details.currency,
      raw: details.raw,
    };
  }
}
