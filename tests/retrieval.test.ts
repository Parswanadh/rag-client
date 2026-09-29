import { describe, expect, it } from "vitest";
import { chunkDocument } from "../src/lib/local/chunk";
import { HashEmbedder } from "../src/lib/local/embed";
import { buildIndex, CachedIndex, score } from "../src/lib/local/bm25";
import { rrf } from "../src/lib/local/fuse";import { indexCorpus, retrieve } from "../src/lib/local/retrieve";
import type { Chunk } from "../src/lib/local/chunk";

const C = (id: string, text: string, page: number | null = 1, section: string | null = null): Chunk => ({
  id,
  docId: "d",
  page,
  section,
  text,
  hash: id,
  version: 1,
});

describe("chunker", () => {
  it("splits long text and keeps H1>H2 trails with clean text", async () => {
    const chunks = await chunkDocument("d", [
      { page: 1, text: "# Beetles\n\n" + "beetle facts. ".repeat(120) + "\n\n## Ladybirds\n\nspots." },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1000)).toBe(true);
    const lady = chunks.find((c) => c.text.includes("spots."));
    expect(lady?.section).toBe("Beetles > Ladybirds");
    expect(lady?.text.startsWith("Beetles")).toBe(false); // no section pollution
    expect(chunks.every((c) => c.page === 1 && c.version === 1)).toBe(true);
  });
  it("splits a single over-long paragraph at word boundaries", async () => {
    const chunks = await chunkDocument("d", [{ page: null, text: "word ".repeat(500) }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1000)).toBe(true);
    expect(chunks[0].page).toBeNull();
  });
  it("carries overlap between consecutive chunks", async () => {
    const words = Array.from({ length: 300 }, (_, i) => `tok${i}`);
    const chunks = await chunkDocument("d", [{ page: 1, text: words.join(" ") }]);
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0].text.split(/\s+/).slice(-5);
    const head = chunks[1].text;
    expect(tail.every((w) => head.includes(w))).toBe(true);
  });
  it("carries section trail across a heading-only page", async () => {
    const chunks = await chunkDocument("d", [
      { page: 1, text: "# Beetles" },
      { page: 2, text: "beetle facts here." },
    ]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].section).toBe("Beetles");
    expect(chunks[0].page).toBe(2);
  });
});

describe("bm25", () => {
  it("ranks exact-term docs first and stems plurals", () => {
    const idx = buildIndex(["carry over five days", "unrelated sparrows gather", "carry over policies"]);
    const s = score(idx, "carries over");
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[2]).toBeGreaterThan(s[1]);
  });
  it("CachedIndex agrees with one-shot buildIndex", () => {
    const texts = ["carry over five days", "unrelated sparrows gather"];
    const a = score(buildIndex(texts), "carry");
    const b = new CachedIndex(texts).score("carry");
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
  });
});

describe("rrf", () => {
  it("rewards consensus across lanes", () => {
    const f = rrf([["a", "b", "c"], ["b", "a", "c"]]);
    expect(f.get("a")).toBeGreaterThan(f.get("c")!);
    expect(f.get("b")).toBeGreaterThan(f.get("c")!);
  });
  it("later ranks contribute less", () => {
    const f = rrf([["a", "b"]]);
    expect(f.get("a")).toBeGreaterThan(f.get("b")!);
  });
});

describe("hybrid retrieve", () => {
  const corpus = [
    C("c1", "Employees may carry over up to 5 unused leave days.", 1, "Leave"),
    C("c2", "Sparrows gather at dawn near the riverbank.", 2, null),
    C("c3", "Leave requests beyond 3 days need manager approval.", 3, "Leave"),
  ];
  async function indexed() {
    const e = new HashEmbedder();
    const m = new Map<string, number[]>();
    (await e.embed(corpus.map((c) => c.text))).forEach((v, i) => m.set(corpus[i].id, v));
    return indexCorpus(corpus, m, e.dim);
  }
  it("finds the grounded chunk with section intact", async () => {
    const e = new HashEmbedder();
    const r = await retrieve("how many leave days carry over?", await indexed(), e, { minScore: 0 });
    expect(r.noAnswer).toBe(false);
    expect(r.hits[0].chunk.id).toBe("c1");
    expect(r.hits[0].chunk.section).toBe("Leave");
    expect(r.hits[0].chunk.page).toBe(1);
  });
  it("gates on dense cosine with controlled vectors", async () => {
    const e = new HashEmbedder(2);
    const far = new Map([
      ["c1", [1, 0]],
      ["c2", [1, 0]],
      ["c3", [1, 0]],
    ]);
    const idx = indexCorpus(corpus, far, 2);
    // query embeds to [0,1]-ish by construction of HashEmbedder? No:
    // control fully — stub embedder returning fixed orthogonal query vector.
    const stub = { dim: 2, embed: async () => [[0, 1]] };
    const r = await retrieve("anything", idx, stub, { minScore: 0.5 });
    expect(r.noAnswer).toBe(true);
    expect(r.hits).toEqual([]);
  });
  it("fail-closed on missing vectors", async () => {
    const e = new HashEmbedder();
    expect(() => indexCorpus(corpus, new Map(), e.dim)).toThrow(/missing.*vector/);
  });
  it("fail-closed on dim mismatch", async () => {
    const e = new HashEmbedder();
    const m = new Map([["c1", [1, 0]], ["c2", [1, 0]], ["c3", [1, 0]]]);
    await expect(retrieve("x", indexCorpus(corpus, m, 2), e)).rejects.toThrow();
  });
  it("returns empty on empty corpus", async () => {
    const e = new HashEmbedder();
    const idx = indexCorpus([], new Map(), e.dim);
    expect((await retrieve("x", idx, e)).noAnswer).toBe(true);
  });
});
