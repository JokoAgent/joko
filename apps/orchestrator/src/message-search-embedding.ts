import {
  MESSAGE_SEARCH_EMBEDDING_MODEL_ID,
  type OperationalStore,
  type SearchSessionMessagesInput
} from "@joko/store";

import type { OpenAiEmbeddingRoute, ProviderCatalogManager } from "./credential-manager.js";

const WORKER_INTERVAL_MS = 1_000;
const BATCH_SIZE = 16;
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;
const QUERY_CACHE_LIMIT = 64;
const QUERY_CACHE_TTL_MS = 2 * 60_000;

export type MessageSearchSemanticMode = "hybrid" | "keyword";

export interface MessageSearchEmbeddingResult {
  readonly semantic?: NonNullable<SearchSessionMessagesInput["semantic"]>;
  readonly skipReason?: string;
}

interface EmbeddingBatch {
  readonly embeddings: readonly (readonly number[])[];
  readonly modelUsed: string;
}

export interface MessageSearchEmbeddingCoordinatorOptions {
  readonly store: OperationalStore;
  readonly providers: Pick<ProviderCatalogManager, "resolveOpenAiEmbeddingRoute">;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

/**
 * Orchestrator-owned semantic search augmentation. Durable queue/index state lives
 * in OperationalStore; plaintext Provider credentials are resolved only for
 * the immediate HTTP request and are never written, emitted, or logged.
 */
export class MessageSearchEmbeddingCoordinator {
  readonly #store: OperationalStore;
  readonly #providers: Pick<ProviderCatalogManager, "resolveOpenAiEmbeddingRoute">;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  readonly #queryCache = new Map<string, { readonly embedding: readonly number[]; readonly expiresAt: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #tick: Promise<void> = Promise.resolve();
  #tickRunning = false;
  #tickQueued = false;
  #stopped = true;
  #configuredEnabled = true;

  constructor(options: MessageSearchEmbeddingCoordinatorOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const configured = this.#store.findSetting<{ readonly semanticIndexEnabled?: boolean }>(
      "service",
      "orchestrator",
      "settings.message_search"
    )?.value.semanticIndexEnabled;
    this.#configuredEnabled = configured ?? true;
    this.#reconcileRuntimeAvailability();
    this.#store.recoverMessageEmbeddingJobs(this.#now());
    this.#scheduleTick();
    this.#timer = this.#setInterval(() => this.#scheduleTick(), WORKER_INTERVAL_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#tick.catch(() => undefined);
    this.#queryCache.clear();
  }

  setEnabled(enabled: boolean): void {
    this.#configuredEnabled = enabled;
    this.#reconcileRuntimeAvailability();
    if (enabled) this.#scheduleTick();
  }

  status(): ReturnType<OperationalStore["messageEmbeddingStatus"]> {
    return this.#store.messageEmbeddingStatus();
  }

  /** Durable owner preference, kept distinct from the runtime availability
   * flag in messageEmbeddingStatus(). A missing Provider route may pause the
   * worker without silently changing what the owner configured. */
  configuredEnabled(): boolean {
    return this.#configuredEnabled;
  }

