export type CheckoutErrorCode = 'PROVIDER_NOT_FOUND' | 'PROVIDER_ALREADY_REGISTERED' | 'PAYMENT_FAILED' | 'WEBHOOK_NOT_SUPPORTED' | 'REDIRECT_NOT_SUPPORTED' | 'TRANSACTION_NOT_FOUND';
export declare class CheckoutError extends Error {
    readonly code: CheckoutErrorCode;
    readonly provider?: string | undefined;
    constructor(message: string, code: CheckoutErrorCode, provider?: string | undefined);
}
//# sourceMappingURL=errors.d.ts.map