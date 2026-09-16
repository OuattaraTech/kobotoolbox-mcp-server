import * as kobo from "./koboClient.js";
import { buildCodebook, Codebook } from "./codebook.js";
import { buildDataset, Dataset } from "./dataset.js";

interface CacheEntry {
  dataset: Dataset;
  codebook: Codebook;
  fetchedAt: number;
  query?: string;
}

/**
 * Submissions are fetched once and reused across the analysis tools in a
 * conversation: profiling, cross-tabs and report building all run on the same
 * snapshot, so the numbers stay consistent and Kobo isn't hammered.
 */
const cache = new Map<string, CacheEntry>();

const TTL_MS = 15 * 60 * 1000;

function key(uid: string, query?: string): string {
  return `${uid}::${query ?? ""}`;
}

export interface LoadOptions {
  query?: string;
  maxRows?: number;
  language?: string;
  /** Bypass the cache and pull a fresh copy from Kobo. */
  refresh?: boolean;
}

export async function loadDataset(uid: string, opts: LoadOptions = {}): Promise<CacheEntry> {
  const k = key(uid, opts.query);
  const hit = cache.get(k);
  if (hit && !opts.refresh && Date.now() - hit.fetchedAt < TTL_MS) {
    return hit;
  }

  const asset = await kobo.getAsset(uid);
  const codebook = buildCodebook(asset, opts.language);
  const { rows, total, truncated } = await kobo.fetchAllSubmissions(uid, {
    query: opts.query,
    maxRows: opts.maxRows,
    // The caller has asked for an explicit number of rows; the default already
    // carries the safety ceiling, so don't clamp a deliberate larger request.
    allowUnbounded: true,
  });
  const dataset = buildDataset(codebook, rows, { total, truncated });

  const entry: CacheEntry = { dataset, codebook, fetchedAt: Date.now(), query: opts.query };
  cache.set(k, entry);
  return entry;
}

/** Returns a cached snapshot without hitting Kobo, if one is still fresh. */
export function peekDataset(uid: string, query?: string): CacheEntry | undefined {
  const hit = cache.get(key(uid, query));
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;
  return undefined;
}

export function clearCache(): void {
  cache.clear();
}
