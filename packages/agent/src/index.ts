/** @rag-client/agent — reusable local-first RAG core.
 * Explicit named exports: Chunk / Embedder / Hit / Retrieval are
 * canonically defined in their modules and re-exported via ./types,
 * so star-exports would be ambiguous here.
 *
 * WARNING: importing this index pulls in ./embed.ts, whose lazy
 * `import("@huggingface/transformers")` makes Rollup emit onnxruntime's
 * ~26.9 MB ort-wasm into dist/ even when fully tree-shaken — an
 * unreferenced file that exceeds Cloudflare's 25 MiB per-file asset limit
 * and breaks `wrangler deploy`. App (PWA) code MUST use the narrow subpath
 * imports (`@rag-client/agent/detect`, `/chunk`, `/embed`, `/bm25`,
 * `/fuse`, `/retrieve`, `/types`) so embed.ts never enters the bundle
 * graph. `npm run guard` (chained into `npm run build`) fails the build
 * if any .wasm lands in dist/.
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
export { DexieStore } from "./store";
export type { ChunkRow, LocalStore, OutboxEntry, OutboxHandler, OutboxOp } from "./store";
