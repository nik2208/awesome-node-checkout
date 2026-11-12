import { Router, Request, Response, RequestHandler } from 'express';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { CheckoutError } from '../../models/errors';
import { PaymentRequest } from '../../models/payment-request.model';
import { PaymentResult } from '../../models/payment-result.model';
import { CheckoutListenerError } from '../../events/checkout-event-bus';
import { isInvalidAmountError, toMinorUnits } from '../../utils/money';

export interface PaymentRequestContext {
  provider: string;
  res: Response;
}

export interface ExpressCheckoutOptions {
  /**
   * Middleware applied to ALL checkout routes (e.g. API key auth).
   * Webhooks and redirects are typically public — use `publicPaths` to exclude them.
   */
  middleware?: RequestHandler[];

  /**
   * Route patterns that bypass `middleware` (e.g. [':provider/webhook', ':provider/redirect']).
   * Matched by path segments after the mount point (:provider matches any single segment).
   * Supports both path strings (':provider/webhook') and segment arrays ([':provider', 'webhook']).
   */
  publicPaths?: (string | string[])[];

  /**
   * Builds the PaymentRequest on the server (amount from your own order), ignoring the client body.
   * If the hook sends an HTTP response directly (e.g. via `ctx.res.status(403)...`),
   * returning `null` or `undefined` halts further adapter processing without error.
   *
   * Required: `createCheckoutRouter` throws `CheckoutError('INSECURE_CONFIGURATION')` at mount
   * when it is missing, unless `allowClientPaymentRequest: true` is set.
   */
  buildPaymentRequest?: (
    req: Request,
    ctx: PaymentRequestContext,
  ) => PaymentRequest | null | undefined | Promise<PaymentRequest | null | undefined>;

  /**
   * **Insecure.** Without `buildPaymentRequest`, sends the client request body to the provider
   * as the PaymentRequest: the browser chooses the amount, the currency and the order id.
   * Never use this for a shop or for anything with a price; it exists for donations-style
   * flows and tests. Ignored when `buildPaymentRequest` is set.
   */
  allowClientPaymentRequest?: true;

  /**
   * When configured, GET /:provider/redirect responds with a 302 redirect
   * to the URL returned by onSuccess or onFailure instead of JSON.
   */
  redirect?: {
    onSuccess: (result: PaymentResult, req: Request) => string;
    onFailure: (result: PaymentResult, req: Request) => string;
  };

  /**
   * Configuration for GET /:provider/:id (getPaymentDetails).
   * If omitted, the details route is NOT mounted (returns 404), like `refund`.
   * The route returns status, amount and currency for any payment id it is given:
   * protect it with `middleware` (a console warning is printed at mount when it has none).
   */
  details?: {
    /**
     * @deprecated Since 2.0.0 the route is mounted only when `details` is set.
     * `enabled: false` behaves as if `details` were omitted; any other value is ignored.
     */
    enabled?: boolean;
    middleware?: RequestHandler[];
  };

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

  /**
   * When `true`, 500 responses carry the error message (masked to 'Invalid provider response'
   * for provider parse errors). Default `false`: 500 bodies are always
   * `{ success: false, error: 'Internal server error' }`. `CheckoutError` 4xx responses keep
   * their message and code either way.
   */
  exposeErrorMessages?: boolean;

  /**
   * Called with the original error (and the request) for every error answered with a 500,
   * whatever `exposeErrorMessages` says. Not called for 4xx `CheckoutError` responses, which are
   * client-triggerable (e.g. an unknown provider name). When omitted, the error is logged with
   * `console.error('[awesome-node-checkout]', err)`.
   */
  onError?: (err: unknown, req: Request) => void;
}

/**
 * Matches a request path against public path patterns by segments.
 * ':provider' matches any single non-empty segment.
 * Accepts patterns formatted as string ('/:provider/webhook') or segment arrays ([':provider', 'webhook']).
 */
export function isPathPublic(reqPath: string, publicPaths: (string | string[])[]): boolean {
  const reqSegments = reqPath.split('/').filter(Boolean);
  return publicPaths.some((pattern) => {
    const patternSegments = Array.isArray(pattern)
      ? pattern
      : pattern.split('/').filter(Boolean);
    if (reqSegments.length !== patternSegments.length) {
      return false;
    }
    return patternSegments.every((patSeg, i) => {
      if (patSeg === ':provider' || patSeg.startsWith(':')) {
        return reqSegments[i].length > 0;
      }
      return patSeg === reqSegments[i];
    });
  });
}

