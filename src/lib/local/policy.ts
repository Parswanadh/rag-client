/** Task 5 app policy: pure, jsdom-less, safe for the initial bundle.
 *
 * Static imports are limited to type-only agent contracts plus the tiny
 * `generate` policy module (no embed/parse/store/retrieve — those pull
 * onnxruntime/pdfjs/Dexie into the bundle graph; see index.ts warning).
 * All persistence goes through an injectable StorageLike so unit tests run
 * in node without DOM.
 */
import type { TierInfo } from "@rag-client/agent/detect";
import { selectGenerationTier } from "@rag-client/agent/generate";

/** Local engine choice. `webllm` is returned ONLY after an explicit download
 * (`webllmLoaded`); otherwise the caller falls back to the extractive
 * composer — models are never auto-downloaded. */
export type LocalEngineKind = "nano" | "webllm" | "extractive";

export function resolveEngineKind(info: TierInfo, webllmLoaded: boolean): LocalEngineKind {
  const p = selectGenerationTier(info);
  if (p.tier === "nano") return "nano";
  if (p.tier === "webllm") return webllmLoaded ? "webllm" : "extractive";
  return "extractive";
}

/** Header badge. Toggle OFF (default) → API path; toggle ON → local
 * generation tier (Nano / WebLLM-local / Extractive). */
export function tierBadge(info: TierInfo | null, askLocal: boolean): string {
  if (!info) return "detecting compute…";
  if (!askLocal) return `API path · ${info.detail}`;
  const p = selectGenerationTier(info);
  if (p.tier === "nano") return `Nano · ${info.detail}`;
  if (p.tier === "webllm") return `WebLLM-local · ${info.detail}`;
  return `Extractive · ${info.detail}`;
}

/** Minimal storage surface (subset of DOM Storage). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function ambientStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* private mode / non-DOM */
  }
  return null;
}

const ASK_KEY = "rag-ask-local";
const DOCS_KEY = "rag-local-docs";
const TOMB_KEY = "rag-local-tombstones";

/** "Ask locally" toggle. Default OFF; only the literal "1" counts as ON. */
export function readAskLocal(s: StorageLike | null = ambientStorage()): boolean {
  try {
    return s?.getItem(ASK_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAskLocal(on: boolean, s: StorageLike | null = ambientStorage()): void {
  try {
    if (!s) return;
    if (on) s.setItem(ASK_KEY, "1");
    else s.removeItem(ASK_KEY);
  } catch {
    /* private mode: toggle simply won't persist */
  }
}

export function isOnline(): boolean {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      return navigator.onLine;
    }
  } catch {
    /* non-DOM: assume online */
  }
  return true;
}

/** Outbox banner copy. Null when nothing is queued. Flush only marks rows
 * flushed locally — server sync is Stage 3 (never invented here). */
export function outboxBanner(pending: number, online: boolean): string | null {
  if (!Number.isFinite(pending) || pending <= 0) return null;
  const n = Math.floor(pending);
  return online ? `${n} queued change(s) — tap Flush` : `${n} queued change(s) — offline`;
}

/** Locally-ingested document metadata (registry lives in localStorage;
 * chunk vectors live in the Dexie store). */
export interface LocalDocMeta {
  id: string;
  filename: string;
  size: number;
  pages: number;
  chunks: number;
  origin: "local";
  embedNote: string;
  addedAt: number;
}

function readJsonArray(key: string, s: StorageLike | null): unknown[] {
  try {
    const raw = s?.getItem(key);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function isLocalDocMeta(v: unknown): v is LocalDocMeta {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "string" && !!d.id && typeof d.filename === "string";
}

export function readLocalDocs(s: StorageLike | null = ambientStorage()): LocalDocMeta[] {
  return readJsonArray(DOCS_KEY, s).filter(isLocalDocMeta);
}

export function addLocalDoc(doc: LocalDocMeta, s: StorageLike | null = ambientStorage()): void {
  try {
    if (!s) return;
    const docs = readLocalDocs(s);
    const at = docs.findIndex((d) => d.id === doc.id);
    if (at >= 0) docs[at] = doc;
    else docs.push(doc);
    s.setItem(DOCS_KEY, JSON.stringify(docs));
  } catch {
    /* private mode */
  }
}

export function removeLocalDoc(id: string, s: StorageLike | null = ambientStorage()): void {
  try {
    if (!s) return;
    s.setItem(DOCS_KEY, JSON.stringify(readLocalDocs(s).filter((d) => d.id !== id)));
  } catch {
    /* private mode */
  }
}

/** Tombstoned local doc ids (local deletes hide chunks until Stage 3 sync). */
export function readTombstones(s: StorageLike | null = ambientStorage()): string[] {
  const out: string[] = [];
  for (const v of readJsonArray(TOMB_KEY, s)) {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function tombstoneDoc(id: string, s: StorageLike | null = ambientStorage()): void {
  try {
    if (!s || !id) return;
    const cur = readTombstones(s);
    if (!cur.includes(id)) s.setItem(TOMB_KEY, JSON.stringify([...cur, id]));
  } catch {
    /* private mode */
  }
}
