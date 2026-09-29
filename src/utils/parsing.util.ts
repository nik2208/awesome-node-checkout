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
 * Active ISO 4217 alpha-3 currency codes, generated from the ISO 4217 Maintenance
 * Agency "List One" (SIX Group, published 2026-09-17).
 *
 * Entries without minor units ("N.A." in List One: precious metals XAU/XAG/XPD/XPT,
 * bond-market units XBA-XBD, XDR, XSU, XUA, the testing code XTS and the
 * "no currency" code XXX) are deliberately excluded: they are not payment currencies.
 */
export const ISO_4217_ALPHA3_CODES: ReadonlySet<string> = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT',
  'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUP',
  'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN',
  'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN',
  'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD',
  'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP',
  'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX',
  'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAD',
  'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
]);

/**
 * Maps Nexi ISO-4217 numeric currency codes to alpha-3 codes.
 * Returns the uppercase alpha-3 code when the input is a mapped numeric code or an
 * alpha-3 code present in the ISO 4217 list (`ISO_4217_ALPHA3_CODES`), otherwise undefined.
 * Shape-only matches that are not ISO codes (e.g. 'XYZ', 'ABC') return undefined.
 */
export function parseNexiCurrency(code: unknown): string | undefined {
  if (typeof code !== 'string' && typeof code !== 'number') return undefined;
  const str = String(code).trim();
  if (NEXI_NUMERIC_CURRENCY_MAP[str]) {
    return NEXI_NUMERIC_CURRENCY_MAP[str];
  }
  if (/^[A-Za-z]{3}$/.test(str)) {
    const upper = str.toUpperCase();
    return ISO_4217_ALPHA3_CODES.has(upper) ? upper : undefined;
  }
  return undefined;
}

/**
 * Validates and normalizes ISO-4217 currency codes (alpha-3 codes from the ISO 4217 list,
 * or mapped numeric codes). Non-ISO codes (e.g. 'EURO', 'XYZ', 'ABC') return undefined.
 */
export const parseIsoCurrency = parseNexiCurrency;
