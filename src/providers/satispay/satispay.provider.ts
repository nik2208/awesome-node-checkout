import * as crypto from 'crypto';
import { BasePaymentProvider } from '../../abstract/base-payment-provider.abstract';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult, WebhookResult } from '../../models/payment-result.model';
import { RefundOptions, isRefundIdempotencyKey } from '../../models/refund.model';
import { ITransactionStore } from '../../interfaces/transaction-store.interface';
import { InMemoryTransactionStore } from '../../stores/in-memory-transaction.store';
import { parseAmountFromCents, parseNexiCurrency } from '../../utils/parsing.util';
import { generateOrderId } from '../../utils/ids';
import { currencyExponent, isInvalidAmountError, toMinorUnits } from '../../utils/money';
import { appendMandateRef } from '../../utils/url';
import { IMandateProvider } from '../../interfaces/mandate-provider.interface';
import {
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
  MandateStatusResult,
} from '../../models/mandate.model';

/** Result of `send()`: never thrown, `networkError` for transport failures and timeouts. */
interface SatispaySendResult {
  ok: boolean;
  status: number;
  json?: Record<string, unknown>;
  networkError?: boolean;
}

/** Outcome of a server-to-server re-read of a pre-authorized payment token. */
type TokenRead =
  | { kind: 'found'; status: string; json: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** Signature headers that `extraHeaders` may never override (compared case-insensitively). */
const PROTECTED_HEADERS = new Set(['host', 'date', 'digest', 'authorization']);

const REVOKE_UNSUPPORTED =
  'Satispay does not document a merchant-side revocation; stop charging this mandate. ' +
  'The customer can revoke it from the Satispay app.';

/**
 * Since 2.2.0. The 4xx answers to a refund that say nothing about it: merchant-side (401, 403,
 * 429) or a same-key request still in flight (408, 409). Any other 4xx is a refusal.
 */
const REFUND_UNKNOWN_4XX: ReadonlySet<number> = new Set([401, 403, 408, 409, 429]);

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
  /**
   * Timeout of the mandate API calls (`createMandate`, `confirmMandate`, `chargeMandate`,
   * `getMandate`) in milliseconds. A timeout is reported as `unknown`, never `failed`.
   *
   * Since 2.2.0 it also bounds `refundPayment` (its payment read and its refund request), but
   * only when it is set: refunds have no default timeout, as in 2.1. A refund that times out
   * without an idempotency key cannot be retried safely, so a default would turn slow successes
   * into apparent failures. A refund that times out is an unknown outcome (`success: false`
   * without `verified`): retry it only with the same `RefundOptions.idempotencyKey`.
   * @default 30000 (mandate calls); no timeout (refunds)
   */
  timeoutMs?: number;
  /**
   * Path of the mandate callback route, appended to `serverUrl` to build the authorization's
   * `callback_url` when `MandateSetupRequest.notifyUrl` is not set.
   * @default '/checkout/satispay/mandate/callback'
   */
  mandateCallbackPath?: string;
}

/**
 * Satispay Business API provider.
 * Flow: `webhook` — creates a MATCH_CODE payment, user pays via Satispay app,
 * Satispay calls the `callback_url` webhook, which is correlated to the order
 * via the `ITransactionStore`. The redirect is then verified via `handleRedirect`.
 *
 * Recurring payments (`IMandateProvider`): Automatic Payments, web-redirect flow. A setup creates
 * a pre-authorized payment token, the customer approves it in Satispay, and every charge (the
 * first one included) is a synchronous `PRE_AUTHORIZED` payment. EUR only.
 */
export class SatispayProvider extends BasePaymentProvider implements IMandateProvider {
  readonly name = 'satispay';
  readonly flow = 'webhook' as const;
  /**
   * Since 2.2.0: `refundPayment` sends `options.idempotencyKey` as `Idempotency-Key` (retention not documented by
   * Satispay: retry promptly).
   */
  readonly supportsRefundIdempotency = true;

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

