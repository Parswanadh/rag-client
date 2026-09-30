# Plan: full local transition + reusable TS agent package

Goal: `rag-client` works fully local-first (parse → embed → store → retrieve →
generate on-device, API fallback preserved), and the reusable core ships as a
native TypeScript package (`packages/agent`) usable later in any app.

## Global Constraints
- TDD: failing test first for behavior; ruff-equivalent discipline (tsc strict, no unused).
- No secrets in code/logs/commits. No backend (ragz) edits. No `main` pushes mid-plan (work on `local-transition`, merge at end).
- Bundle: app initial JS stays < 60KB gz; engines lazy-imported only.
- Contracts in `packages/agent/src/types.ts` are frozen after Task 1 — later tasks build against them, never rewrite them (changes need a Ruling).
- Vitest green before every commit; `npm run build` green before every push.
- Commit per task completion (review-clean only); push constantly to `local-transition`.

## Tasks
1. **Package scaffold + contracts + core move.** Create `packages/agent/` (package.json name `@rag-client/agent`, tsconfig, README, index exports). Move `src/lib/local/{chunk,embed,bm25,fuse,retrieve}.ts` + `src/lib/detect.ts` into it unchanged (pure move + import-path fix). Add `src/types.ts` with shared contracts: Chunk, Hit, Retrieval, Embedder, Store (see below), Parser, Generation, TierPolicy, EvalCase. Root app depends on workspace package; root imports updated. Tests moved + green.
   - Store interface: `putChunks(chunks, vectors)`, `searchDense(vec, k)`, `allChunks()`, `clear()`, `size()`.
   - Parser interface: `parse(file: File|Blob, name: string): Promise<{pages:{page,text}[], mime}>`.
   - Generation interface: `generate(prompt, context): AsyncGenerator<string>` + `isAvailable(): Promise<boolean>`.
2. **Store (Dexie + outbox).** `packages/agent/src/store.ts`: Dexie-backed Store (chunks table + vectors as Float32Array, outbox table with queued/flushed ops). Unit tests with fake-indexeddb? Dexie needs browser IDB — use `fake-indexeddb` npm package in tests. Must pass: persist/reload, outbox enqueue/flush, clear, 5k-chunk smoke timing logged.
3. **Parsing (pdf.js/mammoth/xlsx/pptx).** `packages/agent/src/parse.ts`: pdf.js text per page (`--- Page N ---` semantics via page tracking, lazy pages), mammoth docx raw text, dynamic-import xlsx (sheet name preserved), JSZip+DOMParser pptx slides+notes (slide# as page). Unit tests with generated fixtures (pdf via pdf-lib? use pdfjs-dist + a checked-in 2-page PDF fixture generated once via reportlab in /tmp — fixture bytes committed under packages/agent/testdata/). No canvas render in ingest path.
4. **Generation tier.** `packages/agent/src/generate.ts`: tier policy (Nano if readily → WebLLM cached → extractive fallback), strict grounded prompt builder, extractive composer (quote-only answers with [n] markers from hits, no-answer path), WebLLM loader with progress callback (lazy import, never bundled). Unit tests with fake engines covering: tier selection matrix, extractive citations correct, no-answer honesty, prompt contains grounding rules.
5. **App wiring.** Root app uses `@rag-client/agent`: local retrieve path in UI (tier badge, offline indicator, outbox flush on reconnect), library reads from local store when present, engine download progress UI. Build stays < 60KB initial. Existing API flows untouched and green (bench unaffected).
6. **Eval harness.** `packages/agent/eval/` (separate tsconfig, node-run): golden cases (leave carry-over, moss-beetle page 7, approval, refusal probe) run against local retrieve+extractive over a small checked-in corpus with REAL MiniLM embeddings (download at eval time, cached); asserts recall (expected doc/page in hits), citation page accuracy, no-answer correctness. Report to ledger. Must pass before merge.
7. **Final review + merge + deploy.** Whole-branch review, fix wave, merge `local-transition` → `main`, push, `wrangler deploy`, live smoke (assets + bench API path still 15/15).

## Task/file ownership (no overlaps)
- T1: packages/agent/* (new), root package.json/tsconfig/vite refs, moved tests.
- T2: packages/agent/src/store.ts + tests/store.test.ts only.
- T3: packages/agent/src/parse.ts + tests/parse.test.ts + testdata/* only.
- T4: packages/agent/src/generate.ts + tiers.ts + tests/generate.test.ts only.
- T5: root src/*, index.html (no packages/ edits except version bump if needed).
- T6: packages/agent/eval/* only.
