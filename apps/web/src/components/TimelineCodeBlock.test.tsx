// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translator } from "./types.js";
import { TimelineCodeBlock } from "./TimelineCodeBlock.js";
import { TIMELINE_CODE_HIGHLIGHT_LIMIT, timelineCodeHighlight, timelineCodeLanguage, timelineCodeLanguageLabel } from "./timeline-code-highlighting.js";
import { TIMELINE_MARKDOWN_DIFF_ROW_LIMIT } from "./TimelineMarkdownDiffRows.js";

const roots: Root[] = [];
const t = ((key: string) => ({
  "timeline.copyCode": "Copy code",
  "timeline.codeCopied": "Code copied",
  "timeline.codeCopyFailed": "Could not copy code",
  "timeline.codePlainText": "Plain text"
}[key] ?? key)) as Translator;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("timeline fenced code", () => {
  it("normalizes language aliases and highlights with the installed parser", () => {
    expect(timelineCodeLanguage("hljs language-ts extra")).toBe("typescript");
    expect(timelineCodeLanguageLabel("typescript", "Plain text")).toBe("TypeScript");
    const tokens = timelineCodeHighlight("const answer: number = 42;", "typescript");
    expect(tokens.some((token) => token.className.includes("tok-keyword"))).toBe(true);
    expect(tokens.some((token) => token.className.includes("tok-number"))).toBe(true);
  });

  it("keeps complete selectable source beyond the highlighting or diff row budget", async () => {
    expect(timelineCodeHighlight("x".repeat(TIMELINE_CODE_HIGHLIGHT_LIMIT + 1), "typescript")).toEqual([]);
    expect(timelineCodeHighlight("const x = 1", "unknown-language")).toEqual([]);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    for (const source of ["+ " + "x".repeat(TIMELINE_CODE_HIGHLIGHT_LIMIT), "+ line\n".repeat(TIMELINE_MARKDOWN_DIFF_ROW_LIMIT + 1)]) {
      await act(async () => root.render(<TimelineCodeBlock ownerKey="task" source={source} codeClassName="language-diff" t={t} />));
      expect(host.querySelector(".timeline-markdown-diff__row")).toBeNull();
      expect(host.querySelector("pre code")?.textContent).toBe(source);
      await act(async () => host.querySelector<HTMLButtonElement>(".timeline-code-block__copy")!.click());
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(source);
    }
  });

  it("shows a language label and copies the exact live source", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const source = "const value = 7;\n";
    act(() => root.render(<TimelineCodeBlock ownerKey="task" source={source} codeClassName="language-ts" t={t} />));
    expect(document.querySelector(".timeline-code-block__toolbar")?.textContent).toBe("TypeScript");
    expect(document.querySelector(".tok-keyword")?.textContent).toBe("const");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')?.click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(source);
    expect(document.querySelector<HTMLButtonElement>(".timeline-code-block__copy")?.ariaLabel).toBe("Code copied");
    const diffSource = "\r\n--- a/example.ts\r\n+++ b/example.ts\r\n@@ -1,3 +1,3 @@\r\n context\r\n- old\r\n+  indented\r\n\r\n+\r\n-\r\n tail\r\n";
    await act(async () => root.render(<TimelineCodeBlock ownerKey="task" source={diffSource} codeClassName="language-diff" t={t} />));
    expect(host.querySelector(".timeline-code-block__toolbar")?.textContent).toBe("Diff");
    expect(host.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
    const rows = [...host.querySelectorAll(".timeline-markdown-diff__row")];
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.querySelector(".timeline-markdown-diff__number")?.textContent))
      .toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(rows.map((row) => row.querySelector(".timeline-markdown-diff__sign")?.textContent))
      .toEqual([" ", " ", " ", " ", "-", "+", " ", "+", "-", " "]);
    expect(rows.slice(0, 4).every((row) => row.classList.contains("timeline-markdown-diff__row--context"))).toBe(true);
    expect(rows[4]?.classList.contains("timeline-markdown-diff__row--removed")).toBe(true);
    expect(rows[5]?.classList.contains("timeline-markdown-diff__row--added")).toBe(true);
    expect(rows[5]?.querySelector(".timeline-markdown-diff__text")?.textContent).toBe(" indented\n");
    expect(rows[0]?.querySelector(".timeline-markdown-diff__number")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>(".timeline-code-block__copy")!.click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(diffSource);
    await act(async () => root.render(<TimelineCodeBlock ownerKey="task" source="" codeClassName="language-diff" t={t} />));
    expect(host.querySelector(".timeline-markdown-diff__row")).toBeNull();
  });

  it("copies streaming code in its mounted Document and keeps an older acknowledgement out of the new source", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const ownerDocument = frame.contentDocument!;
    let finishOld!: () => void;
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; })).mockResolvedValue(undefined);
    Object.defineProperty(ownerDocument.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText } });
    const root = createRoot(ownerDocument.body.appendChild(ownerDocument.createElement("div")));
    roots.push(root);
    const render = (source: string) => act(async () => root.render(<TimelineCodeBlock ownerKey="task" source={source} codeClassName="language-diff" t={t} />));
    await render("first");
    const button = () => ownerDocument.querySelector<HTMLButtonElement>(".timeline-code-block__copy")!;
    button().focus();
    await act(async () => { button().click(); button().click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("first");
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(ownerDocument.activeElement).toBe(button());
    await render("second");
    await act(async () => finishOld());
    expect(button().ariaLabel).toBe("Copy code");
    await act(async () => button().click());
    expect(writeText).toHaveBeenLastCalledWith("second");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    Object.defineProperty(ownerDocument.defaultView!.navigator, "clipboard", { configurable: true, value: undefined });
    await act(async () => button().click());
    expect(ownerDocument.querySelector('[role="alert"]')?.textContent).toBe("Could not copy code");
  });
});
