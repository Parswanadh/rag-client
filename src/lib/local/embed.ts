/** Embedder interface. Real path (Stage 1): transformers.js ONNX
 * (`snowflake-arctic-embed-xs` q8, lazy import so the base bundle stays tiny).
 * HashEmbedder: deterministic fallback for tests/offline — NOT for quality.
 */
export interface Embedder {
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Deterministic char-trigram hashing embedder (unit-test / offline stand-in). */
export class HashEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 384) {
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dim).fill(0);
      const toks = tokenize(t);
      for (const tok of toks) {
        for (let i = 0; i < tok.length; i++) {
          const tri = tok.slice(i, i + 3);
          let h = 2166136261;
          for (const c of tri) {
            h ^= c.charCodeAt(0);
            h = Math.imul(h, 16777619);
          }
          v[Math.abs(h) % this.dim] += 1;
        }
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

/** Real ONNX embedder (lazy — import only when a local tier is chosen). */
export class TransformersEmbedder implements Embedder {
  readonly dim = 384;
  private pipe: unknown = null;
  private loading: Promise<unknown> | null = null;
  private model: string;
  constructor(model = "Xenova/all-MiniLM-L6-v2") {
    this.model = model;
  }
  private async load() {
    if (!this.pipe) {
      this.loading ??= import("@huggingface/transformers").then(async (m) => {
        const pipe = await (m as { pipeline: Function }).pipeline("feature-extraction", this.model, {
          dtype: "q8",
          pooling: "mean",
          normalize: true,
        });
        this.pipe = pipe;
        return pipe;
      });
      await this.loading;
    }
    return this.pipe as (t: string[], o: object) => Promise<{ tolist(): number[][] }>;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}
