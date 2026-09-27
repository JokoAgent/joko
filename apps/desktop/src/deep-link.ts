import { posix, win32 } from "node:path";

import {
  isDesktopDeepLinkSettingsSection,
  type DesktopDeepLinkAcknowledgement,
  type DesktopDeepLinkDelivery,
  type DesktopDeepLinkNavigation,
  type DesktopDeepLinkSettingsSection
} from "./channels.js";

export const DESKTOP_DEEP_LINK_SCHEME = "joko";
const MAXIMUM_DEEP_LINK_CHARACTERS = 4_096;
const MAXIMUM_IDENTITY_CHARACTERS = 256;
const MAXIMUM_FOCUS_SOURCE_CHARACTERS = 128;
const MAXIMUM_PORTABLE_PATH_CHARACTERS = 32_768;

export type ParsedDesktopDeepLink =
  | Exclude<DesktopDeepLinkNavigation, { readonly kind: "portable"; readonly file?: unknown }>
  | { readonly kind: "portable" }
  | { readonly kind: "focus"; readonly source?: string };

export type DesktopInboundOpenIntent =
  | ParsedDesktopDeepLink
  | { readonly kind: "portableFile"; readonly path: string };

type DesktopNavigatingOpenIntent = Exclude<DesktopInboundOpenIntent, { readonly kind: "focus" }>;

export interface DesktopInboundNavigationClaim {
  readonly intent: DesktopNavigatingOpenIntent;
  readonly token: object;
}

export interface DesktopSessionDeepLinkInput {
  readonly sessionId: string;
  readonly profileId?: string;
  readonly messageId?: string;
  readonly messageEventId?: string;
}

export interface DesktopDeepLinkOffer {
  readonly deliveryOccurrence: number;
  readonly delivery?: DesktopDeepLinkDelivery;
}

/** A renderer Document changes only for a non-in-place main-frame navigation. */
export function isDesktopMainDocumentReplacementNavigation(
  isMainFrame: boolean,
  isInPlace: boolean
): boolean {
  return isMainFrame && !isInPlace;
}

/** Parse only the public OS handoff surface. The privileged `joko://app` origin is intentionally rejected. */
export function parseDesktopDeepLink(value: unknown): ParsedDesktopDeepLink | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > MAXIMUM_DEEP_LINK_CHARACTERS
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${DESKTOP_DEEP_LINK_SCHEME}:` || url.username !== "" || url.password !== "" ||
    url.port !== "" || url.hash !== "") return undefined;

  if (url.hostname === "task" || url.hostname === "session") return parseSessionUrl(url);
  if (url.hostname === "settings") return parseSettingsUrl(url);
  if (url.hostname === "focus") return parseFocusUrl(url);
  if (url.hostname === "portable" && url.pathname === "/import" && exactQuery(url, [])) {
    return Object.freeze({ kind: "portable" });
  }
  return undefined;
}

export function buildDesktopSessionDeepLink(input: DesktopSessionDeepLinkInput): string {
  requireIdentity(input.sessionId, "Task identity");
  if (input.profileId !== undefined) requireIdentity(input.profileId, "Machine identity");
  if (input.messageId !== undefined) requireIdentity(input.messageId, "Message identity");
  if (input.messageEventId !== undefined) {
    requireIdentity(input.messageEventId, "Message event identity");
    if (input.messageId === undefined) throw new TypeError("A message event requires a message identity.");
  }
  const query = new URLSearchParams();
  if (input.messageEventId !== undefined) query.set("event", input.messageEventId);
  if (input.messageId !== undefined) query.set("message", input.messageId);
  if (input.profileId !== undefined) query.set("profile", input.profileId);
  return requireBoundedPublicDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://task/${encodeURIComponent(input.sessionId)}` +
    (query.size === 0 ? "" : `?${query.toString()}`));
}

export function buildDesktopSettingsDeepLink(section: DesktopDeepLinkSettingsSection): string {
  if (!isDesktopDeepLinkSettingsSection(section)) throw new TypeError("Settings section is not public.");
  return requireBoundedPublicDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://settings/${section}`);
}

