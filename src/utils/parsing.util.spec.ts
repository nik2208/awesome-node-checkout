import { describe, it, expect } from 'vitest';
import { parseAmount, parseAmountFromCents, parseNexiCurrency } from './parsing.util';

describe('parsing.util', () => {
  describe('parseAmount', () => {
    it('returns finite numbers directly', () => {
      expect(parseAmount(12.34)).toBe(12.34);
      expect(parseAmount(0)).toBe(0);
      expect(parseAmount(-5)).toBe(-5);
    });

    it('parses valid numeric strings', () => {
      expect(parseAmount('12.34')).toBe(12.34);
      expect(parseAmount('0')).toBe(0);
      expect(parseAmount('-5.5')).toBe(-5.5);
    });

    it('returns undefined for empty strings, whitespace, null, undefined, booleans', () => {
      expect(parseAmount('')).toBeUndefined();
      expect(parseAmount('   ')).toBeUndefined();
      expect(parseAmount(null)).toBeUndefined();
      expect(parseAmount(undefined)).toBeUndefined();
      expect(parseAmount(true)).toBeUndefined();
      expect(parseAmount(false)).toBeUndefined();
    });

    it('returns undefined for NaN, Infinity, -Infinity and non-numeric strings', () => {
      expect(parseAmount(NaN)).toBeUndefined();
      expect(parseAmount(Infinity)).toBeUndefined();
      expect(parseAmount(-Infinity)).toBeUndefined();
      expect(parseAmount('abc')).toBeUndefined();
      expect(parseAmount('12abc')).toBeUndefined();
    });
  });

  describe('parseAmountFromCents', () => {
    it('divides valid amount by 100', () => {
      expect(parseAmountFromCents(1999)).toBe(19.99);
      expect(parseAmountFromCents('1999')).toBe(19.99);
      expect(parseAmountFromCents(0)).toBe(0);
    });

    it('returns undefined for invalid or empty inputs', () => {
      expect(parseAmountFromCents('')).toBeUndefined();
      expect(parseAmountFromCents('  ')).toBeUndefined();
      expect(parseAmountFromCents(null)).toBeUndefined();
      expect(parseAmountFromCents(undefined)).toBeUndefined();
      expect(parseAmountFromCents('invalid')).toBeUndefined();
    });
  });

  describe('parseNexiCurrency', () => {
    it('maps known numeric ISO-4217 currency codes to alpha-3 codes', () => {
      expect(parseNexiCurrency('978')).toBe('EUR');
      expect(parseNexiCurrency(978)).toBe('EUR');
      expect(parseNexiCurrency('840')).toBe('USD');
      expect(parseNexiCurrency('826')).toBe('GBP');
      expect(parseNexiCurrency('756')).toBe('CHF');
      expect(parseNexiCurrency('392')).toBe('JPY');
    });

    it('preserves and uppercases valid 3-letter alpha codes', () => {
      expect(parseNexiCurrency('EUR')).toBe('EUR');
      expect(parseNexiCurrency('eur')).toBe('EUR');
      expect(parseNexiCurrency('usd')).toBe('USD');
    });

    it('returns undefined for unknown numeric codes, invalid strings, and non-string/non-number', () => {
      expect(parseNexiCurrency('9999')).toBeUndefined();
      expect(parseNexiCurrency('12')).toBeUndefined();
      expect(parseNexiCurrency('EUROPE')).toBeUndefined();
      expect(parseNexiCurrency('')).toBeUndefined();
      expect(parseNexiCurrency(null)).toBeUndefined();
      expect(parseNexiCurrency(undefined)).toBeUndefined();
      expect(parseNexiCurrency({})).toBeUndefined();
    });
  });
});
