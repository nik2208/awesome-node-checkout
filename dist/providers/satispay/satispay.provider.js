"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SatispayProvider = void 0;
const crypto = __importStar(require("crypto"));
const base_payment_provider_abstract_1 = require("../../abstract/base-payment-provider.abstract");
const in_memory_transaction_store_1 = require("../../stores/in-memory-transaction.store");
/**
 * Satispay Business API provider.
 * Flow: `webhook` — creates a MATCH_CODE payment, user pays via Satispay app,
 * Satispay calls the `callback_url` webhook, which is correlated to the order
 * via the `ITransactionStore`. The redirect is then verified via `handleRedirect`.
 */
class SatispayProvider extends base_payment_provider_abstract_1.BasePaymentProvider {
    constructor(config) {
        super();
        this.config = config;
        this.name = 'satispay';
        this.flow = 'webhook';
        this.apiUrl =
            config.environment === 'production'
                ? 'https://authservices.satispay.com/g_business/v1'
                : 'https://staging.authservices.satispay.com/g_business/v1';
        this.transactionStore = config.transactionStore ?? new in_memory_transaction_store_1.InMemoryTransactionStore();
    }
    // ---------------------------------------------------------------------------
    // Authentication
    // ---------------------------------------------------------------------------
    buildSignatureHeaders(method, path, host, body) {
        const bodyString = body ? JSON.stringify(body) : '';
        const digest = 'SHA-256=' + crypto.createHash('sha256').update(bodyString).digest('base64');
        const date = new Date().toUTCString();
        const requestTarget = `${method.toLowerCase()} ${path}`;
        const message = `(request-target): ${requestTarget}\n` +
            `host: ${host}\n` +
            `date: ${date}\n` +
            `digest: ${digest}`;
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(message);
        const signature = sign.sign(this.config.privateKey, 'base64');
        const authorization = `Signature keyId="${this.config.keyId}", algorithm="rsa-sha256", ` +
            `headers="(request-target) host date digest", signature="${signature}"`;
        return {
            'Content-Type': 'application/json',
            'Host': host,
            'Date': date,
            'Digest': digest,
            'Authorization': authorization,
        };
    }
    async request(method, url, body) {
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
        return JSON.parse(text);
    }
    // ---------------------------------------------------------------------------
    // IPaymentProvider implementation
    // ---------------------------------------------------------------------------
    async createPayment(request) {
        try {
            const orderId = request.orderId ?? `ORD-${Date.now()}`;
            const baseUrl = this.config.serverUrl ?? '';
            // Satispay replaces {uuid} at runtime with the actual payment ID
            const callbackUrl = `${baseUrl}/checkout/satispay/webhook?order_id=${orderId}&payment_id={uuid}`;
            const body = {
                flow: 'MATCH_CODE',
                amount_unit: Math.round(request.amount * 100),
                currency: request.currency,
                external_code: orderId,
                callback_url: callbackUrl,
                redirect_url: request.returnUrl,
                metadata: request.metadata,
            };
            const payment = await this.request('POST', `${this.apiUrl}/payments`, body);
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
        }
        catch (error) {
            return this.errorResult(error, 'Failed to create Satispay payment');
        }
    }
    /** For Satispay, execute is equivalent to a status check */
    async executePayment(paymentId) {
        return this.getPaymentDetails(paymentId);
    }
    async getPaymentDetails(paymentId) {
        try {
            const payment = await this.request('GET', `${this.apiUrl}/payments/${paymentId}`);
            return {
                success: true,
                paymentId: payment.id,
                status: payment.status,
                raw: payment,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to get Satispay payment details');
        }
    }
    async refundPayment(paymentId, amount) {
        try {
            const body = amount ? { amount_unit: Math.round(amount * 100) } : {};
            const refund = await this.request('POST', `${this.apiUrl}/payments/${paymentId}/refunds`, body);
            return {
                success: true,
                paymentId: refund.id,
                status: refund.status,
                raw: refund,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to refund Satispay payment');
        }
    }
    /**
     * Handles the async webhook notification from Satispay.
     * Satispay calls this URL with `payment_id` (the Satispay payment UUID).
     * We verify the current payment status via an API call.
     */
    async handleWebhook(body, _headers) {
        const paymentId = body.payment_id ?? body.id;
        if (!paymentId) {
            return { success: false, error: 'Missing payment_id in webhook body' };
        }
        try {
            const payment = await this.request('GET', `${this.apiUrl}/payments/${paymentId}`);
            return {
                success: payment.status === 'ACCEPTED',
                paymentId: payment.id,
                status: payment.status,
                raw: payment,
            };
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : 'Webhook handling failed';
            return { success: false, paymentId, error: msg };
        }
    }
    /**
     * Handles the redirect back to the merchant app after the Satispay flow.
     * Looks up the transaction by `order_id` in the store, then verifies status.
     */
    async handleRedirect(query) {
        const orderId = query.order_id;
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
exports.SatispayProvider = SatispayProvider;
//# sourceMappingURL=satispay.provider.js.map