/**
 * Creates an Express Router with all checkout endpoints pre-wired.
 *
 * Routes mounted:
 * ```
 * POST   /:provider              → createPayment
 * POST   /:provider/execute      → executePayment
 * POST   /:provider/refund       → refundPayment (only if options.refund is configured)
 * GET    /:provider/webhook      → handleWebhook
 * POST   /:provider/webhook      → handleWebhook
 * GET    /:provider/redirect     → handleRedirect  (must come before /:provider/:id)
 * GET    /:provider/:id          → getPaymentDetails (only if options.details is configured)
 * ```
 *
 * Throws `CheckoutError('INSECURE_CONFIGURATION')` when neither `buildPaymentRequest` nor
 * `allowClientPaymentRequest: true` is set.
 *
 * Usage:
 * ```typescript
 * import { createCheckoutRouter } from 'awesome-node-checkout/express';
 * app.use('/checkout', createCheckoutRouter(checkout, {
 *   buildPaymentRequest: async (req, ctx) => {
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
  if (!options.buildPaymentRequest && options.allowClientPaymentRequest !== true) {
    throw new CheckoutError(
      'createCheckoutRouter: set buildPaymentRequest (server-side amount) or allowClientPaymentRequest: true',
      'INSECURE_CONFIGURATION',
    );
  }
  if (!options.buildPaymentRequest) {
    console.warn('[awesome-node-checkout] allowClientPaymentRequest: the client body decides the amount');
  }

  const router = Router();
  const sendError = (req: Request, res: Response, err: unknown, isProvider = true): void =>
    sendErrorResponse(req, res, options, err, isProvider);

  // Apply shared middleware (skipping public paths by segment match)
  if (options.middleware?.length) {
    const publicPaths = options.publicPaths ?? [];
    router.use((req, res, next) => {
      if (isPathPublic(req.path, publicPaths)) return next();
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
      const provider = String(req.params.provider);
      let paymentRequest: PaymentRequest;
      if (options.buildPaymentRequest) {
        let customReq: PaymentRequest | null | undefined;
        try {
          customReq = await options.buildPaymentRequest(req, {
            provider,
            res,
          });
        } catch (consumerErr) {
          sendError(req, res, consumerErr, false);
          return;
        }

        if (res.headersSent) {
          return;
        }

        if (
          !customReq ||
          typeof customReq !== 'object' ||
          typeof customReq.amount !== 'number' ||
          !Number.isFinite(customReq.amount) ||
          customReq.amount <= 0 ||
          typeof customReq.currency !== 'string' ||
          customReq.currency.trim() === '' ||
          typeof customReq.returnUrl !== 'string' ||
          customReq.returnUrl.trim() === '' ||
          typeof customReq.cancelUrl !== 'string' ||
          customReq.cancelUrl.trim() === ''
        ) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAYMENT_REQUEST',
            error:
              'Invalid payment request returned by buildPaymentRequest: amount must be a positive number, currency, returnUrl, and cancelUrl are required strings',
          });
        }
        paymentRequest = customReq;
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
      // Exact minor units: an amount with more decimals than the currency allows is rejected,
      // never rounded
      try {
        toMinorUnits(paymentRequest.amount, paymentRequest.currency);
      } catch (amountErr) {
        if (!isInvalidAmountError(amountErr)) throw amountErr;
        return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', error: amountErr.message });
      }
      const result = await checkout.createPayment(provider, paymentRequest);
      const { raw, ...safeResult } = result;
      res.status(result.success ? 201 : 400).json(safeResult);
    } catch (err) {
      sendError(req, res, err, true);
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
        try {
          await options.execute.onBeforeExecute(req, paymentId);
        } catch (consumerErr) {
          sendError(req, res, consumerErr, false);
          return;
        }
      }
      const result = await checkout.executePayment(String(req.params.provider), paymentId, data);
      const { raw, ...safeResult } = result;
      res.status(result.success ? 200 : 400).json(safeResult);
    } catch (err) {
      sendError(req, res, err, true);
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
        const { raw, ...safeResult } = result;
        res.status(result.success ? 200 : 400).json(safeResult);
      } catch (err) {
        sendError(req, res, err, true);
      }
    });
  }

  // ---- GET & POST /:provider/webhook — handle webhook ----------------------
  const webhookHandler = async (req: Request, res: Response) => {
    try {
      const result = await checkout.handleWebhook(
        String(req.params.provider),
        req.body,
        req.headers as Record<string, string>,
        req.query as Record<string, string>,
        {
          method: req.method,
          path: req.originalUrl || req.url,
          rawBody: (req as any).rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined),
        },
      );
      // Sanitize: do not echo raw provider payload in webhook response
      const { raw, ...safeResult } = result;
      res.status(result.success ? 200 : 400).json(safeResult);
    } catch (err) {
      sendError(req, res, err, true);
    }
  };

  router.get('/:provider/webhook', webhookHandler);
  router.head('/:provider/webhook', webhookHandler);
  router.post('/:provider/webhook', webhookHandler);

  // ---- GET /:provider/redirect — handle redirect callback ------------------
  // NOTE: must be defined BEFORE /:provider/:id to avoid "redirect" being
  // treated as a paymentId.
  router.get('/:provider/redirect', async (req: Request, res: Response) => {
    let result: PaymentResult;
    try {
      result = await checkout.handleRedirect(
        String(req.params.provider),
        req.query as Record<string, string>,
      );
    } catch (err) {
      sendError(req, res, err, true);
      return;
    }
    if (options.redirect) {
      let targetUrl: string;
      try {
        targetUrl = result.success
          ? options.redirect.onSuccess(result, req)
          : options.redirect.onFailure(result, req);
      } catch (consumerErr) {
        sendError(req, res, consumerErr, false);
        return;
      }
      return res.redirect(302, targetUrl);
    }
    const { raw, ...safeResult } = result;
    res.status(result.success ? 200 : 400).json(safeResult);
  });

  // ---- GET /:provider/:id — get payment details (opt-in) -------------------
  // Registered after /:provider/redirect and /:provider/webhook so that those win.
  if (options.details && options.details.enabled !== false) {
    const detailsHandlers: RequestHandler[] = [];
    if (options.details.middleware?.length) {
      detailsHandlers.push(...options.details.middleware);
    } else {
      console.warn(
        '[awesome-node-checkout] details route mounted without middleware: payment status and amount are readable by anyone who knows a payment id',
      );
    }
    router.get('/:provider/:id', ...detailsHandlers, async (req: Request, res: Response) => {
      try {
        const result = await checkout.getPaymentDetails(String(req.params.provider), String(req.params.id));
        const { raw, ...safeResult } = result;
        res.status(result.success ? 200 : 404).json(safeResult);
      } catch (err) {
        sendError(req, res, err, true);
      }
    });
  }

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendErrorResponse(
  req: Request,
  res: Response,
  options: ExpressCheckoutOptions,
  originalErr: unknown,
  isProvider = true,
): void {
  let err = originalErr;
  const isListenerError = err instanceof CheckoutListenerError;
  if (err instanceof CheckoutListenerError && err.cause instanceof CheckoutError) {
    // A listener that throws a CheckoutError keeps its status mapping
    err = err.cause;
  }
  if (err instanceof CheckoutError) {
    if (res.headersSent) return;
    const statusMap: Record<string, number> = {
      PROVIDER_NOT_FOUND: 404,
      WEBHOOK_NOT_SUPPORTED: 422,
      REDIRECT_NOT_SUPPORTED: 422,
    };
    const status = statusMap[err.code] ?? 400;
    res.status(status).json({ success: false, error: err.message, code: err.code });
    return;
  }

  // Unexpected error (500): report it to the app, never to the client unless asked to
  try {
    if (options.onError) {
      options.onError(originalErr, req);
    } else {
      console.error('[awesome-node-checkout]', originalErr);
    }
  } catch {
    // A throwing onError must not prevent the response
  }
  if (res.headersSent) return;
  let message = 'Internal server error';
  if (options.exposeErrorMessages === true) {
    message = err instanceof Error ? err.message : String(err ?? 'Internal server error');
    if (!isListenerError && isProvider && (err instanceof SyntaxError || /JSON|Unexpected token/i.test(message))) {
      message = 'Invalid provider response';
    }
  }
  res.status(500).json({ success: false, error: message });
}
