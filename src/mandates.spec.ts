import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { PaymentRequest } from './models/payment-request.model';
import { PaymentResult, WebhookResult } from './models/payment-result.model';
import { CheckoutError } from './models/errors';
import { CheckoutEventName, CheckoutEventPayload, CheckoutListenerError } from './events/checkout-event-bus';
import { IMandateProvider, isMandateProvider } from './interfaces/mandate-provider.interface';
import {
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateSetupOutcome,
  MandateSetupRequest,
  MandateSetupStart,
} from './models/mandate.model';
import { createCheckoutRouter, ExpressMandateOptions } from './adapters/express';
import { appendMandateRef } from './utils/url';
import { redactSecret } from './utils/redact';

// ---------------------------------------------------------------------------
// Test providers
// ---------------------------------------------------------------------------

/** Copy of the DummyProvider of checkout-configurator.spec.ts (importing a spec would run it). */
class DummyProvider extends BasePaymentProvider {
  name = 'dummy';
  flow = 'redirect' as const;

  async createPayment(req: PaymentRequest): Promise<PaymentResult> {
    return { success: true, paymentId: 'dummy-123', status: 'CREATED', raw: req };
  }
  async executePayment(id: string, data?: any): Promise<PaymentResult> {
    return { success: true, verified: true, paymentId: id, status: 'COMPLETED', raw: data };
  }
  async getPaymentDetails(id: string): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'DETAILS', raw: {} };
  }
  async refundPayment(id: string, amount?: number): Promise<PaymentResult> {
    return { success: true, paymentId: id, status: 'REFUNDED', raw: { amount } };
  }
  async handleWebhook(body?: any, _headers: Record<string, string> = {}, query?: Record<string, string>): Promise<WebhookResult> {
    return { success: true, verified: true, paymentId: 'dummy-123', status: 'WEBHOOK', raw: body ?? query };
  }
  async handleRedirect(query: Record<string, any>): Promise<PaymentResult> {
    return { success: true, verified: true, paymentId: query.id, status: 'REDIRECT', raw: query };
  }
}

/** Credential-like provider id: differs from every mandateRef, and appears in the scripted raws. */
const VAULT_ID = 'vault-tok-SECRET-0001';
const CREATED_AT = '2026-12-01T10:15:00.000Z';

/**
 * Scriptable mandate provider. Every `next*` hook, when set, replaces the default result.
 * Results are built fresh on every call, so normalization can never leak between tests.
 */
class MandateDummyProvider extends DummyProvider implements IMandateProvider {
  nextStart?: (req: MandateSetupRequest) => MandateSetupStart;
  nextConfirm?: (pending: MandatePendingState, input: MandateCallbackInput) => MandateSetupOutcome;
  nextCharge?: (mandate: Mandate, charge: ChargeRequest) => ChargeResult;
  calls = {
    create: [] as MandateSetupRequest[],
    confirm: [] as [MandatePendingState, MandateCallbackInput][],
    charge: [] as [Mandate, ChargeRequest][],
    get: [] as Mandate[],
    revoke: [] as Mandate[],
  };

  async createMandate(req: MandateSetupRequest): Promise<MandateSetupStart> {
    this.calls.create.push(req);
    if (this.nextStart) return this.nextStart(req);
    return {
      success: true,
      approvalUrl: appendMandateRef('https://pay.test/approve', req.mandateRef),
      pending: {
        provider: this.name,
        mandateRef: req.mandateRef,
        orderId: req.orderId,
        amount: req.amount,
        currency: req.currency,
        providerRef: `DUMMY-${req.orderId}`,
        createdAt: CREATED_AT,
      },
      raw: { internal: 'provider-response' },
    };
  }

  async confirmMandate(pending: MandatePendingState, input: MandateCallbackInput): Promise<MandateSetupOutcome> {
    this.calls.confirm.push([pending, input]);
    if (this.nextConfirm) return this.nextConfirm(pending, input);
    return {
      success: true,
      verified: true,
      terminal: true,
      mandate: {
        provider: this.name,
        mandateRef: pending.mandateRef,
        providerMandateId: VAULT_ID,
        status: 'active',
        createdAt: CREATED_AT,
        providerData: { customerId: 'cus_1' },
      },
      firstCharge: {
        status: 'succeeded',
        verified: true,
        chargeRef: pending.orderId,
        providerPaymentId: 'PAY-FIRST',
        amount: pending.amount,
        currency: pending.currency,
        raw: { paymentSource: { vaultId: VAULT_ID } },
      },
      raw: { vault: { id: VAULT_ID, status: 'VAULTED' } },
    };
  }

  async chargeMandate(mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    this.calls.charge.push([mandate, charge]);
    if (this.nextCharge) return this.nextCharge(mandate, charge);
    return {
      status: 'succeeded',
      verified: true,
      chargeRef: charge.chargeRef,
      providerPaymentId: `PAY-${charge.chargeRef}`,
      amount: charge.amount,
      currency: charge.currency,
      raw: { paymentSource: { vaultId: mandate.providerMandateId }, note: `charged ${mandate.providerMandateId}` },
    };
  }

  async getMandate(mandate: Mandate) {
    this.calls.get.push(mandate);
    return { status: 'active' as const, verified: true };
  }

  async revokeMandate(mandate: Mandate) {
    this.calls.revoke.push(mandate);
    return { revokedAtProvider: true, raw: { deleted: mandate.providerMandateId } };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const setupRequest = (overrides: Partial<MandateSetupRequest> = {}): MandateSetupRequest => ({
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  description: 'Pro plan, monthly',
  returnUrl: 'https://app.test/checkout/dummy/mandate/callback',
  cancelUrl: 'https://app.test/checkout/dummy/mandate/callback',
  ...overrides,
});

const pendingState = (overrides: Partial<MandatePendingState> = {}): MandatePendingState => ({
  provider: 'dummy',
  mandateRef: 'MNDT0000000001',
  orderId: 'SUB-0001-INIT',
  amount: 19.9,
  currency: 'EUR',
  providerRef: 'DUMMY-SUB-0001-INIT',
  createdAt: CREATED_AT,
  ...overrides,
});

const activeMandate = (overrides: Partial<Mandate> = {}): Mandate => ({
  provider: 'dummy',
  mandateRef: 'MNDT0000000001',
  providerMandateId: VAULT_ID,
  status: 'active',
  createdAt: CREATED_AT,
  ...overrides,
});

const charge = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
  chargeRef: 'SUB-0001-2026-12',
  amount: 19.99,
  currency: 'EUR',
  ...overrides,
});

const ALL_EVENTS: CheckoutEventName[] = [
  'payment.created',
  'payment.completed',
  'payment.failed',
  'payment.refunded',
  'webhook.received',
  'mandate.setup_started',
  'mandate.created',
  'mandate.setup_failed',
  'mandate.revoked',
  'charge.succeeded',
  'charge.failed',
  'charge.unknown',
  'charge.requires_action',
];

/** Records every event emitted by the configurator, in order. */
function recordEvents(checkout: CheckoutConfigurator): { name: CheckoutEventName; payload: CheckoutEventPayload }[] {
  const seen: { name: CheckoutEventName; payload: CheckoutEventPayload }[] = [];
  for (const name of ALL_EVENTS) {
    checkout.events.on(name, (payload) => {
      seen.push({ name, payload });
    });
  }
  return seen;
}

async function rejection(promise: Promise<unknown>): Promise<CheckoutError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutError);
    return err as CheckoutError;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