  /**
   * Signed request that never throws and keeps the HTTP status and the parsed body, for the
   * mandate methods and (since 2.2.0) the refunds, which must tell 4xx from 5xx from a timeout.
   * `extraHeaders` are merged after the signature headers but can never override `Host`, `Date`,
   * `Digest` or `Authorization` (case-insensitively). `request()` keeps its throwing behaviour for
   * the one-off payment flow.
   *
   * `options.timeoutMs` (since 2.2.0): omitted `options` give the mandate timeout,
   * `config.timeoutMs ?? 30000`; `{ timeoutMs: undefined }` gives no timeout (no `signal`), which
   * is what a refund without a configured `timeoutMs` passes.
   */
  private async send(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    options: { timeoutMs?: number } = { timeoutMs: this.config.timeoutMs ?? 30000 },
  ): Promise<SatispaySendResult> {
    try {
      const parsed = new URL(url);
      const headers: Record<string, string> = this.buildSignatureHeaders(
        method,
        parsed.pathname,
        parsed.host,
        body,
      );
      for (const [name, value] of Object.entries(extraHeaders)) {
        if (PROTECTED_HEADERS.has(name.toLowerCase())) continue;
        headers[name] = value;
      }

      const { timeoutMs } = options;
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });

      let text: string;
      try {
        text = await response.text();
      } catch {
        // The body could not be read (connection reset, timeout while streaming)
        return { ok: false, status: 0, networkError: true };
      }

