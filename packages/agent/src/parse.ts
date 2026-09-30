/** In-browser document parsing for the ingest path (pdf/docx/xlsx/pptx/txt/md).
 *
 * `DocumentParser` implements the frozen `Parser` contract from `./types`
 * (dispatch by filename extension, fail-closed on unknown extensions).
 *
 * TEXT ONLY, by construction: this module has no canvas dependency — no
 * `getViewport`, no `render`, no canvas factory. PDF extraction uses
 * `getPage(n).getTextContent()` per page with a y-position line heuristic;
 * docx goes through mammoth's `extractRawText`; xlsx is lazily
 * dynamic-imported (`import("xlsx")`) so spreadsheet code never enters the
 * initial bundle; pptx slides+notes are read as XML from the zip (JSZip).
 */
import { getDocument } from "pdfjs-dist";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import JSZip from "jszip";
import mammoth from "mammoth";
import type { Parser } from "./types";

/** One extracted page. `page` is 1-based (PDF page, slide #, sheet #, or 1
 *  for flat formats) so downstream `--- Page N ---` chunk semantics hold. */
export interface ParsedPage {
  page: number;
  text: string;
}

export interface ParsedDocument {
  pages: ParsedPage[];
  mime: string;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
};

/** pdf.js text item (narrowed to the fields the line heuristic needs). */
interface PlacedItem {
  str: string;
  /** PDF text-space transform [a, b, c, d, x, y]. */
  transform: number[];
}

function isPlacedItem(item: TextContent["items"][number]): item is TextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as PlacedItem).str === "string" &&
    "transform" in item &&
    Array.isArray((item as PlacedItem).transform)
  );
}

/** Join one PDF page's text items into lines.
 *
 * Items sharing (approximately) the same y baseline form a line
 * (top of page first); within a line items sort left-to-right and gain a
 * space only when the horizontal gap exceeds a quarter of the font size,
 * so kern-split fragments ("Hel"+"lo") don't gain spurious spaces while
 * real word breaks do. Empty items are dropped.
 */
export function joinPdfLineItems(items: TextContent["items"]): string {
  const placed: { x: number; y: number; size: number; str: string }[] = [];
  for (const item of items) {
    if (!isPlacedItem(item) || item.str === "") continue;
    const t = item.transform;
    placed.push({ x: t[4], y: t[5], size: Math.abs(t[0]), str: item.str });
  }
  placed.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: string[] = [];
  let current: { x: number; y: number; size: number; str: string }[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    let line = current[0].str;
    let cursor = current[0].x + current[0].size * current[0].str.length * 0.6;
    for (const it of current.slice(1)) {
      const gap = it.x - cursor;
      if (gap > it.size * 0.25) line += " ";
      line += it.str;
      cursor = it.x + it.size * it.str.length * 0.6;
    }
    lines.push(line);
    current = [];
  };
  for (const it of placed) {
    // New visual line when the baseline drops by more than ~2pt.
    if (current.length > 0 && current[current.length - 1].y - it.y > 2) flush();
    current.push(it);
  }
  flush();
  return lines.join("\n");
}

async function parsePdf(data: Uint8Array): Promise<ParsedPage[]> {
  const task = getDocument({ data });
  const doc = await task.promise;
  try {
    const pages: ParsedPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        pages.push({ page: n, text: joinPdfLineItems(content.items) });
      } finally {
        // Release page resources; rendering is never invoked.
        page.cleanup();
      }
    }
    return pages;
  } finally {
    doc.cleanup();
    await task.destroy();
  }
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParsedPage[]> {
  // mammoth's node entry reads `{buffer}` while its browser entry reads
  // `{arrayBuffer}` (see the mammoth package "browser" field remap of
  // unzip.js); both shapes are in mammoth's `Input` type. Pick at runtime
  // so node tests and browser ingest share this path.
  const input =
    typeof Buffer !== "undefined" ? { buffer: Buffer.from(buffer) } : { arrayBuffer: buffer };
  const { value } = await mammoth.extractRawText(input);
  return [{ page: 1, text: value }];
}

async function parseXlsx(data: Uint8Array): Promise<ParsedPage[]> {
  // Lazy: spreadsheet parsing stays out of the initial bundle.
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(data, { type: "array" });
  return workbook.SheetNames.map((name, i) => {
    const sheet = workbook.Sheets[name];
    // Rows via sheet_to_json (header:1) rather than sheet_to_txt, which
    // emits UTF-16 with a BOM. Tabs separate cells, newlines separate rows.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    const body = rows
      .map((row) => row.map((cell) => String(cell)).join("\t"))
      .join("\n")
      .trim();
    // Flat page contract: sheet name preserved as the first line.
    return { page: i + 1, text: `Sheet: ${name}${body === "" ? "" : `\n${body}`}` };
  });
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) =>
      e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : "'",
    )
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

