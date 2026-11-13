import { MessageRole, PiMessageLifecycleKind } from "@joko/contracts";
import type { MobileState } from "./mobile-client";
import {
  buildMobileMessageDeepLink,
  buildMobileTaskDeepLink,
  parseMobileNativeIntent,
  type MobileNativeIntentSnapshot
} from "./mobile-native-intent";
import type { TimelineRow } from "./timeline";

export const mobileCopyLinkTimeoutMilliseconds = 5_000;

export interface MobileCopyLinkRuntime {
  writeText(value: string): Promise<void>;
}

export type MobileCopyLinkResult = "copied" | "busy";

export interface MobileCopyLinkAuthority {
  readonly profileId: string;
  readonly sessionId: string;
  readonly requiresSelectedSession: boolean;
  readonly messageId?: string;
  readonly messageEventId?: string;
}

export function mobileMessageLinkAvailable(
  state: Pick<MobileState, "selectedId" | "taskSource" | "window" | "older" | "detail" | "live">,
  row: Pick<TimelineRow, "kind" | "id" | "eventId">
): boolean {
  if (row.kind !== "assistant" || !state.selectedId || state.taskSource?.kind === "joined") return true;
  const events = state.window ?? [...state.older, ...(state.detail?.timeline ?? []), ...state.live];
  const event = events.findLast(candidate => candidate.eventId === row.eventId && candidate.identity?.sessionId === state.selectedId);
  const completion = event?.payload?.kind;
  const lifecycle = event?.pi?.payload;
  // Pi's live message_end has a product event ID. Native adoption supplies
  // the persisted entry identity and may remove that temporary event from history.
  return !(completion?.case === "messageCompleted" && completion.value.role === MessageRole.ASSISTANT
    && completion.value.messageId === row.id && lifecycle?.case === "messageLifecycle"
    && lifecycle.value.kind === PiMessageLifecycleKind.MESSAGE_END && !completion.value.nativeIdentity?.entryId);
}

export function claimMobileCopyLinkAuthority(
  snapshot: MobileNativeIntentSnapshot,
  input: {
    readonly sessionId: string;
    readonly requiresSelectedSession: boolean;
    readonly messageId?: string;
    readonly messageEventId?: string;
  }
): MobileCopyLinkAuthority | undefined {
  if (snapshot.activeProfileId === undefined) return undefined;
  const authority = Object.freeze({
    profileId: snapshot.activeProfileId,
    sessionId: input.sessionId,
    requiresSelectedSession: input.requiresSelectedSession,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.messageEventId === undefined ? {} : { messageEventId: input.messageEventId })
  });
  return mobileCopyLinkAuthorityMatches(authority, snapshot) ? authority : undefined;
}

export function mobileCopyLinkAuthorityMatches(
  authority: MobileCopyLinkAuthority,
  snapshot: MobileNativeIntentSnapshot
): boolean {
  if ((snapshot.status !== "connected" && snapshot.status !== "offline")
    || snapshot.activeProfileId !== authority.profileId
    || snapshot.sessionIds.filter((sessionId) => sessionId === authority.sessionId).length !== 1
    || authority.requiresSelectedSession && snapshot.selectedSessionId !== authority.sessionId) return false;
  if (authority.messageId === undefined) return authority.messageEventId === undefined;
  return snapshot.messages.filter((message) => message.messageId === authority.messageId
    && (authority.messageEventId === undefined || message.eventId === authority.messageEventId)).length === 1;
}

/**
 * Serializes native clipboard writes. A timed-out native promise retains ownership until it really
 * settles so a late write cannot overwrite a newer copied link.
 */
export class MobileCopyLinkWriter {
  #pending: Promise<void> | undefined;

  constructor(private readonly runtime: MobileCopyLinkRuntime) {}

  get busy(): boolean { return this.#pending !== undefined; }

  async copy(value: string, timeoutMilliseconds = mobileCopyLinkTimeoutMilliseconds): Promise<MobileCopyLinkResult> {
    const intent = parseMobileNativeIntent(value);
    if (intent?.kind !== "session" || intent.profileId !== undefined) {
      throw new Error("Only a canonical public Joko task link may be copied here.");
    }
    const canonical = intent.messageId === undefined
      ? buildMobileTaskDeepLink(intent.sessionId)
      : buildMobileMessageDeepLink(intent.sessionId, intent.messageId, intent.messageEventId);
    if (value !== canonical) throw new Error("Only a canonical public Joko task link may be copied here.");
    if (this.#pending !== undefined) return "busy";
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw new Error("The clipboard deadline must be a positive integer.");
    }

    const raw = Promise.resolve().then(() => this.runtime.writeText(value));
    this.#pending = raw;
    void raw.finally(() => {
      if (this.#pending === raw) this.#pending = undefined;
    }).catch(() => undefined);
    await withDeadline(raw, timeoutMilliseconds);
    return "copied";
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The system clipboard did not finish in time.")), timeoutMilliseconds);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
