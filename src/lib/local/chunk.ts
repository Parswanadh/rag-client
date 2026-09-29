/** Recursive character chunker (1000 chars / 200 overlap) with heading
 * prefixes, page tracking, and sha-256 content hashes for dedup.
 * Mirrors the server's heading strategy so citations stay comparable.
 */
export interface Chunk {
  id: string;
  docId: string;
  page: number | null;
  section: string | null;
  text: string;
  hash: string;
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

/** Split one page's text; headings (`# `) start new sections. Returns
 * section/text pairs with the section captured at push time. */
export function chunkPage(docId: string, page: number | null, text: string, section: string | null): string[] {
  const out: { s: string | null; t: string }[] = [];
  let buf = "";
  let cur = section;
  for (const para of splitParagraphs(text)) {
    const h = para.match(/^#{1,3}\s+(.*)/);
    if (h) {
      if (buf.trim()) out.push({ s: cur, t: buf.trim() });
      cur = h[1].trim();
      buf = "";
      continue;
    }
    if ((buf + "\n" + para).length > SIZE && buf.trim()) {
      out.push({ s: cur, t: buf.trim() });
      buf = buf.slice(-OVERLAP);
    }
    buf += (buf ? "\n" : "") + para;
  }
  if (buf.trim()) out.push({ s: cur, t: buf.trim() });
  return out.map(({ s, t }) => JSON.stringify({ s, t: (s ? `${s}: ` : "") + t }));
}

export async function chunkDocument(
  docId: string,
  pages: { page: number | null; text: string }[],
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  let section: string | null = null;
  for (const p of pages) {
    for (const raw of chunkPage(docId, p.page, p.text, section)) {
      const { s, t } = JSON.parse(raw) as { s: string | null; t: string };
      section = s;
      chunks.push({
        id: `${docId}:${p.page ?? 0}:${chunks.length}`,
        docId,
        page: p.page,
        section: s,
        text: t,
        hash: await sha256Hex(`${docId}|${p.page}|${t}`),
      });
    }
  }
  return chunks;
}
