import {
  AUDIO_ARTIFACT_MAXIMUM_TRACKS, AUDIO_ARTWORK_MAXIMUM_BYTES,
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  assertAudioArtifactMetadata, type AudioArtifactMetadata, type BlobRef
} from "@joko/core";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, McpCallResult, McpResultArtifactStore } from "./mcp-router.js";
import { decodeAudioArtwork, inspectAudioArtifact } from "./audio-artifact-media.js";
import { nativeBindingFingerprint } from "./native-state-observation.js";

interface AudioPublicationContext extends BridgeToolCallContext {
  readonly requestIdentity: string;
  readonly requestBodyHash: string;
}

interface AudioResultResources {
  readonly read: (uri: string, signal: AbortSignal) => Promise<{ readonly contents: readonly unknown[] }>;
  readonly signal?: AbortSignal;
}

export class McpAudioResultError extends Error {
  readonly code = "invalid_result";
  constructor() { super("MCP audio result is invalid."); }
}

/** Explicit result media, resolved only by the runtime that produced the result. */
export class McpAudioArtifacts {
  constructor(private readonly store: OperationalStore, private readonly artifacts: McpResultArtifactStore) {}

  replay(context: AudioPublicationContext): McpCallResult | undefined {
    const operation = this.store.findOperation<McpCallResult>(this.operationId(context));
    if (operation === undefined) return undefined;
    if (operation.bodyHash !== operationBodyHash(this.body(context))) throw new McpAudioResultError();
    if (operation.status !== "completed" || operation.response === undefined) throw new Error("Audio publication has no confirmed result; it cannot be replayed.");
    return operation.response;
  }

