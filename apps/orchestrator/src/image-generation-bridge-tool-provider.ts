import type { BlobRef } from "@joko/core";

import type {
  BridgeToolCallContext,
  BridgeToolCallResult,
  BridgeToolProvider,
  McpResultArtifactStore,
  McpToolDescriptor
} from "./mcp-router.js";
import {
  ProviderCredentialSurfaceResolver,
  type ConfiguredProviderCredentialSurface
} from "./provider-credential-surface.js";

export const IMAGE_GENERATION_BRIDGE_TOOL_PROVIDER_ID = "joko-image-generation";
export const IMAGE_GENERATION_RESPONSE_MAXIMUM_BYTES = 64 * 1024 * 1024;

const IMAGE_GENERATION_TOOL_NAME = "image_generate";
const OPENAI_IMAGES_GENERATION_ENDPOINT = "https://api.openai.com/v1/images/generations";
const IMAGE_GENERATION_TIMEOUT_MS = 10 * 60_000;
const MAXIMUM_PROMPT_BYTES = 32 * 1024;
const ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;

type ImageAspectRatio = (typeof ASPECT_RATIOS)[number];
type SupportedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

interface ImageGenerationRoute {
  readonly owner: ConfiguredProviderCredentialSurface;
  readonly modelId: string;
  readonly displayName: string;
}

interface ImageGenerationSnapshot {
  readonly signature: string;
  readonly routes: readonly ImageGenerationRoute[];
}

export interface ImageGenerationBridgeToolProviderOptions {
  readonly credentialSurfaces: ProviderCredentialSurfaceResolver;
  readonly artifacts: McpResultArtifactStore;
  readonly fetch?: typeof fetch;
}

/**
 * Service-owned image execution bridge. Provider identity selects neither the
 * protocol nor the endpoint: both come from the declared credential surface.
 */
export class ImageGenerationBridgeToolProvider implements BridgeToolProvider {
  readonly id = IMAGE_GENERATION_BRIDGE_TOOL_PROVIDER_ID;
  readonly #credentialSurfaces: ProviderCredentialSurfaceResolver;
  readonly #artifacts: McpResultArtifactStore;
  readonly #fetch: typeof fetch;
  #generation = 1;
  #signature: string | undefined;
  #routes: readonly ImageGenerationRoute[] = [];

  constructor(options: ImageGenerationBridgeToolProviderOptions) {
    this.#credentialSurfaces = options.credentialSurfaces;
    this.#artifacts = options.artifacts;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get generation(): number {
    this.#refreshSnapshot();
    return this.#generation;
  }

  get available(): boolean {
    this.#refreshSnapshot();
    return this.#routes.length > 0;
  }

