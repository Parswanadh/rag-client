/** API-fallback path: talks to the stable Ragz backend through the same
 * key-scoped external API as the current mobile PWA. No secrets in bundle —
 * sign-in swaps ID+password for a workspace key kept in sessionStorage.
 */
const API = "https://rag.parswanadh.dev";

export function getKey(): string {
  return sessionStorage.getItem("rz_key") ?? "";
}

export async function login(id: string, password: string): Promise<{ workspace: string }> {
  const identifier = id.includes("@") ? id : `${id}@ragz.local`;
  const r = await fetch(`${API}/external/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!r.ok) throw new Error(r.status === 401 ? "wrong ID or password" : `HTTP ${r.status}`);
  const d = await r.json();
  sessionStorage.setItem("rz_key", d.api_key);
  return { workspace: d.workspace_name };
}

export interface DoneMsg {
  answer: string;
  citations: { marker: number; document_id: string; page: number | null; section?: string | null }[];
  no_answer: boolean;
  grounding: string;
  conversation_id: string;
  timings?: { ttft_ms: number; total_ms: number };
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

export interface Doc {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  page_count: number | null;
  version: number;
  status: string;
  error: string | null;
  created_at: string;
}

export interface TocEntry {
  section: string | null;
  page: number;
}

export interface SearchHit {
  document_id: string;
  page: number;
  chunk_index: number;
  text: string;
  score: number;
  section: string | null;
  version: number;
}

export async function streamChat(
  question: string,
  conversationId: string | null,
  onDelta: (text: string) => void,
  laya = false,
): Promise<DoneMsg> {
  const r = await fetch(`${API}/external/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey()}` },
    body: JSON.stringify({ question, conversation_id: conversationId, laya: laya || undefined }),
  });
  if (r.status === 401) throw new Error("signed out — sign in again");
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done: DoneMsg | null = null;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!block.startsWith("data:")) continue;
      const evt = JSON.parse(block.slice(5));
      if (evt.type === "delta") onDelta(evt.text);
      else if (evt.type === "done") done = evt as DoneMsg;
      else if (evt.type === "error") throw new Error(evt.detail ?? "stream failed");
    }
    if (eof || done) break;
  }
  if (!done) throw new Error("stream ended early");
  return done;
}

const keyH = () => ({ Authorization: `Bearer ${getKey()}` });

const enc = (id: string): string => {
  if (typeof id !== "string" || !id) throw new Error("bad document id");
  return encodeURIComponent(id);
};

export async function getModels(): Promise<{ id: string }[]> {
  const r = await fetch(`${API}/external/v1/openai/models`, { headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).data;
}

export async function listDocs(): Promise<Doc[]> {
  const r = await fetch(`${API}/external/v1/documents`, { headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function uploadDoc(file: File): Promise<Doc> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`${API}/external/v1/documents`, { method: "POST", headers: keyH(), body: fd });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function docStatus(id: string): Promise<{ id: string; status: string; error: string | null }> {
  const r = await fetch(`${API}/external/v1/documents/${enc(id)}/status`, { headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function docFile(id: string): Promise<Blob> {
  const r = await fetch(`${API}/external/v1/documents/${enc(id)}/file`, { headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}

export async function docToc(id: string): Promise<TocEntry[]> {
  const r = await fetch(`${API}/external/v1/documents/${enc(id)}/toc`, { headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function docSearch(id: string, q: string, limit = 8): Promise<{ no_answer: boolean; chunks: SearchHit[] }> {
  const n = Math.min(20, Math.max(1, Math.floor(limit) || 8));
  const r = await fetch(
    `${API}/external/v1/documents/${enc(id)}/search?q=${encodeURIComponent(q)}&limit=${n}`,
    { headers: keyH() },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function deleteDoc(id: string): Promise<void> {
  const r = await fetch(`${API}/external/v1/documents/${enc(id)}`, { method: "DELETE", headers: keyH() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
