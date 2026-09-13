// @vitest-environment jsdom
import { getFontEmbedCSS, toSvg } from "html-to-image";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyTimelinePng, timelineDomToPng } from "./timeline-image-export.js";

vi.mock("html-to-image", () => ({ getFontEmbedCSS: vi.fn(async () => ""), toSvg: vi.fn(async () => "data:image/svg+xml,test") }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it("freezes source content, inherited style, dimensions and fonts before awaiting the originating Document", async () => {
  const fixture = createDocument();
  const fontReady = deferred<FontFaceSet>();
  Object.defineProperty(fixture.doc, "fonts", { configurable: true, value: { ready: fontReady.promise } });
  const node = fixture.doc.body.appendChild(fixture.doc.createElement("div"));
  node.innerHTML = '<span style="font-family:&quot;KaTeX_Main&quot;;color:rgb(255, 0, 0)">Formula A</span>';
  Object.defineProperties(node, { scrollWidth: { value: 300 }, scrollHeight: { value: 120 } });
  const result = timelineDomToPng(node, { ownerDocument: fixture.doc, signal: new AbortController().signal });
  const staging = fixture.doc.querySelector<HTMLElement>('[aria-hidden="true"]')!;
  expect(staging.inert).toBe(true);
  expect(staging.textContent).toBe("Formula A");
  node.firstElementChild!.textContent = "Formula B";
  (node.firstElementChild as HTMLElement).style.color = "blue";
  fontReady.resolve({} as FontFaceSet);
  await vi.waitFor(() => expect(fixture.encodes).toHaveLength(1));
  const [snapshot, options] = vi.mocked(toSvg).mock.calls[0]!;
  expect(snapshot.ownerDocument).toBe(fixture.doc);
  expect(snapshot.textContent).toBe("Formula A");
  expect((snapshot.firstElementChild as HTMLElement).style.color).toBe("rgb(255, 0, 0)");
  expect(options).toEqual(expect.objectContaining({ width: 300, height: 120 }));
  expect(vi.mocked(getFontEmbedCSS).mock.calls[0]![0].style.fontFamily).toContain("KaTeX_Main");
  const encode = fixture.encodes[0]!;
  expect(encode.canvas.ownerDocument).toBe(fixture.doc);
  expect([encode.canvas.width, encode.canvas.height]).toEqual([600, 240]);
  const png = new Blob(["PNG"], { type: "image/png" });
  encode.complete(png);
  expect(await result).toBe(png);
  expect(staging.isConnected).toBe(false);
  expect([encode.canvas.width, encode.canvas.height]).toEqual([0, 0]);
});

it("cancels preparation promptly, cleans its snapshot and selects fonts separately in another Document", async () => {
  const first = createDocument();
  const fontReady = deferred<FontFaceSet>();
  Object.defineProperty(first.doc, "fonts", { configurable: true, value: { ready: fontReady.promise } });
  const request = new AbortController();
  const result = timelineDomToPng(content(first.doc, "Table", "sans-serif"), { ownerDocument: first.doc, signal: request.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  request.abort();
  await rejected;
  expect(first.doc.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(toSvg).not.toHaveBeenCalled();
  fontReady.resolve({} as FontFaceSet);
  const second = createDocument();
  const fresh = timelineDomToPng(content(second.doc, "Formula", '"KaTeX_Main"'), { ownerDocument: second.doc, signal: new AbortController().signal });
  await vi.waitFor(() => expect(second.encodes).toHaveLength(1));
  expect(vi.mocked(getFontEmbedCSS).mock.calls[0]![0].ownerDocument).toBe(second.doc);
  second.encodes[0]!.complete(new Blob(["PNG"]));
  await fresh;
  expect(first.encodes).toHaveLength(0);
});

it("cancels a pending canvas encode and never publishes its late bytes", async () => {
  const fixture = createDocument();
  const request = new AbortController();
  const result = timelineDomToPng(content(fixture.doc, "Table", "sans-serif"), { ownerDocument: fixture.doc, signal: request.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(fixture.encodes).toHaveLength(1));
  request.abort();
  await rejected;
  fixture.encodes[0]!.complete(new Blob(["late PNG"]));
  expect(fixture.doc.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(fixture.encodes[0]!.canvas.width).toBe(0);
});

it("writes PNG and exact source together to the initiating clipboard, with no dispatch for a cancelled action", async () => {
  const fixture = createDocument();
  const write = vi.fn(async (_items: readonly ClipboardItem[]) => undefined);
  Object.defineProperty(fixture.win.navigator, "clipboard", { configurable: true, value: { write } });
  class ClipboardItemFixture {
    constructor(readonly values: Record<string, Blob>) {}
  }
  Object.defineProperty(fixture.win, "ClipboardItem", { configurable: true, value: ClipboardItemFixture });
  const request = new AbortController();
  const context = { ownerDocument: fixture.doc, signal: request.signal };
  const png = new Blob(["PNG"]);
  await copyTimelinePng(png, "$$\nx^2\n$$", context);
  const item = write.mock.calls[0]![0][0] as unknown as ClipboardItemFixture;
  expect(item.values["image/png"]).toBe(png);
  expect(item.values["text/plain"]?.type).toBe("text/plain");
  expect(await readBlob(item.values["text/plain"]!, fixture.win)).toBe("$$\nx^2\n$$");
  request.abort();
  await expect(copyTimelinePng(png, "retired", context)).rejects.toMatchObject({ name: "AbortError" });
  expect(write).toHaveBeenCalledTimes(1);
});

function content(doc: Document, text: string, font: string) {
  const node = doc.body.appendChild(doc.createElement("div"));
  node.textContent = text;
  node.style.fontFamily = font;
  Object.defineProperties(node, { scrollWidth: { value: 200 }, scrollHeight: { value: 100 } });
  return node;
}

function createDocument() {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  const win = iframe.contentWindow! as Window & typeof globalThis;
  const computed = win.getComputedStyle.bind(win);
  vi.spyOn(win, "getComputedStyle").mockImplementation((node, pseudo) => pseudo ? doc.createElement("span").style : computed(node));
  vi.spyOn(win.HTMLImageElement.prototype, "src", "set").mockImplementation(function (this: HTMLImageElement) {
    queueMicrotask(() => this.dispatchEvent(new win.Event("load")));
  });
  vi.spyOn(win.HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" } as any);
  const encodes: { readonly canvas: HTMLCanvasElement; readonly complete: BlobCallback }[] = [];
  vi.spyOn(win.HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, complete) { encodes.push({ canvas: this, complete }); });
  return { doc, win, encodes };
}

function readBlob(blob: Blob, win: Window & typeof globalThis): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
