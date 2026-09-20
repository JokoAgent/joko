import { MessageRole, type Event } from "@joko/contracts";
import { mobileInputSummary } from "./mobile-composer-document";
import {
  mobileImageGalleryPageSummary,
  mobileTimelineGalleryPages,
  type MobileImageGalleryPageSummary
} from "./mobile-image-gallery";

export interface TimelineRow {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly sequence: bigint;
  readonly eventId: string;
  readonly kind: "user" | "assistant" | "system" | "tool" | "status" | "error" | "activity";
  readonly completed: boolean;
  readonly images?: readonly MobileImageGalleryPageSummary[];
}

export function timelineRows(events: readonly Event[]): TimelineRow[] {
  const byId = new Map<string, TimelineRow>();
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
        const completedImages = mobileTimelineGalleryPages(event).map(mobileImageGalleryPageSummary);
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
        byId.set(message.messageId, { id: message.messageId, label: previous?.label || roleLabel(message.role),
          text: acceptedInput || blocks.join("\n") || previous?.text || "Completed", sequence: previous?.sequence ?? sequence,
          eventId: event.eventId, kind: roleKind(message.role), completed: true,
          ...(images.length === 0 ? {} : { images }) });
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
        byId.set(event.eventId, { id: event.eventId, label: "Tool", text: "Tool call started", sequence, eventId: event.eventId, kind: "tool", completed: false });
        break;
      case "runDone":
        byId.set(event.eventId, { id: event.eventId, label: "Run", text: "Run finished", sequence, eventId: event.eventId, kind: "activity", completed: false });
        break;
      default:
        byId.set(event.eventId, { id: event.eventId, label: "Activity", text: kind.case.replace(/([A-Z])/g, " $1").trim(), sequence, eventId: event.eventId, kind: "activity", completed: false });
    }
  }
  return [...byId.values()].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.id.localeCompare(b.id));
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
