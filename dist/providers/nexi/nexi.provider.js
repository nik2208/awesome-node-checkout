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
exports.NexiProvider = void 0;
const crypto = __importStar(require("crypto"));
const base_payment_provider_abstract_1 = require("../../abstract/base-payment-provider.abstract");
/**
 * Nexi eCommerce provider.
 * Flow: `redirect` — builds a signed checkout URL, redirects the user to Nexi,
 * then handles the POST-back via `handleRedirect`.
 */
class NexiProvider extends base_payment_provider_abstract_1.BasePaymentProvider {
    constructor(config) {
        super();
        this.config = config;
        this.name = 'nexi';
        this.flow = 'redirect';
        this.apiUrl =
            config.environment === 'production'
                ? 'https://ecommerce.nexi.it'
                : 'https://int-ecommerce.nexi.it';
    }
    /**
     * Computes the SHA-1 MAC required by Nexi to authenticate the payment request.
     * Format: `codTrans={val}divisa={val}importo={val}{macKey}`
     */
    generateMac(codTrans, divisa, importoCents) {
        const raw = `codTrans=${codTrans}divisa=${divisa}importo=${importoCents}${this.config.macKey}`;
        return crypto.createHash('sha1').update(raw).digest('hex');
    }
    async createPayment(request) {
        try {
            const amountCents = Math.round(request.amount * 100);
            const orderId = request.orderId ?? `ORD-${Date.now()}`;
            const mac = this.generateMac(orderId, request.currency, amountCents);
            const params = {
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
        }
        catch (error) {
            return this.errorResult(error, 'Failed to create Nexi payment');
        }
    }
    /**
     * Validates the POST-back data from Nexi.
     * `data` is the query/body object sent by Nexi to the returnUrl.
     */
    async executePayment(paymentId, data) {
        try {
            const esito = data?.esito ?? '';
            const codTrans = data?.codTrans ?? paymentId;
            return {
                success: esito === 'OK',
                paymentId: codTrans,
                status: esito === 'OK' ? 'COMPLETED' : 'FAILED',
                raw: data,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to execute Nexi payment');
        }
    }
    async getPaymentDetails(paymentId) {
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
            if (!response.ok)
                throw new Error(`Nexi API error: ${response.statusText}`);
            const result = await response.json();
            return { success: true, paymentId, status: result.status, raw: result };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to get Nexi payment details');
        }
    }
    async refundPayment(paymentId, amount) {
        try {
            const params = {
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
            if (!response.ok)
                throw new Error(`Nexi API error: ${response.statusText}`);
            const result = await response.json();
            return {
                success: result.esito === 'OK',
                paymentId,
                status: result.esito === 'OK' ? 'REFUNDED' : 'REFUND_FAILED',
                raw: result,
            };
        }
        catch (error) {
            return this.errorResult(error, 'Failed to refund Nexi payment');
        }
    }
    /**
     * Handles the POST-back from Nexi to the returnUrl.
     * Nexi sends `esito`, `codTrans`, `importo`, `mac`, etc. as query/body params.
     */
    async handleRedirect(query) {
        return this.executePayment(query.codTrans, query);
    }
}
exports.NexiProvider = NexiProvider;
//# sourceMappingURL=nexi.provider.js.map