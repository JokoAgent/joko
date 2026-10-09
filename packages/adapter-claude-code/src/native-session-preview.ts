import { boundNativeSessionPreview, type NativeSessionPreview } from "@joko/core";
import { readNativeTranscriptWindow } from "@joko/runtime-governance";
import { claudeCatalogSourceIsCurrent, type ClaudeCatalogSource } from "./session-catalog.js";

export async function readClaudeNativeSessionPreview(source: ClaudeCatalogSource, redact: (text: string) => string): Promise<NativeSessionPreview> {
  if (!(await claudeCatalogSourceIsCurrent(source))) throw unavailable();
  const parts = await readNativeTranscriptWindow(source.path, source);
  const parse = (lines: readonly string[]): NativeSessionPreview["messages"] => lines.flatMap((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return []; }
    if (!record(value) || value["isSidechain"] === true || value["isMeta"] === true || !record(value["message"])) return [];
    const role = value["type"];
    if (role !== "user" && role !== "assistant") return [];
    const content = value["message"]["content"];
    const text = redact(typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: unknown) =>
      record(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("\n") : "").trim();
    const parsedAt = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : NaN;
    return text === "" ? [] : [{ role, text, at: Number.isFinite(parsedAt) ? parsedAt : 0 }];
  });
  if (!(await claudeCatalogSourceIsCurrent(source))) throw unavailable();
  return boundNativeSessionPreview(parse(parts.head), parse(parts.tail), parts.whole);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function unavailable(): Error { return new Error("The native transcript source changed. Rescan and retry."); }