  available(): boolean {
    const status = this.#store.messageEmbeddingStatus();
    return this.#providers.resolveOpenAiEmbeddingRoute(
      MESSAGE_SEARCH_EMBEDDING_MODEL_ID,
      status.providerId
    ) !== undefined;
  }

  /** Reconcile immediately after Provider or credential capability changes. */
  reconcileAvailability(): void {
    const { route } = this.#reconcileRuntimeAvailability();
    if (route !== undefined) this.#scheduleTick();
  }

  /** Runs one serialized maintenance pass; useful for explicit maintenance and deterministic tests. */
  async drain(): Promise<void> {
    if (this.#stopped) return;
    this.#scheduleTick();
    await this.#tick;
  }

  async embedQuery(query: string, mode: MessageSearchSemanticMode): Promise<MessageSearchEmbeddingResult> {
    if (mode === "keyword") return { skipReason: "Semantic retrieval was disabled for this request." };
    let { status, route } = this.#reconcileRuntimeAvailability();
    if (!this.#configuredEnabled) return { skipReason: "The chat semantic index is disabled in Settings." };
    if (!status.vectorAvailable) return { skipReason: "The sqlite-vec extension is unavailable; keyword search was used." };
    if (route === undefined) {
      return { skipReason: "No unambiguous eligible embedding Provider route is available; keyword search was used." };
    }
    ({ status, route } = this.#bindRoute(status, route));
    if (route === undefined) {
      return { skipReason: "The embedding Provider generation is changing; keyword search was used." };
    }
    if (!this.#store.hasMessageEmbeddings(route.providerId, route.generationId, status.modelId)) {
      return { skipReason: "No completed chat vectors are available yet; keyword search was used." };
    }
    const cacheKey = `${route.providerId}\0${route.generationId}\0${status.modelId}\0${query}`;
    const cached = this.#queryCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      this.#queryCache.delete(cacheKey);
      this.#queryCache.set(cacheKey, cached);
      return {
        semantic: {
          providerId: route.providerId,
          providerGenerationId: route.generationId,
          modelId: status.modelId,
          queryEmbedding: cached.embedding
        }
      };
    }
    try {
      const response = await requestEmbeddings({
        fetch: this.#fetch,
        route,
        texts: [query],
        inputType: "query",
        dimensions: status.dimensions
      });
      const generation = this.#store.reconcileMessageEmbeddingModel(
        route.providerId,
        route.generationId,
        response.modelUsed
      );
      if (generation.modelChanged) {
        this.#queryCache.clear();
        return {
          skipReason: "The embedding model generation changed; the chat index is rebuilding and keyword search was used."
        };
      }
      const [embedding] = response.embeddings;
      if (embedding === undefined) throw new EmbeddingRequestError("INVALID_RESPONSE");
      this.#cacheQuery(cacheKey, embedding);
      return {
        semantic: {
          providerId: route.providerId,
          providerGenerationId: route.generationId,
          modelId: response.modelUsed,
          queryEmbedding: embedding
        }
      };
    } catch (error) {
      return { skipReason: querySkipReason(error) };
    }
  }

  #scheduleTick(): void {
    if (this.#stopped) return;
    if (this.#tickRunning) {
      this.#tickQueued = true;
      return;
    }
    this.#tickRunning = true;
    this.#tick = (async () => {
      try {
        do {
          this.#tickQueued = false;
          await this.#runTick();
        } while (this.#tickQueued && !this.#stopped);
      } finally {
        this.#tickRunning = false;
      }
    })();
  }

  async #runTick(): Promise<void> {
    if (this.#stopped) return;
    this.#store.recoverMessageEmbeddingJobs(this.#now());
    this.#store.pruneUnembeddableMessageEmbeddingJobs();
    let { status, route } = this.#reconcileRuntimeAvailability();
    // Disabling only stops future enqueue/query augmentation. Durable work
    // accepted before the switch continues to drain, preserving the activation cutoff
    // semantics and avoiding a permanently paused queue.
    if (!status.vectorAvailable || status.pendingCount === 0 || route === undefined) return;
    ({ status, route } = this.#bindRoute(status, route));
    if (route === undefined) return;
    const jobs = this.#store.claimMessageEmbeddingJobs(BATCH_SIZE, this.#now());
    if (jobs.length === 0) return;
    try {
      const response = await requestEmbeddings({
        fetch: this.#fetch,
        route,
        texts: jobs.map((job) => job.text),
        inputType: "document",
        dimensions: status.dimensions
      });
      if (response.embeddings.length !== jobs.length) throw new EmbeddingRequestError("INVALID_RESPONSE");
      const generation = this.#store.reconcileMessageEmbeddingModel(
        route.providerId,
        route.generationId,
        response.modelUsed
      );
      // The returned vectors belong to the newly observed upstream model, but
      // the generation rotation deliberately fenced every pre-rotation claim.
      // Discard this batch; the durable jobs are pending and will be fetched
      // once more under the now-pinned model identity.
      if (generation.modelChanged) {
        this.#queryCache.clear();
        return;
      }
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index];
        const embedding = response.embeddings[index];
        if (job === undefined || embedding === undefined) throw new EmbeddingRequestError("INVALID_RESPONSE");
        this.#store.completeMessageEmbeddingJob(
          job.eventCursor,
          job.claimToken,
          route.providerId,
          route.generationId,
          response.modelUsed,
          embedding,
          this.#now()
        );
      }
    } catch (error) {
      const code = embeddingErrorCode(error);
      for (const job of jobs) {
        this.#store.failMessageEmbeddingJob(job.eventCursor, job.claimToken, code, this.#now());
      }
    }
  }

  /**
   * Enabling chat embedding establishes its first
   * no-backfill cutoff, only once the configured model is actually available.
   * Exactly one unambiguous, policy-eligible Provider route enables the
   * capability. A missing route disables enqueueing without changing the durable
   * user preference; a later route starts the cutoff at that later boundary.
   */
  #reconcileRuntimeAvailability(): {
    readonly status: ReturnType<OperationalStore["messageEmbeddingStatus"]>;
    readonly route?: OpenAiEmbeddingRoute;
  } {
    let status = this.#store.messageEmbeddingStatus();
    const route = this.#providers.resolveOpenAiEmbeddingRoute(
      MESSAGE_SEARCH_EMBEDDING_MODEL_ID,
      status.providerId
    );
    const shouldEnable = this.#configuredEnabled && route !== undefined;
    if (status.enabled !== shouldEnable) status = this.#store.setMessageEmbeddingEnabled(shouldEnable);
    if (route === undefined) return { status };
    return { status, route };
  }

  #bindRoute(
    status: ReturnType<OperationalStore["messageEmbeddingStatus"]>,
    route: OpenAiEmbeddingRoute
  ): {
    readonly status: ReturnType<OperationalStore["messageEmbeddingStatus"]>;
    readonly route?: OpenAiEmbeddingRoute;
  } {
    const bound = this.#store.bindMessageEmbeddingProvider(route.providerId, route.generationId);
    if (
      bound.providerId !== route.providerId ||
      bound.providerGenerationId !== route.generationId
    ) return { status: bound };
    return { status: bound, route };
  }

  #cacheQuery(key: string, embedding: readonly number[]): void {
    this.#queryCache.delete(key);
    this.#queryCache.set(key, { embedding, expiresAt: this.#now() + QUERY_CACHE_TTL_MS });
    while (this.#queryCache.size > QUERY_CACHE_LIMIT) {
      const oldest = this.#queryCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#queryCache.delete(oldest);
    }
  }
}

class EmbeddingRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmbeddingRequestError";
  }
}

async function requestEmbeddings(input: {
  readonly fetch: typeof globalThis.fetch;
  readonly route: OpenAiEmbeddingRoute;
  readonly texts: readonly string[];
  readonly inputType: "query" | "document";
  readonly dimensions: number;
}): Promise<EmbeddingBatch> {
  assertSafeEmbeddingEndpoint(input.route.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  let response: Response;
  try {
    response = await input.fetch(input.route.endpoint, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: {
        ...input.route.headers,
        "content-type": "application/json",
        accept: "application/json",
        ...(input.route.authorization === undefined ? {} : { authorization: input.route.authorization })
      },
      body: JSON.stringify({
        model: input.route.modelId,
        input: input.texts,
        input_type: input.inputType,
        dimensions: input.dimensions
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new EmbeddingRequestError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  }
  try {
    if (!response.ok) throw new EmbeddingRequestError(httpEmbeddingErrorCode(response.status));
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAXIMUM_RESPONSE_BYTES) {
      throw new EmbeddingRequestError("RESPONSE_TOO_LARGE");
    }
    const bytes = await readBoundedResponse(response, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new EmbeddingRequestError("INVALID_RESPONSE");
    }
    return parseEmbeddingResponse(payload, input.route.modelId, input.texts.length, input.dimensions);
  } finally {
    clearTimeout(timeout);
  }
}

function parseEmbeddingResponse(
  payload: unknown,
  expectedModelId: string,
  expectedCount: number,
  dimensions: number
): EmbeddingBatch {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) throw new EmbeddingRequestError("INVALID_RESPONSE");
  const modelUsed = reportedEmbeddingModel(payload["model"], expectedModelId);
  const byIndex = new Map<number, readonly number[]>();
  for (let fallbackIndex = 0; fallbackIndex < payload["data"].length; fallbackIndex += 1) {
    const item = payload["data"][fallbackIndex];
    if (!isRecord(item)) throw new EmbeddingRequestError("INVALID_RESPONSE");
    const index = Number.isSafeInteger(item["index"]) ? Number(item["index"]) : fallbackIndex;
    const embedding = item["embedding"];
    if (!Array.isArray(embedding) || embedding.length !== dimensions) {
      throw new EmbeddingRequestError("DIMENSION_MISMATCH");
    }
    const values = embedding as unknown[];
    if (
      values.some((value) =>
        typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))
      ) || byIndex.has(index)
    ) {
      throw new EmbeddingRequestError("INVALID_RESPONSE");
    }
    byIndex.set(index, values as number[]);
  }
  if (byIndex.size !== expectedCount) throw new EmbeddingRequestError("INVALID_RESPONSE");
  const embeddings = Array.from({ length: expectedCount }, (_, index) => {
    const embedding = byIndex.get(index);
    if (embedding === undefined) throw new EmbeddingRequestError("INVALID_RESPONSE");
    return embedding;
  });
  return { embeddings, modelUsed };
}

function reportedEmbeddingModel(value: unknown, requestedModelId: string): string {
  if (value === undefined || value === null || value === "") return requestedModelId;
  if (typeof value !== "string") throw new EmbeddingRequestError("INVALID_RESPONSE");
  const normalized = value.trim();
  if (
    normalized === "" || [...normalized].length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) throw new EmbeddingRequestError("INVALID_RESPONSE");
  return normalized;
}

function httpEmbeddingErrorCode(status: number): string {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "INVALID_REQUEST";
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EmbeddingRequestError("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof EmbeddingRequestError) throw error;
    throw new EmbeddingRequestError(signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertSafeEmbeddingEndpoint(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new EmbeddingRequestError("UNSAFE_ENDPOINT"); }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new EmbeddingRequestError("UNSAFE_ENDPOINT");
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")
  ) return;
  throw new EmbeddingRequestError("UNSAFE_ENDPOINT");
}

function embeddingErrorCode(error: unknown): string {
  return error instanceof EmbeddingRequestError ? error.code : "EMBEDDING_FAILED";
}

function querySkipReason(error: unknown): string {
  switch (embeddingErrorCode(error)) {
    case "AUTH_FAILED": return "The embedding Provider is not authenticated; keyword search was used.";
    case "RATE_LIMITED": return "The embedding Provider is rate-limited; keyword search was used.";
    case "TIMEOUT": return "The embedding query timed out; keyword search was used.";
    case "DIMENSION_MISMATCH": return "The embedding model returned an incompatible vector dimension; keyword search was used.";
    default: return "The embedding query failed; keyword search was used.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
