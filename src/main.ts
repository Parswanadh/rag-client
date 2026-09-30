import { detectTier } from "@rag-client/agent/detect";
import type { TierInfo } from "@rag-client/agent/detect";
import {
  addLocalDoc,
  isOnline,
  outboxBanner,
  readAskLocal,
  readLocalDocs,
  removeLocalDoc,
  resolveEngineKind,
  tierBadge,
  tombstoneDoc,
  writeAskLocal,
} from "./lib/local/policy";
import {
  deleteDoc,
  docFile,
  docSearch,
  docStatus,
  docToc,
  getKey,
  getModels,
  listDocs,
  login,
  streamChat,
  uploadDoc,
  type Doc,
} from "./lib/api";

const $ = (id: string) => document.getElementById(id)!;
let conv: string | null = null;
const docsById = new Map<string, Doc>();
let tierInfo: TierInfo | null = null;
const askLocalOn = (): boolean => {
  try {
    return (document.getElementById("askLocal") as HTMLInputElement)?.checked ?? readAskLocal();
  } catch {
    return readAskLocal();
  }
};

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"'/]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#x2F;" })[c] ?? c);
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const layaOn = () => (document.getElementById("layaToggle") as HTMLInputElement)?.checked ?? false;

async function init() {
  try {
    const t = await detectTier();
    tierInfo = t;
    $("tier").textContent = tierBadge(t, readAskLocal());
  } catch {
    $("tier").textContent = "API path";
  }
  if (getKey()) {
    showChat();
    void modelBadge();
  }
  ($("loginBtn") as HTMLButtonElement).onclick = async () => {    const id = ($("uid") as HTMLInputElement).value.trim();
    const pw = ($("pw") as HTMLInputElement).value;
    if (!id || !pw) return;
    try {
      await login(id, pw);
      ($("uid") as HTMLInputElement).value = "";
      ($("pw") as HTMLInputElement).value = "";
      showChat();
      void modelBadge();
      void refreshTierBadge();
    } catch (e) {
      alert(`Sign-in failed: ${(e as Error).message}`);
    }
  };
  ($("ask") as HTMLButtonElement).onclick = () => void ask();
  ($("signOut") as HTMLButtonElement).onclick = signOut;
  ($("q") as HTMLTextAreaElement).onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab ?? "chat");
  });
  ($("file") as HTMLInputElement).onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void upload(f);
  };
  ($("upBtn") as HTMLButtonElement).onclick = () => ($("file") as HTMLInputElement).click();
  ($("viewerClose") as HTMLButtonElement).onclick = closeViewer;
  ($("viewerSearchGo") as HTMLButtonElement).onclick = () => void viewerSearch();
  ($("viewerTocBtn") as HTMLButtonElement).onclick = () => void toggleToc();
  try {
    if (localStorage.getItem("laya_guard") === "1")
      (document.getElementById("layaToggle") as HTMLInputElement).checked = true;
  } catch { /* private mode */ }
  (document.getElementById("layaToggle") as HTMLInputElement).onchange = (e) => {
    try {
      localStorage.setItem("laya_guard", (e.target as HTMLInputElement).checked ? "1" : "0");
    } catch { /* private mode */ }
  };
  try {
    (document.getElementById("askLocal") as HTMLInputElement).checked = readAskLocal();
  } catch { /* private mode */ }
  (document.getElementById("askLocal") as HTMLInputElement).onchange = (e) => {
    writeAskLocal((e.target as HTMLInputElement).checked);
    void refreshTierBadge();
    void refreshModelRow();
  };
  ($("dlModel") as HTMLButtonElement).onclick = () => void downloadModel();
  ($("outboxFlush") as HTMLButtonElement).onclick = () => void flushOutboxUi();
  updateNet();
  window.addEventListener("online", () => {
    updateNet();
    void refreshOutbox();
  });
  window.addEventListener("offline", () => {
    updateNet();
    void refreshOutbox();
  });
  void refreshOutbox();
  void refreshModelRow();
}

