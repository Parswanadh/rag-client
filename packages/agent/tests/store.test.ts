import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DexieStore } from "../src/store";
import type { Chunk } from "../src/chunk";
import type { Store } from "../src/types";

const C = (id: string, text: string): Chunk => ({
  id,
  docId: "d",
  page: 1,
  section: null,
  text,
  hash: id,
  version: 1,
});

let n = 0;
const dbName = (): string => `test-store-${Date.now()}-${n++}`;

const unitVec = (dim: number, hot: number): number[] => {
  const v = new Array<number>(dim).fill(0);
  v[hot % dim] = 1;
  return v;
};

describe("DexieStore", () => {
  it("persists chunks+vectors across instances (reload)", async () => {
    const name = dbName();
    const s1 = new DexieStore(name);
    const chunks = [C("a", "alpha"), C("b", "beta"), C("c", "gamma")];
    const vectors = new Map(chunks.map((c, i) => [c.id, unitVec(4, i)] as [string, number[]]));
    await s1.putChunks(chunks, vectors);
    expect(await s1.size()).toBe(3);
    s1.close();

    // New instance on the same DB name still has the rows.
    const s2 = new DexieStore(name);
    // DexieStore satisfies the frozen Store contract (usable as Store).
    const asStore: Store = s2;
    expect(await asStore.size()).toBe(3);
    const all = await s2.allChunks();
    expect(all.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    const hits = await s2.searchDense(unitVec(4, 0), 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe("a");
    expect(hits[0].score).toBeCloseTo(1, 9);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    s2.close();
  });

  it("outbox enqueue/flush/pending", async () => {
    const s = new DexieStore(dbName());
    expect(await s.pending()).toBe(0);
    await s.enqueue("put", { id: "a" });
    await s.enqueue("delete", { id: "b" });
    expect(await s.pending()).toBe(2);

    const seen: unknown[] = [];
    const flushed = await s.flush(async (op, payload) => {
      seen.push([op, payload]);
    });
    expect(flushed).toBe(2);
    expect(seen).toEqual([
      ["put", { id: "a" }],
      ["delete", { id: "b" }],
    ]);
    expect(await s.pending()).toBe(0);
    expect(await s.flush(async () => {})).toBe(0);
    s.close();
  });

  it("clear empties chunks and outbox", async () => {
    const s = new DexieStore(dbName());
    await s.putChunks([C("a", "alpha")], new Map([["a", unitVec(4, 0)]]));
    await s.enqueue("put", { id: "a" });
    await s.clear();
    expect(await s.size()).toBe(0);
    expect(await s.allChunks()).toEqual([]);
    expect(await s.searchDense(unitVec(4, 0), 5)).toEqual([]);
    expect(await s.pending()).toBe(0);
    s.close();
  });

  it("5k-chunk put+search smoke (timing logged, no assert)", async () => {
    const s = new DexieStore(dbName());
    const N = 5000;
    const dim = 8;
    const chunks: Chunk[] = Array.from({ length: N }, (_, i) => C(`c${i}`, `chunk ${i}`));
    const vectors = new Map(chunks.map((c, i) => [c.id, unitVec(dim, i)] as [string, number[]]));

    const t0 = Date.now();
    await s.putChunks(chunks, vectors);
    const tPut = Date.now() - t0;
    console.log(`store smoke: putChunks(${N}, dim=${dim}) took ${tPut}ms`);

    expect(await s.size()).toBe(N);
    const q = unitVec(dim, 0);
    const t1 = Date.now();
    const hits = await s.searchDense(q, 5);
    const tSearch = Date.now() - t1;
    console.log(`store smoke: searchDense over ${N} took ${tSearch}ms`);
    expect(hits).toHaveLength(5);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
    s.close();
  });
});
