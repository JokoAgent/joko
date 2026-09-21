import {
  buildMobileMessageDeepLink,
  buildMobileTaskDeepLink,
  parseMobileNativeIntent,
  type MobileNativeIntentSnapshot
} from "./mobile-native-intent";

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
