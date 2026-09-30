/** Task 5 local pipeline: on-device ingest → retrieve → answer.
 *
 * This module is ALWAYS dynamically imported by app code
 * (`await import("./local/pipeline")`) so Dexie/pdf.js stay out of the
 * initial bundle. Static imports here are limited to wasm-free agent
 * subpaths (chunk/bm25/fuse/generate + erased types). NEVER statically
 * import `@rag-client/agent/embed`, `/retrieve`, `/parse`, or `/store`
 * from app code — `embed.ts` pulls onnxruntime wasm into dist/ (guard),
 * and `retrieve.ts` re-exports through `embed.ts`.
 */
import { chunkDocument, type Chunk } from "@rag-client/agent/chunk";
import { CachedIndex } from "@rag-client/agent/bm25";
import { rrf } from "@rag-client/agent/fuse";
import {
  composeExtractive,
  formatSources,
  NanoEngine,
  NO_ANSWER_TEXT,
  WebLLMEngine,
} from "@rag-client/agent/generate";
import type { Hit, Retrieval } from "@rag-client/agent/retrieve";
import type { DexieStore } from "@rag-client/agent/store";
import { readTombstones, type LocalEngineKind } from "./policy";

/** App-side char-trigram hash embedder — algorithm-parity with the agent's
 * `HashEmbedder` (same tokenize/trigram/FNV/normalize, dim 384) so stored
 * vectors stay forward-compatible with a future MiniLM swap. Kept inline
 * (instead of importing `@rag-client/agent/embed`) because `embed.ts`
 * carries the lazy transformers import that emits onnxruntime wasm. */
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

