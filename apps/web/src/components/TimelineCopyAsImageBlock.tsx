import { toBlob as domNodeToBlob, getFontEmbedCSS } from "html-to-image";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

const MAX_EDGE = 4_096;
const MAX_PIXELS = MAX_EDGE * MAX_EDGE;
let fontEmbedCss: Promise<string> | undefined;

export function timelineExportScale(width: number, height: number, desired = 2): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.min(desired, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

export function timelineTableToTsv(node: HTMLElement): string | undefined {
  const rows = [...node.querySelectorAll("tr")];
  if (rows.length === 0) return undefined;
  return rows.map((row) => [...row.querySelectorAll("th, td")]
    .map((cell) => (cell as HTMLElement).innerText.replace(/\s*\n\s*/gu, " ").trim())
    .join("\t")).join("\n");
}

export function timelineMathToLatex(node: HTMLElement): string | undefined {
  const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
  return tex === undefined || tex.length === 0 ? undefined : `$$\n${tex}\n$$`;
}

function opaqueBackground(node: Element): string {
  let current: Element | null = node;
  while (current !== null) {
    const color = getComputedStyle(current).backgroundColor;
    if (color !== "" && color !== "transparent" && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/u.test(color)) return color;
    current = current.parentElement;
  }
  return document.documentElement.dataset.theme === "dark" ? "#1f1f1d" : "#ffffff";
}

async function collectFontCss(node: HTMLElement): Promise<string> {
  fontEmbedCss ??= getFontEmbedCSS(node).catch(() => {
    fontEmbedCss = undefined;
    return "";
  });
  return fontEmbedCss;
}

export async function timelineDomToPng(node: HTMLElement): Promise<Blob> {
  const width = node.scrollWidth;
  const height = node.scrollHeight;
  if (width <= 0 || height <= 0) throw new Error("Content has no renderable size.");
  if (document.fonts !== undefined) await document.fonts.ready;
  const blob = await domNodeToBlob(node, {
    width,
    height,
    pixelRatio: timelineExportScale(width, height),
    backgroundColor: opaqueBackground(node),
    fontEmbedCSS: await collectFontCss(node)
  });
  if (blob === null) throw new Error("PNG encoding failed.");
  return blob;
}

export async function copyTimelinePng(blob: Blob, plainText?: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) throw new Error("Clipboard unavailable.");
  await navigator.clipboard.write([new ClipboardItem({
    "image/png": blob,
    ...(plainText === undefined ? {} : { "text/plain": new Blob([plainText], { type: "text/plain" }) })
  })]);
}

export function TimelineCopyAsImageBlock({ children, t, className, contentClassName, extractPlainText }: {
  readonly children: ReactNode;
  readonly t: Translator;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly extractPlainText?: (node: HTMLElement) => string | undefined;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  const copy = (): void => {
    const node = contentRef.current;
    if (node === null || state === "copying") return;
    setState("copying");
    void timelineDomToPng(node)
      .then((blob) => copyTimelinePng(blob, extractPlainText?.(node)))
      .then(() => {
        setState("copied");
        timerRef.current = window.setTimeout(() => setState("idle"), 1_500);
      })
      .catch(() => setState("failed"));
  };
  const label = state === "copied"
    ? t("timeline.blockCopied")
    : state === "failed"
      ? t("timeline.blockCopyFailed")
      : t("timeline.blockCopy");

  return <div className={`timeline-copy-block${className === undefined ? "" : ` ${className}`}`}>
    <div ref={contentRef} className={contentClassName}>{children}</div>
    <IconButton className="timeline-copy-block__button" disabled={state === "copying"} disabledReason={state === "copying" ? label : undefined} label={label} onClick={copy}>
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
    {state === "failed" && <span className="sr-only" role="alert">{label}</span>}
  </div>;
}
