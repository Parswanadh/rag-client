import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildGroundedPrompt,
  composeExtractive,
  DEFAULT_WEBLLM_MODEL,
  ExtractiveEngine,
  NanoEngine,
  selectGenerationTier,
  WebLLMEngine,
} from "../src/generate";
import type { TierInfo } from "../src/detect";
import type { Chunk } from "../src/chunk";
import type { Hit } from "../src/retrieve";

const C = (id: string, text: string, page: number | null = 1, docId = "doc-a"): Chunk => ({
  id,
  docId,
  page,
  section: null,
  text,
  hash: id,
  version: 1,
});

const H = (chunk: Chunk, score = 1): Hit => ({ chunk, score, lane: "both" });

/** Sentences of an extractive answer with citation markers/quotes stripped. */
function answerSentences(answer: string): string[] {
  const stripped = answer
    .replace(/\[\d+\]/g, " ")
    .replace(/[""]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("selectGenerationTier (injected detect signals, no hardware probing)", () => {
  it("nano-ready → nano", () => {
    const info: TierInfo = {
      tier: "nano",
      detail: "Chrome built-in Nano ready",
      webgpu: true,
      ramGB: 8,
      cores: 8,
      mobile: false,
    };
    const p = selectGenerationTier(info);
    expect(p.tier).toBe("nano");
    expect(p.reason.length).toBeGreaterThan(0);
  });
  it("webgpu desktop → webllm (cached)", () => {
    const info: TierInfo = {
      tier: "webllm",
      detail: "WebGPU + desktop-class RAM/CPU",
      webgpu: true,
      ramGB: 8,
      cores: 8,
      mobile: false,
    };
    const p = selectGenerationTier(info);
    expect(p.tier).toBe("webllm");
    expect(p.reason.length).toBeGreaterThan(0);
  });
  it("mobile below thresholds → extractive fallback (API preserved in reason)", () => {
    const info: TierInfo = {
      tier: "api",
      detail: "No WebGPU — API fallback",
      webgpu: false,
      ramGB: 2,
      cores: 4,
      mobile: true,
    };
    const p = selectGenerationTier(info);
    expect(p.tier).toBe("extractive");
    expect(p.reason).toMatch(/api/i);
  });
  it("no-gpu desktop → extractive fallback", () => {
    const info: TierInfo = {
      tier: "api",
      detail: "No WebGPU — API fallback",
      webgpu: false,
      ramGB: 16,
      cores: 8,
      mobile: false,
    };
    const p = selectGenerationTier(info);
    expect(p.tier).toBe("extractive");
  });
  it("unknown → extractive fallback", () => {
    const info: TierInfo = { tier: "unknown", detail: "?", webgpu: false, ramGB: 0, cores: 0, mobile: false };
    expect(selectGenerationTier(info).tier).toBe("extractive");
  });
});

describe("composeExtractive", () => {
  const hits = [
    H(C("c1", "Employees may carry over up to 5 unused leave days. Requests beyond 3 days need approval.", 7)),
    H(C("c2", "Sparrows gather at dawn near the riverbank.", 2), 0.5),
  ];
  it("quotes hits verbatim with [n] markers mapping to hits in order", () => {
    const r = composeExtractive(hits);
    expect(r.noAnswer).toBe(false);
    expect(r.answer).toContain("[1]");
    expect(r.answer).toContain("[2]");
    expect(r.citations).toEqual([
      { marker: "[1]", documentId: "doc-a", page: 7 },
      { marker: "[2]", documentId: "doc-a", page: 2 },
    ]);
  });
  it("is quote-only: every answer sentence is a substring of some hit text", () => {
    const r = composeExtractive(hits);
    const texts = hits.map((h) => h.chunk.text);
    for (const s of answerSentences(r.answer)) {
      expect(texts.some((t) => t.includes(s))).toBe(true);
    }
  });
  it("empty hits → honest no-answer mentioning insufficient grounded information", () => {
    const r = composeExtractive([]);
    expect(r.noAnswer).toBe(true);
    expect(r.citations).toEqual([]);
    expect(r.answer).toMatch(/insufficient grounded information/i);
  });
});

describe("buildGroundedPrompt", () => {
  it("contains grounding rules + numbered sources", () => {
    const hits = [H(C("c1", "Employees may carry over up to 5 unused leave days.", 7))];
    const p = buildGroundedPrompt("How many leave days carry over?", hits);
    expect(p).toMatch(/quote-only/i);
    expect(p).toMatch(/cite every claim/i);
    expect(p).toMatch(/outside knowledge/i);
    expect(p).toContain("[1]");
    expect(p).toContain("doc-a");
    expect(p).toMatch(/insufficient grounded information/i);
  });
});

describe("NanoEngine (node: API absent)", () => {
  it("isAvailable() is false without window.LanguageModel", async () => {
    expect(await new NanoEngine().isAvailable()).toBe(false);
  });
  it("generate() throws a clear unavailable error", async () => {
    const eng = new NanoEngine();
    await expect(async () => {
      const gen = eng.generate("q", "ctx");
      for await (const _ of gen) void _;
    }).rejects.toThrow(/unavailable/i);
  });
});

describe("ExtractiveEngine implements Generation", () => {
  it("isAvailable() is always true and generate() yields the composed answer", async () => {
    const hits = [H(C("c1", "Employees may carry over up to 5 unused leave days.", 7))];
    const eng = new ExtractiveEngine(hits);
    expect(await eng.isAvailable()).toBe(true);
    let out = "";
    for await (const chunk of eng.generate("How many days?", "")) out += chunk;
    expect(out).toContain("[1]");
    expect(out).toContain("carry over");
  });
});

describe("WebLLMEngine loader", () => {
  it("uses the documented default model and constructs without downloading", async () => {
    expect(DEFAULT_WEBLLM_MODEL).toBe("Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
    const eng = new WebLLMEngine();
    expect(eng.model).toBe(DEFAULT_WEBLLM_MODEL);
    expect(await eng.isAvailable()).toBe(false); // not loaded → no network touched
  });
  it("generate() before load() throws a clear not-loaded error (no network)", async () => {
    const eng = new WebLLMEngine({ model: DEFAULT_WEBLLM_MODEL });
    await expect(async () => {
      const gen = eng.generate("q", "ctx");
      for await (const _ of gen) void _;
    }).rejects.toThrow(/not loaded/i);
  });
  it("web-llm is lazily imported (no static import at module load)", async () => {
    const src = await readFile(new URL("../src/generate.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import\s+.*web-llm/m);
    expect(src).not.toMatch(/from\s+["']@mlc-ai\/web-llm["']/);
    expect(src).toContain('await import("@mlc-ai/web-llm")');
  });
});
