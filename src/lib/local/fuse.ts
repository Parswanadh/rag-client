/** Reciprocal Rank Fusion (k=60) over ranked id lists + min-max normalize.
 * RRF is rank-based: dense and sparse scales never mix directly, which is why
 * hybrid beats either lane alone.
 */
export function rrf(ranks: string[][], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of ranks) {
    list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return out;
}

export function normalize(scores: Map<string, number>): Map<string, number> {
  const vals = [...scores.values()];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi <= lo) return new Map([...scores.keys()].map((id) => [id, 1]));
  return new Map([...scores].map(([id, v]) => [id, (v - lo) / (hi - lo)]));
}

/** Proximity re-boost: fraction of distinct query terms co-occurring in the
 * text (free pre-rerank signal; cross-encoder lands in Stage 2). */
export function proximity(text: string, queryTerms: string[]): number {
  if (!queryTerms.length) return 0;
  const low = text.toLowerCase();
  const hit = new Set(queryTerms.filter((t) => t.length > 2 && low.includes(t)));
  return hit.size / queryTerms.length;
}
