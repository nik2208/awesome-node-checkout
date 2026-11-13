import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayPalProvider } from './paypal.provider';
import { CheckoutConfigurator } from '../../checkout-configurator';
import { isChargeLookupProvider } from '../../index';
import { Mandate } from '../../models/mandate.model';

// Public charge lookup on PayPal by invoice_id (`getCharge`, #40) and the refunded amount of
// `getCharge` and `getPaymentDetails` (#41).

// Mock of PayPal Server SDK v2.5, with the Transaction Search controller and the capture read
// that the existing PayPal specs do not define.
const sdk = vi.hoisted(() => {
  class ApiError extends Error {
    statusCode: number;
    result: unknown;
    body: string;
    // Like the real SDK error: carries the request with its bearer token
    request = { headers: { authorization: 'Bearer SECRET-TOKEN' } };
    constructor(statusCode: number, result?: unknown) {
      super(`HTTP ${statusCode}`);
      this.name = 'ApiError';
      this.statusCode = statusCode;
      this.result = result;
      this.body = result === undefined ? '' : JSON.stringify(result);
    }
  }
  return {
    ApiError,
    createOrder: vi.fn(),
    captureOrder: vi.fn(),
    getOrder: vi.fn(),
    refundCapturedPayment: vi.fn(),
    getCapturedPayment: vi.fn(),
    getPaymentToken: vi.fn(),
    deletePaymentToken: vi.fn(),
    searchTransactions: vi.fn(),
    transactionSearchControllers: 0,
  };
});

vi.mock('@paypal/paypal-server-sdk', () => ({
  Environment: {
    Sandbox: class { constructor() {} },
    Production: class { constructor() {} },
  },
  LogLevel: { Error: 'error' },
  Client: class { constructor() {} },
  OrdersController: class {
    createOrder = sdk.createOrder;
    captureOrder = sdk.captureOrder;
    getOrder = sdk.getOrder;
  },
  PaymentsController: class {
    refundCapturedPayment = sdk.refundCapturedPayment;
    getCapturedPayment = sdk.getCapturedPayment;
  },
  VaultController: class {
    getPaymentToken = sdk.getPaymentToken;
    deletePaymentToken = sdk.deletePaymentToken;
  },
  TransactionSearchController: class {
    searchTransactions = sdk.searchTransactions;
    constructor() {
      sdk.transactionSearchControllers += 1;
    }
  },
  ApiError: sdk.ApiError,
}));

const { ApiError } = sdk;
const apiError = (status: number) =>
  new ApiError(status, { name: 'NOT_AUTHORIZED', message: 'refused', debug_id: 'dbg-1', details: [{ issue: 'PERMISSION_DENIED' }] });

const NOW = new Date('2026-11-12T10:00:00.000Z');
const SINCE = '2026-11-12T01:00:00.000Z';
const CHARGE = 'SUB-0001-2026-12';

const mandate: Mandate = {
  provider: 'paypal',
  mandateRef: 'MNDT0000000001',
  providerMandateId: 'vt_1',
  status: 'active',
  createdAt: '2026-11-01T10:00:00.000Z',
};

/** A search record (transaction_info only, as requested). */
function record(transactionId: string, invoiceId: string = CHARGE) {
  return { transactionInfo: { transactionId, invoiceId, transactionEventCode: 'T0006' } };
}

/** One search page. `totalPages` is left out when undefined. */
function searchPage(records: unknown[], totalPages?: number) {
  return { result: { transactionDetails: records, ...(totalPages !== undefined ? { totalPages } : {}) } };
}

/** The captured payment of the issue's fixture. */
function capturedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'CAP-1',
    status: 'COMPLETED',
    amount: { currencyCode: 'EUR', value: '19.90' },
    invoiceId: CHARGE,
    customId: 'MNDT0000000001',
    supplementaryData: { relatedIds: { orderId: 'ORDER-9' } },
    ...overrides,
  };
}

/** The order of a renewal charge, as getOrder returns it. */
function chargeOrder(captureOverrides: Record<string, unknown> = {}, refunds?: unknown[]) {
  return {
    id: 'ORDER-9',
    status: 'COMPLETED',
    purchaseUnits: [
      {
        invoiceId: CHARGE,
        customId: 'MNDT0000000001',
        amount: { currencyCode: 'EUR', value: '19.90' },
        payments: {
          captures: [
            { id: 'CAP-1', status: 'COMPLETED', amount: { currencyCode: 'EUR', value: '19.90' }, ...captureOverrides },
          ],
          ...(refunds !== undefined ? { refunds } : {}),
        },
      },
    ],
  };
}

