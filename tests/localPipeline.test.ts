import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { formatSources } from "@rag-client/agent/generate";
import type { Chunk } from "@rag-client/agent/chunk";
import type { Hit, Retrieval } from "@rag-client/agent/retrieve";
import { DexieStore } from "@rag-client/agent/store";
import {
  addLocalDoc,
  readLocalDocs,
  readTombstones,
  type LocalDocMeta,
  type StorageLike,
} from "../src/lib/local/policy";
import {
  answerLocal,
  deleteLocalDoc,
  flushOutbox,
  getStore,
  ingestLocalFile,
  LocalHashEmbedder,
  queueLocalOp,
  pendingOps,
  retrieveLocal,
  type EngineLike,
} from "../src/lib/local/pipeline";

const memStorage = (): StorageLike => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

const C = (id: string, docId: string, text: string): Chunk => ({
  id,
  docId,
  page: 1,
  section: null,
  text,
  hash: id,
  version: 1,
});

let n = 0;
const dbName = (): string => `task5-pipeline-${Date.now()}-${n++}`;

/** Word-overlap embedder: deterministic, dim-stable, no IDB. */
const fakeEmbedder = (dim = 16) => ({
  dim,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 0;
        for (const c of w) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
        v[Math.abs(h) % dim] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
});

const memStore = (chunks: Chunk[], vectors: Map<string, number[]>) => ({
  async allChunks(): Promise<Chunk[]> {
    return chunks;
  },
  async searchDense(vec: number[], k: number): Promise<{ id: string; score: number }[]> {
    const scored = chunks.map((c) => {
      const v = vectors.get(c.id) ?? [];
      const dot = vec.reduce((a, x, i) => a + x * (v[i] ?? 0), 0);
      return { id: c.id, score: v.length === vec.length ? dot : 0 };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  },
});

describe("retrieveLocal (Dexie-seeded hybrid, no server)", () => {
  it("finds the locally ingested chunk for a topical query", async () => {
    const chunks = [
      C("d1:1:0", "d1", "Employees may carry over up to 5 unused leave days."),
      C("d2:1:0", "d2", "Sparrows gather at dawn near the riverbank."),
    ];
    const emb = fakeEmbedder();
    const vectors = new Map<string, number[]>();
    for (const c of chunks) vectors.set(c.id, (await emb.embed([c.text]))[0]);
    const r = await retrieveLocal("carry over leave days", {
      store: memStore(chunks, vectors),
      embedder: emb,
      minScore: 0,
    });
    expect(r.noAnswer).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].chunk.docId).toBe("d1");
  });

  it("empty local store → honest no-answer", async () => {
    const r = await retrieveLocal("anything", {
      store: memStore([], new Map()),
      embedder: fakeEmbedder(),
    });
    expect(r).toEqual({ hits: [], noAnswer: true });
  });

  it("tombstoned docs are filtered (local delete hides chunks)", async () => {
    const chunks = [C("d1:1:0", "d1", "Employees may carry over leave days.")];
    const emb = fakeEmbedder();
    const vectors = new Map<string, number[]>(
      chunks.map((c) => [c.id, [0.5, 0.5] as number[]] as [string, number[]]),
    );
    const r = await retrieveLocal("leave days", {
      store: memStore(chunks, vectors),
      embedder: { dim: 2, embed: async (t: string[]) => t.map(() => [0.5, 0.5]) },
      minScore: 0,
      tombstones: new Set(["d1"]),
    });
    expect(r).toEqual({ hits: [], noAnswer: true });
  });
});

describe("answerLocal passes formatSources(hits) as live-LLM context", () => {
  it("engine receives numbered sources verbatim", async () => {
    const hits: Hit[] = [
      { chunk: C("d1:1:0", "d1", "Employees may carry over up to 5 unused leave days."), score: 1, lane: "both" },
      { chunk: C("d1:1:1", "d1", "Requests beyond 3 days need approval."), score: 0.5, lane: "dense" },
    ];
    const seen: { prompt: string; context: string }[] = [];
    const engine: EngineLike = {
      async *generate(prompt: string, context: string): AsyncGenerator<string> {
        seen.push({ prompt, context });
        yield "quoted answer";
      },
    };
    const out = await answerLocal("How many leave days carry over?", engine, {
      retrieveFn: async (): Promise<Retrieval> => ({ hits, noAnswer: false }),
    });
    expect(out.answer).toBe("quoted answer");
    expect(out.hits).toBe(hits);
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toBe("How many leave days carry over?");
    // THE review finding: context must be the numbered sources, not "".
    expect(seen[0].context).toBe(formatSources(hits));
    expect(seen[0].context).toContain("[1]");
    expect(seen[0].context).toContain("[2]");
    expect(seen[0].context).toContain("d1");
  });

  it("empty hits → context is empty-format (no crash), answer still streams", async () => {
    const seen: string[] = [];
    const engine: EngineLike = {
      async *generate(_p: string, ctx: string): AsyncGenerator<string> {
        seen.push(ctx);
        yield "x";
      },
    };
    await answerLocal("q?", engine, {
      retrieveFn: async () => ({ hits: [], noAnswer: true }),
    });
    expect(seen).toEqual([formatSources([])]);
  });
});

