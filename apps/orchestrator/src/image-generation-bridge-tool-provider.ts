import { JokoError, type BlobRef } from "@joko/core";
import { OperationInProgressError, OperationPreviouslyFailedError, type OperationalStore } from "@joko/store";

import type { ArtifactStore } from "./artifact-store.js";
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
const IMAGE_EDIT_TOOL_NAME = "image_edit";
const OPENAI_IMAGES_GENERATION_ENDPOINT = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGES_EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
const GEMINI_IMAGES_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const IMAGE_GENERATION_TIMEOUT_MS = 10 * 60_000;
const IMAGE_RESULT_STAGING_MS = 10 * 60_000;
const MAXIMUM_PROMPT_BYTES = 32 * 1024;
const MAXIMUM_REFERENCE_IMAGES = 16;
const REFERENCE_IMAGE_BYTE_LIMIT = 50_000_000;
const MAXIMUM_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;
const ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
const EXACT_IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
const GEMINI_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const GEMINI_FLASH_ASPECT_RATIOS = [...GEMINI_ASPECT_RATIOS, "1:4", "4:1", "1:8", "8:1"] as const;
const GEMINI_RESOLUTIONS = ["512", "1K", "2K", "4K"] as const;
const GEMINI_FLASH_MODEL = "gemini/gemini-3.1-flash-image";
const GEMINI_PRO_MODEL = "gemini/gemini-3-pro-image";

type ImageAspectRatio = (typeof ASPECT_RATIOS)[number];
type ImageQuality = (typeof EXACT_IMAGE_QUALITIES)[number];
type SupportedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type ImageToolName = typeof IMAGE_GENERATION_TOOL_NAME | typeof IMAGE_EDIT_TOOL_NAME;

interface ImageEditReference {
  readonly blob: BlobRef;
  readonly file: Blob;
  readonly extension: string;
}

interface ImageDispatchInput {
  readonly executionApi: ConfiguredProviderCredentialSurface["surface"]["executionApi"];
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly size?: string;
  readonly quality?: ImageQuality;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly references?: readonly ImageEditReference[];
  readonly signal?: AbortSignal;
  readonly beforeDispatch: () => void;
}

type ImageProviderFetch = (input: RequestInfo | URL, init: RequestInit, beforeDispatch: () => void) => Promise<Response>;

interface ImageGenerationRoute {
  readonly owner: ConfiguredProviderCredentialSurface;
  readonly modelId: string;
  readonly displayName: string;
}

interface ImageGenerationSnapshot {
  readonly signature: string;
  readonly routes: readonly ImageGenerationRoute[];
}

export interface ExecutableImageGenerationModel {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
}

export interface ImageGenerationBridgeToolProviderOptions {
  readonly store: OperationalStore;
  readonly credentialSurfaces: ProviderCredentialSurfaceResolver;
  readonly artifacts: McpResultArtifactStore & Pick<ArtifactStore, "readBlob">;
  readonly fetch?: ImageProviderFetch;
}

/**
 * Service-owned image execution bridge. Provider identity selects neither the
 * protocol nor the endpoint: both come from the declared credential surface.
 */
export class ImageGenerationBridgeToolProvider implements BridgeToolProvider {
  readonly id = IMAGE_GENERATION_BRIDGE_TOOL_PROVIDER_ID;
  readonly #credentialSurfaces: ProviderCredentialSurfaceResolver;
  readonly #artifacts: ImageGenerationBridgeToolProviderOptions["artifacts"];
  readonly #store: OperationalStore;
  readonly #fetch: ImageProviderFetch;
  #generation = 1;
  #signature: string | undefined;
  #routes: readonly ImageGenerationRoute[] = [];

