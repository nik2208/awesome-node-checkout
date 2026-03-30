"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckoutError = void 0;
class CheckoutError extends Error {
    constructor(message, code, provider) {
        super(message);
        this.code = code;
        this.provider = provider;
        this.name = 'CheckoutError';
        // Maintains proper stack trace in V8
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, CheckoutError);
        }
    }
}
exports.CheckoutError = CheckoutError;
//# sourceMappingURL=errors.js.map