  async publish(result: McpCallResult, context: AudioPublicationContext, guard: () => void, redact: (value: string) => string, normalize: (value: McpCallResult) => McpCallResult, resources: AudioResultResources): Promise<McpCallResult> {
    const rawDeclarations = result.structuredContent?.["jokoAudioArtifacts"];
    const indices = result.content.flatMap((part, index) => mediaType(part, "audio") ? [index] : []);
    if (rawDeclarations === undefined && indices.length === 0) return result;
    if (result.isError || indices.length === 0 || indices.length > AUDIO_ARTIFACT_MAXIMUM_TRACKS) throw new McpAudioResultError();
    const declarations = new Map<number, Record<string, unknown>>();
    if (rawDeclarations !== undefined) {
      if (!Array.isArray(rawDeclarations) || rawDeclarations.length > AUDIO_ARTIFACT_MAXIMUM_TRACKS) throw new McpAudioResultError();
      for (const item of rawDeclarations) {
        if (!record(item) || !keys(item, ["audioContentIndex", "kind", "title", "description", "durationSeconds", "artwork"])
          || !Number.isSafeInteger(item["audioContentIndex"]) || !indices.includes(Number(item["audioContentIndex"]))
          || declarations.has(Number(item["audioContentIndex"]))) throw new McpAudioResultError();
        declarations.set(Number(item["audioContentIndex"]), item);
      }
    }
    const claim = this.store.claimDeferredEffectOperation<McpCallResult>({ id: this.operationId(context), kind: "audio_artifact_publication", body: this.body(context) }, guard);
    if (!claim.claimed) return claim.value;
    const staged: BlobRef[] = [];
    const covers = new Map<number, AudioArtifactMetadata["artwork"]>();
    const consumed = new Set(indices);
    for (const declaration of declarations.values()) {
      const art = declaration["artwork"];
      if (record(art) && Number.isSafeInteger(art["imageContentIndex"])) {
        const index = Number(art["imageContentIndex"]);
        if (mediaType(result.content[index], "image")) consumed.add(index);
      }
    }
    // Adopted resources become private input identities. Providers may repeat
    // their signed URI anywhere in ordinary result text or structured data.
    const privateUris = [...new Set([...consumed].flatMap((index) => {
      const part = result.content[index];
      if (!record(part)) return [];
      const source = part["type"] === "resource_link" ? part : part["type"] === "resource" && record(part["resource"]) ? part["resource"] : undefined;
      return typeof source?.["uri"] === "string" && source["uri"].length > 0 ? [source["uri"]] : [];
    }))].sort((left, right) => right.length - left.length);
    const redactIdentities = (value: string): string => {
      let safe = value;
      for (const uri of privateUris) safe = safe.replaceAll(uri, "[private resource]");
      return safe;
    };
    const redactPrivate = (value: string): string => redact(redactIdentities(value));
    const tracks: { blob: BlobRef; metadata: AudioArtifactMetadata }[] = [];
    let resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const receive = async (value: unknown, type: "audio" | "image", maximum: number): Promise<{ bytes: Buffer; mimeType: string }> => {
      guard();
      if (!record(value)) throw new McpAudioResultError();
      if (value["type"] === type) return binary(value, type, maximum);
      let resource: unknown;
      if (value["type"] === "resource") resource = value["resource"];
      else if (value["type"] === "resource_link") {
        if (typeof value["uri"] !== "string" || value["uri"].length === 0 || Buffer.byteLength(value["uri"]) > 8192
          || value["uri"].includes("\0") || typeof value["name"] !== "string" || !value["name"]
          || typeof value["mimeType"] !== "string") throw new McpAudioResultError();
        const response = await readResultResource(value["uri"], resources);
        guard();
        const receivedBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
        if (resultBytes + receivedBytes > this.artifacts.maximumBlobBytes) {
          throw Object.assign(new Error("MCP audio resources exceed the configured Artifact capacity."), { code: "resource_exhausted" });
        }
        resultBytes += receivedBytes;
        if (!Array.isArray(response.contents) || response.contents.length !== 1) throw new McpAudioResultError();
        resource = response.contents[0];
        if (!record(resource) || resource["uri"] !== value["uri"] || resource["mimeType"] !== value["mimeType"]) throw new McpAudioResultError();
      }
      if (!record(resource) || typeof resource["uri"] !== "string" || !resource["uri"] || "text" in resource) throw new McpAudioResultError();
      return binary({ type, data: resource["blob"], mimeType: resource["mimeType"] }, type, maximum);
    };
    const stage = async (bytes: Uint8Array, mimeType: string, fileName: string): Promise<BlobRef> => {
      guard();
      const stored = await this.artifacts.ingestBytes(bytes, { mimeType, fileName, expiresAt: Date.now() + 10 * 60_000 });
      const blob: BlobRef = { id: stored.id, sha256: stored.sha256, byteLength: stored.byteLength, mimeType: stored.mimeType, ...(stored.fileName === undefined ? {} : { fileName: stored.fileName }) };
      staged.push(blob);
      guard();
      return blob;
    };
    try {
      for (const index of indices) {
        guard();
        const declaration = declarations.get(index);
        const part = result.content[index];
        const resourceLabel = declaration === undefined && record(part) && part["type"] === "resource_link" ? part : undefined;
        const metadata = {
          kind: declaration === undefined ? "generic" : declaration["kind"],
          title: declaration?.["title"] !== undefined ? declaration["title"] : resourceLabel?.["title"] === undefined ? "" : resourceLabel["title"],
          description: declaration?.["description"] !== undefined ? declaration["description"] : resourceLabel?.["description"] === undefined ? "" : resourceLabel["description"],
          ...(declaration?.["durationSeconds"] === undefined ? {} : { durationSeconds: declaration["durationSeconds"] })
        };
        try { assertAudioArtifactMetadata(metadata); } catch { throw new McpAudioResultError(); }
        const audio = await receive(part, "audio", this.artifacts.maximumBlobBytes);
        const detected = await inspectAudioArtifact(audio.bytes, audio.mimeType).catch(() => { throw new McpAudioResultError(); });
        guard();
        let artwork: AudioArtifactMetadata["artwork"];
        const art = declaration?.["artwork"];
        if (record(art) && Number.isSafeInteger(art["imageContentIndex"])) {
          const imageIndex = Number(art["imageContentIndex"]);
          const alt = art["alt"] === undefined ? "" : art["alt"];
          const validArtwork = keys(art, ["imageContentIndex", "alt"]) && typeof alt === "string" && Buffer.byteLength(alt) <= 4096 && !alt.includes("\0");
          if (validArtwork && covers.has(imageIndex)) artwork = covers.get(imageIndex);
          else if (validArtwork) {
            try {
              const image = await receive(result.content[imageIndex], "image", AUDIO_ARTWORK_MAXIMUM_BYTES);
              const info = await decodeAudioArtwork(image.bytes, image.mimeType);
              guard();
              const blob = await stage(image.bytes, image.mimeType, `audio-artwork-${imageIndex}.${info.format}`);
              artwork = { blob, width: info.width, height: info.height, alt: "" };
            } catch {
              guard();
              // Optional artwork failure never prevents a valid audio track.
            }
            covers.set(imageIndex, artwork);
          }
          if (artwork !== undefined && typeof alt === "string") artwork = { ...artwork, alt: redactPrivate(alt) };
        }
        const blob = await stage(audio.bytes, detected.mime, `audio-${index}.${detected.ext}`);
        const normalized: AudioArtifactMetadata = { ...metadata, title: redactPrivate(metadata.title), description: redactPrivate(metadata.description), ...(artwork === undefined ? {} : { artwork }) };
        assertAudioArtifactMetadata(normalized);
        tracks.push({ blob, metadata: normalized });
      }
      guard();
      const structuredContent = { ...result.structuredContent };
      delete structuredContent["jokoAudioArtifacts"];
      const sanitized = normalize(redactResourceValues({
        content: [...result.content.filter((_, index) => !consumed.has(index)), ...tracks.map((track) => ({ type: "text", text: `Audio Artifact ${track.blob.id}: ${track.metadata.title || track.blob.fileName}` }))],
        structuredContent,
        isError: false
      }, redactIdentities));
      return this.store.completeDeferredEffectOperation<McpCallResult>(claim.operation.id, claim.operation.bodyHash, (store) => {
        guard();
        const session = store.getSession(context.sessionId).descriptor;
        for (const cover of covers.values()) if (cover !== undefined) store.adoptSessionArtifact({ blob: cover.blob, sessionId: session.id });
        for (const track of tracks) {
          store.adoptSessionArtifact({ blob: track.blob, sessionId: session.id, audioMetadata: track.metadata });
          store.appendEvent({ backendId: session.backendId, targetId: session.targetId, sessionId: session.id,
            generation: context.generation, operationId: claim.operation.id, traceId: `audio:${context.requestIdentity}`,
            metadata: { namespace: "joko.audio_artifact", fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: nativeBindingFingerprint(session.binding.opaqueRef) } },
            payload: { type: "artifact", artifact: track.blob, purpose: "audio", audioMetadata: track.metadata } });
        }
        return sanitized;
      }).value;
    } catch (error) {
      this.store.failEffectOperation(claim.operation.id, claim.operation.bodyHash, new Error("Audio Artifact publication did not complete."));
      throw error;
    } finally {
      this.store.releaseArtifactStaging(staged.map((blob) => blob.id));
    }
  }

  private operationId(context: AudioPublicationContext): string { return `audio-publication:${context.requestIdentity}`; }
  private body(context: AudioPublicationContext): unknown {
    return { sessionId: context.sessionId, targetId: context.targetId, generation: context.generation, requestBodyHash: context.requestBodyHash };
  }
}

