/** Hybrid retrieve: dense cosine + BM25, RRF fusion, proximity re-boost,
 * min-score gate with honest no-answer. Same contract shape as the server
 * (`no_answer`, chunks with doc/page/section) so Stage-2 answers stay
 * comparable to the golden bench.
 */
import { score as bm25, buildIndex, tokenize } from "./bm25";
import { cosine, type Embedder } from "./embed";
import { normalize, proximity, rrf } from "./fuse";
import type { Chunk } from "./chunk";

export interface Hit {
  chunk: Chunk;
  score: number;
  lane: "both" | "dense" | "sparse";
}

export interface Retrieval {
  hits: Hit[];
  noAnswer: boolean;
}

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  pool?: number;
}

export async function retrieve(
  query: string,
  chunks: Chunk[],
  vectors: Map<string, number[]>,
  embedder: Embedder,
  opts: RetrieveOptions = {},
): Promise<Retrieval> {
  const { topK = 8, minScore = 0.35, pool = 50 } = opts;
  if (!chunks.length) return { hits: [], noAnswer: true };
  const [qvec] = await embedder.embed([`search_query: ${query}`]);
  const dense = chunks
    .map((c) => ({ c, s: cosine(qvec, vectors.get(c.id) ?? []) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, pool);
  const index = buildIndex(chunks.map((c) => c.text));
  const bscores = bm25(index, query);
  const sparse = chunks
    .map((c, i) => ({ c, s: bscores[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, pool);
  const fused = rrf([
    dense.map((d) => d.c.id),
    sparse.map((s) => s.c.id),
  ]);
  const dnorm = normalize(new Map(dense.map((d) => [d.c.id, d.s] as [string, number])));
  const snorm = normalize(new Map(sparse.map((s) => [s.c.id, s.s] as [string, number])));
  const terms = tokenize(query);
  const ranked = [...fused.entries()]
    .map(([id, f]) => {
      const c = chunks.find((x) => x.id === id)!;
      const base = f + 0.15 * (dnorm.get(id) ?? 0) + 0.15 * (snorm.get(id) ?? 0);
      const s = base * (0.85 + 0.3 * proximity(c.text, terms));
      const inD = dnorm.has(id);
      const inS = snorm.has(id);
      return { chunk: c, score: s, lane: inD && inS ? ("both" as const) : inD ? ("dense" as const) : ("sparse" as const) };
    })
    .sort((a, b) => b.score - a.score);
  // No-answer mirrors the server: best dense cosine below min_score means
  // nothing is semantically close, even if sparse matched exact terms.
  const bestDense = dense.length ? dense[0].s : -1;
  if (bestDense < minScore) return { hits: [], noAnswer: true };
  const hits = ranked.slice(0, topK);
  return { hits, noAnswer: hits.length === 0 };
}
