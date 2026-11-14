import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import ts from 'typescript';

// Public types of #53, checked with the TypeScript compiler. Vitest strips types and tsconfig.json excludes the specs,
// so a spec that only imported a missing type would still pass: this one compiles a snippet against src/index.ts with
// the repository's compiler options, and reads the declarations through the type checker.

const ROOT = join(__dirname, '..');
const SNIPPET_FILE = join(__dirname, '__provider-error-code.types.snippet__.ts');

const SNIPPET = `
import type {
  ChargeErrorCode,
  ChargeLookupResult,
  ChargeResult,
  MandateRevokeResult,
  MandateSetupOutcome,
  MandateSetupStart,
  MandateStatusResult,
  PaymentResult,
  ProviderErrorCode,
} from './index';

// 2.2.0 code keeps compiling
const amountMismatch: ChargeResult = {
  status: 'unknown',
  verified: true,
  chargeRef: 'SUB-0001-INIT',
  errorCode: 'AMOUNT_MISMATCH',
  error: 'Captured amount does not match',
};
const code22: ChargeErrorCode = 'AMOUNT_MISMATCH';
const payment22: PaymentResult = { success: false, error: 'Response status code was not ok: 503.' };
const isMismatch = (result: ChargeResult): boolean => result.errorCode === 'AMOUNT_MISMATCH';

// Since 2.3.0
const providerCodes: ProviderErrorCode[] = ['PROVIDER_AUTH_FAILED', 'PROVIDER_AUTH_UNAVAILABLE'];
const chargeCodes: ChargeErrorCode[] = ['AMOUNT_MISMATCH', ...providerCodes];
const payment: PaymentResult = { success: false, errorCode: 'PROVIDER_AUTH_FAILED', error: 'PayPal authentication failed (HTTP 401)' };
const start: MandateSetupStart = { success: false, errorCode: 'PROVIDER_AUTH_UNAVAILABLE', error: 'Failed to create PayPal mandate setup' };
const outcome: MandateSetupOutcome = {
  success: false,
  verified: false,
  terminal: false,
  errorCode: 'PROVIDER_AUTH_FAILED',
  firstCharge: { status: 'unknown', verified: false, chargeRef: 'SUB-0001-INIT' },
};
const status: MandateStatusResult = { status: 'unknown', verified: false, errorCode: 'PROVIDER_AUTH_UNAVAILABLE' };
const revoke: MandateRevokeResult = { revokedAtProvider: false, errorCode: 'PROVIDER_AUTH_FAILED' };
const lookup: ChargeLookupResult = { status: 'unknown', verified: false, chargeRef: 'SUB-0001-2026-12', errorCode: 'PROVIDER_AUTH_UNAVAILABLE' };
const charge: ChargeResult = { status: 'unknown', verified: false, chargeRef: 'SUB-0001-2026-12', errorCode: 'PROVIDER_AUTH_FAILED' };
const fromCharge: ProviderErrorCode | 'AMOUNT_MISMATCH' | undefined = charge.errorCode;

// @ts-expect-error: AMOUNT_MISMATCH is a charge code, not a ProviderErrorCode
const notProviderCode: PaymentResult = { success: false, errorCode: 'AMOUNT_MISMATCH' };
// @ts-expect-error: not a code
const notCode: ChargeErrorCode = 'PROVIDER_AUTH';

export {
  amountMismatch,
  code22,
  payment22,
  isMismatch,
  chargeCodes,
  payment,
  start,
  outcome,
  status,
  revoke,
  lookup,
  fromCharge,
  notProviderCode,
  notCode,
};
`;

let program: ts.Program;
let checker: ts.TypeChecker;

/** The declaration exported by src/index.ts under `name` (aliases resolved). */
function exported(name: string): ts.Symbol {
  const index = program.getSourceFile(join(__dirname, 'index.ts'));
  if (!index) throw new Error('src/index.ts is not part of the program');
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(index)!).find((s) => s.getName() === name);
  if (!symbol) throw new Error(`src/index.ts does not export ${name}`);
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Property `name` of the interface exported as `type`. */
function property(type: string, name: string): ts.Symbol | undefined {
  return checker.getDeclaredTypeOfSymbol(exported(type)).getProperty(name);
}

/** The members of the union type alias exported as `name`, sorted. */
function members(name: string): string[] {
  const type = checker.getDeclaredTypeOfSymbol(exported(name));
  const types = type.isUnion() ? type.types : [type];
  return types.map((t) => checker.typeToString(t)).sort();
}

beforeAll(() => {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const options: ts.CompilerOptions = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === SNIPPET_FILE
      ? ts.createSourceFile(fileName, SNIPPET, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => fileName === SNIPPET_FILE || fileExists(fileName);
  host.readFile = (fileName) => (fileName === SNIPPET_FILE ? SNIPPET : readFile(fileName));
  program = ts.createProgram([SNIPPET_FILE], options, host);
  checker = program.getTypeChecker();
}, 60_000);

describe('ProviderErrorCode: public types (#53)', () => {
  it('2.2.0 code (a ChargeResult with AMOUNT_MISMATCH, a PaymentResult without errorCode) and 2.3.0 code compile', () => {
    const file = program.getSourceFile(SNIPPET_FILE)!;
    const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  it('src/index.ts exports ProviderErrorCode: PROVIDER_AUTH_FAILED | PROVIDER_AUTH_UNAVAILABLE', () => {
    expect(members('ProviderErrorCode')).toEqual(['"PROVIDER_AUTH_FAILED"', '"PROVIDER_AUTH_UNAVAILABLE"']);
  });

  it('ChargeErrorCode gains both codes', () => {
    expect(members('ChargeErrorCode')).toEqual(['"AMOUNT_MISMATCH"', '"PROVIDER_AUTH_FAILED"', '"PROVIDER_AUTH_UNAVAILABLE"']);
    const errorCode = property('ChargeResult', 'errorCode');
    expect(errorCode!.flags & ts.SymbolFlags.Optional).not.toBe(0);
    expect(checker.typeToString(checker.getTypeOfSymbol(errorCode!))).toBe('ChargeErrorCode | undefined');
  });

  it.each([
    'PaymentResult',
    'MandateSetupStart',
    'MandateSetupOutcome',
    'MandateStatusResult',
    'MandateRevokeResult',
    'ChargeLookupResult',
  ])('%s has an optional errorCode of type ProviderErrorCode', (type) => {
    const errorCode = property(type, 'errorCode');
    expect(errorCode).toBeDefined();
    expect(errorCode!.flags & ts.SymbolFlags.Optional).not.toBe(0);
    expect(checker.typeToString(checker.getTypeOfSymbol(errorCode!))).toBe('ProviderErrorCode | undefined');
    expect(ts.displayPartsToString(errorCode!.getDocumentationComment(checker))).toContain('Since 2.3.0');
  });

  it('WebhookResult and MandatePendingState are unchanged (no errorCode)', () => {
    expect(property('WebhookResult', 'errorCode')).toBeUndefined();
    expect(property('MandatePendingState', 'errorCode')).toBeUndefined();
  });
});
