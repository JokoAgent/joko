import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { BlobRef, ImageInput } from "@joko/core";
import type { OperationalStore, PersistedEvent } from "@joko/store";

import type { ProviderCatalogManager, ProviderInferenceRoute } from "./credential-manager.js";

const VISION_REQUEST_TIMEOUT_MS = 30_000;
const INFERENCE_RESPONSE_LIMIT = 1024 * 1024;
const VISION_CACHE_LIMIT = 128;
const VISION_TOOL_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const VISION_DESCRIPTION_LIMIT = 32 * 1024;
const PREDICTION_CACHE_LIMIT = 64;
const SESSION_EVENT_SCAN_PAGE_SIZE = 10_000;
const PREDICTION_CACHE_TTL_MS = 5 * 60_000;
const IMAGE_UNAVAILABLE_TEXT =
  "[Image unavailable / 图片不可用: Vision Bridge could not analyze this image. Do not infer or invent its contents; tell the user the image could not be inspected.]";
const DEFAULT_VISION_PROMPT =
  "Describe this image precisely for a coding agent. Include visible text, UI state, layout, errors, and details relevant to the user's request. Do not guess hidden content.";

const MANAGED_PROVIDER_CATALOG_CAPABILITY = "provider.managed_catalog";

export interface ModelRouteRef {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelRouteDescriptor extends ModelRouteRef {
  readonly supportsImages: boolean;
  readonly credentialRoute: boolean;
}

export interface CredentialModelRoute extends ProviderInferenceRoute {
  readonly backendId: string;
}

export interface ModelRouteCatalog {
  list(): readonly ModelRouteDescriptor[];
  resolve(
    reference: ModelRouteRef,
    options?: { readonly requireImages?: boolean }
  ): CredentialModelRoute | undefined;
}

export function createModelRouteCatalog(
  store: OperationalStore,
  providers: Pick<ProviderCatalogManager, "hasInferenceModel" | "resolveInferenceRoute">
): ModelRouteCatalog {
  const list = (): readonly ModelRouteDescriptor[] => store.listBackends().flatMap((record) => {
    const managedCatalog = record.descriptor.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported === true;
    return record.descriptor.models.map((model) => ({
      backendId: record.descriptor.id,
      providerId: model.providerId,
      modelId: model.modelId,
      supportsImages: model.supportsImages,
      credentialRoute: managedCatalog && providers.hasInferenceModel(model.providerId, model.modelId)
    }));
  }).sort(compareModelRoutes);
  return {
    list,
    resolve: (reference, options = {}) => {
      const descriptor = list().find((candidate) => sameModelRoute(candidate, reference));
      if (descriptor?.credentialRoute !== true || (options.requireImages === true && !descriptor.supportsImages)) return undefined;
      const route = providers.resolveInferenceRoute(reference.providerId, reference.modelId, options);
      return route === undefined ? undefined : { ...route, backendId: reference.backendId };
    }
  };
}

export interface StoredVisionBridgeSettings {
  readonly enabled?: boolean;
  readonly targetModels?: readonly ModelRouteRef[];
  readonly primary?: ModelRouteRef | null;
  readonly fallback?: ModelRouteRef | null;
}

export interface VisionBridgeState {
  readonly enabled: boolean;
  readonly targetModels: readonly ModelRouteRef[];
  readonly primary: ModelRouteRef | null;
  readonly fallback: ModelRouteRef | null;
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly customizedFields: readonly (keyof StoredVisionBridgeSettings)[];
}

export interface VisionBridgeTransformInput extends ModelRouteRef {
  readonly text: string;
  readonly images: readonly ImageInput[];
  readonly signal?: AbortSignal;
  /** Content-free UI progress hook. Invoked only after the current
   * Provider+Model is authoritatively selected for bridging. */
  readonly onStart?: (imageCount: number) => void | Promise<void>;
}

export interface VisionBridgeTransformResult {
  readonly descriptions: readonly string[];
  readonly usedFallback: boolean;
  readonly unavailableCount: number;
}

export interface VisionBridgeCoordinatorOptions {
  readonly store: OperationalStore;
  readonly routes: ModelRouteCatalog;
  readonly readBlob: (blob: BlobRef) => Promise<{ readonly data: Uint8Array; readonly mimeType?: string }>;
  readonly fetch?: typeof globalThis.fetch;
  /** Narrow-test override; production defaults to a 30 second budget. */
  readonly requestTimeoutMs?: number;
}

/**
 * Orchestrator-owned image-to-text bridge. Settings and public capability are
 * content-free; image bytes and Provider credentials only coexist in the
 * bounded request stack and never enter Events, diagnostics, or settings.
 */
export class VisionBridgeCoordinator {
  readonly #store: OperationalStore;
  readonly #routes: ModelRouteCatalog;
  readonly #readBlob: VisionBridgeCoordinatorOptions["readBlob"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #cache = new Map<string, string>();
  readonly #inferenceSlots = new AbortableSemaphore(2);
  readonly #requestTimeoutMs: number;

