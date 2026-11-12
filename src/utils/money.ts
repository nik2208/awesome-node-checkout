import { CheckoutError } from '../models/errors';

/** ISO 4217 currencies with no minor unit. */
const EXPONENT_0 = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** ISO 4217 currencies with three decimals. */
const EXPONENT_3 = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Floating-point noise tolerated when scaling to minor units (e.g. 19.99 * 100 = 1998.9999999999998). */
const EPSILON = 1e-6;

function normalizeCurrency(currency: string): string {
  return typeof currency === 'string' ? currency.trim().toUpperCase() : '';
}

/** ISO 4217 minor-unit exponent. Default 2. */
export function currencyExponent(currency: string): 0 | 2 | 3 {
  const code = normalizeCurrency(currency);
  if (EXPONENT_0.has(code)) return 0;
  if (EXPONENT_3.has(code)) return 3;
  return 2;
}

/**
 * Converts a major-unit amount to an integer number of minor units of `currency`.
 *
 * Throws CheckoutError('INVALID_AMOUNT') when the amount is not finite, <= 0,
 * or has more decimals than the currency allows. Never rounds a real excess:
 * `19.999 EUR` throws instead of charging `20.00`.
 */
export function toMinorUnits(amount: number, currency: string): number {
  const exponent = currencyExponent(currency);
  const invalid = (): CheckoutError =>
    new CheckoutError(
      `Invalid amount ${String(amount)} for ${normalizeCurrency(currency) || 'currency'}: ` +
        `the amount must be a positive finite number with at most ${exponent} decimal places`,
      'INVALID_AMOUNT',
    );
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw invalid();
  }
  const scaled = amount * 10 ** exponent;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > EPSILON || rounded <= 0 || !Number.isSafeInteger(rounded)) {
    throw invalid();
  }
  return rounded;
}

/**
 * Formats a major-unit string for APIs that take one (PayPal): toMinorUnits then divides,
 * fixed to the exponent (`1000 JPY` → `'1000'`, `19.9 EUR` → `'19.90'`, `1.2 KWD` → `'1.200'`).
 * Throws CheckoutError('INVALID_AMOUNT') like toMinorUnits.
 */
export function toMajorString(amount: number, currency: string): string {
  const minor = toMinorUnits(amount, currency);
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  // Integer string arithmetic: exact, no floating-point formatting involved
  const digits = String(minor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** True for the CheckoutError thrown by toMinorUnits / toMajorString. */
export function isInvalidAmountError(error: unknown): error is CheckoutError {
  return error instanceof CheckoutError && error.code === 'INVALID_AMOUNT';
}
