/** Dexie-backed persistent vector store + sync outbox.
 *
 * - `chunks` table keyed by Chunk.id; each row is the Chunk plus its dense
 *   vector stored as a Float32Array (IndexedDB structured-cloneable).
 * - `outbox` table (`++id` auto key) of `{op: "put"|"delete", payload,
 *   queuedAt}` rows for later backend sync, with explicit
 *   `enqueue` / `flush(handler)` / `pending` helpers.
 *
 * NOTE: `DexieStore implements Store` from `./types` (frozen contract:
 * sync-or-async methods, `searchDense` returns `{id, score}[]`).
 */
import Dexie, { type Table } from "dexie";
import type { Chunk } from "./chunk";
import type { Store } from "./types";

/** Sync outbox operation kinds. */
export type OutboxOp = "put" | "delete";

/** One queued outbox row. `id` is auto-assigned by IndexedDB on add. */
export interface OutboxEntry {
  id?: number;
  op: OutboxOp;
  payload: unknown;
  queuedAt: number;
}

/** Chunk row as persisted: Chunk fields + dense vector as Float32Array. */
export interface ChunkRow extends Chunk {
  vector: Float32Array;
}

/** Handler invoked once per outbox row by `flush`, in queue order. */
export type OutboxHandler = (op: OutboxOp, payload: unknown) => void | Promise<void>;

function stripVector(row: ChunkRow): Chunk {
  const { vector: _dropped, ...chunk } = row;
  return chunk;
}

/** Cosine over a plain query vector and a stored Float32Array.
 * NaN-free 0 on empty/dim-mismatched input (mirrors `cosine` in embed.ts,
 * which cannot type a Float32Array as `readonly number[]`). */
function cosineStored(q: readonly number[], v: Float32Array): number {
  if (q.length === 0 || q.length !== v.length) return 0;
  let dot = 0;
  for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
  return dot;
}

export class DexieStore extends Dexie implements Store {
  private chunks!: Table<ChunkRow, string>;
  private outbox!: Table<OutboxEntry, number>;

  constructor(dbName = "rag-client") {
    super(dbName);
    this.version(1).stores({
      chunks: "&id",
      outbox: "++id",
    });
  }

  /** Upsert chunks with their dense vectors. Fail-closed: every chunk must
   * have a vector and all vectors must share one non-zero dim. */
  async putChunks(chunks: Chunk[], vectors: Map<string, number[]>): Promise<void> {
    if (chunks.length === 0) return;
    let dim = -1;
    for (const c of chunks) {
      const v = vectors.get(c.id);
      if (!v) throw new Error(`missing vector for chunk ${c.id}`);
      if (dim < 0) dim = v.length;
      else if (v.length !== dim) throw new Error(`dim-mismatched vector for chunk ${c.id}`);
    }
    if (dim <= 0) throw new Error("vectors must be non-empty");
    const rows: ChunkRow[] = chunks.map((c) => ({
      ...c,
      vector: Float32Array.from(vectors.get(c.id) as number[]),
    }));
    await this.chunks.bulkPut(rows);
  }

  /** Brute-force dense top-k by cosine; ties broken by chunk id ascending
   * for determinism. Dim-mismatched rows score 0 (never NaN). */
  async searchDense(vec: number[], k: number): Promise<{ id: string; score: number }[]> {
    if (k <= 0) return [];
    const rows = await this.chunks.toArray();
    return rows
      .map((r) => ({ id: r.id, score: cosineStored(vec, r.vector) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, k);
  }

  async allChunks(): Promise<Chunk[]> {
    const rows = await this.chunks.toArray();
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.map(stripVector);
  }

  /** Clear both the chunks and the outbox tables. */
  async clear(): Promise<void> {
    await this.transaction("rw", this.chunks, this.outbox, async () => {
      await this.chunks.clear();
      await this.outbox.clear();
    });
  }

  size(): Promise<number> {
    return this.chunks.count();
  }

  /** Queue one sync op; resolves with the auto-assigned outbox id. */
  enqueue(op: OutboxOp, payload: unknown): Promise<number> {
    return this.outbox.add({ op, payload, queuedAt: Date.now() });
  }

  /** Deliver queued ops to `handler` in FIFO order, deleting each row only
   * after its handler resolves. Stops at the first handler throw (failed
   * and later rows stay queued). Resolves with the count flushed. */
  async flush(handler: OutboxHandler): Promise<number> {
    const rows = await this.outbox.orderBy("id").toArray();
    let flushed = 0;
    for (const row of rows) {
      await handler(row.op, row.payload);
      await this.outbox.delete(row.id as number);
      flushed++;
    }
    return flushed;
  }

  /** Count of queued (unflushed) outbox rows. */
  pending(): Promise<number> {
    return this.outbox.count();
  }
}
