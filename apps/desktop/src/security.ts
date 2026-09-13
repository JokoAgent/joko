import { isAbsolute, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESKTOP_APP_SCHEME = "joko";
export const DESKTOP_APP_HOST = "app";
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}`;
export const DESKTOP_APP_ENTRY_URL = `${DESKTOP_APP_ORIGIN}/index.html`;

export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  // diagrams.net's fixed, self-hosted GraphViewer artifact evaluates its
  // internal graph codec. Inline and remote scripts remain forbidden.
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  // CSP cannot express RFC1918/ULA ranges. The main-process webRequest policy
  // below narrows `http:`/`ws:` back to trusted local-network hosts.
  // PDF.js reads authenticated, in-memory artifact URLs from this origin.
  "connect-src 'self' blob: https: http: wss: ws:"
].join("; ");

export interface DesktopNavigationPolicy {
  readonly packagedEntryPath: string;
  readonly packagedBundleRoot: string;
  readonly developmentUrl?: string;
  readonly developmentOrigin?: string;
}

export interface IpcSenderIdentity<TWindow, TContents, TFrame> {
  readonly owner: TWindow | null | undefined;
  readonly expectedWindow: TWindow | undefined;
  readonly sender: TContents;
  readonly ownerContents: TContents | undefined;
  readonly senderFrame: TFrame | undefined;
  readonly mainFrame: TFrame;
  readonly frameUrl: string | undefined;
}

export function createNavigationPolicy(packagedEntryPath: string, developmentUrl?: string): DesktopNavigationPolicy {
  const entry = resolve(packagedEntryPath);
  if (!isAbsolute(packagedEntryPath) || entry !== packagedEntryPath) {
    throw new Error("The packaged Desktop entry must be a normalized absolute path.");
  }
  if (developmentUrl === undefined) {
    return { packagedEntryPath: entry, packagedBundleRoot: dirname(entry) };
  }
  const parsed = new URL(developmentUrl);
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("JOKO_WEB_DEV_URL must be a credential-free loopback HTTP URL.");
  }
  return {
    packagedEntryPath: entry,
    packagedBundleRoot: dirname(entry),
    developmentUrl: parsed.href,
    developmentOrigin: parsed.origin
  };
}

/** Main-frame navigation is exact in packaged mode and same-origin in dev mode. */
export function isAllowedMainFrameNavigation(value: string, policy: DesktopNavigationPolicy): boolean {
  try {
    const url = new URL(value);
    if (policy.developmentOrigin !== undefined) {
      return url.origin === policy.developmentOrigin && url.username === "" && url.password === "";
    }
    return url.protocol === `${DESKTOP_APP_SCHEME}:` &&
      url.hostname === DESKTOP_APP_HOST && url.port === "" &&
      url.username === "" && url.password === "" &&
      url.pathname === "/index.html" && isAllowedDesktopAppEntrySearch(url.search);
  } catch {
    return false;
  }
}

/** File subresources may only resolve within the immutable packaged Web bundle. */
export function isAllowedPackagedBundleResource(value: string, policy: DesktopNavigationPolicy): boolean {
  if (policy.developmentOrigin !== undefined) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return pathContains(policy.packagedBundleRoot, resolve(fileURLToPath(url)));
    return resolvePackagedAppResource(value, policy) !== undefined;
  } catch {
    return false;
  }
}

/** Maps the privileged app scheme to one immutable file inside the staged UI. */
export function resolvePackagedAppResource(value: string, policy: DesktopNavigationPolicy): string | undefined {
  if (policy.developmentOrigin !== undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${DESKTOP_APP_SCHEME}:` || url.hostname !== DESKTOP_APP_HOST || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.hash !== "" ||
      (url.search !== "" && (url.pathname !== "/index.html" || !isAllowedDesktopAppEntrySearch(url.search)))
    ) return undefined;
    const decodedPath = decodeURIComponent(url.pathname);
    if (!decodedPath.startsWith("/") || decodedPath.includes("\0") || decodedPath.includes("\\")) return undefined;
    const segments = decodedPath.split("/").slice(1);
    if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return undefined;
    }
    const candidate = resolve(policy.packagedBundleRoot, ...segments);
    return pathContains(policy.packagedBundleRoot, candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function isAllowedDesktopAppEntrySearch(search: string): boolean {
  if (search === "") return true;
  const query = new URLSearchParams(search);
  if ([...query.keys()].join(",") === "runtimeProcessMonitor") {
    return query.get("runtimeProcessMonitor") === "1";
  }
  if ([...query.keys()].sort().join(",") !== "bootSession,sessionWindow") return false;
  const sessionId = query.get("bootSession");
  return query.get("sessionWindow") === "1" && typeof sessionId === "string" &&
    sessionId.length >= 1 && sessionId.length <= 256 && sessionId.trim() === sessionId &&
    !/[\u0000-\u001f\u007f]/u.test(sessionId);
}

/**
 * Build the standalone resource-monitor entry without a fragment on the
 * initial network request. Electron exposes that fragment to webRequest even
 * though it is renderer-owned state, so including it would make the strict
 * packaged-resource fence cancel the application entry itself.
 */
export function runtimeProcessMonitorEntryUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.searchParams.set("runtimeProcessMonitor", "1");
  return url.href;
}

