// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { copyMermaid, renderMermaidPng } from "./mermaid-image-export.js";
import { copyTimelinePng, timelineDomToPng } from "./timeline-image-export.js";

vi.mock("./timeline-image-export.js", () => ({ timelineDomToPng: vi.fn(), copyTimelinePng: vi.fn(async () => undefined) }));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

it("exports an immutable SVG at natural size in its card Document and preserves the original source representation", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  const card = doc.body.appendChild(doc.createElement("div"));
  card.style.cssText = "width:1800px;height:900px;transform:scale(5);background-color:rgb(20, 30, 40);font-family:monospace";
  const request = new AbortController();
  const context = { ownerDocument: doc, signal: request.signal };
  const png = new Blob(["PNG"], { type: "image/png" });
  let captured!: HTMLElement;
  vi.mocked(timelineDomToPng).mockImplementation(async (node, action) => {
    captured = node;
    expect(action).toBe(context);
    expect(node.ownerDocument).toBe(doc);
    expect(node.style.width).toBe("81px");
    expect(node.style.height).toBe("31px");
    expect(node.style.backgroundColor).toBe("rgb(20, 30, 40)");
    expect(node.textContent).toBe("Original");
    expect(node.querySelector("svg")?.getAttribute("width")).toBe("81");
    return png;
  });
  await copyMermaid('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 80.5 30.5"><text>Original</text></svg>', "graph LR; raw source", card, context);
  expect(copyTimelinePng).toHaveBeenCalledExactlyOnceWith(png, "graph LR; raw source", context);
  expect(captured.isConnected).toBe(false);
  expect(doc.querySelector('[aria-hidden="true"]')).toBeNull();
});

it("cleans an aborted export immediately and never publishes a late raster or one from an adopted card", async () => {
  const card = document.body.appendChild(document.createElement("div"));
  const request = new AbortController();
  const context = { ownerDocument: document, signal: request.signal };
  let resolve!: (blob: Blob) => void;
  vi.mocked(timelineDomToPng).mockImplementation(() => new Promise<Blob>((accept) => { resolve = accept; }));
  const result = copyMermaid('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"/>', "raw", card, context).catch((error: unknown) => error);
  request.abort();
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  resolve(new Blob(["obsolete"]));
  await result;
  expect(copyTimelinePng).not.toHaveBeenCalled();
  const iframe = document.body.appendChild(document.createElement("iframe"));
  iframe.contentDocument!.body.append(card);
  await expect(renderMermaidPng('<svg viewBox="0 0 40 20"/>', card, { ownerDocument: document, signal: new AbortController().signal })).rejects.toThrow("no longer available");
});