// Configurator
// ---------------------------------------------------------------------------

describe('Mandates: configurator', () => {
  let checkout: CheckoutConfigurator;
  let provider: MandateDummyProvider;
  let events: { name: CheckoutEventName; payload: CheckoutEventPayload }[];

  beforeEach(() => {
    checkout = new CheckoutConfigurator({ emitEvents: true });
    provider = new MandateDummyProvider();
    checkout.registerProvider(provider);
    events = recordEvents(checkout);
  });

  describe('capability (AC 1)', () => {
    it('supportsMandates is false for the plain DummyProvider and true for MandateDummyProvider', () => {
      const plain = new CheckoutConfigurator();
      plain.registerProvider(new DummyProvider());
      expect(plain.supportsMandates('dummy')).toBe(false);
      expect(checkout.supportsMandates('dummy')).toBe(true);
    });

    it('createMandate on the plain DummyProvider throws MANDATES_NOT_SUPPORTED', async () => {
      const plain = new CheckoutConfigurator();
      plain.registerProvider(new DummyProvider());
      const err = await rejection(plain.createMandate('dummy', setupRequest()));
      expect(err.code).toBe('MANDATES_NOT_SUPPORTED');
      expect(err.provider).toBe('dummy');
      for (const call of [
        plain.confirmMandate('dummy', pendingState(), {}),
        plain.chargeMandate('dummy', activeMandate(), charge()),
        plain.getMandate('dummy', activeMandate()),
        plain.revokeMandate('dummy', activeMandate()),
      ]) {
        expect((await rejection(call)).code).toBe('MANDATES_NOT_SUPPORTED');
      }
    });

    it('isMandateProvider requires all five methods to be functions', () => {
      expect(isMandateProvider(new MandateDummyProvider())).toBe(true);
      expect(isMandateProvider(new DummyProvider())).toBe(false);
      const fns = {
        createMandate: () => undefined,
        confirmMandate: () => undefined,
        chargeMandate: () => undefined,
        getMandate: () => undefined,
        revokeMandate: () => undefined,
      };
      expect(isMandateProvider(fns)).toBe(true);
      expect(isMandateProvider({ ...fns, revokeMandate: 'nope' })).toBe(false);
      expect(isMandateProvider(null)).toBe(false);
      expect(isMandateProvider('dummy')).toBe(false);
    });

    it('supportsMandates throws PROVIDER_NOT_FOUND for an unregistered provider', () => {
      expect(() => checkout.supportsMandates('ghost')).toThrowError(CheckoutError);
    });
  });

  describe('createMandate validation (AC 2)', () => {
    const invalid: [string, Partial<MandateSetupRequest>][] = [
      ["mandateRef 'abc' (too short)", { mandateRef: 'abc' }],
      ["mandateRef 'x'.repeat(31)", { mandateRef: 'x'.repeat(31) }],
      ["mandateRef 'a b c d e'", { mandateRef: 'a b c d e' }],
      ["orderId ''", { orderId: '' }],
      ["orderId 'SUB_0001' (underscore)", { orderId: 'SUB_0001' }],
      ["description ''", { description: '' }],
      ['description of 128 chars', { description: 'd'.repeat(128) }],
      ["returnUrl ''", { returnUrl: '' }],
      ["cancelUrl ''", { cancelUrl: '' }],
      ["returnUrl '/checkout/dummy/mandate/callback' (relative)", { returnUrl: '/checkout/dummy/mandate/callback' }],
      ["cancelUrl 'ftp://app.test/cancel'", { cancelUrl: 'ftp://app.test/cancel' }],
      ["returnUrl 'javascript:alert(1)'", { returnUrl: 'javascript:alert(1)' }],
      ["notifyUrl 'not a url'", { notifyUrl: 'not a url' }],
      ["notifyUrl ''", { notifyUrl: '' }],
    ];

    it('accepts an absolute http(s) notifyUrl', async () => {
      const start = await checkout.createMandate(
        'dummy',
        setupRequest({ notifyUrl: 'https://app.test/checkout/dummy/mandate/callback' }),
      );
      expect(start.success).toBe(true);
      expect(provider.calls.create).toHaveLength(1);
    });

    it.each(invalid)('rejects %s with INVALID_MANDATE_REQUEST without calling the provider', async (_label, overrides) => {
      const err = await rejection(checkout.createMandate('dummy', setupRequest(overrides)));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(provider.calls.create).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('rejects amount 19.999 with INVALID_AMOUNT without calling the provider', async () => {
      const err = await rejection(checkout.createMandate('dummy', setupRequest({ amount: 19.999 })));
      expect(err.code).toBe('INVALID_AMOUNT');
      expect(provider.calls.create).toHaveLength(0);
    });

    it("rejects chargeRef 'x' (too short) on chargeMandate without calling the provider", async () => {
      const err = await rejection(checkout.chargeMandate('dummy', activeMandate(), charge({ chargeRef: 'x' })));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(provider.calls.charge).toHaveLength(0);
    });

    it('rejects chargeRef with an underscore and amount 19.999 on chargeMandate', async () => {
      expect((await rejection(checkout.chargeMandate('dummy', activeMandate(), charge({ chargeRef: 'SUB_0001' })))).code)
        .toBe('INVALID_MANDATE_REQUEST');
      expect((await rejection(checkout.chargeMandate('dummy', activeMandate(), charge({ amount: 19.999 })))).code)
        .toBe('INVALID_AMOUNT');
      expect(provider.calls.charge).toHaveLength(0);
    });

    it('accepts the boundaries of the documented patterns', async () => {
      const start = await checkout.createMandate(
        'dummy',
        setupRequest({ mandateRef: 'a_b-C'.padEnd(30, '9'), orderId: 'AB', description: 'd'.repeat(127) }),
      );
      expect(start.success).toBe(true);
      expect(provider.calls.create).toHaveLength(1);
    });
  });

  describe('createMandate result', () => {
    it('returns the start and emits mandate.setup_started with verified: false', async () => {
      const start = await checkout.createMandate('dummy', setupRequest());
      expect(start.success).toBe(true);
      expect(start.approvalUrl).toBe('https://pay.test/approve?mandate_ref=MNDT0000000001');
      expect(start.pending).toEqual(pendingState());
      expect(events.map((e) => e.name)).toEqual(['mandate.setup_started']);
      expect(events[0].payload).toMatchObject({
        provider: 'dummy',
        orderId: 'SUB-0001-INIT',
        verified: false,
        data: { mandateRef: 'MNDT0000000001' },
      });
    });

    it('returns success: false when the provider returns a different pending.mandateRef (AC 3)', async () => {
      provider.nextStart = (req) => ({
        success: true,
        approvalUrl: 'https://pay.test/approve',
        pending: { ...pendingState(), mandateRef: 'MNDT9999999999', orderId: req.orderId },
      });
      const start = await checkout.createMandate('dummy', setupRequest());
      expect(start.success).toBe(false);
      expect(start.pending).toBeUndefined();
      expect(start.approvalUrl).toBeUndefined();
      expect(start.error).toBe('Mandate setup does not match the request');
      expect(events).toHaveLength(0);
    });

    it('returns success: false for a pending.provider or pending.orderId that differs, or no pending', async () => {
      provider.nextStart = () => ({ success: true, approvalUrl: 'https://pay.test', pending: pendingState({ provider: 'other' }) });
      expect((await checkout.createMandate('dummy', setupRequest())).success).toBe(false);
      provider.nextStart = () => ({ success: true, approvalUrl: 'https://pay.test', pending: pendingState({ orderId: 'SUB-0002-INIT' }) });
      expect((await checkout.createMandate('dummy', setupRequest())).success).toBe(false);
      provider.nextStart = () => ({ success: true, approvalUrl: 'https://pay.test' });
      expect((await checkout.createMandate('dummy', setupRequest())).success).toBe(false);
      expect(events).toHaveLength(0);
    });

    it('keeps the provider error of a failed start and emits nothing', async () => {
      provider.nextStart = () => ({ success: false, error: 'Nexi mandates support EUR only' });
      const start = await checkout.createMandate('dummy', setupRequest());
      expect(start).toMatchObject({ success: false, error: 'Nexi mandates support EUR only' });
      expect(events).toHaveLength(0);
    });
  });

  describe('confirmMandate normalization (AC 4)', () => {
    it('an unverified "success" is a non-terminal failure without mandate, and emits no event', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: false,
        terminal: true,
        mandate: activeMandate(),
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId, providerPaymentId: 'PAY-X' },
      });
      const emitSpy = vi.spyOn(checkout.events, 'emit');
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome.success).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.terminal).toBe(false);
      expect(outcome.mandate).toBeUndefined();
      expect(outcome.firstCharge.status).toBe('unknown');
      expect(outcome.firstCharge.verified).toBe(false);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it('an unverified failed first charge stays failed (only succeeded is downgraded)', async () => {
      provider.nextConfirm = (pending) => ({
        success: false,
        verified: false,
        terminal: false,
        firstCharge: { status: 'failed', verified: false, chargeRef: pending.orderId, error: 'local refusal' },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome.firstCharge.status).toBe('failed');
      expect(outcome.firstCharge.error).toBe('local refusal');
      expect(events).toHaveLength(0);
    });

    it('a verified terminal refusal emits mandate.setup_failed and passes the assertions', async () => {
      provider.nextConfirm = (pending) => ({
        success: false,
        verified: true,
        terminal: true,
        error: 'Payment refused',
        firstCharge: { status: 'failed', verified: true, chargeRef: pending.orderId, error: 'KO', providerCode: '19' },
        raw: { vault: { id: VAULT_ID } },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({ success: false, verified: true, terminal: true, error: 'Payment refused' });
      expect(outcome.mandate).toBeUndefined();
      expect(outcome.firstCharge.status).toBe('failed');
      expect(events.map((e) => e.name)).toEqual(['mandate.setup_failed', 'charge.failed']);
      expect(events[0].payload).toMatchObject({
        provider: 'dummy',
        orderId: 'SUB-0001-INIT',
        verified: true,
        error: 'Payment refused',
        data: { mandateRef: 'MNDT0000000001' },
      });
    });

    it('a verified outcome whose mandate.mandateRef differs from pending.mandateRef returns failure', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: true,
        mandate: activeMandate({ mandateRef: 'MNDT9999999999' }),
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({
        success: false,
        verified: false,
        terminal: false,
        error: 'Mandate outcome does not match the pending setup',
      });
      expect(outcome.mandate).toBeUndefined();
      expect(outcome.firstCharge.status).toBe('unknown');
      expect(events).toHaveLength(0);
    });

    it('a verified outcome with another mandate.provider or firstCharge.chargeRef returns failure', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: true,
        mandate: activeMandate({ provider: 'other' }),
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId },
      });
      expect((await checkout.confirmMandate('dummy', pendingState(), {})).error).toBe(
        'Mandate outcome does not match the pending setup',
      );
      provider.nextConfirm = () => ({
        success: false,
        verified: true,
        terminal: true,
        firstCharge: { status: 'failed', verified: true, chargeRef: 'SUB-0002-INIT' },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
      expect(outcome.firstCharge.chargeRef).toBe('SUB-0001-INIT');
      expect(events).toHaveLength(0);
    });

    it("a pending.provider of 'other' throws INVALID_MANDATE_REQUEST without calling the provider", async () => {
      const err = await rejection(checkout.confirmMandate('dummy', pendingState({ provider: 'other' }), {}));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(provider.calls.confirm).toHaveLength(0);
    });

    it('a verified success emits mandate.created, then charge.succeeded, without providerMandateId', async () => {
      const outcome = await checkout.confirmMandate('dummy', pendingState(), { query: { mandate_ref: 'MNDT0000000001' } });
      expect(outcome).toMatchObject({ success: true, verified: true, terminal: true });
      expect(outcome.mandate?.providerMandateId).toBe(VAULT_ID);
      // The returned result keeps the full provider raw
      expect(JSON.stringify(outcome.raw)).toContain(VAULT_ID);
      expect(outcome.firstCharge).toMatchObject({ status: 'succeeded', chargeRef: 'SUB-0001-INIT', providerPaymentId: 'PAY-FIRST' });
      expect(events.map((e) => e.name)).toEqual(['mandate.created', 'charge.succeeded']);
      expect(events[0].payload).toMatchObject({ orderId: 'SUB-0001-INIT', verified: true, data: { mandateRef: 'MNDT0000000001' } });
      expect(events[1].payload).toMatchObject({ orderId: 'SUB-0001-INIT', paymentId: 'PAY-FIRST', verified: true });
      for (const { payload } of events) {
        expect(JSON.stringify(payload)).not.toContain(VAULT_ID);
      }
    });

    it('a verified success is always terminal', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: false,
        mandate: activeMandate(),
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId },
      });
      expect((await checkout.confirmMandate('dummy', pendingState(), {})).terminal).toBe(true);
    });

    it('success: true without an active mandate is treated as a mismatch', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: true,
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
      expect(events).toHaveLength(0);
    });

    it('a verified but non-terminal outcome (authorization pending) emits nothing', async () => {
      provider.nextConfirm = (pending) => ({
        success: false,
        verified: true,
        terminal: false,
        error: 'AUTHORIZATION_PENDING',
        firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({ success: false, verified: true, terminal: false, error: 'AUTHORIZATION_PENDING' });
      expect(events).toHaveLength(0);
    });

    it('keeps mixed terminal outcomes: no mandate with a succeeded first charge', async () => {
      provider.nextConfirm = (pending) => ({
        success: false,
        verified: true,
        terminal: true,
        error: 'MANDATE_NOT_VAULTED',
        firstCharge: {
          status: 'succeeded', verified: true, chargeRef: pending.orderId, providerPaymentId: 'ORDER-1', amount: 19.9, currency: 'EUR',
        },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome).toMatchObject({ success: false, terminal: true, error: 'MANDATE_NOT_VAULTED' });
      expect(outcome.firstCharge.status).toBe('succeeded');
      expect(events.map((e) => e.name)).toEqual(['mandate.setup_failed', 'charge.succeeded']);
    });

    it('keeps mixed terminal outcomes: an active mandate with a failed first charge', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: true,
        mandate: activeMandate(),
        firstCharge: { status: 'failed', verified: true, chargeRef: pending.orderId, providerCode: '36', error: 'x' },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome.success).toBe(true);
      expect(outcome.firstCharge).toMatchObject({ status: 'failed', providerCode: '36', error: 'x' });
      expect(events.map((e) => e.name)).toEqual(['mandate.created', 'charge.failed']);
    });

    it('a first charge reported for another amount becomes unknown', async () => {
      provider.nextConfirm = (pending) => ({
        success: true,
        verified: true,
        terminal: true,
        mandate: activeMandate(),
        firstCharge: { status: 'succeeded', verified: true, chargeRef: pending.orderId, amount: 9.9, currency: 'EUR' },
      });
      const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
      expect(outcome.success).toBe(true);
      expect(outcome.firstCharge).toMatchObject({ status: 'unknown', error: 'Charged amount does not match the request' });
      expect(events.map((e) => e.name)).toEqual(['mandate.created', 'charge.unknown']);
    });

    it('never mutates the object returned by the provider', async () => {
      const scripted: MandateSetupOutcome = Object.freeze({
        success: true,
        verified: false,
        terminal: true,
        firstCharge: Object.freeze({ status: 'succeeded' as const, verified: true, chargeRef: 'SUB-0001-INIT' }),
      });
      provider.nextConfirm = () => scripted;
      await checkout.confirmMandate('dummy', pendingState(), {});
      expect(scripted.success).toBe(true);
      expect(scripted.firstCharge.status).toBe('succeeded');
    });
  });

  describe('chargeMandate (AC 5)', () => {
    it('a revoked mandate returns mandateUnusable: true and the provider is not called', async () => {
      const result = await checkout.chargeMandate('dummy', activeMandate({ status: 'revoked' }), charge());
      expect(result).toEqual({
        status: 'failed',
        verified: false,
        chargeRef: 'SUB-0001-2026-12',
        error: 'Mandate is revoked',
        mandateUnusable: true,
      });
      expect(provider.calls.charge).toHaveLength(0);
    });

    it('a provider succeeded with verified: false becomes unknown', async () => {
      provider.nextCharge = (_m, c) => ({ status: 'succeeded', verified: false, chargeRef: c.chargeRef, providerPaymentId: 'PAY-1' });
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
    });

    it('a verified succeeded with amount 9.99 for a request of 19.99 becomes unknown with the mismatch error', async () => {
      provider.nextCharge = (_m, c) => ({ status: 'succeeded', verified: true, chargeRef: c.chargeRef, amount: 9.99, currency: 'EUR' });
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge({ amount: 19.99 }));
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('Charged amount does not match the request');
    });

    it('a verified succeeded in another currency becomes unknown; absent amount and currency are not compared', async () => {
      provider.nextCharge = (_m, c) => ({ status: 'succeeded', verified: true, chargeRef: c.chargeRef, amount: 19.99, currency: 'USD' });
      expect((await checkout.chargeMandate('dummy', activeMandate(), charge())).status).toBe('unknown');
      provider.nextCharge = (_m, c) => ({ status: 'succeeded', verified: true, chargeRef: c.chargeRef, providerPaymentId: c.chargeRef });
      expect((await checkout.chargeMandate('dummy', activeMandate(), charge())).status).toBe('succeeded');
      provider.nextCharge = (_m, c) => ({ status: 'succeeded', verified: true, chargeRef: c.chargeRef, amount: 19.99, currency: 'EUR' });
      expect((await checkout.chargeMandate('dummy', activeMandate(), charge())).status).toBe('succeeded');
    });

    it("the result's chargeRef always equals the request's", async () => {
      provider.nextCharge = () => ({ status: 'failed', verified: true, chargeRef: 'SOMETHING-ELSE', error: 'declined' });
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
      expect(result.chargeRef).toBe('SUB-0001-2026-12');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('declined');
    });

    it('an unverified failed passes through as failed', async () => {
      provider.nextCharge = (_m, c) => ({ status: 'failed', verified: false, chargeRef: c.chargeRef, error: 'Nexi mandates support EUR only' });
      expect((await checkout.chargeMandate('dummy', activeMandate(), charge())).status).toBe('failed');
    });

    it('a provider that throws gives unknown; validation errors still propagate', async () => {
      provider.nextCharge = () => {
        throw new Error(`socket hang up for ${VAULT_ID}`);
      };
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
      expect(result).toMatchObject({ status: 'unknown', verified: false, chargeRef: 'SUB-0001-2026-12' });
      expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
      expect(JSON.stringify(events[0].payload)).not.toContain(VAULT_ID);
    });

    it('a thrown SDK error reaches raw and charge.unknown only as { name, message }', async () => {
      provider.nextCharge = () => {
        const err = Object.assign(new Error('Request failed with status 500'), {
          request: {
            method: 'POST',
            headers: { Authorization: 'Bearer A21AAsecretAccessToken' },
            body: JSON.stringify({ payment_source: { token: { id: VAULT_ID, type: 'BILLING_AGREEMENT' } } }),
          },
          headers: { 'paypal-debug-id': 'dbg-1' },
          body: '{"name":"INTERNAL_SERVER_ERROR"}',
          statusCode: 500,
        });
        throw err;
      };
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
      expect(result.status).toBe('unknown');
      expect(result.raw).toEqual({ name: 'Error', message: 'Request failed with status 500' });
      expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
      expect(events[0].payload.raw).toEqual({ name: 'Error', message: 'Request failed with status 500' });
      const serialized = JSON.stringify(events[0].payload);
      expect(serialized).not.toContain('A21AAsecretAccessToken');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain(VAULT_ID);
    });

    it('a thrown non-Error value gives unknown with no raw', async () => {
      provider.nextCharge = () => {
        throw { headers: { Authorization: 'Bearer A21AAsecretAccessToken' } };
      };
      const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
      expect(result.status).toBe('unknown');
      expect(result.raw).toBeUndefined();
      expect(JSON.stringify(events[0].payload)).not.toContain('A21AAsecretAccessToken');
    });

    it('a mandate of another provider is rejected with INVALID_MANDATE_REQUEST', async () => {
      const err = await rejection(checkout.chargeMandate('dummy', activeMandate({ provider: 'other' }), charge()));
      expect(err.code).toBe('INVALID_MANDATE_REQUEST');
      expect(provider.calls.charge).toHaveLength(0);
    });

    const statuses: ChargeResult['status'][] = ['succeeded', 'failed', 'unknown', 'requires_action'];
    it.each(statuses)(
      'emits charge.%s with orderId === chargeRef and no providerMandateId in the payload',
      async (status) => {
        provider.nextCharge = (m, c) => ({
          status,
          verified: true,
          chargeRef: c.chargeRef,
          providerPaymentId: `PAY-${c.chargeRef}`,
          error: status === 'succeeded' ? undefined : `refused for token ${m.providerMandateId}`,
          raw: { paymentSource: { paypal: { vaultId: m.providerMandateId } }, list: [m.providerMandateId] },
        });
        const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
        expect(result.status).toBe(status);
        // The returned result keeps the provider's raw untouched
        expect(JSON.stringify(result.raw)).toContain(VAULT_ID);
        expect(events).toHaveLength(1);
        const { name, payload } = events[0];
        expect(name).toBe(`charge.${status}`);
        expect(payload.orderId).toBe('SUB-0001-2026-12');
        expect(payload.paymentId).toBe('PAY-SUB-0001-2026-12');
        expect(payload.data.mandateRef).toBe('MNDT0000000001');
        expect(JSON.stringify(payload)).not.toContain(VAULT_ID);
      },
    );

    it('the revoked short-circuit emits charge.failed', async () => {
      await checkout.chargeMandate('dummy', activeMandate({ status: 'revoked' }), charge());
      expect(events.map((e) => e.name)).toEqual(['charge.failed']);
      expect(events[0].payload).toMatchObject({ orderId: 'SUB-0001-2026-12', verified: false, data: { mandateUnusable: true } });
    });
  });

  describe('getMandate and revokeMandate', () => {
    it('getMandate passes the provider result through', async () => {
      expect(await checkout.getMandate('dummy', activeMandate())).toEqual({ status: 'active', verified: true });
      expect(provider.calls.get).toHaveLength(1);
    });

    it('revokeMandate emits mandate.revoked with data.revokedAtProvider and no providerMandateId', async () => {
      const result = await checkout.revokeMandate('dummy', activeMandate());
      expect(result.revokedAtProvider).toBe(true);
      expect(events.map((e) => e.name)).toEqual(['mandate.revoked']);
      expect(events[0].payload.data).toEqual({ mandateRef: 'MNDT0000000001', revokedAtProvider: true });
      expect(JSON.stringify(events[0].payload)).not.toContain(VAULT_ID);
    });
  });

  describe('JSON round trip and restart (AC 9)', () => {
    it('pending state and mandate survive JSON and are accepted by a fresh configurator', async () => {
      const start = await checkout.createMandate('dummy', setupRequest());
      const pending: MandatePendingState = JSON.parse(JSON.stringify(start.pending));
      expect(pending).toEqual(start.pending);

      // Simulated restart: new configurator, new provider instance, nothing shared in memory
      const restarted = new CheckoutConfigurator();
      restarted.registerProvider(new MandateDummyProvider());
      const outcome = await restarted.confirmMandate('dummy', pending, { query: { mandate_ref: pending.mandateRef } });
      expect(outcome.success).toBe(true);
      const mandate: Mandate = JSON.parse(JSON.stringify(outcome.mandate));
      expect(mandate).toEqual(outcome.mandate);

      const again = new CheckoutConfigurator();
      again.registerProvider(new MandateDummyProvider());
      const result = await again.chargeMandate('dummy', mandate, charge());
      expect(result).toMatchObject({ status: 'succeeded', verified: true, chargeRef: 'SUB-0001-2026-12' });
    });
  });
});

