"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCheckoutRouter = createCheckoutRouter;
const express_1 = require("express");
const errors_1 = require("../../models/errors");
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
function createCheckoutRouter(checkout, options = {}) {
    const router = (0, express_1.Router)();
    // Apply shared middleware (skipping public paths)
    if (options.middleware?.length) {
        const publicPaths = options.publicPaths ?? [];
        router.use((req, res, next) => {
            const providerParam = String(req.params?.provider ?? '');
            const isPublic = publicPaths.some((p) => req.path.endsWith(p) || req.path.includes(p.replace(':provider', providerParam)));
            if (isPublic)
                return next();
            // Chain all middleware in sequence
            const handlers = options.middleware;
            const run = (i) => {
                if (i >= handlers.length)
                    return next();
                handlers[i](req, res, () => run(i + 1));
            };
            run(0);
        });
    }
    // ---- POST /:provider — create payment ------------------------------------
    router.post('/:provider', async (req, res) => {
        try {
            const result = await checkout.createPayment(String(req.params.provider), req.body);
            res.status(result.success ? 201 : 400).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    // ---- POST /:provider/execute — execute payment ---------------------------
    router.post('/:provider/execute', async (req, res) => {
        try {
            const { paymentId, data } = req.body;
            const result = await checkout.executePayment(String(req.params.provider), paymentId, data);
            res.status(result.success ? 200 : 400).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    // ---- POST /:provider/refund — refund payment -----------------------------
    router.post('/:provider/refund', async (req, res) => {
        try {
            const { paymentId, amount } = req.body;
            const result = await checkout.refundPayment(String(req.params.provider), paymentId, amount);
            res.status(result.success ? 200 : 400).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    // ---- POST /:provider/webhook — handle webhook ----------------------------
    router.post('/:provider/webhook', async (req, res) => {
        try {
            const result = await checkout.handleWebhook(String(req.params.provider), req.body, req.headers);
            res.status(result.success ? 200 : 400).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    // ---- GET /:provider/redirect — handle redirect callback ------------------
    // NOTE: must be defined BEFORE /:provider/:id to avoid "redirect" being
    // treated as a paymentId.
    router.get('/:provider/redirect', async (req, res) => {
        try {
            const result = await checkout.handleRedirect(String(req.params.provider), req.query);
            res.status(result.success ? 200 : 400).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    // ---- GET /:provider/:id — get payment details ----------------------------
    router.get('/:provider/:id', async (req, res) => {
        try {
            const result = await checkout.getPaymentDetails(String(req.params.provider), String(req.params.id));
            res.status(result.success ? 200 : 404).json(result);
        }
        catch (err) {
            sendError(res, err);
        }
    });
    return router;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendError(res, err) {
    if (err instanceof errors_1.CheckoutError) {
        const statusMap = {
            PROVIDER_NOT_FOUND: 404,
            WEBHOOK_NOT_SUPPORTED: 422,
            REDIRECT_NOT_SUPPORTED: 422,
        };
        const status = statusMap[err.code] ?? 500;
        res.status(status).json({ success: false, error: err.message, code: err.code });
    }
    else {
        const message = err instanceof Error ? err.message : 'Internal server error';
        res.status(500).json({ success: false, error: message });
    }
}
//# sourceMappingURL=index.js.map