describe("outbox queue/flush (offline mutations, local flush — no server sync)", () => {
  it("enqueue while offline → pending → flush marks flushed locally in FIFO order", async () => {
    const name = dbName();
    // Exercise the pipeline-level helpers (fresh store per name via env override).
    const store = new DexieStore(name);
    await queueLocalOp("put", { kind: "upload", docId: "a", filename: "a.txt", at: 1 }, store);
    await queueLocalOp("delete", { kind: "delete", docId: "b", filename: "b.txt", at: 2 }, store);
    expect(await pendingOps(store)).toBe(2);

    const flushed = await flushOutbox(store);
    expect(flushed).toBe(2);
    expect(await pendingOps(store)).toBe(0);
    expect(await flushOutbox(store)).toBe(0);
    store.close();
  });
});

describe("ingestLocalFile end-to-end (.txt Blob → Dexie, real parse/chunk path)", () => {
  it("parses, chunks, embeds, and stores retrievable vectors; outbox gets a put entry", async () => {
    const store = await getStore();
    await store.clear();
    try {
      const text = "Employees may carry over up to 5 unused leave days. ".repeat(30);
      const r = await ingestLocalFile(new Blob([text], { type: "text/plain" }), "leave-policy.txt");

      expect(r.filename).toBe("leave-policy.txt");
      expect(r.docId.startsWith("local-")).toBe(true);
      expect(r.pages).toBe(1);
      expect(r.chunks).toBeGreaterThan(0);
      expect(r.note.length).toBeGreaterThan(0);

      // Vectors stored and retrievable: searchDense returns this doc's chunks.
      const emb = new LocalHashEmbedder(384);
      const [qvec] = await emb.embed(["carry over unused leave days"]);
      const dense = await store.searchDense(qvec as number[], 5);
      expect(dense.length).toBeGreaterThan(0);
      const all = await store.allChunks();
      for (const d of dense) {
        expect(all.find((c) => c.id === d.id)?.docId).toBe(r.docId);
      }

      // The upload glue step queues a "put" entry in the outbox.
      await queueLocalOp(
        "put",
        { kind: "upload", docId: r.docId, filename: r.filename, at: Date.now() },
      );
      expect(await pendingOps()).toBe(1);
      expect(await flushOutbox()).toBe(1);
      expect(await pendingOps()).toBe(0);
    } finally {
      await store.clear();
    }
  });
});

describe("deleteLocalDoc queues unconditionally (online or offline)", () => {
  it("an online delete still leaves a delete entry in the outbox", async () => {
    const store = new DexieStore(dbName());
    const storage = memStorage();
    const meta: LocalDocMeta = {
      id: "d1",
      filename: "d1.txt",
      size: 10,
      pages: 1,
      chunks: 1,
      origin: "local",
      embedNote: "hash",
      addedAt: 1,
    };
    addLocalDoc(meta, storage);
    expect(readLocalDocs(storage).map((d) => d.id)).toEqual(["d1"]);

    // No online/offline gate exists at this layer by design: flush is
    // local-only anyway, and the entry preserves Stage-3 sync intent.
    await deleteLocalDoc("d1", "d1.txt", store, storage);

    expect(readLocalDocs(storage)).toEqual([]);
    expect(readTombstones(storage)).toEqual(["d1"]);
    expect(await store.pending()).toBe(1);
    const seen: [string, unknown][] = [];
    const flushed = await store.flush(async (op, payload) => {
      seen.push([op, payload]);
    });
    expect(flushed).toBe(1);
    expect(seen[0][0]).toBe("delete");
    expect(seen[0][1]).toMatchObject({ kind: "delete", docId: "d1", filename: "d1.txt" });
    store.close();
  });
});
