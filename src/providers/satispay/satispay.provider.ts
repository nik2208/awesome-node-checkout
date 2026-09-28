import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { ITransactionStore } from '../../interfaces/transaction-store.interface';
import { InMemoryTransactionStore } from '../../stores/in-memory-transaction.store';
import { parseAmountFromCents, parseNexiCurrency } from '../../utils/parsing.util';

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
   * Maximum acceptable age of the webhook `Date` header in milliseconds.
   * Requests older than this window are rejected to prevent replay attacks.
   * @default 300_000 (5 minutes)
   */
  signatureMaxAgeMs?: number;
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
  /**
   * Validates that the payment ID contains only safe alphanumeric/hyphen characters.
   */
  private isValidPaymentId(id: unknown): id is string {
    return (
      typeof id === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
      !id.includes('/') &&
      !id.includes('..')
    );
  }

  /**
   * Verifies the HTTP Signature in an inbound Satispay webhook request.
   * Satispay signs webhooks with their own RSA private key; we verify using
   * the corresponding public key supplied in `config.webhookPublicKey`.
   *
   * Validates:
   * - Presence and format of Authorization/Signature header
   * - Freshness of Date header within `signatureMaxAgeMs` (default 5 minutes)
   * - Exact match between Digest header and SHA-256 of raw body
   * - (request-target) exclusively from context (never client body/headers)
   * - Constant-time RSA-SHA256 signature verification
   */
  verifyWebhookSignature(
    body?: unknown,
    headers?: Record<string, string>,
    context?: { method?: string; path?: string; rawBody?: Buffer | string },
  ): boolean {
    if (!this.config.webhookPublicKey) {
      return true; // verification skipped — no public key configured
    }

    if (!headers || typeof headers !== 'object') {
      return false;
    }

    try {
      const authHeader =
        headers['authorization'] ??
        headers['Authorization'] ??
        headers['signature'] ??
        headers['Signature'];

      if (!authHeader || typeof authHeader !== 'string') return false;

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
        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const valueStart = eqIdx + 2;
        const valueEnd = part.lastIndexOf('"');
        if (valueEnd <= valueStart) continue;
        const value = part.slice(valueStart, valueEnd);
        if (key) sigParams[key] = value;
      }

      const signature = sigParams['signature'];
      const signedHeaders = sigParams['headers'] ?? '(request-target) host date digest';
      if (!signature) return false;

      const headerNames = signedHeaders.split(' ').map((h) => h.trim().toLowerCase()).filter(Boolean);

      // Require minimum signed headers
      if (!headerNames.includes('(request-target)') || !headerNames.includes('date')) {
        return false;
      }

      const hasBody =
        (context?.rawBody !== undefined &&
          (typeof context.rawBody === 'string'
            ? context.rawBody.length > 0
            : Buffer.isBuffer(context.rawBody)
            ? context.rawBody.length > 0
            : false)) ||
        (body !== undefined &&
          body !== null &&
          (typeof body === 'string'
            ? body.length > 0
            : Buffer.isBuffer(body)
            ? body.length > 0
            : typeof body === 'object'
            ? Object.keys(body).length > 0
            : false));

      if (hasBody && !headerNames.includes('digest')) {
        return false;
      }

      // 1. Freshness check on Date: Date header is strictly required
      const rawDate = headers['date'] ?? headers['Date'];
      if (!rawDate) return false;
      const dateParsed = new Date(rawDate);
      if (isNaN(dateParsed.getTime())) return false;
      const maxAgeMs = this.config.signatureMaxAgeMs ?? 300_000;
      if (Math.abs(Date.now() - dateParsed.getTime()) > maxAgeMs) {
        return false;
      }

      // 2. Digest comparison: Digest header MUST match SHA-256 of the raw body
      const headerDigest = headers['digest'] ?? headers['Digest'];
      if (headerNames.includes('digest') || hasBody) {
        if (!headerDigest) return false;

        let rawBytes: Buffer;
        if (context?.rawBody !== undefined) {
          rawBytes = Buffer.isBuffer(context.rawBody)
            ? context.rawBody
            : Buffer.from(context.rawBody, 'utf-8');
        } else if (Buffer.isBuffer(body)) {
          rawBytes = body;
        } else if (typeof body === 'string') {
          rawBytes = Buffer.from(body, 'utf-8');
        } else if (body !== undefined && body !== null && typeof body === 'object') {
          rawBytes = Buffer.from(JSON.stringify(body), 'utf-8');
        } else {
          rawBytes = Buffer.from('', 'utf-8');
        }

        const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(rawBytes).digest('base64');
        if (headerDigest !== expectedDigest) {
          return false;
        }
      }

      // 3. Reconstruct the signed message from headers and context
      const parts: string[] = [];
      for (const name of headerNames) {
        if (name === '(request-target)') {
          // (request-target) MUST come strictly from context
          if (!context?.method || !context?.path) return false;
          parts.push(`(request-target): ${context.method.toLowerCase()} ${context.path}`);
        } else if (name === 'digest') {
          parts.push(`digest: ${headerDigest}`);
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
      throw new Error(`Satispay API returned HTTP ${response.status}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Invalid provider response');
    }
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
    if (!this.isValidPaymentId(paymentId)) {
      return {
        success: false,
        paymentId: typeof paymentId === 'string' ? paymentId : undefined,
        status: 'FAILED',
        error: 'Invalid payment ID format',
      };
    }
    try {
      const payment = await this.request<Record<string, unknown>>(
        'GET',
        `${this.apiUrl}/payments/${encodeURIComponent(paymentId)}`,
      );
      const amount = parseAmountFromCents(payment['amount_unit']);
      const currencyRaw = payment['currency'];
      const currency = parseNexiCurrency(currencyRaw) ?? (typeof currencyRaw === 'string' && currencyRaw.trim() !== '' ? currencyRaw.trim() : undefined);
      const status = payment['status'] as string | undefined;
      const isAccepted = status === 'ACCEPTED' && amount !== undefined && amount > 0 && !!currency;

      return {
        success: isAccepted,
        paymentId: payment['id'] as string,
        status: status ?? 'UNKNOWN',
        amount,
        currency,
        raw: payment,
        ...(isAccepted
          ? {}
          : {
              error:
                status === 'ACCEPTED'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment is ${status ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      return this.errorResult(error, 'Failed to get Satispay payment details');
    }
  }

  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    if (!this.isValidPaymentId(paymentId)) {
      return {
        success: false,
        paymentId: typeof paymentId === 'string' ? paymentId : undefined,
        status: 'REFUND_FAILED',
        error: 'Invalid payment ID format',
      };
    }
    try {
      const body = amount ? { amount_unit: Math.round(amount * 100) } : {};
      const refund = await this.request<Record<string, unknown>>(
        'POST',
        `${this.apiUrl}/payments/${encodeURIComponent(paymentId)}/refunds`,
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
   *
   * Flow:
   * - POST webhooks: The HTTP Signature in the Authorization header is verified
   *   against `config.webhookPublicKey` (when configured) before processing.
   * - GET/HEAD callbacks: Satispay GET callbacks (?payment_id=...) do not carry HTTP signatures.
   *   An unsigned GET/HEAD is accepted solely as a trigger for a secure server-to-server
   *   API re-read using the merchant's RSA private key. The payment ID is validated
   *   exclusively from the query string and nothing else from the query string is trusted.
   */
  async handleWebhook(
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
    context?: { method?: string; path?: string; rawBody?: Buffer | string },
  ): Promise<WebhookResult> {
    const method = context?.method?.toUpperCase();
    const isGetOrHead = method === 'GET' || method === 'HEAD';

    if (!isGetOrHead) {
      if (!this.verifyWebhookSignature(body, headers, context)) {
        return { success: false, verified: false, error: 'Webhook signature verification failed' };
      }
    }

    const b = body ?? {};
    const rawId: unknown = isGetOrHead
      ? query['payment_id']
      : (b['payment_id'] ?? b['id'] ?? query['payment_id']);
    if (!rawId) {
      return { success: false, verified: false, error: 'Missing payment_id in webhook body or query' };
    }
    if (!this.isValidPaymentId(rawId)) {
      return { success: false, verified: false, error: 'Invalid payment ID format' };
    }
    const paymentId = rawId;

    try {
      const payment = await this.request<Record<string, unknown>>(
        'GET',
        `${this.apiUrl}/payments/${encodeURIComponent(paymentId)}`,
      );
      const amount = parseAmountFromCents(payment['amount_unit']);
      const currencyRaw = payment['currency'];
      const currency = parseNexiCurrency(currencyRaw) ?? (typeof currencyRaw === 'string' && currencyRaw.trim() !== '' ? currencyRaw.trim() : undefined);
      const status = payment['status'] as string | undefined;
      const isAccepted = status === 'ACCEPTED' && amount !== undefined && amount > 0 && !!currency;
      const orderId = (payment['external_code'] as string) || undefined;

      return {
        success: isAccepted,
        verified: true,
        paymentId: payment['id'] as string,
        orderId,
        status: status ?? 'UNKNOWN',
        amount,
        currency,
        raw: payment,
        ...(isAccepted
          ? {}
          : {
              error:
                status === 'ACCEPTED'
                  ? (amount === undefined || amount <= 0
                      ? 'Payment amount is missing or invalid'
                      : 'Payment currency is missing or invalid')
                  : `Payment is ${status ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      let msg = error instanceof Error ? error.message : 'Webhook handling failed';
      if (error instanceof SyntaxError || /JSON|Unexpected token/i.test(msg)) {
        msg = 'Invalid provider response';
      }
      return { success: false, verified: false, paymentId, error: msg };
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
      ...(details.success ? {} : { error: details.error }),
    };
  }
}
