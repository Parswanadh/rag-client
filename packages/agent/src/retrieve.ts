/** Hybrid retrieve v2 (review fixes applied).
 *
 * - ONE fusion signal: pure RRF (k=60) over dense + sparse ranks. No blends,
 *   no proximity re-boost (BM25 already scores lexical overlap).
 * - No-answer mirrors the server: best dense cosine < minScore. Embedders are
 *   named per model (no instruction prefixes MiniLM never trained on).
 * - Fail-closed: missing/dim-mismatched vectors throw (never NaN-ranked).
 * - Index built once per corpus (CachedIndex); chunk lookup is O(1).
 */
import { CachedIndex } from "./bm25";
import { assertVectors, cosine, type Embedder } from "./embed";
import { rrf } from "./fuse";
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

export interface IndexedCorpus {
  chunks: Chunk[];
  byId: Map<string, Chunk>;
  bm25: CachedIndex;
  vectors: Map<string, number[]>;
  dim: number;
}

export function indexCorpus(chunks: Chunk[], vectors: Map<string, number[]>, dim: number): IndexedCorpus {
  assertVectors(
    chunks.map((c) => c.id),
    vectors,
    dim,
  );
  return {
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    bm25: new CachedIndex(chunks.map((c) => c.text)),
    vectors,
    dim,
  };
}

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  pool?: number;
}

export async function retrieve(
  query: string,
  corpus: IndexedCorpus,
  embedder: Embedder,
  opts: RetrieveOptions = {},
): Promise<Retrieval> {
  const { topK = 8, minScore = 0.35, pool = 50 } = opts;
  if (!corpus.chunks.length) return { hits: [], noAnswer: true };
  if (embedder.dim !== corpus.dim) throw new Error(`embedder dim ${embedder.dim} != corpus dim ${corpus.dim}`);
  const [qvec] = await embedder.embed([query]);
  if (!qvec || qvec.length !== corpus.dim) throw new Error("query embedding failed");
  const dense = corpus.chunks
    .map((c) => ({ id: c.id, s: cosine(qvec, corpus.vectors.get(c.id) ?? []) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, pool);
  const bscores = corpus.bm25.score(query);
  const sparse = corpus.chunks
    .map((c, i) => ({ id: c.id, s: bscores[i] ?? 0 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, pool);
  const denseIds = new Set(dense.map((d) => d.id));
  const sparseIds = new Set(sparse.map((s) => s.id));
  const fused = rrf([
    dense.map((d) => d.id),
    sparse.map((s) => s.id),
  ]);
  const hits: Hit[] = [...fused.entries()]
    .map(([id, s]) => {
      const chunk = corpus.byId.get(id);
      if (!chunk) throw new Error(`fused unknown chunk ${id}`);
      const inD = denseIds.has(id);
      const inS = sparseIds.has(id);
      return { chunk, score: s, lane: inD && inS ? ("both" as const) : inD ? ("dense" as const) : ("sparse" as const) };
    })
    .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
    .slice(0, topK);
  const bestDense = dense.length ? dense[0].s : -1;
  if (bestDense < minScore) return { hits: [], noAnswer: true };
  return { hits, noAnswer: hits.length === 0 };
}
