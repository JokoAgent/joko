import { boundNativeSessionPreview, redactSecrets, type NativeSessionPreview } from "@joko/core";
import { readNativeTranscriptWindow } from "@joko/runtime-governance";
import type { CodexCatalogSource } from "./session-catalog.js";
import { resolveCodexCatalogPreviewPath, validateCodexCatalogSource } from "./session-materialization.js";

export async function readCodexNativeSessionPreview(source: CodexCatalogSource, nativeSessionId: string): Promise<NativeSessionPreview> {
  const path = await resolveCodexCatalogPreviewPath(source, nativeSessionId);
  const parts = await readNativeTranscriptWindow(path);
  const parse = (lines: readonly string[]): NativeSessionPreview["messages"] => lines.flatMap((line) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return []; }
    if (!record(value) || value["type"] !== "response_item" || !record(value["payload"])) return [];
    const message = value["payload"];
    const role = message["role"];
    if (message["type"] !== "message" || role !== "user" && role !== "assistant") return [];
    const content = message["content"];
    const text = redactSecrets(typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: unknown) =>
      record(part) && ["input_text", "output_text", "text"].includes(String(part["type"])) && typeof part["text"] === "string" ? [part["text"]] : []).join("\n") : "").trim();
    const parsedAt = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : NaN;
    return text === "" ? [] : [{ role, text, at: Number.isFinite(parsedAt) ? parsedAt : 0 }];
  });
  await validateCodexCatalogSource(source, nativeSessionId);
  return boundNativeSessionPreview(parse(parts.head), parse(parts.tail), parts.whole);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
