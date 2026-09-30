import { describe, expect, it } from "vitest";
import type { TierInfo } from "@rag-client/agent/detect";
import {
  addLocalDoc,
  outboxBanner,
  readAskLocal,
  readLocalDocs,
  readTombstones,
  removeLocalDoc,
  resolveEngineKind,
  tierBadge,
  tombstoneDoc,
  writeAskLocal,
  type LocalDocMeta,
  type StorageLike,
} from "../src/lib/local/policy";

const info = (tier: TierInfo["tier"], detail = "d"): TierInfo => ({
  tier,
  detail,
  webgpu: tier !== "api",
  ramGB: 8,
  cores: 8,
  mobile: false,
});

const memStore = (): StorageLike => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

const doc = (id: string): LocalDocMeta => ({
  id,
  filename: `${id}.txt`,
  size: 10,
  pages: 1,
  chunks: 2,
  origin: "local",
  embedNote: "hash",
  addedAt: 1,
});

describe("tierBadge (detect signal + ask-locally toggle)", () => {
  it("null info → detecting copy", () => {
    expect(tierBadge(null, false)).toMatch(/detecting/i);
  });
  it("toggle OFF → API path regardless of tier", () => {
    expect(tierBadge(info("nano"), false)).toMatch(/^API/);
    expect(tierBadge(info("webllm"), false)).toMatch(/^API/);
    expect(tierBadge(info("api"), false)).toMatch(/^API/);
  });
  it("toggle ON + nano → Nano badge", () => {
    expect(tierBadge(info("nano"), true)).toMatch(/Nano/);
  });
  it("toggle ON + webllm → WebLLM-local badge", () => {
    expect(tierBadge(info("webllm"), true)).toMatch(/WebLLM-local/);
  });
  it("toggle ON + api/unknown → Extractive badge (local fallback, not server)", () => {
    expect(tierBadge(info("api"), true)).toMatch(/Extractive/);
    expect(tierBadge(info("unknown"), true)).toMatch(/Extractive/);
  });
});

describe("resolveEngineKind", () => {
  it("nano readily → nano (no download needed)", () => {
    expect(resolveEngineKind(info("nano"), false)).toBe("nano");
  });
  it("webllm without download → extractive (never auto-download)", () => {
    expect(resolveEngineKind(info("webllm"), false)).toBe("extractive");
  });
  it("webllm after explicit download → webllm", () => {
    expect(resolveEngineKind(info("webllm"), true)).toBe("webllm");
  });
  it("api/unknown → extractive composer", () => {
    expect(resolveEngineKind(info("api"), false)).toBe("extractive");
    expect(resolveEngineKind(info("unknown"), true)).toBe("extractive");
  });
});

describe("ask-locally persistence (default OFF)", () => {
  it("defaults to OFF when nothing stored", () => {
    expect(readAskLocal(memStore())).toBe(false);
  });
  it("round-trips ON then OFF", () => {
    const s = memStore();
    writeAskLocal(true, s);
    expect(readAskLocal(s)).toBe(true);
    writeAskLocal(false, s);
    expect(readAskLocal(s)).toBe(false);
  });
  it("ignores unexpected stored values (stays OFF)", () => {
    const s = memStore();
    s.setItem("rag-ask-local", "yes");
    expect(readAskLocal(s)).toBe(false);
  });
});

describe("outboxBanner", () => {
  it("null when nothing queued", () => {
    expect(outboxBanner(0, true)).toBeNull();
    expect(outboxBanner(0, false)).toBeNull();
  });
  it("offline → queued note (no flush action implied)", () => {
    expect(outboxBanner(2, false)).toMatch(/2.*queued/i);
  });
  it("online → flush prompt", () => {
    expect(outboxBanner(3, true)).toMatch(/3.*flush/i);
  });
});

describe("local doc registry + tombstones", () => {
  it("add/remove round-trip", () => {
    const s = memStore();
    expect(readLocalDocs(s)).toEqual([]);
    addLocalDoc(doc("a"), s);
    addLocalDoc(doc("b"), s);
    expect(readLocalDocs(s).map((d) => d.id)).toEqual(["a", "b"]);
    addLocalDoc(doc("a"), s); // upsert, no duplicate
    expect(readLocalDocs(s).map((d) => d.id)).toEqual(["a", "b"]);
    removeLocalDoc("a", s);
    expect(readLocalDocs(s).map((d) => d.id)).toEqual(["b"]);
  });
  it("tombstones accumulate removals", () => {
    const s = memStore();
    expect(readTombstones(s)).toEqual([]);
    tombstoneDoc("a", s);
    tombstoneDoc("a", s);
    expect(readTombstones(s)).toEqual(["a"]);
  });
});
