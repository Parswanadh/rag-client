import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentParser } from "../src/parse";
import type { Parser } from "../src/types";

const testdata = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata");
const load = async (name: string): Promise<File> =>
  new File([await readFile(join(testdata, name))], name);

describe("DocumentParser", () => {
  it("implements the frozen Parser contract", () => {
    const asParser: Parser = new DocumentParser();
    expect(typeof asParser.parse).toBe("function");
  });

  it("pdf: extracts both pages in order with real text", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parse(await load("two-page.pdf"), "two-page.pdf");
    expect(doc.mime).toBe("application/pdf");
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(doc.pages[0].text).toContain("RAG ingest test document.");
    expect(doc.pages[0].text).toContain("First page alpha content about retrieval.");
    expect(doc.pages[0].text).toContain("Second line on page one mentions chunking.");
    expect(doc.pages[1].text).toContain("Second page beta content about reranking.");
    expect(doc.pages[1].text).toContain("Final line on page two mentions citations.");
    // Page isolation: no cross-page leakage.
    expect(doc.pages[0].text).not.toContain("beta content");
    expect(doc.pages[1].text).not.toContain("alpha content");
  });

  it("docx: extracts raw text via mammoth", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parse(await load("sample.docx"), "sample.docx");
    expect(doc.mime).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].page).toBe(1);
    expect(doc.pages[0].text).toContain("Docx gamma paragraph about hybrid search.");
    expect(doc.pages[0].text).toContain("Second docx paragraph mentions embeddings.");
  });

  it("xlsx: one page per sheet with sheet name preserved", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parse(await load("sample.xlsx"), "sample.xlsx");
    expect(doc.mime).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0].text.split("\n")[0]).toBe("Sheet: Planets");
    expect(doc.pages[0].text).toContain("Earth");
    expect(doc.pages[1].text.split("\n")[0]).toBe("Sheet: Notes");
    expect(doc.pages[1].text).toContain("xlsx delta note about recall");
  });

  it("pptx: slide number as page, notes appended", async () => {
    const parser = new DocumentParser();
    const doc = await parser.parse(await load("sample.pptx"), "sample.pptx");
    expect(doc.mime).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(doc.pages[0].text).toContain("Pptx epsilon title slide");
    expect(doc.pages[0].text).toContain("Bullet about local-first RAG");
    expect(doc.pages[1].text).toContain("Second slide zeta heading");
    expect(doc.pages[1].text).toContain("Speaker note theta about grounding");
    // Notes belong to slide 2, not slide 1.
    expect(doc.pages[0].text).not.toContain("theta about grounding");
  });

  it("txt/md: decoded via Blob.text()", async () => {
    const parser = new DocumentParser();
    const txt = await parser.parse(
      new Blob(["hello txt world"], { type: "text/plain" }),
      "note.txt",
    );
    expect(txt.mime).toBe("text/plain");
    expect(txt.pages).toEqual([{ page: 1, text: "hello txt world" }]);
    const md = await parser.parse(new Blob(["# Title\nbody"]), "note.MD");
    expect(md.mime).toBe("text/markdown");
    expect(md.pages).toEqual([{ page: 1, text: "# Title\nbody" }]);
  });

  it("unknown extension throws (fail-closed)", async () => {
    const parser = new DocumentParser();
    const blob = new Blob(["???"]);
    await expect(parser.parse(blob, "archive.xyz")).rejects.toThrow(/unsupported/i);
    await expect(parser.parse(blob, "noextension")).rejects.toThrow(/unsupported/i);
  });
});