  constructor(options: VisionBridgeCoordinatorOptions) {
    this.#store = options.store;
    this.#routes = options.routes;
    this.#readBlob = options.readBlob;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? VISION_REQUEST_TIMEOUT_MS;
  }

  state(): VisionBridgeState {
    const stored = normalizeVisionBridgeSettings(this.#store.findSetting<unknown>(
      "service",
      "orchestrator",
      "settings.vision_bridge"
    )?.value);
    const defaults = this.#defaultTargets();
    const targetModels = stored.targetModels ?? defaults;
    const primary = stored.primary ?? null;
    const fallback = stored.fallback ?? null;
    const primaryRoute = primary === null
      ? undefined
      : this.#routes.resolve(primary, { requireImages: true });
    const available = primaryRoute !== undefined;
    const unavailableReason = available
      ? ""
      : primary === null
        ? "Select a primary multimodal Provider model before enabling Vision Bridge."
        : "The selected primary multimodal Provider route is not authenticated or available.";
    const customizedFields: (keyof StoredVisionBridgeSettings)[] = [];
    if ((stored.enabled ?? false) !== false) customizedFields.push("enabled");
    if (stored.targetModels !== undefined && !sameModelRoutes(stored.targetModels, defaults)) customizedFields.push("targetModels");
    if (stored.primary !== undefined && stored.primary !== null) customizedFields.push("primary");
    if (stored.fallback !== undefined && stored.fallback !== null) customizedFields.push("fallback");
    return {
      enabled: stored.enabled ?? false,
      targetModels,
      primary,
      fallback,
      available,
      unavailableReason,
      customizedFields
    };
  }

  async transform(input: VisionBridgeTransformInput): Promise<VisionBridgeTransformResult | undefined> {
    const state = this.state();
    if (
      !state.enabled ||
      input.images.length === 0 ||
      !state.targetModels.some((target) => sameModelRoute(target, input))
    ) return undefined;
    if (input.signal?.aborted) throw abortError();
    await input.onStart?.(input.images.length);
    if (input.signal?.aborted) throw abortError();
    const primary = state.primary === null
      ? undefined
      : this.#routes.resolve(state.primary, { requireImages: true });
    const fallback = state.fallback === null
      ? undefined
      : this.#routes.resolve(state.fallback, { requireImages: true });
    const distinctFallback = primary !== undefined && fallback !== undefined && state.primary !== null && state.fallback !== null &&
      modelRouteKey(state.primary) !== modelRouteKey(state.fallback)
      ? fallback
      : undefined;
    if (primary === undefined) {
      return {
        descriptions: input.images.map(() => IMAGE_UNAVAILABLE_TEXT),
        usedFallback: false,
        unavailableCount: input.images.length
      };
    }

    let usedFallback = false;
    let unavailableCount = 0;
    const descriptions = await mapWithConcurrency(input.images, 2, async (image, index) => {
      if (input.signal?.aborted) throw abortError();
      try {
        return await this.#describe(primary, image, input.text, input.signal);
      } catch (error) {
        if (isAbort(error, input.signal)) throw error;
        if (distinctFallback !== undefined) {
          try {
            const description = await this.#describe(distinctFallback, image, input.text, input.signal);
            usedFallback = true;
            return description;
          } catch (fallbackError) {
            if (isAbort(fallbackError, input.signal)) throw fallbackError;
          }
        }
        unavailableCount += 1;
        return `${IMAGE_UNAVAILABLE_TEXT} (image ${index + 1})`;
      }
    });
    return { descriptions, usedFallback, unavailableCount };
  }