/** Re-run tier detection (post-login) and repaint the badge. */
async function refreshTierBadge() {
  try {
    tierInfo = await detectTier();
    $("tier").textContent = tierBadge(tierInfo, askLocalOn());
  } catch {
    /* keep last badge */
  }
  void refreshModelRow();
}

/** Offline indicator from navigator.onLine. */
function updateNet() {
  const el = document.getElementById("netDot");
  if (!el) return;
  const online = isOnline();
  el.textContent = online ? "online" : "offline";
  el.classList.toggle("off", !online);
}

/** Show the model-download row only for the unloaded WebLLM local tier. */
async function refreshModelRow() {
  const row = document.getElementById("modelRow");
  if (!row) return;
  if (!askLocalOn() || tierInfo?.tier !== "webllm") {
    row.classList.add("hidden");
    return;
  }
  try {
    const { isWebLLMLoaded } = await import("./lib/local/pipeline");
    row.classList.toggle("hidden", isWebLLMLoaded());
  } catch {
    row.classList.remove("hidden");
  }
}

/** Explicit WebLLM download tap — the ONLY auto-free download path is none:
 * this handler is the sole trigger, with loader onProgress on the bar. */
async function downloadModel() {
  const msg = $("dlMsg") as HTMLElement;
  const bar = $("dlProg") as HTMLElement;
  const btn = $("dlModel") as HTMLButtonElement;
  btn.disabled = true;
  msg.textContent = "Downloading local model…";
  try {
    const { loadWebLLM } = await import("./lib/local/pipeline");
    await loadWebLLM((p) => {
      const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
      bar.style.width = `${pct}%`;
      msg.textContent = `Downloading local model… ${pct}%`;
    });
    msg.textContent = "Model ready — local answers use WebLLM.";
    bar.style.width = "100%";
  } catch (e) {
    msg.textContent = `Download failed: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
    void refreshModelRow();
  }
}

/** Outbox banner: pending local mutations, flushable on reconnect. */
async function refreshOutbox() {
  const bar = document.getElementById("outboxBar");
  const text = $("outboxText") as HTMLElement;
  if (!bar) return;
  let pending = 0;
  try {
    const { pendingOps } = await import("./lib/local/pipeline");
    pending = await pendingOps();
  } catch {
    pending = 0;
  }
  const copy = outboxBanner(pending, isOnline());
  bar.classList.toggle("hidden", copy === null);
  if (copy !== null) text.textContent = copy;
}

async function flushOutboxUi() {
  try {
    const { flushOutbox } = await import("./lib/local/pipeline");
    const n = await flushOutbox();
    ($("outboxText") as HTMLElement).textContent = n ? `Flushed ${n} locally.` : "Nothing queued.";
  } catch (e) {
    ($("outboxText") as HTMLElement).textContent = `Flush failed: ${(e as Error).message}`;
  }
  setTimeout(() => void refreshOutbox(), 1500);
  void refreshOutbox();
}

function showChat() {
  $("loginPane").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  $("signOut").classList.remove("hidden");
  showTab("chat");
}

function signOut() {
  sessionStorage.removeItem("rz_key");
  conv = null;
  closeViewer();
  ($("app") as HTMLElement).classList.add("hidden");
  ($("composer") as HTMLElement).classList.add("hidden");
  ($("signOut") as HTMLElement).classList.add("hidden");
  ($("loginPane") as HTMLElement).classList.remove("hidden");
  ($("thread") as HTMLElement).innerHTML = "";
}

function showTab(name: string) {
  for (const t of ["chat", "lib"]) {
    document.getElementById(`pane-${t}`)?.classList.toggle("hidden", t !== name);
    document.querySelector(`#tabs button[data-tab="${t}"]`)?.classList.toggle("on", t === name);
  }
  if (name === "lib") void loadDocs();
}

