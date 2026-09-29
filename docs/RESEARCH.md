# Research digest (2026-09-29, 5 agents)

- **Mastra (mastra.ai): SKIP as client runtime.** Node/Bun/Deno/edge only;
  browser issue #9197 (Vite failures); ~38MB core; no IDB store, no browser
  embedder/LLM, no offline story. Borrow chunk/rerank/eval patterns only;
  optional server sidecar later.
- **Local LLMs:** tier Nano (Chrome desktop, readily) → WebLLM Qwen2.5
  1.5B (~1.6GB) / 0.5B (~800MB) → API. Embeddings: arctic-embed-xs 22M/384
  (best tiny) or MiniLM-L6-v2, q8 WASM ~12ms/q. Phones = API fallback
  (iOS tab limit ~1.5GB, Safari WebGPU only 26+). Detect: Nano availability
  → WebGPU adapter probe → deviceMemory/cores/UA.
- **Local store:** sqlite-wasm + sqlite-vec on OPFS (primary, ~1.5MB WASM,
  FTS5, int8 4x); Dexie + brute-force/VecLite fallback (good to ~50k
  chunks). Parsing: pdf.js (page markers, lazy pages), mammoth, dynamic
  xlsx, JSZip PPTX slides, gated tesseract ≤5pp. 1000pp ≈ 3–6 min local,
  200pp cap with server offload above.
- **Community:** shipping stacks = transformers.js + Dexie/IDB + WebLLM/wllama
  + pdf.js + Workers (LocalMode, Domicile, thinkhere, advancedRagDemo…).
  Consensus: local retrieval + cloud generation hybrid; strict grounded
  prompts + 0.5–0.65 thresholds + I-don't-know; hybrid BM25+vector RRF;
  Workers mandatory; iOS/Safari is the long pole. X/Facebook login-walled
  (no claims from them); Reddit snippets + HN titles + blogs used.
- **India/region:** keep Mimo V2.6 Flash via OpenCode Go primary. Fallbacks:
  Gemini Flash-Lite + Groq (fast/cheap), Sarvam 105B for Hindi/residency
  (₹29/₹73 per 1M, Bengaluru), Krutrim-2 dirt cheap. Local CPU: Gemma
  3-4B-Q4 (128K, Indic) or Qwen3-4B (Apache-2.0) + Arctic-embed-m; browser:
  Qwen3-1.7B-MLC. MiMo 311B cannot run locally (9B distill only).
