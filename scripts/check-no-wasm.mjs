#!/usr/bin/env node
/** Build guard: fail if any `.wasm` file lands in `dist/`.
 *
 * Context: Rollup follows the lazy `import("@huggingface/transformers")` in
 * `packages/agent/src/embed.ts` during graph construction and emits
 * onnxruntime's ~26.9 MB `ort-wasm` asset even when all of that JS is
 * tree-shaken away. The file is unreferenced by the app, yet `wrangler
 * deploy` uploads the whole `dist/` directory — and at ~25.6 MiB it exceeds
 * Cloudflare's 25 MiB individual-file static-asset limit, breaking deploys.
 * App code must import the package via narrow subpaths
 * (`@rag-client/agent/detect`, …) so `embed.ts` never enters the bundle
 * graph; this guard makes any regression (e.g. someone importing the package
 * index from app code) fail the build loudly instead of silently.
 *
 * Zero dependencies; run via `npm run guard` (chained into `npm run build`).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".wasm")) out.push(p);
  }
}

let found;
try {
  found = [];
  walk(dist, found);
} catch (e) {
  console.error(`guard: cannot scan dist/ (${e.message}) — did vite build run?`);
  process.exit(1);
}

if (found.length) {
  console.error(`guard: FAIL — ${found.length} .wasm file(s) in dist/ (unreferenced wasm breaks Cloudflare deploys):`);
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}
console.log("guard: ok — no .wasm in dist/");
