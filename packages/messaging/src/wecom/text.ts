import { Buffer } from "node:buffer";

export const WECOM_TEXT_LIMIT_BYTES = 18 * 1_024;

export function splitWeComText(source: string): readonly string[] {
  const normalized = source.replace(/\r\n?/gu, "\n").trim();
  if (normalized === "") return [];
  const output: string[] = [];
  let current = "";
  for (const point of normalized) {
    const candidate = current + point;
    if (current !== "" && Buffer.byteLength(candidate, "utf8") > WECOM_TEXT_LIMIT_BYTES) {
      output.push(current);
      current = point;
    } else {
      current = candidate;
    }
  }
  if (current !== "") output.push(current);
  return output;
}

export function escapeWeComMarkdown(source: string): string {
  return source.replace(/([\\`*_{}[\]()#+\-.!>])/gu, "\\$1");
}
