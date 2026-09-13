// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";
import { WorkspaceMermaidHosts, WorkspaceMermaidLightbox, type WorkspaceMermaidHostLabels } from "./WorkspaceMermaidHosts.js";
import { generatedImageAnnotationLabels } from "./GeneratedImageAnnotationButton.js";
import { renderMermaid } from "./mermaid-render.js";
import { copyMermaid, renderMermaidPng } from "./mermaid-image-export.js";
import { WORKSPACE_MERMAID_OPEN_EVENT, workspaceMarkdownMermaidExtensions, workspaceMarkdownMermaidThemeChanged, type WorkspaceMermaidOpenDetail } from "./workspace-markdown-mermaid.js";
import type { Translator } from "./types.js";

vi.mock("./mermaid-render.js", () => ({ renderMermaid: vi.fn(), mermaidDocumentTheme: () => "default" }));
vi.mock("./mermaid-image-export.js", () => ({ copyMermaid: vi.fn(), renderMermaidPng: vi.fn() }));
const roots: Root[] = [];
const views: EditorView[] = [];
const labels: WorkspaceMermaidHostLabels = { editTitle: "Edit diagram", source: "Source", cancel: "Cancel", apply: "Apply", targetMissing: "Target changed", zoomOut: "Zoom out", zoomIn: "Zoom in", copy: "Copy diagram", copied: "Copied", copyFailed: "Copy failed", close: "Close" };
const annotationLabels = generatedImageAnnotationLabels(((key: string) => key) as Translator);
const widgetLabels = { zoom: "Zoom", copy: "Copy diagram", copied: "Copied", copyFailed: "Copy failed", editSource: "Edit source", renderFailed: "Render failed: " };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 80 30"><text>Flow</text></svg>';
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); prepareWindow(window); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); for (const view of views.splice(0)) view.destroy(); });
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("routes real editor widgets only to their containing host, replaces themed renders and retains a changed-target edit draft", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  prepareWindow(iframe.contentWindow! as Window & typeof globalThis);
  const renders: BrowserActionContext[] = [];
  vi.mocked(renderMermaid).mockImplementation(async (_source, _theme, context) => { renders.push(context); return svg; });
  const pane = doc.body.appendChild(doc.createElement("section"));
  const otherPane = doc.body.appendChild(doc.createElement("section"));
  const editorHost = pane.appendChild(doc.createElement("div"));
  const host = pane.appendChild(doc.createElement("div"));
  const otherHost = otherPane.appendChild(doc.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const otherRoot = createRoot(otherHost); roots.push(otherRoot);
  await act(async () => {
    root.render(<WorkspaceMermaidHosts ownerKey="file-a" rootRef={{ current: pane }} labels={labels} annotationLabels={annotationLabels} />);
    otherRoot.render(<WorkspaceMermaidHosts ownerKey="file-b" rootRef={{ current: otherPane }} labels={labels} annotationLabels={annotationLabels} />);
  });
  const view = new EditorView({ parent: editorHost, state: EditorState.create({ doc: "```mermaid\ngraph LR; A-->B\n```", extensions: workspaceMarkdownMermaidExtensions(widgetLabels) }) });
  views.push(view);
  await act(async () => undefined);
  const click = (label: string) => act(async () => pane.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await click("Zoom");
  expect(doc.querySelectorAll(".workspace-mermaid-lightbox")).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // A Window event has no editor authority, even when its payload names a real trigger.
  const trigger = pane.querySelector<HTMLElement>(".cm-md-mermaid-card")!;
  await act(async () => doc.defaultView!.dispatchEvent(new doc.defaultView!.CustomEvent(WORKSPACE_MERMAID_OPEN_EVENT, {
    detail: { svg, source: "forged", returnFocus: trigger, signal: new AbortController().signal, isCurrent: () => true }
  })));
  expect(doc.querySelectorAll(".workspace-mermaid-lightbox")).toHaveLength(1);
  await click("Edit source");
  expect(doc.querySelector(".workspace-mermaid-lightbox")).toBeNull();
  const textarea = doc.querySelector<HTMLTextAreaElement>("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(textarea, "graph LR; User-->Draft"); textarea.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true })); });
  expect(textarea.value).toBe("graph LR; User-->Draft");
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "```mermaid\ngraph LR; New-->Source\n```" } }));
  expect(renders[0]!.signal.aborted).toBe(true);
  expect(textarea.isConnected).toBe(true);
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply")!.click());
  expect(doc.querySelector('.workspace-mermaid-source-modal__error')?.textContent).toBe("Target changed");
  expect(view.state.doc.toString()).toContain("New-->Source");
  expect(textarea.value).toContain("User-->Draft");
  const beforeTheme = renders.at(-1)!;
  await act(async () => view.dispatch({ effects: workspaceMarkdownMermaidThemeChanged.of(undefined) }));
  expect(beforeTheme.signal.aborted).toBe(true);
  expect(renders.at(-1)).not.toBe(beforeTheme);
  await act(async () => doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("pagehide")));
  expect(doc.querySelector('[role="dialog"]')).toBeNull();
  const hidden = renders.at(-1)!;
  expect(hidden.signal.aborted).toBe(true);
  await act(async () => doc.defaultView!.dispatchEvent(new doc.defaultView!.Event("pageshow")));
  expect(renders.at(-1)).not.toBe(hidden);
  expect(renders.at(-1)!.signal.aborted).toBe(false);
  await click("Zoom");
  expect(doc.querySelector(".workspace-mermaid-lightbox")).not.toBeNull();
  await click("Edit source");
  expect(doc.querySelector("textarea")?.value).toContain("New-->Source");
  const reopened = doc.querySelector<HTMLTextAreaElement>("textarea")!;
  const editTrigger = pane.querySelector<HTMLButtonElement>('button[aria-label="Edit source"]')!;
  await act(async () => reopened.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  expect(doc.querySelector("textarea")).toBeNull();
  expect(doc.activeElement).toBe(editTrigger);
  await click("Edit source");
  const currentText = doc.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { setValue.call(currentText, "graph LR; Saved-->Diagram"); currentText.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true })); });
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply")!.click());
  expect(view.state.doc.toString()).toContain("Saved-->Diagram");
  expect(doc.querySelector("textarea")).toBeNull();
  expect(doc.activeElement).toBe(view.contentDOM);
  await click("Edit source");
  const retiredTrigger = pane.querySelector<HTMLButtonElement>('button[aria-label="Edit source"]')!;
  const restoreOld = vi.spyOn(retiredTrigger, "focus");
  await act(async () => root.render(<WorkspaceMermaidHosts ownerKey="replacement-file" rootRef={{ current: pane }} labels={labels} annotationLabels={annotationLabels} />));
  expect(retiredTrigger.isConnected).toBe(true);
  expect(restoreOld).not.toHaveBeenCalled();
  expect(doc.querySelector("textarea")).toBeNull();
});