export class LocalHashEmbedder {
  readonly dim: number;
  constructor(dim = 384) {
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of tokenize(t)) {
        for (let i = 0; i < tok.length; i++) {
          let h = 2166136261;
          for (const c of tok.slice(i, i + 3)) {
            h ^= c.charCodeAt(0);
            h = Math.imul(h, 16777619);
          }
          v[Math.abs(h) % this.dim] += 1;
        }
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

/** Why local vectors are hashed (surfaced in the library UI). */
export const HASH_EMBED_NOTE =
  "hashed char-trigram vectors (dim 384, HashEmbedder-parity) — MiniLM deferred: " +
  "onnxruntime wasm exceeds the host 25 MiB asset limit (R2-hosted wasm is a later stage)";

/** Minimal store surface the local pipeline needs (satisfied by DexieStore). */
export interface DenseStore {
  allChunks(): Promise<Chunk[]>;
  searchDense(vec: number[], k: number): Promise<{ id: string; score: number }[]>;
}

export interface OutboxStore {
  enqueue(op: "put" | "delete", payload: unknown): Promise<number>;
  flush(handler: (op: "put" | "delete", payload: unknown) => void | Promise<void>): Promise<number>;
  pending(): Promise<number>;
}

export interface QueryEmbedder {
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Structural generation engine (satisfied by Nano/WebLLM/Extractive engines). */
export interface EngineLike {
  generate(prompt: string, context: string): AsyncGenerator<string>;
}

const stores = new Map<string, DexieStore>();

/** Dexie singleton (dynamic import keeps Dexie in a lazy chunk). */
export async function getStore(dbName = "rag-client"): Promise<DexieStore> {
  let s = stores.get(dbName);
  if (!s) {
    const { DexieStore: Ctor } = await import("@rag-client/agent/store");
    s = new Ctor(dbName);
    stores.set(dbName, s);
  }
  return s;
}

export interface IngestResult {
  docId: string;
  filename: string;
  pages: number;
  chunks: number;
  note: string;
}

/** Local upload path: agent parse() → chunkDocument → hash embed → Dexie. */
export async function ingestLocalFile(file: Blob, filename: string, docId?: string): Promise<IngestResult> {
  const { parseDocument } = await import("@rag-client/agent/parse");
  const parsed = await parseDocument(file, filename);
  const id =
    docId ?? `local-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const chunks = await chunkDocument(
    id,
    parsed.pages.map((p) => ({ page: p.page, text: p.text })),
  );
  const embedder = new LocalHashEmbedder(384);
  const vecs = await embedder.embed(chunks.map((c) => c.text));
  const map = new Map(chunks.map((c, i) => [c.id, vecs[i] as number[]]));
  await (await getStore()).putChunks(chunks, map);
  return { docId: id, filename, pages: parsed.pages.length, chunks: chunks.length, note: HASH_EMBED_NOTE };
}

export interface RetrieveLocalOptions {
  store?: DenseStore;
  embedder?: QueryEmbedder;
  tombstones?: Set<string>;
  topK?: number;
  minScore?: number;
  pool?: number;
}

/** Hybrid retrieve over the Dexie store: dense (searchDense) + BM25 sparse,
 * fused by pure RRF — same semantics as agent retrieve() (RRF k=60,
 * minScore no-answer mirror, fail-closed on fused unknowns). */
export async function retrieveLocal(question: string, opts: RetrieveLocalOptions = {}): Promise<Retrieval> {
  const { topK = 8, minScore = 0.35, pool = 50 } = opts;
  const store = opts.store ?? await getStore();
  const embedder = opts.embedder ?? new LocalHashEmbedder(384);
  const tomb = opts.tombstones ?? new Set(readTombstones());
  const chunks = (await store.allChunks()).filter((c) => !tomb.has(c.docId));
  if (chunks.length === 0) return { hits: [], noAnswer: true };
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const [qvec] = await embedder.embed([question]);
  if (!qvec) throw new Error("query embedding failed");
  const dense = (await store.searchDense(qvec, pool))
    .filter((d) => byId.has(d.id))
    .slice(0, pool);
  const bscores = new CachedIndex(chunks.map((c) => c.text)).score(question);
  const sparse = chunks
    .map((c, i) => ({ id: c.id, s: bscores[i] ?? 0 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, pool);
  const denseIds = new Set(dense.map((d) => d.id));
  const sparseIds = new Set(sparse.map((s) => s.id));
  const fused = rrf([dense.map((d) => d.id), sparse.map((s) => s.id)]);
  const hits: Hit[] = [...fused.entries()]
    .map(([id, s]) => {
      const chunk = byId.get(id);
      if (!chunk) throw new Error(`fused unknown chunk ${id}`);
      const inD = denseIds.has(id);
      const inS = sparseIds.has(id);
      return {
        chunk,
        score: s,
        lane: inD && inS ? ("both" as const) : inD ? ("dense" as const) : ("sparse" as const),
      };
    })
    .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
    .slice(0, topK);
  const bestDense = dense.length ? (dense[0] as { score: number }).score : -1;
  if (bestDense < minScore) return { hits: [], noAnswer: true };
  return { hits, noAnswer: hits.length === 0 };
}

/** Answer via a live engine. ALWAYS passes formatSources(hits) — the
 * numbered grounded sources — as `context` (review finding: the prompt
 * lacks numbered sources otherwise). */
export async function answerLocal(
  question: string,
  engine: EngineLike,
  opts: { retrieveFn?: (q: string) => Promise<Retrieval> } = {},
): Promise<{ answer: string; hits: Hit[] }> {
  const retrieveFn = opts.retrieveFn ?? ((q: string) => retrieveLocal(q));
  const { hits } = await retrieveFn(question);
  const context = formatSources(hits);
  let answer = "";
  for await (const t of engine.generate(question, context)) answer += t;
  return { answer, hits };
}

export interface LocalAnswer {
  answer: string;
  hits: Hit[];
  citations: { marker: string; documentId: string; page: number | null }[];
  noAnswer: boolean;
  engineKind: LocalEngineKind;
}

/** Full local ask: engine chosen by the caller (policy.resolveEngineKind).
 * Extractive composes quote-only answers; live engines stream with numbered
 * sources; empty retrieval short-circuits to the honest no-answer text. */
export async function answerWithKind(
  question: string,
  kind: LocalEngineKind,
  webllm?: EngineLike | null,
): Promise<LocalAnswer> {
  if (kind === "extractive") {
    const { hits, noAnswer } = await retrieveLocal(question);
    const r = composeExtractive(hits);
    return {
      answer: r.answer,
      hits,
      citations: r.citations.map((c) => ({ marker: c.marker, documentId: c.documentId, page: c.page })),
      noAnswer: r.noAnswer || noAnswer,
      engineKind: kind,
    };
  }
  const { hits, noAnswer } = await retrieveLocal(question);
  if (noAnswer || hits.length === 0) {
    return { answer: NO_ANSWER_TEXT, hits: [], citations: [], noAnswer: true, engineKind: kind };
  }
  const engine: EngineLike =
    kind === "nano" ? new NanoEngine() : requireWebLLM(webllm);
  return { ...(await answerLocal(question, engine)), citations: [], noAnswer: false, engineKind: kind };
}

function requireWebLLM(webllm?: EngineLike | null): EngineLike {
  if (!webllm) throw new Error("WebLLM not downloaded yet — tap “Download local model” first");
  return webllm;
}

let webllmEngine: WebLLMEngine | null = null;

export function isWebLLMLoaded(): boolean {
  return webllmEngine !== null;
}

export function getWebLLM(): WebLLMEngine | null {
  return webllmEngine;
}

/** Explicit model download (only call from the download tap). Progress
 * reuses the loader onProgress callback. */
export async function loadWebLLM(onProgress?: (p: number) => void): Promise<WebLLMEngine> {
  if (webllmEngine) return webllmEngine;
  const eng = new WebLLMEngine(onProgress ? { onProgress } : {});
  await eng.load();
  webllmEngine = eng;
  return eng;
}

export async function nanoReadily(): Promise<boolean> {
  try {
    return await new NanoEngine().isAvailable();
  } catch {
    return false;
  }
}

/** First chunks of a local doc (library preview). */
export async function readLocalChunks(docId: string, limit = 3): Promise<Chunk[]> {
  const all = await (await getStore()).allChunks();
  return all.filter((c) => c.docId === docId).slice(0, Math.max(1, limit));
}

export interface LocalOpPayload {
  kind: "upload" | "delete";
  docId: string;
  filename: string;
  at: number;
}

/** Queue a local mutation while offline (server sync is Stage 3). */
export async function queueLocalOp(
  op: "put" | "delete",
  payload: LocalOpPayload,
  store?: OutboxStore,
): Promise<number> {
  const s: OutboxStore = store ?? await getStore();
  return s.enqueue(op, payload);
}

export async function pendingOps(store?: OutboxStore): Promise<number> {
  const s: OutboxStore = store ?? await getStore();
  return s.pending();
}

/** Flush = mark flushed locally (rows deleted after the handler resolves).
 * The handler is a no-op: server sync belongs to Stage 3 and is NOT
 * invented here. */
export async function flushOutbox(store?: OutboxStore): Promise<number> {
  const s: OutboxStore = store ?? await getStore();
  return s.flush(async () => {});
}
