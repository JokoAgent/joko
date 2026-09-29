import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  AUDIO_ARTIFACT_MAXIMUM_TRACKS,
  AUDIO_ARTWORK_MAXIMUM_BYTES
} from "@joko/core";
import { fileTypeFromBuffer } from "file-type";

import type { McpCallResult } from "./mcp-router.js";

export const MCP_AUDIO_RESULT_MAPPING_META_KEY = "joko.audioResultMapping";

type AudioArtifactKind = "generic" | "music" | "sound_effect";
type ResultPath = readonly string[];

export interface McpAudioBinaryResultMapping {
  readonly path: ResultPath;
  readonly encoding: "url" | "base64";
  readonly mimeType: string;
  readonly allowedUrlHosts?: readonly string[];
}

export interface McpAudioArtworkResultMapping extends McpAudioBinaryResultMapping {
  readonly altPath?: ResultPath;
}

export interface McpAudioTrackResultMapping {
  readonly trackPath: ResultPath;
  readonly audio: McpAudioBinaryResultMapping;
  readonly kind: AudioArtifactKind;
  readonly titlePath?: ResultPath;
  readonly descriptionPath?: ResultPath;
  readonly durationSecondsPath?: ResultPath;
  readonly artwork?: McpAudioArtworkResultMapping;
}

export interface McpAudioResultMapping {
  readonly version: 1;
  readonly tracks: readonly McpAudioTrackResultMapping[];
}

export interface PreparedMcpAudioMedia {
  readonly type: "audio" | "image";
  readonly mimeType: string;
  /** Invoked only after the durable audio-publication claim is held. */
  readonly load: () => Promise<Uint8Array>;
}

export interface PreparedMcpAudioResult {
  readonly media: ReadonlyMap<number, PreparedMcpAudioMedia>;
  readonly privateIdentities: readonly string[];
}

export interface AdaptedMcpAudioResult {
  readonly result: McpCallResult;
  readonly prepared?: PreparedMcpAudioResult;
}

export interface McpAudioResultDownloadInput {
  readonly url: string;
  readonly allowedHosts: readonly string[];
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly guard: () => void;
}

export type McpAudioResultDownloader = (
  input: McpAudioResultDownloadInput
) => Promise<Uint8Array>;

export class McpAudioResultMappingError extends Error {
  readonly code = "invalid_result" as const;

  constructor() {
    super("MCP audio result mapping is invalid.");
    this.name = "McpAudioResultMappingError";
  }
}

export interface PinnedHttpsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bytes: Uint8Array;
}

export interface PinnedHttpsRequestInput {
  readonly url: URL;
  readonly address: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
}

export interface PinnedHttpsAudioResultDownloaderOptions {
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly request?: (input: PinnedHttpsRequestInput) => Promise<PinnedHttpsResponse>;
  readonly timeoutMs?: number;
}

/**
 * Credential-free HTTPS downloader for explicitly declared result fields.
 * Every redirect is re-authorized and DNS is pinned before the socket opens.
 */
export class PinnedHttpsAudioResultDownloader {
  readonly #resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  readonly #request: (input: PinnedHttpsRequestInput) => Promise<PinnedHttpsResponse>;
  readonly #timeoutMs: number;

  constructor(options: PinnedHttpsAudioResultDownloaderOptions = {}) {
    this.#resolveAddresses = options.resolveAddresses ?? (async (hostname) =>
      (await lookup(hostname, { all: true })).map((answer) => answer.address));
    this.#request = options.request ?? pinnedHttpsRequest;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) {
      throw new RangeError("MCP audio result download timeout is invalid.");
    }
  }

  readonly download: McpAudioResultDownloader = async (input) => {
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) throw invalid();
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    let url = mappedHttpsUrl(input.url, input.allowedHosts);
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      input.guard();
      signal.throwIfAborted();
      if (visited.has(url.href)) throw invalid();
      visited.add(url.href);
      let addresses: readonly string[];
      try {
        addresses = await awaitWithAbort(this.#resolveAddresses(url.hostname), signal);
      } catch {
        throw invalid();
      }
      input.guard();
      signal.throwIfAborted();
      if (addresses.length === 0 || addresses.some((address) => !isPublicAudioResultAddress(address))) {
        throw invalid();
      }
      let response: PinnedHttpsResponse;
      try {
        response = await this.#request({
          url,
          address: addresses[0]!,
          maximumBytes: input.maximumBytes,
          signal
        });
      } catch {
        input.guard();
        throw invalid();
      }
      input.guard();
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (redirects === 5 || location === undefined || Buffer.byteLength(location, "utf8") > 16_384) {
          throw invalid();
        }
        try {
          url = mappedHttpsUrl(new URL(location, url).href, input.allowedHosts);
        } catch {
          throw invalid();
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300
        || response.bytes.byteLength < 1 || response.bytes.byteLength > input.maximumBytes) throw invalid();
      return response.bytes;
    }
    throw invalid();
  };
}