it("fences lightbox copies and close timers, ignores IME Escape and restores only explicit close focus in the owning Document", async () => {
  vi.useFakeTimers();
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  const win = iframe.contentWindow! as Window & typeof globalThis;
  prepareWindow(win);
  const trigger = doc.body.appendChild(doc.createElement("button"));
  const host = doc.body.appendChild(doc.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const attempts: { context: BrowserActionContext; result: ReturnType<typeof deferred<void>> }[] = [];
  vi.mocked(copyMermaid).mockImplementation((_svg, _source, _card, context) => { const result = deferred<void>(); attempts.push({ context, result }); return result.promise; });
  const onClose = vi.fn();
  let lifetime = new AbortController();
  let detail: WorkspaceMermaidOpenDetail = { svg, source: "A", returnFocus: trigger, signal: lifetime.signal, isCurrent: () => true };
  const render = () => act(async () => root.render(<WorkspaceMermaidLightbox ownerKey="task" detail={detail} labels={labels} annotationLabels={annotationLabels} onClose={onClose} />));
  const button = (label: string) => doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await render();
  await act(async () => { button("Copy diagram").click(); button("Copy diagram").click(); });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.context.ownerDocument).toBe(doc);
  await act(async () => button("Close").click());
  expect(attempts[0]!.context.signal.aborted).toBe(true);
  lifetime = new AbortController();
  detail = { ...detail, source: "B", signal: lifetime.signal };
  await render();
  await act(async () => { vi.advanceTimersByTime(250); attempts[0]!.result.resolve(); });
  expect(onClose).not.toHaveBeenCalled();
  expect(button("Copied")).toBeNull();
  const dialog = doc.querySelector<HTMLElement>('[role="dialog"]')!;
  dialog.focus();
  await act(async () => dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  await act(async () => vi.advanceTimersByTime(250));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => dialog.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => vi.advanceTimersByTime(250));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(doc.activeElement).toBe(trigger);
});

it("hands a prepared diagram to one annotation surface and retires the owned image URL on close", async () => {
  const url = vi.fn(() => "blob:diagram-preview");
  const revoke = vi.fn();
  Object.defineProperties(window.URL, { createObjectURL: { configurable: true, value: url }, revokeObjectURL: { configurable: true, value: revoke } });
  vi.mocked(renderMermaidPng).mockResolvedValue(new Blob(["PNG"], { type: "image/png" }));
  const trigger = document.body.appendChild(document.createElement("button"));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const detail = { svg, source: "A", returnFocus: trigger, signal: new AbortController().signal, isCurrent: () => true };
  const onClose = vi.fn();
  await act(async () => root.render(<WorkspaceMermaidLightbox ownerKey="task" detail={detail} labels={labels} annotationLabels={annotationLabels} onSendToChat={vi.fn()} onClose={onClose} />));
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="workspace.imageAnnotate"]')!.click());
  expect(document.querySelector<HTMLElement>(".workspace-mermaid-lightbox")!.style.display).toBe("none");
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  expect(document.querySelector(".workspace-image-lightbox__image-wrap.is-annotating")).not.toBeNull();
  expect(renderMermaidPng).toHaveBeenCalledWith(svg, expect.any(HTMLElement), expect.objectContaining({ ownerDocument: document }));
  await act(async () => root.unmount()); roots.pop();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:diagram-preview");
});

function prepareWindow(win: Window & typeof globalThis): void {
  Object.defineProperty(win, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  Object.defineProperty(win, "requestAnimationFrame", { configurable: true, writable: true, value: vi.fn(() => 1) });
  Object.defineProperty(win, "cancelAnimationFrame", { configurable: true, writable: true, value: vi.fn() });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
