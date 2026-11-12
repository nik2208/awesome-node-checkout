const MAX_DEPTH = 32;
const REDACTED = '[redacted]';

/**
 * Returns a copy of `value` in which every occurrence of `secret` inside a string (values and
 * keys) is replaced by `'[redacted]'`. Plain objects, arrays and class instances are copied
 * through their own enumerable properties; binary data and dates are kept as they are. A cycle
 * becomes `'[circular]'` and nesting deeper than 32 levels is dropped. `value` itself is never mutated.
 *
 * Used to keep credential-like ids (the mandate's `providerMandateId`) out of event payloads.
 */
export function redactSecret<T>(value: T, secret: string | undefined): T {
  if (typeof secret !== 'string' || secret === '') return value;
  const ancestors = new Set<object>();
  const scrubString = (s: string): string => (s.includes(secret) ? s.split(secret).join(REDACTED) : s);

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date) return v;
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
