// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";
import { TimelineCopyAsImageBlock } from "./TimelineCopyAsImageBlock.js";
import { copyTimelinePng, timelineDomToPng } from "./timeline-image-export.js";
import type { Translator } from "./types.js";

vi.mock("./timeline-image-export.js", () => ({ timelineDomToPng: vi.fn(), copyTimelinePng: vi.fn(async () => undefined) }));
let root: Root | undefined;
const t = ((key: string) => key) as Translator;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); });
afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("copies one captured text and PNG pair, keeps the trigger Document and suppresses retired source work", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const ownerDocument = iframe.contentDocument!;
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  root = createRoot(host);
  let source = "A";
  const attempts: { readonly text: string; readonly context: BrowserActionContext; readonly result: ReturnType<typeof deferred<Blob>> }[] = [];
  vi.mocked(timelineDomToPng).mockImplementation((node, context) => {
    const result = deferred<Blob>();
    attempts.push({ text: node.textContent!, context, result });
    return result.promise;
  });
  const render = () => act(async () => root!.render(<StrictMode><TimelineCopyAsImageBlock ownerKey="task" sourceKey={source} imageName="table.png" t={t} extractPlainText={(node) => node.textContent!}>
    <table><tbody><tr><td>{source}</td></tr></tbody></table>
  </TimelineCopyAsImageBlock></StrictMode>));
  const button = () => host.querySelector<HTMLButtonElement>("button")!;
  await render();
  button().focus();
  await act(async () => { button().click(); button().click(); });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.context.ownerDocument).toBe(ownerDocument);
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(false);
  source = "B";
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(true);
  await act(async () => button().click());
  await act(async () => attempts[0]!.result.resolve(new Blob(["old PNG"])));
  expect(copyTimelinePng).not.toHaveBeenCalled();
  expect(button().getAttribute("aria-busy")).toBe("true");
  const png = new Blob(["PNG B"]);
  // A later live DOM update must not change the text paired with an in-flight snapshot.
  host.querySelector("td")!.textContent = "later display";
  await act(async () => attempts[1]!.result.resolve(png));
  expect(copyTimelinePng).toHaveBeenCalledWith(png, "B", attempts[1]!.context);
  expect(button().getAttribute("aria-label")).toBe("timeline.blockCopied");
  expect(ownerDocument.activeElement).toBe(button());
  source = "C";
  await render();
  await act(async () => button().click());
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => attempts[2]!.result.resolve(new Blob(["closed PNG"])));
  expect(copyTimelinePng).toHaveBeenCalledTimes(1);
});

it("reports current raster failure and allows an explicit retry", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.mocked(timelineDomToPng).mockRejectedValueOnce(new Error("encoding failed")).mockResolvedValue(new Blob(["PNG"]));
  await act(async () => root!.render(<TimelineCopyAsImageBlock ownerKey="task" sourceKey="formula" imageName="formula.png" t={t}><span>Formula</span></TimelineCopyAsImageBlock>));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("timeline.blockCopyFailed");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(copyTimelinePng).toHaveBeenCalledWith(expect.any(Blob), undefined, expect.objectContaining({ ownerDocument: document }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

it("offers annotation only with image attachment capability and owns the generated preview through source replacement", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  const win = iframe.contentWindow! as Window & typeof globalThis;
  vi.spyOn(win, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(win, "cancelAnimationFrame").mockImplementation(() => undefined);
  const createUrl = vi.fn(() => "blob:generated-preview");
  const revokeUrl = vi.fn();
  Object.defineProperties(win.URL, {
    createObjectURL: { configurable: true, value: createUrl },
    revokeObjectURL: { configurable: true, value: revokeUrl }
  });
  const host = doc.body.appendChild(doc.createElement("div"));
  root = createRoot(host);
  let source = "table-a";
  let enabled = false;
  const send = vi.fn();
  const attempts: { context: BrowserActionContext; result: ReturnType<typeof deferred<Blob>> }[] = [];
  vi.mocked(timelineDomToPng).mockImplementation((_node, context) => {
    const result = deferred<Blob>();
    attempts.push({ context, result });
    return result.promise;
  });
  const render = () => act(async () => root!.render(<TimelineCopyAsImageBlock ownerKey="task" sourceKey={source} imageName="table.png" onSendToChat={enabled ? send : undefined} t={t}>Table</TimelineCopyAsImageBlock>));
  const annotate = () => host.querySelector<HTMLButtonElement>('button[aria-label="workspace.imageAnnotate"]');
  await render();
  expect(annotate()).toBeNull();
  enabled = true;
  await render();
  await act(async () => { annotate()!.click(); annotate()!.click(); });
  expect(attempts).toHaveLength(1);
  source = "table-b";
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(true);
  await act(async () => attempts[0]!.result.resolve(new Blob(["retired"])));
  expect(createUrl).not.toHaveBeenCalled();
  await act(async () => annotate()!.click());
  await act(async () => attempts[1]!.result.resolve(new Blob(["PNG"], { type: "image/png" })));
  expect(doc.querySelector('[role="dialog"][aria-label="table.png"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(doc.querySelector(".workspace-image-lightbox__image-wrap.is-annotating")).not.toBeNull();
  expect(attempts[1]!.context.ownerDocument).toBe(doc);
  source = "table-c";
  await render();
  expect(doc.querySelector('[role="dialog"]')).toBeNull();
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:generated-preview");
  await act(async () => annotate()!.click());
  await act(async () => win.dispatchEvent(new win.Event("pagehide")));
  await act(async () => attempts[2]!.result.resolve(new Blob(["hidden"])));
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await act(async () => annotate()!.click());
  const foreignFrame = document.body.appendChild(document.createElement("iframe"));
  foreignFrame.contentDocument!.body.appendChild(host);
  await act(async () => attempts[3]!.result.resolve(new Blob(["moved controls"])));
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(foreignFrame.contentDocument!.querySelector('[role="dialog"]')).toBeNull();
});
