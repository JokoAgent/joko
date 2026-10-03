// @vitest-environment jsdom
import { toSvg } from "html-to-image";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyTimelinePng, timelineDomToPng, timelineTableToTsv } from "./timeline-image-export.js";

vi.mock("html-to-image", () => ({ toSvg: vi.fn(async () => "data:image/svg+xml,test") }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it("extracts each formula once from an attached styled snapshot without mutating the selected table", () => {
  const fixture = createDocument();
  const node = fixture.doc.body.appendChild(fixture.doc.createElement("div"));
  node.innerHTML = '<table><tbody><tr><td class="math" style="white-space:pre-wrap">Before <span class="katex"><span class="katex-mathml"><math><semantics><mi>E</mi><annotation encoding="application/x-tex"> E=mc^2 </annotation></semantics></math></span><span class="katex-html">Duplicate E</span></span><br>second <span class="katex"><span class="katex-mathml"><math><semantics><mi>fraction</mi><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></span><span class="katex-html">Duplicate fraction</span></span> After<span style="display:none">Hidden</span></td><td class="plain">Alpha<br>Beta</td></tr></tbody></table>';
  const original = node.innerHTML;
  const text = node.querySelector("td")!.firstChild!;
  const selection = fixture.win.getSelection()!;
  const range = fixture.doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 6);
  selection.addRange(range);
  const observer = new fixture.win.MutationObserver(() => undefined);
  observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
  let failRead = false;
  // jsdom has no native innerText; Chrome separately verifies rendered text semantics.
  Object.defineProperty(fixture.win.HTMLElement.prototype, "innerText", { configurable: true, get(this: HTMLElement) {
    if (this.className === "plain") {
      expect(node.contains(this)).toBe(true);
      return "Alpha\nBeta";
    }
    expect(this.isConnected).toBe(true);
    expect(node.contains(this)).toBe(false);
    expect(this.ownerDocument).toBe(fixture.doc);
    expect(this.style.whiteSpace).toBe("pre-wrap");
    expect([...this.querySelectorAll(".katex")].map((math) => math.textContent)).toEqual(["E=mc^2", "\\frac{1}{2}"]);
    expect(this.querySelector(".katex-mathml, .katex-html, annotation")).toBeNull();
    expect((this.lastElementChild as HTMLElement).style.display).toBe("none");
    expect(this.closest<HTMLElement>('[aria-hidden="true"]')!.inert).toBe(true);
    if (failRead) throw new Error("read failed");
    return "Before E=mc^2\nsecond \\frac{1}{2} After";
  } });
  expect(timelineTableToTsv(node)).toBe("Before E=mc^2 second \\frac{1}{2} After\tAlpha Beta");
  failRead = true;
  expect(() => timelineTableToTsv(node)).toThrow("read failed");
  expect(fixture.doc.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(node.innerHTML).toBe(original);
  expect(selection.toString()).toBe("Before");
  expect(selection.anchorNode).toBe(text);
  expect(selection.focusNode).toBe(text);
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});

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
  expect(options).toEqual(expect.objectContaining({ fontEmbedCSS: "" }));
  const encode = fixture.encodes[0]!;
  expect(encode.canvas.ownerDocument).toBe(fixture.doc);
  expect([encode.canvas.width, encode.canvas.height]).toEqual([600, 240]);
  const png = new Blob(["PNG"], { type: "image/png" });
  encode.complete(png);
  expect(await result).toBe(png);
  expect(staging.isConnected).toBe(false);
  expect([encode.canvas.width, encode.canvas.height]).toEqual([0, 0]);
});

it("keeps the default raster scale and applies each per-request scale bound", async () => {
  const fixture = createDocument();
  const node = fixture.doc.body.appendChild(fixture.doc.createElement("div"));
  node.textContent = "Bounded export";
  node.style.fontFamily = "sans-serif";
  Object.defineProperties(node, {
    scrollWidth: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 200 }
  });
  const render = async (
    options: Parameters<typeof timelineDomToPng>[2],
    expectedSize: readonly [number, number]
  ): Promise<void> => {
    const encodeIndex = fixture.encodes.length;
    const result = timelineDomToPng(
      node,
      { ownerDocument: fixture.doc, signal: new AbortController().signal },
      options
    );
    await vi.waitFor(() => expect(fixture.encodes).toHaveLength(encodeIndex + 1));
    const encode = fixture.encodes[encodeIndex]!;
    expect([encode.canvas.width, encode.canvas.height]).toEqual(expectedSize);
    encode.complete(new Blob(["PNG"], { type: "image/png" }));
    await result;
  };

  await render(undefined, [600, 400]);
  await render({ desiredScale: 0.75, maximumEdgePixels: 2_000, maximumPixels: 1_000_000 }, [225, 150]);
  await render({ desiredScale: 3, maximumEdgePixels: 420, maximumPixels: 1_000_000 }, [420, 280]);
  await render({ desiredScale: 3, maximumEdgePixels: 2_000, maximumPixels: 30_000 }, [212, 141]);
});