  /** Layer-C Pi tool execution. The file and focus stay in this bounded call
   * stack; Orchestrator neither appends them to Events nor includes them in errors. */
  async describeFile(input: {
    readonly path: string;
    readonly focus: string;
    readonly allowedRoots: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (input.signal?.aborted) throw abortError();
    const state = this.state();
    if (!state.enabled || !state.available || state.primary === null) return IMAGE_UNAVAILABLE_TEXT;
    const imagePath = await resolveAllowedImagePath(input.path, input.allowedRoots);
    const metadata = await stat(imagePath);
    if (!metadata.isFile() || metadata.size > VISION_TOOL_MAX_IMAGE_BYTES) throw new InferenceFailure("IMAGE_UNAVAILABLE");
    const data = await readFile(imagePath);
    if (data.byteLength > VISION_TOOL_MAX_IMAGE_BYTES) throw new InferenceFailure("IMAGE_UNAVAILABLE");
    const mimeType = sniffImageMime(data);
    if (mimeType === undefined) throw new InferenceFailure("IMAGE_UNAVAILABLE");
    const identity = createHash("sha256").update(data).digest("hex");
    const primary = this.#routes.resolve(state.primary, { requireImages: true });
    const fallback = state.fallback === null
      ? undefined
      : this.#routes.resolve(state.fallback, { requireImages: true });
    const distinctFallback = primary !== undefined && fallback !== undefined && state.fallback !== null &&
      modelRouteKey(state.primary) !== modelRouteKey(state.fallback)
      ? fallback
      : undefined;
    if (primary === undefined) return IMAGE_UNAVAILABLE_TEXT;
    try {
      return await this.#describeBytes(primary, data, mimeType, identity, input.focus, input.signal);
    } catch (error) {
      if (isAbort(error, input.signal)) throw error;
      if (distinctFallback !== undefined) {
        try {
          return await this.#describeBytes(distinctFallback, data, mimeType, identity, input.focus, input.signal);
        } catch (fallbackError) {
          if (isAbort(fallbackError, input.signal)) throw fallbackError;
        }
      }
      return IMAGE_UNAVAILABLE_TEXT;
    }
  }

  async #describe(
    route: CredentialModelRoute,
    image: ImageInput,
    focus: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (image.blob.byteLength > VISION_TOOL_MAX_IMAGE_BYTES) throw new InferenceFailure("IMAGE_UNAVAILABLE");
    const resolved = await this.#readBlob(image.blob);
    if (resolved.data.byteLength > VISION_TOOL_MAX_IMAGE_BYTES) throw new InferenceFailure("IMAGE_UNAVAILABLE");
    if (resolved.data.byteLength !== image.blob.byteLength) throw new InferenceFailure("IMAGE_INTEGRITY_FAILED");
    // Blob media types are uploader-controlled metadata. Use the final
    // egress fence and derive the actual format from magic bytes instead.
    const mimeType = sniffImageMime(resolved.data);
    if (mimeType === undefined) throw new InferenceFailure("IMAGE_TYPE_UNSUPPORTED");
    return this.#describeBytes(route, resolved.data, mimeType, image.blob.sha256, focus, signal);
  }