export class McpAudioResultMapper {
  readonly #maximumBlobBytes: number;
  readonly #download: McpAudioResultDownloader;

  constructor(maximumBlobBytes: number, download = new PinnedHttpsAudioResultDownloader().download) {
    if (!Number.isSafeInteger(maximumBlobBytes) || maximumBlobBytes < 1) {
      throw new RangeError("MCP audio result capacity is invalid.");
    }
    this.#maximumBlobBytes = maximumBlobBytes;
    this.#download = download;
  }

  adapt(
    result: McpCallResult,
    mapping: McpAudioResultMapping,
    context: { readonly signal?: AbortSignal; readonly guard: () => void }
  ): AdaptedMcpAudioResult {
    if (result.isError || result.structuredContent === undefined
      || result.structuredContent["jokoAudioArtifacts"] !== undefined
      || result.content.some((part) => mediaPart(part, "audio"))) return { result };

    const content = [...result.content];
    const declarations: Record<string, unknown>[] = [];
    const prepared = new Map<number, PreparedMcpAudioMedia>();
    const privateIdentities = new Set<string>();
    for (const trackMapping of mapping.tracks) {
      const candidates = valuesAtPath(result.structuredContent, trackMapping.trackPath);
      if (candidates.length + declarations.length > AUDIO_ARTIFACT_MAXIMUM_TRACKS) throw invalid();
      for (const candidate of candidates) {
        context.guard();
        context.signal?.throwIfAborted();
        if (!record(candidate)) throw invalid();
        const audioRaw = requiredStringAtPath(candidate, trackMapping.audio.path);
        privateIdentities.add(audioRaw);
        const audioContentIndex = content.length;
        content.push({ type: "audio", data: "", mimeType: trackMapping.audio.mimeType });
        prepared.set(audioContentIndex, {
          type: "audio",
          mimeType: trackMapping.audio.mimeType,
          load: async () => (await this.#materialize(
            audioRaw,
            trackMapping.audio,
            "audio",
            this.#maximumBlobBytes,
            context
          )).bytes
        });

        const title = optionalStringAtPath(candidate, trackMapping.titlePath) ?? "";
        const description = optionalStringAtPath(candidate, trackMapping.descriptionPath) ?? "";
        const durationSeconds = optionalNumberAtPath(candidate, trackMapping.durationSecondsPath);
        let artwork: Record<string, unknown> | undefined;
        if (trackMapping.artwork !== undefined) {
          try {
            const artworkRaw = optionalStringAtPath(candidate, trackMapping.artwork.path);
            if (artworkRaw !== undefined) {
              privateIdentities.add(artworkRaw);
              const alt = optionalStringAtPath(candidate, trackMapping.artwork.altPath) ?? "";
              const imageContentIndex = content.length;
              content.push({ type: "image", data: "", mimeType: trackMapping.artwork.mimeType });
              prepared.set(imageContentIndex, {
                type: "image",
                mimeType: trackMapping.artwork.mimeType,
                load: async () => (await this.#materialize(
                  artworkRaw,
                  trackMapping.artwork!,
                  "image",
                  AUDIO_ARTWORK_MAXIMUM_BYTES,
                  context
                )).bytes
              });
              artwork = { imageContentIndex, alt };
            }
          } catch {
            // Supplier artwork is optional; owner loss and cancellation remain terminal.
            context.guard();
            context.signal?.throwIfAborted();
          }
        }
        declarations.push({
          audioContentIndex,
          kind: trackMapping.kind,
          title,
          description,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
          ...(artwork === undefined ? {} : { artwork })
        });
      }
    }
    if (declarations.length === 0) return { result };
    return {
      result: {
        content,
        structuredContent: {
          ...result.structuredContent,
          jokoAudioArtifacts: declarations
        },
        isError: false
      },
      prepared: {
        media: prepared,
        privateIdentities: [...privateIdentities].sort((left, right) => right.length - left.length)
      }
    };
  }

  async #materialize(
    raw: string,
    mapping: McpAudioBinaryResultMapping,
    type: "audio" | "image",
    maximumBytes: number,
    context: { readonly signal?: AbortSignal; readonly guard: () => void }
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    let bytes: Uint8Array;
    let dataMimeType: string | undefined;
    if (mapping.encoding === "url") {
      bytes = await this.#download({
        url: raw,
        allowedHosts: mapping.allowedUrlHosts!,
        maximumBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        guard: context.guard
      });
    } else {
      const decoded = decodeMappedBase64(raw, maximumBytes);
      bytes = decoded.bytes;
      dataMimeType = decoded.mimeType;
    }
    context.guard();
    context.signal?.throwIfAborted();
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) throw invalid();
    const detected = await fileTypeFromBuffer(bytes.subarray(0, 65_536)).catch(() => undefined);
    context.guard();
    if (detected === undefined
      || (type === "audio" && !detected.mime.startsWith("audio/"))
      || (type === "image" && !["image/png", "image/jpeg", "image/webp"].includes(detected.mime))
      || detected.mime !== mapping.mimeType
      || (dataMimeType !== undefined && detected.mime !== dataMimeType)) throw invalid();
    return { bytes, mimeType: detected.mime };
  }
}

