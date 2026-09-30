/** Local generation tier (Stage 0: policy + prompt + extractive + lazy engines).
 *
 * Tier policy: Chrome Nano when `readily` available → cached WebLLM
 * (WebGPU desktop-class) → extractive quote-only fallback. API fallback is
 * preserved (see `selectGenerationTier` reason strings) but never called here.
 *
 * Reuses `detect.ts` signals — this module never probes hardware itself; it
 * routes on the injected {@link TierInfo}. Heavy engines are lazy: `@mlc-ai/web-llm`
 * is `await import()`-ed ONLY inside {@link WebLLMEngine.load} so importing this
 * module (or the package index) has zero download/bundle side effects.
 */
import type { TierInfo } from "./detect";
import type { Hit } from "./retrieve";
import type { Generation, TierPolicy } from "./types";

/** Default cached WebLLM model (small instruct, widely cached). */
export const DEFAULT_WEBLLM_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

/** Honest refusal used by every no-answer path (grounded wording, stable). */
export const NO_ANSWER_TEXT =
  "I have insufficient grounded information to answer this question from the provided documents.";

/** Route an injected detect-tier signal to a generation tier. Pure: no probing. */
export function selectGenerationTier(info: TierInfo): TierPolicy {
  if (info.tier === "nano")
    return { tier: "nano", reason: "Chrome built-in Nano readily available — free on-device generation" };
  if (info.tier === "webllm")
    return {
      tier: "webllm",
      reason: `WebGPU present (${info.detail}) — cached WebLLM model ${DEFAULT_WEBLLM_MODEL}`,
    };
  return {
    tier: "extractive",
    reason: `No local LLM tier (${info.detail}) — extractive quote-only fallback; API fallback preserved for the caller`,
  };
}

/** Format retrieved hits as numbered grounded sources for a prompt. */
export function formatSources(hits: Hit[]): string {
  return hits
    .map((h, i) => {
      const c = h.chunk;
      const loc = `(doc ${c.docId}, p. ${c.page ?? "?"}, section: ${c.section ?? "—"})`;
      return `[${i + 1}] ${loc}: ${c.text}`;
    })
    .join("\n");
}

/** Strict grounded prompt: quote-only, cite-every-claim, no-outside-knowledge. */
export function buildGroundedPrompt(question: string, hits: Hit[]): string {
  return [
    "You are a grounded question-answering assistant. Answer using ONLY the context below.",
    "",
    "Grounding rules (strict):",
    "1. QUOTE-ONLY (quote-only): every sentence of your answer MUST be a verbatim quote from the context. Do not paraphrase, summarize, or add words of your own outside the quotes.",
    "2. CITE-EVERY-CLAIM (cite every claim): append a [n] marker after each quoted sentence, where n is the number of the source it quotes. Every claim needs its citation.",
    "3. NO-OUTSIDE-KNOWLEDGE (no-outside-knowledge): do not use any outside knowledge — only the context below counts as evidence.",
    `   If the context is insufficient, reply exactly: "${NO_ANSWER_TEXT}"`,
    "",
    `Question: ${question}`,
    "",
    "Context:",
    hits.length ? formatSources(hits) : "(no retrieved context)",
    "",
    "Answer with verbatim quotes + [n] markers:",
  ].join("\n");
}

export interface ExtractiveCitation {
  marker: string;
  documentId: string;
  page: number | null;
}

export interface ExtractiveResult {
  answer: string;
  citations: ExtractiveCitation[];
  noAnswer: boolean;
}

/** First sentence (verbatim, terminator included) — guarantees substring quotes. */
function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const m = t.match(/^.*?[.?!](?=\s|$)/s);
  if (m) return m[0].trim();
  return t.length > 300 ? t.slice(0, 300).trimEnd() : t;
}

/** Quote-only composer: `"sentence" [n]` lines; honest no-answer on empty hits. */
export function composeExtractive(hits: Hit[]): ExtractiveResult {
  const usable = hits.filter((h) => h.chunk.text.trim().length > 0);
  if (usable.length === 0) return { answer: NO_ANSWER_TEXT, citations: [], noAnswer: true };
  const lines: string[] = [];
  const citations: ExtractiveCitation[] = [];
  usable.forEach((h, i) => {
    const quote = firstSentence(h.chunk.text);
    if (!quote) return;
    lines.push(`"${quote}" [${i + 1}]`);
    citations.push({ marker: `[${i + 1}]`, documentId: h.chunk.docId, page: h.chunk.page });
  });
  if (lines.length === 0) return { answer: NO_ANSWER_TEXT, citations: [], noAnswer: true };
  return { answer: lines.join("\n"), citations, noAnswer: false };
}

