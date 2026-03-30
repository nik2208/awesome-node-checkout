import { Router, RequestHandler } from 'express';
import { CheckoutConfigurator } from '../../checkout-configurator';
export interface ExpressCheckoutOptions {
    /**
     * Middleware applied to ALL checkout routes (e.g. API key auth).
     * Webhooks are typically public — use `publicPaths` to exclude them.
     */
    middleware?: RequestHandler[];
    /**
     * Route suffixes that bypass `middleware` (e.g. [':provider/webhook']).
     * Matched against the path suffix after the mount point.
     */
    publicPaths?: string[];
}
/**
 * Creates an Express Router with all checkout endpoints pre-wired.
 *
 * Routes mounted:
 * ```
 * POST   /:provider              → createPayment
 * POST   /:provider/execute      → executePayment
 * GET    /:provider/redirect     → handleRedirect  (must come before /:provider/:id)
 * GET    /:provider/:id          → getPaymentDetails
 * POST   /:provider/refund       → refundPayment
 * POST   /:provider/webhook      → handleWebhook
 * ```
 *
 * Usage:
 * ```typescript
 * import { createCheckoutRouter } from 'awesome-node-checkout/express';
 * app.use('/checkout', createCheckoutRouter(checkout));
 * ```
 */
export declare function createCheckoutRouter(checkout: CheckoutConfigurator, options?: ExpressCheckoutOptions): Router;
//# sourceMappingURL=index.d.ts.map