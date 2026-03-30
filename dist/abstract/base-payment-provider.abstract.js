"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BasePaymentProvider = void 0;
/**
 * Convenience base class for building custom payment providers.
 * Provides the `errorResult` helper to normalize error handling.
 *
 * Usage:
 * ```typescript
 * export class MyProvider extends BasePaymentProvider {
 *   readonly name = 'myprovider';
 *   readonly flow = 'redirect' as const;
 *   // ... implement abstract methods
 * }
 * ```
 */
class BasePaymentProvider {
    /**
     * Helper to produce a normalized error PaymentResult.
     * Extracts message from Error instances automatically.
     */
    errorResult(error, fallback = 'Unknown error') {
        const message = error instanceof Error ? error.message : fallback;
        return { success: false, error: message };
    }
}
exports.BasePaymentProvider = BasePaymentProvider;
//# sourceMappingURL=base-payment-provider.abstract.js.map