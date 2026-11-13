import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// package.json "exports" (#54): tools read an installed package's version through
// require('awesome-node-checkout/package.json'), which "exports" hides unless it lists "./package.json".
// Resolved here by self-reference (a package can import itself by name through its own "exports"), so no
// packing is needed. "." and "./express" point into dist/, which `npm test` does not build: they are only
// compared, never resolved.

const PACKAGE_JSON = path.resolve(__dirname, '..', 'package.json');

function packageJson(): { version: string; exports: unknown } {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
}

describe('package.json exports (#54)', () => {
  const req = createRequire(path.resolve(__dirname, 'index.ts'));

  it("require('awesome-node-checkout/package.json') reads the package's own package.json", () => {
    expect(req('awesome-node-checkout/package.json').version).toBe(packageJson().version);
    expect(req.resolve('awesome-node-checkout/package.json')).toBe(fs.realpathSync(PACKAGE_JSON));
  });

  it('"exports" is the two entry points, unchanged, and "./package.json"', () => {
    expect(packageJson().exports).toStrictEqual({
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      './express': {
        types: './dist/adapters/express/index.d.ts',
        default: './dist/adapters/express/index.js',
      },
      './package.json': './package.json',
    });
  });
});
