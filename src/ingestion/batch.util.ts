/**
 * Postgres rejects a single INSERT ... ON CONFLICT ... DO UPDATE statement if
 * two of its OWN input rows target the same conflict key ("ON CONFLICT DO
 * UPDATE command cannot affect row a second time"). Any batch upsert built
 * from N scraped items across multiple hotels WILL hit this eventually (the
 * same amenity name, the same room category, occasionally the same hotel
 * name) — so every batch upsert must dedupe its input by conflict key first.
 *
 * This collapses `items` by `keyFn`, keeping the LAST occurrence (most
 * recently scraped wins), and returns a map from every original index to the
 * index it was collapsed into within `deduped` — so callers can still
 * distribute the single resolved id/row back out to every original item
 * (e.g. two hotels in one batch that happened to share a name both get the
 * same resulting hotel id).
 */
export interface Deduped<T> {
  deduped: T[];
  indexToDedupedIndex: number[];
}

export function dedupeKeepLast<T>(items: T[], keyFn: (item: T) => string): Deduped<T> {
  const dedupedIndexByKey = new Map<string, number>();
  const deduped: T[] = [];
  const indexToDedupedIndex: number[] = new Array(items.length);

  items.forEach((item, originalIndex) => {
    const key = keyFn(item);
    const existingIndex = dedupedIndexByKey.get(key);
    if (existingIndex === undefined) {
      const newIndex = deduped.length;
      deduped.push(item);
      dedupedIndexByKey.set(key, newIndex);
      indexToDedupedIndex[originalIndex] = newIndex;
    } else {
      deduped[existingIndex] = item; // last occurrence wins
      indexToDedupedIndex[originalIndex] = existingIndex;
    }
  });

  return { deduped, indexToDedupedIndex };
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Runs `tasks` under a shared bounded worker pool of size `limit` — each of
 * `limit` workers pulls the next unclaimed task as soon as it finishes its
 * current one, so the pool stays saturated instead of stepping through fixed
 * chunks (a straggler in one chunk no longer stalls everything behind it).
 * One caller's failure doesn't stop the rest — each task is responsible for
 * catching its own errors if a partial failure shouldn't abort the batch.
 */
export async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  const poolSize = Math.max(1, Math.min(limit, tasks.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      for (let i = next++; i < tasks.length; i = next++) {
        await tasks[i]();
      }
    }),
  );
}
