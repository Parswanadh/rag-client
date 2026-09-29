/** Embedder interface. Real path: transformers.js ONNX (MiniLM default,
 * verified 0.81 related / 0.05 unrelated), lazy-imported so the base bundle
 * stays tiny. HashEmbedder: deterministic stand-in for unit tests ONLY.
 */
export interface Embedder {
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

interface FeaturePipe {
  (texts: string[], opts: Record<string, unknown>): Promise<{ tolist(): number[][] }>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Deterministic char-trigram hashing embedder (unit tests only). */
export class HashEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 384) {
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of tokenize(t)) {
        for (let i = 0; i < tok.length; i++) {
          let h = 2166136261;
          for (const c of tok.slice(i, i + 3)) {
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
  private pipe: FeaturePipe | null = null;
  private loading: Promise<FeaturePipe> | null = null;
  private model: string;
  constructor(model = "Xenova/all-MiniLM-L6-v2") {
    this.model = model;
  }
  async isLoaded(): Promise<boolean> {
    return this.pipe !== null;
  }
  private load(): Promise<FeaturePipe> {
    this.loading ??= import("@huggingface/transformers").then(async (m) => {
      const mod = m as unknown as {
        pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<FeaturePipe>;
      };
      const pipe = await mod.pipeline("feature-extraction", this.model, {
        dtype: "q8",
        pooling: "mean",
        normalize: true,
      });
      this.pipe = pipe;
      return pipe;
    });
    return this.loading;
  }
  async embed(texts: string[], batchSize = 32): Promise<number[][]> {
    const pipe = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const r = await pipe(texts.slice(i, i + batchSize), { pooling: "mean", normalize: true });
      out.push(...r.tolist());
    }
    return out;
  }
}

/** Cosine over equal-length normalized vectors. Returns NaN-free 0 when
 * either side is missing/mismatched — callers MUST pre-validate instead. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Fail-closed vector check: every chunk must have a dim-matching vector. */
export function assertVectors(ids: string[], vectors: Map<string, number[]>, dim: number): void {
  for (const id of ids) {
    const v = vectors.get(id);
    if (!v || v.length !== dim) throw new Error(`missing or dim-mismatched vector for chunk ${id}`);
  }
}