  get tools(): readonly McpToolDescriptor[] {
    this.#refreshSnapshot();
    if (this.#routes.length === 0) return [];
    const multipleRoutes = this.#routes.length > 1;
    return [{
      serverId: this.id,
      name: IMAGE_GENERATION_TOOL_NAME,
      runtimeName: IMAGE_GENERATION_TOOL_NAME,
      description:
        "Generate an image with the configured image model. Use a clear, complete visual prompt and an optional supported aspect ratio.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            description: "A complete description of the image to generate."
          },
          aspect_ratio: {
            type: "string",
            enum: [...ASPECT_RATIOS],
            description: "Optional output aspect ratio."
          },
          ...(multipleRoutes ? {
            model: {
              type: "string",
              enum: this.#routes.map((route) => route.modelId),
              description: "The configured image model to use."
            }
          } : {})
        },
        required: multipleRoutes ? ["prompt", "model"] : ["prompt"],
        additionalProperties: false
      },
      requiresPermission: true
    }];
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    _context: BridgeToolCallContext
  ): Promise<BridgeToolCallResult> {
    this.#refreshSnapshot();
    if (name !== IMAGE_GENERATION_TOOL_NAME || this.#routes.length === 0) {
      throw new Error("Image generation is not part of this runtime snapshot.");
    }
    const multipleRoutes = this.#routes.length > 1;
    assertOnlyKeys(arguments_, multipleRoutes
      ? ["prompt", "aspect_ratio", "model"]
      : ["prompt", "aspect_ratio"]);
    const prompt = requiredUtf8String(arguments_["prompt"], MAXIMUM_PROMPT_BYTES, "Image prompt is invalid.");
    const aspectRatio = optionalAspectRatio(arguments_["aspect_ratio"]);
    const selectedModel = multipleRoutes ? requiredModel(arguments_["model"]) : undefined;
    const route = multipleRoutes
      ? this.#routes.find((candidate) => candidate.modelId === selectedModel)
      : this.#routes[0];
    if (route === undefined || !this.#credentialSurfaces.modelEnabled(route.owner, route.modelId)) {
      throw new Error("The selected image model is unavailable.");
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.#credentialSurfaces.resolveSecret(route.owner).trim();
      if (apiKey.length === 0) throw new Error("Image generation credential is not configured.");
      const generated = await this.#dispatch({
        executionApi: route.owner.surface.executionApi,
        apiKey,
        model: route.modelId,
        prompt,
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
        ...(signal === undefined ? {} : { signal })
      });
      let blob: BlobRef;
      try {
        blob = await this.#artifacts.ingestBytes(generated.bytes, {
          fileName: `generated-image${extensionForMime(generated.mimeType)}`,
          mimeType: generated.mimeType
        });
      } catch {
        throw new Error("Generated image could not be stored.");
      }
      return imageResult(blob, route.modelId);
    } finally {
      apiKey = undefined;
    }
  }

  #refreshSnapshot(): void {
    const next = this.#readSnapshot();
    if (this.#signature !== undefined && next.signature !== this.#signature) this.#generation += 1;
    this.#signature = next.signature;
    this.#routes = next.routes;
  }

  #readSnapshot(): ImageGenerationSnapshot {
    const owners = this.#credentialSurfaces.listConfigured({
      capability: "image_generation",
      executionApi: "openai-images"
    });
    if (owners.length > 64 || owners.some((owner) => owner.surface.models.length > 64)) {
      return { signature: "catalog-limit", routes: [] };
    }
    const candidates = owners.flatMap((owner) => owner.surface.models.flatMap((model) => {
      if (!boundedIdentifier(model.modelId, 256)
        || !boundedDisplayName(model.displayName, 512)
        || !this.#credentialSurfaces.modelEnabled(owner, model.modelId)) return [];
      return [{ owner, modelId: model.modelId, displayName: model.displayName }];
    }));
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      counts.set(candidate.modelId, (counts.get(candidate.modelId) ?? 0) + 1);
    }
    const routes = candidates
      .filter((candidate) => counts.get(candidate.modelId) === 1)
      .sort((left, right) => left.modelId.localeCompare(right.modelId, "en"));
    const signature = JSON.stringify(routes.map((route) => ({
      backendId: route.owner.backend.id,
      providerId: route.owner.provider.providerId,
      surfaceId: route.owner.surface.surfaceId,
      executionApi: route.owner.surface.executionApi,
      credentialReferenceId: route.owner.credentialReferenceId,
      credentialGeneration: route.owner.credential.generation,
      modelId: route.modelId,
      displayName: route.displayName
    })));
    return { signature, routes };
  }

  async #dispatch(input: {
    readonly executionApi: ConfiguredProviderCredentialSurface["surface"]["executionApi"];
    readonly apiKey: string;
    readonly model: string;
    readonly prompt: string;
    readonly aspectRatio?: ImageAspectRatio;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: SupportedImageMime }> {
    switch (input.executionApi) {
      case "openai-images":
        return await this.#dispatchOpenAiImages(input);
      default:
        throw new Error("Image generation execution protocol is unsupported.");
    }
  }

  async #dispatchOpenAiImages(input: {
    readonly apiKey: string;
    readonly model: string;
    readonly prompt: string;
    readonly aspectRatio?: ImageAspectRatio;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly bytes: Uint8Array; readonly mimeType: SupportedImageMime }> {
    const requestSignal = boundedSignal(input.signal, IMAGE_GENERATION_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(OPENAI_IMAGES_GENERATION_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          n: 1,
          size: input.aspectRatio === undefined ? "auto" : sizeForAspectRatio(input.aspectRatio)
        }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: requestSignal.signal
      });
    } catch {
      requestSignal.dispose();
      throw new Error("Image generation request did not complete.");
    }
    try {
      if (response.redirected
        || (response.url !== "" && response.url !== OPENAI_IMAGES_GENERATION_ENDPOINT)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Image generation response was redirected.");
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Image generation request was rejected.");
      }
      if (mediaType(response.headers.get("content-type")) !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Image generation returned an unsupported response type.");
      }
      const body = await readBoundedBody(response, IMAGE_GENERATION_RESPONSE_MAXIMUM_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        throw new Error("Image generation returned an invalid response.");
      }
      const base64 = imageBase64(parsed);
      const bytes = decodeCanonicalBase64(base64, this.#artifacts.maximumBlobBytes);
      const mimeType = sniffImageMime(bytes);
      if (mimeType === undefined) throw new Error("Image generation returned an unsupported image format.");
      return { bytes, mimeType };
    } finally {
      requestSignal.dispose();
    }
  }
}

