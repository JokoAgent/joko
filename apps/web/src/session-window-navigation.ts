import { sessionRouteHash } from "./controller.js";

const MAXIMUM_SESSION_ID_CHARACTERS = 256;

export function validSessionWindowId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAXIMUM_SESSION_ID_CHARACTERS
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Preserve only the current trusted app entry and a bounded task hash. */
export function sessionTaskLink(locationValue: Pick<Location, "href">, sessionId: string, profileId?: string): string {
  if (!validSessionWindowId(sessionId)) throw new TypeError("Task identity is invalid.");
  if (profileId !== undefined && !validSessionWindowId(profileId)) throw new TypeError("Machine identity is invalid.");
  const url = new URL(locationValue.href);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = sessionRouteHash({ kind: "session", sessionId, ...(profileId === undefined ? {} : { profileId }) });
  return url.href;
}

/** Build the public Desktop handoff form without exposing the privileged app-resource origin. */
export function desktopSessionTaskLink(sessionId: string, profileId?: string): string {
  if (!validSessionWindowId(sessionId)) throw new TypeError("Task identity is invalid.");
  if (profileId !== undefined && !validSessionWindowId(profileId)) throw new TypeError("Machine identity is invalid.");
  const query = new URLSearchParams();
  if (profileId !== undefined) query.set("profile", profileId);
  return `joko://task/${encodeURIComponent(sessionId)}${query.size === 0 ? "" : `?${query.toString()}`}`;
}

export function isSessionApplicationWindow(locationValue: Pick<Location, "search">): boolean {
  const query = new URLSearchParams(locationValue.search);
  return [...query.keys()].sort().join(",") === "bootSession,sessionWindow" &&
    query.get("sessionWindow") === "1" && validSessionWindowId(query.get("bootSession"));
}

export function openSessionWindowFallback(locationValue: Pick<Location, "href">, sessionId: string, profileId?: string): Window | null {
  return window.open(sessionTaskLink(locationValue, sessionId, profileId), "_blank", "noopener,noreferrer");
}
