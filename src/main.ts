import { detectTier } from "./lib/detect";
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

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const layaOn = () => (document.getElementById("layaToggle") as HTMLInputElement)?.checked ?? false;

async function init() {
  try {
    const t = await detectTier();
    $("tier").textContent = t.tier === "api" ? `API path · ${t.detail}` : `${t.tier} path available · ${t.detail}`;
  } catch {
    $("tier").textContent = "API path";
  }
  if (getKey()) {
    showChat();
    void modelBadge();
  }
  ($("loginBtn") as HTMLButtonElement).onclick = async () => {
    const id = ($("uid") as HTMLInputElement).value.trim();
    const pw = ($("pw") as HTMLInputElement).value;
    if (!id || !pw) return;
    try {
      await login(id, pw);
      showChat();
      void modelBadge();
    } catch (e) {
      alert(`Sign-in failed: ${(e as Error).message}`);
    }
  };
  ($("ask") as HTMLButtonElement).onclick = () => void ask();
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
}

function showChat() {
  $("loginPane").classList.add("hidden");
  $("app").classList.remove("hidden");
  showTab("chat");
}

function showTab(name: string) {
  for (const t of ["chat", "lib"]) {
    document.getElementById(`pane-${t}`)?.classList.toggle("hidden", t !== name);
    document.querySelector(`#tabs button[data-tab="${t}"]`)?.classList.toggle("on", t === name);
  }
  if (name === "lib") void loadDocs();
}

async function modelBadge() {
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
      .map(
        (c) =>
          `<button class="cite" data-doc="${esc(c.document_id)}" data-page="${c.page ?? 1}">[${c.marker}] p.${c.page ?? "?"} · ${esc(c.document_id.slice(0, 8))}</button>`,
      )
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
      const pill = d.status === "failed" ? "failed" : ["indexed", "ready"].includes(d.status) ? "ready" : "working";
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="doc" data-id="${d.id}"><b>${esc(d.filename)}</b> ` +
          `<span class="pill ${pill}">${esc(d.status)}</span>` +
          `<div class="docmeta">${d.page_count ? `${d.page_count} pages · ` : ""}${fmtSize(d.size_bytes)} · v${d.version}</div>` +
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

let viewerUrl: string | null = null;
let viewerDoc = "";
let tocCache = new Map<string, { section: string | null; page: number }[]>();

async function openViewer(docId: string, page: number) {
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
    ($("viewerFrame") as HTMLIFrameElement).src = isPdf ? `${viewerUrl}#page=${page}` : viewerUrl;
    ($("viewerPage") as HTMLElement).textContent = `p. ${page}`;
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
      if (t) {
        ($("viewerFrame") as HTMLIFrameElement).src = `${viewerUrl}#page=${t.page}`;
        ($("viewerPage") as HTMLElement).textContent = `p. ${t.page}`;
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
        if (c) {
          ($("viewerFrame") as HTMLIFrameElement).src = `${viewerUrl}#page=${c.page}`;
          ($("viewerPage") as HTMLElement).textContent = `p. ${c.page}`;
        }
      };
    });
  } catch (e) {
    box.innerHTML = `<p class='hint'>Search failed: ${esc((e as Error).message)}</p>`;
  }
}

init();