it("rewrites snapshot DOM and SVG ids, local references and style selectors without mutating the source", async () => {
  const fixture = createDocument();
  const node = fixture.doc.body.appendChild(fixture.doc.createElement("div"));
  node.id = "message-card";
  node.innerHTML = `
    <span id="message-label" data-part="label">Rendered message</span>
    <span data-part="description" aria-labelledby="message-label external-label">Description</span>
    <svg viewBox="0 0 10 10">
      <defs>
        <linearGradient id="paint"><stop offset="1" stop-color="red"></stop></linearGradient>
        <clipPath id="clip"><rect width="10" height="10"></rect></clipPath>
        <style>#shape { fill: url(#paint); } .clipped { clip-path: url(#clip); }</style>
      </defs>
      <rect id="shape" data-part="shape" fill="url(#paint)" clip-path="url('#clip')"></rect>
      <use data-part="use" href="#shape"></use>
    </svg>`;
  Object.defineProperties(node, { scrollWidth: { value: 200 }, scrollHeight: { value: 100 } });

  const capture = async (): Promise<HTMLElement> => {
    const callIndex = vi.mocked(toSvg).mock.calls.length;
    const encodeIndex = fixture.encodes.length;
    const result = timelineDomToPng(node, { ownerDocument: fixture.doc, signal: new AbortController().signal });
    await vi.waitFor(() => expect(fixture.encodes).toHaveLength(encodeIndex + 1));
    const snapshot = vi.mocked(toSvg).mock.calls[callIndex]![0] as HTMLElement;
    fixture.encodes[encodeIndex]!.complete(new Blob(["PNG"], { type: "image/png" }));
    await result;
    return snapshot;
  };

  const first = await capture();
  const firstLabel = first.querySelector<HTMLElement>('[data-part="label"]')!;
  const firstDescription = first.querySelector<HTMLElement>('[data-part="description"]')!;
  const firstPaint = first.querySelector<SVGElement>("linearGradient")!;
  const firstClip = first.querySelector<SVGElement>("clipPath")!;
  const firstShape = first.querySelector<SVGElement>('[data-part="shape"]')!;
  const firstUse = first.querySelector<SVGElement>('[data-part="use"]')!;
  const firstIds = [first.id, firstLabel.id, firstPaint.id, firstClip.id, firstShape.id];
  expect(firstIds.every((id) => /^timeline-export-\d+-id-\d+$/u.test(id))).toBe(true);
  expect(new Set(firstIds).size).toBe(firstIds.length);
  expect(firstDescription.getAttribute("aria-labelledby")).toBe(`${firstLabel.id} external-label`);
  expect(firstShape.getAttribute("fill")).toBe(`url(#${firstPaint.id})`);
  expect(firstShape.getAttribute("clip-path")).toBe(`url('#${firstClip.id}')`);
  expect(firstUse.getAttribute("href")).toBe(`#${firstShape.id}`);
  expect(first.querySelector("style")!.textContent).toContain(`#${firstShape.id}`);
  expect(first.querySelector("style")!.textContent).toContain(`url(#${firstPaint.id})`);
  expect(first.querySelector("style")!.textContent).toContain(`url(#${firstClip.id})`);

  const second = await capture();
  expect(second.id).not.toBe(first.id);
  expect(second.querySelector<HTMLElement>('[data-part="label"]')!.id).not.toBe(firstLabel.id);
  expect(node.id).toBe("message-card");
  expect(node.querySelector<HTMLElement>('[data-part="label"]')!.id).toBe("message-label");
  expect(node.querySelector('[data-part="description"]')!.getAttribute("aria-labelledby")).toBe("message-label external-label");
  expect(node.querySelector('[data-part="shape"]')!.getAttribute("fill")).toBe("url(#paint)");
  expect(node.querySelector('[data-part="shape"]')!.getAttribute("clip-path")).toBe("url('#clip')");
  expect(node.querySelector('[data-part="use"]')!.getAttribute("href")).toBe("#shape");
});

it("embeds a used packaged font from its stylesheet URL without creating a CSP-blocked base element", async () => {
  const fixture = createDocument();
  const style = fixture.doc.head.appendChild(fixture.doc.createElement("style"));
  style.textContent = '@font-face{font-display:block;font-family:"KaTeX_Main";font-style:normal;font-weight:400;src:url("./font.woff2") format("woff2"),url("./font.ttf") format("truetype")}';
  Object.defineProperty(style.sheet!, "href", { configurable: true, value: "joko://app/assets/Timeline.css" });
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    headers: { get: () => "font/woff2" },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
  } as unknown as Response));
  Object.defineProperty(fixture.win, "fetch", { configurable: true, value: fetch });
  const result = timelineDomToPng(
    content(fixture.doc, "Formula", '"KaTeX_Main"'),
    { ownerDocument: fixture.doc, signal: new AbortController().signal }
  );
  await vi.waitFor(() => expect(fixture.encodes).toHaveLength(1));
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "joko://app/assets/font.woff2",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
  const options = vi.mocked(toSvg).mock.calls[0]![1]!;
  expect(options.fontEmbedCSS).toContain("@font-face");
  expect(options.fontEmbedCSS).toContain("data:font/woff2;base64,AQIDBA==");
  expect(options.fontEmbedCSS).toContain('format("woff2")');
  expect(options.fontEmbedCSS).not.toContain("font.ttf");
  expect(fixture.doc.querySelector("base")).toBeNull();
  fixture.encodes[0]!.complete(new Blob(["PNG"]));
  await result;
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
  expect((vi.mocked(toSvg).mock.calls[0]![0] as HTMLElement).ownerDocument).toBe(second.doc);
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
