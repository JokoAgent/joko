export const MAXIMUM_SHARE_MESSAGE_CHARACTERS = 12_000;
export const MAXIMUM_SHARE_IMAGE_EDGE_PIXELS = 8_192;
export const MAXIMUM_SHARE_IMAGE_PIXELS = 16_777_216;

const SHARE_IMAGE_CSS_WIDTH = 900;
const SHARE_IMAGE_SCALE = 2;
const SHARE_IMAGE_HORIZONTAL_PADDING = 44;
const SHARE_IMAGE_CARD_PADDING = 28;
const SHARE_IMAGE_BODY_LINE_HEIGHT = 26;
const SHARE_IMAGE_MAX_TITLE_CHARACTERS = 120;
const SHARE_IMAGE_MAX_ATTACHMENT_COUNT = 16;
const SHARE_IMAGE_MAX_ATTACHMENT_NAME_CHARACTERS = 180;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export interface ShareMessageImageContent {
  readonly sessionName: string;
  readonly role: "user" | "assistant";
  readonly roleLabel: string;
  readonly text: string;
  readonly attachmentNames?: readonly string[];
  readonly attachmentsLabel: string;
  readonly createdAtLabel?: string;
}

export interface ShareMessageImagePalette {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly secondaryText: string;
  readonly line: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly fontFamily: string;
}

export interface ShareMessageImageLayout {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly title: string;
  readonly roleLabel: string;
  readonly createdAtLabel?: string;
  readonly lines: readonly string[];
  readonly cardTop: number;
  readonly cardHeight: number;
}

export type ShareMessageImageDelivery = "shared" | "downloaded" | "cancelled";

export class ShareMessageImageEmptyError extends Error {
  constructor() {
    super("The selected message has no shareable content.");
    this.name = "ShareMessageImageEmptyError";
  }
}

export class ShareMessageImageTooLargeError extends Error {
  constructor() {
    super("The selected message is too large to export as a readable image.");
    this.name = "ShareMessageImageTooLargeError";
  }
}

export class ShareMessageImageEncodingError extends Error {
  constructor() {
    super("The browser could not encode the message as PNG.");
    this.name = "ShareMessageImageEncodingError";
  }
}

export function redactShareMessageText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|ghp_|github_pat_|glpat-|npm_|pypi-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_TOKEN]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|authorization)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|passwd|authorization)\s*(?::|=|\bis\b)\s*[^\s,;]+/giu, "$1=[REDACTED]");
}

export function wrapShareMessageText(
  value: string,
  maximumWidth: number,
  measure: (value: string) => number
): readonly string[] {
  const lines: string[] = [];
  const paragraphs = normalizeMultiline(value).split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > 0) {
      if (measure(remaining) <= maximumWidth) {
        lines.push(remaining);
        break;
      }
      const characters = [...remaining];
      let low = 1;
      let high = characters.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(characters.slice(0, middle).join("")) <= maximumWidth) low = middle;
        else high = middle - 1;
      }
      let breakAt = Math.max(1, low);
      const fitted = characters.slice(0, breakAt).join("");
      const whitespace = Math.max(fitted.lastIndexOf(" "), fitted.lastIndexOf("\t"));
      if (whitespace >= Math.floor(breakAt * 0.45)) breakAt = Math.max(1, [...fitted.slice(0, whitespace)].length);
      const line = characters.slice(0, breakAt).join("").trimEnd();
      lines.push(line);
      remaining = characters.slice(breakAt).join("").trimStart();
    }
  }
  return lines;
}

