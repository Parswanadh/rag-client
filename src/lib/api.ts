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
  citations: { marker: number; document_id: string; page: number | null }[];
  no_answer: boolean;
  grounding: string;
  conversation_id: string;
  timings?: { ttft_ms: number; total_ms: number };
}

export async function streamChat(
  question: string,
  conversationId: string | null,
  onDelta: (text: string) => void,
): Promise<DoneMsg> {
  const r = await fetch(`${API}/external/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey()}` },
    body: JSON.stringify({ question, conversation_id: conversationId }),
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
