import { extractPdfPageText, PDF_PAGE_TEXT_MAX_CHARS, PDF_PAGE_TEXT_MAX_PAGES } from "@joko/tool-document";

type Result = { readonly content: readonly Record<string, unknown>[]; readonly isError: boolean };

/** Source-only native Read: bytes arrive after the original operation's file
 * lease has authorized them. The parser never receives a Host or Source path. */
export async function readHostedAgentClaudePdf(bytes: Buffer, pages: string | undefined, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  const supplied = pages !== undefined && pages.trim() !== "";
  const match = supplied ? /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/u.exec(pages) : undefined;
  if (supplied && !match) return result('Invalid pages parameter. Use a 1-indexed page or range, such as "3" or "1-5".', true);
  const first = match ? Number(match[1]) : 1, last = match ? Number(match[2] ?? match[1]) : PDF_PAGE_TEXT_MAX_PAGES;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return result("The PDF page range is invalid.", true);
  if (last - first + 1 > PDF_PAGE_TEXT_MAX_PAGES) return result(`Read at most ${PDF_PAGE_TEXT_MAX_PAGES} PDF pages per request. Use a smaller page range.`, true);
  try {
    const extracted = await extractPdfPageText(bytes, { first, last }, PDF_PAGE_TEXT_MAX_CHARS, { signal });
    signal.throwIfAborted();
    if (first > extracted.numPages) return result(`The PDF has ${extracted.numPages} page(s); page ${first} does not exist.`, true);
    const lastRead = Math.min(last, extracted.pagesInspected), notes = [
      `PDF: ${extracted.numPages} page(s). Text of pages ${first}-${lastRead} follows; images, layout and scanned pages are not included.`
    ];
    if (!supplied && extracted.numPages > lastRead) notes.push(`Use pages "${lastRead + 1}-${Math.min(extracted.numPages, lastRead + PDF_PAGE_TEXT_MAX_PAGES)}" to read more.`);
    if (extracted.clipped) notes.push("The text was cut off at the size limit; read a smaller page range to see the rest.");
    if (!extracted.sections.length) notes.push("These pages have no extractable text (they may be scanned images).");
    return result([notes.join(" "), ...extracted.sections].join("\n\n"));
  } catch { signal.throwIfAborted(); return result("PDF text could not be extracted on the task computer.", true); }
}
function result(text: string, isError = false): Result { return { content: [{ type: "text", text }], isError }; }
