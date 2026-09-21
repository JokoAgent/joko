import type { MobileState } from "./mobile-client";
import { timelineRows } from "./timeline";

export const mobileNativeIntentMaximumCharacters = 4_096;
export const mobileNativeIntentIdentityMaximumCharacters = 256;
export const mobileNativeIntentFocusSourceMaximumCharacters = 128;
export const mobileNativeIntentDuplicateWindowMilliseconds = 1_500;
export const mobileNativeIntentHistoryPageMaximum = 256;

export type MobileNativeIntent =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly profileId?: string;
      readonly messageId?: string;
      readonly messageEventId?: string;
    }
  | { readonly kind: "settings" }
  | { readonly kind: "focus"; readonly source?: string };

export interface MobileNativeIntentClaim {
  readonly sequence: number;
  readonly fingerprint: string;
  readonly intent: MobileNativeIntent;
}

export type MobileNativeIntentRecovery =
  | "connection-required"
  | "profile-unavailable"
  | "profile-connect-failed"
  | "session-unavailable"
  | "message-unavailable";

export interface MobileNativeIntentMessageFocus {
  readonly requestId: number;
  readonly sessionId: string;
  readonly messageId: string;
  readonly messageEventId?: string;
}

export interface MobileNativeIntentSnapshot {
  readonly status: MobileState["status"];
  readonly activeProfileId?: string;
  readonly savedProfileIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly selectedSessionId?: string;
  readonly messages: readonly {
    readonly messageId: string;
    readonly eventId: string;
  }[];
  readonly historyEnd: boolean;
  readonly historyKey: string;
}

