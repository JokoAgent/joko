import { describe, expect, it } from "vitest";
import { extractPdfPageText, extractPdfText } from "@joko/tool-document";
import { readHostedAgentClaudePdf } from "./hosted-agent-claude-pdf.js";

describe("Claude Source PDF text", () => {
  it("extracts a bounded twenty-page range, including later pages, through the actual isolated parser", async () => {
    const bytes = textPdf(Array.from({ length: 50 }, (_, index) => "Source page " + (index + 1))), signal = new AbortController().signal;
    const first = await readHostedAgentClaudePdf(bytes, undefined, signal);
    expect(first).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("--- Page 20 ---") }] });
    expect(JSON.stringify(first)).not.toContain("--- Page 21 ---");
    const later = await readHostedAgentClaudePdf(bytes, "42-43", signal);
    expect(later).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("Source page 42") }] });
    expect(JSON.stringify(later)).not.toContain("Source page 41");
    expect(await readHostedAgentClaudePdf(bytes, "1-21", signal)).toMatchObject({ isError: true });
    expect(await readHostedAgentClaudePdf(bytes, "51", signal)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("50 page(s)") }] });
    expect(await readHostedAgentClaudePdf(bytes, "invalid", signal)).toMatchObject({ isError: true });
    const clipped = await extractPdfPageText(bytes, { first: 42, last: 43 }, 24);
    expect(clipped).toMatchObject({ clipped: true, pagesInspected: 42 }); expect(clipped.sections.join("\n\n").length).toBeLessThanOrEqual(24);
    const ordinary = await extractPdfText(bytes, 48_000);
    expect(ordinary.pagesInspected).toBe(40); expect(ordinary.sections).toHaveLength(40);
    const abort = new AbortController(); abort.abort(); await expect(readHostedAgentClaudePdf(bytes, "1", abort.signal)).rejects.toThrow();
  }, 20_000);
});

function textPdf(pages: readonly string[]): Buffer {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"], pageIds: number[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  for (const text of pages) {
    const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`, content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>"; objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let output = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length; output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}
