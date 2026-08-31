/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once —
 * bounds how many simultaneous requests a large catalog sync opens against
 * an upstream (NOMAD/Kiwix, FlatNotes, ...) rather than firing all of them
 * at once. Extracted here once a second gateway (`FlatnotesGateway`) needed
 * the exact same bounded-concurrency fetch loop `KiwixGateway.syncCatalog()`
 * already had — same "extract at the second need" convention already
 * applied to `fetch-bounded.ts`/`node/src/bounded-map.ts`.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (let i = nextIndex++; i < items.length; i = nextIndex++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