export interface MobileNativeIntentRuntime {
  snapshot(): MobileNativeIntentSnapshot;
  connectProfile(profileId: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  loadAround(eventId: string): Promise<void>;
  loadOlder(): Promise<void>;
  returnLatest(): void;
  showPage(page: "connection" | "home" | "settings" | "task"): void;
  showSavedConnections(): void;
  showRecovery(recovery: MobileNativeIntentRecovery): void;
  clearRecovery(): void;
  focusMessage(focus: MobileNativeIntentMessageFocus): void;
  clearMessageFocus(): void;
  focusApplication(): void;
}

export interface MobileNativeIntentLinkingSource {
  addEventListener(event: "url", listener: (event: { readonly url: string }) => void): { remove(): void };
  getInitialURL(): Promise<string | null>;
}

export type MobileNativeIntentExecution =
  | "retired"
  | "focused"
  | "settings"
  | "session"
  | "message"
  | MobileNativeIntentRecovery;

export function isMobileIncomingShareUrl(value: unknown): value is string {
  return typeof value === "string" && /^joko:\/\/expo-sharing(?:[/?#]|$)/iu.test(value);
}

export function mobileConnectionStageRequired(activeProfileId: string | undefined, page: string): boolean {
  return page === "connection" || (activeProfileId === undefined && page !== "settings");
}

export function installMobileNativeIntentLinking(
  source: MobileNativeIntentLinkingSource,
  onUrl: (url: string) => boolean | void
): () => void {
  let active = true;
  let initialSettled = false;
  let acceptedWarmUrlBeforeInitial = false;
  const subscription = source.addEventListener("url", ({ url }) => {
    if (!active) return;
    const accepted = onUrl(url) !== false;
    if (!initialSettled && accepted) acceptedWarmUrlBeforeInitial = true;
  });
  void source.getInitialURL().then((url) => {
    // The initial URL predates any warm event. Once a valid warm event has been accepted,
    // never let the late initial promise overwrite that newer external intent.
    if (active && url !== null && !acceptedWarmUrlBeforeInitial) onUrl(url);
  }).catch(() => undefined).finally(() => {
    initialSettled = true;
  });
  return () => {
    active = false;
    subscription.remove();
  };
}

/** Parse only the public OS handoff surface. The privileged `joko://app` origin is rejected. */
export function parseMobileNativeIntent(value: unknown): MobileNativeIntent | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > mobileNativeIntentMaximumCharacters
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  let url: URL;
  try { url = new URL(value); }
  catch { return undefined; }
  if (url.protocol !== "joko:" || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.hostname === "task") return parseSessionIntent(url);
  if (url.hostname === "settings" && (url.pathname === "" || url.pathname === "/") && exactQuery(url, [])) {
    return Object.freeze({ kind: "settings" });
  }
  if (url.hostname === "focus") return parseFocusIntent(url);
  return undefined;
}

/** Build the public, portable task handoff. Device-local profile identity is intentionally omitted. */
export function buildMobileTaskDeepLink(sessionId: string): string {
  return buildMobileSessionDeepLink({ sessionId });
}

/** Build a public task handoff anchored to one exact durable message and, when known, its Event. */
export function buildMobileMessageDeepLink(
  sessionId: string,
  messageId: string,
  messageEventId?: string
): string {
  return buildMobileSessionDeepLink({ sessionId, messageId, messageEventId });
}

/**
 * Buffers only the latest valid navigation before the product is ready. A focus-only handoff never
 * supersedes navigation already being materialized. A later navigation invalidates an active claim.
 */
export class MobileNativeIntentDelivery {
  #active: MobileNativeIntentClaim | undefined;
  #lastCompleted: { readonly fingerprint: string; readonly at: number } | undefined;
  #latestSequence = 0;
  #pending: MobileNativeIntentClaim | undefined;
  #sequence = 0;

  offer(value: unknown, now = Date.now()): boolean {
    const intent = parseMobileNativeIntent(value);
    if (intent === undefined) return false;
    const fingerprint = mobileNativeIntentFingerprint(intent);
    if (intent.kind === "focus" && (this.#active !== undefined || this.#pending !== undefined)) return false;
    const latest = this.#pending ?? this.#active;
    if (latest?.fingerprint === fingerprint) return false;
    if (latest === undefined && this.#lastCompleted?.fingerprint === fingerprint
      && now - this.#lastCompleted.at >= 0
      && now - this.#lastCompleted.at <= mobileNativeIntentDuplicateWindowMilliseconds) return false;
    const claim = Object.freeze({ sequence: ++this.#sequence, fingerprint, intent });
    this.#latestSequence = claim.sequence;
    this.#pending = claim;
    return true;
  }

  take(ready = true): MobileNativeIntentClaim | undefined {
    if (!ready || this.#active !== undefined || this.#pending === undefined) return undefined;
    const claim = this.#pending;
    this.#pending = undefined;
    this.#active = claim;
    return claim;
  }

  isCurrent(claim: MobileNativeIntentClaim): boolean {
    return this.#active === claim && this.#pending === undefined && claim.sequence === this.#latestSequence;
  }

  complete(claim: MobileNativeIntentClaim, now = Date.now()): boolean {
    if (this.#active !== claim) return false;
    this.#active = undefined;
    this.#lastCompleted = Object.freeze({ fingerprint: claim.fingerprint, at: now });
    return true;
  }

  invalidate(): void {
    this.#latestSequence = ++this.#sequence;
    this.#active = undefined;
    this.#pending = undefined;
  }
}

/** Coordinates the existing durable share inbox with URL navigation without coupling their payloads. */
export class MobileExternalIntentFence {
  #latestNavigation: "native" | "share" | undefined;

  offerShare(): void { this.#latestNavigation = "share"; }

  offerNative(intent: MobileNativeIntent): void {
    if (intent.kind !== "focus") this.#latestNavigation = "native";
  }

  shareMayNavigate(): boolean { return this.#latestNavigation !== "native"; }
}

export function projectMobileNativeIntentSnapshot(state: MobileState): MobileNativeIntentSnapshot {
  const events = state.window ?? [...state.older, ...(state.detail?.timeline ?? []), ...state.live];
  const messages = timelineRows(events).flatMap((row) => row.kind === "user" || row.kind === "assistant"
    ? [{ messageId: row.id, eventId: row.eventId }]
    : []);
  const first = events[0];
  const last = events.at(-1);
  return Object.freeze({
    status: state.status,
    ...(state.activeProfileId === undefined ? {} : { activeProfileId: state.activeProfileId }),
    savedProfileIds: Object.freeze(state.saved.map((profile) => profile.profileId)),
    sessionIds: Object.freeze((state.owner?.sessions ?? []).map((session) => session.sessionId)),
    ...(state.selectedId === undefined ? {} : { selectedSessionId: state.selectedId }),
    messages: Object.freeze(messages),
    historyEnd: state.historyEnd,
    historyKey: [
      state.window === undefined ? "latest" : "window",
      state.before?.opaqueToken ?? "",
      state.before?.sequence?.toString() ?? "",
      state.historyEnd ? "end" : "more",
      events.length.toString(),
      first?.eventId ?? "",
      last?.eventId ?? ""
    ].join("\u001f")
  });
}

export async function executeMobileNativeIntent(
  claim: MobileNativeIntentClaim,
  delivery: Pick<MobileNativeIntentDelivery, "isCurrent">,
  runtime: MobileNativeIntentRuntime
): Promise<MobileNativeIntentExecution> {
  const current = (): boolean => delivery.isCurrent(claim);
  const intent = claim.intent;
  if (!current()) return "retired";
  if (intent.kind === "focus") {
    runtime.focusApplication();
    return "focused";
  }
  runtime.clearRecovery();
  runtime.clearMessageFocus();
  if (intent.kind === "settings") {
    runtime.showPage("settings");
    return "settings";
  }

  let snapshot = runtime.snapshot();
  const profileId = resolveProfileId(snapshot, intent.profileId);
  if (profileId === undefined) {
    return recoverConnection(runtime, intent.profileId === undefined ? "connection-required" : "profile-unavailable");
  }
  if (snapshot.activeProfileId !== profileId || (snapshot.status !== "connected" && snapshot.status !== "offline")) {
    runtime.showSavedConnections();
    try { await runtime.connectProfile(profileId); }
    catch {
      if (!current()) return "retired";
      return recoverConnection(runtime, "profile-connect-failed");
    }
  }
  if (!current()) return "retired";
  snapshot = runtime.snapshot();
  if (snapshot.activeProfileId !== profileId || (snapshot.status !== "connected" && snapshot.status !== "offline")) {
    return recoverConnection(runtime, "profile-connect-failed");
  }
  if (snapshot.sessionIds.filter((sessionId) => sessionId === intent.sessionId).length !== 1) {
    return recoverSession(runtime, "session-unavailable");
  }
  try { await runtime.selectSession(intent.sessionId); }
  catch {
    if (!current()) return "retired";
    return recoverSession(runtime, "session-unavailable");
  }
  if (!current()) return "retired";
  snapshot = runtime.snapshot();
  if (snapshot.activeProfileId !== profileId || snapshot.selectedSessionId !== intent.sessionId
    || snapshot.sessionIds.filter((sessionId) => sessionId === intent.sessionId).length !== 1) {
    return recoverSession(runtime, "session-unavailable");
  }
  runtime.showPage("task");
  if (intent.messageId === undefined) return "session";

  let message = exactMessage(snapshot, intent.messageId, intent.messageEventId);
  if (message === undefined && intent.messageEventId !== undefined) {
    if (snapshot.status !== "connected") return recoverMessage(runtime);
    try { await runtime.loadAround(intent.messageEventId); }
    catch {
      if (!current()) return "retired";
      runtime.returnLatest();
      return recoverMessage(runtime);
    }
    if (!current()) return "retired";
    snapshot = runtime.snapshot();
    // loadAround already proves the requested anchor event belongs to this Session. The
    // rendered message row may use its started or completed event as its own identity.
    message = exactMessage(snapshot, intent.messageId, undefined);
  } else if (message === undefined && snapshot.status === "connected") {
    for (let page = 0; page < mobileNativeIntentHistoryPageMaximum && !snapshot.historyEnd; page += 1) {
      const previousHistoryKey = snapshot.historyKey;
      try { await runtime.loadOlder(); }
      catch {
        if (!current()) return "retired";
        runtime.returnLatest();
        return recoverMessage(runtime);
      }
      if (!current()) return "retired";
      snapshot = runtime.snapshot();
      message = exactMessage(snapshot, intent.messageId, undefined);
      if (message !== undefined || snapshot.historyEnd || snapshot.historyKey === previousHistoryKey) break;
    }
  }
  if (!current()) return "retired";
  if (message === undefined) {
    runtime.returnLatest();
    return recoverMessage(runtime);
  }
  runtime.focusMessage(Object.freeze({
    requestId: claim.sequence,
    sessionId: intent.sessionId,
    messageId: message.messageId,
    ...(intent.messageEventId === undefined ? {} : { messageEventId: message.eventId })
  }));
  return "message";
}

export function mobileNativeIntentMessageMatches(
  focus: MobileNativeIntentMessageFocus,
  row: { readonly id: string; readonly eventId: string }
): boolean {
  return row.id === focus.messageId
    && (focus.messageEventId === undefined || row.eventId === focus.messageEventId);
}

function parseSessionIntent(url: URL): Extract<MobileNativeIntent, { readonly kind: "session" }> | undefined {
  if (!exactQuery(url, ["event", "message", "profile"])) return undefined;
  const sessionId = oneEncodedPathComponent(url.pathname);
  if (!boundedIdentity(sessionId)) return undefined;
  const profileId = optionalIdentityQuery(url, "profile");
  const messageId = optionalIdentityQuery(url, "message");
  const messageEventId = optionalIdentityQuery(url, "event");
  if (profileId === false || messageId === false || messageEventId === false
    || (messageEventId !== undefined && messageId === undefined)) return undefined;
  return Object.freeze({
    kind: "session",
    sessionId,
    ...(profileId === undefined ? {} : { profileId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(messageEventId === undefined ? {} : { messageEventId })
  });
}

function buildMobileSessionDeepLink(input: {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly messageEventId?: string;
}): string {
  if (!boundedIdentity(input.sessionId)
    || (input.messageId !== undefined && !boundedIdentity(input.messageId))
    || (input.messageEventId !== undefined && !boundedIdentity(input.messageEventId))
    || (input.messageEventId !== undefined && input.messageId === undefined)) {
    throw new Error("A public Joko task link requires bounded task and message identities.");
  }
  const query = input.messageId === undefined
    ? ""
    : `?message=${encodeURIComponent(input.messageId)}${input.messageEventId === undefined
      ? "" : `&event=${encodeURIComponent(input.messageEventId)}`}`;
  const value = `joko://task/${encodeURIComponent(input.sessionId)}${query}`;
  const parsed = parseMobileNativeIntent(value);
  if (parsed?.kind !== "session"
    || parsed.sessionId !== input.sessionId
    || parsed.profileId !== undefined
    || parsed.messageId !== input.messageId
    || parsed.messageEventId !== input.messageEventId) {
    throw new Error("The public Joko task link exceeds its canonical handoff boundary.");
  }
  return value;
}

function parseFocusIntent(url: URL): Extract<MobileNativeIntent, { readonly kind: "focus" }> | undefined {
  if (!exactQuery(url, [])) return undefined;
  if (url.pathname === "" || url.pathname === "/") return Object.freeze({ kind: "focus" });
  const source = oneEncodedPathComponent(url.pathname);
  return boundedText(source, mobileNativeIntentFocusSourceMaximumCharacters)
    ? Object.freeze({ kind: "focus", source })
    : undefined;
}

function exactQuery(url: URL, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function optionalIdentityQuery(url: URL, key: string): string | undefined | false {
  if (!url.searchParams.has(key)) return undefined;
  const value = url.searchParams.get(key);
  return boundedIdentity(value) ? value : false;
}

function oneEncodedPathComponent(pathname: string): string | undefined {
  if (!/^\/[^/]+$/u.test(pathname)) return undefined;
  try { return decodeURIComponent(pathname.slice(1)); }
  catch { return undefined; }
}

function boundedIdentity(value: unknown): value is string {
  return boundedText(value, mobileNativeIntentIdentityMaximumCharacters);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mobileNativeIntentFingerprint(intent: MobileNativeIntent): string {
  if (intent.kind === "settings") return "settings";
  if (intent.kind === "focus") return `focus\u001f${intent.source ?? ""}`;
  return ["session", intent.sessionId, intent.profileId ?? "", intent.messageId ?? "", intent.messageEventId ?? ""]
    .join("\u001f");
}

function resolveProfileId(snapshot: MobileNativeIntentSnapshot, explicitProfileId: string | undefined): string | undefined {
  const candidate = explicitProfileId ?? snapshot.activeProfileId;
  if (candidate === undefined) return undefined;
  return snapshot.savedProfileIds.filter((profileId) => profileId === candidate).length === 1
    ? candidate
    : undefined;
}

function exactMessage(
  snapshot: MobileNativeIntentSnapshot,
  messageId: string,
  messageEventId: string | undefined
): { readonly messageId: string; readonly eventId: string } | undefined {
  const matches = snapshot.messages.filter((message) => message.messageId === messageId
    && (messageEventId === undefined || message.eventId === messageEventId));
  return matches.length === 1 ? matches[0] : undefined;
}

function recoverConnection(
  runtime: MobileNativeIntentRuntime,
  recovery: Extract<MobileNativeIntentRecovery, "connection-required" | "profile-unavailable" | "profile-connect-failed">
): MobileNativeIntentRecovery {
  runtime.clearMessageFocus();
  runtime.showSavedConnections();
  runtime.showPage("connection");
  runtime.showRecovery(recovery);
  return recovery;
}

function recoverSession(
  runtime: MobileNativeIntentRuntime,
  recovery: Extract<MobileNativeIntentRecovery, "session-unavailable">
): MobileNativeIntentRecovery {
  runtime.clearMessageFocus();
  runtime.showPage("home");
  runtime.showRecovery(recovery);
  return recovery;
}

function recoverMessage(runtime: MobileNativeIntentRuntime): MobileNativeIntentRecovery {
  runtime.clearMessageFocus();
  runtime.showPage("task");
  runtime.showRecovery("message-unavailable");
  return "message-unavailable";
}
