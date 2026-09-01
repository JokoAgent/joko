// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translator } from "./types.js";
import { TimelineCodeBlock } from "./TimelineCodeBlock.js";
import { TIMELINE_CODE_HIGHLIGHT_LIMIT, timelineCodeHighlight, timelineCodeLanguage, timelineCodeLanguageLabel } from "./timeline-code-highlighting.js";

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

  it("fails open to selectable plain text beyond the highlighting budget", () => {
    expect(timelineCodeHighlight("x".repeat(TIMELINE_CODE_HIGHLIGHT_LIMIT + 1), "typescript")).toEqual([]);
    expect(timelineCodeHighlight("const x = 1", "unknown-language")).toEqual([]);
  });

  it("shows a language label and copies the exact live source", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const source = "const value = 7;\n";
    act(() => root.render(<TimelineCodeBlock source={source} codeClassName="language-ts" t={t} />));
    expect(document.querySelector(".timeline-code-block__toolbar")?.textContent).toBe("TypeScript");
    expect(document.querySelector(".tok-keyword")?.textContent).toBe("const");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')?.click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(source);
    expect(document.querySelector<HTMLButtonElement>(".timeline-code-block__copy")?.ariaLabel).toBe("Code copied");
  });
});
