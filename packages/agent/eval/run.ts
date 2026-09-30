/** Task 6 — local retrieval eval harness (node-run, zero new dependencies).
 *
 * Golden cases (leave carry-over expiry, moss-beetle catalogue page,
 * approval rule, Tokyo-dinners refusal probe) run against the REAL agent
 * stack — chunkDocument + indexCorpus/retrieve + composeExtractive — over a
 * small checked-in corpus (`corpus/`), using the SAME prod defaults
 * (minScore 0.35, topK 8).
 *
 * Embeddings: REAL MiniLM via TransformersEmbedder (downloaded at eval time,
 * HuggingFace cache; 120s timebox). If the download fails (offline), falls
 * back to HashEmbedder and MARKS every result row + the JSON report as
 * `lexical-tier`. The fallback uses a wide 4096-dim feature hash: identical
 * code path and threshold, just fewer accidental trigram collisions so the
 * lexical stand-in approximates true token overlap.
 *
 * Per-case asserts: recall (expected doc/page in hits), citation page
 * accuracy (beetle → page cited), no-answer correctness (retrieval AND
 * extractive agree with the case), expected phrases in the extractive
 * answer, minCites. Prints a PASS/FAIL table, writes `eval-report.json`
 * next to this file, exits non-zero on any fail.
 *
 * Run: `npm run eval --workspace=@rag-client/agent` (or `npm run eval`
 * inside `packages/agent/eval/`). Not part of any tsconfig `include`, so it
 * never affects `tsc --noEmit` / `vite build`; uses relative imports only.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { chunkDocument } from "../src/chunk.ts";
import type { Chunk } from "../src/chunk.ts";
import { HashEmbedder, TransformersEmbedder } from "../src/embed.ts";
import type { Embedder } from "../src/embed.ts";
import { indexCorpus, retrieve } from "../src/retrieve.ts";
import type { IndexedCorpus } from "../src/retrieve.ts";
import { composeExtractive } from "../src/generate.ts";
import type { EvalCase } from "../src/types.ts";

// Same as prod defaults in retrieve.ts — deliberately not tuned per case.
const MIN_SCORE = 0.35;
const TOP_K = 8;
// Timebox for the MiniLM download at eval time; offline → lexical fallback.
const EMBED_TIMEOUT_MS = 120_000;
// Wide feature hash for the offline fallback (fewer random collisions;
// same threshold + code path as the semantic tier).
const FALLBACK_DIM = 4096;

const HERE = new URL("./", import.meta.url);
const CORPUS_DIR = new URL("./corpus/", import.meta.url);
const REPORT_URL = new URL("./eval-report.json", import.meta.url);
void HERE;

interface CorpusSource {
  file: string;
  docId: string;
  page: number;
}

// Flat .txt corpus; page numbers are explicit here because chunkDocument
// takes pages[{page, text}] (beetle fact lives on page 2 by construction).
const SOURCES: CorpusSource[] = [
  { file: "leave-policy.txt", docId: "leave-policy", page: 1 },
  { file: "approval-policy.txt", docId: "approval-policy", page: 1 },
  { file: "beetle-guide-p1.txt", docId: "beetle-guide", page: 1 },
  { file: "beetle-guide-p2.txt", docId: "beetle-guide", page: 2 },
  { file: "misc-notes.txt", docId: "misc-notes", page: 1 },
];

/** EvalCase + the expected document for the recall assert. */
interface GoldenCase extends EvalCase {
  expectDoc: string;
}