/** Node-safe Nano availability probe (no throw outside the browser). */
async function nanoReadily(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !window.LanguageModel) return false;
    return (await window.LanguageModel.availability()) === "readily";
  } catch {
    return false;
  }
}

interface NanoSession {
  promptStreaming(prompt: string): AsyncIterable<string>;
}

/** Chrome built-in (Nano) engine. Throws a clear "unavailable" outside Chrome. */
export class NanoEngine implements Generation {
  async isAvailable(): Promise<boolean> {
    return nanoReadily();
  }
  async *generate(prompt: string, context: string): AsyncGenerator<string> {
    if (!(await this.isAvailable()))
      throw new Error("Chrome Nano unavailable: window.LanguageModel is absent or not readily available");
    const api = window.LanguageModel as unknown as {
      create(opts?: Record<string, unknown>): Promise<NanoSession>;
    };
    if (typeof api.create !== "function")
      throw new Error("Chrome Nano unavailable: window.LanguageModel.create() is not supported here");
    const session = await api.create({ temperature: 0 });
    const full = buildGroundedPrompt(prompt, []);
    const text = `${full}\n${context}`;
    for await (const chunk of session.promptStreaming(text)) yield chunk;
  }
}

/** Extractive (no-LLM) engine: always available, quotes stored hits verbatim. */
export class ExtractiveEngine implements Generation {
  private hits: Hit[];
  constructor(hits: Hit[] = []) {
    this.hits = hits;
  }
  setHits(hits: Hit[]): void {
    this.hits = hits;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async *generate(prompt: string, _context: string): AsyncGenerator<string> {
    void prompt;
    yield composeExtractive(this.hits).answer;
  }
}

export interface WebLLMOptions {
  model?: string;
  onProgress?: (progress: number) => void;
}

interface WebLLMChatCompletions {
  create(req: unknown): Promise<AsyncIterable<unknown>>;
}

interface WebLLMEngineLike {
  chat: { completions: WebLLMChatCompletions };
}

/** Extract streamed text from OpenAI-style chunks or plain-string chunks. */
function deltaText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  const c = chunk as { choices?: { delta?: { content?: unknown } }[] };
  const content = c.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

/** WebLLM engine. Construction is side-effect free; call {@link load} to download. */
export class WebLLMEngine implements Generation {
  readonly model: string;
  private readonly onProgress?: (progress: number) => void;
  private engine: WebLLMEngineLike | null = null;

  constructor(opts: WebLLMOptions = {}) {
    this.model = opts.model ?? DEFAULT_WEBLLM_MODEL;
    this.onProgress = opts.onProgress;
  }

  async isAvailable(): Promise<boolean> {
    return this.engine !== null;
  }

  /** Download/cache the model. ONLY place that imports @mlc-ai/web-llm (lazy). */
  async load(): Promise<void> {
    if (this.engine) return;
    const mod = await import("@mlc-ai/web-llm");
    const { CreateMLCEngine } = mod as unknown as {
      CreateMLCEngine(
        model: string,
        config?: { initProgressCallback?: (report: { progress: number }) => void },
      ): Promise<WebLLMEngineLike>;
    };
    const onProgress = this.onProgress;
    this.engine = await CreateMLCEngine(
      this.model,
      onProgress ? { initProgressCallback: (r) => onProgress(r.progress) } : undefined,
    );
  }

  async *generate(prompt: string, context: string): AsyncGenerator<string> {
    if (!this.engine) throw new Error("WebLLM engine not loaded: call load() first (no download happens before load())");
    const stream = await this.engine.chat.completions.create({
      messages: [
        { role: "system", content: "Answer only from the provided context, quoting verbatim with [n] citations." },
        { role: "user", content: `${buildGroundedPrompt(prompt, [])}\n${context}` },
      ],
      stream: true,
      temperature: 0,
    });
    for await (const chunk of stream) {
      const t = deltaText(chunk);
      if (t) yield t;
    }
  }
}
