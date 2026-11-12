/**
 * Adds (or replaces) the `mandate_ref` query parameter of an absolute URL, keeping the rest of
 * the query and the hash. Providers use it for the setup's `returnUrl`, `cancelUrl` and
 * `notifyUrl`, so that the callback route can find the pending state.
 *
 * `appendMandateRef('https://x.test/r?a=1#h', 'MNDT00001')` →
 * `'https://x.test/r?a=1&mandate_ref=MNDT00001#h'`.
 *
 * @throws TypeError when `url` is not an absolute URL.
 */
export function appendMandateRef(url: string, mandateRef: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('mandate_ref', mandateRef);
  return parsed.toString();
}
