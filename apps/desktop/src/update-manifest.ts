import { parse } from "yaml";

import { compareDesktopUpdateVersions } from "./update-service.js";

export const DESKTOP_UPDATE_STARTUP_MANIFEST_TIMEOUT_MS = 8_000;
const MAXIMUM_UPDATE_MANIFEST_BYTES = 256 * 1024;

export interface DesktopUpdateManifestProbeOptions {
  readonly feedUrl: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

/** Bounded generic-provider manifest probe used only for cold-start
 * choice between a verified local installer and a newer online installer. */
export async function fetchDesktopUpdateManifestVersion(
  options: DesktopUpdateManifestProbeOptions
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DESKTOP_UPDATE_STARTUP_MANIFEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return null;
  let manifestUrl: string;
  try {
    manifestUrl = desktopUpdateManifestUrl(options.feedUrl, options.platform, options.architecture);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await options.fetch(manifestUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/octet-stream" }
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_UPDATE_MANIFEST_BYTES) return null;
    const raw = await readBoundedBody(response, MAXIMUM_UPDATE_MANIFEST_BYTES);
    const parsed: unknown = parse(raw, { maxAliasCount: 0, prettyErrors: false });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = (parsed as Record<string, unknown>)["version"];
    if (typeof candidate !== "string" || candidate.trim() !== candidate ||
      compareDesktopUpdateVersions(candidate, candidate) === undefined) return null;
    return candidate;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function desktopUpdateManifestUrl(
  feedUrl: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture
): string {
  const base = new URL(feedUrl);
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "" ||
    base.search !== "" || base.hash !== "") throw new Error("Desktop update feed is unsafe.");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  let fileName: string;
  if (platform === "win32") {
    fileName = "latest.yml";
  } else if (platform === "darwin") {
    fileName = "latest-mac.yml";
  } else if (platform === "linux") {
    fileName = `latest-linux${architecture === "x64" ? "" : `-${architecture}`}.yml`;
  } else {
    throw new Error("Desktop update platform is unsupported.");
  }
  return new URL(fileName, base).href;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) throw new Error("Desktop update manifest is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) throw new Error("Desktop update manifest exceeds its size limit.");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
}