async function modelBadge() {
  if (askLocalOn()) return; // local badge owns the header while Ask-locally is on
  try {
    const m = await getModels();
    if (m.length) $("tier").textContent = `API path · ${m[0].id}`;
  } catch { /* quiet */ }
}

async function ask() {
  const box = $("q") as HTMLTextAreaElement;
  const text = box.value.trim();
  if (!text) return;
  box.value = "";
  if (askLocalOn()) {
    await askLocalFlow(text);
    return;
  }
  const thread = $("thread");
  thread.insertAdjacentHTML("beforeend", `<div class="msg-q"><span>${esc(text)}</span></div>`);
  const mine = document.createElement("div");
  mine.className = "msg-a";
  mine.innerHTML = `<span>Thinking…</span>`;
  thread.appendChild(mine);
  const t0 = performance.now();
  let acc = "";
  try {
    const done = await streamChat(
      text,
      conv,
      (d) => {
        acc += d;
        mine.innerHTML = `<p>${esc(acc)}</p>`;
      },
      layaOn(),
    );
    conv = done.conversation_id;
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    const tt = done.timings ? (done.timings.ttft_ms / 1000).toFixed(1) : "?";
    const cites = (done.citations ?? [])
      .map((c) => {
        const marker = num(c.marker, 0);
        const page = c.page === null ? null : num(c.page, 1);
        const docId = str(c.document_id);
        if (!docId) return "";
        return `<button class="cite" data-doc="${esc(docId)}" data-page="${page ?? 1}">[${marker}] p.${page ?? "?"} · ${esc(docId.slice(0, 8))}</button>`;
      })
      .join("");
    mine.innerHTML =
      `<p>${esc(done.answer)}</p>` +
      (done.no_answer ? `<p><em>Not grounded — no answer given.</em></p>` : "") +
      (cites ? `<div>${cites}</div>` : "") +
      `<div class="lat">⚡ ${tt}s first token · ${total}s total</div>`;
    mine.querySelectorAll<HTMLButtonElement>(".cite").forEach((b) => {
      b.onclick = () => void openViewer(b.dataset.doc ?? "", Number(b.dataset.page ?? 1));
    });
  } catch (e) {
    mine.innerHTML = `<span>Couldn't answer: ${esc((e as Error).message)}</span>`;
  }
  mine.scrollIntoView({ block: "end" });
}

/** On-device answer path (Ask-locally toggle). Retrieve runs over the
 * locally-ingested Dexie docs; the engine is Nano when readily available,
 * the downloaded WebLLM model when present, else the extractive composer.
 * Live-LLM calls receive formatSources(hits) as context (pipeline). */
async function askLocalFlow(text: string) {
  const thread = $("thread");
  thread.insertAdjacentHTML("beforeend", `<div class="msg-q"><span>${esc(text)}</span></div>`);
  const mine = document.createElement("div");
  mine.className = "msg-a";
  mine.innerHTML = `<span>Thinking locally…</span>`;
  thread.appendChild(mine);
  const t0 = performance.now();
  try {
    const pipe = await import("./lib/local/pipeline");
    const kind = tierInfo ? resolveEngineKind(tierInfo, pipe.isWebLLMLoaded()) : "extractive";
    const r = await pipe.answerWithKind(text, kind, pipe.getWebLLM());
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    const sources = r.hits
      .map((h, i) => {
        const page = h.chunk.page === null ? "?" : String(h.chunk.page);
        return `<span class="cite" title="${esc(h.chunk.text.slice(0, 240))}">[${i + 1}] p.${esc(page)} · ${esc(h.chunk.docId.slice(0, 12))}</span>`;
      })
      .join("");
    mine.innerHTML =
      `<p>${esc(r.answer)}</p>` +
      (r.noAnswer ? `<p><em>Not grounded — no answer given.</em></p>` : "") +
      (sources ? `<div>${sources}</div>` : "") +
      `<div class="lat">📴 ${esc(kind)} · ${total}s on-device</div>`;
  } catch (e) {
    mine.innerHTML = `<span>Couldn't answer locally: ${esc((e as Error).message)}</span>`;
  }
  mine.scrollIntoView({ block: "end" });
}

