import type { TimelineItemView } from "../model.js";
import { visibleSelectionQuoteMessageText } from "../selection-quote.js";
import {
  MAXIMUM_SHARE_IMAGE_EDGE_PIXELS,
  MAXIMUM_SHARE_IMAGE_PIXELS,
  MAXIMUM_SHARE_MESSAGE_CHARACTERS,
  ShareMessageImageEmptyError,
  ShareMessageImageEncodingError,
  ShareMessageImageTooLargeError,
  assertPngBlob,
  redactShareMessageText,
  shareMessageImageFilename,
  wrapShareMessageText
} from "./share-message-image.js";

const SHARE_WIDTH = 900;
const SHARE_SCALE = 2;
const HORIZONTAL_PADDING = 44;
const CARD_PADDING = 24;
const BODY_LINE_HEIGHT = 25;
const CARD_GAP = 18;
const DISCONTINUITY_GAP = 42;
const MAXIMUM_SHARE_MESSAGES = 80;
const MAXIMUM_SHARE_ATTACHMENTS = 64;

export interface ShareSelectionImageMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly roleLabel: string;
  readonly text: string;
  readonly attachmentNames: readonly string[];
  readonly attachmentsLabel: string;
  readonly createdAtLabel?: string;
  readonly gapBefore: boolean;
}

export interface ShareSelectionImageContent {
  readonly sessionName: string;
  readonly messages: readonly ShareSelectionImageMessage[];
}

export interface ShareSelectionImageCardLayout {
  readonly role: "user" | "assistant";
  readonly roleLabel: string;
  readonly createdAtLabel?: string;
  readonly lines: readonly string[];
  readonly top: number;
  readonly height: number;
  readonly gapBefore: boolean;
}

export interface ShareSelectionImageLayout {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly title: string;
  readonly cards: readonly ShareSelectionImageCardLayout[];
}

export interface ShareSelectionImagePalette {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly secondaryText: string;
  readonly line: string;
  readonly accent: string;
  readonly accentInk: string;
  readonly fontFamily: string;
}

export function shareSelectionImageMessages(
  allMessages: readonly TimelineItemView[],
  selectedMessages: readonly TimelineItemView[],
  labels: { readonly user: string; readonly assistant: string; readonly attachments: string },
  formatCreatedAt: (createdAt: number) => string
): readonly ShareSelectionImageMessage[] {
  const order = new Map(allMessages.map((item, index) => [item.id, index]));
  let previousIndex: number | undefined;
  return selectedMessages.flatMap((item) => {
    if (item.kind !== "user" && item.kind !== "assistant") return [];
    const currentIndex = order.get(item.id);
    const gapBefore = previousIndex !== undefined && currentIndex !== undefined && currentIndex - previousIndex > 1;
    previousIndex = currentIndex;
    return [{
      id: item.id,
      role: item.kind,
      roleLabel: item.kind === "user" ? labels.user : labels.assistant,
      text: item.kind === "user"
        ? visibleSelectionQuoteMessageText(item.text ?? "", item.quotesEncoded === true)
        : item.text ?? "",
      attachmentNames: item.attachments?.map((attachment) => attachment.fileName || attachment.title) ?? [],
      attachmentsLabel: labels.attachments,
      createdAtLabel: formatCreatedAt(item.createdAt),
      gapBefore
    }];
  });
}

export function layoutShareSelectionImage(
  content: ShareSelectionImageContent,
  measure: (value: string) => number
): ShareSelectionImageLayout {
  if (content.messages.length === 0) throw new ShareMessageImageEmptyError();
  if (content.messages.length > MAXIMUM_SHARE_MESSAGES) throw new ShareMessageImageTooLargeError();
  const totalCharacters = content.messages.reduce((total, message) => total + [...message.text].length + message.attachmentNames.reduce((count, name) => count + [...name].length, 0), 0);
  const totalAttachments = content.messages.reduce((total, message) => total + message.attachmentNames.length, 0);
  if (totalCharacters > MAXIMUM_SHARE_MESSAGE_CHARACTERS || totalAttachments > MAXIMUM_SHARE_ATTACHMENTS) throw new ShareMessageImageTooLargeError();

  const cardWidth = SHARE_WIDTH - HORIZONTAL_PADDING * 2;
  const bodyWidth = cardWidth - CARD_PADDING * 2;
  let top = 132;
  let hasContent = false;
  const cards = content.messages.map((message, index): ShareSelectionImageCardLayout => {
    if (index > 0) top += message.gapBefore ? DISCONTINUITY_GAP : CARD_GAP;
    const redactedText = redactShareMessageText(normalizeMultiline(message.text)).trim();
    const attachmentNames = message.attachmentNames
      .map((name) => redactShareMessageText(singleLine(name)).slice(0, 180))
      .filter(Boolean);
    const body = [
      redactedText,
      attachmentNames.length === 0 ? "" : `${singleLine(message.attachmentsLabel)}\n${attachmentNames.map((name) => `• ${name}`).join("\n")}`
    ].filter(Boolean).join("\n\n");
    if (body.length === 0) throw new ShareMessageImageEmptyError();
    hasContent = true;
    const lines = wrapShareMessageText(body, bodyWidth, measure);
    const height = CARD_PADDING + 28 + 16 + Math.max(BODY_LINE_HEIGHT, lines.length * BODY_LINE_HEIGHT) + CARD_PADDING;
    const card = {
      role: message.role,
      roleLabel: singleLine(message.roleLabel).slice(0, 80),
      ...(message.createdAtLabel === undefined ? {} : { createdAtLabel: singleLine(message.createdAtLabel).slice(0, 120) }),
      lines,
      top,
      height,
      gapBefore: message.gapBefore
    };
    top += height;
    return card;
  });
  if (!hasContent) throw new ShareMessageImageEmptyError();
  const height = top + 102;
  const pixelWidth = SHARE_WIDTH * SHARE_SCALE;
  const pixelHeight = height * SHARE_SCALE;
  if (
    pixelWidth > MAXIMUM_SHARE_IMAGE_EDGE_PIXELS
    || pixelHeight > MAXIMUM_SHARE_IMAGE_EDGE_PIXELS
    || pixelWidth * pixelHeight > MAXIMUM_SHARE_IMAGE_PIXELS
  ) throw new ShareMessageImageTooLargeError();
  return {
    width: SHARE_WIDTH,
    height,
    scale: SHARE_SCALE,
    title: redactShareMessageText(singleLine(content.sessionName)).slice(0, 120) || "Untitled task",
    cards
  };
}