// NOTE on `page`: the bench oracle (tests/bench/run.mjs) expects the beetle
// citation on page 2 and the harness corpus is built to match (fact on p.2).
// The task brief's "page 7" refers to the generate.test.ts fixture, not this
// corpus — page 2 is used here, consistent with the bench golden.
const CASES: GoldenCase[] = [
  {
    q: "When do carry-over days expire?",
    expectPhrases: ["March 31"],
    noAnswer: false,
    minCites: 1,
    expectDoc: "leave-policy",
  },
  {
    q: "Who first catalogued the Zephyrian moss-beetle, and in what year?",
    expectPhrases: ["Voss", "1987"],
    noAnswer: false,
    minCites: 1,
    page: 2,
    expectDoc: "beetle-guide",
  },
  {
    q: "Do we need manager approval for a 5-day leave?",
    expectPhrases: ["approval"],
    noAnswer: false,
    minCites: 1,
    expectDoc: "approval-policy",
  },
  {
    q: "What is the reimbursement limit for client dinners in Tokyo?",
    expectPhrases: [],
    noAnswer: true,
    minCites: 0,
    expectDoc: "",
  },
];

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface CaseResult {
  q: string;
  pass: boolean;
  top: string;
  answer: string;
  checks: CheckResult[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function loadEmbedder(): Promise<{ embedder: Embedder; tier: string; embedderName: string }> {
  if (process.env.EVAL_EMBEDDER === "lexical") {
    // Deterministic offline simulation (CI without network): skip MiniLM.
    console.warn("[eval] EVAL_EMBEDDER=lexical — using HashEmbedder; results are LEXICAL-TIER.");
    return {
      embedder: new HashEmbedder(FALLBACK_DIM),
      tier: `lexical-tier (HashEmbedder(${FALLBACK_DIM}) forced via EVAL_EMBEDDER=lexical)`,
      embedderName: "HashEmbedder",
    };
  }
  try {
    const mini = new TransformersEmbedder();
    await withTimeout(mini.embed(["eval warm-up probe"]), EMBED_TIMEOUT_MS, "MiniLM download");
    return { embedder: mini, tier: "semantic (REAL MiniLM Xenova/all-MiniLM-L6-v2)", embedderName: "TransformersEmbedder" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[eval] MiniLM unavailable (${reason}) — falling back to HashEmbedder; results are LEXICAL-TIER.`);
    return {
      embedder: new HashEmbedder(FALLBACK_DIM),
      tier: `lexical-tier (HashEmbedder(${FALLBACK_DIM}) fallback; MiniLM unavailable: ${reason})`,
      embedderName: "HashEmbedder",
    };
  }
}

async function loadChunks(): Promise<Chunk[]> {
  const files = new Set((await readdir(CORPUS_DIR)).filter((f) => f.endsWith(".txt")));
  const chunks: Chunk[] = [];
  for (const src of SOURCES) {
    if (!files.has(src.file)) throw new Error(`corpus file missing: ${src.file}`);
    const text = (await readFile(new URL(src.file, CORPUS_DIR), "utf8")).trim();
    if (!text) throw new Error(`corpus file empty: ${src.file}`);
    chunks.push(...(await chunkDocument(src.docId, [{ page: src.page, text }])));
  }
  if (chunks.length === 0) throw new Error("corpus produced zero chunks");
  return chunks;
}

async function indexChunks(chunks: Chunk[], embedder: Embedder): Promise<IndexedCorpus> {
  const vectors = await embedder.embed(chunks.map((c) => c.text));
  const byId = new Map<string, number[]>();
  chunks.forEach((c, i) => byId.set(c.id, vectors[i] as number[]));
  return indexCorpus(chunks, byId, embedder.dim);
}

function check(name: string, pass: boolean, detail: string): CheckResult {
  return { name, pass, detail };
}

async function runCase(c: GoldenCase, corpus: IndexedCorpus, embedder: Embedder): Promise<CaseResult> {
  const retrieval = await retrieve(c.q, corpus, embedder, { topK: TOP_K, minScore: MIN_SCORE });
  const ext = composeExtractive(retrieval.hits);
  const checks: CheckResult[] = [];

  // Recall: expected doc (/page) present in hits; refusal probe → no hits.
  if (c.noAnswer) {
    checks.push(check("recall", retrieval.hits.length === 0, `hits=${retrieval.hits.length} (expect none)`));
  } else {
    const docHit = retrieval.hits.some((h) => h.chunk.docId === c.expectDoc);
    checks.push(check("recall", docHit, `doc "${c.expectDoc}" ${docHit ? "in" : "NOT in"} top-${retrieval.hits.length}`));
    if (c.page !== undefined) {
      const pageHit = retrieval.hits.some((h) => h.chunk.docId === c.expectDoc && h.chunk.page === c.page);
      checks.push(check("recall-page", pageHit, `${c.expectDoc} p.${c.page} ${pageHit ? "hit" : "MISSED"}`));
    }
  }

  // No-answer correctness: retrieval gate AND extractive composer agree.
  const naPass = retrieval.noAnswer === c.noAnswer && ext.noAnswer === c.noAnswer;
  checks.push(
    check("no-answer", naPass, `retrieve.noAnswer=${retrieval.noAnswer} extractive.noAnswer=${ext.noAnswer} (expect ${c.noAnswer})`),
  );

  // Expected phrases verbatim in the extractive answer (grounded cases).
  for (const p of c.expectPhrases) {
    checks.push(check(`phrase "${p}"`, ext.answer.includes(p), ext.answer.includes(p) ? "quoted" : "MISSING from answer"));
  }

  // Citation count + citation page accuracy.
  checks.push(check("min-cites", ext.citations.length >= c.minCites, `cites=${ext.citations.length} (min ${c.minCites})`));
  if (c.page !== undefined && !c.noAnswer) {
    const cited = ext.citations.some((ci) => ci.documentId === c.expectDoc && ci.page === c.page);
    checks.push(check("cite-page", cited, `p.${c.page} ${cited ? "cited" : "NOT cited"}`));
  }

  const top = retrieval.hits[0] ? `${retrieval.hits[0].chunk.docId} p.${retrieval.hits[0].chunk.page}` : "(none)";
  return { q: c.q, pass: checks.every((k) => k.pass), top, answer: ext.answer, checks };
}

async function main(): Promise<void> {
  const { embedder, tier, embedderName } = await loadEmbedder();
  const chunks = await loadChunks();
  const corpus = await indexChunks(chunks, embedder);

  const results: CaseResult[] = [];
  for (const c of CASES) results.push(await runCase(c, corpus, embedder));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nEVAL  tier=${tier}  minScore=${MIN_SCORE} topK=${TOP_K} chunks=${chunks.length}`);
  console.log("=".repeat(100));
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.q}  [top: ${r.top}]`);
    for (const k of r.checks) console.log(`      ${k.pass ? "ok  " : "MISS"} ${k.name} — ${k.detail}`);
  }
  console.log("=".repeat(100));
  console.log(`${passed}/${results.length} cases passed`);

  const report = {
    at: new Date().toISOString(),
    tier,
    embedder: embedderName,
    minScore: MIN_SCORE,
    topK: TOP_K,
    chunks: chunks.length,
    passed,
    total: results.length,
    results,
  };
  await writeFile(REPORT_URL, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${REPORT_URL.pathname}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`[eval] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