const fmtSize = (b: number) =>
  b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

async function loadDocs() {
  const box = $("docList");
  box.innerHTML = "<p class='hint'>Loading library…</p>";
  try {
    const docs = await listDocs();
    docsById.clear();
    docs.forEach((d) => docsById.set(d.id, d));
    const ready = docs.filter((d) => ["indexed", "ready"].includes(d.status)).length;
    $("docCount").textContent = docs.length ? `· ${ready}/${docs.length} searchable` : "";
    box.innerHTML = docs.length ? "" : "<p class='hint'>No books yet.</p>";
    for (const d of docs) {
      if (typeof d.id !== "string" || !d.id) continue;
      const pill = d.status === "failed" ? "failed" : ["indexed", "ready"].includes(d.status) ? "ready" : "working";
      const pages = num(d.page_count, 0);
      const ver = num(d.version, 0);
      const size = num(d.size_bytes, 0);
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="doc" data-id="${esc(d.id)}"><b>${esc(d.filename)}</b> ` +
          `<span class="pill ${pill}">${esc(d.status)}</span>` +
          `<span class="pill origin">server</span>` +
          `<div class="docmeta">${pages ? `${pages} pages · ` : ""}${fmtSize(size)} · v${ver}</div>` +
          (d.error ? `<div class="docerr">${esc(d.error)}</div>` : "") +
          `<div class="row"><button data-act="read">📖 Read</button>` +
          `<button data-act="del" class="ghost">Delete</button></div></div>`,
      );
    }
    box.querySelectorAll<HTMLDivElement>(".doc").forEach((el) => {
      const id = el.dataset.id ?? "";
      el.querySelector('[data-act="read"]')!.addEventListener("click", () => void openViewer(id, 1));
      el.querySelector('[data-act="del"]')!.addEventListener("click", () => void removeDoc(id));
    });
  } catch (e) {
    box.innerHTML = `<p class='hint'>Couldn't load: ${esc((e as Error).message)}</p>`;
  }
  renderLocalDocs(box);
}

/** Local docs (on-device Dexie store) alongside server docs, badged local. */
function renderLocalDocs(box: HTMLElement) {
  const locals = readLocalDocs();
  if (!locals.length) return;
  box.insertAdjacentHTML("beforeend", `<h3 class="hint">On this device</h3>`);
  for (const d of locals) {
    if (typeof d.id !== "string" || !d.id) continue;
    const pages = num(d.pages, 0);
    const size = num(d.size, 0);
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="doc" data-local="${esc(d.id)}"><b>${esc(d.filename)}</b> ` +
        `<span class="pill local">local</span>` +
        `<div class="docmeta">${pages ? `${pages} pages · ` : ""}${num(d.chunks, 0)} chunks · ${fmtSize(size)}</div>` +
        `<div class="docmeta" title="${esc(d.embedNote)}">on-device vectors</div>` +
        `<div class="localprev hidden"></div>` +
        `<div class="row"><button data-act="read">📖 Preview</button>` +
        `<button data-act="del" class="ghost">Delete</button></div></div>`,
    );
  }
  box.querySelectorAll<HTMLDivElement>(".doc[data-local]").forEach((el) => {
    const id = el.dataset.local ?? "";
    el.querySelector('[data-act="read"]')!.addEventListener("click", () => void previewLocal(id, el));
    el.querySelector('[data-act="del"]')!.addEventListener("click", () => void removeLocal(id));
  });
}

async function previewLocal(id: string, el: HTMLElement) {
  const prev = el.querySelector(".localprev") as HTMLElement;
  prev.classList.toggle("hidden");
  if (prev.classList.contains("hidden") || prev.dataset.loaded) return;
  try {
    const { readLocalChunks } = await import("./lib/local/pipeline");
    const chunks = await readLocalChunks(id, 3);
    prev.innerHTML = chunks.length
      ? chunks.map((c) => `<p class="hint">p.${c.page ?? "?"} · ${esc(c.text.slice(0, 200))}…</p>`).join("")
      : "<p class='hint'>No text stored.</p>";
    prev.dataset.loaded = "1";
  } catch (e) {
    prev.innerHTML = `<p class='hint'>Preview failed: ${esc((e as Error).message)}</p>`;
  }
}

async function removeLocal(id: string) {
  const d = readLocalDocs().find((x) => x.id === id);
  if (!confirm(`Delete local copy of '${d?.filename ?? id}'?`)) return;
  removeLocalDoc(id);
  tombstoneDoc(id);
  if (!isOnline()) {
    try {
      const { queueLocalOp } = await import("./lib/local/pipeline");
      await queueLocalOp("delete", { kind: "delete", docId: id, filename: d?.filename ?? id, at: Date.now() });
    } catch {
      /* outbox unavailable — the delete still applies locally */
    }
  }
  void refreshOutbox();
  void loadDocs();
}

async function removeDoc(id: string) {
  const d = docsById.get(id);
  if (!confirm(`Delete '${d?.filename ?? id}'? This removes its indexed content.`)) return;
  try {
    await deleteDoc(id);
    alert("Deletion scheduled.");
    setTimeout(() => void loadDocs(), 5000);
    void loadDocs();
  } catch (e) {
    alert(`Delete failed: ${(e as Error).message}`);
  }
}

async function upload(file: File) {
  if (!isOnline()) {
    await uploadLocal(file);
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    alert("Over the 25 MB mobile cap.");
    return;
  }
  ($("upMsg") as HTMLElement).textContent = `Uploading ${file.name}…`;
  try {
    const d = await uploadDoc(file);
    ($("file") as HTMLInputElement).value = "";
    ($("upMsg") as HTMLElement).textContent = `Queued: ${d.filename} — ingesting…`;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await docStatus(d.id);
      ($("upMsg") as HTMLElement).textContent = `${d.filename} — ${s.status}…`;
      if (["indexed", "ready", "failed"].includes(s.status)) break;
    }
    void loadDocs();
  } catch (e) {
    ($("upMsg") as HTMLElement).textContent = `Upload failed: ${(e as Error).message}`;
  }
}

/** Offline upload path: agent parse() → chunk → hash embed → Dexie store,
 * queued in the outbox (server sync is Stage 3). */
async function uploadLocal(file: File) {
  if (file.size > 25 * 1024 * 1024) {
    alert("Over the 25 MB mobile cap.");
    return;
  }
  const msg = $("upMsg") as HTMLElement;
  msg.textContent = `Parsing ${file.name} on-device…`;
  try {
    const { ingestLocalFile, queueLocalOp } = await import("./lib/local/pipeline");
    const r = await ingestLocalFile(file, file.name);
    addLocalDoc({
      id: r.docId,
      filename: r.filename,
      size: file.size,
      pages: r.pages,
      chunks: r.chunks,
      origin: "local",
      embedNote: r.note,
      addedAt: Date.now(),
    });
    await queueLocalOp("put", { kind: "upload", docId: r.docId, filename: r.filename, at: Date.now() });
    ($("file") as HTMLInputElement).value = "";
    msg.textContent = `Stored locally: ${r.filename} (${r.chunks} chunks) — syncs in Stage 3.`;
    void refreshOutbox();
    void loadDocs();
  } catch (e) {
    msg.textContent = `Local ingest failed: ${(e as Error).message}`;
  }
}

let viewerUrl: string | null = null;
let viewerDoc = "";
let tocCache = new Map<string, { section: string | null; page: number }[]>();

async function openViewer(docId: string, page: number) {
  if (typeof docId !== "string" || !docId) return;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  viewerDoc = docId;
  tocCache.delete(docId);
  ($("viewer") as HTMLElement).classList.remove("hidden");
  ($("viewerTitle") as HTMLElement).textContent = docsById.get(docId)?.filename ?? "Source";
  ($("viewerStatus") as HTMLElement).textContent = "Loading…";
  try {
    const blob = await docFile(docId);
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(blob);
    const isPdf = (blob.type || "").includes("pdf");
    if (!isPdf) {
      // Never render untrusted non-PDF bytes in-origin: force download.
      const a = document.createElement("a");
      a.href = viewerUrl;
      a.download = docsById.get(docId)?.filename ?? "download";
      a.click();
      ($("viewerStatus") as HTMLElement).textContent = "Download started (preview supports PDF).";
      return;
    }
    ($("viewerFrame") as HTMLIFrameElement).src = `${viewerUrl}#page=${safePage}`;
    ($("viewerPage") as HTMLElement).textContent = `p. ${safePage}`;
    ($("viewerStatus") as HTMLElement).textContent = "";
  } catch (e) {
    ($("viewerStatus") as HTMLElement).textContent = `Couldn't load: ${(e as Error).message}`;
  }
}

function closeViewer() {
  ($("viewer") as HTMLElement).classList.add("hidden");
  ($("viewerFrame") as HTMLIFrameElement).src = "about:blank";
  if (viewerUrl) {
    URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }
}

async function toggleToc() {
  const panel = $("viewerToc") as HTMLElement;
  panel.classList.toggle("hidden");
  if (panel.classList.contains("hidden") || !viewerDoc) return;
  if (!tocCache.has(viewerDoc)) {
    try {
      tocCache.set(viewerDoc, await docToc(viewerDoc));
    } catch {
      panel.innerHTML = "<p class='hint'>No sections.</p>";
      return;
    }
  }
  const entries = tocCache.get(viewerDoc) ?? [];
  panel.innerHTML = entries.length
    ? entries
        .map(
          (t, i) =>
            `<button class="tocrow" data-i="${i}">${esc(t.section ?? `Page ${t.page}`)} <span>· p.${t.page}</span></button>`,
        )
        .join("")
    : "<p class='hint'>No sections.</p>";
  panel.querySelectorAll<HTMLButtonElement>(".tocrow").forEach((b) => {
    b.onclick = () => {
      const t = entries[Number(b.dataset.i)];
      const p = t && Number.isFinite(t.page) && t.page > 0 ? Math.floor(t.page) : null;
      if (p !== null) {
        ($("viewerFrame") as HTMLIFrameElement).src = `${viewerUrl}#page=${p}`;
        ($("viewerPage") as HTMLElement).textContent = `p. ${p}`;
      }
    };
  });
}

async function viewerSearch() {
  const q = ($("viewerSearch") as HTMLInputElement).value.trim();
  const box = $("viewerResults") as HTMLElement;
  if (!q || !viewerDoc) return;
  box.innerHTML = "<p class='hint'>Searching…</p>";
  try {
    const r = await docSearch(viewerDoc, q, 8);
    box.innerHTML = r.chunks.length
      ? `<p class='hint'>${r.chunks.length} matches</p>` +
        r.chunks
          .map(
            (c, i) =>
              `<button class="vres" data-i="${i}">p.${c.page} · ${esc((c.section ?? "").slice(0, 40))}<br><span>${esc(c.text.slice(0, 120))}…</span></button>`,
          )
          .join("")
      : "<p class='hint'>No matches in this book.</p>";
    box.querySelectorAll<HTMLButtonElement>(".vres").forEach((b) => {
      b.onclick = () => {
        const c = r.chunks[Number(b.dataset.i)];
        const p = c && Number.isFinite(c.page) && (c.page as number) > 0 ? Math.floor(c.page as number) : null;
        if (p !== null) {
          ($("viewerFrame") as HTMLIFrameElement).src = `${viewerUrl}#page=${p}`;
          ($("viewerPage") as HTMLElement).textContent = `p. ${p}`;
        }
      };
    });
  } catch (e) {
    box.innerHTML = `<p class='hint'>Search failed: ${esc((e as Error).message)}</p>`;
  }
}

init();
