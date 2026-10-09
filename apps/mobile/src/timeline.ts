import { MessageInputDelivery, MessageRole, ToolCallState, type Event, type PartnerPrivateMessageOrigin, type ToolCall } from "@joko/contracts";
import { mobileInputSummary } from "./mobile-composer-document";
import { mobileTimelineContent, mobileTimelineContentSourceKey, mobileTimelineToolMediaEvents } from "./mobile-timeline-content";
import { projectMobileToolCall, mobileToolCallScopeKey, mobileToolCallCompleted, type MobileToolCallView } from "./mobile-tool-call";
import {
  mobileImageGalleryPageSummary,
  mobileTimelineGalleryPages,
  type MobileImageGalleryPageSummary
} from "./mobile-image-gallery";
import {
  mobileTimelineArtifacts,
  type MobileTimelineArtifact
} from "./mobile-timeline-artifacts";
import { mobileEventTimestamp, mobileMessageEventScope, mobileMessageScope, mobileThinkingViews,
  type MobileThinkingView } from "./mobile-thinking-projection";
import type { MobileInlinePlan } from "./mobile-plan-projection";

export type MobileTimelineMessagePart =
  | { readonly kind: "text"; readonly contentIndex: number; readonly text: string }
  | { readonly kind: "thinking"; readonly contentIndex: number; readonly thinking: MobileThinkingView }
  | { readonly kind: "image"; readonly contentIndex: number; readonly image: MobileImageGalleryPageSummary }
  | { readonly kind: "artifact"; readonly contentIndex: number; readonly artifact: MobileTimelineArtifact };

/** A display and navigation hint. The Partner service must authorize every open. */
export interface MobilePartnerPrivatePreviewCandidate {
  readonly threadId: string;
  readonly targetPartnerId: string;
  readonly targetName: string;
  readonly preview?: string;
}

export interface TimelineRow {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly sequence: bigint;
  readonly eventId: string;
  readonly kind: "user" | "assistant" | "system" | "tool" | "status" | "error" | "activity";
  readonly completed: boolean;
  /** Exact durable send identity; present only on canonical accepted user input. */
  readonly operationId?: string;
  /** Page-local presentation only; never sourced from or written to durable events. */
  readonly optimistic?: boolean;
  readonly quoteSource?: {
    readonly sourceMessageId: string;
    readonly sourceEventId: string;
    readonly text: string;
  };
  readonly images?: readonly MobileImageGalleryPageSummary[];
  readonly artifacts?: readonly MobileTimelineArtifact[];
  readonly partnerPrivatePreview?: MobilePartnerPrivatePreviewCandidate;
  readonly tool?: MobileToolCallView;
  /** Ordered presentation remains inside this canonical message and keeps its actions. */
  readonly messageParts?: readonly MobileTimelineMessagePart[];
  readonly ownerScope?: string;
  readonly runScope?: string;
  readonly startedAtMs?: number;
  readonly lastActivityAtMs?: number;
  readonly turnFinal?: boolean;
  readonly compactBoundary?: boolean;
  readonly workActivity?: boolean;
  readonly workStreaming?: boolean;
  readonly persistentTask?: boolean;
  readonly answerSequence?: bigint;
  readonly completionCursor?: bigint;
  readonly internalInput?: boolean;
  readonly partnerPrivateOrigin?: PartnerPrivateMessageOrigin;
  /** A durable Run outcome, distinct from a completed message segment. */
  readonly runOutcome?: "completed" | "failed" | "stopped";
  /** Retain an owned collaboration delivery even when its technical tool is hidden. */
  readonly partnerDelivery?: boolean;
  readonly runStopped?: boolean;
  /** The exact latest plan edge places its structural card without changing this row's raw cursor. */
  readonly planSequence?: bigint;
  readonly plan?: MobileInlinePlan;
}

