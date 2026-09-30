// Module-resolution hook for the Task 6 eval harness (no new dependencies).
//
// The agent sources use bundler-style extensionless relative imports
// (`./bm25`, `./embed`, …) which plain Node ESM — even with type stripping —
// cannot resolve. This hook maps those to their sibling `.ts` files so the
// harness exercises the REAL sources. Bare package imports
// (e.g. `@huggingface/transformers`) pass through untouched.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!path.extname(specifier)) {
      try {
        const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      } catch {
        // Fall through to default resolution on any unexpected shape.
      }
    }
  }
  return nextResolve(specifier, context);
}
