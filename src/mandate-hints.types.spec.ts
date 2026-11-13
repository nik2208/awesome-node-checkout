import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import ts from 'typescript';

// Public types of #46, checked with the TypeScript compiler. Vitest strips types and tsconfig.json excludes the specs,
// so a spec that only imported a missing type would still pass: this one compiles a snippet against src/index.ts with
// the repository's compiler options, and reads the declarations through the type checker.

const ROOT = join(__dirname, '..');
const SNIPPET_FILE = join(__dirname, '__mandate-hints.types.snippet__.ts');

const SNIPPET = `
import type { CheckoutConfig, Mandate, MandateHints, MandateSetupOutcome } from './index';

// Since 2.2.0: the hints next to the mandate, and where confirmMandate puts them
const hints: MandateHints = { cardExpiry: '203012', maskedPan: '453997******0006', payerEmail: 'payer@example.com' };
const outcomeHints: MandateSetupOutcome['hints'] = hints;
const configs: CheckoutConfig[] = [{}, { mandateHints: 'inline' }, { mandateHints: 'separate' }];
// @ts-expect-error: only 'inline' or 'separate'
const bogus: CheckoutConfig = { mandateHints: 'bogus' };

// 2.1.0 code keeps compiling: Mandate.unverified is deprecated, not removed
const legacy: Mandate['unverified'] = { cardExpiry: '203012', maskedPan: '453997******0006' };
const legacyHints: NonNullable<Mandate['unverified']> = hints;
const asHints: MandateHints | undefined = legacy;
const persisted: Mandate = {
  provider: 'nexi',
  mandateRef: 'MNDT0000000001',
  providerMandateId: 'MNDT0000000001',
  status: 'active',
  createdAt: '2026-12-01T10:15:00.000Z',
  unverified: { cardExpiry: '203012', maskedPan: '453997******0006' },
};
const maskedPan: string | undefined = persisted.unverified?.maskedPan;
const outcome21: MandateSetupOutcome = {
  success: true,
  verified: true,
  terminal: true,
  mandate: persisted,
  firstCharge: { status: 'succeeded', verified: true, chargeRef: 'SUB-0001-INIT' },
};

export { outcomeHints, configs, bogus, legacyHints, asHints, maskedPan, outcome21 };
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

describe('Mandate hints: public types (#46)', () => {
  it('MandateHints, MandateSetupOutcome.hints and CheckoutConfig.mandateHints compile, and so does 2.1 code using Mandate.unverified', () => {
    const file = program.getSourceFile(SNIPPET_FILE)!;
    const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  it('src/index.ts exports MandateHints', () => {
    const index = program.getSourceFile(join(__dirname, 'index.ts'))!;
    const names = checker.getExportsOfModule(checker.getSymbolAtLocation(index)!).map((s) => s.getName());
    expect(names).toContain('MandateHints');
  });

  it('Mandate.unverified is deprecated, not removed: still optional, of type MandateHints', () => {
    const unverified = property('Mandate', 'unverified');
    expect(unverified).toBeDefined();
    expect(unverified!.flags & ts.SymbolFlags.Optional).not.toBe(0);
    expect(unverified!.getJsDocTags(checker).map((tag) => tag.name)).toContain('deprecated');
    expect(checker.typeToString(checker.getTypeOfSymbol(unverified!))).toBe('MandateHints | undefined');
  });

  it('MandateSetupOutcome.hints and CheckoutConfig.mandateHints are optional, and neither is deprecated', () => {
    const hints = property('MandateSetupOutcome', 'hints');
    expect(hints).toBeDefined();
    expect(hints!.flags & ts.SymbolFlags.Optional).not.toBe(0);
    expect(checker.typeToString(checker.getTypeOfSymbol(hints!))).toBe('MandateHints | undefined');
    expect(hints!.getJsDocTags(checker).map((tag) => tag.name)).not.toContain('deprecated');

    const mode = property('CheckoutConfig', 'mandateHints');
    expect(mode).toBeDefined();
    expect(mode!.flags & ts.SymbolFlags.Optional).not.toBe(0);
    expect(checker.typeToString(checker.getTypeOfSymbol(mode!))).toBe('"inline" | "separate" | undefined');
    expect(mode!.getJsDocTags(checker).map((tag) => tag.name)).not.toContain('deprecated');
  });
});