export function audioResultMappingFromMeta(value: unknown): McpAudioResultMapping | undefined {
  if (!record(value) || value[MCP_AUDIO_RESULT_MAPPING_META_KEY] === undefined) return undefined;
  return parseMcpAudioResultMapping(value[MCP_AUDIO_RESULT_MAPPING_META_KEY]);
}

export function parseMcpAudioResultMapping(value: unknown): McpAudioResultMapping {
  if (!record(value) || !onlyKeys(value, ["version", "tracks"])
    || value["version"] !== 1 || !Array.isArray(value["tracks"])
    || value["tracks"].length < 1 || value["tracks"].length > AUDIO_ARTIFACT_MAXIMUM_TRACKS) throw invalid();
  return {
    version: 1,
    tracks: value["tracks"].map((item) => parseTrackMapping(item))
  };
}

export function mcpAudioResultMappingUsesNetwork(mapping: McpAudioResultMapping): boolean {
  return mapping.tracks.some((track) =>
    track.audio.encoding === "url" || track.artwork?.encoding === "url");
}

function parseTrackMapping(value: unknown): McpAudioTrackResultMapping {
  if (!record(value) || !onlyKeys(value, [
    "trackPath", "audio", "kind", "titlePath", "descriptionPath", "durationSecondsPath", "artwork"
  ]) || !["generic", "music", "sound_effect"].includes(String(value["kind"]))) throw invalid();
  return {
    trackPath: resultPath(value["trackPath"], true),
    audio: parseBinaryMapping(value["audio"], "audio"),
    kind: value["kind"] as AudioArtifactKind,
    ...(value["titlePath"] === undefined ? {} : { titlePath: resultPath(value["titlePath"], false) }),
    ...(value["descriptionPath"] === undefined ? {} : { descriptionPath: resultPath(value["descriptionPath"], false) }),
    ...(value["durationSecondsPath"] === undefined ? {} : { durationSecondsPath: resultPath(value["durationSecondsPath"], false) }),
    ...(value["artwork"] === undefined ? {} : { artwork: parseArtworkMapping(value["artwork"]) })
  };
}

function parseArtworkMapping(value: unknown): McpAudioArtworkResultMapping {
  if (!record(value) || !onlyKeys(value, ["path", "encoding", "mimeType", "allowedUrlHosts", "altPath"])) {
    throw invalid();
  }
  return {
    ...parseBinaryMapping(value, "image"),
    ...(value["altPath"] === undefined ? {} : { altPath: resultPath(value["altPath"], false) })
  };
}

function parseBinaryMapping(value: unknown, type: "audio" | "image"): McpAudioBinaryResultMapping {
  if (!record(value) || !onlyKeys(value, ["path", "encoding", "mimeType", "allowedUrlHosts", "altPath"])
    || (type === "audio" && value["altPath"] !== undefined)
    || (value["encoding"] !== "url" && value["encoding"] !== "base64")) throw invalid();
  const mimeType = value["mimeType"];
  if (typeof mimeType !== "string"
    || (type === "audio" && !/^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType))
    || (type === "image" && !["image/png", "image/jpeg", "image/webp"].includes(mimeType))) throw invalid();
  if (value["encoding"] === "url") {
    const allowedUrlHosts = allowedHosts(value["allowedUrlHosts"]);
    return {
      path: resultPath(value["path"], false),
      encoding: "url",
      mimeType,
      allowedUrlHosts
    };
  }
  if (value["allowedUrlHosts"] !== undefined) throw invalid();
  return {
    path: resultPath(value["path"], false),
    encoding: "base64",
    mimeType
  };
}

function allowedHosts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw invalid();
  const hosts = value.map((candidate) => {
    if (typeof candidate !== "string" || candidate !== candidate.toLowerCase()
      || !/^[a-z0-9.-]{1,253}$/u.test(candidate) || !candidate.includes(".")
      || candidate.startsWith(".") || candidate.endsWith(".") || candidate.includes("..")
      || candidate.endsWith(".local") || isIP(candidate) !== 0) throw invalid();
    return candidate;
  });
  if (new Set(hosts).size !== hosts.length) throw invalid();
  return hosts;
}