const PARTNER_PRIVATE_TOOL_NAMES = new Set([
  "mcp__joko_partners__send_private_message",
  "mcp__joko_28e1bfbb33986d6789e0c720__send_private_message"
]);
const PARTNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PARTNER_AVATAR = /^[a-z][a-z0-9-]{0,31}$/u;
const FORBIDDEN_INLINE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function timelineRows(events: readonly Event[], sessionStreaming = false): TimelineRow[] {
  const byId = new Map<string, TimelineRow>();
  const toolStarts = new Map<string, Event[]>();
  const acceptedUserInputs = new Set<string>();
  const unique = new Map(events.map((event) => [event.eventId, event]));
  const ordered = [...unique.values()].sort((a, b) => (a.cursor?.sequence ?? 0n) < (b.cursor?.sequence ?? 0n) ? -1
    : (a.cursor?.sequence ?? 0n) > (b.cursor?.sequence ?? 0n) ? 1 : 0);
  for (const event of ordered) {
    const kind = event.payload?.kind;
    const sequence = event.cursor?.sequence ?? 0n;
    if (!kind?.case) continue;
    switch (kind.case) {
      case "sessionChanged":
      case "runtimeCommandsChanged":
      case "runChanged":
      case "queueItemChanged":
      case "thinkingDelta":
        break;
      case "messageStarted": {
        const message = kind.value;
        if (message.role === MessageRole.USER && message.userInputAccepted) acceptedUserInputs.add(message.messageId);
        const images = mobileTimelineGalleryPages(event).map(mobileImageGalleryPageSummary);
        byId.set(message.messageId, { id: message.messageId, label: roleLabel(message.role),
          text: mobileInputSummary(message.userInput, message.userInputAccepted) || "…", sequence, eventId: event.eventId,
          kind: roleKind(message.role), completed: message.role === MessageRole.USER && message.userInputAccepted,
          ...(message.role !== MessageRole.USER ? {} : {
            internalInput: message.automaticContinuation || message.objectiveContinuation !== undefined
              || message.automationOrigin !== undefined || message.inputDelivery === MessageInputDelivery.SCHEDULER
          }),
          ...(message.partnerPrivateOrigin === undefined ? {} : { partnerPrivateOrigin: message.partnerPrivateOrigin }),
          ...(message.role === MessageRole.USER && message.userInputAccepted && event.identity?.operationId
            ? { operationId: event.identity.operationId }
            : {}),
          ...(images.length === 0 ? {} : { images }) });
        break;
      }
      case "textDelta": {
        const previous = byId.get(kind.value.messageId);
        if (previous && !previous.completed) byId.set(previous.id, { ...previous, text: previous.text === "…" ? kind.value.delta : previous.text + kind.value.delta });
        break;
      }
      case "messageCompleted": {
        const message = kind.value;
        const previous = byId.get(message.messageId);
        const completedGalleryPages = mobileTimelineGalleryPages(event);
        const completedImages = completedGalleryPages.map(mobileImageGalleryPageSummary);
        const artifacts = mobileTimelineArtifacts(event).filter((artifact) => !completedGalleryPages.some((page) =>
          "eventId" in page.source && mobileTimelineContentSourceKey(page.source) === mobileTimelineContentSourceKey(artifact.source)));
        const images = message.role === MessageRole.USER && acceptedUserInputs.has(message.messageId)
          && previous?.images && previous.images.length > 0
          ? previous.images
          : completedImages;
        const blocks = message.blocks.flatMap((block) => block.content.case === "text" ? [block.content.value]
          : block.content.case === "image" ? ["[Image]"] : block.content.case === "artifact" ? ["[Artifact]"]
            : block.content.case === "toolCall" ? ["[Tool call]"] : []);
        const acceptedInput = message.role === MessageRole.USER && acceptedUserInputs.has(message.messageId)
          ? previous?.text
          : undefined;
        const quoteText = message.role === MessageRole.ASSISTANT && message.blocks.length > 0
          && message.blocks.every((block) => block.content.case === "text")
          ? message.blocks.map((block) => block.content.case === "text" ? block.content.value : "").join("\n")
          : undefined;
        byId.set(message.messageId, { id: message.messageId, label: previous?.label || roleLabel(message.role),
          text: acceptedInput || blocks.join("\n") || previous?.text || "Completed", sequence: previous?.sequence ?? sequence,
          eventId: event.eventId, kind: roleKind(message.role), completed: true,
          completionCursor: sequence,
          ...(previous?.internalInput === undefined ? {} : { internalInput: previous.internalInput }),
          ...((message.partnerPrivateOrigin ?? previous?.partnerPrivateOrigin) === undefined ? {}
            : { partnerPrivateOrigin: message.partnerPrivateOrigin ?? previous?.partnerPrivateOrigin }),
          ...(previous?.operationId === undefined ? {} : { operationId: previous.operationId }),
          ...(quoteText?.trim() ? { quoteSource: {
            sourceMessageId: message.messageId,
            sourceEventId: event.eventId,
            text: quoteText
          } } : {}),
          ...(images.length === 0 ? {} : { images }),
          ...(artifacts.length === 0 ? {} : { artifacts }) });
        break;
      }
      case "statusStream":
        byId.set(event.eventId, { id: event.eventId, label: "Status", text: kind.value.label + (kind.value.detail ? ` · ${kind.value.detail}` : ""), sequence, eventId: event.eventId, kind: "status", completed: false });
        break;
      case "recoverableError":
      case "terminalError":
        byId.set(event.eventId, { id: event.eventId, label: "Error", text: kind.value.error?.message || "The task reported an error.", sequence, eventId: event.eventId, kind: "error", completed: false });
        break;
      case "toolCallStarted":
      case "toolCallUpdated":
      case "toolCallCompleted": {
        const callId = kind.value.toolCall?.toolCallId ?? "";
        if (kind.case === "toolCallStarted" && callId) toolStarts.set(callId, [...(toolStarts.get(callId) ?? []), event]);
        const scopeKey = mobileToolCallScopeKey(event);
        if (scopeKey === undefined) {
          byId.set(event.eventId, { id: event.eventId, label: "Tool", text: "Tool call unavailable",
            sequence, eventId: event.eventId, kind: "tool", completed: false });
          break;
        }
        const previous = byId.get(scopeKey);
        const tool = projectMobileToolCall(event, previous?.tool)!;
        if (previous?.tool === tool) break;
        const candidate = kind.case === "toolCallCompleted" ? partnerPrivatePreview(event, toolStarts.get(callId) ?? []) : undefined;
        byId.set(tool.scopeKey, { id: tool.scopeKey, label: "Tool", text: tool.name,
          sequence: previous?.sequence ?? sequence, eventId: event.eventId, kind: "tool", completed: mobileToolCallCompleted(tool), tool,
          ...(candidate === undefined ? {} : { partnerPrivatePreview: candidate }) });
        break;
      }
      case "runDone":
        byId.set(event.eventId, { id: event.eventId, label: "Run", text: "Run finished", sequence, eventId: event.eventId, kind: "activity", completed: false });
        break;
      case "runAborted":
        byId.set(event.eventId, { id: event.eventId, label: "Run", text: "Run stopped", sequence, eventId: event.eventId,
          kind: "activity", completed: true, runStopped: true });
        break;
      case "artifactProduced":
      case "imageProduced": {
        const media = timelineMedia([event]);
        if (media.images?.length || media.artifacts?.length) byId.set(event.eventId, {
          id: event.eventId, label: kind.case === "imageProduced" ? "Image" : "File", text: "",
          sequence, eventId: event.eventId, kind: "activity", completed: true, ...media
        });
        break;
      }
      default:
        byId.set(event.eventId, { id: event.eventId, label: "Activity", text: kind.case.replace(/([A-Z])/g, " $1").trim(), sequence, eventId: event.eventId, kind: "activity", completed: false });
    }
  }
  const toolMediaEvents = mobileTimelineToolMediaEvents(ordered);
  const toolBlobs = new Set<string>();
  for (const [scopeKey, mediaEvents] of toolMediaEvents) {
    const row = byId.get(scopeKey);
    if (row?.tool) byId.set(scopeKey, { ...row, ...timelineMedia(mediaEvents) });
    for (const mediaEvent of mediaEvents) for (const content of mobileTimelineContent(mediaEvent)) {
      const call = mediaEvent.payload?.kind;
      const runId = call?.case === "toolCallStarted" || call?.case === "toolCallUpdated" || call?.case === "toolCallCompleted"
        ? call.value.toolCall?.runId ?? "" : "";
      toolBlobs.add(JSON.stringify([mediaEvent.identity?.sessionId, runId, content.blob.blobId, content.blob.sha256Hex]));
    }
  }
  for (const event of ordered) if (event.payload?.kind.case === "artifactProduced") {
    const artifact = event.payload.kind.value.artifact;
    if (artifact?.blob && toolBlobs.has(JSON.stringify([artifact.sessionId, artifact.runId, artifact.blob.blobId, artifact.blob.sha256Hex]))) {
      byId.delete(event.eventId);
    }
  }
  attachThinkingParts(byId, ordered, sessionStreaming);
  return [...byId.values()].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.id.localeCompare(b.id));
}