      const status = typeof response.status === 'number' ? response.status : 0;
      const ok = response.ok === true;
      let json: Record<string, unknown> | undefined;
      try {
        const value: unknown = text ? JSON.parse(text) : undefined;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          json = value as Record<string, unknown>;
        }
      } catch {
        json = undefined;
      }
      return json ? { ok, status, json } : { ok, status };
    } catch {
      return { ok: false, status: 0, networkError: true };
    }
  }

  // ---------------------------------------------------------------------------
  // IPaymentProvider implementation
  // ---------------------------------------------------------------------------

  async createPayment(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const orderId = request.orderId ?? generateOrderId();
      const baseUrl = this.config.serverUrl ?? '';
      const callbackPath = this.config.callbackPath ?? '/checkout/satispay/webhook';

      // Satispay replaces {uuid} at runtime with the actual payment ID
      const callbackUrl =
        `${baseUrl}${callbackPath}?order_id=${encodeURIComponent(orderId)}&payment_id={uuid}`;

      const validatedCurrency = parseNexiCurrency(request.currency);
      if (!validatedCurrency) {
        return {
          success: false,
          error: 'Payment currency is missing or invalid',
          status: 'FAILED',
        };
      }
      // Payment details and refunds are read and sent in hundredths: only 2-decimal currencies
      // keep create, read-back and refund on the same scale
      if (currencyExponent(validatedCurrency) !== 2) {
        return {
          success: false,
          error: 'Payment currency is not supported by Satispay: only currencies with 2 decimal places are accepted',
          status: 'FAILED',
        };
      }

      const body = {
        flow: 'MATCH_CODE',
        amount_unit: toMinorUnits(request.amount, validatedCurrency),
        currency: validatedCurrency,
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
      if (isInvalidAmountError(error)) {
        return { success: false, error: error.message, status: 'FAILED' };
      }
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
      const currency = parseNexiCurrency(currencyRaw);
      const status = payment['status'] as string | undefined;
      const isAccepted = status === 'ACCEPTED' && amount !== undefined && amount > 0 && !!currency;

      return {
        success: isAccepted,
        // Outcome read from the Satispay API with a request signed by the merchant key
        verified: true,
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

  /**
   * Refunds the payment `paymentId` with the documented flow (since 2.2.0): a new payment
   * `POST /payments` with `flow: 'REFUND'`, `parent_payment_uid: paymentId`, `amount_unit` and
   * `currency: 'EUR'`, and `options.idempotencyKey` as `Idempotency-Key`.
   *
   * - `amount_unit` is required: a full refund (`amount` omitted) first reads the payment
   *   (`GET /payments/{id}`). Unless that read is a 2xx for this id, `ACCEPTED`, with an integer
   *   `amount_unit > 0`, the result is `REFUND_FAILED` and nothing is sent. After an earlier
   *   partial refund, a full refund of the original amount is refused (4xx): pass the remaining
   *   amount explicitly.
   * - `success: true` (verified) only for a 2xx `ACCEPTED` refund with an id and a `type` absent
   *   or `REFUND_TO_BUSINESS`. Any other 2xx, a network error or a timeout, and HTTP 401, 403,
   *   408, 409, 429 or 5xx are an unknown outcome (`success: false` without `verified`: the
   *   refund may exist). Any other 4xx is an authenticated refusal (`verified: true`,
   *   `REFUND_FAILED`): nothing was refunded.
   * - Bounded by `config.timeoutMs` only when it is set (no default timeout, as in 2.1).
   * - A key that does not match `REFUND_IDEMPOTENCY_KEY_PATTERN` is refused (`REFUND_FAILED`)
   *   without any request.
   */
  async refundPayment(paymentId: string, amount?: number, options?: RefundOptions): Promise<PaymentResult> {
    if (!this.isValidPaymentId(paymentId)) {
      return {
        success: false,
        paymentId: typeof paymentId === 'string' ? paymentId : undefined,
        status: 'REFUND_FAILED',
        error: 'Invalid payment ID format',
      };
    }
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey !== undefined && !isRefundIdempotencyKey(idempotencyKey)) {
      return { success: false, paymentId, status: 'REFUND_FAILED', error: 'Invalid refund idempotency key' };
    }
    // As configured: unset means no timeout, as the 2.1 refund (request()) had none
    const timeout = { timeoutMs: this.config.timeoutMs };

    let amountUnit: number;
    if (amount !== undefined) {
      // createPayment accepts only 2-decimal currencies, so an amount is always in hundredths.
      // Only an omitted (undefined) amount means a full refund, as in PayPal: 0 and null are
      // rejected by toMinorUnits like any invalid amount.
      try {
        amountUnit = toMinorUnits(amount, 'EUR');
      } catch (error) {
        if (isInvalidAmountError(error)) {
          return { success: false, error: error.message, status: 'FAILED' };
        }
        return this.errorResult(error, 'Failed to refund Satispay payment');
      }
    } else {
      const read = await this.send(
        'GET',
        `${this.apiUrl}/payments/${encodeURIComponent(paymentId)}`,
        undefined,
        {},
        timeout,
      );
      const unit = read.json?.['amount_unit'];
      if (
        !read.ok ||
        read.json?.['id'] !== paymentId ||
        read.json['status'] !== 'ACCEPTED' ||
        typeof unit !== 'number' ||
        !Number.isInteger(unit) ||
        unit <= 0
      ) {
        return {
          success: false,
          status: 'REFUND_FAILED',
          error: 'Satispay payment could not be read: no refund was sent',
        };
      }
      amountUnit = unit;
    }

    const res = await this.send(
      'POST',
      `${this.apiUrl}/payments`,
      { flow: 'REFUND', parent_payment_uid: paymentId, amount_unit: amountUnit, currency: 'EUR' },
      idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {},
      timeout,
    );
    return this.mapRefund(res);
  }

  /** The answer to a `flow: 'REFUND'` payment, mapped as documented on `refundPayment`. */
  private mapRefund(res: SatispaySendResult): PaymentResult {
    if (res.networkError) {
      // The refund may exist: no `verified`
      return { success: false, error: 'Satispay refund outcome unknown (network error or timeout)' };
    }
    const json = res.json;
    if (res.ok) {
      const status = typeof json?.['status'] === 'string' ? json['status'] : undefined;
      const id = json?.['id'];
      const type = json?.['type'];
      if (status === 'ACCEPTED' && typeof id === 'string' && id !== '' && (type === undefined || type === 'REFUND_TO_BUSINESS')) {
        const refunded = parseAmountFromCents(json?.['amount_unit']);
        const currency = json?.['currency'];
        return {
          success: true,
          // Authenticated server-to-server response, as in getPaymentDetails
          verified: true,
          paymentId: id,
          status: 'ACCEPTED',
          ...(refunded !== undefined ? { amount: refunded } : {}),
          ...(typeof currency === 'string' ? { currency } : {}),
          raw: json,
        };
      }
      // Not final, another type, no id or no JSON: uncertain
      const reported = status ?? 'UNKNOWN';
      return { success: false, status: reported, error: `Satispay refund is ${reported}`, raw: json };
    }
    const http = res.status;
    if (http >= 400 && http < 500 && !REFUND_UNKNOWN_4XX.has(http)) {
      // An authenticated refusal: nothing was refunded
      const message = json?.['message'];
      return {
        success: false,
        verified: true,
        status: 'REFUND_FAILED',
        error: typeof message === 'string' ? message : 'Satispay refused the refund',
        raw: json,
      };
    }
    // Merchant-side (401, 403, 429), a same-key request still in flight (408, 409), 5xx, or any
    // other status: the refund may exist
    return { success: false, error: `Satispay refund outcome unknown (HTTP ${http})`, raw: json };
  }

  /**
   * Handles the async webhook notification from Satispay.
   * Satispay calls this URL with `payment_id` (the Satispay payment UUID).
   *
   * Flow:
   * - POST webhooks: The HTTP Signature in the Authorization header is verified
   *   against `config.webhookPublicKey` (when configured) before processing.
   *   When `config.webhookPublicKey` is omitted, cryptographic signature verification is skipped,
   *   and `verified: true` indicates that the payment details and status were securely verified
   *   directly via an authenticated server-to-server API re-read signed with the merchant's RSA private key.
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
      const currency = parseNexiCurrency(currencyRaw);
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

    const verified = details.verified === true;
    // orderId comes from the authenticated API record (external_code) or the local
    // transaction store, never from the redirect query.
    const apiOrderId =
      typeof details.raw?.external_code === 'string' && details.raw.external_code !== ''
        ? (details.raw.external_code as string)
        : undefined;
    if (verified && apiOrderId !== undefined && transaction.orderId && apiOrderId !== transaction.orderId) {
      return {
        success: false,
        verified: false,
        status: 'FAILED',
        error: 'Order id does not match the outcome',
      };
    }

    if (details.success && details.status === 'ACCEPTED') {
      await this.transactionStore.delete(orderId);
    }

    return {
      success: details.success && details.status === 'ACCEPTED',
      verified,
      paymentId: verified ? details.paymentId : undefined,
      orderId: verified ? (apiOrderId ?? transaction.orderId) : undefined,
      status: details.status,
      amount: details.amount,
      currency: details.currency,
      raw: details.raw,
      ...(details.success ? {} : { error: details.error }),
    };
  }

  // ---------------------------------------------------------------------------
  // IMandateProvider implementation (Automatic Payments, web-redirect flow)
  // ---------------------------------------------------------------------------

  /**
   * Creates a pre-authorized payment token (`POST /pre_authorized_payment_tokens`) and returns
   * its `redirect_url` as `approvalUrl`. Never open that URL in a WebView.
   *
   * - EUR only.
   * - `callback_url` is `notifyUrl` (or `serverUrl + mandateCallbackPath`) with `mandate_ref`
   *   and the raw `token_id={uuid}` placeholder, which Satispay substitutes with the token id.
   * - `redirect_url` is `returnUrl` with `mandate_ref`.
   * - `cancelUrl` is unused: Satispay has no cancel redirect (a canceled authorization is
   *   reported through the callback and re-read as `CANCELED`).
   * - `Idempotency-Key: setup-<orderId>`.
   */
  async createMandate(request: MandateSetupRequest): Promise<MandateSetupStart> {
    if (request.currency !== 'EUR') {
      return { success: false, error: 'Satispay mandates support EUR only' };
    }
    try {
      // The first charge is made later from the pending state: reject an invalid amount now
      toMinorUnits(request.amount, 'EUR');
    } catch (error) {
      return {
        success: false,
        error: isInvalidAmountError(error) ? error.message : 'Invalid mandate amount',
      };
    }

    const base =
      request.notifyUrl ??
      (this.config.serverUrl
        ? this.config.serverUrl +
          (this.config.mandateCallbackPath ?? '/checkout/satispay/mandate/callback')
        : undefined);
    if (!base) {
      return { success: false, error: 'Satispay mandates require notifyUrl or serverUrl' };
    }

    let callbackUrl: string;
    let redirectUrl: string;
    try {
      const callback = new URL(appendMandateRef(base, request.mandateRef));
      callback.searchParams.delete('token_id');
      // A fragment is never sent to a server; dropping it keeps the placeholder in the query
      callback.hash = '';
      // `{uuid}` is appended raw AFTER serialization: URLSearchParams would percent-encode the
      // braces and Satispay would no longer substitute the token id
      callbackUrl = callback.toString() + '&token_id={uuid}';
      redirectUrl = appendMandateRef(request.returnUrl, request.mandateRef);
    } catch {
      return { success: false, error: 'Satispay mandate callback or return URL is not an absolute URL' };
    }

    const res = await this.send(
      'POST',
      `${this.apiUrl}/pre_authorized_payment_tokens`,
      { reason: request.description, callback_url: callbackUrl, redirect_url: redirectUrl },
      { 'Idempotency-Key': 'setup-' + request.orderId },
    );
    const id = res.json?.['id'];
    const approvalUrl = res.json?.['redirect_url'];
    if (!res.ok || typeof id !== 'string' || id === '' || typeof approvalUrl !== 'string' || approvalUrl === '') {
      // Generic: never the response body, which may carry the token id
      return {
        success: false,
        error: res.networkError
          ? 'Satispay authorization could not be created (network error or timeout)'
          : `Satispay authorization could not be created (HTTP ${res.status})`,
      };
    }

    return {
      success: true,
      approvalUrl,
      pending: {
        provider: this.name,
        mandateRef: request.mandateRef,
        orderId: request.orderId,
        amount: request.amount,
        currency: 'EUR',
        providerRef: id,
        createdAt: new Date().toISOString(),
      },
      raw: res.json,
    };
  }

  /**
   * Re-reads the authorization server-to-server (the callback is unsigned) and, once it is
   * `ACCEPTED`, makes the first `PRE_AUTHORIZED` payment with `Idempotency-Key = orderId`. A second
   * confirm (a second callback, or a re-confirm job with `{}`) replays that key and gets Satispay's
   * original response instead of charging twice. The token id is always `pending.providerRef`;
   * a callback `token_id` only has to match it.
   *
   * `CANCELED` is terminal with no mandate. The first payment is replayed with the same body and
   * `Idempotency-Key = orderId` (Satispay returns the original response for a reused key), so a
   * re-confirm after an `unknown` first charge learns whether it was taken:
   * - `ACCEPTED` (the authorization was canceled after the first charge): `success: false`,
   *   verified, terminal, `succeeded` first charge, error 'Authorization canceled after the first
   *   charge'. The app refunds it or keeps it as a one-off payment.
   * - a 4xx (no payment exists for that key, e.g. the customer declined the authorization):
   *   `success: false`, verified, terminal, `failed` first charge ('Authorization canceled').
   * - 401, 403, 408, 409, 429, 5xx, a network error or an unexpected 2xx: unverified, non-terminal,
   *   `unknown` first charge.
   * The replay is only authoritative while Satispay keeps the key (retention not documented).
   */
  async confirmMandate(
    pending: MandatePendingState,
    input: MandateCallbackInput,
  ): Promise<MandateSetupOutcome> {
    const unverified = (error: string): MandateSetupOutcome => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId },
      error,
    });

    const callbackTokenId = input?.query?.['token_id'];
    if (callbackTokenId !== undefined && callbackTokenId !== pending.providerRef) {
      return unverified('Callback token does not match the pending setup');
    }

    const read = await this.readToken(pending.providerRef);
    if (read.kind !== 'found') {
      return unverified('Satispay authorization could not be read');
    }

    const firstChargeRequest: ChargeRequest = {
      chargeRef: pending.orderId,
      amount: pending.amount,
      currency: 'EUR',
    };

    switch (read.status) {
      case 'PENDING':
        return {
          success: false,
          verified: true,
          terminal: false,
          error: 'AUTHORIZATION_PENDING',
          firstCharge: {
            status: 'unknown',
            verified: false,
            chargeRef: pending.orderId,
            error: 'Authorization still pending',
          },
          raw: read.json,
        };
      case 'CANCELED': {
        // Replay the first payment exactly as the ACCEPTED branch sends it (same body, same key)
        const replay = await this.postPayment(pending.providerRef, firstChargeRequest);
        if (replay.status === 'succeeded') {
          return {
            success: false,
            verified: true,
            terminal: true,
            error: 'Authorization canceled after the first charge',
            firstCharge: replay,
            raw: read.json,
          };
        }
        if (replay.status === 'failed') {
          // A 4xx: Satispay holds no payment for this key. (A local amount or currency check that
          // failed means no request with this body could ever have been sent.)
          return {
            success: false,
            verified: true,
            terminal: true,
            error: 'Authorization canceled',
            firstCharge: {
              status: 'failed',
              verified: true,
              chargeRef: pending.orderId,
              error: 'Authorization canceled',
            },
            raw: read.json,
          };
        }
        return {
          ...unverified('Authorization canceled; the first charge outcome is unknown'),
          firstCharge: replay,
        };
      }
      case 'ACCEPTED': {
        const mandate: Mandate = {
          provider: this.name,
          mandateRef: pending.mandateRef,
          providerMandateId: pending.providerRef,
          status: 'active',
          createdAt: new Date().toISOString(),
        };
        const firstCharge = await this.chargeMandate(mandate, firstChargeRequest);
        return { success: true, verified: true, terminal: true, mandate, firstCharge, raw: read.json };
      }
      default:
        return unverified('Satispay authorization status is not recognised');
    }
  }

  /**
   * Merchant-initiated `PRE_AUTHORIZED` payment, synchronous: Satispay creates it `ACCEPTED` or
   * answers 4xx without creating a payment. `Idempotency-Key = chargeRef`: the same `chargeRef`
   * gets Satispay's original response (retention not documented: retry `unknown` promptly).
   * `providerPaymentId` is the Satispay payment id, refundable with `refundPayment`.
   * 408 and 409 are `unknown`, not a refusal: they may answer a concurrent request with the same
   * key that is still in flight (Satispay documents neither the behaviour nor the status).
   */
  async chargeMandate(mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    const result = await this.postPayment(mandate.providerMandateId, charge);
    if (result.status === 'failed' && result.verified) {
      // A refusal (4xx): tell the app whether the authorization itself is gone
      const read = await this.readToken(mandate.providerMandateId);
      if (read.kind === 'not_found' || (read.kind === 'found' && read.status === 'CANCELED')) {
        result.mandateUnusable = true;
      }
    }
    return result;
  }

  /**
   * `POST /payments` (`PRE_AUTHORIZED`, `Idempotency-Key = chargeRef`) mapped to a `ChargeResult`,
   * without the token re-read that sets `mandateUnusable`. A verified `failed` is always a 4xx.
   */
  private async postPayment(tokenId: string, charge: ChargeRequest): Promise<ChargeResult> {
    const chargeRef = charge.chargeRef;
    if (charge.currency !== 'EUR') {
      return { status: 'failed', verified: false, chargeRef, error: 'Satispay mandates support EUR only' };
    }
    let amountUnit: number;
    try {
      amountUnit = toMinorUnits(charge.amount, 'EUR');
    } catch (error) {
      return {
        status: 'failed',
        verified: false,
        chargeRef,
        error: isInvalidAmountError(error) ? error.message : 'Invalid charge amount',
      };
    }

    const res = await this.send(
      'POST',
      `${this.apiUrl}/payments`,
      {
        flow: 'PRE_AUTHORIZED',
        token: tokenId,
        amount_unit: amountUnit,
        currency: 'EUR',
        external_code: chargeRef,
        ...(charge.description ? { metadata: { description: charge.description } } : {}),
      },
      { 'Idempotency-Key': chargeRef },
    );

    if (res.networkError) {
      return { status: 'unknown', verified: false, chargeRef, error: 'Satispay charge timed out or failed to connect' };
    }

    if (res.ok) {
      const json = res.json;
      if (!json) {
        return { status: 'unknown', verified: false, chargeRef, error: 'Invalid provider response' };
      }
      const externalCode = json['external_code'];
      if (externalCode !== undefined && externalCode !== null && externalCode !== chargeRef) {
        return {
          status: 'unknown',
          verified: false,
          chargeRef,
          error: 'Satispay payment does not match the charge reference',
          raw: json,
        };
      }
      const paymentId = json['id'];
      if (json['status'] !== 'ACCEPTED' || typeof paymentId !== 'string' || paymentId === '') {
        return {
          status: 'unknown',
          verified: false,
          chargeRef,
          error: `Satispay payment is ${typeof json['status'] === 'string' ? json['status'] : 'unknown'}`,
          raw: json,
        };
      }
      const rawAmount = json['amount_unit'];
      const amount = parseAmountFromCents(rawAmount);
      const currency = json['currency'];
      if ((rawAmount != null && amount === undefined) || (currency != null && typeof currency !== 'string')) {
        return { status: 'unknown', verified: false, chargeRef, error: 'Invalid provider response', raw: json };
      }
      return {
        status: 'succeeded',
        // Authenticated server-to-server response, as in getPaymentDetails
        verified: true,
        chargeRef,
        providerPaymentId: paymentId,
        amount,
        currency: currency ?? undefined,
        raw: json,
      };
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // Merchant-side (credentials, rate limit): not a refusal of this customer's charge
      return {
        status: 'unknown',
        verified: false,
        chargeRef,
        error: `Satispay rejected the request (HTTP ${res.status})`,
        raw: res.json,
      };
    }

    if (res.status === 408 || res.status === 409) {
      // Possibly a same-key request still in flight: the original may succeed
      return {
        status: 'unknown',
        verified: false,
        chargeRef,
        error: `Satispay charge outcome is unknown (HTTP ${res.status})`,
        raw: res.json,
      };
    }

    if (res.status >= 400 && res.status < 500) {
      const json = res.json;
      return {
        status: 'failed',
        verified: true,
        chargeRef,
        providerCode: String(json?.['code'] ?? res.status),
        error: String(json?.['message'] ?? 'Satispay refused the charge'),
        raw: json,
      };
    }

    return {
      status: 'unknown',
      verified: false,
      chargeRef,
      error: `Satispay charge outcome is unknown (HTTP ${res.status})`,
      raw: res.json,
    };
  }

  /** Re-reads the authorization: ACCEPTED → active, CANCELED or 404 → revoked, PENDING → unknown. */
  async getMandate(mandate: Mandate): Promise<MandateStatusResult> {
    const read = await this.readToken(mandate.providerMandateId);
    if (read.kind === 'not_found') return { status: 'revoked', verified: true };
    if (read.kind === 'unavailable') return { status: 'unknown', verified: false };
    switch (read.status) {
      case 'ACCEPTED':
        return { status: 'active', verified: true, raw: read.json };
      case 'CANCELED':
        return { status: 'revoked', verified: true, raw: read.json };
      case 'PENDING':
        return { status: 'unknown', verified: true, raw: read.json };
      default:
        return { status: 'unknown', verified: false, raw: read.json };
    }
  }

  /**
   * Makes no network call: Satispay documents no merchant-side revocation (the token API has only
   * GET). The undocumented `PUT /pre_authorized_payment_tokens/{id}` is deliberately not used.
   * Stop charging the mandate; the customer can revoke it from the Satispay app.
   */
  async revokeMandate(_mandate: Mandate): Promise<MandateRevokeResult> {
    return { revokedAtProvider: false, error: REVOKE_UNSUPPORTED };
  }

  /**
   * `GET /pre_authorized_payment_tokens/{id}`. A 2xx whose `id` is not `tokenId` or whose `status`
   * is not a string, a network error, a 5xx and any other non-2xx except 404 are `unavailable`.
   */
  private async readToken(tokenId: string): Promise<TokenRead> {
    if (typeof tokenId !== 'string' || tokenId === '') return { kind: 'unavailable' };
    const res = await this.send(
      'GET',
      `${this.apiUrl}/pre_authorized_payment_tokens/${encodeURIComponent(tokenId)}`,
    );
    if (res.networkError) return { kind: 'unavailable' };
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok || !res.json) return { kind: 'unavailable' };
    const status = res.json['status'];
    if (res.json['id'] !== tokenId || typeof status !== 'string') return { kind: 'unavailable' };
    return { kind: 'found', status, json: res.json };
  }
}