export function buildDesktopFocusDeepLink(source?: string): string {
  if (source === undefined) return requireBoundedPublicDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://focus`);
  if (!boundedText(source, MAXIMUM_FOCUS_SOURCE_CHARACTERS)) throw new TypeError("Focus source is invalid.");
  return requireBoundedPublicDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://focus/${encodeURIComponent(source)}`);
}

export function buildDesktopPortableDeepLink(): string {
  return requireBoundedPublicDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://portable/import`);
}

export function parseDesktopDeepLinkAcknowledgement(value: unknown): DesktopDeepLinkAcknowledgement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Desktop deep-link acknowledgement must be an exact object.");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "deliveryOccurrence,documentOccurrence"
    || !boundedIdentity(candidate["documentOccurrence"])
    || typeof candidate["deliveryOccurrence"] !== "number"
    || !Number.isSafeInteger(candidate["deliveryOccurrence"])
    || candidate["deliveryOccurrence"] < 1) {
    throw new TypeError("Desktop deep-link acknowledgement is invalid.");
  }
  return Object.freeze({
    documentOccurrence: candidate["documentOccurrence"],
    deliveryOccurrence: candidate["deliveryOccurrence"]
  });
}

export function desktopDeepLinkDeliveryMatchesAcknowledgement(
  delivery: Pick<DesktopDeepLinkDelivery, "deliveryOccurrence"> & { readonly documentOccurrence?: string },
  acknowledgement: DesktopDeepLinkAcknowledgement
): boolean {
  return delivery.documentOccurrence !== undefined
    && delivery.documentOccurrence === acknowledgement.documentOccurrence
    && delivery.deliveryOccurrence === acknowledgement.deliveryOccurrence;
}

/** Find the last OS handoff argument without resolving arbitrary paths or accepting folder switches. */
export function desktopInboundOpenIntentFromArgv(
  argv: readonly string[],
  platform: NodeJS.Platform
): DesktopInboundOpenIntent | undefined {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    const parsed = parseDesktopDeepLink(argument);
    if (parsed !== undefined) return parsed;
    if (isPortableSessionPath(argument, platform)) return Object.freeze({ kind: "portableFile", path: argument });
  }
  return undefined;
}

export function isPortableSessionPath(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAXIMUM_PORTABLE_PATH_CHARACTERS ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const pathApi = platform === "win32" ? win32 : posix;
  return pathApi.isAbsolute(value) && pathApi.extname(value).toLowerCase() === ".jshare";
}

/**
 * Main and renderer use a pull-on-mount handshake. The latest valid OS intent
 * remains retained until the exact document and delivery occurrences
 * acknowledge it. A replacement preload capture closes the old gate without
 * discarding that intent, so a committed replacement document can reclaim it
 * safely while a cancelled navigation leaves the existing gate usable.
 */
export class DesktopDeepLinkDeliveryBuffer {
  private pending: {
    readonly deliveryOccurrence: number;
    readonly navigation: DesktopDeepLinkNavigation;
  } | undefined;
  private readyDocumentOccurrence: string | undefined;
  private nextDeliveryOccurrence = 0;

  offer(value: DesktopDeepLinkNavigation): DesktopDeepLinkDelivery | undefined {
    return this.offerWithOccurrence(value).delivery;
  }

  offerWithOccurrence(value: DesktopDeepLinkNavigation): DesktopDeepLinkOffer {
    this.nextDeliveryOccurrence += 1;
    if (!Number.isSafeInteger(this.nextDeliveryOccurrence)) {
      throw new RangeError("Desktop deep-link delivery occurrence capacity was reached.");
    }
    this.pending = Object.freeze({
      deliveryOccurrence: this.nextDeliveryOccurrence,
      navigation: value
    });
    const delivery = this.currentClaim();
    return Object.freeze({
      deliveryOccurrence: this.nextDeliveryOccurrence,
      ...(delivery === undefined ? {} : { delivery })
    });
  }

  /**
   * Retire an older delivery as soon as a newer navigation intent wins native
   * ingress. Keep the current renderer ready occurrence so the replacement can
   * be delivered live after any bounded native materialization finishes.
   */
  retirePendingForNewNavigation(): void {
    this.pending = undefined;
  }

