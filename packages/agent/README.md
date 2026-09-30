# @rag-client/agent

Reusable local-first RAG core extracted from the `rag-client` app.
Pure retrieval stack — no app chrome, no API keys, no secrets.

- `chunk.ts` — recursive character chunker (~1000 chars / 200 overlap, H1>H2 section trails, content hashes)
- `embed.ts` — `Embedder` interface; `TransformersEmbedder` (real ONNX path, **lazy** dynamic import so the base bundle stays tiny); `HashEmbedder` (deterministic stand-in for unit tests only)
- `bm25.ts` — BM25 (k1=1.5, b=0.75) with compact Porter stemmer + cached per-corpus index
- `fuse.ts` — Reciprocal Rank Fusion (k=60), the only fusion signal in the retrieve path
- `retrieve.ts` — hybrid retrieve v2 (pure RRF over dense + sparse, dense-cosine no-answer gate, fail-closed vectors)
- `detect.ts` — compute-tier detection (`nano` | `webllm` | `api`), never downloads weights until the tier check passes
- `types.ts` — frozen shared contracts: `Chunk`, `Hit`, `Retrieval`, `Embedder`, `Store`, `Parser`, `Generation`, `TierPolicy`, `EvalCase` (`Store` / `Parser` / `Generation` are interfaces only — bodies land in later tasks)

## Import

```ts
import { chunkDocument, HashEmbedder, indexCorpus, retrieve, detectTier } from "@rag-client/agent";
import type { Chunk, EvalCase, Store, TierPolicy } from "@rag-client/agent";
```
