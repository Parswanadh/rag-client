# rag-client — local-first client-side RAG PWA

Stage 0 (v0): working chat shell. Compute-tier detection at launch, sign-in
(ID + password → workspace key), streaming grounded answers with citations +
latency, served from Cloudflare Workers. Local engines (vectors, parsing,
generation) are typed stubs that light up stage by stage.

- Plan: [docs/PLAN.md](docs/PLAN.md) · Failure modes: [docs/FAILURES.md](docs/FAILURES.md) · Research: [docs/RESEARCH.md](docs/RESEARCH.md)
- API fallback: stable Ragz backend (`rag.parswanadh.dev`); local tiers per PLAN.
- `npm install && npm run build && npx wrangler deploy`