export function isTrustedIpcSenderIdentity<TWindow, TContents, TFrame>(
  identity: IpcSenderIdentity<TWindow, TContents, TFrame>,
  policy: DesktopNavigationPolicy
): boolean {
  return identity.owner !== null &&
    identity.owner !== undefined &&
    identity.owner === identity.expectedWindow &&
    identity.ownerContents !== undefined &&
    identity.sender === identity.ownerContents &&
    identity.senderFrame !== undefined &&
    identity.senderFrame === identity.mainFrame &&
    identity.frameUrl !== undefined &&
    isAllowedMainFrameNavigation(identity.frameUrl, policy);
}

export function isSafeExternalUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth for renderer requests. HTTPS/WSS remain available for
 * remote Orchestrator nodes and provider flows; plaintext HTTP/WS is confined to
 * loopback, RFC1918, IPv6 ULA, and explicitly local DNS names.
 */
export function isAllowedRendererNetworkUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.hostname === "" || url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:" || url.protocol === "wss:") return true;
    return (url.protocol === "http:" || url.protocol === "ws:") && isTrustedLocalNetworkHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isTrustedLocalNetworkHostname(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (hostname === "" || hostname === "0.0.0.0" || hostname === "::") return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) return isTrustedIpv4(ipv4);
  const ipv6 = parseIpv6(hostname);
  if (ipv6 !== undefined) return isTrustedIpv6(ipv6);
  if (hostname.endsWith(".local") || hostname.endsWith(".home.arpa")) return true;
  return !hostname.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname);
}

export function canonicalExternalUrl(value: string): string {
  if (!isSafeExternalUrl(value)) throw new Error("Only credential-free HTTP(S) external links are allowed.");
  return new URL(value).href;
}

export function mergeContentSecurityPolicyHeaders(
  headers: Readonly<Record<string, readonly string[]>> | undefined
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  const existingPolicies: string[] = [];
  for (const [name, values] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "content-security-policy") existingPolicies.push(...values);
    else merged[name] = [...values];
  }
  merged["Content-Security-Policy"] = [...existingPolicies, DESKTOP_CONTENT_SECURITY_POLICY];
  return merged;
}

export function isSecureStorageBackend(
  platform: NodeJS.Platform,
  encryptionAvailable: boolean,
  selectedBackend?: string
): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== "linux") return true;
  return selectedBackend !== undefined && ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(selectedBackend);
}

export function validateProfileId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("Invalid profile identifier.");
  }
}

export function validateCredentialSecret(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 16 || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error("Credential is invalid.");
  }
}

export function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain"
  } as Readonly<Record<string, string>>)[extension] ?? "application/octet-stream";
}

export function isRelativeBundleAssetReference(value: string, entryPath: string): boolean {
  if (!value.startsWith("./") || value.includes("\0")) return false;
  try {
    const entryUrl = pathToFileURL(entryPath);
    const resolvedUrl = new URL(value, entryUrl);
    return resolvedUrl.protocol === "file:" && pathContains(dirname(entryPath), resolve(fileURLToPath(resolvedUrl)));
  } catch {
    return false;
  }
}

export function extractHtmlAssetReferences(html: string): readonly string[] {
  const references: string[] = [];
  const matcher = /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of html.matchAll(matcher)) {
    const value = match[1];
    if (value !== undefined && !value.startsWith("#") && !value.startsWith("data:")) references.push(value);
  }
  return references;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function canonicalHostname(value: string): string {
  const lowered = value.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function parseIpv4(value: string): readonly [number, number, number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index])) {
    return undefined;
  }
  return numbers as unknown as readonly [number, number, number, number];
}

function isTrustedIpv4(value: readonly [number, number, number, number]): boolean {
  const [first, second] = value;
  return first === 10 || first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function parseIpv6(value: string): readonly number[] | undefined {
  if (!value.includes(":")) return undefined;
  const double = value.indexOf("::");
  if (double !== -1 && double !== value.lastIndexOf("::")) return undefined;
  const left = (double === -1 ? value : value.slice(0, double)).split(":").filter(Boolean);
  const right = (double === -1 ? "" : value.slice(double + 2)).split(":").filter(Boolean);
  const parseWords = (parts: readonly string[]): number[] | undefined => {
    const words: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };
  const leftWords = parseWords(left);
  const rightWords = parseWords(right);
  if (leftWords === undefined || rightWords === undefined) return undefined;
  if (double === -1) return leftWords.length === 8 ? leftWords : undefined;
  const missing = 8 - leftWords.length - rightWords.length;
  if (missing < 1) return undefined;
  return [...leftWords, ...Array.from({ length: missing }, () => 0), ...rightWords];
}

function isTrustedIpv6(words: readonly number[]): boolean {
  if (words.length !== 8) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0]! & 0xfe00) === 0xfc00) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isTrustedIpv4([words[6]! >>> 8, words[6]! & 0xff, words[7]! >>> 8, words[7]! & 0xff]);
  }
  return false;
}

function pathContains(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}
