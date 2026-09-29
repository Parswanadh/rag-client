# rag-client — stage-wise plan: local-first client-side RAG PWA

Goal: TypeScript PWA where DB + parsing + vectors are on-device, the LLM loads
locally when compute allows and falls back to the API key otherwise. Same
features as the stable server app (grounded chat, citations, library, upload,
streaming). Lightweight, no quality loss.

Research verdicts baked in: Mastra skipped as client runtime (Node-only, ~38MB,
no browser/IDB story — borrow its RAG/eval patterns only). Generation default:
Chrome Nano if readily → WebLLM Qwen2.5-1.5B/0.5B → API. Embeddings:
transformers.js arctic-xs/MiniLM. Store: sqlite-wasm+sqlite-vec/OPFS, Dexie
fallback. Parsing: pdf.js/mammoth/xlsx/JSZip-pptx, gated tesseract. Community
consensus: local retrieval + cloud generation hybrid, strict grounded prompts,
everything heavy in Workers, phones = API fallback.

## Stage 0 — API-fallback shell (v0, this scaffold) ✅
Vite+TS PWA, compute-tier detection display, login → workspace key
(sessionStorage), streaming grounded chat + citations + latency via the stable
backend (`POST /external/v1/{login,chat/stream,documents...}`). Local engines
as typed stubs. Deployed to Cloudflare Workers.

## Stage 1 — On-device retrieval (~2h)
- Web Worker: transformers.js `snowflake-arctic-embed-xs` (q8) embedding.
- Dexie (IndexedDB) chunk store + brute-force cosine + custom BM25 + RRF
  hybrid (SciFact-backed: hybrid MRR 0.65 > either alone).
- pdf.js page-at-a-time text extraction with `--- Page N ---` markers;
  mammoth (docx), dynamic xlsx, JSZip-slide PPTX.
- Recursive 1000c/200ov chunking + `heading: chunk` prefixes + content_hash.
- Golden-eval vs server answers (faithfulness = supported claims / total).

## Stage 2 — Local generation tier (~2h)
- Launch-time tiering: Nano if `readily` → cached WebLLM (1.5B desktop /
  0.5B light, 1–2k ctx) → API key. Progress UI for first weight download.
- Strict grounded system prompt (temp 0–0.2, quote-only, score threshold
  0.5–0.65, explicit I-don't-know) — the community's anti-hallucination recipe.
- Judge-gated: <2B single JSON only; multi-step agents stay on API.

## Stage 3 — sqlite-vec + sync (~2h)
- sqlite-wasm-vec on OPFS (vec0 + FTS5), int8 quantization, batched txns,
  200-page local cap with server offload above.
- Sync protocol: UUIDv7 + sha256 dedup, IDB outbox + SW background sync,
  cursor pull, LWW + tombstones, MinIO presigned bytes.
- Gated tesseract OCR (≤5 pages, opt-in, Worker) else server flag.

## Stage 4 — Hardening (~1h)
- `persist()` + quota meter + blob-first LRU eviction + rehydrate; iOS
  fallback path (IDB + WASM-SIMD, no WebGPU assumption); 7-day-wipe banner.
- In-browser eval harness (recall@K, faithfulness) on 20–30 golden Qs in CI.
- Mastra-pattern faithfulness scorers for server-side regression only.

## Failure modes (see docs/FAILURES.md)
OOM tab, storage eviction, Safari gaps, small-model hallucination, sync
conflicts, secret leakage, offline staleness, weight-download abandonment,
tunnel/proxy dependency for the API path, build-weight creep.