function binary(value: unknown, type: "audio" | "image", maximum: number): { bytes: Buffer; mimeType: string } {
  if (!record(value) || value["type"] !== type || typeof value["mimeType"] !== "string"
    || typeof value["data"] !== "string" || value["data"].length > Math.ceil(maximum / 3) * 4) throw new McpAudioResultError();
  const data = value["data"];
  if (data.length === 0 || data.length % 4 !== 0) throw new McpAudioResultError();
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > maximum || bytes.toString("base64") !== data) throw new McpAudioResultError();
  return { bytes, mimeType: value["mimeType"] };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

function redactResourceValues<T>(value: T, redact: (value: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactResourceValues(item, redact)) as T;
  if (!record(value)) return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [originalKey, item] of Object.entries(value)) {
    const baseKey = redact(originalKey);
    let key = baseKey;
    for (let suffix = 2; Object.hasOwn(result, key); suffix += 1) key = `${baseKey}#${suffix}`;
    result[key] = redactResourceValues(item, redact);
  }
  return result as T;
}

function mediaType(value: unknown, type: "audio" | "image"): boolean {
  if (!record(value)) return false;
  if (value["type"] === type) return true;
  const source = value["type"] === "resource_link" ? value : value["type"] === "resource" && record(value["resource"]) ? value["resource"] : undefined;
  return typeof source?.["mimeType"] === "string" && source["mimeType"].startsWith(`${type}/`);
}

/** A URI is an opaque MCP resource identity, never a destination for host fetch or file IO. */
async function readResultResource(uri: string, resources: AudioResultResources): Promise<{ readonly contents: readonly unknown[] }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30_000);
  const signal = resources.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, resources.signal]);
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      resources.read(uri, signal),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("MCP audio resource reading was cancelled or timed out."));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } catch {
    // Resource URIs and transport errors may carry producer credentials.
    throw new McpAudioResultError();
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