  async #describeBytes(
    route: CredentialModelRoute,
    data: Uint8Array,
    mimeType: string,
    identity: string,
    focus: string,
    signal?: AbortSignal
  ): Promise<string> {
    const normalizedFocus = focus.trim().slice(0, 2_000);
    const cacheKey = `${route.backendId}\0${route.generationId}\0${identity}\0${normalizedFocus}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      return cached;
    }
    const imageData = Buffer.from(data).toString("base64");
    const prompt = normalizedFocus.length === 0
      ? DEFAULT_VISION_PROMPT
      : `${DEFAULT_VISION_PROMPT}\n\nUser focus: ${normalizedFocus}`;
    const description = await this.#inferenceSlots.run(signal, () => requestInference({
      fetch: this.#fetch,
      route,
      system: "You are a precise image description engine. Return only a factual description of visible content.",
      user: prompt,
      image: { mimeType, base64: imageData },
      maxTokens: 1024,
      signal,
      timeoutMs: this.#requestTimeoutMs
    }));
    const normalized = description.trim();
    if (normalized.length === 0) throw new InferenceFailure("EMPTY_RESPONSE");
    const bounded = normalized.length > VISION_DESCRIPTION_LIMIT
      ? `${normalized.slice(0, VISION_DESCRIPTION_LIMIT)}…[truncated]`
      : normalized;
    this.#cache.set(cacheKey, bounded);
    while (this.#cache.size > VISION_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return bounded;
  }

  #defaultTargets(): ModelRouteRef[] {
    return this.#routes.list()
      .filter((model) => !model.supportsImages)
      .map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId }));
  }
}

export interface PromptRecommendationState {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly unavailableReason: string;
}

export interface PromptPredictionServiceOptions {
  readonly store: OperationalStore;
  readonly routes: ModelRouteCatalog;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** Ephemeral, fenced next-prompt prediction. Conversation content is read
 * from Orchestrator's durable Events, not trusted from a renderer request. */
export class PromptPredictionService {
  readonly #store: OperationalStore;
  readonly #routes: ModelRouteCatalog;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly prompt: string; readonly expiresAt: number }>();
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(options: PromptPredictionServiceOptions) {
    this.#store = options.store;
    this.#routes = options.routes;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  state(): PromptRecommendationState {
    const enabled = normalizePromptRecommendationSettings(this.#store.findSetting<unknown>(
      "service",
      "orchestrator",
      "settings.prompt_recommendation"
    )?.value).enabled ?? true;
    const available = this.#routes.list().some((model) =>
      model.credentialRoute && this.#routes.resolve(model) !== undefined
    );
    return {
      enabled,
      available,
      unavailableReason: available ? "" : "No authenticated managed Provider route is available for prompt prediction."
    };
  }

  async predict(input: {
    readonly sessionId: string;
    readonly expectedLastActivityAt: number;
    readonly expectedGeneration: number;
    readonly locale: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const state = this.state();
    if (!state.enabled || !state.available || input.signal?.aborted) return "";
    const key = `${input.sessionId}\0${input.expectedLastActivityAt}\0${input.expectedGeneration}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.#now()) return cached.prompt;
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running;
    const prediction = this.#predict({ ...input, key }).finally(() => {
      if (this.#inFlight.get(key) === prediction) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, prediction);
    return prediction;
  }

  async #predict(input: {
    readonly sessionId: string;
    readonly expectedLastActivityAt: number;
    readonly expectedGeneration: number;
    readonly locale: string;
    readonly key: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const session = this.#eligibleSession(input);
    if (session === undefined || session.descriptor.providerId === undefined || session.descriptor.modelId === undefined) return "";
    const route = this.#routes.resolve({
      backendId: session.descriptor.backendId,
      providerId: session.descriptor.providerId,
      modelId: session.descriptor.modelId
    });
    if (route === undefined) return "";
    const context = conversationContext(recentConversationEvents(this.#store, input.sessionId));
    if (context.length === 0) return "";
    if (this.#eligibleSession(input) === undefined) return "";
    const system = [
      "You are a terse predictive text engine for a coding chat input.",
      "Return only the predicted next user message: no quotes, markdown, commentary, or multiple options.",
      "Keep it under 140 characters and make it actionable for a coding agent.",
      localeHint(input.locale)
    ].join("\n");
    const user = [
      "Predict the next message the user is likely to type.",
      "",
      "<recent_conversation>",
      escapeReferenceData(context),
      "</recent_conversation>",
      "",
      "Match the user's tone, brevity, phrasing, and terminology.",
      "Do not copy a prior message verbatim. Return exactly one concise prompt."
    ].join("\n");
    let raw: string;
    try {
      raw = await requestInference({
        fetch: this.#fetch,
        route,
        system,
        user,
        maxTokens: 96,
        signal: input.signal,
        timeoutMs: 20_000
      });
    } catch {
      return "";
    }
    if (this.#eligibleSession(input) === undefined) return "";
    const prompt = sanitizePrediction(raw);
    if (prompt.length === 0) return "";
    this.#cache.set(input.key, { prompt, expiresAt: this.#now() + PREDICTION_CACHE_TTL_MS });
    while (this.#cache.size > PREDICTION_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return prompt;
  }

  #eligibleSession(input: {
    readonly sessionId: string;
    readonly expectedLastActivityAt: number;
    readonly expectedGeneration: number;
  }): ReturnType<OperationalStore["getSession"]> | undefined {
    let session: ReturnType<OperationalStore["getSession"]>;
    try {
      session = this.#store.getSession(input.sessionId);
    } catch {
      return undefined;
    }
    if (
      session.descriptor.deletedAt !== undefined ||
      session.descriptor.binding.generation !== input.expectedGeneration ||
      session.descriptor.updatedAt !== input.expectedLastActivityAt ||
      this.#store.listRuns({ sessionId: input.sessionId, activeOnly: true, limit: 1 }).length > 0 ||
      this.#store.listQueueItems({
        sessionId: input.sessionId,
        states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
        limit: 1
      }).length > 0 ||
      this.#store.hasActiveSessionBackgroundTasks(input.sessionId)
    ) return undefined;
    const lastDone = latestSessionDoneEvent(this.#store, input.sessionId);
    return lastDone?.payload.type === "done" && lastDone.payload.outcome === "completed" ? session : undefined;
  }
}

