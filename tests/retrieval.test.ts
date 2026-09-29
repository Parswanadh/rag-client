import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/lib/local/chunk";
import { HashEmbedder } from "../src/lib/local/embed";
import { buildIndex, score } from "../src/lib/local/bm25";
import { normalize, proximity, rrf } from "../src/lib/local/fuse";
import { retrieve } from "../src/lib/local/retrieve";
import type { Chunk } from "../src/lib/local/chunk";

const C = (id: string, text: string, page = 1, section: string | null = null): Chunk => ({
  id,
  docId: "d",
  page,
  section,
  text,
  hash: id,
});

describe("chunker", () => {
  it("splits long text and keeps headings as sections", async () => {
    const chunks = await chunkDocument("d", [
      { page: 1, text: "# Beetles\n\n" + "beetle facts. ".repeat(120) + "\n\n# Moths\n\nmoth facts." },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.section === "Beetles")).toBe(true);
    expect(chunks.some((c) => c.section === "Moths")).toBe(true);
    expect(chunks.every((c) => c.hash.length === 64)).toBe(true);
  });
});

describe("bm25", () => {
  it("ranks exact-term docs first and stems plurals", () => {
    const idx = buildIndex(["carry over five days", "unrelated sparrows gather", "carry over policies"]);
    const s = score(idx, "carries over");
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[2]).toBeGreaterThan(s[1]);
  });
});

describe("rrf", () => {
  it("rewards consensus across lanes", () => {
    const f = rrf([["a", "b", "c"], ["b", "a", "c"]]);
    expect(f.get("a")).toBeGreaterThan(f.get("c")!);
    expect(f.get("b")).toBeGreaterThan(f.get("c")!);
  });
  it("normalize maps best to 1", () => {
    expect(normalize(new Map([["a", 2], ["b", 4]])).get("b")).toBe(1);
  });
  it("proximity counts term overlap", () => {
    expect(proximity("carry over five days", ["carry", "over", "zzz"])).toBeCloseTo(2 / 3);
  });
});

describe("hybrid retrieve", () => {
  const corpus = [
    C("c1", "Employees may carry over up to 5 unused leave days.", 1, "Leave"),
    C("c2", "Sparrows gather at dawn near the riverbank.", 2, null),
    C("c3", "Leave requests beyond 3 days need manager approval.", 3, "Leave"),
  ];
  async function vecs() {
    const e = new HashEmbedder();
    const m = new Map<string, number[]>();
    (await e.embed(corpus.map((c) => c.text))).forEach((v, i) => m.set(corpus[i].id, v));
    return { e, m };
  }
  it("finds the grounded chunk with section intact", async () => {
    const { e, m } = await vecs();
    const r = await retrieve("how many leave days carry over?", corpus, m, e, { minScore: 0 });
    expect(r.noAnswer).toBe(false);
    expect(r.hits[0].chunk.id).toBe("c1");
    expect(r.hits[0].chunk.section).toBe("Leave");
    expect(r.hits[0].chunk.page).toBe(1);
  });
  it("says no-answer when nothing is close", async () => {
    const { e, m } = await vecs();
    const r = await retrieve("quantum chromodynamics Lagrangian", corpus, m, e, { minScore: 0.99 });
    expect(r.noAnswer).toBe(true);
    expect(r.hits).toEqual([]);
  });
  it("returns empty on empty corpus", async () => {
    const { e } = await vecs();
    expect((await retrieve("x", [], new Map(), e)).noAnswer).toBe(true);
  });
});
