import { ArtifactKind } from "./gen/joko/v1/common_pb.js";
import type { Event } from "./gen/joko/v1/event_pb.js";
import { ToolCallState, ToolFileAction } from "./gen/joko/v1/tool_pb.js";

export const DOCUMENT_TOOL_PROVIDER_ID = "joko-document-tools";

export const DOCUMENT_WRITE_TOOLS = {
  docx: "make_docx",
  pptx: "make_pptx",
  xlsx: "make_xlsx",
  pdf: "render_pdf"
} as const;

export type DocumentOutputFormat = keyof typeof DOCUMENT_WRITE_TOOLS;

export function isDocumentOutputPath(path: string): boolean {
  return path.length > 0 && path.length <= 4_096 && path === path.trim() &&
    !/[\\\u0000-\u001f\u007f]/u.test(path) && !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Read the service's typed delivery receipt from the existing v1 tool result. */
export function readDocumentOutput(event: Event) {
  const payload = event.payload?.kind;
  const call = payload?.case === "toolCallCompleted" ? payload.value.toolCall : undefined;
  const owner = event.identity;
  if (call === undefined || owner === undefined || !call.toolCallId || !call.sessionId || !call.runId || !call.attemptId ||
      owner.operationId !== call.toolCallId || owner.sessionId !== call.sessionId ||
      owner.runId !== call.runId || owner.attemptId !== call.attemptId ||
      call.toolProviderId !== DOCUMENT_TOOL_PROVIDER_ID || call.state !== ToolCallState.SUCCEEDED ||
      call.result === undefined || call.result.truncated) return undefined;
  const format = (Object.keys(DOCUMENT_WRITE_TOOLS) as DocumentOutputFormat[])
    .find(candidate => DOCUMENT_WRITE_TOOLS[candidate] === call.toolId);
  if (format === undefined) return undefined;
  const parts = call.result.parts.map(part => part.content);
  const file = parts.find(part => part.case === "fileChange")?.value;
  const artifact = parts.find(part => part.case === "artifact")?.value;
  const blob = artifact?.blob;
  if (file === undefined || !file.workspaceId || !isDocumentOutputPath(file.relativePath) ||
      !file.relativePath.toLowerCase().endsWith(`.${format}`) ||
      (file.action !== ToolFileAction.CREATED && file.action !== ToolFileAction.UPDATED) ||
      artifact?.kind !== ArtifactKind.FILE || blob === undefined || !blob.blobId || artifact.artifactId !== blob.blobId ||
      !/^[a-f0-9]{64}$/u.test(blob.sha256Hex) || file.revisionAfter !== `sha256:${blob.sha256Hex}`) return undefined;

  const text = (field: string): string | undefined => {
    const value = call.arguments.find(argument => argument.fieldPath === field && !argument.redacted)?.value;
    return value?.case === "text" ? value.value : undefined;
  };
  const theme = text("theme");
  const subtitle = text("subtitle");
  const slideTitle = text("slide.title");
  const slideSubtitle = text("slide.subtitle");
  const count = call.arguments.find(argument => argument.fieldPath === "count" && !argument.redacted)?.value;
  const cover = call.arguments.find(argument => argument.fieldPath === "cover" && !argument.redacted)?.value;
  const table = parts.find(part => part.case === "table")?.value;
  return { format, file, artifact, blob,
    ...(theme === "light" || theme === "dark" || theme === "navy" ? { theme } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(count?.case === "integer" && count.value > 0n && count.value <= 10_000n ? { count: Number(count.value) } : {}),
    ...(cover?.case === "boolean" ? { cover: cover.value } : {}),
    ...(format === "pptx" && slideTitle ? { slide: { title: slideTitle, ...(slideSubtitle ? { subtitle: slideSubtitle } : {}) } } : {}),
    ...(format === "xlsx" && table !== undefined ? { sheet: {
      columns: table.columns.slice(0, 3), rows: table.rows.slice(0, 4).map(row => row.cells.slice(0, 3))
    } } : {})
  };
}
