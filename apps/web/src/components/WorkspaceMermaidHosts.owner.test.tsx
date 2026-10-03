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

it("pinches around two touch points, continues one-finger pan and retires every captured pointer", async () => {
  const trigger = document.body.appendChild(document.createElement("button"));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  let lifetime = new AbortController();
  let detail: WorkspaceMermaidOpenDetail = { svg, source: "A", returnFocus: trigger, signal: lifetime.signal, isCurrent: () => true };
  const render = () => act(async () => root.render(<WorkspaceMermaidLightbox ownerKey="task" detail={detail} labels={labels} annotationLabels={annotationLabels} onClose={() => undefined} />));
  await render();
  const surface = mermaidGestureSurface();

  pointer(surface.stage, "pointerdown", 1, 150, 150);
  pointer(surface.stage, "pointerdown", 2, 250, 150);
  expect(surface.captured).toEqual(new Set([1, 2]));
  pointer(surface.stage, "pointerdown", 3, 320, 180);
  pointer(surface.stage, "pointermove", 3, 390, 240);
  expect(surface.captured).toEqual(new Set([1, 2]));
  expect(surface.card.style.transform).toBe("translate(0px, 0px) scale(1)");

  pointer(surface.stage, "pointermove", 2, 350, 150);
  expect(surface.card.style.transform).toBe("translate(50px, 0px) scale(2)");
  act(() => surface.stage.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(surface.card.style.transform).toBe("translate(50px, 0px) scale(2)");
  pointer(surface.stage, "pointerup", 2, 350, 150);
  pointer(surface.stage, "pointermove", 1, 170, 160);
  expect(surface.card.style.transform).toBe("translate(70px, 10px) scale(2)");
  pointer(surface.stage, "pointercancel", 1, 170, 160);
  pointer(surface.stage, "pointermove", 1, 300, 260);
  expect(surface.card.style.transform).toBe("translate(70px, 10px) scale(2)");
  expect(surface.captured.size).toBe(0);

  pointer(surface.stage, "pointerdown", 4, 140, 150);
  pointer(surface.stage, "pointerdown", 5, 240, 150);
  expect(surface.captured).toEqual(new Set([4, 5]));
  pointer(surface.stage, "lostpointercapture", 4, 140, 150);
  expect(surface.captured.size).toBe(0);
  pointer(surface.stage, "pointermove", 5, 340, 150);
  expect(surface.card.style.transform).toBe("translate(70px, 10px) scale(2)");

  pointer(surface.stage, "pointerdown", 6, 140, 150);
  pointer(surface.stage, "pointerdown", 7, 240, 150);
  lifetime = new AbortController();
  detail = { ...detail, source: "B", signal: lifetime.signal };
  await render();
  expect(surface.captured.size).toBe(0);
  expect(surface.card.style.transform).toBe("translate(0px, 0px) scale(1)");
  pointer(surface.stage, "pointermove", 7, 340, 150);
  expect(surface.card.style.transform).toBe("translate(0px, 0px) scale(1)");
});

it("traps focus and closes only a stationary bare-backdrop gesture with explicit focus restoration", async () => {
  vi.useFakeTimers();
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, writable: true, value: vi.fn((callback: FrameRequestCallback) => { callback(0); return 1; }) });
  const trigger = document.body.appendChild(document.createElement("button"));
  const outside = document.body.appendChild(document.createElement("button"));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const onClose = vi.fn();
  let lifetime = new AbortController();
  let detail: WorkspaceMermaidOpenDetail = { svg, source: "A", returnFocus: trigger, signal: lifetime.signal, isCurrent: () => true };
  const render = () => act(async () => root.render(<WorkspaceMermaidLightbox ownerKey="task" detail={detail} labels={labels} annotationLabels={annotationLabels} onClose={onClose} />));
  trigger.focus();
  await render();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  expect(document.activeElement).toBe(document.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]'));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
  expect(document.activeElement).toBe(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'));

  const surface = mermaidGestureSurface();
  pointer(surface.stage, "pointerdown", 1, 100, 100);
  pointer(surface.stage, "pointerup", 1, 100, 100);
  pointer(surface.stage, "pointerdown", 2, 10, 10);
  pointer(surface.stage, "pointermove", 2, 30, 10);
  pointer(surface.stage, "pointerup", 2, 30, 10);
  pointer(surface.stage, "pointerdown", 3, 10, 20);
  pointer(surface.stage, "pointerdown", 4, 30, 20);
  pointer(surface.stage, "pointerup", 4, 30, 20);
  pointer(surface.stage, "pointerup", 3, 10, 20);
  await act(async () => vi.advanceTimersByTime(250));
  expect(onClose).not.toHaveBeenCalled();

  const beforeClose = surface.card.style.transform;
  pointer(surface.stage, "pointerdown", 5, 10, 10);
  pointer(surface.stage, "pointerup", 5, 10, 10);
  expect(surface.captured.size).toBe(0);
  act(() => surface.stage.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(surface.card.style.transform).toBe(beforeClose);
  await act(async () => vi.advanceTimersByTime(250));
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);

  lifetime = new AbortController();
  detail = { ...detail, source: "B", signal: lifetime.signal };
  await render();
  outside.focus();
  await act(async () => lifetime.abort());
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(outside);
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
function mermaidGestureSurface(ownerDocument: Document = document): { readonly stage: HTMLDivElement; readonly card: HTMLDivElement; readonly captured: Set<number> } {
  const stage = ownerDocument.querySelector<HTMLDivElement>(".workspace-mermaid-lightbox__stage")!;
  const card = ownerDocument.querySelector<HTMLDivElement>(".workspace-mermaid-lightbox__card")!;
  const stageRect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() { return {}; } };
  const cardRect = { left: 50, top: 50, width: 300, height: 200, right: 350, bottom: 250, x: 50, y: 50, toJSON() { return {}; } };
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(stageRect);
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(cardRect);
  const captured = new Set<number>();
  stage.setPointerCapture = (pointerId) => { captured.add(pointerId); };
  stage.hasPointerCapture = (pointerId) => captured.has(pointerId);
  stage.releasePointerCapture = (pointerId) => { captured.delete(pointerId); };
  return { stage, card, captured };
}
function pointer(target: HTMLElement, type: string, pointerId: number, clientX: number, clientY: number, pointerType = "touch"): void {
  const event = new target.ownerDocument.defaultView!.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType }, button: { value: 0 }, clientX: { value: clientX }, clientY: { value: clientY } });
  act(() => target.dispatchEvent(event));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