  constructor(options: ImageGenerationBridgeToolProviderOptions) {
    this.#store = options.store;
    this.#credentialSurfaces = options.credentialSurfaces;
    this.#artifacts = options.artifacts;
    this.#fetch = options.fetch ?? ((input, init, beforeDispatch) => {
      beforeDispatch();
      return globalThis.fetch(input, init);
    });
  }

  get generation(): number {
    this.#refreshSnapshot();
    return this.#generation;
  }

  get available(): boolean {
    this.#refreshSnapshot();
    return this.#routes.length > 0;
  }

  listModels(): readonly ExecutableImageGenerationModel[] {
    return this.#readSnapshot().routes.map(route => ({ id: route.modelId, name: route.displayName, providerId: route.owner.provider.providerId }));
  }

  get tools(): readonly McpToolDescriptor[] {
    this.#refreshSnapshot();
    if (this.#routes.length === 0) return [];
    const tools = [describeImageTool(IMAGE_GENERATION_TOOL_NAME, this.#routes)];
    const editRoutes = this.#routes.filter(route => isGptImage2Route(route) || isGeminiImageRoute(route));
    if (editRoutes.length > 0) tools.push(describeImageTool(IMAGE_EDIT_TOOL_NAME, editRoutes));
    return tools;
  }

  toolsForSession(sessionId: string): readonly McpToolDescriptor[] {
    const tools = this.tools;
    const session = this.#store.findSession(sessionId)?.descriptor;
    if (session === undefined) return tools;
    const target = this.#store.getTarget(session.targetId).descriptor;
    return target.trusted && target.remoteWorkspace === undefined && session.remoteWorkspace === undefined
      ? tools : tools.filter(tool => tool.name !== IMAGE_EDIT_TOOL_NAME);
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<BridgeToolCallResult> {
    this.#refreshSnapshot();
    if (name !== IMAGE_GENERATION_TOOL_NAME && name !== IMAGE_EDIT_TOOL_NAME) {
      throw new Error("The image tool is unavailable in this runtime snapshot.");
    }
    const editing = name === IMAGE_EDIT_TOOL_NAME;
    const routes = editing ? this.#routes.filter(route => isGptImage2Route(route) || isGeminiImageRoute(route)) : this.#routes;
    const multipleRoutes = routes.length > 1;
    const allowed = ["prompt", "aspect_ratio", "size", "quality", "resolution"];
    if (editing) allowed.push("image");
    if (multipleRoutes) allowed.push("model");
    assertOnlyKeys(arguments_, allowed);
    const prompt = requiredUtf8String(arguments_["prompt"], MAXIMUM_PROMPT_BYTES, "Image prompt is invalid.");
    const selectedModel = multipleRoutes ? requiredModel(arguments_["model"]) : undefined;
    const route = multipleRoutes
      ? routes.find((candidate) => candidate.modelId === selectedModel)
      : routes[0];
    if (route === undefined || !this.#credentialSurfaces.modelEnabled(route.owner, route.modelId)) {
      throw new Error("The selected image model is unavailable.");
    }
    if (!isGptImage2Route(route) && (arguments_["size"] !== undefined || arguments_["quality"] !== undefined)) {
      throw new Error("The selected image model does not support size and quality options.");
    }
    const gemini = isGeminiImageRoute(route);
    const openAiAspectRatio = gemini ? undefined : optionalAspectRatio(arguments_["aspect_ratio"]);
    const aspectRatio = gemini ? optionalGeminiAspectRatio(arguments_["aspect_ratio"], route.modelId) : openAiAspectRatio;
    if (!gemini && arguments_["resolution"] !== undefined) throw new Error("The selected image model does not support resolution.");
    const resolution = gemini ? optionalGeminiResolution(arguments_["resolution"], route.modelId) : undefined;
    const size = gemini ? undefined : imageSize(arguments_["size"], openAiAspectRatio);
    const quality = optionalImageQuality(arguments_["quality"]);
    if (editing && gemini && Array.isArray(arguments_["image"]) && arguments_["image"].length > 14) {
      throw new Error("Gemini image editing accepts at most 14 reference images.");
    }
    const references = editing ? await this.#readEditReferences(arguments_["image"], context, signal) : undefined;

    let apiKey: string | undefined;
    try {
      apiKey = this.#credentialSurfaces.resolveSecret(route.owner).trim();
      if (apiKey.length === 0) throw new Error("Image generation credential is not configured.");
      let operation: { readonly id: string; readonly bodyHash: string } | undefined;
      const assertDispatched = () => {
        this.#credentialSurfaces.assertDispatchedCredential(route.owner, route.modelId);
        references?.assertCurrent();
      };
      try {
        const generated = await this.#dispatch({
          executionApi: route.owner.surface.executionApi,
          apiKey,
          model: route.modelId,
          prompt,
          ...(size === undefined ? {} : { size }),
          ...(aspectRatio === undefined ? {} : { aspectRatio }),
          ...(resolution === undefined ? {} : { resolution }),
          ...(quality === undefined ? {} : { quality }),
          ...(references === undefined ? {} : { references: references.images }),
          ...(signal === undefined ? {} : { signal }),
          beforeDispatch: () => {
            signal?.throwIfAborted();
            context.assertCurrent?.();
            assertDispatched();
            context.acceptDispatchedImageResult?.(assertDispatched);
            const claim = this.#claimImageEffect(route, context, references?.images);
            if (!claim.claimed) throw new ReplayedImageEffect(claim.value);
            operation = claim.operation;
          }
        });
        if (operation === undefined) throw new Error("The original image request was not captured.");
        context.assertCurrent?.();
        const staged = await this.#artifacts.ingestBytes(generated.bytes, {
          fileName: `${editing ? "edited" : "generated"}-image${extensionForMime(generated.mimeType)}`,
          mimeType: generated.mimeType,
          ...(context.acceptDispatchedImageResult === undefined ? {} : { expiresAt: Date.now() + IMAGE_RESULT_STAGING_MS })
        });
        context.assertCurrent?.();
        const blob = this.#store.getArtifact(staged.id).blob;
        this.#store.completeDeferredEffectOperation(operation.id, operation.bodyHash, () => blob);
        return imageResult(blob, route.modelId, editing);
      } catch (error) {
        if (error instanceof ReplayedImageEffect) {
          const stored = this.#store.findArtifact(error.blob.id);
          if (stored === undefined) throw new Error("The original image result is no longer available.");
          return imageResult(stored.blob, route.modelId, editing);
        }
        if (operation === undefined) throw error;
        const failure = imageSubmissionFailure(operation.id, error instanceof ImageProviderRejection);
        try {
          this.#store.failEffectOperation(operation.id, operation.bodyHash, failure);
        } catch {
          // A lost terminal write leaves the original durable claim in place.
        }
        context.assertCurrent?.();
        throw failure;
      }
    } finally {
      apiKey = undefined;
    }
  }

  async #readEditReferences(value: unknown, context: BridgeToolCallContext, signal: AbortSignal | undefined) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_REFERENCE_IMAGES) {
      throw new Error(`Image editing requires 1–${MAXIMUM_REFERENCE_IMAGES} image references.`);
    }
    const input = context.nativeRootQueueInput;
    const assertRoot = context.assertNativeRoot;
    if (input === undefined || assertRoot === undefined) throw imageEditInputUnavailable();
    const assertNativeInput = (): void => {
      signal?.throwIfAborted();
      assertRoot();
      input.assertCurrent();
    };
    context.assertCurrent?.();
    assertNativeInput();
    const original = this.#store.getQueueItem(input.queueItemId);
    const operation = this.#store.getOperation(original.operationId);
    if ((operation.kind !== "sendInput" && operation.kind !== "send_input") || operation.status !== "completed"
      || operation.connectionId === undefined) throw imageEditInputUnavailable();
    const connection = this.#store.getConnection(operation.connectionId);
    const assertOwner = (): void => {
      assertNativeInput();
      const session = this.#store.getSession(context.sessionId).descriptor;
      const target = this.#store.getTarget(session.targetId).descriptor;
      const queue = this.#store.getQueueItem(original.id);
      const run = this.#store.getRun(queue.runId).descriptor;
      const backendGeneration = this.#store.getBackend(session.backendId).descriptor.instanceGeneration;
      if (queue.sessionId !== session.id || run.sessionId !== session.id || run.source !== "user" || run.parentRunId !== undefined
        || session.targetId !== context.targetId || session.binding.generation !== context.generation
        || session.archived || session.deletedAt !== undefined || session.remoteWorkspace !== undefined
        || !target.trusted || target.remoteWorkspace !== undefined || queue.bodyHash !== original.bodyHash
        || queue.backendInstanceGeneration !== backendGeneration
        || (queue.state !== "dispatching" && queue.state !== "backend_accepted") || queue.attemptId === undefined
        || queue.attemptId !== original.attemptId || run.activeAttemptId !== queue.attemptId) throw imageEditInputUnavailable();
      const attempt = this.#store.getAttempt(queue.attemptId).descriptor;
      if (attempt.generation !== context.generation || attempt.backendInstanceGeneration !== backendGeneration
        || attempt.endedAt !== undefined || attempt.runId !== run.id) throw imageEditInputUnavailable();
      this.#store.authorizeConnection(connection.id, connection.authKeyDigest);
    };
    assertOwner();
    const attached = original.body.images.map(image => image.blob);
    const records = value.map((reference: unknown) => {
      if (!boundedIdentifier(reference, 512)) throw imageEditInputUnavailable();
      const numbered = /^input:([1-9]\d{0,2})$/u.exec(reference);
      const attachment = numbered === null ? attached.find(blob => blob.id === reference) : attached[Number(numbered[1]) - 1];
      if (numbered !== null && attachment === undefined) throw imageEditInputUnavailable();
      const artifact = this.#store.findArtifact(attachment?.id ?? reference);
      if (artifact === undefined || (artifact.sessionId !== context.sessionId && (artifact.sessionId !== undefined || attachment === undefined))
        || (attachment !== undefined && (artifact.blob.sha256 !== attachment.sha256 || artifact.blob.byteLength !== attachment.byteLength))) {
        throw imageEditInputUnavailable();
      }
      if (!supportedEditMime(artifact.blob.mimeType) || artifact.blob.byteLength < 1 || artifact.blob.byteLength >= REFERENCE_IMAGE_BYTE_LIMIT) {
        throw new Error("An image reference exceeds its size limit or has an unsupported format.");
      }
      return artifact;
    });
    if (new Set(records.map(record => record.blob.id)).size !== records.length
      || records.reduce((bytes, record) => bytes + record.blob.byteLength, 0) > MAXIMUM_REFERENCE_TOTAL_BYTES) {
      throw new Error("Image references must be distinct and within the total size limit.");
    }
    const assertCurrent = (): void => {
      assertOwner();
      for (const record of records) {
        const current = this.#store.findArtifact(record.blob.id);
        if (current === undefined || current.revision !== record.revision) throw imageEditInputUnavailable();
        if (isRecord(current.metadata) && typeof current.metadata["expiresAt"] === "number"
          && current.metadata["expiresAt"] <= Date.now()) throw imageEditInputUnavailable();
      }
    };
    const images: ImageEditReference[] = [];
    for (const record of records) {
      context.assertCurrent?.();
      assertCurrent();
      const image = await this.#artifacts.readBlob(record.blob);
      const mimeType = sniffImageMime(image.data);
      if (mimeType !== record.blob.mimeType || !supportedEditMime(mimeType)) {
        throw new Error("An image reference has an unsupported format.");
      }
      images.push({ blob: record.blob, file: new Blob([Uint8Array.from(image.data)], { type: mimeType }), extension: extensionForMime(mimeType) });
    }
    context.assertCurrent?.();
    assertCurrent();
    return { images, assertCurrent };
  }

  #claimImageEffect(route: ImageGenerationRoute, context: BridgeToolCallContext, references: readonly ImageEditReference[] | undefined) {
    const { requestIdentity, requestBodyHash } = context;
    if (requestIdentity === undefined || requestBodyHash === undefined) throw new Error("Image request identity is unavailable.");
    const operationId = `mcp-image:${requestIdentity}`;
    const { backend, provider, surface, credential } = route.owner;
    try {
      return this.#store.claimDeferredEffectOperation<BlobRef>({ id: operationId,
        kind: references === undefined ? "mcp_image_generate" : "mcp_image_edit", body: {
        requestBodyHash, sessionId: context.sessionId, targetId: context.targetId, generation: context.generation,
        backendId: backend.id, backendGeneration: backend.instanceGeneration, providerId: provider.providerId,
        surfaceId: surface.surfaceId, executionApi: surface.executionApi, modelId: route.modelId,
        credentialReferenceId: route.owner.credentialReferenceId, credentialGeneration: credential.generation,
        ...(references === undefined ? {} : { referenceImages: references.map(({ blob }) => ({ id: blob.id, sha256: blob.sha256 })) })
      } });
    } catch (error) {
      if (error instanceof OperationInProgressError) throw imageSubmissionFailure(operationId, false);
      if (error instanceof OperationPreviouslyFailedError) {
        throw imageSubmissionFailure(operationId, isRecord(error.storedError) && error.storedError["code"] === "IMAGE_SUBMISSION_REJECTED");
      }
      throw error;
    }
  }

  #refreshSnapshot(): void {
    const next = this.#readSnapshot();
    if (this.#signature !== undefined && next.signature !== this.#signature) this.#generation += 1;
    this.#signature = next.signature;
    this.#routes = next.routes;
  }

  #readSnapshot(): ImageGenerationSnapshot {
    const owners = [
      ...this.#credentialSurfaces.listConfigured({ capability: "image_generation", executionApi: "openai-images" }),
      ...this.#credentialSurfaces.listConfigured({ capability: "image_generation", executionApi: "gemini-images" })
    ];
    if (owners.length > 64 || owners.some((owner) => owner.surface.models.length > 64)) {
      return { signature: "catalog-limit", routes: [] };
    }
    const candidates = owners.flatMap((owner) => owner.surface.models.flatMap((model) => {
      if (!boundedIdentifier(model.modelId, 256)
        || !boundedDisplayName(model.displayName, 512)
        || !this.#credentialSurfaces.modelEnabled(owner, model.modelId)) return [];
      const route = { owner, modelId: model.modelId, displayName: model.displayName };
      return owner.surface.executionApi === "gemini-images" && !isGeminiImageRoute(route) ? [] : [route];
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

  async #dispatch(input: ImageDispatchInput): Promise<{ readonly bytes: Uint8Array; readonly mimeType: SupportedImageMime }> {
    switch (input.executionApi) {
      case "openai-images":
        return await this.#dispatchOpenAiImages(input);
      case "gemini-images":
        return await this.#dispatchGeminiImages(input);
      default:
        throw new Error("Image generation execution protocol is unsupported.");
    }
  }

  async #dispatchOpenAiImages(input: ImageDispatchInput) {
    const endpoint = input.references === undefined ? OPENAI_IMAGES_GENERATION_ENDPOINT : OPENAI_IMAGES_EDIT_ENDPOINT;
    const options = {
      model: input.model, prompt: input.prompt, n: 1, size: input.size ?? "auto",
      ...(input.quality === undefined ? {} : { quality: input.quality })
    };
    let body: string | FormData;
    if (input.references === undefined) body = JSON.stringify(options);
    else {
      const form = new FormData();
      for (const [key, value] of Object.entries(options)) form.set(key, String(value));
      input.references.forEach(({ file, extension }, index) => form.append("image[]", file, `reference-${index + 1}${extension}`));
      body = form;
    }
    return this.#requestImage(input, endpoint, {
      authorization: `Bearer ${input.apiKey}`,
      ...(typeof body === "string" ? { "content-type": "application/json" } : {})
    }, body);
  }

  async #dispatchGeminiImages(input: ImageDispatchInput) {
    const parts: Record<string, unknown>[] = [{ text: input.prompt }];
    for (const reference of input.references ?? []) {
      input.signal?.throwIfAborted();
      const data = Buffer.from(await reference.file.arrayBuffer()).toString("base64");
      parts.push({ inlineData: { mimeType: reference.file.type, data } });
    }
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(input.aspectRatio === undefined && input.resolution === undefined ? {} : { imageConfig: {
          ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
          ...(input.resolution === undefined ? {} : { imageSize: input.resolution })
        } })
      }
    });
    if (Buffer.byteLength(body, "utf8") > 20_000_000) throw new Error("Gemini inline image input exceeds its request size limit.");
    const endpoint = `${GEMINI_IMAGES_BASE}${encodeURIComponent(input.model.slice("gemini/".length))}:generateContent`;
    return this.#requestImage(input, endpoint, { "x-goog-api-key": input.apiKey, "content-type": "application/json" }, body);
  }

  async #requestImage(input: ImageDispatchInput, endpoint: string, headers: Record<string, string>, body: string | FormData) {
    const requestSignal = boundedSignal(input.signal, IMAGE_GENERATION_TIMEOUT_MS);
    let response: Response;
    let dispatchGuardFailure: { readonly error: unknown } | undefined;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          ...headers
        },
        body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: requestSignal.signal
      }, () => {
        try {
          requestSignal.signal.throwIfAborted();
          input.beforeDispatch();
        } catch (error) {
          dispatchGuardFailure = { error };
          throw error;
        }
      });
    } catch {
      requestSignal.dispose();
      if (dispatchGuardFailure !== undefined) throw dispatchGuardFailure.error;
      throw new Error("Image generation request did not complete.");
    }
    try {
      if (response.redirected
        || (response.url !== "" && response.url !== endpoint)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Image generation response was redirected.");
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        if ([400, 401, 403, 404, 413, 415, 422, 429].includes(response.status)) throw new ImageProviderRejection();
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
      const encoded: { readonly base64: string; readonly mimeType?: string } = input.executionApi === "gemini-images"
        ? geminiImageData(parsed) : { base64: imageBase64(parsed) };
      const bytes = decodeCanonicalBase64(encoded.base64, this.#artifacts.maximumBlobBytes);
      const mimeType = sniffImageMime(bytes);
      if (mimeType === undefined || encoded.mimeType !== undefined && encoded.mimeType !== mimeType) {
        throw new Error("Image generation returned an unsupported image format.");
      }
      return { bytes, mimeType };
    } finally {
      requestSignal.dispose();
    }
  }
}

