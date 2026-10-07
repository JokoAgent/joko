import { toBinary } from "@bufbuild/protobuf";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSchema, MessageInputDelivery, MessageRole, type Event, type NativeMessageIdentity } from "@joko/contracts";
import { plainTextMobileComposerDraft, restoreMobileComposerInput, type MobileComposerDraft } from "./mobile-composer-document";

export interface MobileMessageForkSource {
  readonly eventId: string; readonly messageId: string; readonly nativeEntryId: string;
  readonly sourceKey: string; readonly restoreInput: boolean; readonly draft?: MobileComposerDraft;
}

/** Native boundaries are opaque public identities; visible history never supplies a missing parent. */
export function resolveMobileMessageForkSource(events: readonly Event[], sessionId: string, eventId: string,
  generation: bigint, sessionActive: boolean): MobileMessageForkSource | undefined {
  const matches = events.filter((event) => event.eventId === eventId);
  if (matches.length !== 1) return undefined;
  const event = matches[0]!; const payload = event.payload?.kind;
  if (!exactId(sessionId) || !exactId(eventId) || event.identity?.sessionId !== sessionId || event.cursor?.generation !== generation
    || (payload?.case !== "messageStarted" && payload?.case !== "messageCompleted")) return undefined;
  const message = payload.value;
  if (!exactId(message.messageId) || (message.role !== MessageRole.USER && message.role !== MessageRole.ASSISTANT)
    || (payload.case === "messageStarted" && (message.role !== MessageRole.USER || !payload.value.userInputAccepted))) return undefined;
  const starts = events.filter((candidate) => candidate.identity?.sessionId === sessionId && candidate.cursor?.generation === generation
    && candidate.payload?.kind.case === "messageStarted" && candidate.payload.kind.value.messageId === message.messageId);
  if (starts.length > 1) return undefined;
  const start = starts[0]; const started = start?.payload?.kind.case === "messageStarted" ? start.payload.kind.value : undefined;
  if (started && started.role !== message.role) return undefined;
  const identity = mergeIdentity(message.nativeIdentity, started?.nativeIdentity);
  const nativeEntryId = message.role === MessageRole.USER ? identity?.parentEntryId : identity?.entryId;
  if (!nativeEntryId || !exactId(nativeEntryId)) return undefined;
  if (sessionActive) {
    if (message.role === MessageRole.USER && !stableInput(started?.inputDelivery)) return undefined;
    if (message.role === MessageRole.ASSISTANT && !events.some((candidate) => candidate.identity?.sessionId === sessionId
      && candidate.cursor?.generation === generation && (candidate.cursor.sequence ?? 0n) > (event.cursor?.sequence ?? 0n)
      && candidate.payload?.kind.case === "messageStarted" && candidate.payload.kind.value.role === MessageRole.USER
      && candidate.payload.kind.value.userInputAccepted && stableInput(candidate.payload.kind.value.inputDelivery))) return undefined;
  }
  try {
    const draft = message.role !== MessageRole.USER ? undefined
      : started?.userInputAccepted && started.userInput
        ? restoreMobileComposerInput(started.userInput, { sessionId, messageId: message.messageId, eventId: start!.eventId })
        : plainTextMobileComposerDraft(payload.case === "messageCompleted"
          ? payload.value.blocks.flatMap((block) => block.content.case === "text" ? [block.content.value] : []).join("\n") : "");
    return { eventId, messageId: message.messageId, nativeEntryId, restoreInput: message.role === MessageRole.USER,
      ...(draft ? { draft } : {}), sourceKey: JSON.stringify([eventId, nativeEntryId,
        bytesToHex(sha256(toBinary(EventSchema, event))), start ? bytesToHex(sha256(toBinary(EventSchema, start))) : ""]) };
  } catch { return undefined; }
}

function mergeIdentity(current: NativeMessageIdentity | undefined, started: NativeMessageIdentity | undefined): NativeMessageIdentity | undefined {
  if (current && started && ((current.entryId && started.entryId && current.entryId !== started.entryId)
    || (current.parentEntryId && started.parentEntryId && current.parentEntryId !== started.parentEntryId))) return undefined;
  return current ? { ...current, entryId: current.entryId || started?.entryId || "",
    parentEntryId: current.parentEntryId || started?.parentEntryId || "" } : started;
}
function stableInput(delivery: MessageInputDelivery | undefined): boolean {
  return delivery === MessageInputDelivery.PROMPT || delivery === MessageInputDelivery.FOLLOW_UP || delivery === MessageInputDelivery.SCHEDULER;
}
function exactId(value: string): boolean { return value.length > 0 && value.length <= 1_024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value); }