function attachThinkingParts(rows: Map<string, TimelineRow>, ordered: readonly Event[], sessionStreaming: boolean): void {
  const events = new Map(ordered.map((event) => [event.eventId, event]));
  const views = mobileThinkingViews(ordered, sessionStreaming);
  const byMessage = new Map<string, MobileThinkingView[]>();
  const textParts = new Map<string, Map<number, string>>();
  const starts = new Map<string, number>();
  const stoppedRuns = new Set<string>();
  const outcomes = new Map<string, NonNullable<TimelineRow["runOutcome"]>>();
  const sealedMessages = new Set<string>();
  for (const view of views) byMessage.set(view.messageScope, [...(byMessage.get(view.messageScope) ?? []), view]);
  for (const event of ordered) {
    const scope = mobileMessageEventScope(event);
    const kind = event.payload?.kind;
    if (!scope || !kind?.case) continue;
    if (kind.case === "runDone" || kind.case === "runAborted" || kind.case === "terminalError") {
      if (event.identity?.runId) {
        stoppedRuns.add(scope.runScope);
        outcomes.set(scope.runScope, kind.case === "runDone" ? "completed" : kind.case === "runAborted" ? "stopped" : "failed");
      }
    }
    if (kind.case === "messageStarted") {
      const at = mobileEventTimestamp(event);
      if (at !== undefined) starts.set(mobileMessageScope(scope, kind.value.messageId), at);
    }
    if (kind.case === "messageCompleted") sealedMessages.add(mobileMessageScope(scope, kind.value.messageId));
    if (kind.case !== "textDelta" || !Number.isSafeInteger(kind.value.contentIndex) || kind.value.contentIndex < 0) continue;
    const key = mobileMessageScope(scope, kind.value.messageId);
    if (sealedMessages.has(key) || stoppedRuns.has(scope.runScope)) continue;
    const parts = textParts.get(key) ?? new Map<number, string>();
    parts.set(kind.value.contentIndex, (parts.get(kind.value.contentIndex) ?? "") + kind.value.delta);
    textParts.set(key, parts);
  }
  // A window can start inside a message. Thinking deltas still own the real message ID.
  for (const view of views) if (!view.completed && !rows.has(view.messageId)) rows.set(view.messageId, {
    id: view.messageId, label: "Assistant", text: "", kind: "assistant", eventId: view.eventId,
    sequence: view.sequence, completed: false
  });
  for (const [id, row] of rows) {
    const event = events.get(row.eventId);
    const scope = event && mobileMessageEventScope(event);
    if (!event || !scope) continue;
    const messageKey = mobileMessageScope(scope, id);
    const thinking = byMessage.get(messageKey) ?? [];
    const parts: MobileTimelineMessagePart[] = [];
    const payload = event.payload?.kind;
    if (row.kind === "assistant" && payload?.case === "messageCompleted" && payload.value.blocks.length > 0
      && payload.value.blocks.every((block) => block.content.case === "thinking") && thinking.length === 0) {
      rows.delete(id);
      continue;
    }
    if (row.kind === "assistant" && thinking.length) {
      if (payload?.case === "messageCompleted") {
        const pages = mobileTimelineGalleryPages(event);
        for (let contentIndex = 0; contentIndex < payload.value.blocks.length; contentIndex++) {
          const block = payload.value.blocks[contentIndex]!;
          if (block.content.case === "thinking") {
            const view = thinking.find((item) => item.contentIndex === contentIndex);
            if (view) parts.push({ kind: "thinking", contentIndex, thinking: view });
          } else if (block.content.case === "text") parts.push({ kind: "text", contentIndex, text: block.content.value });
          else if (block.content.case === "image" || block.content.case === "artifact") {
            const page = pages.find((item) => item.source.kind === "timeline" && item.source.contentIndex === contentIndex);
            const artifact = row.artifacts?.find((item) => item.source.kind === "timeline" && item.source.contentIndex === contentIndex);
            if (page) parts.push({ kind: "image", contentIndex, image: mobileImageGalleryPageSummary(page) });
            else if (artifact) parts.push({ kind: "artifact", contentIndex, artifact });
            else parts.push({ kind: "text", contentIndex, text: block.content.case === "image" ? "[Image]" : "[Artifact]" });
          } else if (block.content.case === "toolCall") parts.push({ kind: "text", contentIndex, text: "[Tool call]" });
        }
      } else {
        parts.push(...thinking.map((view): MobileTimelineMessagePart => ({ kind: "thinking", contentIndex: view.contentIndex, thinking: view })));
        for (const [contentIndex, text] of textParts.get(messageKey) ?? []) parts.push({ kind: "text", contentIndex, text });
        parts.sort((a, b) => a.contentIndex - b.contentIndex);
      }
    }
    const startedAtMs = starts.get(messageKey) ?? row.tool?.startedAtMs ?? mobileEventTimestamp(event);
    const thoughtOnly = parts.length > 0 && parts.every((part) => part.kind === "thinking" || part.kind === "text" && part.text.trim() === "");
    rows.set(id, { ...row, ownerScope: scope.ownerScope, runScope: scope.runScope,
      ...(outcomes.has(scope.runScope) ? { runOutcome: outcomes.get(scope.runScope)! } : {}),
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      ...(mobileEventTimestamp(event) === undefined ? {} : { lastActivityAtMs: mobileEventTimestamp(event) }),
      ...(row.kind === "assistant" && row.completed && stoppedRuns.has(scope.runScope) ? { turnFinal: true } : {}),
      ...(row.kind === "assistant" && row.completed && !thoughtOnly ? { answerSequence: event.cursor!.sequence } : {}),
      ...(payload?.case === "compactionChanged" ? { compactBoundary: true } : {}),
      ...(parts.length ? { messageParts: parts, workActivity: thoughtOnly, workStreaming: thinking.some((view) => view.streaming) } : {})
    });
  }
}