class ImageProviderRejection extends Error {}

class ReplayedImageEffect extends Error {
  constructor(readonly blob: BlobRef) { super("The original image result was already saved."); }
}

function imageSubmissionFailure(operationId: string, rejected: boolean): JokoError {
  return new JokoError({
    code: rejected ? "IMAGE_SUBMISSION_REJECTED" : "IMAGE_SUBMISSION_OUTCOME_UNKNOWN",
    message: rejected ? `The image Provider rejected request ${operationId}.`
      : `Image request ${operationId} is still in progress or its result is unconfirmed. Check the original request before submitting a new one.`,
    phase: "image_generation",
    retryable: false,
    stateMayHaveChanged: !rejected,
    recovery: rejected ? "Correct the request or Provider settings before starting a new generation."
      : "Query the original request. Reusing its identity will not send another generation."
  });
}

function imageResult(blob: BlobRef, model: string, editing: boolean): BridgeToolCallResult {
  const status = editing ? "Image edited successfully." : "Image generated successfully.";
  return {
    content: [{ type: "text", text: `${status} Image reference ${blob.id}.` }],
    structuredContent: {
      ...(editing ? { edited: true } : { generated: true }),
      model,
      mimeType: blob.mimeType,
      byteLength: blob.byteLength
    },
    isError: false,
    hostImages: [{ blob }]
  };
}