function recentConversationEvents(store: OperationalStore, sessionId: string): PersistedEvent[] {
  const selected: PersistedEvent[] = [];
  let beforeCursor: bigint | undefined;
  while (selected.length < 6) {
    const page = store.listEvents({
      sessionId,
      order: "desc",
      ...(beforeCursor === undefined ? {} : { beforeCursor }),
      limit: SESSION_EVENT_SCAN_PAGE_SIZE
    });
    for (const event of page) {
      if (
        event.payload.type === "message_complete"
        && (event.payload.role === "user" || event.payload.role === "assistant")
        && event.payload.automaticContinuation === undefined
      ) selected.push(event);
      if (selected.length === 6) break;
    }
    if (selected.length === 6 || page.length < SESSION_EVENT_SCAN_PAGE_SIZE) break;
    beforeCursor = page.at(-1)?.globalCursor;
    if (beforeCursor === undefined) break;
  }
  return selected.reverse();
}

function latestSessionDoneEvent(store: OperationalStore, sessionId: string): PersistedEvent | undefined {
  let beforeCursor: bigint | undefined;
  while (true) {
    const page = store.listEvents({
      sessionId,
      order: "desc",
      ...(beforeCursor === undefined ? {} : { beforeCursor }),
      limit: SESSION_EVENT_SCAN_PAGE_SIZE
    });
    const done = page.find((event) => event.payload.type === "done");
    if (done !== undefined || page.length < SESSION_EVENT_SCAN_PAGE_SIZE) return done;
    beforeCursor = page.at(-1)?.globalCursor;
    if (beforeCursor === undefined) return undefined;
  }
}

export function normalizeVisionBridgeSettings(value: unknown): StoredVisionBridgeSettings {
  if (!isRecord(value)) return {};
  const result: {
    enabled?: boolean;
    targetModels?: readonly ModelRouteRef[];
    primary?: ModelRouteRef | null;
    fallback?: ModelRouteRef | null;
  } = {};
  if (typeof value["enabled"] === "boolean") result.enabled = value["enabled"];
  if (Array.isArray(value["targetModels"])) {
    result.targetModels = normalizeModelRouteRefs(value["targetModels"]);
  }
  if (value["primary"] === null) result.primary = null;
  else {
    const primary = normalizeModelRouteRef(value["primary"]);
    if (primary !== undefined) result.primary = primary;
  }
  if (value["fallback"] === null) result.fallback = null;
  else {
    const fallback = normalizeModelRouteRef(value["fallback"]);
    if (fallback !== undefined) result.fallback = fallback;
  }
  return result;
}

export function normalizePromptRecommendationSettings(value: unknown): { readonly enabled?: boolean } {
  return isRecord(value) && typeof value["enabled"] === "boolean" ? { enabled: value["enabled"] } : {};
}

function normalizeModelRouteRef(value: unknown): ModelRouteRef | undefined {
  if (!isRecord(value)) return undefined;
  const backendId = typeof value["backendId"] === "string" ? value["backendId"].trim() : "";
  const providerId = typeof value["providerId"] === "string" ? value["providerId"].trim() : "";
  const modelId = typeof value["modelId"] === "string" ? value["modelId"].trim() : "";
  return backendId.length === 0 || providerId.length === 0 || modelId.length === 0
    ? undefined
    : { backendId, providerId, modelId };
}

function normalizeModelRouteRefs(values: readonly unknown[]): ModelRouteRef[] {
  const result = new Map<string, ModelRouteRef>();
  for (const value of values) {
    const reference = normalizeModelRouteRef(value);
    if (reference === undefined) continue;
    result.set(modelRouteKey(reference), reference);
  }
  return [...result.values()].sort(compareModelRoutes);
}

function modelRouteKey(value: ModelRouteRef): string {
  return `${value.backendId}\0${value.providerId}\0${value.modelId}`;
}

