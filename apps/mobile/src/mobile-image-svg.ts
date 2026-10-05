export interface MobileSvgPreview {
  readonly width: number; readonly height: number; readonly markup: string;
}

/** Validate a self-contained vector document before passing it to a native image decoder. */
export function inspectMobileSvgBytes(bytes: Uint8Array, inspectEmbeddedImage: (base64: string, mediaType: string) => void): MobileSvgPreview {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim() || text.length > 2_097_152 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw invalidSvg();
  const stack: string[] = []; let offset = 0; let nodes = 0; let styleParts: string[] | undefined;
  let root: { start: number; end: number; name: string; selfClosing: boolean; attributes: Map<string, string> } | undefined;
  while (offset < text.length) {
    const start = text.indexOf("<", offset);
    const body = text.slice(offset, start < 0 ? undefined : start);
    if (!stack.length && body.trim()) throw invalidSvg();
    if (styleParts) styleParts.push(decodeEntities(body));
    if (start < 0) break;
    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4); if (end < 0) throw invalidSvg();
      offset = end + 3; continue;
    }
    if (text.startsWith("<![CDATA[", start)) {
      const end = text.indexOf("]]>", start + 9); if (end < 0 || !stack.length) throw invalidSvg();
      if (styleParts) styleParts.push(text.slice(start + 9, end));
      offset = end + 3; continue;
    }
    if (text.startsWith("<?", start)) {
      const end = text.indexOf("?>", start + 2);
      if (root || end < 0 || !/^<\?xml\s[\s\S]*\?>$/u.test(text.slice(start, end + 2))) throw invalidSvg();
      offset = end + 2; continue;
    }
    if (text.startsWith("<!", start)) throw invalidSvg();
    let end = start + 1; let quote = "";
    for (; end < text.length; end++) {
      const character = text[end]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= text.length || end - start > 131_072) throw invalidSvg();
    const tag = text.slice(start + 1, end);
    if (tag.startsWith("/")) {
      const match = /^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/u.exec(tag);
      if (!match || stack.pop() !== match[1]) throw invalidSvg();
      if (styleParts) { assertLocalCss(styleParts.join("")); styleParts = undefined; }
    } else {
      if (styleParts) throw invalidSvg();
      const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(tag); if (!match) throw invalidSvg();
      const name = match[1]!; const localName = name.split(":").at(-1)!.toLowerCase();
      if (["script", "foreignobject", "iframe", "object", "embed", "audio", "video"].includes(localName)) throw invalidSvg();
      const selfClosing = /\/\s*$/u.test(match[2]!);
      const attributes = parseAttributes(selfClosing ? match[2]!.replace(/\/\s*$/u, "") : match[2]!);
      if (++nodes > 10_000 || stack.length >= 64) throw invalidSvg();
      if (!stack.length) {
        if (root || localName !== "svg") throw invalidSvg();
        root = { start, end: end + 1, name, selfClosing, attributes };
      }
      for (const [attribute, value] of attributes) {
        const localAttribute = attribute.split(":").at(-1)!.toLowerCase();
        if (/^on/iu.test(localAttribute) || localAttribute === "base") throw invalidSvg();
        if (localAttribute === "href" || localAttribute === "src") {
          if (/^#[^\s\u0000-\u001f]+$/u.test(value)) continue;
          const embedded = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
          if (!embedded || localName !== "image") throw invalidSvg();
          inspectEmbeddedImage(embedded[2]!, embedded[1]!);
        } else if (localAttribute === "style" || ["fill", "stroke", "filter", "clip-path", "mask", "cursor", "marker", "marker-start", "marker-mid", "marker-end"].includes(localAttribute)
          || /url\s*\(/iu.test(value)) assertLocalCss(value);
        if ((localName.startsWith("animate") || localName === "set") && localAttribute === "attributename"
          && /(?:href|src|base|style|on[a-z])/iu.test(value)) throw invalidSvg();
        if ((localName.startsWith("animate") || localName === "set") && ["values", "from", "to", "by"].includes(localAttribute)) assertLocalCss(value);
      }
      if (!selfClosing) { stack.push(name); if (localName === "style") styleParts = []; }
    }
    offset = end + 1;
  }
  if (!root || stack.length) throw invalidSvg();
  const viewBoxText = root.attributes.get("viewBox");
  const viewBox = viewBoxText?.trim().split(/[\s,]+/u).map(Number);
  if (viewBox && (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2]! <= 0 || viewBox[3]! <= 0)) throw invalidSvg();
  let width = absoluteLength(root.attributes.get("width")); let height = absoluteLength(root.attributes.get("height"));
  if (width === undefined && height !== undefined && viewBox) width = height * viewBox[2]! / viewBox[3]!;
  if (height === undefined && width !== undefined && viewBox) height = width * viewBox[3]! / viewBox[2]!;
  width = Math.ceil(width ?? viewBox?.[2] ?? 300); height = Math.ceil(height ?? viewBox?.[3] ?? 150);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw invalidSvg();
  const attributes = new Map(root.attributes); attributes.set("width", String(width)); attributes.set("height", String(height));
  const opening = `<${root.name}${[...attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}${root.selfClosing ? "/" : ""}>`;
  // Both native decoders report the outer canvas; the inner viewBox keeps its original geometry.
  return { width, height, markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${opening}${text.slice(root.end)}</svg>` };
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>(); let offset = 0;
  while (offset < source.length) {
    const space = /^\s*/u.exec(source.slice(offset))![0]; offset += space.length;
    if (offset === source.length) break;
    if (!space) throw invalidSvg();
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/u.exec(source.slice(offset)); if (!match) throw invalidSvg();
    offset += match[0].length; const end = source.indexOf(match[2]!, offset);
    if (end < 0 || attributes.has(match[1]!) || attributes.size >= 128) throw invalidSvg();
    attributes.set(match[1]!, decodeEntities(source.slice(offset, end))); offset = end + 1;
  }
  return attributes;
}
function decodeEntities(source: string): string {
  const known: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return source.replace(/&([^;\s]*);?|</gu, (match, entity: string | undefined) => {
    if (entity === undefined || !match.endsWith(";")) throw invalidSvg();
    if (Object.hasOwn(known, entity)) return known[entity]!;
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(entity)) throw invalidSvg();
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw invalidSvg();
    return String.fromCodePoint(code);
  });
}
function assertLocalCss(source: string): void {
  if (source.includes("\\") || /\/\*|@import|@font-face|expression\s*\(/iu.test(source)) throw invalidSvg();
  const remainder = source.replace(/url\s*\(\s*(["']?)(#[^\s()"']+)\1\s*\)/giu, "");
  if (/url\s*\(/iu.test(remainder)) throw invalidSvg();
}
function absoluteLength(source: string | undefined): number | undefined {
  if (source === undefined || /%\s*$/u.test(source)) return undefined;
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm|q)?\s*$/iu.exec(source);
  if (!match) throw invalidSvg();
  const scales: Readonly<Record<string, number>> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  const value = Number(match[1]) * (scales[match[2]?.toLowerCase() ?? "px"] ?? 1);
  if (!Number.isFinite(value) || value <= 0) throw invalidSvg(); return value;
}
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function invalidSvg(): Error { return new Error("The SVG must be a bounded, self-contained vector image without scripts or external resources."); }