function describeImageTool(name: ImageToolName, routes: readonly ImageGenerationRoute[]): McpToolDescriptor {
  const editing = name === IMAGE_EDIT_TOOL_NAME;
  const multipleRoutes = routes.length > 1;
  const exactOptions = routes.some(isGptImage2Route);
  const geminiOptions = routes.some(isGeminiImageRoute);
  return {
    serverId: IMAGE_GENERATION_BRIDGE_TOOL_PROVIDER_ID,
    name,
    runtimeName: name,
    description: editing
      ? "Edit images from the current owner prompt or use exact image Artifact IDs from this task."
      : "Generate an image with the configured image model. Use a clear, complete visual prompt and supported output options.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string", minLength: 1,
          description: editing ? "A complete description of the image edits." : "A complete description of the image to generate."
        },
        aspect_ratio: { type: "string", enum: geminiOptions ? [...GEMINI_FLASH_ASPECT_RATIOS] : [...ASPECT_RATIOS], description: "Optional output aspect ratio supported by the selected model." },
        ...(editing ? { image: {
          type: "array", minItems: 1, maxItems: MAXIMUM_REFERENCE_IMAGES,
          items: { type: "string", minLength: 1, maxLength: 512 },
          description: "Use input:1, input:2, and so on for images attached to this prompt, or pass an exact image Artifact ID from this task."
        } } : {}),
        ...(exactOptions ? {
          size: {
            type: "string",
            description: "GPT Image 2 exact WIDTHxHEIGHT or auto. Each edge must be divisible by 16 and at most 3840, with a ratio up to 3:1 and 655360–8294400 pixels."
          },
          quality: { type: "string", enum: [...EXACT_IMAGE_QUALITIES], description: "Optional GPT Image 2 quality." }
        } : {}),
        ...(geminiOptions ? { resolution: {
          type: "string", enum: [...GEMINI_RESOLUTIONS],
          description: "Optional Gemini output resolution. Only Gemini 3.1 Flash Image supports 512."
        } } : {}),
        ...(multipleRoutes ? {
          model: { type: "string", enum: routes.map(route => route.modelId), description: "The configured image model to use." }
        } : {})
      },
      required: ["prompt", ...(editing ? ["image"] : []), ...(multipleRoutes ? ["model"] : [])],
      additionalProperties: false
    },
    requiresPermission: true,
    ...(editing ? { requiresNativeRoot: true } : {})
  };
}