function compareModelRoutes(left: ModelRouteRef, right: ModelRouteRef): number {
  return left.backendId.localeCompare(right.backendId, "en") ||
    left.providerId.localeCompare(right.providerId, "en") ||
    left.modelId.localeCompare(right.modelId, "en");
}

function sameModelRoute(left: ModelRouteRef, right: ModelRouteRef): boolean {
  return modelRouteKey(left) === modelRouteKey(right);
}

function sameModelRoutes(left: readonly ModelRouteRef[], right: readonly ModelRouteRef[]): boolean {
  return left.length === right.length && left.every((value, index) => modelRouteKey(value) === modelRouteKey(right[index]!));
}

async function resolveAllowedImagePath(value: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(value) || roots.length === 0) throw new InferenceFailure("IMAGE_UNAVAILABLE");
  let candidate: string;
  try {
    candidate = await realpath(resolve(value));
  } catch {
    throw new InferenceFailure("IMAGE_UNAVAILABLE");
  }
  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(resolve(root));
      const child = relative(canonicalRoot, candidate);
      if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return candidate;
    } catch {
      // A stale approved root does not widen access to another root.
    }
  }
  throw new InferenceFailure("IMAGE_UNAVAILABLE");
}

function sniffImageMime(data: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  if (data.byteLength < 12) return undefined;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return "image/webp";
  return undefined;
}

