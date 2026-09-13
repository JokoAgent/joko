import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import { copyTimelinePng, timelineDomToPng } from "./timeline-image-export.js";

/** Rasterize at the diagram's natural size, independently of lightbox pan or zoom. */
export async function renderMermaidPng(svg: string, card: HTMLElement, context: BrowserActionContext): Promise<Blob> {
  assertBrowserActionCurrent(context);
  const { ownerDocument, signal } = context;
  const ownerWindow = ownerDocument.defaultView!;
  const current = (): void => {
    assertBrowserActionCurrent(context);
    if (!card.isConnected || card.ownerDocument !== ownerDocument) throw new Error("Diagram is no longer available.");
  };
  current();
  const content = ownerDocument.createElement("div");
  content.innerHTML = svg;
  const diagram = content.firstElementChild;
  if (diagram?.localName !== "svg" || diagram.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("Invalid diagram.");
  const viewBox = diagram.getAttribute("viewBox")?.trim().split(/[\s,]+/u).map(Number);
  const dimension = (name: "width" | "height", position: number): number => {
    const attribute = diagram.getAttribute(name) ?? "";
    const pixels = /^\d+(?:\.\d+)?(?:px)?$/u.test(attribute) ? Number.parseFloat(attribute) : undefined;
    const value = pixels ?? viewBox?.[position];
    if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error("Diagram has no renderable size.");
    return Math.ceil(value);
  };
  const width = dimension("width", 2);
  const height = dimension("height", 3);
  diagram.setAttribute("width", String(width));
  diagram.setAttribute("height", String(height));
  (diagram as SVGElement).style.cssText += `;width:${width}px;height:${height}px;max-width:none;display:block;`;
  content.style.cssText = `width:${width}px;height:${height}px;`;
  content.style.fontFamily = ownerWindow.getComputedStyle(card).fontFamily;
  for (let element: Element | null = card; element !== null; element = element.parentElement) {
    const color = ownerWindow.getComputedStyle(element).backgroundColor;
    if (color !== "" && color !== "transparent" && !/^rgba\([^)]*,\s*0\s*\)$/u.test(color)) {
      content.style.backgroundColor = color;
      break;
    }
  }
  const staging = ownerDocument.createElement("div");
  staging.inert = true;
  staging.setAttribute("aria-hidden", "true");
  staging.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;";
  staging.append(content);
  ownerDocument.body.append(staging);
  const retire = (): void => staging.remove();
  signal.addEventListener("abort", retire, { once: true });
  try {
    const png = await timelineDomToPng(content, context);
    current();
    return png;
  } finally {
    signal.removeEventListener("abort", retire);
    staging.remove();
  }
}

export async function copyMermaid(svg: string, source: string, card: HTMLElement, context: BrowserActionContext): Promise<void> {
  const png = await renderMermaidPng(svg, card, context);
  assertBrowserActionCurrent(context);
  await copyTimelinePng(png, source, context);
}
