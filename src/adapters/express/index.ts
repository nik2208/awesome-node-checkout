import { Router, Request, Response, RequestHandler } from 'express';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import { PaymentRequest } from '../../models/payment-request.model';

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

  /**
   * Builds the PaymentRequest on the server (amount from your own order), ignoring the client body.
   */
  buildPaymentRequest?: (req: Request) => PaymentRequest | Promise<PaymentRequest>;

  /**
   * Configuration for POST /:provider/refund.
   * If omitted, the refund route is NOT mounted (returns 404).
   */
  refund?: {
    middleware?: RequestHandler[];
  };

  /**
   * Configuration for POST /:provider/execute.
   */
  execute?: {
    middleware?: RequestHandler[];
    onBeforeExecute?: (req: Request, paymentId: string) => void | Promise<void>;
  };
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
 * POST   /:provider/refund       → refundPayment (only if options.refund is configured)
 * POST   /:provider/webhook      → handleWebhook
 * ```
 *
 * Usage:
 * ```typescript
 * import { createCheckoutRouter } from 'awesome-node-checkout/express';
 * app.use('/checkout', createCheckoutRouter(checkout, {
 *   buildPaymentRequest: async (req) => {
 *     const order = await getOrder(req.body.orderId);
 *     return {
 *       amount: order.total,
 *       currency: 'EUR',
 *       orderId: order.id,
 *       returnUrl: 'https://example.com/success',
 *       cancelUrl: 'https://example.com/cancel',
 *     };
 *   },
 * }));
 * ```
 */
export function createCheckoutRouter(
  checkout: CheckoutConfigurator,
  options: ExpressCheckoutOptions = {},
): Router {
  const router = Router();

  if (!options.buildPaymentRequest) {
    console.warn(
      '[awesome-node-checkout] createCheckoutRouter: the client body decides the amount; set buildPaymentRequest',
    );
  }

  // Apply shared middleware (skipping public paths)
  if (options.middleware?.length) {
    const publicPaths = options.publicPaths ?? [];
    router.use((req, res, next) => {
      const providerParam = String(req.params?.provider ?? '');
      const isPublic = publicPaths.some((p) =>
        req.path.endsWith(p) || req.path.includes(p.replace(':provider', providerParam)),
      );
      if (isPublic) return next();
      // Chain all middleware in sequence
      const handlers = options.middleware!;
      const run = (i: number): void => {
        if (i >= handlers.length) return next();
        handlers[i](req, res, () => run(i + 1));
      };
      run(0);
    });
  }

  // ---- POST /:provider — create payment ------------------------------------
  router.post('/:provider', async (req: Request, res: Response) => {
    try {
      let paymentRequest: PaymentRequest;
      if (options.buildPaymentRequest) {
        paymentRequest = await options.buildPaymentRequest(req);
      } else {
        const body = req.body;
        const amount = body?.amount;
        const currency = body?.currency;
        if (
          typeof amount !== 'number' ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          typeof currency !== 'string' ||
          currency.trim() === ''
        ) {
          return res.status(400).json({
            success: false,
            error: 'Invalid payment request: amount must be a positive number and currency is required',
          });
        }
        paymentRequest = body;
      }
      const result = await checkout.createPayment(String(req.params.provider), paymentRequest);
      res.status(result.success ? 201 : 400).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- POST /:provider/execute — execute payment ---------------------------
  const executeHandlers: RequestHandler[] = [];
  if (options.execute?.middleware?.length) {
    executeHandlers.push(...options.execute.middleware);
  }
  router.post('/:provider/execute', ...executeHandlers, async (req: Request, res: Response) => {
    try {
      const { paymentId, data } = req.body as { paymentId: string; data?: any };
      if (options.execute?.onBeforeExecute) {
        await options.execute.onBeforeExecute(req, paymentId);
      }
      const result = await checkout.executePayment(String(req.params.provider), paymentId, data);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- POST /:provider/refund — refund payment (opt-in) --------------------
  if (options.refund) {
    const refundHandlers: RequestHandler[] = [];
    if (options.refund.middleware?.length) {
      refundHandlers.push(...options.refund.middleware);
    }
    router.post('/:provider/refund', ...refundHandlers, async (req: Request, res: Response) => {
      try {
        const { paymentId, amount } = req.body as { paymentId: string; amount?: number };
        const result = await checkout.refundPayment(String(req.params.provider), paymentId, amount);
        res.status(result.success ? 200 : 400).json(result);
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  // ---- POST /:provider/webhook — handle webhook ----------------------------
  router.post('/:provider/webhook', async (req: Request, res: Response) => {
    try {
      const result = await checkout.handleWebhook(
        String(req.params.provider),
        req.body,
        req.headers as Record<string, string>,
      );
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- GET /:provider/redirect — handle redirect callback ------------------
  // NOTE: must be defined BEFORE /:provider/:id to avoid "redirect" being
  // treated as a paymentId.
  router.get('/:provider/redirect', async (req: Request, res: Response) => {
    try {
      const result = await checkout.handleRedirect(
        String(req.params.provider),
        req.query as Record<string, string>,
      );
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- GET /:provider/:id — get payment details ----------------------------
  router.get('/:provider/:id', async (req: Request, res: Response) => {
    try {
      const result = await checkout.getPaymentDetails(String(req.params.provider), String(req.params.id));
      res.status(result.success ? 200 : 404).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, err: unknown): void {
  if (err instanceof CheckoutError) {
    const statusMap: Record<string, number> = {
      PROVIDER_NOT_FOUND: 404,
      WEBHOOK_NOT_SUPPORTED: 422,
      REDIRECT_NOT_SUPPORTED: 422,
    };
    const status = statusMap[err.code] ?? 400;
    res.status(status).json({ success: false, error: err.message, code: err.code });
  } else {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ success: false, error: message });
  }
}
