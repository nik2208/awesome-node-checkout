import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CheckoutConfigurator } from './checkout-configurator';
import { BasePaymentProvider } from './abstract/base-payment-provider.abstract';
import { CheckoutEventName, CheckoutEventPayload } from './events/checkout-event-bus';
import { IMandateProvider } from './interfaces/mandate-provider.interface';
import {
  ChargeRequest,
  ChargeResult,
  Mandate,
  MandateCallbackInput,
  MandatePendingState,
  MandateSetupOutcome,
  MandateSetupStart,
} from './models/mandate.model';
import { PaymentResult } from './models/payment-result.model';
import { NexiProvider } from './providers/nexi/nexi.provider';

// Structured providerState / providerStatus on ChargeResult through the configurator (#42).
// Nexi fixtures copied from providers/nexi/nexi.mandates.spec.ts:16-49.

const MERCHANT_ID = 'ALIAS_TEST_01';
const MAC_KEY = 'TEST_SECRET_KEY_0001';
const NOW = 1767225600000;
/** SHA-1 of `esito=OKidOperazione=123456789timeStamp=1767225601000TEST_SECRET_KEY_0001`. */
const MAC_API_RESPONSE_OK = '2a8dbadc3faa3fe66c9f67f9d360da3039ce207a';
const OK_RESP = { esito: 'OK', idOperazione: '123456789', timeStamp: '1767225601000', mac: MAC_API_RESPONSE_OK };

const MANDATE_REF = 'MNDT0000000001';
const ORDER_ID = 'SUB-0001-INIT';
const CHARGE_REF = 'SUB-0001-2026-12';
const PAID_ENTRY = { codiceTransazione: CHARGE_REF, stato: 'Autorizzato', importo: 1990, divisa: 'EUR' };

const CHARGE_EVENTS: CheckoutEventName[] = ['charge.succeeded', 'charge.failed', 'charge.unknown', 'charge.requires_action'];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function mandate(provider = 'nexi'): Mandate {
  return {
    provider,
    mandateRef: MANDATE_REF,
    providerMandateId: provider === 'nexi' ? MANDATE_REF : 'vault-tok-0001',
    status: 'active',
    createdAt: new Date(NOW).toISOString(),
  };
}

/** A minimal mandate provider whose charge and confirm results are scripted. */
class ScriptedMandateProvider extends BasePaymentProvider implements IMandateProvider {
  name = 'scripted';
  flow = 'redirect' as const;
  nextCharge: (charge: ChargeRequest) => ChargeResult = (c) => ({ status: 'succeeded', verified: true, chargeRef: c.chargeRef });
  nextConfirm: (pending: MandatePendingState) => MandateSetupOutcome = (p) => ({
    success: false,
    verified: false,
    terminal: false,
    firstCharge: { status: 'unknown', verified: false, chargeRef: p.orderId },
  });

  async createPayment(): Promise<PaymentResult> {
    return { success: false };
  }
  async executePayment(): Promise<PaymentResult> {
    return { success: false };
  }
  async getPaymentDetails(): Promise<PaymentResult> {
    return { success: false };
  }
  async refundPayment(): Promise<PaymentResult> {
    return { success: false };
  }
  async createMandate(): Promise<MandateSetupStart> {
    return { success: false };
  }
  async confirmMandate(pending: MandatePendingState, _input: MandateCallbackInput): Promise<MandateSetupOutcome> {
    return this.nextConfirm(pending);
  }
  async chargeMandate(_mandate: Mandate, charge: ChargeRequest): Promise<ChargeResult> {
    return this.nextCharge(charge);
  }
  async getMandate() {
    return { status: 'active' as const, verified: true };
  }
  async revokeMandate() {
    return { revokedAtProvider: true };
  }
}

