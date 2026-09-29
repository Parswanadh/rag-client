/** Local-engine stubs (Stages 1-3 build these out).
 * Stage 1: transformers.js embeddings + Dexie store + pdf.js parsing (Web Worker).
 * Stage 2: WebLLM generation tier + Chrome Nano path.
 * Stage 3: sqlite-vec/OPFS + server sync protocol.
 * Each stub throws a staged error so UI can show "coming in stage N".
 */
export const STAGE = 0;

export async function loadLocalModel(): Promise<never> {
  throw new Error("local generation lands in Stage 2 (WebLLM / Nano)");
}

export async function embedLocal(_texts: string[]): Promise<never> {
  throw new Error("local embeddings land in Stage 1 (transformers.js)");
}

export async function localSearch(_query: string): Promise<never> {
  throw new Error("on-device search lands in Stage 1 (Dexie + hybrid BM25)");
}

export async function parseLocal(_file: File): Promise<never> {
  throw new Error("in-browser parsing lands in Stage 1 (pdf.js/mammoth)");
}