export function layoutShareMessageImage(
  content: ShareMessageImageContent,
  measure: (value: string) => number
): ShareMessageImageLayout {
  if (content.text.length > MAXIMUM_SHARE_MESSAGE_CHARACTERS) throw new ShareMessageImageTooLargeError();
  if ((content.attachmentNames?.length ?? 0) > SHARE_IMAGE_MAX_ATTACHMENT_COUNT) throw new ShareMessageImageTooLargeError();
  const attachmentNames = (content.attachmentNames ?? [])
    .map((name) => boundedDisplayText(redactShareMessageText(singleLine(name)), SHARE_IMAGE_MAX_ATTACHMENT_NAME_CHARACTERS))
    .filter(Boolean);
  const redactedText = redactShareMessageText(normalizeMultiline(content.text)).trim();
  const body = [
    redactedText,
    attachmentNames.length === 0 ? "" : `${singleLine(content.attachmentsLabel)}\n${attachmentNames.map((name) => `• ${name}`).join("\n")}`
  ].filter(Boolean).join("\n\n");
  if (body.length === 0) throw new ShareMessageImageEmptyError();

  const cardWidth = SHARE_IMAGE_CSS_WIDTH - SHARE_IMAGE_HORIZONTAL_PADDING * 2;
  const bodyWidth = cardWidth - SHARE_IMAGE_CARD_PADDING * 2;
  const lines = wrapShareMessageText(body, bodyWidth, measure);
  const cardTop = 132;
  const rolePillHeight = 28;
  const cardHeight = SHARE_IMAGE_CARD_PADDING + rolePillHeight + 18 + Math.max(SHARE_IMAGE_BODY_LINE_HEIGHT, lines.length * SHARE_IMAGE_BODY_LINE_HEIGHT) + SHARE_IMAGE_CARD_PADDING;
  const height = cardTop + cardHeight + 102;
  const pixelWidth = SHARE_IMAGE_CSS_WIDTH * SHARE_IMAGE_SCALE;
  const pixelHeight = height * SHARE_IMAGE_SCALE;
  if (
    pixelWidth > MAXIMUM_SHARE_IMAGE_EDGE_PIXELS
    || pixelHeight > MAXIMUM_SHARE_IMAGE_EDGE_PIXELS
    || pixelWidth * pixelHeight > MAXIMUM_SHARE_IMAGE_PIXELS
  ) throw new ShareMessageImageTooLargeError();

  return {
    width: SHARE_IMAGE_CSS_WIDTH,
    height,
    scale: SHARE_IMAGE_SCALE,
    title: boundedDisplayText(redactShareMessageText(singleLine(content.sessionName)), SHARE_IMAGE_MAX_TITLE_CHARACTERS) || "Untitled task",
    roleLabel: singleLine(content.roleLabel).slice(0, 80),
    ...(content.createdAtLabel === undefined ? {} : { createdAtLabel: singleLine(content.createdAtLabel).slice(0, 120) }),
    lines,
    cardTop,
    cardHeight
  };
}

export async function buildShareMessageImagePng(
  content: ShareMessageImageContent,
  palette = readShareMessageImagePalette()
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new ShareMessageImageEncodingError();
  context.font = `400 17px ${palette.fontFamily}`;
  const layout = layoutShareMessageImage(content, (value) => context.measureText(value).width);
  canvas.width = layout.width * layout.scale;
  canvas.height = layout.height * layout.scale;
  context.scale(layout.scale, layout.scale);
  context.textBaseline = "top";

  context.fillStyle = palette.background;
  context.fillRect(0, 0, layout.width, layout.height);
  context.fillStyle = palette.accent;
  roundedRect(context, SHARE_IMAGE_HORIZONTAL_PADDING, 43, 34, 7, 3.5);
  context.fill();
  context.fillStyle = palette.text;
  context.font = `650 25px ${palette.fontFamily}`;
  context.fillText(layout.title, SHARE_IMAGE_HORIZONTAL_PADDING, 65, layout.width - SHARE_IMAGE_HORIZONTAL_PADDING * 2);
  context.fillStyle = palette.secondaryText;
  context.font = `400 13px ${palette.fontFamily}`;
  context.fillText("Joko", SHARE_IMAGE_HORIZONTAL_PADDING, 101);

  const cardLeft = SHARE_IMAGE_HORIZONTAL_PADDING;
  const cardWidth = layout.width - SHARE_IMAGE_HORIZONTAL_PADDING * 2;
  roundedRect(context, cardLeft, layout.cardTop, cardWidth, layout.cardHeight, 18);
  context.fillStyle = palette.surface;
  context.fill();
  context.strokeStyle = palette.line;
  context.lineWidth = 1;
  context.stroke();

  const roleLabel = layout.roleLabel || (content.role === "user" ? "You" : "Agent");
  context.font = `600 13px ${palette.fontFamily}`;
  const pillWidth = Math.min(220, Math.max(62, context.measureText(roleLabel).width + 24));
  roundedRect(context, cardLeft + SHARE_IMAGE_CARD_PADDING, layout.cardTop + SHARE_IMAGE_CARD_PADDING, pillWidth, 28, 14);
  context.fillStyle = palette.accent;
  context.fill();
  context.fillStyle = palette.accentInk;
  context.fillText(roleLabel, cardLeft + SHARE_IMAGE_CARD_PADDING + 12, layout.cardTop + SHARE_IMAGE_CARD_PADDING + 6, pillWidth - 24);
  if (layout.createdAtLabel !== undefined) {
    context.fillStyle = palette.secondaryText;
    context.font = `400 12px ${palette.fontFamily}`;
    const timeWidth = context.measureText(layout.createdAtLabel).width;
    context.fillText(layout.createdAtLabel, cardLeft + cardWidth - SHARE_IMAGE_CARD_PADDING - timeWidth, layout.cardTop + SHARE_IMAGE_CARD_PADDING + 7);
  }

  context.fillStyle = palette.text;
  context.font = `400 17px ${palette.fontFamily}`;
  let lineTop = layout.cardTop + SHARE_IMAGE_CARD_PADDING + 46;
  for (const line of layout.lines) {
    context.fillText(line, cardLeft + SHARE_IMAGE_CARD_PADDING, lineTop, cardWidth - SHARE_IMAGE_CARD_PADDING * 2);
    lineTop += SHARE_IMAGE_BODY_LINE_HEIGHT;
  }

  const footerTop = layout.cardTop + layout.cardHeight + 44;
  context.strokeStyle = palette.line;
  context.beginPath();
  context.moveTo(SHARE_IMAGE_HORIZONTAL_PADDING, footerTop);
  context.lineTo(layout.width - SHARE_IMAGE_HORIZONTAL_PADDING, footerTop);
  context.stroke();
  context.fillStyle = palette.accent;
  context.font = `700 18px ${palette.fontFamily}`;
  context.fillText("Joko", SHARE_IMAGE_HORIZONTAL_PADDING, footerTop + 18);

  const blob = await canvasPngBlob(canvas);
  await assertPngBlob(blob);
  return blob;
}

