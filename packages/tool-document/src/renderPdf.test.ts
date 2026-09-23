import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderPdf, type PdfRenderRequest, type PdfRenderer } from "./index.js";

it("snapshots task-local HTML resources and applies print defaults without leaking external reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-render-pdf-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-render-pdf-outside-"));
  const seen: PdfRenderRequest[] = [];
  const renderer: PdfRenderer = { render: async request => {
    seen.push(request);
    return { buffer: Buffer.from("%PDF-1.4\nfixture"), fontsReady: true };
  } };
  try {
    await mkdir(join(root, "doc", "styles"), { recursive: true });
    await mkdir(join(root, "doc", "img"));
    await writeFile(join(root, "doc", "img", "pixel.png"), Buffer.from([137, 80, 78, 71, 1, 2]));
    await writeFile(join(root, "doc", "styles", "theme.css"), "h1 { color: navy; }");
    await writeFile(join(root, "doc", "styles", "main.css"), '@import "theme.css"; .hero { background: url("../img/pixel.png"); }');
    await writeFile(join(root, "doc", "report.html"), '<html><head><title>Quarterly report</title><link rel="stylesheet" href="styles/main.css"></head><body><h1>Results</h1><img src="img/pixel.png"></body></html>');
    const result = await renderPdf({ htmlPath: "doc/report.html" }, root, renderer);
    expect(result).toMatchObject({ pageSize: "A4", landscape: false, fontsReady: true,
      templateApplied: false, title: "Quarterly report" });
    expect(seen[0]).toMatchObject({ pageSize: "A4", landscape: false, printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, timeoutMs: 30_000, fontTimeoutMs: 5_000 });
    expect(seen[0]!.html).toContain("data:text/css;base64,");
    expect(seen[0]!.html).toContain("data:image/png;base64,");
    expect(seen[0]!.html).not.toContain('href="styles/main.css"');
    expect(seen[0]!.html).not.toContain('src="img/pixel.png"');
    const stylesheet = seen[0]!.html.match(/href="data:text\/css;base64,([^"]+)"/)?.[1];
    expect(stylesheet).toBeDefined();
    const css = Buffer.from(stylesheet!, "base64").toString("utf8");
    expect(css).toContain("data:text/css;base64,");
    expect(css).toContain("data:image/png;base64,");
    expect(css).not.toContain("theme.css");
    expect(css).not.toContain("../img/pixel.png");
    const unstyled = await renderPdf({ html: "<h1>Summary</h1><table><tr><td>42</td></tr></table>", theme: "navy" }, root, renderer);
    expect(unstyled).toMatchObject({ templateApplied: true, theme: "navy", title: "Summary" });
    expect(seen[1]).toMatchObject({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    expect(seen[1]!.html).toContain('data-joko-document-template="report"');
    expect(seen[1]!.html).toContain("#1F4E79");
    await renderPdf({ html: "<style>body{color:red}</style><p>Styled</p>", template: "auto",
      pageSize: "Letter", landscape: true, printBackground: false,
      margins: { top: 0.5 } }, root, renderer);
    expect(seen[2]).toMatchObject({ pageSize: "Letter", landscape: true, printBackground: false,
      margins: { top: 0.5, bottom: 0.4, left: 0.4, right: 0.4 } });
    expect(seen[2]!.html).not.toContain('data-joko-document-template="report"');
    await expect(renderPdf({ html: "<p>One</p>", htmlPath: "doc/report.html" }, root, renderer))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(renderPdf({ html: "<p>One</p>", typo: true }, root, renderer))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(renderPdf({ html: "<img src='https://example.invalid/a.png'>" }, root, renderer))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(renderPdf({ html: "<img src='file:///private/a.png'>" }, root, renderer))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(renderPdf({ html: '<style>@import url("https://example.invalid/remote.css");</style>' }, root, renderer))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(renderPdf({ htmlPath: "../outside.html" }, root, renderer))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await writeFile(join(root, "doc", "wrong.txt"), "<p>Wrong extension</p>");
    await expect(renderPdf({ htmlPath: "doc/wrong.txt" }, root, renderer))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await writeFile(join(root, "doc", "oversized.html"), Buffer.alloc(0));
    await truncate(join(root, "doc", "oversized.html"), 16 * 1024 * 1024 + 1);
    await expect(renderPdf({ htmlPath: "doc/oversized.html" }, root, renderer))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await writeFile(join(root, "doc", "img", "large.png"), Buffer.alloc(0));
    await truncate(join(root, "doc", "img", "large.png"), 8 * 1024 * 1024 + 1);
    await expect(renderPdf({ html: '<img src="doc/img/large.png">' }, root, renderer))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await writeFile(join(outside, "private.png"), Buffer.from([1, 2, 3]));
    await symlink(outside, join(root, "doc", "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(renderPdf({ html: '<img src="doc/linked/private.png">' }, root, renderer))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(renderPdf({ html: "<p>Stop</p>" }, root, renderer, cancelled.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
