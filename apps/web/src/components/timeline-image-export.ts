import { toSvg } from "html-to-image";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";

const MAX_EDGE = 4_096;
const MAX_PIXELS = MAX_EDGE * MAX_EDGE;
let snapshotSequence = 0;

export function timelineExportScale(width: number, height: number, desired = 2): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(desired, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

export function timelineTableToTsv(node: HTMLElement): string | undefined {
  const rows = [...node.querySelectorAll("tr")];
  if (rows.length === 0) return undefined;
  const cells = rows.map((row) => [...row.querySelectorAll<HTMLElement>("th, td")]);
  const mathematicalCells = new Set(cells.flat().filter((cell) =>
    [...cell.querySelectorAll(".katex")].some((math) => mathSource(math) !== undefined)));
  const format = (read: (cell: HTMLElement) => string): string => cells.map((row) => row
    .map((cell) => read(cell).replace(/\s*\n\s*/gu, " ").trim())
    .join("\t")).join("\n");
  if (mathematicalCells.size === 0) return format((cell) => cell.innerText);

  const ownerDocument = node.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Content is no longer available.");
  const clone = node.cloneNode(true) as HTMLElement;
  const originals = [node, ...node.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  const copiedCells = new Map<HTMLElement, HTMLElement>();
  originals.forEach((original, index) => {
    const copy = copies[index] as HTMLElement | SVGElement;
    if (copy.style !== undefined) copyStyle(ownerWindow.getComputedStyle(original), copy.style);
    if (mathematicalCells.has(original as HTMLElement)) copiedCells.set(original as HTMLElement, copy as HTMLElement);
  });
  for (const math of clone.querySelectorAll<HTMLElement>(".katex")) {
    const tex = mathSource(math);
    if (tex !== undefined) math.replaceChildren(ownerDocument.createTextNode(tex));
  }
  const staging = ownerDocument.createElement("div");
  staging.setAttribute("aria-hidden", "true");
  staging.inert = true;
  staging.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;contain:layout paint;";
  // A detached or display-none source uses innerText's textContent fallback.
  if (!node.isConnected) staging.style.display = "none";
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    if (ownerWindow.getComputedStyle(parent).display === "none") { staging.style.display = "none"; break; }
  }
  staging.append(clone);
  ownerDocument.body.append(staging);
  try {
    // Keep the clone attached for native br/visibility/white-space semantics.
    return format((cell) => copiedCells.get(cell)?.innerText ?? cell.innerText);
  } finally {
    staging.remove();
  }
}

export function timelineMathToLatex(node: HTMLElement): string | undefined {
  const tex = mathSource(node);
  return tex === undefined ? undefined : `$$\n${tex}\n$$`;
}

function mathSource(node: Element): string | undefined {
  const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
  return tex === undefined || tex.length === 0 ? undefined : tex;
}

function copyStyle(source: CSSStyleDeclaration, target: CSSStyleDeclaration): void {
  for (let index = 0; index < source.length; index += 1) {
    const name = typeof source.item === "function" ? source.item(index) : source[index]!;
    target.setProperty(name, source.getPropertyValue(name), source.getPropertyPriority(name));
  }
}

function fontFamilyNames(value: string): string[] {
  return [...value.matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/gu)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim().toLocaleLowerCase())
    .filter((name) => name.length > 0);
}

function fontFaceRules(rules: CSSRuleList, output: CSSFontFaceRule[]): void {
  for (const rule of rules) {
    if (rule.type === 5 && "style" in rule) {
      output.push(rule as CSSFontFaceRule);
      continue;
    }
    if ("cssRules" in rule) fontFaceRules((rule as CSSGroupingRule).cssRules, output);
  }
}

function selectedFontSource(value: string): { readonly url: string; readonly format?: string } | undefined {
  const sources = [...value.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\)]*?))\s*\)\s*(?:format\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\)]*?))\s*\))?/giu
  )].map((match) => ({
    url: (match[1] ?? match[2] ?? match[3] ?? "").trim(),
    format: (match[4] ?? match[5] ?? match[6])?.trim().toLocaleLowerCase()
  })).filter((source) => source.url.length > 0);
  return sources.find((source) => source.format === "woff2") ?? sources[0];
}