export async function buildShareSelectionImagePng(
  content: ShareSelectionImageContent,
  palette = readPalette()
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new ShareMessageImageEncodingError();
  context.font = `400 17px ${palette.fontFamily}`;
  const layout = layoutShareSelectionImage(content, (value) => context.measureText(value).width);
  canvas.width = layout.width * layout.scale;
  canvas.height = layout.height * layout.scale;
  context.scale(layout.scale, layout.scale);
  context.textBaseline = "top";
  context.fillStyle = palette.background;
  context.fillRect(0, 0, layout.width, layout.height);

  context.fillStyle = palette.accent;
  roundedRect(context, HORIZONTAL_PADDING, 43, 34, 7, 3.5);
  context.fill();
  context.fillStyle = palette.text;
  context.font = `650 25px ${palette.fontFamily}`;
  context.fillText(layout.title, HORIZONTAL_PADDING, 65, layout.width - HORIZONTAL_PADDING * 2);
  context.fillStyle = palette.secondaryText;
  context.font = `400 13px ${palette.fontFamily}`;
  context.fillText("Joko", HORIZONTAL_PADDING, 101);

  const cardLeft = HORIZONTAL_PADDING;
  const cardWidth = layout.width - HORIZONTAL_PADDING * 2;
  for (const [index, card] of layout.cards.entries()) {
    if (index > 0 && card.gapBefore) {
      context.fillStyle = palette.secondaryText;
      context.font = `600 18px ${palette.fontFamily}`;
      context.textAlign = "center";
      context.fillText("•••", layout.width / 2, card.top - 29);
      context.textAlign = "left";
    }
    roundedRect(context, cardLeft, card.top, cardWidth, card.height, 18);
    context.fillStyle = palette.surface;
    context.fill();
    context.strokeStyle = palette.line;
    context.lineWidth = 1;
    context.stroke();

    const roleLabel = card.roleLabel || (card.role === "user" ? "You" : "Agent");
    context.font = `600 13px ${palette.fontFamily}`;
    const pillWidth = Math.min(220, Math.max(62, context.measureText(roleLabel).width + 24));
    roundedRect(context, cardLeft + CARD_PADDING, card.top + CARD_PADDING, pillWidth, 28, 14);
    context.fillStyle = palette.accent;
    context.fill();
    context.fillStyle = palette.accentInk;
    context.fillText(roleLabel, cardLeft + CARD_PADDING + 12, card.top + CARD_PADDING + 6, pillWidth - 24);
    if (card.createdAtLabel !== undefined) {
      context.fillStyle = palette.secondaryText;
      context.font = `400 12px ${palette.fontFamily}`;
      const timeWidth = Math.min(cardWidth / 2, context.measureText(card.createdAtLabel).width);
      context.fillText(card.createdAtLabel, cardLeft + cardWidth - CARD_PADDING - timeWidth, card.top + CARD_PADDING + 7, timeWidth);
    }

    context.fillStyle = palette.text;
    context.font = `400 17px ${palette.fontFamily}`;
    let lineTop = card.top + CARD_PADDING + 44;
    for (const line of card.lines) {
      context.fillText(line, cardLeft + CARD_PADDING, lineTop, cardWidth - CARD_PADDING * 2);
      lineTop += BODY_LINE_HEIGHT;
    }
  }

  const footerTop = layout.cards.at(-1)!.top + layout.cards.at(-1)!.height + 44;
  context.strokeStyle = palette.line;
  context.beginPath();
  context.moveTo(HORIZONTAL_PADDING, footerTop);
  context.lineTo(layout.width - HORIZONTAL_PADDING, footerTop);
  context.stroke();
  context.fillStyle = palette.accent;
  context.font = `700 18px ${palette.fontFamily}`;
  context.fillText("Joko", HORIZONTAL_PADDING, footerTop + 18);

  const blob = await canvasPngBlob(canvas);
  await assertPngBlob(blob);
  return blob;
}

export async function copyShareSelectionImagePng(blob: Blob): Promise<void> {
  await assertPngBlob(blob);
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") {
    throw new ShareMessageImageEncodingError();
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function downloadShareSelectionImagePng(blob: Blob, sessionName: string, createdAt: number): Promise<void> {
  await assertPngBlob(blob);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = shareMessageImageFilename(sessionName, createdAt);
    anchor.rel = "noopener";
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function readPalette(): ShareSelectionImagePalette {
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

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
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