function imageEditInputUnavailable(): Error {
  return new Error("The original image reference is unavailable in this task.");
}

function supportedEditMime(value: string | undefined): value is Exclude<SupportedImageMime, "image/gif"> {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
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

function isGptImage2Route(route: ImageGenerationRoute): boolean {
  return route.owner.surface.executionApi === "openai-images" && route.modelId === "gpt-image-2";
}

function isGeminiImageRoute(route: ImageGenerationRoute): boolean {
  return route.owner.surface.executionApi === "gemini-images"
    && (route.modelId === GEMINI_FLASH_MODEL || route.modelId === GEMINI_PRO_MODEL);
}

function optionalGeminiAspectRatio(value: unknown, model: string): string | undefined {
  if (value === undefined) return undefined;
  const ratios: readonly string[] = model === GEMINI_FLASH_MODEL ? GEMINI_FLASH_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
  if (typeof value !== "string" || !ratios.includes(value)) throw new Error("The selected Gemini image model does not support this aspect ratio.");
  return value;
}

function optionalGeminiResolution(value: unknown, model: string): string | undefined {
  if (value === undefined) return undefined;
  const resolution = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!(GEMINI_RESOLUTIONS as readonly string[]).includes(resolution) || resolution === "512" && model !== GEMINI_FLASH_MODEL) {
    throw new Error("The selected Gemini image model does not support this resolution.");
  }
  return resolution;
}

