export interface DesktopMicrophonePermissionRequest {
  readonly permission: string;
  readonly trustedOwner: boolean;
  readonly mainFrame: boolean;
  readonly trustedFrameUrl: string;
  readonly requestingUrl: string;
  readonly mediaTypes: readonly string[];
}

export interface DesktopClipboardWritePermissionRequest {
  readonly permission: string;
  readonly trustedOwner: boolean;
  readonly mainFrame: boolean;
  readonly trustedFrameUrl: string;
  readonly requestingUrl: string;
}

/** Only the trusted application main frame may request audio-only capture. */
export function isAllowedDesktopMicrophoneRequest(request: DesktopMicrophonePermissionRequest): boolean {
  if (request.permission !== "media" || !request.trustedOwner || !request.mainFrame) return false;
  if (!sameCredentialFreeOrigin(request.trustedFrameUrl, request.requestingUrl)) return false;
  return request.mediaTypes.length === 1 && request.mediaTypes[0] === "audio";
}

/** The production app may write sanitized clipboard data, but never read it. */
export function isAllowedDesktopClipboardWriteRequest(request: DesktopClipboardWritePermissionRequest): boolean {
  return request.permission === "clipboard-sanitized-write"
    && request.trustedOwner
    && request.mainFrame
    && sameCredentialFreeOrigin(request.trustedFrameUrl, request.requestingUrl);
}

export function microphoneMediaTypesFromPermissionDetails(details: unknown): readonly string[] {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const value = details as Record<string, unknown>;
  if (Array.isArray(value["mediaTypes"])) {
    return value["mediaTypes"].filter((item): item is string => typeof item === "string");
  }
  return typeof value["mediaType"] === "string" ? [value["mediaType"]] : [];
}

export function microphoneMainFrameFromPermissionDetails(details: unknown): boolean {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    && (details as Record<string, unknown>)["isMainFrame"] === true;
}

export function mapDesktopMicrophonePermissionStatus(value: string): "granted" | "denied" | "prompt" | "unknown" {
  if (value === "granted") return "granted";
  if (value === "denied" || value === "restricted") return "denied";
  if (value === "not-determined") return "prompt";
  return "unknown";
}

function sameCredentialFreeOrigin(leftValue: string, rightValue: string): boolean {
  try {
    const left = new URL(leftValue);
    const right = new URL(rightValue);
    return left.protocol === right.protocol
      && left.hostname === right.hostname
      && left.port === right.port
      && left.username === ""
      && left.password === ""
      && right.username === ""
      && right.password === "";
  } catch {
    return false;
  }
}