const refund = (id: string, value: string, status = 'COMPLETED', currencyCode = 'EUR') => ({
  id,
  status,
  amount: { currencyCode, value },
});

describe('PayPalProvider.getCharge (#40)', () => {
  let provider: PayPalProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    sdk.transactionSearchControllers = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    provider = new PayPalProvider({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One record CAP-1 and its captured payment. */
  function happyPath(captureOverrides: Record<string, unknown> = {}) {
    sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1')]));
    sdk.getCapturedPayment.mockResolvedValueOnce({ result: capturedPayment(captureOverrides) });
  }

  it('implements the charge lookup capability', () => {
    expect(isChargeLookupProvider(provider)).toBe(true);
    expect(new CheckoutConfigurator({ emitEvents: false }).registerProvider(provider).supportsChargeLookup('paypal')).toBe(true);
  });

  it('constructs the Transaction Search controller lazily, once', async () => {
    expect(sdk.transactionSearchControllers).toBe(0);
    sdk.searchTransactions.mockResolvedValue(searchPage([]));
    await provider.getCharge(CHARGE, { since: SINCE });
    await provider.getCharge(CHARGE, { since: SINCE });
    expect(sdk.transactionSearchControllers).toBe(1);
    expect(sdk.searchTransactions).toHaveBeenCalledTimes(2);
  });

  it('searches the window since - 1 h .. until + 1 h with exactly these parameters', async () => {
    sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
    await provider.getCharge(CHARGE, { since: SINCE });
    expect(sdk.searchTransactions.mock.calls).toStrictEqual([
      [
        {
          startDate: '2026-11-12T00:00:00.000Z',
          endDate: '2026-11-12T02:00:00.000Z',
          fields: 'transaction_info',
          balanceAffectingRecordsOnly: 'N',
          pageSize: 500,
          page: 1,
        },
      ],
    ]);
  });

  it('caps the end of the window at now', async () => {
    sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
    await provider.getCharge(CHARGE, { since: '2026-11-12T09:30:00.000Z' });
    expect(sdk.searchTransactions.mock.calls[0][0]).toMatchObject({
      startDate: '2026-11-12T08:30:00.000Z',
      endDate: '2026-11-12T10:00:00.000Z',
    });
  });

  it('one completed capture is succeeded with the order id, amount, currency and status', async () => {
    happyPath();
    const result = await provider.getCharge(CHARGE, { since: SINCE });
    expect(result).toMatchObject({
      status: 'succeeded',
      verified: true,
      chargeRef: 'SUB-0001-2026-12',
      providerPaymentId: 'ORDER-9',
      amount: 19.9,
      currency: 'EUR',
      providerStatus: 'COMPLETED',
    });
    expect('providerState' in result).toBe(false);
    expect('error' in result).toBe(false);
    expect(sdk.getCapturedPayment).toHaveBeenCalledWith({ captureId: 'CAP-1' });
    // raw is the captured payment, never a search page
    expect(result.raw).toEqual(capturedPayment());
  });

  it('with options.mandate, the capture must carry its mandateRef as custom_id', async () => {
    happyPath();
    const ok = await provider.getCharge(CHARGE, { since: SINCE, mandate });
    expect(ok.status).toBe('succeeded');

    happyPath();
    const other = await provider.getCharge(CHARGE, { since: SINCE, mandate: { ...mandate, mandateRef: 'OTHER-MANDATE' } });
    expect(other.status).toBe('unknown');
    expect(other.verified).toBe(false);
    expect(other.error).toBe('PayPal capture does not match the charge');
    expect('providerPaymentId' in other).toBe(false);
  });

  it('a capture of another invoice_id is unknown', async () => {
    happyPath({ invoiceId: 'SUB-0002-2026-12' });
    const result = await provider.getCharge(CHARGE, { since: SINCE });
    expect(result.status).toBe('unknown');
    expect(result.error).toBe('PayPal capture does not match the charge');
  });

  it.each([
    ['PENDING', 'pending', undefined],
    ['DECLINED', 'failed', undefined],
    ['FAILED', 'failed', undefined],
    ['REFUNDED', 'succeeded', 'refunded'],
    ['PARTIALLY_REFUNDED', 'succeeded', 'partially_refunded'],
    ['SOMETHING_NEW', 'pending', undefined],
  ])('capture status %s is %s (providerState %s)', async (captureStatus, status, providerState) => {
    happyPath({ status: captureStatus });
    sdk.getOrder.mockRejectedValue(new Error('not needed'));
    const result = await provider.getCharge(CHARGE, { since: SINCE });
    expect(result.status).toBe(status);
    expect(result.verified).toBe(true);
    expect(result.providerStatus).toBe(captureStatus);
    if (providerState === undefined) expect('providerState' in result).toBe(false);
    else expect(result.providerState).toBe(providerState);
  });

  describe('no matching record', () => {
    it('with the default until (01:00, now 10:00) is absent and verified', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result).toEqual({ status: 'absent', verified: true, chargeRef: CHARGE });
      expect(sdk.getCapturedPayment).not.toHaveBeenCalled();
    });

    it("with until '2026-11-12T06:30:00.000Z' is unknown: PayPal may not list it yet", async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
      const result = await provider.getCharge(CHARGE, { since: SINCE, until: '2026-11-12T06:30:00.000Z' });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('PayPal transaction search may not list this charge yet');
      expect(sdk.searchTransactions.mock.calls[0][0]).toMatchObject({
        startDate: '2026-11-12T00:00:00.000Z',
        endDate: '2026-11-12T07:30:00.000Z',
      });
    });

    it('exactly 4 hours after until is absent', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
      const result = await provider.getCharge(CHARGE, { since: SINCE, until: '2026-11-12T06:00:00.000Z' });
      expect(result.status).toBe('absent');
    });

    it('records with other invoice ids only are the same as no record', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(
        searchPage([record('CAP-X', 'SUB-0002-2026-12'), record('CAP-Y', 'OTHER-INVOICE'), { transactionInfo: {} }, {}]),
      );
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result).toEqual({ status: 'absent', verified: true, chargeRef: CHARGE });
      expect(sdk.getCapturedPayment).not.toHaveBeenCalled();
    });

    it('a page without transactionDetails or totalPages is an empty single page', async () => {
      sdk.searchTransactions.mockResolvedValueOnce({ result: {} });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('absent');
      expect(sdk.searchTransactions).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-reading the matching records', () => {
    it('a second matching record that is not a capture (404) is skipped', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1'), record('REFUND-1')]));
      sdk.getCapturedPayment.mockImplementation(async ({ captureId }: { captureId: string }) => {
        if (captureId === 'CAP-1') return { result: capturedPayment() };
        throw new ApiError(404, { name: 'RESOURCE_NOT_FOUND', message: 'not found', debug_id: 'dbg-2' });
      });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect(result.providerPaymentId).toBe('ORDER-9');
      expect(sdk.getCapturedPayment).toHaveBeenCalledWith({ captureId: 'REFUND-1' });
    });

    it('every matching record 404 is unknown', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('REFUND-1'), record('REFUND-2')]));
      sdk.getCapturedPayment.mockRejectedValue(new ApiError(404, { name: 'RESOURCE_NOT_FOUND' }));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('PayPal lists this invoice_id but no capture was found');
    });

    it('a 503 on a re-read is unknown, with only the PayPal error body in raw', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1')]));
      sdk.getCapturedPayment.mockRejectedValueOnce(new ApiError(503, { name: 'SERVICE_UNAVAILABLE', debug_id: 'dbg-3' }));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toContain('HTTP 503');
      expect(result.raw).toEqual({ name: 'SERVICE_UNAVAILABLE', debug_id: 'dbg-3' });
      expect(JSON.stringify(result)).not.toContain('Bearer');
    });

    it('two distinct captures are unknown: a possible double charge is never resolved by picking one', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1'), record('CAP-2')]));
      sdk.getCapturedPayment
        .mockResolvedValueOnce({ result: capturedPayment() })
        .mockResolvedValueOnce({ result: capturedPayment({ id: 'CAP-2' }) });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('More than one PayPal capture has this invoice_id: reconcile it in PayPal');
      expect('providerPaymentId' in result).toBe(false);
    });

    it('the same capture listed twice is one capture', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1'), record('CAP-1')]));
      sdk.getCapturedPayment.mockResolvedValue({ result: capturedPayment() });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
    });

    it('more than 5 matching records is unknown (ambiguous)', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(
        searchPage(['A', 'B', 'C', 'D', 'E', 'F'].map((id) => record(`CAP-${id}`))),
      );
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(sdk.getCapturedPayment).not.toHaveBeenCalled();
    });
  });

  describe('pagination', () => {
    it('totalPages: 2 requests page 2, and a match found there is used', async () => {
      sdk.searchTransactions
        .mockResolvedValueOnce(searchPage([record('CAP-X', 'OTHER-INVOICE')], 2))
        .mockResolvedValueOnce(searchPage([record('CAP-1')], 2));
      sdk.getCapturedPayment.mockResolvedValueOnce({ result: capturedPayment() });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(sdk.searchTransactions).toHaveBeenCalledTimes(2);
      expect(sdk.searchTransactions.mock.calls[1][0]).toStrictEqual({
        startDate: '2026-11-12T00:00:00.000Z',
        endDate: '2026-11-12T02:00:00.000Z',
        fields: 'transaction_info',
        balanceAffectingRecordsOnly: 'N',
        pageSize: 500,
        page: 2,
      });
      expect(result.status).toBe('succeeded');
      expect(result.providerPaymentId).toBe('ORDER-9');
    });

    it('totalPages: 11 is unknown after a single searchTransactions call', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([record('CAP-1')], 11));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('Too many PayPal transactions in the lookup window');
      expect(sdk.searchTransactions).toHaveBeenCalledTimes(1);
      expect(sdk.getCapturedPayment).not.toHaveBeenCalled();
    });

    it('a malformed page (transactionDetails or totalPages of the wrong type) is unknown, never absent', async () => {
      sdk.searchTransactions.mockResolvedValueOnce({ result: { transactionDetails: 'none' } });
      expect((await provider.getCharge(CHARGE, { since: SINCE })).status).toBe('unknown');
      sdk.searchTransactions.mockResolvedValueOnce({ result: { transactionDetails: [], totalPages: 'many' } });
      expect((await provider.getCharge(CHARGE, { since: SINCE })).status).toBe('unknown');
      sdk.searchTransactions.mockResolvedValueOnce({ result: { transactionDetails: [], totalPages: 0 } });
      expect((await provider.getCharge(CHARGE, { since: SINCE })).status).toBe('unknown');
    });
  });

  describe('arguments', () => {
    it('without since it is unknown, with no SDK call', async () => {
      for (const options of [undefined, {}, { until: SINCE }]) {
        const result = await provider.getCharge(CHARGE, options);
        expect(result).toEqual({
          status: 'unknown',
          verified: false,
          chargeRef: CHARGE,
          error: 'PayPal charge lookup requires options.since',
        });
      }
      expect(sdk.searchTransactions).not.toHaveBeenCalled();
      expect(sdk.getCapturedPayment).not.toHaveBeenCalled();
      expect(sdk.transactionSearchControllers).toBe(0);
    });

    it('until 31 days after since is unknown, with no SDK call', async () => {
      const result = await provider.getCharge(CHARGE, { since: SINCE, until: '2026-12-13T01:00:00.000Z' });
      expect(result.status).toBe('unknown');
      expect(result.error).toBe('PayPal charge lookup window exceeds 31 days');
      expect(sdk.searchTransactions).not.toHaveBeenCalled();
    });

    it('until exactly 30 days after since is searched', async () => {
      vi.setSystemTime(new Date('2026-12-20T00:00:00.000Z'));
      sdk.searchTransactions.mockResolvedValueOnce(searchPage([]));
      const result = await provider.getCharge(CHARGE, { since: SINCE, until: '2026-12-12T01:00:00.000Z' });
      expect(result.status).toBe('absent');
      expect(sdk.searchTransactions.mock.calls[0][0]).toMatchObject({
        startDate: '2026-11-12T00:00:00.000Z',
        endDate: '2026-12-12T02:00:00.000Z',
      });
    });

    it('a since more than 1 hour in the future is unknown, with no SDK call', async () => {
      const result = await provider.getCharge(CHARGE, { since: '2026-11-12T11:00:00.000Z' });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(sdk.searchTransactions).not.toHaveBeenCalled();
    });

    it('called directly with an unparseable since, or an until before since, it is unknown with no SDK call', async () => {
      for (const options of [{ since: 'yesterday' }, { since: SINCE, until: '2026-11-12T00:00:00.000Z' }]) {
        const result = await provider.getCharge(CHARGE, options);
        expect(result.status).toBe('unknown');
        expect(result.verified).toBe(false);
      }
      expect(sdk.searchTransactions).not.toHaveBeenCalled();
    });
  });

  describe('search errors', () => {
    it('a 403 from searchTransactions is unknown and names HTTP 403', async () => {
      sdk.searchTransactions.mockRejectedValueOnce(apiError(403));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('PayPal transaction search failed (HTTP 403)');
      expect(result.raw).toEqual({
        name: 'NOT_AUTHORIZED',
        message: 'refused',
        debug_id: 'dbg-1',
        details: [{ issue: 'PERMISSION_DENIED' }],
      });
      expect(JSON.stringify(result)).not.toContain('Bearer');
      expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN');
    });

    it('a network error is unknown', async () => {
      sdk.searchTransactions.mockRejectedValueOnce(new Error('ECONNRESET'));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('unknown');
      expect(result.verified).toBe(false);
      expect(result.error).toBe('PayPal transaction search failed');
      expect(JSON.stringify(result)).not.toContain('Bearer');
    });

    it('a search page never reaches the result (it lists other customers)', async () => {
      sdk.searchTransactions.mockResolvedValueOnce(
        searchPage([
          {
            transactionInfo: { transactionId: 'CAP-OTHER', invoiceId: 'OTHER-INVOICE' },
            payerInfo: { emailAddress: 'other.customer@example.com' },
          },
          record('CAP-1'),
        ]),
      );
      sdk.getCapturedPayment.mockResolvedValueOnce({ result: capturedPayment() });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect(JSON.stringify(result)).not.toContain('other.customer@example.com');
      expect(JSON.stringify(result)).not.toContain('OTHER-INVOICE');
    });
  });

  describe('refundedAmount (#41)', () => {
    it('a COMPLETED capture is refundedAmount 0, without calling getOrder', async () => {
      happyPath();
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.refundedAmount).toBe(0);
      expect(sdk.getOrder).not.toHaveBeenCalled();
    });

    it("a REFUNDED capture with one completed refund of '19.90' is refundedAmount 19.9", async () => {
      happyPath({ status: 'REFUNDED' });
      sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder({ status: 'REFUNDED' }, [refund('R1', '19.90')]) });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect(result.providerState).toBe('refunded');
      expect(result.refundedAmount).toBe(19.9);
      expect(sdk.getOrder).toHaveBeenCalledWith({ id: 'ORDER-9' });
    });

    it('a PARTIALLY_REFUNDED capture sums the completed refunds in minor units', async () => {
      happyPath({ status: 'PARTIALLY_REFUNDED' });
      sdk.getOrder.mockResolvedValueOnce({
        result: chargeOrder({ status: 'PARTIALLY_REFUNDED' }, [refund('R1', '5.00'), refund('R2', '4.99')]),
      });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.providerState).toBe('partially_refunded');
      expect(result.refundedAmount).toBe(9.99);
    });

    it('getOrder rejecting is still succeeded and refunded, without refundedAmount', async () => {
      happyPath({ status: 'REFUNDED' });
      sdk.getOrder.mockRejectedValueOnce(new ApiError(500, { name: 'INTERNAL_SERVER_ERROR' }));
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect(result.verified).toBe(true);
      expect(result.providerState).toBe('refunded');
      expect('refundedAmount' in result).toBe(false);
      expect(result.raw).toEqual(capturedPayment({ status: 'REFUNDED' }));
    });

    it("an order whose first capture id is 'CAP-OTHER' gives no refundedAmount", async () => {
      happyPath({ status: 'REFUNDED' });
      sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder({ id: 'CAP-OTHER', status: 'REFUNDED' }, [refund('R1', '19.90')]) });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect(result.providerState).toBe('refunded');
      expect('refundedAmount' in result).toBe(false);
    });

    it('a REFUNDED capture without an order id gives no refundedAmount and no getOrder call', async () => {
      happyPath({ status: 'REFUNDED', supplementaryData: undefined });
      const result = await provider.getCharge(CHARGE, { since: SINCE });
      expect(result.status).toBe('succeeded');
      expect('providerPaymentId' in result).toBe(false);
      expect('refundedAmount' in result).toBe(false);
      expect(sdk.getOrder).not.toHaveBeenCalled();
    });

    it('a pending or failed capture has no refundedAmount', async () => {
      for (const status of ['PENDING', 'DECLINED']) {
        happyPath({ status });
        const result = await provider.getCharge(CHARGE, { since: SINCE });
        expect('refundedAmount' in result).toBe(false);
      }
      expect(sdk.getOrder).not.toHaveBeenCalled();
    });
  });
});