function geminiImageData(value: unknown): { readonly base64: string; readonly mimeType?: string } {
  if (!isRecord(value)) throw new Error("Gemini image response is invalid.");
  if (isRecord(value["promptFeedback"]) && value["promptFeedback"]["blockReason"]) throw new ImageProviderRejection();
  const candidate = Array.isArray(value["candidates"]) ? value["candidates"][0] : undefined;
  const content = isRecord(candidate) && isRecord(candidate["content"]) ? candidate["content"] : undefined;
  const parts: unknown[] = content !== undefined && Array.isArray(content["parts"]) ? content["parts"] : [];
  const image = parts.find(part => isRecord(part) && part["thought"] !== true
    && isRecord(part["inlineData"]) && typeof part["inlineData"]["data"] === "string");
  if (!isRecord(image) || !isRecord(image["inlineData"])) throw new Error("Gemini image response contains no image.");
  const data = image["inlineData"];
  if (typeof data["data"] !== "string" || typeof data["mimeType"] !== "string") throw new Error("Gemini image data is invalid.");
  return { base64: data["data"], mimeType: data["mimeType"] };
}

function imageSize(value: unknown, aspectRatio: ImageAspectRatio | undefined): string {
  const size = typeof value === "string" && value.length <= 100 ? value.trim().toLowerCase().replace("×", "x") : undefined;
  if (value === undefined || size === "auto") return aspectRatio === undefined ? "auto" : sizeForAspectRatio(aspectRatio);
  const match = /^(\d{1,6})x(\d{1,6})$/u.exec(size ?? "");
  if (match === null) throw new Error("Image size must be auto or WIDTHxHEIGHT.");
  const width = Number(match[1]), height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0 || Math.max(width, height) > 3840 ||
    Math.max(width, height) > 3 * Math.min(width, height) || pixels < 655_360 || pixels > 8_294_400) {
    throw new Error("Image size is outside GPT Image 2's supported dimensions.");
  }
  if (aspectRatio !== undefined) {
    const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
    if (Math.abs(width / height - aspectWidth! / aspectHeight!) > 0.001) {
      throw new Error("Image size and aspect ratio conflict. Use size alone for exact dimensions.");
    }
  }
  return `${width}x${height}`;
}

function optionalImageQuality(value: unknown): ImageQuality | undefined {
  if (value === undefined) return undefined;
  const quality = typeof value === "string" ? value.trim() : undefined;
  const supported = EXACT_IMAGE_QUALITIES.find(candidate => candidate === quality);
  if (supported === undefined) throw new Error("Image quality must be auto, low, medium, or high.");
  return supported;
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
