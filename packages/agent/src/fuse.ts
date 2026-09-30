/** Reciprocal Rank Fusion (k=60) over ranked id lists. Rank-based by
 * design: dense and sparse scales never mix directly. This is the ONLY
 * fusion signal in the retrieve path.
 */
export function rrf(ranks: string[][], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of ranks) {
    list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return out;
}
