import { randomUUID } from "node:crypto";
import type { BlobRef } from "@joko/core";
import { OperationInProgressError, OperationPreviouslyFailedError, TaskShareStore, type OperationalStore, type QueueItemRecord } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { ProviderCatalogManager, ProviderInferenceRoute } from "./credential-manager.js";
import type { BridgeToolCallContext, BridgeToolCallResult, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import { PinnedHttpsAudioResultDownloader } from "./mcp-audio-result-mapping.js";
import type { SessionHost } from "./session-host.js";
import {
  parseVideoGenerationInput, pollVideoGeneration, submitVideoGeneration, VideoGenerationRejected,
  VIDEO_GENERATION_ASPECT_RATIOS, VIDEO_GENERATION_DURATIONS, VIDEO_GENERATION_RESOLUTIONS
} from "./video-generation-protocol.js";

const providerId = "joko-video-generation";
const generateTool = "video_generate";
const statusTool = "video_status";
const purpose = { purpose: "xai_video" } as const;
const operationKind = "mcp_video_generation";
const receiptPattern = /^mcp-video:[a-f0-9]{64}$/u;
const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

interface VideoRoute {
  readonly key: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly generationId: string;
  readonly supportsImages: boolean;
}

interface VideoOperationOwner {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
}

interface VideoOperationBody extends VideoOperationOwner {
  readonly requestBodyHash: string;
  readonly route: VideoRoute;
}

interface VideoCaller {
  readonly identity: VideoOperationOwner;
  readonly queue: QueueItemRecord;
  readonly assertCurrent: () => void;
}

interface VideoReceipt {
  readonly requestId: string;
}

type VideoFetch = (url: URL, init: RequestInit, beforeDispatch: () => void) => Promise<Response>;

export class VideoGenerationBridgeToolProvider implements BridgeToolProvider {
  readonly id = providerId;
  #generation = 1;
  #signature = "";
  #routes: readonly VideoRoute[] = [];
  readonly #activePolls = new Set<string>();
  readonly #downloadPublicResult = new PinnedHttpsAudioResultDownloader().download;

  constructor(readonly options: {
    readonly store: OperationalStore;
    readonly providers: ProviderCatalogManager;
    readonly artifacts: Pick<ArtifactStore, "readBlob" | "ingestBytes" | "maximumBlobBytes">;
    readonly fetch: VideoFetch;
    readonly approveDownload: SessionHost["requestOwnerToolApproval"];
  }) {}

  get generation(): number { this.#refresh(); return this.#generation; }
  get available(): boolean { this.#refresh(); return this.#routes.length > 0; }

  get tools(): readonly McpToolDescriptor[] {
    if (!this.available) return [];
    return [{
      serverId: this.id, name: generateTool, runtimeName: generateTool, requiresPermission: true, requiresNativeRoot: true,
      description: "Submit a single video generation request using an explicitly configured video model. Use video_status with the returned receipt to check this request.",
      inputSchema: { type: "object", additionalProperties: false, required: ["model", "prompt"], properties: {
        model: { type: "string", enum: this.#routes.map(route => route.key) },
        prompt: { type: "string", minLength: 1 },
        duration: { type: "integer", ...VIDEO_GENERATION_DURATIONS },
        resolution: { type: "string", enum: VIDEO_GENERATION_RESOLUTIONS },
        aspect_ratio: { type: "string", enum: VIDEO_GENERATION_ASPECT_RATIOS },
        ...(this.#routes.some(route => route.supportsImages) ? {
          image_blob_id: { type: "string", description: "A single image attached to the active user message." }
        } : {})
      } }
    }, {
      serverId: this.id, name: statusTool, runtimeName: statusTool, requiresPermission: false,
      description: "Check the original video generation and retrieve the finished video. Check again if pending or if the download was interrupted.",
      inputSchema: { type: "object", additionalProperties: false, required: ["receipt"], properties: { receipt: { type: "string" } } }
    }];
  }

  includeForTarget(targetId: string): boolean {
    try { const target = this.options.store.getTarget(targetId).descriptor; return target.trusted && target.remoteWorkspace === undefined; }
    catch { return false; }
  }

  async callTool(name: string, value: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<BridgeToolCallResult> {
    this.#refresh();
    if (context.providerGeneration !== undefined && context.providerGeneration !== this.#generation) throw new Error("The video model catalog changed.");
    const owner = this.#owner(context, signal);
    if (name === generateTool) return this.#generate(value, owner, context, signal);
    if (name === statusTool && Object.keys(value).length === 1 && typeof value["receipt"] === "string"
      && receiptPattern.test(value["receipt"])) return this.#status(value["receipt"], owner, signal);
    throw new Error("A video request receipt is required.");
  }

  #refresh(): void {
    const { store, providers } = this.options;
    const routes = store.listBackends().flatMap(({ descriptor }) => providers.listManaged(descriptor.id).flatMap(entry =>
      entry.provider.models.flatMap(model => {
        if (model.mode !== purpose.purpose) return [];
        const backendId = descriptor.id, providerId = entry.provider.id, modelId = model.id;
        const identity = providers.describeInferenceRoute(backendId, providerId, modelId, purpose);
        if (identity === undefined) return [];
        return [{ key: `${backendId}/${providerId}/${modelId}`, backendId, providerId, modelId,
          generationId: identity.generationId, supportsImages: model.input?.includes("image") === true }];
      })));
    const counts = new Map<string, number>();
    for (const route of routes) counts.set(route.key, (counts.get(route.key) ?? 0) + 1);
    const unique = routes.filter(route => counts.get(route.key) === 1).sort((left, right) => left.key.localeCompare(right.key, "en"));
    const next = JSON.stringify(unique);
    if (next !== this.#signature) { this.#signature = next; this.#routes = unique; this.#generation++; }
  }

  #owner(context: BridgeToolCallContext, signal?: AbortSignal): VideoCaller {
    const { store } = this.options;
    const source = context.inputQueueItem;
    const assertBridgeCurrent = context.assertCurrent;
    if (context.localProductScope !== true || source === undefined || assertBridgeCurrent === undefined) {
      throw new Error("The original video request owner is unavailable.");
    }
    const queue = store.getQueueItem(source.id);
    const operation = store.getOperation(queue.operationId);
    if (operation.connectionId === undefined || operation.status !== "completed"
      || !["sendInput", "send_input"].includes(operation.kind)
      || new TaskShareStore(store).getAuthorForOperation(operation.id) !== undefined) throw new Error("The original video request owner is unavailable.");
    const connection = store.getConnection(operation.connectionId);
    const target = store.getTarget(context.targetId);
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertBridgeCurrent();
      store.authorizeConnection(connection.id, connection.authKeyDigest);
      const session = store.getSession(context.sessionId).descriptor;
      const current = store.getQueueItem(queue.id);
      const run = store.getRun(source.runId).descriptor;
      if (session.deletedAt !== undefined || session.archived || session.hidden || session.automationOrigin !== undefined
        || session.derivationOrigin?.sideChat || run.source !== "user" || run.parentRunId !== undefined || run.activeAttemptId !== source.attemptId
        || session.targetId !== target.descriptor.id || session.binding.generation !== context.generation
        || store.getTarget(context.targetId).revision !== target.revision || !this.includeForTarget(context.targetId)
        || session.remoteWorkspace !== undefined || current.bodyHash !== queue.bodyHash
        || current.sessionId !== session.id || current.runId !== source.runId || current.attemptId !== source.attemptId
        || current.body.messagingOrigin || current.body.automaticContinuation || current.body.objectiveContinuation
        || current.body.inputHandoffContinuation || current.disposition !== "prompt"
        || !["dispatching", "backend_accepted"].includes(current.state)) {
        throw new Error("The original video request owner changed.");
      }
    };
    assertCurrent();
    const identity = { connectionId: connection.id, sessionId: context.sessionId, targetId: context.targetId, generation: context.generation };
    return { identity, queue, assertCurrent };
  }

  #resolve(route: VideoRoute): ProviderInferenceRoute {
    const current = this.options.providers.resolveInferenceRoute(route.backendId, route.providerId, route.modelId, purpose);
    if (current?.generationId !== route.generationId) throw new Error("The original video model connection is unavailable.");
    return current;
  }

  async #generate(value: Readonly<Record<string, unknown>>, owner: VideoCaller,
    context: BridgeToolCallContext, signal?: AbortSignal): Promise<BridgeToolCallResult> {
    const allowed = new Set(["model", "prompt", "duration", "resolution", "aspect_ratio", "image_blob_id"]);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("The video request contains an unsupported field.");
    const route = this.#routes.find(candidate => candidate.key === value["model"]);
    const receipt = `mcp-video:${context.requestIdentity ?? ""}`;
    const requestBodyHash = context.requestBodyHash;
    if (route === undefined || !receiptPattern.test(receipt) || requestBodyHash === undefined) {
      throw new Error("The selected video request is unavailable.");
    }
    if (owner.queue.executionOverrides?.planMode ?? this.options.store.getSession(context.sessionId).descriptor.planMode) {
      throw new Error("Video generation requires an ordinary execution turn.");
    }
    const options = parseVideoGenerationInput(value);
    const assertCurrent = () => {
      owner.assertCurrent();
      if (this.options.providers.describeInferenceRoute(route.backendId, route.providerId, route.modelId, purpose)?.generationId !== route.generationId) {
        throw new Error("The original video model connection changed.");
      }
    };
    const imageUrl = value["image_blob_id"] === undefined ? undefined : await this.#imageUrl(value["image_blob_id"], route, owner);
    const { store, fetch } = this.options;
    const connection = this.#resolve(route);
    let operation: { readonly id: string; readonly bodyHash: string } | undefined;
    let replayed = false;
    try {
      const requestId = await submitVideoGeneration({
        modelId: route.modelId, options, connection: videoConnection(connection), fetch,
        ...(imageUrl === undefined ? {} : { imageUrl }), ...(signal === undefined ? {} : { signal }),
        beforeDispatch: () => {
          assertCurrent();
          const body: VideoOperationBody = { ...owner.identity, requestBodyHash, route };
          const claim = store.claimDeferredEffectOperation<VideoReceipt>({ id: receipt, kind: operationKind, body });
          if (!claim.claimed) { replayed = true; throw new Error("The original video request is already recorded."); }
          operation = claim.operation;
        }
      });
      if (operation === undefined) throw new Error("The original video submission was not captured.");
      assertCurrent();
      store.completeDeferredEffectOperation(operation.id, operation.bodyHash, () => ({ requestId }));
      return videoResult(receipt, "pending");
    } catch (error) {
      if (replayed) return videoResult(receipt, "pending");
      if (error instanceof OperationInProgressError) return videoResult(receipt, "submission_unknown");
      if (error instanceof OperationPreviouslyFailedError) {
        return videoResult(receipt, submissionStatus(error.storedError));
      }
      if (operation === undefined) throw error;
      const rejected = error instanceof VideoGenerationRejected;
      const code = rejected ? "VIDEO_SUBMISSION_REJECTED" : "VIDEO_SUBMISSION_UNKNOWN";
      try { store.failEffectOperation(operation.id, operation.bodyHash, { code, message: rejected
        ? "The provider rejected the video request." : "The video provider may have accepted the original request.",
        retryable: false, phase: "dispatch", stateMayHaveChanged: !rejected }); } catch { /* The original claim remains recoverable. */ }
      owner.assertCurrent();
      return videoResult(receipt, rejected ? "failed" : "submission_unknown");
    }
  }

  async #imageUrl(value: unknown, route: VideoRoute, owner: VideoCaller): Promise<string> {
    const blob = owner.queue.body.images.find(image => image.blob.id === value)?.blob;
    if (!route.supportsImages || blob === undefined || blob.byteLength > 24 * 1024 * 1024 || !imageMimeTypes.has(blob.mimeType)) {
      throw new Error("Select one supported image from the active user message.");
    }
    const { data, mimeType } = await this.options.artifacts.readBlob(blob);
    owner.assertCurrent();
    if (mimeType !== blob.mimeType || data.byteLength !== blob.byteLength) throw new Error("The selected image changed.");
    return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
  }

  async #status(receipt: string, owner: VideoCaller, signal?: AbortSignal): Promise<BridgeToolCallResult> {
    const { store } = this.options;
    const operation = store.findOperation<VideoReceipt>(receipt);
    const claimed = operation?.body as VideoOperationBody | undefined;
    // A new Owner turn can inspect the persisted receipt after a cold runtime rebind.
    // Its own queue, target, connection and current generation still fence every effect.
    if (operation?.kind !== operationKind || claimed === undefined || claimed.connectionId !== owner.identity.connectionId
      || claimed.sessionId !== owner.identity.sessionId || claimed.targetId !== owner.identity.targetId
      || claimed.generation > owner.identity.generation) throw new Error("The video receipt is unavailable for this task.");
    if (operation.status === "failed") return videoResult(receipt, submissionStatus(operation.error));
    if (operation.status !== "completed" || operation.response === undefined) return videoResult(receipt, "submission_unknown");
    const cached = store.findSetting("session", owner.identity.sessionId, receipt)?.value;
    const existing = typeof cached === "string" ? store.findArtifact(cached) : undefined;
    if (existing !== undefined) return videoResult(receipt, "done", existing.blob);
    if (this.#activePolls.has(receipt)) return videoResult(receipt, "poll_in_progress");
    this.#activePolls.add(receipt);
    try { return await this.#poll(receipt, claimed.route, operation.response.requestId, owner, signal); }
    finally { this.#activePolls.delete(receipt); }
  }

  async #poll(receipt: string, route: VideoRoute, requestId: string, owner: VideoCaller, signal?: AbortSignal): Promise<BridgeToolCallResult> {
    const { store, fetch, artifacts } = this.options;
    const connection = this.#resolve(route);
    const assertCurrent = () => {
      owner.assertCurrent();
      if (this.options.providers.describeInferenceRoute(route.backendId, route.providerId,
        route.modelId, purpose)?.generationId !== connection.generationId) throw new Error("The original video connection changed.");
    };
    const status = await pollVideoGeneration({ connection: videoConnection(connection), requestId,
      fetch, ...(signal === undefined ? {} : { signal }), beforeDispatch: assertCurrent });
    assertCurrent();
    if (status.state !== "done") return videoResult(receipt, status.state);
    const resultUrl = status.contentUrl;
    try {
      let bytes: Uint8Array;
      if (resultUrl.origin === new URL(connection.baseUrl).origin) {
        const timeout = AbortSignal.timeout(120_000);
        const response = await fetch(resultUrl, { method: "GET", redirect: "error", credentials: "omit",
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) }, assertCurrent);
        bytes = await readVideoBytes(response, artifacts.maximumBlobBytes, assertCurrent);
      } else {
        if (resultUrl.protocol !== "https:" || resultUrl.port !== "") return videoResult(receipt, "download_unavailable");
        if (resultUrl.origin !== "https://vidgen.x.ai" && !await this.options.approveDownload({
          id: `video-download-${randomUUID()}`, connectionId: owner.identity.connectionId,
          generation: owner.identity.generation, queueId: owner.queue.id, assertCurrent,
          title: "Download the generated video?", tool: "Video generation",
          summary: `The provider returned the original video at ${resultUrl.hostname}. The download may follow redirects to subdomains of that host.`
        }, signal)) return videoResult(receipt, "download_unavailable");
        bytes = await this.#downloadPublicResult({ url: resultUrl.href, allowedHosts: [resultUrl.hostname],
          maximumBytes: artifacts.maximumBlobBytes, guard: assertCurrent, ...(signal === undefined ? {} : { signal }) });
      }
      if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp") {
        throw new Error("The video provider did not return an MP4 artifact.");
      }
      const blob = await artifacts.ingestBytes(bytes, { fileName: "generated-video.mp4", mimeType: "video/mp4", assertCurrent });
      assertCurrent();
      store.setSetting("session", owner.identity.sessionId, receipt, blob.id);
      return videoResult(receipt, "done", store.getArtifact(blob.id).blob);
    } catch {
      assertCurrent();
      return videoResult(receipt, "download_unavailable");
    }
  }
}

function videoConnection(route: ProviderInferenceRoute) {
  return { baseUrl: route.baseUrl, headers: { ...route.headers,
    ...(route.authorization === undefined ? {} : { authorization: route.authorization }) } };
}

function submissionStatus(error: unknown): "failed" | "submission_unknown" {
  return (error as { code?: unknown } | undefined)?.code === "VIDEO_SUBMISSION_REJECTED" ? "failed" : "submission_unknown";
}

function videoResult(receipt: string, status: string, blob?: BlobRef): BridgeToolCallResult {
  const value = { receipt, status, ...(blob === undefined ? {} : { blobId: blob.id }) };
  return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
    ...(blob === undefined ? {} : { hostArtifacts: [{ blob, label: "Generated video" }] }) };
}

async function readVideoBytes(response: Response, limit: number, assertCurrent: () => void): Promise<Uint8Array> {
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!response.ok || response.body === null || Number(response.headers.get("content-length")) > limit
    || (mimeType !== "video/mp4" && mimeType !== "application/octet-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The video download is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      assertCurrent();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw new Error("The video exceeds its artifact size limit.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