/** Extract drawingML paragraphs (`a:p` → runs `a:t`) from slide/notes XML.
 *  Prefers DOMParser where available (browsers), else a regex fallback
 *  (node/workers) — identical paragraph-per-line shape either way. */
export function extractDrawingParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  const domParser =
    typeof globalThis !== "undefined"
      ? (globalThis as unknown as { DOMParser?: typeof DOMParser }).DOMParser
      : undefined;
  if (typeof domParser !== "undefined") {
    const doc = new domParser().parseFromString(xml, "application/xml");
    const els = doc.getElementsByTagName("*");
    for (const el of Array.from(els)) {
      if (el.localName !== "p" || el.prefix !== "a") continue;
      const runs: string[] = [];
      const descendants = el.getElementsByTagName("*");
      for (const d of Array.from(descendants)) {
        if (d.localName === "t" && d.prefix === "a" && d.textContent !== null) {
          runs.push(d.textContent);
        }
      }
      if (runs.length > 0) paragraphs.push(runs.join(""));
    }
    return paragraphs;
  }
  for (const pMatch of xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)) {
    const runs: string[] = [];
    for (const tMatch of pMatch[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)) {
      runs.push(decodeXmlEntities(tMatch[1]));
    }
    if (runs.length > 0) paragraphs.push(runs.join(""));
  }
  return paragraphs;
}

/** Resolve a slide's notes part via its .rels (`notesSlide` relationship). */
function resolveNotesPath(zip: JSZip, slidePath: string, slideRelsXml: string): string | null {
  const match = slideRelsXml.match(
    /<Relationship[^>]*Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"[^>]*\/>/,
  );
  if (!match) return null;
  // Target is relative to ppt/slides/_rels/ (e.g. ../notesSlides/notesSlide1.xml).
  const base = slidePath.slice(0, slidePath.lastIndexOf("/")); // ppt/slides
  const parts = base.split("/");
  for (const seg of match[1].split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const resolved = parts.join("/");
  return zip.file(resolved) === null ? null : resolved;
}

async function parsePptx(buffer: ArrayBuffer): Promise<ParsedPage[]> {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)![1]) - Number(b.match(/slide(\d+)\.xml$/)![1]));
  const pages: ParsedPage[] = [];
  for (const slidePath of slidePaths) {
    const slideNo = Number(slidePath.match(/slide(\d+)\.xml$/)![1]);
    const slideXml = await zip.file(slidePath)!.async("text");
    const parts = extractDrawingParagraphs(slideXml);
    const relsFile = zip.file(
      slidePath.replace("ppt/slides/slide", "ppt/slides/_rels/slide").replace(/\.xml$/, ".xml.rels"),
    );
    if (relsFile !== null) {
      const notesPath = resolveNotesPath(zip, slidePath, await relsFile.async("text"));
      if (notesPath !== null) {
        const notesXml = await zip.file(notesPath)!.async("text");
        parts.push(...extractDrawingParagraphs(notesXml));
      }
    }
    pages.push({ page: slideNo, text: parts.join("\n") });
  }
  return pages;
}

/** Dispatch by filename extension; unknown extensions throw (fail-closed). */
export class DocumentParser implements Parser {
  async parse(
    file: File | Blob,
    name: string,
  ): Promise<{ pages: { page: number; text: string }[]; mime: string }> {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    switch (ext) {
      case "pdf": {
        const data = new Uint8Array(await file.arrayBuffer());
        return { pages: await parsePdf(data), mime: MIME[ext] };
      }
      case "docx": {
        return { pages: await parseDocx(await file.arrayBuffer()), mime: MIME[ext] };
      }
      case "xlsx": {
        const data = new Uint8Array(await file.arrayBuffer());
        return { pages: await parseXlsx(data), mime: MIME[ext] };
      }
      case "pptx": {
        return { pages: await parsePptx(await file.arrayBuffer()), mime: MIME[ext] };
      }
      case "txt":
      case "md": {
        return { pages: [{ page: 1, text: await file.text() }], mime: MIME[ext] };
      }
      default:
        throw new Error(`Unsupported file type "${name}": no parser registered`);
    }
  }
}

/** Convenience wrapper for one-shot parsing without instantiating the class. */
export async function parseDocument(
  file: File | Blob,
  name: string,
): Promise<ParsedDocument> {
  return new DocumentParser().parse(file, name);
}
