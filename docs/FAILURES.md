# Failure modes — how this goes wrong and the guard for each

1. **Tab OOM (weights + KV + vectors)** — Gate every download on tier check
   (WebGPU probe + deviceMemory + cores + mobile UA); 1.5B desktop / 0.5B
   light / phones API-only; 1–2k ctx caps KV; `maxStorageBufferBindingSize`
   check before `engine.reload()`.
2. **Storage eviction (origin wiped silently)** — `persist()` on first run,
   `estimate()` meter in UI, LRU doc eviction (blobs before vectors), server
   backup + one-tap rehydrate; offline badge with queued-write count.
3. **Safari/iOS gaps** — No WebGPU/OPFS assumptions: IDB + WASM-SIMD path,
   paginated ingest, real-device tests, 7-day-wipe warning when not installed.
4. **Small-model hallucination** — Strict prompts (temp 0–0.2, quote-only,
   0.5–0.65 threshold, I-don't-know), single-JSON only <2B, judge needs 7B+
   so faithfulness evals run server-side; multi-step agents stay on API.
5. **Sync conflicts/duplicates** — sha256 dedup, UUIDv7 ids, LWW+origin tiebreak,
   tombstone deletes with 30d GC, vectors derived-never-source-of-truth.
6. **Secret leakage** — No keys in bundle; login-swapped session key only;
   worker never logs keys; scope keys per workspace with expiry.
7. **Offline staleness** — Mark server collections stale when offline; reads
   served local-first with visible staleness; writes to outbox, never lost.
8. **Weight-download abandonment** — Resumable Cache-API chunks, progress UI,
   pause/resume, Wi-Fi-only default on mobile.
9. **API-path dependency** — Fallback path needs tunnel+backend; local tiers
   degrade gracefully offline; status dot shows which path serves.
10. **Build-weight creep** — Engines lazy-imported per stage; budget check in
    CI (initial JS < 300KB gz); Mastra-style 38MB deps banned from bundle.
11. **OCR cost blowup** — Client OCR hard-capped (5 pages, opt-in, Worker);
    larger docs flag `needs_ocr` for the server pipeline.
12. **Citation drift (small models)** — chunk→(doc,section,page,charStart/End)
    links mandatory, small-to-big retrieval, clickable chips; eval pins it.