function conversationContext(events: readonly PersistedEvent[]): string {
  const messages = events.flatMap((event) => {
    if (
      event.payload.type !== "message_complete"
      || event.payload.automaticContinuation !== undefined
      || (event.payload.role !== "user" && event.payload.role !== "assistant")
    ) return [];
    const text = event.payload.blocks
      .filter((block): block is Extract<typeof block, { readonly kind: "text" }> => block.kind === "text")
      .map((block) => block.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (text.length === 0) return [];
    const maximum = event.payload.role === "user" ? 400 : 600;
    const clipped = text.length <= maximum
      ? text
      : event.payload.role === "assistant"
        ? `${text.slice(0, Math.floor(maximum * 0.4))} … ${text.slice(-Math.floor(maximum * 0.6))}`
        : text.slice(0, maximum);
    return [{ role: event.payload.role, text: clipped }];
  }).slice(-6);
  const context = messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n");
  return context.length <= 2_000 ? context : context.slice(-2_000);
}

function localeHint(locale: string): string {
  if (locale.toLowerCase().startsWith("zh")) return "Match the user's language. The user types in Chinese.";
  if (locale.toLowerCase().startsWith("ja")) return "Match the user's language. The user types in Japanese.";
  if (locale.toLowerCase().startsWith("ko")) return "Match the user's language. The user types in Korean.";
  return "Match the user's language and tone.";
}

function escapeReferenceData(value: string): string {
  return value.replace(/[&<>]/gu, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
}

function sanitizePrediction(value: string): string {
  const normalized = value.replace(/\r?\n[\s\S]*/u, "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").trim();
  if (normalized.length === 0 || /^(?:user|assistant|prompt)\s*:/iu.test(normalized) || /```|^#{1,6}\s/u.test(normalized)) return "";
  return [...normalized].slice(0, 140).join("").trim();
}

export interface ManagedTextInferenceInput {
  readonly route: ProviderInferenceRoute;
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Bounded Orchestrator-owned utility inference; Provider credentials stay in the request stack. */
export function requestManagedTextInference(input: ManagedTextInferenceInput): Promise<string> {
  if (
    input.system.length === 0 || input.system.length > 32 * 1024 ||
    input.user.length === 0 || input.user.length > 64 * 1024
  ) throw new RangeError("Managed text inference prompt is invalid.");
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 8_192) {
    throw new RangeError("Managed text inference output limit is invalid.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 5 * 60_000) {
    throw new RangeError("Managed text inference timeout is invalid.");
  }
  return requestInference({
    fetch: input.fetch ?? globalThis.fetch,
    route: input.route,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs: input.timeoutMs
  });
}

async function requestInference(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly route: ProviderInferenceRoute;
  readonly system: string;
  readonly user: string;
  readonly image?: { readonly mimeType: string; readonly base64: string };
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<string> {
  const endpoint = inferenceEndpoint(input.route.baseUrl, input.route.api);
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const body = inferenceBody(input);
  let response: Response;
  try {
    response = await input.fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        ...input.route.headers,
        "content-type": "application/json",
        accept: "application/json",
        ...(input.route.authorization === undefined ? {} : { authorization: input.route.authorization })
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    if (timeout.aborted) throw new InferenceFailure("TIMEOUT");
    throw new InferenceFailure("NETWORK_ERROR", { cause: error });
  }
  if (!response.ok) throw new InferenceFailure(`HTTP_${response.status}`);
  let text: string;
  try {
    text = await boundedResponseText(response, INFERENCE_RESPONSE_LIMIT);
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    if (timeout.aborted) throw new InferenceFailure("TIMEOUT");
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InferenceFailure("INVALID_RESPONSE", { cause: error });
  }
  const output = inferenceText(parsed, input.route.api);
  if (output.length === 0) throw new InferenceFailure("EMPTY_RESPONSE");
  return output;
}

function inferenceBody(input: Parameters<typeof requestInference>[0]): unknown {
  const imageDataUrl = input.image === undefined ? undefined : `data:${input.image.mimeType};base64,${input.image.base64}`;
  if (input.route.api === "anthropic-messages") {
    const content: unknown[] = [];
    if (input.image !== undefined) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: input.image.mimeType, data: input.image.base64 }
      });
    }
    content.push({ type: "text", text: input.user });
    return {
      model: input.route.modelId,
      system: input.system,
      messages: [{ role: "user", content }],
      max_tokens: input.maxTokens
    };
  }
  if (input.route.api === "openai-responses") {
    const content: unknown[] = [];
    if (imageDataUrl !== undefined) content.push({ type: "input_image", image_url: imageDataUrl });
    content.push({ type: "input_text", text: input.user });
    return {
      model: input.route.modelId,
      instructions: input.system,
      input: [{ role: "user", content }],
      max_output_tokens: input.maxTokens
    };
  }
  const content: unknown = imageDataUrl === undefined
    ? input.user
    : [{ type: "text", text: input.user }, { type: "image_url", image_url: { url: imageDataUrl } }];
  return {
    model: input.route.modelId,
    messages: [{ role: "system", content: input.system }, { role: "user", content }],
    max_tokens: input.maxTokens,
    stream: false
  };
}

function inferenceEndpoint(baseUrl: string, api: ProviderInferenceRoute["api"]): string {
  const url = new URL(baseUrl);
  const suffix = api === "anthropic-messages" ? "messages" : api === "openai-responses" ? "responses" : "chat/completions";
  let path = url.pathname.replace(/\/+$/u, "");
  if (api === "anthropic-messages" && !/\/v1$/u.test(path)) path = `${path}/v1`;
  url.pathname = `${path}/${suffix}`.replace(/\/{2,}/gu, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function inferenceText(value: unknown, api: ProviderInferenceRoute["api"]): string {
  if (!isRecord(value)) return "";
  if (api === "anthropic-messages") {
    return Array.isArray(value["content"])
      ? value["content"].flatMap((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("\n").trim()
      : "";
  }
  if (api === "openai-responses") {
    if (typeof value["output_text"] === "string") return value["output_text"].trim();
    if (!Array.isArray(value["output"])) return "";
    return value["output"].flatMap((item) => isRecord(item) && Array.isArray(item["content"])
      ? item["content"].flatMap((part) => isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : [])
      : []).join("\n").trim();
  }
  const first = Array.isArray(value["choices"]) ? value["choices"][0] : undefined;
  if (!isRecord(first) || !isRecord(first["message"])) return "";
  const content = first["message"]["content"];
  if (typeof content === "string") return content.trim();
  return Array.isArray(content)
    ? content.flatMap((part) => isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : []).join("\n").trim()
    : "";
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new InferenceFailure("RESPONSE_TOO_LARGE");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InferenceFailure("RESPONSE_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) result[index] = await work(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

class AbortableSemaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<{
    readonly signal?: AbortSignal;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly onAbort?: () => void;
  }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      if (signal?.aborted) throw abortError();
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: {
        signal?: AbortSignal;
        resolve: () => void;
        reject: (error: unknown) => void;
        onAbort?: () => void;
      } = { ...(signal === undefined ? {} : { signal }), resolve, reject };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiting.indexOf(waiter);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiting.push(waiter);
    });
  }

  #release(): void {
    while (this.#waiting.length > 0) {
      const waiter = this.#waiting.shift()!;
      if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.#active -= 1;
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

class InferenceFailure extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "InferenceFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