describe('providerState / providerStatus through CheckoutConfigurator.chargeMandate (#42)', () => {
  let checkout: CheckoutConfigurator;
  let scripted: ScriptedMandateProvider;
  let events: { name: CheckoutEventName; payload: CheckoutEventPayload }[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    global.fetch = vi.fn();
    scripted = new ScriptedMandateProvider();
    checkout = new CheckoutConfigurator()
      .registerProvider(new NexiProvider({ merchantId: MERCHANT_ID, macKey: MAC_KEY }))
      .registerProvider(scripted);
    events = [];
    for (const name of CHARGE_EVENTS) {
      checkout.events.on(name, (payload) => {
        events.push({ name, payload });
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a Nexi replay of 'Rimborsato' for the same 19.90 EUR is succeeded, refunded (status unchanged)", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Rimborsato' }] }));
    const result = await checkout.chargeMandate('nexi', mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
    expect(result.status).toBe('succeeded');
    expect(result.verified).toBe(true);
    expect(result.providerState).toBe('refunded');
    expect(result.providerStatus).toBe('Rimborsato');
    expect(result.raw).toEqual({ stato: 'Rimborsato' });
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    expect(events.map((e) => e.name)).toEqual(['charge.succeeded']);
    expect(events[0].payload.data.providerState).toBe('refunded');
  });

  it('the same replay for 25.00 EUR is unknown through the amount check and keeps both fields', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Rimborsato' }] }));
    const result = await checkout.chargeMandate('nexi', mandate(), { chargeRef: CHARGE_REF, amount: 25, currency: 'EUR' });
    expect(result.status).toBe('unknown');
    expect(result.error).toBe('Charged amount does not match the request');
    expect(result.providerState).toBe('refunded');
    expect(result.providerStatus).toBe('Rimborsato');

    expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
    expect(events[0].payload.data.providerState).toBe('refunded');
  });

  it('a replay of [Autorizzato 19.90, Contabilizzato Parz. 10.00] for 19.90 EUR stays succeeded, as in 2.1.0, flagged', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ ...OK_RESP, report: [PAID_ENTRY, { ...PAID_ENTRY, stato: 'Contabilizzato Parz.', importo: 1000 }] }),
    );
    const result = await checkout.chargeMandate('nexi', mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
    expect(result.status).toBe('succeeded');
    expect(result.verified).toBe(true);
    expect(result.amount).toBe(19.9);
    expect(result.raw).toEqual({ stato: 'Autorizzato' });
    expect(result.providerStatus).toBe('Autorizzato');
    expect(result.providerState).toBe('partially_captured');
    expect('error' in result).toBe(false);
    expect(events.map((e) => e.name)).toEqual(['charge.succeeded']);
    expect(events[0].payload.data.providerState).toBe('partially_captured');
  });

  it("a replay of 'Contabilizzato Parz.' stays succeeded with partially_captured", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ ...OK_RESP, report: [{ ...PAID_ENTRY, stato: 'Contabilizzato Parz.' }] }),
    );
    const result = await checkout.chargeMandate('nexi', mandate(), { chargeRef: CHARGE_REF, amount: 19.9, currency: 'EUR' });
    expect(result.status).toBe('succeeded');
    expect(result.providerState).toBe('partially_captured');
    expect(events[0].payload.data.providerState).toBe('partially_captured');
  });

  it('an unverified result is unknown without either field', async () => {
    scripted.nextCharge = (c) => ({
      status: 'succeeded',
      verified: false,
      chargeRef: c.chargeRef,
      providerState: 'refunded',
      providerStatus: 'X',
    });
    const result = await checkout.chargeMandate('scripted', mandate('scripted'), {
      chargeRef: CHARGE_REF,
      amount: 19.9,
      currency: 'EUR',
    });
    expect(result.status).toBe('unknown');
    expect(result.verified).toBe(false);
    expect('providerState' in result).toBe(false);
    expect('providerStatus' in result).toBe(false);
    expect(events.map((e) => e.name)).toEqual(['charge.unknown']);
    expect(events[0].payload.data.providerState).toBeUndefined();
  });

  it('an unverified failed result drops both fields too; a verified one keeps them and its status', async () => {
    scripted.nextCharge = (c) => ({
      status: 'failed',
      verified: false,
      chargeRef: c.chargeRef,
      providerState: 'partially_captured',
      providerStatus: 'X',
    });
    const unverified = await checkout.chargeMandate('scripted', mandate('scripted'), {
      chargeRef: CHARGE_REF,
      amount: 19.9,
      currency: 'EUR',
    });
    expect(unverified.status).toBe('failed');
    expect('providerState' in unverified).toBe(false);
    expect('providerStatus' in unverified).toBe(false);

    scripted.nextCharge = (c) => ({
      status: 'failed',
      verified: true,
      chargeRef: c.chargeRef,
      providerState: 'partially_captured',
      providerStatus: 'X',
    });
    const verified = await checkout.chargeMandate('scripted', mandate('scripted'), {
      chargeRef: CHARGE_REF,
      amount: 19.9,
      currency: 'EUR',
    });
    expect(verified.status).toBe('failed');
    expect(verified.providerState).toBe('partially_captured');
    expect(verified.providerStatus).toBe('X');
  });

  it("confirmMandate: an unverified outcome's first charge carries neither field", async () => {
    scripted.nextConfirm = (p) => ({
      success: false,
      verified: false,
      terminal: false,
      firstCharge: { status: 'succeeded', verified: true, chargeRef: p.orderId, providerState: 'refunded', providerStatus: 'X' },
    });
    const pending: MandatePendingState = {
      provider: 'scripted',
      mandateRef: MANDATE_REF,
      orderId: ORDER_ID,
      amount: 19.9,
      currency: 'EUR',
      providerRef: ORDER_ID,
      createdAt: new Date(NOW).toISOString(),
    };
    const outcome = await checkout.confirmMandate('scripted', pending, {});
    expect(outcome.firstCharge.status).toBe('unknown');
    expect('providerState' in outcome.firstCharge).toBe(false);
    expect('providerStatus' in outcome.firstCharge).toBe(false);
  });
});
