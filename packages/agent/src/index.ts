/** @rag-client/agent — reusable local-first RAG core.
 * Explicit named exports: Chunk / Embedder / Hit / Retrieval are
 * canonically defined in their modules and re-exported via ./types,
 * so star-exports would be ambiguous here.
 */
export { chunkDocument, chunkPage, sha256Hex, splitParagraphs } from "./chunk";
export type { Block, Chunk } from "./chunk";
export { assertVectors, cosine, HashEmbedder, TransformersEmbedder } from "./embed";
export type { Embedder } from "./embed";
export { buildIndex, CachedIndex, score, tokenize } from "./bm25";
export type { Bm25Index } from "./bm25";
export { rrf } from "./fuse";
export { indexCorpus, retrieve } from "./retrieve";
export type { Hit, IndexedCorpus, Retrieval, RetrieveOptions } from "./retrieve";
export { detectTier } from "./detect";
export type { Tier, TierInfo } from "./detect";
export type { EvalCase, Generation, Parser, Store, TierPolicy } from "./types";