// ---------------------------------------------------------------------------
// Express adapter
// ---------------------------------------------------------------------------

describe('Mandates: Express adapter (AC 6, 7)', () => {
  let checkout: CheckoutConfigurator;
  let provider: MandateDummyProvider;
  const buildPaymentRequest = () => ({
    amount: 10,
    currency: 'EUR',
    returnUrl: 'https://app.test/ok',
    cancelUrl: 'https://app.test/ko',
  });

  /** Reference app: pending states keyed by mandateRef, single-use. */
  function referenceStore() {
    const pendings = new Map<string, { pending: MandatePendingState; consumed: boolean }>();
    const mandates = new Map<string, Mandate>();
    const hooks: ExpressMandateOptions = {
      buildMandateRequest: () => setupRequest(),
      onStarted: (start) => {
        if (start.success && start.pending) {
          pendings.set(start.pending.mandateRef, { pending: start.pending, consumed: false });
        }
      },
      loadPending: (_req, { mandateRef }) => {
        const row = pendings.get(mandateRef);
        return row && !row.consumed ? row.pending : null;
      },
      onOutcome: (outcome, _req, res) => {
        if (outcome.terminal) {
          const row = pendings.get(outcome.mandate?.mandateRef ?? '') ?? [...pendings.values()][0];
          // Conditional update: act only if still pending
          if (row && !row.consumed) {
            row.consumed = true;
            if (outcome.mandate) mandates.set(outcome.mandate.mandateRef, outcome.mandate);
          }
        }
        res.redirect(302, outcome.success ? '/app/subscribed' : '/app/subscription-failed');
      },
    };
    return { pendings, mandates, hooks };
  }

  function makeApp(options: Parameters<typeof createCheckoutRouter>[1], before?: express.RequestHandler): Express {
    const app = express();
    if (before) app.use(before);
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use('/checkout', createCheckoutRouter(checkout, options));
    return app;
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    checkout = new CheckoutConfigurator({ emitEvents: false });
    provider = new MandateDummyProvider();
    checkout.registerProvider(provider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shared middleware calling next(err)', () => {
    const unauthorized = () => Object.assign(new Error('unauthorized'), { status: 401 });

    it('next(err) stops POST /:provider/mandate: the error reaches Express, onStarted and the provider are not called', async () => {
      const { hooks } = referenceStore();
      const onStarted = vi.fn(hooks.onStarted);
      const app = makeApp({
        buildPaymentRequest,
        middleware: [(_q, _s, next) => next(unauthorized())],
        mandates: { ...hooks, onStarted },
      });
      const res = await request(app).post('/checkout/dummy/mandate').send({});
      expect(res.status).toBe(401);
      expect(res.body.success).toBeUndefined();
      expect(onStarted).not.toHaveBeenCalled();
      expect(provider.calls.create).toHaveLength(0);
    });

    it('next(err) stops POST /:provider too', async () => {
      const create = vi.spyOn(provider, 'createPayment');
      const app = makeApp({ buildPaymentRequest, middleware: [(_q, _s, next) => next(unauthorized())] });
      expect((await request(app).post('/checkout/dummy').send({})).status).toBe(401);
      expect(create).not.toHaveBeenCalled();
    });

    it("next(err) in the second middleware stops the chain; next('route') continues to the next one", async () => {
      const { hooks } = referenceStore();
      const second = vi.fn((_q: Request, _s: Response, next: NextFunction) => next(unauthorized()));
      const app = makeApp({
        buildPaymentRequest,
        middleware: [(_q, _s, next) => next('route'), second],
        mandates: hooks,
      });
      expect((await request(app).post('/checkout/dummy/mandate').send({})).status).toBe(401);
      expect(second).toHaveBeenCalledTimes(1);
      expect(provider.calls.create).toHaveLength(0);
    });

    it("next('router') leaves the checkout router (404) without reaching the route", async () => {
      const { hooks } = referenceStore();
      const app = makeApp({ buildPaymentRequest, middleware: [(_q, _s, next) => next('router')], mandates: hooks });
      expect((await request(app).post('/checkout/dummy/mandate').send({})).status).toBe(404);
      expect(provider.calls.create).toHaveLength(0);
    });

    it('next() with no argument still reaches the route (201)', async () => {
      const { hooks } = referenceStore();
      const app = makeApp({ buildPaymentRequest, middleware: [(_q, _s, next) => next()], mandates: hooks });
      expect((await request(app).post('/checkout/dummy/mandate').send({})).status).toBe(201);
    });
  });

  it('throws INSECURE_CONFIGURATION when mandates lacks one of the four hooks', () => {
    const buildMandateRequest = () => setupRequest();
    let thrown: unknown;
    try {
      createCheckoutRouter(checkout, { buildPaymentRequest, mandates: { buildMandateRequest } as any });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CheckoutError);
    expect((thrown as CheckoutError).code).toBe('INSECURE_CONFIGURATION');

    const { hooks } = referenceStore();
    for (const hook of ['buildMandateRequest', 'loadPending', 'onOutcome', 'onStarted'] as const) {
      const partial: any = { ...hooks };
      delete partial[hook];
      expect(() => createCheckoutRouter(checkout, { buildPaymentRequest, mandates: partial })).toThrow(CheckoutError);
    }
    expect(() => createCheckoutRouter(checkout, { buildPaymentRequest, mandates: hooks })).not.toThrow();
  });

  it('without mandates, POST /checkout/dummy/mandate is 404', async () => {
    const app = makeApp({ buildPaymentRequest });
    expect((await request(app).post('/checkout/dummy/mandate').send({})).status).toBe(404);
    expect((await request(app).get('/checkout/dummy/mandate/callback?mandate_ref=MNDT0000000001')).status).toBe(404);
    expect(provider.calls.create).toHaveLength(0);
  });

  it('POST /:provider/mandate awaits onStarted before the response, and returns approvalUrl only', async () => {
    const order: string[] = [];
    const { hooks } = referenceStore();
    const onStarted = vi.fn(async (start: MandateSetupStart) => {
      order.push('onStarted:begin');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('onStarted:end');
      expect(start.pending).toEqual(pendingState());
    });
    const recordFinish = (_req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => order.push('response'));
      next();
    };
    const app = makeApp({ buildPaymentRequest, mandates: { ...hooks, onStarted } }, recordFinish);

    const res = await request(app).post('/checkout/dummy/mandate').send({ plan: 'pro', amount: 0.01 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, approvalUrl: 'https://pay.test/approve?mandate_ref=MNDT0000000001' });
    expect(res.body.pending).toBeUndefined();
    expect(res.body.raw).toBeUndefined();
    expect(order).toEqual(['onStarted:begin', 'onStarted:end', 'response']);
    expect(onStarted).toHaveBeenCalledTimes(1);
    // The client body never reaches the provider: the request comes from buildMandateRequest
    expect(provider.calls.create[0]).toEqual(setupRequest());
  });

  it('POST /:provider/mandate answers 400 for a missing request or an invalid one, 422 without support', async () => {
    const { hooks } = referenceStore();
    let app = makeApp({ buildPaymentRequest, mandates: { ...hooks, buildMandateRequest: () => null } });
    expect((await request(app).post('/checkout/dummy/mandate')).status).toBe(400);

    app = makeApp({ buildPaymentRequest, mandates: { ...hooks, buildMandateRequest: () => setupRequest({ orderId: 'SUB_1' }) } });
    const invalid = await request(app).post('/checkout/dummy/mandate');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_MANDATE_REQUEST');

    app = makeApp({ buildPaymentRequest, mandates: { ...hooks, buildMandateRequest: () => setupRequest({ amount: 19.999 }) } });
    expect((await request(app).post('/checkout/dummy/mandate')).body.code).toBe('INVALID_AMOUNT');

    const plain = new CheckoutConfigurator();
    plain.registerProvider(new DummyProvider());
    const plainApp = express();
    plainApp.use(express.json());
    plainApp.use('/checkout', createCheckoutRouter(plain, { buildPaymentRequest, mandates: hooks }));
    const unsupported = await request(plainApp).post('/checkout/dummy/mandate');
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.code).toBe('MANDATES_NOT_SUPPORTED');
  });

  it('the callback answers 400 for an invalid mandate_ref and 404 for an unknown one', async () => {
    const { hooks } = referenceStore();
    const app = makeApp({ buildPaymentRequest, mandates: hooks });
    expect((await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'bad ref' })).status).toBe(400);
    expect((await request(app).get('/checkout/dummy/mandate/callback')).status).toBe(400);
    expect((await request(app).get('/checkout/dummy/mandate/callback?mandate_ref=A&mandate_ref=B')).status).toBe(400);
    const unknown = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000404' });
    expect(unknown.status).toBe(404);
    expect(provider.calls.confirm).toHaveLength(0);
  });

  it("a valid ref calls confirmMandate with the loaded pending state and the request's query, body and headers", async () => {
    const { hooks } = referenceStore();
    const confirmSpy = vi.spyOn(checkout, 'confirmMandate');
    const app = makeApp({ buildPaymentRequest, mandates: { ...hooks, onOutcome: () => undefined } });
    await request(app).post('/checkout/dummy/mandate');

    const res = await request(app)
      .post('/checkout/dummy/mandate/callback?mandate_ref=MNDT0000000001&esito=OK')
      .set('X-Test', 'yes')
      .type('form')
      .send({ codTrans: 'SUB-0001-INIT', mac: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const [name, pending, input] = confirmSpy.mock.calls[0];
    expect(name).toBe('dummy');
    expect(pending).toEqual(pendingState());
    expect(input?.query).toEqual({ mandate_ref: 'MNDT0000000001', esito: 'OK' });
    expect(input?.body).toEqual({ codTrans: 'SUB-0001-INIT', mac: 'abc' });
    expect(input?.headers?.['x-test']).toBe('yes');
    expect(input?.context?.method).toBe('POST');
    expect(input?.context?.path).toBe('/checkout/dummy/mandate/callback?mandate_ref=MNDT0000000001&esito=OK');
    // The provider receives the same pending state and input
    expect(provider.calls.confirm[0][0]).toEqual(pendingState());
    expect(provider.calls.confirm[0][1].query).toEqual({ mandate_ref: 'MNDT0000000001', esito: 'OK' });
  });

  it('onOutcome decides the response; without one the route answers 200 { success }', async () => {
    const { hooks } = referenceStore();
    const app = makeApp({ buildPaymentRequest, mandates: hooks });
    await request(app).post('/checkout/dummy/mandate');
    const res = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/subscribed');

    provider.nextConfirm = (pending) => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId },
    });
    const silent = makeApp({ buildPaymentRequest, mandates: { ...hooks, loadPending: () => pendingState(), onOutcome: () => undefined } });
    const unverified = await request(silent).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(unverified.status).toBe(200);
    expect(unverified.body).toEqual({ success: false });
  });

  it('with details mounted, GET /checkout/dummy/mandate/callback is not routed to getPaymentDetails', async () => {
    const { hooks } = referenceStore();
    const detailsSpy = vi.spyOn(checkout, 'getPaymentDetails');
    const app = makeApp({ buildPaymentRequest, details: {}, mandates: hooks });
    expect((await request(app).get('/checkout/dummy/mandate/callback')).status).toBe(400);
    expect((await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000404' })).status).toBe(404);
    expect((await request(app).get('/checkout/dummy/mandate')).status).toBe(405);
    expect(detailsSpy).not.toHaveBeenCalled();
    // Other ids still reach the details route
    await request(app).get('/checkout/dummy/PAY-1');
    expect(detailsSpy).toHaveBeenCalledWith('dummy', 'PAY-1');
  });

  it('the shared middleware does not apply to the callback, but applies to POST /:provider/mandate', async () => {
    const { hooks } = referenceStore();
    const deny403 = (_req: Request, res: Response) => {
      res.status(403).json({ error: 'forbidden' });
    };
    const app = makeApp({ buildPaymentRequest, middleware: [deny403], mandates: { ...hooks, loadPending: () => pendingState() } });
    expect((await request(app).post('/checkout/dummy/mandate')).status).toBe(403);
    expect(provider.calls.create).toHaveLength(0);
    const callback = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(callback.status).toBe(302);
    expect(provider.calls.confirm).toHaveLength(1);
    // Other routes stay protected
    expect((await request(app).post('/checkout/dummy').send({})).status).toBe(403);
  });

  it('mandates.middleware applies to POST /:provider/mandate only', async () => {
    const { hooks } = referenceStore();
    const deny401 = (_req: Request, res: Response) => {
      res.status(401).json({ error: 'login' });
    };
    const app = makeApp({ buildPaymentRequest, mandates: { ...hooks, middleware: [deny401], loadPending: () => pendingState() } });
    expect((await request(app).post('/checkout/dummy/mandate')).status).toBe(401);
    expect((await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' })).status).toBe(302);
  });

  it('single-use pending state: a replayed callback after a terminal outcome answers 404 without reaching the provider', async () => {
    const { hooks, pendings, mandates } = referenceStore();
    const app = makeApp({ buildPaymentRequest, mandates: hooks });
    await request(app).post('/checkout/dummy/mandate');
    expect(pendings.get('MNDT0000000001')?.consumed).toBe(false);

    const first = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(first.status).toBe(302);
    expect(provider.calls.confirm).toHaveLength(1);
    expect(pendings.get('MNDT0000000001')?.consumed).toBe(true);
    expect(mandates.get('MNDT0000000001')?.providerMandateId).toBe(VAULT_ID);

    const replay = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(replay.status).toBe(404);
    expect(provider.calls.confirm).toHaveLength(1);
  });

  it('single-use pending state: after a non-terminal outcome a second callback reaches the provider', async () => {
    const { hooks, pendings } = referenceStore();
    const app = makeApp({ buildPaymentRequest, mandates: hooks });
    await request(app).post('/checkout/dummy/mandate');

    provider.nextConfirm = (pending) => ({
      success: false,
      verified: false,
      terminal: false,
      error: 'Invalid outcome MAC',
      firstCharge: { status: 'unknown', verified: false, chargeRef: pending.orderId },
    });
    const forged = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(forged.status).toBe(302);
    expect(forged.headers.location).toBe('/app/subscription-failed');
    expect(pendings.get('MNDT0000000001')?.consumed).toBe(false);

    provider.nextConfirm = undefined;
    const genuine = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(genuine.status).toBe(302);
    expect(genuine.headers.location).toBe('/app/subscribed');
    expect(provider.calls.confirm).toHaveLength(2);
    expect(pendings.get('MNDT0000000001')?.consumed).toBe(true);
  });

  it('there is no route for charge or revoke', async () => {
    const { hooks } = referenceStore();
    const app = makeApp({ buildPaymentRequest, mandates: hooks });
    expect((await request(app).post('/checkout/dummy/mandate/charge').send({})).status).toBe(404);
    expect((await request(app).post('/checkout/dummy/mandate/revoke').send({})).status).toBe(404);
    expect(provider.calls.charge).toHaveLength(0);
    expect(provider.calls.revoke).toHaveLength(0);
  });

  it('consumer hook errors answer a generic 500 and go to onError', async () => {
    const { hooks } = referenceStore();
    const onError = vi.fn();
    const app = makeApp({
      buildPaymentRequest,
      onError,
      mandates: { ...hooks, onStarted: () => { throw new Error('db down'); } },
    });
    const res = await request(app).post('/checkout/dummy/mandate');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Review findings
// ---------------------------------------------------------------------------

describe('Mandates: listener errors after the provider call', () => {
  let provider: MandateDummyProvider;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    provider = new MandateDummyProvider();
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function make(config: ConstructorParameters<typeof CheckoutConfigurator>[0] = {}): CheckoutConfigurator {
    const checkout = new CheckoutConfigurator(config);
    checkout.registerProvider(provider);
    return checkout;
  }

  it('chargeMandate resolves with the verified result when a charge.succeeded listener throws', async () => {
    const onListenerError = vi.fn();
    const checkout = make({ onListenerError });
    checkout.events.on('charge.succeeded', () => {
      throw new Error('metrics down');
    });
    const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
    expect(result).toMatchObject({
      status: 'succeeded',
      verified: true,
      chargeRef: 'SUB-0001-2026-12',
      providerPaymentId: 'PAY-SUB-0001-2026-12',
    });
    expect(provider.calls.charge).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    const [err, event] = onListenerError.mock.calls[0];
    expect(err).toBeInstanceOf(CheckoutListenerError);
    expect((err as CheckoutListenerError).message).toBe('metrics down');
    expect((err as CheckoutListenerError).event).toBe('charge.succeeded');
    expect(event).toBe('charge.succeeded');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('without onListenerError the listener error is logged with console.error', async () => {
    const checkout = make();
    checkout.events.on('charge.succeeded', () => {
      throw new Error('metrics down');
    });
    const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
    expect(result.status).toBe('succeeded');
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toBe('[awesome-node-checkout]');
    expect(errorLog.mock.calls[0][1]).toBeInstanceOf(CheckoutListenerError);
  });

  it('a throwing onListenerError never rejects chargeMandate', async () => {
    const checkout = make({
      onListenerError: async () => {
        throw new Error('hook down');
      },
    });
    checkout.events.on('charge.succeeded', () => {
      throw new Error('metrics down');
    });
    const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
    expect(result.status).toBe('succeeded');
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it('confirmMandate returns the outcome and still emits charge.succeeded when mandate.created throws', async () => {
    const onListenerError = vi.fn();
    const checkout = make({ onListenerError });
    const seen: string[] = [];
    checkout.events.on('mandate.created', () => {
      throw new Error('crm down');
    });
    checkout.events.on('charge.succeeded', ({ orderId }) => {
      seen.push(`charge ${orderId}`);
    });
    const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
    expect(outcome.success).toBe(true);
    expect(outcome.terminal).toBe(true);
    expect(outcome.mandate?.providerMandateId).toBe(VAULT_ID);
    expect(outcome.firstCharge.providerPaymentId).toBe('PAY-FIRST');
    expect(seen).toEqual(['charge SUB-0001-INIT']);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError.mock.calls[0][1]).toBe('mandate.created');
  });

  it('revokeMandate returns the provider result when a mandate.revoked listener throws', async () => {
    const onListenerError = vi.fn();
    const checkout = make({ onListenerError });
    checkout.events.on('mandate.revoked', () => {
      throw new Error('crm down');
    });
    const result = await checkout.revokeMandate('dummy', activeMandate());
    expect(result.revokedAtProvider).toBe(true);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('mandate.setup_started still propagates the listener error (no money has moved)', async () => {
    const onListenerError = vi.fn();
    const checkout = make({ onListenerError });
    checkout.events.on('mandate.setup_started', () => {
      throw new Error('crm down');
    });
    await expect(checkout.createMandate('dummy', setupRequest())).rejects.toBeInstanceOf(CheckoutListenerError);
    expect(onListenerError).not.toHaveBeenCalled();
  });

  it('Express callback: a throwing mandate.created listener still runs onOutcome once and answers', async () => {
    const onListenerError = vi.fn();
    const checkout = make({ onListenerError });
    const charges: string[] = [];
    checkout.events.on('mandate.created', () => {
      throw new Error('crm down');
    });
    checkout.events.on('charge.succeeded', ({ orderId }) => {
      charges.push(String(orderId));
    });
    const pendings = new Map<string, MandatePendingState>([['MNDT0000000001', pendingState()]]);
    const saved: Mandate[] = [];
    const onOutcome = vi.fn((outcome: MandateSetupOutcome, _req: Request, res: Response) => {
      if (outcome.terminal && pendings.delete('MNDT0000000001') && outcome.mandate) saved.push(outcome.mandate);
      res.redirect(302, outcome.success ? '/app/subscribed' : '/app/subscription-failed');
    });
    const app = express();
    app.use(
      '/checkout',
      createCheckoutRouter(checkout, {
        buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/ko' }),
        mandates: {
          buildMandateRequest: () => setupRequest(),
          onStarted: () => {},
          loadPending: (_req, { mandateRef }) => pendings.get(mandateRef) ?? null,
          onOutcome,
        },
      }),
    );
    const res = await request(app).get('/checkout/dummy/mandate/callback').query({ mandate_ref: 'MNDT0000000001' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/subscribed');
    expect(provider.calls.confirm).toHaveLength(1);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(saved.map((m) => m.providerMandateId)).toEqual([VAULT_ID]);
    expect(pendings.size).toBe(0);
    expect(charges).toEqual(['SUB-0001-INIT']);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });
});

describe('Mandates: event payload scrubbing and unverified first charges', () => {
  let checkout: CheckoutConfigurator;
  let provider: MandateDummyProvider;
  let events: { name: CheckoutEventName; payload: CheckoutEventPayload }[];

  beforeEach(() => {
    checkout = new CheckoutConfigurator();
    provider = new MandateDummyProvider();
    checkout.registerProvider(provider);
    events = recordEvents(checkout);
  });

  const startWith = (providerRef: string, raw: unknown) => (req: MandateSetupRequest): MandateSetupStart => ({
    success: true,
    approvalUrl: 'https://pay.test/approve',
    pending: {
      provider: 'dummy',
      mandateRef: req.mandateRef,
      orderId: req.orderId,
      amount: req.amount,
      currency: req.currency,
      providerRef,
      createdAt: CREATED_AT,
    },
    raw,
  });

  it('mandate.setup_started scrubs pending.providerRef (the future Satispay token id) from raw', async () => {
    provider.nextStart = startWith('tok_SECRET', { id: 'tok_SECRET', status: 'PENDING', note: 'token tok_SECRET' });
    const start = await checkout.createMandate('dummy', setupRequest());
    expect(start.success).toBe(true);
    // The returned start keeps the provider's raw untouched
    expect(start.raw).toEqual({ id: 'tok_SECRET', status: 'PENDING', note: 'token tok_SECRET' });
    expect(events.map((e) => e.name)).toEqual(['mandate.setup_started']);
    expect(JSON.stringify(events[0].payload)).not.toContain('tok_SECRET');
    expect(events[0].payload.raw).toEqual({ id: '[redacted]', status: 'PENDING', note: 'token [redacted]' });
    expect(events[0].payload.orderId).toBe('SUB-0001-INIT');
    expect(events[0].payload.data).toEqual({ mandateRef: 'MNDT0000000001' });
  });

  it('mandate.setup_started keeps raw when providerRef is the orderId (Nexi codTrans)', async () => {
    provider.nextStart = startWith('SUB-0001-INIT', { codTrans: 'SUB-0001-INIT' });
    await checkout.createMandate('dummy', setupRequest());
    expect(events[0].payload.raw).toEqual({ codTrans: 'SUB-0001-INIT' });
  });

  it('a binary raw never reaches a charge event', async () => {
    provider.nextCharge = (_m, c) => ({
      status: 'succeeded',
      verified: true,
      chargeRef: c.chargeRef,
      providerPaymentId: 'PAY-1',
      raw: Buffer.from('{"vault_id":"vault-tok-SECRET-0001"}'),
    });
    const result = await checkout.chargeMandate('dummy', activeMandate(), charge());
    expect(Buffer.isBuffer(result.raw)).toBe(true);
    expect(events.map((e) => e.name)).toEqual(['charge.succeeded']);
    expect(events[0].payload.raw).toBe('[binary]');
  });

  it('an unverified first charge carries no providerPaymentId, amount or currency', async () => {
    provider.nextConfirm = (pending) => ({
      success: true,
      verified: false,
      terminal: true,
      firstCharge: {
        status: 'succeeded',
        verified: false,
        chargeRef: 'FORGED-1',
        providerPaymentId: 'PAY-FORGED',
        amount: 0.01,
        currency: 'USD',
      },
      raw: { from: pending.mandateRef },
    });
    const outcome = await checkout.confirmMandate('dummy', pendingState(), {});
    expect(outcome).toMatchObject({ success: false, verified: false, terminal: false });
    expect(outcome.mandate).toBeUndefined();
    expect(outcome.firstCharge.status).toBe('unknown');
    expect(outcome.firstCharge.chargeRef).toBe('SUB-0001-INIT');
    expect(outcome.firstCharge.providerPaymentId).toBeUndefined();
    expect(outcome.firstCharge.amount).toBeUndefined();
    expect(outcome.firstCharge.currency).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('Express: a relative returnUrl answers 400 INVALID_MANDATE_REQUEST without calling the provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.use(
      '/checkout',
      createCheckoutRouter(checkout, {
        buildPaymentRequest: () => ({ amount: 10, currency: 'EUR', returnUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/ko' }),
        mandates: {
          buildMandateRequest: () => setupRequest({ returnUrl: '/checkout/dummy/mandate/callback' }),
          onStarted: () => {},
          loadPending: () => null,
          onOutcome: () => {},
        },
      }),
    );
    const res = await request(app).post('/checkout/dummy/mandate');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      code: 'INVALID_MANDATE_REQUEST',
      error: 'returnUrl and cancelUrl must be absolute http(s) URLs',
    });
    expect(provider.calls.create).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

describe('appendMandateRef (AC 8)', () => {
  it('adds mandate_ref and keeps the query and the hash', () => {
    expect(appendMandateRef('https://x.test/r?a=1#h', 'MNDT00001')).toBe('https://x.test/r?a=1&mandate_ref=MNDT00001#h');
  });

  it('replaces an existing mandate_ref', () => {
    expect(appendMandateRef('https://x.test/r?mandate_ref=OLD000001&a=1#h', 'MNDT00001')).toBe(
      'https://x.test/r?mandate_ref=MNDT00001&a=1#h',
    );
    expect(appendMandateRef('https://x.test/r', 'MNDT00001')).toBe('https://x.test/r?mandate_ref=MNDT00001');
  });
});

describe('redactSecret', () => {
  it('replaces the secret in nested strings and keys without mutating the input', () => {
    const input = { a: 'tok-1', b: [{ c: 'x tok-1 y' }], d: 3, 'tok-1': true, e: new Error('bad tok-1') };
    const out = redactSecret(input, 'tok-1');
    expect(JSON.stringify(out)).not.toContain('tok-1');
    expect(out.a).toBe('[redacted]');
    expect(out.b[0].c).toBe('x [redacted] y');
    expect(out.d).toBe(3);
    expect(input.a).toBe('tok-1');
  });

  it('cuts cycles and returns the value unchanged without a secret', () => {
    const cyclic: any = { a: 'tok-1' };
    cyclic.self = cyclic;
    const out: any = redactSecret(cyclic, 'tok-1');
    expect(out.self).toBe('[circular]');
    expect(redactSecret(cyclic, undefined)).toBe(cyclic);
  });

  it("replaces binary values with '[binary]' and keeps dates", () => {
    const when = new Date(CREATED_AT);
    const out: any = redactSecret(
      {
        buf: Buffer.from('{"vault_id":"tok-1"}'),
        bytes: new Uint8Array([1, 2]),
        ab: new ArrayBuffer(4),
        view: new DataView(new ArrayBuffer(2)),
        when,
      },
      'tok-1',
    );
    expect(out).toEqual({ buf: '[binary]', bytes: '[binary]', ab: '[binary]', view: '[binary]', when });
    expect(out.when).toBe(when);
  });
});
