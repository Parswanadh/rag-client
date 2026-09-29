# Parity matrix — Ragz (reference) → rag-client (this repo)

Reference: stable Ragz @ mqr-pr-11 external API (`rag.parswanadh.dev`).
Pinned by `tests/bench/run.mjs` (15 checks, all passing 2026-09-29).

| Ragz capability | rag-client status | Notes |
|---|---|---|
| Login → workspace key | ✅ ported (`lib/api.login`) | sessionStorage, same 401 semantics |
| Streaming grounded chat + citations | ✅ ported (`streamChat`, SSE parser) | delta/done/error frames, timings, usage |
| Non-stream chat | ✅ via stream collector | same answers (bench golden) |
| No-answer honesty (struct) | ✅ displayed | banner on `no_answer` |
| Latency per answer | ✅ ported | ttft/total server + client |
| Library list + statuses | ✅ ported | count, pills, errors |
| Upload + ingest poll | ✅ ported | 25MB cap, staged status |
| Source file bytes + viewer | ✅ ported | blob iframe, `#page=` jump |
| In-book search | ✅ ported | scoped, page badges |
| Section TOC | ✅ ported | first-page-per-section |
| Delete (async purge) | ✅ ported | confirm + 202 + refresh |
| Laya opt-in guard flag | ✅ ported | toggle persisted, fail-open server-side |
| Model badge | ✅ ported | `/openai/models` |
| Keyless 401s | ✅ enforced | same shapes |
| Workspaces/folders/RBAC admin | ❌ server-only | native UI (`app.parswanadh.dev`) covers |
| Evals/bots/usage/reports | ❌ server-only | same as above |
| MQR toggle | ➖ backend flag | honored automatically when workspace has it |
| Local tiers (embed/store/parse/LLM) | ⏳ staged stubs | Stages 1–3 per `docs/PLAN.md` |

Latency budgets (streaming, server `timings`): typical Q ttft 3–7s / total
10–23s (Mimo reasoning locked on gateway-side); beetle-class queries slower
(~40s — long-context retrieval + reasoning). Stage 2 local tier targets:
ttft < 2s on desktop GPU for ≤1.5B models (to be measured, not promised).