function timelineMedia(events: readonly Event[]): Pick<TimelineRow, "images" | "artifacts"> {
  const pages = events.flatMap(mobileTimelineGalleryPages);
  const imageSources = new Set(pages.flatMap((page) => "eventId" in page.source ? [mobileTimelineContentSourceKey(page.source)] : []));
  const seen = new Set<string>();
  const images = pages.filter((page) => {
    const key = JSON.stringify([page.blob.blobId, page.sha256Hex]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(mobileImageGalleryPageSummary);
  const artifacts = events.flatMap(mobileTimelineArtifacts).filter((artifact) => !imageSources.has(mobileTimelineContentSourceKey(artifact.source)));
  return { ...(images.length ? { images } : {}), ...(artifacts.length ? { artifacts } : {}) };
}

function partnerPrivatePreview(event: Event, starts: readonly Event[]): MobilePartnerPrivatePreviewCandidate | undefined {
  const payload = event.payload?.kind;
  if (payload?.case !== "toolCallCompleted") return undefined;
  const call = payload.value.toolCall;
  // Current event projection puts the provider identity in toolId and leaves toolProviderId empty.
  if (!call || !PARTNER_PRIVATE_TOOL_NAMES.has(call.toolId) || call.toolProviderId !== ""
    || call.state !== ToolCallState.SUCCEEDED
    || !event.identity?.sessionId || call.sessionId !== event.identity.sessionId
    || call.result?.truncated || call.result?.completeOutput !== undefined || call.result?.parts.length !== 1) {
    return undefined;
  }
  const content = call.result.parts[0]?.content;
  if (content?.case !== "text" || content.value.length > 4_096) return undefined;
  const result = jsonRecord(content.value);
  const target = asRecord(result?.["target_partner"]);
  const threadId = selectedId(result?.["thread_id"]);
  const messageId = selectedId(result?.["message_id"]);
  const targetPartnerId = selectedId(target?.["id"]);
  const targetName = selectedInlineText(target?.["display_name"], 100);
  const remaining = result?.["remaining_messages"];
  if (!hasOnlyKeys(result, ["thread_id", "message_id", "target_partner", "delivery_status",
    "remaining_messages", "conversation_ended"])
    || !hasOnlyKeys(target, ["id", "display_name", "avatar", "status", "ready"])
    || threadId === undefined || messageId === undefined || targetPartnerId === undefined
    || targetName === undefined || typeof target?.["avatar"] !== "string"
    || !PARTNER_AVATAR.test(target["avatar"])
    || !["active", "archived", "deleted"].includes(String(target["status"]))
    || typeof target["ready"] !== "boolean" || result?.["delivery_status"] !== "delivered"
    || typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > 12
    || typeof result["conversation_ended"] !== "boolean") return undefined;
  const preview = matchingMessagePreview(event, call, targetPartnerId, starts);
  return { threadId, targetPartnerId, targetName, ...(preview === undefined ? {} : { preview }) };
}

function matchingMessagePreview(event: Event, completed: ToolCall, targetPartnerId: string,
  starts: readonly Event[]): string | undefined {
  const matching = starts.filter((start) => {
    const payload = start.payload?.kind;
    const call = payload?.case === "toolCallStarted" ? payload.value.toolCall : undefined;
    return call !== undefined && call.toolCallId === completed.toolCallId && call.toolId === completed.toolId
      && call.sessionId === completed.sessionId && call.runId === completed.runId
      && call.attemptId === completed.attemptId && start.identity?.sessionId === event.identity?.sessionId
      && start.cursor?.generation === event.cursor?.generation
      && start.cursor !== undefined && event.cursor !== undefined
      && start.cursor.sequence < event.cursor.sequence;
  });
  if (matching.length !== 1) return undefined;
  const call = matching[0]?.payload?.kind;
  const args = call?.case === "toolCallStarted" ? call.value.toolCall?.arguments : undefined;
  if (args?.length !== 1 || args[0]?.fieldPath !== "$" || args[0].redacted
    || args[0].value.case !== "text" || args[0].value.value.length > 17_000) return undefined;
  const input = jsonRecord(args[0].value.value);
  const message = selectedMultilineText(input?.["message"], 16_000);
  if (!hasOnlyKeys(input, ["target_partner_id", "message"])
    || selectedId(input?.["target_partner_id"]) !== targetPartnerId || message === undefined) return undefined;
  return message.slice(0, 180);
}

function jsonRecord(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>> | undefined, allowed: readonly string[]): boolean {
  return value !== undefined && Object.keys(value).every((key) => allowed.includes(key));
}

function selectedId(value: unknown): string | undefined {
  return typeof value === "string" && PARTNER_ID.test(value) ? value : undefined;
}

function selectedInlineText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !FORBIDDEN_INLINE.test(value) ? value : undefined;
}

function selectedMultilineText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized.length > 0 && normalized.length <= maximum && !FORBIDDEN_MULTILINE.test(normalized)
    ? normalized : undefined;
}

function roleLabel(role: MessageRole): string {
  if (role === MessageRole.USER) return "You";
  if (role === MessageRole.ASSISTANT) return "Assistant";
  if (role === MessageRole.SYSTEM) return "System";
  if (role === MessageRole.TOOL) return "Tool";
  return "Message";
}

function roleKind(role: MessageRole): TimelineRow["kind"] {
  if (role === MessageRole.USER) return "user";
  if (role === MessageRole.ASSISTANT) return "assistant";
  if (role === MessageRole.SYSTEM) return "system";
  if (role === MessageRole.TOOL) return "tool";
  return "activity";
}