function resultPath(value: unknown, allowEmpty: boolean): ResultPath {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 24
    || value.some((segment) => typeof segment !== "string" || segment.length < 1
      || Buffer.byteLength(segment, "utf8") > 128 || segment.includes("\0")
      || ["__proto__", "prototype", "constructor"].includes(segment))) throw invalid();
  return [...value] as string[];
}

function valuesAtPath(value: unknown, path: ResultPath): readonly unknown[] {
  let values: readonly unknown[] = [value];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const candidate of values) {
      if (segment === "*") {
        if (Array.isArray(candidate)) next.push(...candidate);
        else if (record(candidate)) next.push(...Object.values(candidate));
      } else if (record(candidate) && Object.hasOwn(candidate, segment)) {
        next.push(candidate[segment]);
      }
    }
    values = next;
  }
  return values;
}

function requiredStringAtPath(value: unknown, path: ResultPath): string {
  const result = optionalStringAtPath(value, path);
  if (result === undefined || result.length === 0) throw invalid();
  return result;
}

function optionalStringAtPath(value: unknown, path: ResultPath | undefined): string | undefined {
  if (path === undefined) return undefined;
  const values = valuesAtPath(value, path);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].includes("\0")) throw invalid();
  return values[0];
}

function optionalNumberAtPath(value: unknown, path: ResultPath | undefined): number | undefined {
  if (path === undefined) return undefined;
  const values = valuesAtPath(value, path);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "number" || !Number.isFinite(values[0])) throw invalid();
  return values[0];
}

function decodeMappedBase64(
  raw: string,
  maximumBytes: number
): { readonly bytes: Uint8Array; readonly mimeType?: string } {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/su.exec(raw);
  const mimeType = dataUrl?.[1]?.toLowerCase();
  if (mimeType !== undefined && !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType)) throw invalid();
  const encoded = (dataUrl?.[2] ?? raw).replace(/\s/gu, "");
  if (encoded.length < 4 || encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes || bytes.toString("base64") !== encoded) throw invalid();
  return { bytes, ...(mimeType === undefined ? {} : { mimeType }) };
}

function mappedHttpsUrl(raw: string, allowedUrlHosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  if (Buffer.byteLength(raw, "utf8") > 16_384 || url.protocol !== "https:" || url.port !== ""
    || url.username !== "" || url.password !== "" || url.hash !== ""
    || !allowedUrlHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw invalid();
  return url;
}

export function isPublicAudioResultAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split(".").map(Number);
    if (a === undefined || b === undefined || c === undefined) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && b >= 18 && b <= 19) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const normalized = value.toLowerCase();
    return (normalized.startsWith("2") || normalized.startsWith("3"))
      && !normalized.startsWith("2001:db8:")
      && !normalized.includes(".");
  }
  return false;
}

async function pinnedHttpsRequest(input: PinnedHttpsRequestInput): Promise<PinnedHttpsResponse> {
  return await new Promise<PinnedHttpsResponse>((resolve, reject) => {
    const request = httpsRequest({
      hostname: input.address,
      port: 443,
      path: `${input.url.pathname}${input.url.search}`,
      method: "GET",
      servername: input.url.hostname,
      headers: { host: input.url.hostname, accept: "audio/*, image/png, image/jpeg, image/webp" },
      rejectUnauthorized: true,
      signal: input.signal,
      agent: false
    }, async (response) => {
      const status = response.statusCode ?? 500;
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
        key.toLowerCase(),
        value === undefined ? undefined : Array.isArray(value) ? value.join(", ") : value
      ]));
      if ([301, 302, 303, 307, 308].includes(status) || status < 200 || status >= 300) {
        response.destroy();
        resolve({ status, headers, bytes: new Uint8Array() });
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && (!Number.isSafeInteger(declared) || declared < 0 || declared > input.maximumBytes)) {
        response.destroy();
        reject(invalid());
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of response) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += part.byteLength;
          if (total > input.maximumBytes) throw invalid();
          chunks.push(part);
        }
        resolve({ status, headers, bytes: Buffer.concat(chunks) });
      } catch {
        request.destroy();
        reject(invalid());
      }
    });
    request.once("error", () => reject(invalid()));
    request.end();
  });
}

async function awaitWithAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : invalid());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([value, aborted]); }
  finally { if (onAbort !== undefined) signal.removeEventListener("abort", onAbort); }
}

function mediaPart(value: unknown, type: "audio" | "image"): boolean {
  if (!record(value)) return false;
  if (value["type"] === type) return true;
  const source = value["type"] === "resource_link" ? value
    : value["type"] === "resource" && record(value["resource"]) ? value["resource"] : undefined;
  return typeof source?.["mimeType"] === "string" && source["mimeType"].startsWith(`${type}/`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalid(): McpAudioResultMappingError {
  return new McpAudioResultMappingError();
}
