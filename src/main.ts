import { detectTier } from "./lib/detect";
import { getKey, login, streamChat } from "./lib/api";

const $ = (id: string) => document.getElementById(id)!;
let conv: string | null = null;
let acc = "";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

async function init() {
  try {
    const t = await detectTier();
    $("tier").textContent =
      t.tier === "api" ? `API path · ${t.detail}` : `${t.tier} path available · ${t.detail}`;
  } catch {
    $("tier").textContent = "API path";
  }
  if (getKey()) showChat();
  ($("loginBtn") as HTMLButtonElement).onclick = async () => {
    const id = ($("uid") as HTMLInputElement).value.trim();
    const pw = ($("pw") as HTMLInputElement).value;
    if (!id || !pw) return;
    try {
      await login(id, pw);
      showChat();
    } catch (e) {
      alert(`Sign-in failed: ${(e as Error).message}`);
    }
  };
  ($("ask") as HTMLButtonElement).onclick = ask;
  ($("q") as HTMLTextAreaElement).onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };
}

function showChat() {
  $("loginPane").classList.add("hidden");
  $("chatPane").classList.remove("hidden");
  $("composer").classList.remove("hidden");
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
  acc = "";
  try {
    const done = await streamChat(text, conv, (d) => {
      acc += d;
      mine.innerHTML = `<p>${esc(acc)}</p>`;
      mine.scrollIntoView({ block: "end" });
    });
    conv = done.conversation_id;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const cites = (done.citations ?? [])
      .map((c) => `<span class="cite">[${c.marker}] p.${c.page ?? "?"} · ${esc(c.document_id.slice(0, 8))}</span>`)
      .join("");
    mine.innerHTML =
      `<p>${esc(done.answer)}</p>` +
      (done.no_answer ? `<p><em>Not grounded — no answer given.</em></p>` : "") +
      (cites ? `<div>${cites}</div>` : "") +
      `<div class="lat">⚡ ${secs}s total</div>`;
  } catch (e) {
    mine.innerHTML = `<span>Couldn't answer: ${esc((e as Error).message)}</span>`;
  }
  mine.scrollIntoView({ block: "end" });
}

init();
