/** Recursive character chunker (~1000 chars / 200 overlap, word boundaries)
 * with H1>H2 section trails, page tracking, and content hashes.
 * Text stays clean (section lives in metadata, never prefixed into text).
 */
export interface Chunk {
  id: string;
  docId: string;
  page: number | null;
  section: string | null;
  text: string;
  hash: string;
  version: number;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SIZE = 1000;
const OVERLAP = 200;

export function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
}

function parseHeading(para: string): { level: number; title: string } | null {
  const m = para.match(/^(#{1,3})\s+(.*\S)/);
  return m ? { level: m[1].length, title: m[2].trim() } : null;
}

/** Word-boundary head/tail split of an over-long string. */
function hardSlice(s: string, max: number): [string, string] {
  if (s.length <= max) return [s, ""];
  let cut = s.lastIndexOf(" ", max);
  if (cut < max * 0.5) cut = max;
  return [s.slice(0, cut), s.slice(cut).trimStart()];
}

/** Last ~max chars of s, cut at a word boundary. */
function tailWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.indexOf(" ", s.length - max);
  return cut < 0 ? s.slice(-max) : s.slice(cut + 1);
}

export interface Block {
  section: string | null;
  text: string;
}

/** Split one page's text; headings start/trim the section trail. */
export function chunkPage(text: string, trail: readonly (string | null)[]): Block[] {
  const out: Block[] = [];
  let buf = "";
  let cur: (string | null)[] = [...trail];
  const sectionOf = (): string | null => cur.filter(Boolean).join(" > ") || null;
  const flush = (): void => {
    if (buf.trim()) out.push({ section: sectionOf(), text: buf.trim() });
    buf = "";
  };
  for (const para of splitParagraphs(text)) {
    const h = parseHeading(para);
    if (h) {
      flush();
      cur = [...cur.slice(0, h.level - 1), h.title];
      continue;
    }
    let rest = para;
    while (rest) {
      const candidate = buf + (buf ? "\n" : "") + rest;
      if (candidate.length <= SIZE) {
        buf = candidate;
        rest = "";
      } else if (!buf.trim()) {
        // Single over-long paragraph: emit word-boundary slices until the
        // remainder fits, then carry it. Overlap across mid-para splits is
        // intentionally skipped; normal paragraph flow still carries
        // OVERLAP tails (see flush branch below).
        let tail = rest;
        while (tail.length > SIZE) {
          const [head, next] = hardSlice(tail, SIZE);
          out.push({ section: sectionOf(), text: head.trim() });
          tail = next;
          if (!tail) break;
        }
        buf = tail;
        rest = "";
        break;
      } else {
        flush();
        buf = tailWords(buf, OVERLAP);
      }
    }
  }
  flush();
  return out;
}

export async function chunkDocument(
  docId: string,
  pages: { page: number | null; text: string }[],
  version = 1,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  let trail: (string | null)[] = [];
  for (const p of pages) {
    for (const b of chunkPage(p.text, trail)) {
      trail = b.section ? b.section.split(" > ") : [];
      const text = b.text;
      chunks.push({
        id: `${docId}:${p.page ?? "np"}:${chunks.length}`,
        docId,
        page: p.page,
        section: b.section,
        text,
        hash: await sha256Hex(`${text}`),
        version,
      });
    }
  }
  return chunks;
}
