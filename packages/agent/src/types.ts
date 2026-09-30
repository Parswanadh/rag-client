/** Shared contracts for the local-first RAG agent.
 *
 * Canonical value shapes (Chunk, Hit, Retrieval, Embedder) live in their
 * implementation modules and are re-exported here so `types.ts` is the
 * single place to discover every contract name. Store / Parser / Generation
 * are interfaces only in this task — bodies land in later tasks.
 */
export type { Chunk } from "./chunk";
export type { Embedder } from "./embed";
export type { Hit, Retrieval } from "./retrieve";
import type { Chunk } from "./chunk";

/** Persistent vector store (Dexie / sqlite-vec / OPFS land in later stages).
 * Vectors are keyed by chunk id; implementations may be sync or async.
 */
export interface Store {
  putChunks(chunks: Chunk[], vectors: Map<string, number[]>): void | Promise<void>;
  searchDense(vec: number[], k: number): { id: string; score: number }[] | Promise<{ id: string; score: number }[]>;
  allChunks(): Chunk[] | Promise<Chunk[]>;
  clear(): void | Promise<void>;
  size(): number | Promise<number>;
}

/** In-browser document parser (pdf.js / mammoth land in later stages). */
export interface Parser {
  parse(file: File | Blob, name: string): Promise<{ pages: { page: number; text: string }[]; mime: string }>;
}

/** Local text generation (WebLLM / Chrome Nano land in later stages).
 * `context` is the grounded context assembled from retrieved hits.
 */
export interface Generation {
  generate(prompt: string, context: string): AsyncGenerator<string>;
  isAvailable(): Promise<boolean>;
}

/** Compute-tier routing decision. `extractive` (no LLM: quote the best
 * hit verbatim) has no detector yet — it is a policy fallback chosen by
 * the caller, not by `detectTier` (which reports nano | webllm | api).
 */
export interface TierPolicy {
  tier: "nano" | "webllm" | "extractive" | "api";
  reason: string;
}

/** Retrieval eval harness case (harness lands in a later task). */
export interface EvalCase {
  q: string;
  expectPhrases: string[];
  noAnswer: boolean;
  minCites: number;
  page?: number;
}
