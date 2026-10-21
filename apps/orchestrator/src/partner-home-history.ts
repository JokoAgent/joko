import { createHash } from "node:crypto";
import type { BlobRef, MessageBlock } from "@joko/core";
import type { OperationalStore } from "@joko/store";

/** Visible conversation only. Native requests, thinking, tool traces and queue bodies never move. */
export function copyPartnerHomeHistory(input: { readonly store: OperationalStore; readonly requestId: string;
  readonly sourceSessionId: string; readonly targetSessionId: string; readonly throughCursor: bigint;
  readonly unavailableArtifactIds: ReadonlySet<string>;
  readonly readThroughCursor: bigint; readonly sourceName: string; readonly assertCurrent: () => void }): {
    readonly count: number; readonly readThroughCursor: bigint;
  } {
  const { store } = input;
  let afterCursor = 0n, count = 0, readThroughCursor = 0n;
  const target = store.getSession(input.targetSessionId).descriptor;
  const artifactCopies = new Map<string, BlobRef>();
  const copyAudio = (audio: import("@joko/core").AudioArtifactMetadata): import("@joko/core").AudioArtifactMetadata => {
    const { artwork, ...rest } = audio, copied = artwork && copyArtifact(artwork.blob);
    return { ...rest, ...(copied && artwork ? { artwork: { ...artwork, blob: copied } } : {}) };
  };
  const copyArtifact = (blob: BlobRef): BlobRef | undefined => {
    if (input.unavailableArtifactIds.has(blob.id)) return undefined;
    const known = artifactCopies.get(blob.id); if (known) return known;
    input.assertCurrent(); const source = store.findArtifact(blob.id);
    if (!source || source.deletedAt !== undefined) return undefined;
    if (source.sessionId !== undefined && source.sessionId !== input.sourceSessionId
      || source.blob.sha256 !== blob.sha256 || source.blob.byteLength !== blob.byteLength) {
      throw new Error("The original Partner attachment is unavailable.");
    }
    const id = `partner-home-artifact-${hash([input.requestId, target.id, blob.id])}`;
    const audio = (source.metadata as { audio?: import("@joko/core").AudioArtifactMetadata } | undefined)?.audio;
    const metadata = audio === undefined ? {} : { audio: copyAudio(audio) };
    const copied = store.putArtifact({ id, sha256: source.blob.sha256, byteLength: source.blob.byteLength,
      mimeType: source.blob.mimeType, ...(source.blob.fileName === undefined ? {} : { fileName: source.blob.fileName }),
      storageKey: source.storageKey, sessionId: target.id, createdAt: source.createdAt, metadata,
      purpose: "partner_home_history", traceId: `partner-home:${input.requestId}` });
    artifactCopies.set(blob.id, copied.blob); return copied.blob;
  };
  for (;;) {
    input.assertCurrent();
    const events = store.listEvents({ sessionId: input.sourceSessionId, afterCursor, limit: 1_000 });
    if (!events.length) break;
    for (const event of events) {
      if (event.globalCursor > input.throughCursor) return { count, readThroughCursor };
      afterCursor = event.globalCursor;
      if (event.payload.type !== "message_complete" || event.payload.partnerPrivateOrigin !== undefined || event.payload.automaticContinuation || event.payload.objectiveContinuation) continue;
      const payload = event.payload;
      const blocks: MessageBlock[] = [];
      for (const block of payload.blocks) {
        if (block.kind === "text") blocks.push(block);
        else if (block.kind === "image" || block.kind === "artifact") {
          if (payload.role !== "user") {
            blocks.push({ kind: "text", text: `[${block.kind === "artifact" ? block.label : block.alt ?? block.blob.fileName ?? "Image"} · ${input.sourceName}]` });
            continue;
          }
          const blob = copyArtifact(block.blob);
          if (!blob) { blocks.push({ kind: "text", text: `[Attachment: ${block.kind === "artifact" ? block.label : block.alt ?? block.blob.fileName ?? "Image"}]` }); continue; }
          if (block.kind === "image") blocks.push({ ...block, blob });
          else {
            const audioMetadata = block.audioMetadata && copyAudio(block.audioMetadata);
            blocks.push({ ...block, blob, ...(audioMetadata === undefined ? {} : { audioMetadata }) });
          }
        }
      }
      if (!blocks.length) continue;
      const id = `partner-home-history-${hash([input.requestId, target.id, event.id])}`;
      const copied = store.findEvent(id, { includeTombstoned: true }) ?? store.appendEventIfAbsent({ id,
        emittedAt: event.emittedAt, backendId: target.backendId, targetId: target.targetId, sessionId: target.id,
        generation: target.binding.generation, traceId: `partner-home:${input.requestId}`,
        payload: { type: "message_complete", role: payload.role, blocks } });
      if (event.globalCursor <= input.readThroughCursor) readThroughCursor = copied.globalCursor;
      count++;
    }
    if (events.length < 1_000) break;
  }
  input.assertCurrent(); return { count, readThroughCursor };
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