  takeAfterRendererReady(documentOccurrence: string): DesktopDeepLinkDelivery | undefined {
    if (!boundedIdentity(documentOccurrence)) {
      throw new TypeError("Desktop deep-link document occurrence is invalid.");
    }
    if (this.readyDocumentOccurrence !== undefined && this.readyDocumentOccurrence !== documentOccurrence) {
      return undefined;
    }
    this.readyDocumentOccurrence = documentOccurrence;
    return this.currentClaim();
  }

  acknowledge(acknowledgement: DesktopDeepLinkAcknowledgement): boolean {
    const pending = this.pending;
    if (pending === undefined || acknowledgement.documentOccurrence !== this.readyDocumentOccurrence ||
      acknowledgement.deliveryOccurrence !== pending.deliveryOccurrence) return false;
    this.pending = undefined;
    return true;
  }

  resetRenderer(): void {
    this.readyDocumentOccurrence = undefined;
  }

  private currentClaim(): DesktopDeepLinkDelivery | undefined {
    const pending = this.pending;
    const documentOccurrence = this.readyDocumentOccurrence;
    return pending === undefined || documentOccurrence === undefined
      ? undefined
      : Object.freeze({
          documentOccurrence,
          deliveryOccurrence: pending.deliveryOccurrence,
          navigation: pending.navigation
        });
  }
}

/**
 * A focus-only OS handoff reveals the application but must not cancel a task,
 * settings, or portable-package navigation that is still being materialized.
 * A newer navigation intent does supersede the older one so a slow native file
 * read can never navigate after a later explicit handoff.
 */
export class DesktopInboundOpenIntentFence {
  private currentToken: object | undefined;

  begin(intent: DesktopInboundOpenIntent): DesktopInboundNavigationClaim | undefined {
    if (intent.kind === "focus") return undefined;
    const token = Object.freeze({});
    this.currentToken = token;
    return Object.freeze({ intent, token });
  }

  isCurrent(claim: DesktopInboundNavigationClaim): boolean {
    return claim.token === this.currentToken;
  }
}

function parseSessionUrl(url: URL): Extract<ParsedDesktopDeepLink, { readonly kind: "session" }> | undefined {
  if (!exactQuery(url, ["event", "message", "profile"])) return undefined;
  const sessionId = oneEncodedPathComponent(url.pathname);
  if (!boundedIdentity(sessionId)) return undefined;
  const profileId = optionalIdentityQuery(url, "profile");
  const messageId = optionalIdentityQuery(url, "message");
  const messageEventId = optionalIdentityQuery(url, "event");
  if (profileId === false || messageId === false || messageEventId === false ||
    (messageEventId !== undefined && messageId === undefined)) return undefined;
  return Object.freeze({
    kind: "session",
    sessionId,
    ...(profileId === undefined ? {} : { profileId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(messageEventId === undefined ? {} : { messageEventId })
  });
}

function parseSettingsUrl(url: URL): Extract<ParsedDesktopDeepLink, { readonly kind: "settings" }> | undefined {
  if (!exactQuery(url, [])) return undefined;
  const rawSection = url.pathname === "" || url.pathname === "/" ? "general" : oneEncodedPathComponent(url.pathname);
  if (!isDesktopDeepLinkSettingsSection(rawSection)) return undefined;
  return Object.freeze({ kind: "settings", section: rawSection });
}

function parseFocusUrl(url: URL): Extract<ParsedDesktopDeepLink, { readonly kind: "focus" }> | undefined {
  if (!exactQuery(url, [])) return undefined;
  if (url.pathname === "" || url.pathname === "/") return Object.freeze({ kind: "focus" });
  const source = oneEncodedPathComponent(url.pathname);
  return boundedText(source, MAXIMUM_FOCUS_SOURCE_CHARACTERS)
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
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    return undefined;
  }
}

function boundedIdentity(value: unknown): value is string {
  return boundedText(value, MAXIMUM_IDENTITY_CHARACTERS);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function requireIdentity(value: unknown, label: string): asserts value is string {
  if (!boundedIdentity(value)) throw new TypeError(`${label} is invalid.`);
}

function requireBoundedPublicDeepLink(value: string): string {
  if (value.length > MAXIMUM_DEEP_LINK_CHARACTERS) {
    throw new RangeError("Desktop deep link exceeds the public handoff limit.");
  }
  return value;
}