describe('PayPalProvider.getPaymentDetails refundedAmount (#41)', () => {
  let provider: PayPalProvider;

  beforeEach(() => {
    vi.resetAllMocks();
    provider = new PayPalProvider({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox' });
  });

  function partiallyRefunded(refunds?: unknown[]) {
    return chargeOrder({ status: 'PARTIALLY_REFUNDED' }, refunds);
  }

  it('sums the completed refunds: 5.00 + 4.99 is 9.99, the rest of the result unchanged', async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '5.00'), refund('R2', '4.99')]) });
    const result = await provider.getPaymentDetails('ORDER-9');
    expect(result.refundedAmount).toBe(9.99);
    expect(result.success).toBe(false);
    expect(result.status).toBe('PARTIALLY_REFUNDED');
    expect(result.amount).toBe(19.9);
    expect(result.verified).toBe(true);
    expect(sdk.getOrder).toHaveBeenCalledTimes(1);
  });

  it('a PENDING refund is not counted', async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '5.00'), refund('R2', '4.99', 'PENDING')]) });
    expect((await provider.getPaymentDetails('ORDER-9')).refundedAmount).toBe(5);
  });

  it('a COMPLETED capture with no refunds list is 0', async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: chargeOrder() });
    const result = await provider.getPaymentDetails('ORDER-9');
    expect(result.success).toBe(true);
    expect(result.refundedAmount).toBe(0);
  });

  it("a refund in 'USD' gives no field", async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '5.00'), refund('R2', '4.99', 'COMPLETED', 'USD')]) });
    const result = await provider.getPaymentDetails('ORDER-9');
    expect('refundedAmount' in result).toBe(false);
    expect(result.status).toBe('PARTIALLY_REFUNDED');
  });

  it("a refund with value 'abc' gives no field", async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', 'abc')]) });
    expect('refundedAmount' in (await provider.getPaymentDetails('ORDER-9'))).toBe(false);
  });

  it('a refund of 0 or with more decimals than the currency allows gives no field', async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '0.00')]) });
    expect('refundedAmount' in (await provider.getPaymentDetails('ORDER-9'))).toBe(false);
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '5.001')]) });
    expect('refundedAmount' in (await provider.getPaymentDetails('ORDER-9'))).toBe(false);
  });

  it('the currency is compared case-insensitively', async () => {
    sdk.getOrder.mockResolvedValueOnce({ result: partiallyRefunded([refund('R1', '5.00', 'COMPLETED', 'eur')]) });
    expect((await provider.getPaymentDetails('ORDER-9')).refundedAmount).toBe(5);
  });

  it("an order without captures has no 'refundedAmount' key", async () => {
    sdk.getOrder.mockResolvedValueOnce({
      result: { id: 'ORDER-9', status: 'APPROVED', purchaseUnits: [{ payments: { refunds: [refund('R1', '5.00')] } }] },
    });
    const result = await provider.getPaymentDetails('ORDER-9');
    expect(result.status).toBe('NO_CAPTURE');
    expect('refundedAmount' in result).toBe(false);
  });

  it('two captures in the purchase unit give no field', async () => {
    const order = partiallyRefunded([refund('R1', '5.00')]);
    order.purchaseUnits[0].payments.captures.push({
      id: 'CAP-2',
      status: 'COMPLETED',
      amount: { currencyCode: 'EUR', value: '1.00' },
    });
    sdk.getOrder.mockResolvedValueOnce({ result: order });
    expect('refundedAmount' in (await provider.getPaymentDetails('ORDER-9'))).toBe(false);
  });
});