function imageResult(blob: BlobRef, model: string): BridgeToolCallResult {
  return {
    content: [{ type: "text", text: "Image generated successfully." }],
    structuredContent: {
      generated: true,
      model,
      mimeType: blob.mimeType,
      byteLength: blob.byteLength
    },
    isError: false,
    hostImages: [{ blob }]
  };
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error("Image generation arguments are invalid.");
  }
}

function requiredUtf8String(value: unknown, maximumBytes: number, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(error);
  return normalized;
}

function requiredModel(value: unknown): string {
  if (typeof value !== "string" || !boundedIdentifier(value, 256)) {
    throw new Error("Image model is invalid.");
  }
  return value;
}

function optionalAspectRatio(value: unknown): ImageAspectRatio | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(ASPECT_RATIOS as readonly string[]).includes(value)) {
    throw new Error("Image aspect ratio is invalid.");
  }
  return value as ImageAspectRatio;
}

function sizeForAspectRatio(value: ImageAspectRatio): string {
  switch (value) {
    case "1:1": return "1024x1024";
    case "3:2": return "1536x1024";
    case "2:3": return "1024x1536";
    default: throw new Error("Image aspect ratio is unsupported.");
  }
}

function boundedIdentifier(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedDisplayName(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
  };
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const byteLength = Number(declared);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Image generation response exceeded its size limit.");
    }
  }
  if (response.body === null) throw new Error("Image generation returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Image generation response exceeded its size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function imageBase64(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value["data"]) || value["data"].length !== 1) {
    throw new Error("Image generation returned an invalid response.");
  }
  const first = value["data"][0];
  if (!isRecord(first) || typeof first["b64_json"] !== "string") {
    throw new Error("Image generation returned an invalid response.");
  }
  return first["b64_json"];
}

function decodeCanonicalBase64(value: string, maximumBytes: number): Uint8Array {
  const maximumEncodedBytes = Math.ceil(maximumBytes / 3) * 4;
  if (value.length === 0
    || value.length > maximumEncodedBytes
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Image generation returned invalid image data.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0
    || decoded.byteLength > maximumBytes
    || decoded.toString("base64") !== value) {
    throw new Error("Image generation returned invalid image data.");
  }
  return decoded;
}

function sniffImageMime(bytes: Uint8Array): SupportedImageMime | undefined {
  if (bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.byteLength >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.byteLength >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.byteLength >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

function extensionForMime(mimeType: SupportedImageMime): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: throw new Error("Image MIME type is unsupported.");
  }
}

function mediaType(value: string | null): string | undefined {
  if (value === null) return undefined;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return type === "" ? undefined : type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