function fontMimeType(source: { readonly url: string; readonly format?: string }, response: Response): string {
  if (source.format === "woff2" || /\.woff2(?:$|[?#])/iu.test(source.url)) return "font/woff2";
  if (source.format === "woff" || /\.woff(?:$|[?#])/iu.test(source.url)) return "font/woff";
  if (source.format === "truetype" || /\.ttf(?:$|[?#])/iu.test(source.url)) return "font/ttf";
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
}

function dataUrl(bytes: ArrayBuffer, mimeType: string, ownerWindow: Window & typeof globalThis, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new ownerWindow.FileReader();
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const abort = (): void => {
      reader.abort();
      cleanup();
      reject(signal.reason);
    };
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (typeof result === "string") resolve(result);
      else reject(new Error("Font encoding failed."));
    };
    reader.onerror = () => {
      const error = reader.error ?? new Error("Font encoding failed.");
      cleanup();
      reject(error);
    };
    reader.onabort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(new ownerWindow.Blob([bytes], { type: mimeType }));
  });
}

/**
 * Embed only fonts used by the frozen snapshot without html-to-image's detached
 * <base> element. The packaged shell intentionally sets base-uri 'none'.
 */
async function timelineFontEmbedCss(
  fontFamilies: ReadonlySet<string>,
  ownerDocument: Document,
  signal: AbortSignal
): Promise<string> {
  const usedFamilies = new Set([...fontFamilies].flatMap(fontFamilyNames));
  if (usedFamilies.size === 0) return "";
  const rules: CSSFontFaceRule[] = [];
  for (const sheet of ownerDocument.styleSheets) {
    try {
      fontFaceRules((sheet as CSSStyleSheet).cssRules, rules);
    } catch {
      // Unreadable cross-origin styles cannot own fonts loaded by this origin.
    }
  }
  const ownerWindow = ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (ownerWindow === null) throw new Error("Content is no longer available.");
  const embedded = await Promise.all(rules
    .filter((rule) => fontFamilyNames(rule.style.getPropertyValue("font-family")).some((name) => usedFamilies.has(name)))
    .map(async (rule) => {
      signal.throwIfAborted();
      const source = selectedFontSource(rule.style.getPropertyValue("src"));
      if (source === undefined) return rule.cssText;
      let embeddedUrl = source.url;
      if (!embeddedUrl.startsWith("data:")) {
        const baseUrl = rule.parentStyleSheet?.href ?? ownerDocument.baseURI;
        const resourceUrl = new URL(embeddedUrl, baseUrl).href;
        const response = await abortable(ownerWindow.fetch(resourceUrl, { signal }), signal);
        if (!response.ok) throw new Error(`Font request failed (${response.status}).`);
        const bytes = await abortable(response.arrayBuffer(), signal);
        embeddedUrl = await dataUrl(bytes, fontMimeType(source, response), ownerWindow, signal);
      }
      const declaration = ownerDocument.createElement("span").style;
      copyStyle(rule.style, declaration);
      declaration.setProperty(
        "src",
        `url("${embeddedUrl}")${source.format === undefined ? "" : ` format("${source.format}")`}`,
        rule.style.getPropertyPriority("src")
      );
      return `@font-face{${declaration.cssText}}`;
    }));
  return embedded.join("\n");
}

function opaqueBackground(node: Element, ownerWindow: Window): string {
  for (let current: Element | null = node; current !== null; current = current.parentElement) {
    const color = ownerWindow.getComputedStyle(current).backgroundColor;
    if (color !== "" && color !== "transparent" && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/u.test(color)) return color;
  }
  return node.ownerDocument.documentElement.dataset.theme === "dark" ? "#1f1f1d" : "#ffffff";
}

/** Capture content and inherited presentation before fonts or encoding can yield. */
function captureContent(node: HTMLElement, context: BrowserActionContext) {
  assertBrowserActionCurrent(context);
  const { ownerDocument } = context;
  const ownerWindow = ownerDocument.defaultView!;
  if (node.ownerDocument !== ownerDocument || !node.isConnected) throw new Error("Content is no longer available.");
  const width = Math.ceil(node.scrollWidth);
  const height = Math.ceil(node.scrollHeight);
  if (width <= 0 || height <= 0) throw new Error("Content has no renderable size.");
  const backgroundColor = opaqueBackground(node, ownerWindow);
  const clone = node.cloneNode(true) as HTMLElement;
  const originals = [node, ...node.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  const fontFamilies = new Set<string>();
  const pseudoRules: string[] = [];
  const snapshotId = `timeline-export-${++snapshotSequence}`;
  originals.forEach((original, index) => {
    const copy = copies[index] as HTMLElement | SVGElement;
    if (copy.style === undefined) return;
    const computed = ownerWindow.getComputedStyle(original);
    copyStyle(computed, copy.style);
    if (computed.fontFamily !== "") fontFamilies.add(computed.fontFamily);
    copy.style.setProperty("animation", "none", "important");
    copy.style.setProperty("transition", "none", "important");
    for (const pseudo of ["::before", "::after"] as const) {
      const style = ownerWindow.getComputedStyle(original, pseudo);
      if (style.content === "" || style.content === "none" || style.content === "normal") continue;
      const selector = `${snapshotId}-${index}`;
      copy.setAttribute("data-timeline-export", selector);
      const declaration = ownerDocument.createElement("span").style;
      copyStyle(style, declaration);
      pseudoRules.push(`[data-timeline-export="${selector}"]${pseudo}{${declaration.cssText}}`);
    }
    if (original.localName === "img") {
      const image = original as HTMLImageElement;
      if (!image.complete || image.naturalWidth === 0) throw new Error("An image is still loading.");
      const canvas = ownerDocument.createElement("canvas");
      try {
        const scale = timelineExportScale(image.naturalWidth, image.naturalHeight, 1);
        canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
        const drawing = canvas.getContext("2d");
        if (drawing === null) throw new Error("Canvas is unavailable.");
        drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
        copy.setAttribute("src", canvas.toDataURL("image/png"));
        copy.removeAttribute("srcset");
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  });
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.overflow = "visible";
  clone.style.transform = "none";
  if (pseudoRules.length > 0) {
    const style = ownerDocument.createElement("style");
    style.textContent = pseudoRules.join("\n");
    clone.append(style);
  }
  const staging = ownerDocument.createElement("div");
  staging.setAttribute("aria-hidden", "true");
  staging.inert = true;
  staging.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;pointer-events:none;`;
  staging.append(clone);
  ownerDocument.body.append(staging);
  return { clone, staging, fontFamilies, width, height, backgroundColor };
}

function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}

export async function timelineDomToPng(node: HTMLElement, context: BrowserActionContext): Promise<Blob> {
  const captured = captureContent(node, context);
  const { ownerDocument, signal } = context;
  const image = ownerDocument.createElement("img");
  const canvas = ownerDocument.createElement("canvas");
  try {
    if (ownerDocument.fonts !== undefined) await abortable(ownerDocument.fonts.ready, signal);
    assertBrowserActionCurrent(context);
    // Font selection is per request and Document; a table cannot cache away a later formula's fonts.
    const fontEmbedCSS = await timelineFontEmbedCss(captured.fontFamilies, ownerDocument, signal);
    assertBrowserActionCurrent(context);
    const svg = await abortable(toSvg(captured.clone, {
      width: captured.width,
      height: captured.height,
      backgroundColor: captured.backgroundColor,
      fontEmbedCSS,
      fetchRequestInit: { signal }
    }), signal);
    assertBrowserActionCurrent(context);
    await abortable(new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image rendering failed."));
      image.src = svg;
    }), signal);
    assertBrowserActionCurrent(context);
    const scale = timelineExportScale(captured.width, captured.height);
    canvas.width = Math.max(1, Math.floor(captured.width * scale));
    canvas.height = Math.max(1, Math.floor(captured.height * scale));
    const drawing = canvas.getContext("2d");
    if (drawing === null) throw new Error("Canvas is unavailable.");
    drawing.fillStyle = captured.backgroundColor;
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await abortable(new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result === null ? reject(new Error("PNG encoding failed.")) : resolve(result), "image/png");
    }), signal);
    assertBrowserActionCurrent(context);
    return blob;
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    canvas.width = 0;
    canvas.height = 0;
    captured.staging.remove();
  }
}

export async function copyTimelinePng(blob: Blob, plainText: string | undefined, context: BrowserActionContext): Promise<void> {
  assertBrowserActionCurrent(context);
  const ownerWindow = context.ownerDocument.defaultView! as Window & typeof globalThis;
  if (ownerWindow.ClipboardItem === undefined || ownerWindow.navigator.clipboard?.write === undefined) throw new Error("Clipboard unavailable.");
  const item = new ownerWindow.ClipboardItem({
    "image/png": blob,
    ...(plainText === undefined ? {} : { "text/plain": new ownerWindow.Blob([plainText], { type: "text/plain" }) })
  });
  assertBrowserActionCurrent(context);
  await ownerWindow.navigator.clipboard.write([item]);
}
