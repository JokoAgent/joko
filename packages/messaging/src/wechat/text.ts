import { weChatInvalid } from "./errors.js";

export const WECHAT_MAXIMUM_TEXT_POINTS = 3_500;

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

/** Keep code intact while removing only formatting unsupported by the provider. */
export function filterWeChatMarkdown(source: string): string {
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : filterInlineCode(line);
  }).join("");
}

export function splitWeChatText(source: string, maximumPoints = WECHAT_MAXIMUM_TEXT_POINTS): string[] {
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < 1 || maximumPoints > WECHAT_MAXIMUM_TEXT_POINTS) {
    throw weChatInvalid("WeChat text part limit is invalid.");
  }
  if (source === "") return [];
  if (maximumPoints < 9) return splitRaw(source, maximumPoints);
  const chunks: string[] = [];
  let fenceOpen = false;
  for (const raw of splitRaw(source, maximumPoints - 8)) {
    const prefix = fenceOpen ? "```\n" : "";
    if ((raw.match(/^\s*```/gmu) ?? []).length % 2 === 1) fenceOpen = !fenceOpen;
    const suffix = fenceOpen ? "\n```" : "";
    const part = `${prefix}${raw}${suffix}`;
    if (Array.from(part).length > maximumPoints) throw weChatInvalid("WeChat text part exceeded its limit.");
    chunks.push(part);
  }
  return chunks;
}

function splitRaw(source: string, maximumPoints: number): string[] {
  const points = Array.from(source);
  const chunks: string[] = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + maximumPoints, points.length);
    if (end < points.length) {
      while (end > start && (points[end - 1] === "`" || points[end] === "`")) end -= 1;
      if (end === start) end = Math.min(start + maximumPoints, points.length);
      const minimumBreak = start + Math.floor(maximumPoints * 0.6);
      for (let candidate = end; candidate > minimumBreak; candidate -= 1) {
        if (/\s/u.test(points[candidate - 1] ?? "")) { end = candidate; break; }
      }
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

function filterInlineCode(source: string): string {
  let result = "";
  for (let offset = 0; offset < source.length;) {
    const start = source.indexOf("`", offset);
    if (start < 0) return result + filterPlain(source.slice(offset));
    result += filterPlain(source.slice(offset, start));
    let markerEnd = start;
    while (source[markerEnd] === "`") markerEnd += 1;
    const marker = source.slice(start, markerEnd);
    const end = source.indexOf(marker, markerEnd);
    if (end < 0) return result + source.slice(start);
    result += source.slice(start, end + marker.length);
    offset = end + marker.length;
  }
  return result;
}

function filterPlain(source: string): string {
  return removeImages(source)
    .replace(/^#{5,6}\s+/gmu, "")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/(\*{1,3}|_{1,3})([^*_\n]+)\1/gu, (whole, marker: string, body: string) =>
      CJK.test(body) && marker.length !== 2 ? body : whole);
}

function removeImages(source: string): string {
  let result = "";
  for (let offset = 0; offset < source.length;) {
    const start = source.indexOf("![", offset);
    if (start < 0) return result + source.slice(offset);
    const altEnd = source.indexOf("]", start + 2);
    if (altEnd < 0) return result + source.slice(offset);
    if (source[altEnd + 1] !== "(") {
      result += source.slice(offset, altEnd + 1);
      offset = altEnd + 1;
      continue;
    }
    const destinationEnd = source.indexOf(")", altEnd + 2);
    if (destinationEnd < 0) return result + source.slice(offset);
    result += source.slice(offset, start);
    offset = destinationEnd + 1;
  }
  return result;
}
