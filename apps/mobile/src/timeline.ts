import { MessageRole, ToolCallState, type Event, type ToolCall } from "@joko/contracts";
import { mobileInputSummary } from "./mobile-composer-document";
import {
  mobileImageGalleryPageSummary,
  mobileTimelineGalleryPages,
  type MobileImageGalleryPageSummary
} from "./mobile-image-gallery";
import {
  mobileTimelineArtifacts,
  type MobileTimelineArtifact
} from "./mobile-timeline-artifacts";

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
}

const PARTNER_PRIVATE_TOOL_NAMES = new Set([
  "mcp__joko_partners__send_private_message",
  "mcp__joko_28e1bfbb33986d6789e0c720__send_private_message"
]);
const PARTNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PARTNER_AVATAR = /^[a-z][a-z0-9-]{0,31}$/u;
const FORBIDDEN_INLINE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function timelineRows(events: readonly Event[]): TimelineRow[] {
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
      case "messageStarted": {
        const message = kind.value;
        if (message.role === MessageRole.USER && message.userInputAccepted) acceptedUserInputs.add(message.messageId);
        const images = mobileTimelineGalleryPages(event).map(mobileImageGalleryPageSummary);
        byId.set(message.messageId, { id: message.messageId, label: roleLabel(message.role),
          text: mobileInputSummary(message.userInput, message.userInputAccepted) || "…", sequence, eventId: event.eventId,
          kind: roleKind(message.role), completed: message.role === MessageRole.USER && message.userInputAccepted,
          ...(message.role === MessageRole.USER && message.userInputAccepted && event.identity?.operationId
            ? { operationId: event.identity.operationId }
            : {}),
          ...(images.length === 0 ? {} : { images }) });
        break;
      }
      case "textDelta": {
        const previous = byId.get(kind.value.messageId);
        if (previous) byId.set(previous.id, { ...previous, text: previous.text === "…" ? kind.value.delta : previous.text + kind.value.delta });
        break;
      }
      case "messageCompleted": {
        const message = kind.value;
        const previous = byId.get(message.messageId);
        const completedGalleryPages = mobileTimelineGalleryPages(event);
        const completedImages = completedGalleryPages.map(mobileImageGalleryPageSummary);
        const artifacts = mobileTimelineArtifacts(event).filter((artifact) => !completedGalleryPages.some((page) =>
          page.source.kind === "timeline" && page.source.contentKind === "block"
            && page.source.contentIndex === artifact.contentIndex
        ));
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
      case "toolCallStarted": {
        const callId = kind.value.toolCall?.toolCallId;
        if (callId) toolStarts.set(callId, [...(toolStarts.get(callId) ?? []), event]);
        byId.set(event.eventId, { id: event.eventId, label: "Tool", text: "Tool call started", sequence, eventId: event.eventId, kind: "tool", completed: false });
        break;
      }
      case "toolCallCompleted": {
        const candidate = partnerPrivatePreview(event, toolStarts.get(kind.value.toolCall?.toolCallId ?? "") ?? []);
        byId.set(event.eventId, { id: event.eventId, label: "Tool",
          text: candidate ? "Private message" : kind.value.toolCall?.state === ToolCallState.FAILED
            || kind.value.toolCall?.state === ToolCallState.ABORTED ? "Tool call failed" : "Tool call completed",
          sequence, eventId: event.eventId, kind: "tool", completed: true,
          ...(candidate === undefined ? {} : { partnerPrivatePreview: candidate }) });
        break;
      }
      case "runDone":
        byId.set(event.eventId, { id: event.eventId, label: "Run", text: "Run finished", sequence, eventId: event.eventId, kind: "activity", completed: false });
        break;
      default:
        byId.set(event.eventId, { id: event.eventId, label: "Activity", text: kind.case.replace(/([A-Z])/g, " $1").trim(), sequence, eventId: event.eventId, kind: "activity", completed: false });
    }
  }
  return [...byId.values()].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.id.localeCompare(b.id));
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