export async function assertPngBlob(blob: Blob): Promise<void> {
  if (blob.type !== "image/png" || blob.size < PNG_SIGNATURE.length) throw new ShareMessageImageEncodingError();
  const bytes = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new ShareMessageImageEncodingError();
}

export async function deliverShareMessageImage(
  blob: Blob,
  filename: string,
  title: string
): Promise<ShareMessageImageDelivery> {
  await assertPngBlob(blob);
  const safeTitle = boundedDisplayText(redactShareMessageText(singleLine(title)), SHARE_IMAGE_MAX_TITLE_CHARACTERS) || "Joko";
  const file = typeof File === "undefined" ? undefined : new File([blob], filename, { type: "image/png" });
  if (file !== undefined && typeof navigator.share === "function" && (navigator.userActivation?.isActive ?? true)) {
    let canShare = false;
    try {
      canShare = typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] });
    } catch {
      canShare = false;
    }
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: safeTitle });
        return "shared";
      } catch (error) {
        if (error !== null && typeof error === "object" && "name" in error && error.name === "AbortError") return "cancelled";
        // Some Chromium/WebView builds advertise file sharing but reject it
        // after asynchronous PNG encoding. The local download remains a real,
        // user-visible fallback; only failure of both paths reaches the UI.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return "downloaded";
}

export function shareMessageImageFilename(sessionName: string, createdAt: number): string {
  const slug = redactShareMessageText(singleLine(sessionName)).toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "task";
  const timestamp = safeIsoTimestamp(createdAt);
  return `joko-${slug}-${timestamp}.png`;
}

function safeIsoTimestamp(value: number): string {
  if (!Number.isFinite(value)) return "message";
  try {
    return new Date(value).toISOString().replace(/[:.]/gu, "-");
  } catch {
    return "message";
  }
}

function readShareMessageImagePalette(): ShareMessageImagePalette {
  const styles = getComputedStyle(document.documentElement);
  const required = (name: string): string => {
    const value = styles.getPropertyValue(name).trim();
    if (value.length === 0) throw new ShareMessageImageEncodingError();
    return value;
  };
  return {
    background: required("--bg"),
    surface: required("--surface-raised"),
    text: required("--text"),
    secondaryText: required("--text-soft"),
    line: required("--line"),
    accent: required("--accent"),
    accentInk: required("--accent-ink"),
    fontFamily: styles.fontFamily || "sans-serif"
  };
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new ShareMessageImageEncodingError());
      else resolve(blob);
    }, "image/png");
  });
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
}

function singleLine(value: string): string {
  return normalizeMultiline(value).replace(/\s+/gu, " ").trim();
}

function boundedDisplayText(value: string, maximumCharacters: number): string {
  if ([...value].length <= maximumCharacters) return value;
  return `${[...value].slice(0, Math.max(1, maximumCharacters - 1)).join("")}…`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const boundedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + boundedRadius, y);
  context.lineTo(x + width - boundedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + boundedRadius);
  context.lineTo(x + width, y + height - boundedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - boundedRadius, y + height);
  context.lineTo(x + boundedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - boundedRadius);
  context.lineTo(x, y + boundedRadius);
  context.quadraticCurveTo(x, y, x + boundedRadius, y);
  context.closePath();
}
