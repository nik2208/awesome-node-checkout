/**
 * Safely parses an amount value into a finite number.
 * Returns undefined for null, undefined, boolean, empty strings, whitespace, NaN, and Infinity.
 * Enforces strict decimal notation (rejects hex '0x10' and scientific '1e3').
 */
export function parseAmount(val: unknown): number | undefined {
  if (val == null || typeof val === 'boolean') return undefined;
  if (typeof val === 'number') {
    return !isNaN(val) && isFinite(val) && val >= 0 ? val : undefined;
  }
  if (typeof val === 'string') {
    const str = val.trim();
    if (!/^\d+(\.\d+)?$/.test(str)) return undefined;
    const num = Number(str);
    return !isNaN(num) && isFinite(num) && num >= 0 ? num : undefined;
  }
  return undefined;
}

/**
 * Safely parses amounts denominated in minor units (cents) into major units.
 * Returns undefined if the input cannot be parsed or is not an integer number of cents.
 */
export function parseAmountFromCents(val: unknown): number | undefined {
  if (val == null || typeof val === 'boolean') return undefined;
  if (typeof val === 'number') {
    return Number.isInteger(val) && isFinite(val) && val >= 0 ? val / 100 : undefined;
  }
  if (typeof val === 'string') {
    const str = val.trim();
    if (!/^\d+$/.test(str)) return undefined;
    const num = Number(str);
    return !isNaN(num) && isFinite(num) && num >= 0 ? num / 100 : undefined;
  }
  return undefined;
}

const NEXI_NUMERIC_CURRENCY_MAP: Record<string, string> = {
  '978': 'EUR',
  '840': 'USD',
  '826': 'GBP',
  '756': 'CHF',
  '392': 'JPY',
  '036': 'AUD',
  '124': 'CAD',
  '702': 'SGD',
  '752': 'SEK',
  '578': 'NOK',
  '208': 'DKK',
  '484': 'MXN',
  '949': 'TRY',
  '986': 'BRL',
  '356': 'INR',
};

/**
 * Maps Nexi ISO-4217 numeric currency codes to alpha-3 codes.
 * Returns 3-letter uppercase alpha code if recognized or already alpha,
 * otherwise undefined.
 */
export function parseNexiCurrency(code: unknown): string | undefined {
  if (typeof code !== 'string' && typeof code !== 'number') return undefined;
  const str = String(code).trim();
  if (NEXI_NUMERIC_CURRENCY_MAP[str]) {
    return NEXI_NUMERIC_CURRENCY_MAP[str];
  }
  if (/^[A-Za-z]{3}$/.test(str)) {
    return str.toUpperCase();
  }
  return undefined;
}
