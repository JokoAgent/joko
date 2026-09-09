// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";
import { writeClipboardText } from "../clipboard-action.js";
import { TimelineMermaidBlock } from "./TimelineMermaidBlock.js";
import { renderMermaid } from "./mermaid-render.js";
import { copyMermaid } from "./mermaid-image-export.js";
import type { Translator } from "./types.js";

vi.mock("./mermaid-render.js", () => ({ renderMermaid: vi.fn(), mermaidDocumentTheme: (doc: Document) => doc.documentElement.dataset.theme === "dark" ? "dark" : "default" }));
vi.mock("./mermaid-image-export.js", () => ({ copyMermaid: vi.fn(), renderMermaidPng: vi.fn() }));
vi.mock("../clipboard-action.js", () => ({ writeClipboardText: vi.fn(async () => undefined) }));
let root: Root | undefined;
const t = ((key: string) => key) as Translator;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); });
afterEach(async () => { if (root !== undefined) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

it("keeps each SVG paired with its raw source and Document through replacement, copy, source view and theme changes", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  const win = iframe.contentWindow! as Window & typeof globalThis;
  Object.defineProperty(win, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  vi.spyOn(win, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(win, "cancelAnimationFrame").mockImplementation(() => undefined);
  const host = doc.body.appendChild(doc.createElement("div"));
  root = createRoot(host);
  const attempts: { source: string; theme: string; context: BrowserActionContext; result: ReturnType<typeof deferred<string>> }[] = [];
  vi.mocked(renderMermaid).mockImplementation((source, theme, context) => {
    const result = deferred<string>(); attempts.push({ source, theme, context, result }); return result.promise;
  });
  const copies: { context: BrowserActionContext; result: ReturnType<typeof deferred<void>> }[] = [];
  vi.mocked(copyMermaid).mockImplementation((_svg, _source, _card, context) => { const result = deferred<void>(); copies.push({ context, result }); return result.promise; });
  let source = "graph LR; A-->B";
  const render = () => act(async () => root!.render(<StrictMode><TimelineMermaidBlock ownerKey="task-1" source={source} t={t} /></StrictMode>));
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await render();
  const a = attempts.at(-1)!;
  expect(a.context.signal.aborted).toBe(false);
  expect(a.context.ownerDocument).toBe(doc);
  await act(async () => a.result.resolve('<svg xmlns="http://www.w3.org/2000/svg" id="A" viewBox="0 0 40 20"><text>A</text></svg>'));
  await act(async () => button("timeline.mermaidViewSource").click());
  await act(async () => { button("timeline.mermaidCopy").click(); button("timeline.mermaidCopy").click(); });
  expect(copyMermaid).toHaveBeenCalledTimes(1);
  expect(copyMermaid).toHaveBeenCalledWith(expect.stringContaining('id="A"'), source, expect.any(win.HTMLElement), copies[0]!.context);
  expect(writeClipboardText).not.toHaveBeenCalled();
  source = "graph LR; C-->D";
  await render();
  expect(a.context.signal.aborted).toBe(true);
  expect(copies[0]!.context.signal.aborted).toBe(true);
  expect(host.querySelector("svg[id='A']")).toBeNull();
  expect(button("timeline.mermaidZoom")).toBeNull();
  await act(async () => copies[0]!.result.resolve());
  expect(button("timeline.mermaidCopied")).toBeNull();
  await act(async () => button("timeline.mermaidCopy").click());
  expect(writeClipboardText).toHaveBeenCalledWith(source, expect.objectContaining({ ownerDocument: doc }));
  const b = attempts.at(-1)!;
  await act(async () => b.result.resolve('<svg xmlns="http://www.w3.org/2000/svg" id="B" viewBox="0 0 40 20"><text>B</text></svg>'));
  expect(button("timeline.mermaidCopied")).toBeNull();
  await act(async () => button("timeline.mermaidZoom").click());
  expect(doc.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(doc.querySelector(".workspace-mermaid-lightbox__card")?.shadowRoot?.querySelector("#B")).not.toBeNull();
  await act(async () => { doc.documentElement.dataset.theme = "dark"; });
  expect(doc.querySelector('[role="dialog"]')).toBeNull();
  expect(attempts.at(-1)!.theme).toBe("dark");
  expect(b.context.signal.aborted).toBe(true);
  await act(async () => win.dispatchEvent(new win.Event("pagehide")));
  const dark = attempts.at(-1)!;
  expect(dark.context.signal.aborted).toBe(true);
  await act(async () => dark.result.resolve('<svg id="retired"/>'));
  expect(host.querySelector("#retired")).toBeNull();
  await act(async () => win.dispatchEvent(new win.Event("pageshow")));
  expect(attempts.at(-1)).not.toBe(dark);
  expect(attempts.at(-1)!.context.signal.aborted).toBe(false);
});

it("shows parser failure with the unchanged source and allows source copying", async () => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  vi.mocked(renderMermaid).mockRejectedValue(new Error("Invalid statement."));
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<TimelineMermaidBlock ownerKey="task" source="unrecognized statement" t={t} />));
  expect(host.querySelector("pre")?.textContent).toBe("unrecognized statement");
  expect(host.querySelector(".timeline-mermaid__error")?.textContent).toBe("timeline.mermaidRenderFailed");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="timeline.mermaidCopy"]')!.click());
  expect(writeClipboardText).toHaveBeenCalledWith("unrecognized statement", expect.objectContaining({ ownerDocument: document }));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
