const MAX_DEPTH = 32;
const REDACTED = '[redacted]';
const BINARY = '[binary]';

/**
 * Returns a copy of `value` in which every occurrence of `secret` (or of each of several secrets)
 * inside a string (values and keys) is replaced by `'[redacted]'`. Plain objects, arrays and class instances are copied
 * through their own enumerable properties; dates are kept as they are. Binary data (`Buffer`,
 * typed arrays, `DataView`, `ArrayBuffer`) cannot be scrubbed reliably, so it becomes `'[binary]'`.
 * A cycle becomes `'[circular]'` and nesting deeper than 32 levels is dropped. `value` itself is
 * never mutated. Without a secret (`undefined`, `''`, or a list with none), `value` is returned as
 * it is (binary data included). Longer secrets are replaced first, so a secret that contains
 * another is never left half visible.
 *
 * Used to keep credential-like ids (the mandate's `providerMandateId`, a setup's
 * `pending.providerRef`) out of event payloads.
 */
export function redactSecret<T>(
  value: T,
  secret: string | undefined | readonly (string | undefined)[],
): T {
  const list = (Array.isArray(secret) ? secret : [secret]) as readonly unknown[];
  const secrets = [...new Set(list.filter((x): x is string => typeof x === 'string' && x !== ''))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return value;
  const ancestors = new Set<object>();
  const scrubString = (s: string): string =>
    secrets.reduce((acc, sec) => (acc.includes(sec) ? acc.split(sec).join(REDACTED) : acc), s);

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return BINARY;
    if (v instanceof Date) return v;
    if (depth >= MAX_DEPTH) return undefined;
    if (ancestors.has(v)) return '[circular]';
    ancestors.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      if (v instanceof Error) {
        out.name = v.name;
        out.message = scrubString(v.message);
      }
      for (const [key, item] of Object.entries(v)) {
        out[scrubString(key)] = walk(item, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };

  return walk(value, 0) as T;
}
