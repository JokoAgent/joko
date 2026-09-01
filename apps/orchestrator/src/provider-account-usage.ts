const ACCOUNT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_INITIAL_BACKOFF_MS = 5_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_ENTRIES = 32;

export const PROVIDER_ACCOUNT_USAGE_CAPABILITY = "provider.account_usage";

export interface ProviderAccountUsageWindow {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetAt?: number;
}

export interface ProviderAccountCreditsSnapshot {
  readonly hasCredits?: boolean;
  readonly unlimited?: boolean;
  readonly balance?: string;
  readonly observedAt: number;
}

export interface ProviderAccountUsageSnapshot {
  readonly providerId: string;
  readonly primaryWindow?: ProviderAccountUsageWindow;
  readonly secondaryWindow?: ProviderAccountUsageWindow;
  readonly limitReached?: boolean;
  readonly planType?: string;
  readonly credits?: ProviderAccountCreditsSnapshot;
  readonly observedAt: number;
}

export interface ProviderAccountUsageCredentialIdentity {
  readonly providerId: string;
  readonly catalogGeneration: number;
  readonly providerGeneration: bigint;
  readonly authGeneration: string;
}

export interface ProviderAccountUsageCredential {
  readonly accessToken: string;
  readonly accountId: string;
}

/** Service-owned port. Plaintext credentials exist only for the duration of useCredential. */
export interface ProviderAccountUsageCredentialResolver {
  currentCatalogGeneration(): number;
  describeProviderAccountUsage(providerId: string): ProviderAccountUsageCredentialIdentity | undefined;
  useProviderAccountUsageCredential<T>(
    identity: ProviderAccountUsageCredentialIdentity,
    operation: (credential: ProviderAccountUsageCredential) => Promise<T>
  ): Promise<T>;
  recoverProviderAccountUsageAuthorization?(identity: ProviderAccountUsageCredentialIdentity): Promise<void>;
}

class ProviderAccountUsageUnauthorizedError extends Error {
  constructor() {
    super("Provider account usage authorization was rejected.");
    this.name = "ProviderAccountUsageUnauthorizedError";
  }
}

export interface ProviderAccountUsageProviderOptions {
  readonly credentials: ProviderAccountUsageCredentialResolver;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly bodyLimitBytes?: number;
  readonly cacheTtlMs?: number;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly maximumEntries?: number;
}

interface CacheEntry {
  readonly identityKey: string;
  readonly snapshot?: ProviderAccountUsageSnapshot;
  readonly expiresAt: number;
  readonly retryAt: number;
  readonly failures: number;
  readonly lastAccessedAt: number;
}

interface InflightEntry {
  readonly identityKey: string;
  readonly controller: AbortController;
  readonly promise: Promise<ProviderAccountUsageSnapshot | undefined>;
  waiters: number;
  settled: boolean;
}

/**
 * Capability-owned account quota reader. It keeps only normalized, non-secret
 * snapshots in bounded memory and never persists or logs upstream material.
 */
export class ProviderAccountUsageProvider {
  readonly #credentials: ProviderAccountUsageCredentialResolver;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #bodyLimitBytes: number;
  readonly #cacheTtlMs: number;
  readonly #initialBackoffMs: number;
  readonly #maximumBackoffMs: number;
  readonly #maximumEntries: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, InflightEntry>();
  #catalogGeneration: number | undefined;

  constructor(options: ProviderAccountUsageProviderOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 30_000, "timeout");
    this.#bodyLimitBytes = boundedInteger(options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES, 1, 1024 * 1024, "body limit");
    this.#cacheTtlMs = boundedInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 1, 60 * 60_000, "cache lifetime");
    this.#initialBackoffMs = boundedInteger(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS, 1, 60 * 60_000, "initial backoff");
    this.#maximumBackoffMs = boundedInteger(options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS, this.#initialBackoffMs, 24 * 60 * 60_000, "maximum backoff");
    this.#maximumEntries = boundedInteger(options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES, 1, 256, "cache capacity");
  }

  peek(providerId: string): ProviderAccountUsageSnapshot | undefined {
    this.#reconcileCatalogGeneration();
    const identity = this.#credentials.describeProviderAccountUsage(providerId);
    if (identity === undefined) {
      this.invalidate(providerId);
      return undefined;
    }
    const entry = this.#cache.get(providerId);
    if (entry === undefined || entry.identityKey !== identityKey(identity)) {
      this.invalidate(providerId);
      return undefined;
    }
    return entry.snapshot;
  }

  async get(providerId: string, signal?: AbortSignal): Promise<ProviderAccountUsageSnapshot | undefined> {
    throwIfAborted(signal);
    this.#reconcileCatalogGeneration();
    const identity = this.#credentials.describeProviderAccountUsage(providerId);
    if (identity === undefined) {
      this.invalidate(providerId);
      return undefined;
    }
    const key = identityKey(identity);
    let cached = this.#cache.get(providerId);
    if (cached !== undefined && cached.identityKey !== key) {
      this.invalidate(providerId);
      cached = undefined;
    }
    const now = this.#now();
    if (cached !== undefined && cached.expiresAt > now) {
      this.#touch(providerId, cached, now);
      return cached.snapshot;
    }
    if (cached !== undefined && cached.retryAt > now) {
      this.#touch(providerId, cached, now);
      return cached.snapshot;
    }
    const existing = this.#inflight.get(providerId);
    if (existing !== undefined && existing.identityKey === key) {
      return await this.#waitForInflight(providerId, existing, signal);
    }
    if (existing !== undefined) this.invalidate(providerId);

    const controller = new AbortController();
    let inflight!: InflightEntry;
    const promise = this.#refresh(identity, controller)
      .finally(() => {
        inflight.settled = true;
        if (this.#inflight.get(providerId) === inflight) this.#inflight.delete(providerId);
      });
    inflight = { identityKey: key, controller, promise, waiters: 0, settled: false };
    this.#inflight.set(providerId, inflight);
    return await this.#waitForInflight(providerId, inflight, signal);
  }

  invalidate(providerId?: string): void {
    if (providerId === undefined) {
      for (const entry of this.#inflight.values()) entry.controller.abort();
      this.#inflight.clear();
      this.#cache.clear();
      return;
    }
    this.#inflight.get(providerId)?.controller.abort();
    this.#inflight.delete(providerId);
    this.#cache.delete(providerId);
  }

  async #refresh(
    identity: ProviderAccountUsageCredentialIdentity,
    controller: AbortController
  ): Promise<ProviderAccountUsageSnapshot | undefined> {
    const providerId = identity.providerId;
    const key = identityKey(identity);
    const previous = this.#cache.get(providerId);
    try {
      const snapshot = await this.#credentials.useProviderAccountUsageCredential(identity, async (credential) =>
        await fetchProviderAccountUsage({
          providerId,
          credential,
          fetch: this.#fetch,
          signal: controller.signal,
          timeoutMs: this.#timeoutMs,
          bodyLimitBytes: this.#bodyLimitBytes,
          now: this.#now
        }));
      if (controller.signal.aborted || this.#inflight.get(providerId)?.controller !== controller
          || identityKey(this.#credentials.describeProviderAccountUsage(providerId)) !== key) return undefined;
      const now = this.#now();
      this.#store(providerId, {
        identityKey: key,
        snapshot,
        expiresAt: now + this.#cacheTtlMs,
        retryAt: 0,
        failures: 0,
        lastAccessedAt: now
      });
      return snapshot;
    } catch (error) {
      if (controller.signal.aborted || this.#inflight.get(providerId)?.controller !== controller
          || identityKey(this.#credentials.describeProviderAccountUsage(providerId)) !== key) return undefined;
      const now = this.#now();
      const failures = Math.min(30, (previous?.failures ?? 0) + 1);
      const delay = Math.min(this.#maximumBackoffMs, this.#initialBackoffMs * (2 ** Math.min(20, failures - 1)));
      if (error instanceof ProviderAccountUsageUnauthorizedError) {
        this.#store(providerId, {
          identityKey: key,
          expiresAt: 0,
          retryAt: now + delay,
          failures,
          lastAccessedAt: now
        });
        void this.#credentials.recoverProviderAccountUsageAuthorization?.(identity).catch(() => undefined);
        return undefined;
      }
      this.#store(providerId, {
        identityKey: key,
        ...(previous?.snapshot === undefined ? {} : { snapshot: previous.snapshot }),
        expiresAt: 0,
        retryAt: now + delay,
        failures,
        lastAccessedAt: now
      });
      return previous?.snapshot;
    }
  }

  #reconcileCatalogGeneration(): void {
    const current = this.#credentials.currentCatalogGeneration();
    if (this.#catalogGeneration === undefined) {
      this.#catalogGeneration = current;
      return;
    }
    if (current === this.#catalogGeneration) return;
    this.invalidate();
    this.#catalogGeneration = current;
  }

  #touch(providerId: string, entry: CacheEntry, now: number): void {
    this.#cache.delete(providerId);
    this.#cache.set(providerId, { ...entry, lastAccessedAt: now });
  }

  async #waitForInflight(
    providerId: string,
    inflight: InflightEntry,
    signal: AbortSignal | undefined
  ): Promise<ProviderAccountUsageSnapshot | undefined> {
    inflight.waiters += 1;
    try {
      return await waitForCaller(inflight.promise, signal);
    } finally {
      inflight.waiters -= 1;
      if (inflight.waiters === 0 && !inflight.settled && this.#inflight.get(providerId) === inflight) {
        inflight.controller.abort();
        this.#inflight.delete(providerId);
      }
    }
  }

  #store(providerId: string, entry: CacheEntry): void {
    this.#cache.delete(providerId);
    this.#cache.set(providerId, entry);
    while (this.#cache.size > this.#maximumEntries) {
      const oldest = [...this.#cache.entries()]
        .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt || left[0].localeCompare(right[0], "en"))[0];
      if (oldest === undefined) break;
      this.#cache.delete(oldest[0]);
    }
  }
}

async function fetchProviderAccountUsage(input: {
  readonly providerId: string;
  readonly credential: ProviderAccountUsageCredential;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly bodyLimitBytes: number;
  readonly now: () => number;
}): Promise<ProviderAccountUsageSnapshot> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, input.timeoutMs);
  try {
    throwIfAborted(input.signal);
    const accessToken = safeHeaderValue(input.credential.accessToken, 64 * 1024);
    const accountId = safeHeaderValue(input.credential.accountId, 256);
    const response = await input.fetch(ACCOUNT_USAGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId
      },
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
    if (response.redirected) throw new Error("Provider account usage redirected.");
    if (response.status === 401 || response.status === 403) throw new ProviderAccountUsageUnauthorizedError();
    if (response.status !== 200) throw new Error("Provider account usage is temporarily unavailable.");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new Error("Provider account usage returned an unsupported representation.");
    const body = await readBoundedJson(response, input.bodyLimitBytes);
    return parseProviderAccountUsage(input.providerId, body, input.now());
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abort);
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length")?.trim();
  if (declared !== undefined && declared !== "") {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new Error("Provider account usage response exceeded its size limit.");
    }
  }
  if (response.body === null) throw new Error("Provider account usage response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Provider account usage response exceeded its size limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Provider account usage response was not valid UTF-8."); }
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Provider account usage response was not valid JSON."); }
}

function parseProviderAccountUsage(providerId: string, value: unknown, observedAt: number): ProviderAccountUsageSnapshot {
  const root = record(value, "response");
  const rateLimit = optionalRecord(root, "rate_limit");
  const primaryWindow = rateLimit === undefined ? undefined : usageWindow(rateLimit, "primary_window", observedAt);
  const secondaryWindow = rateLimit === undefined ? undefined : usageWindow(rateLimit, "secondary_window", observedAt);
  const limitReached = rateLimit === undefined ? undefined : optionalBoolean(rateLimit, "limit_reached");
  const planType = optionalText(root, "plan_type", 128);
  const creditsRecord = optionalRecord(root, "credits");
  const credits = creditsRecord === undefined ? undefined : creditsSnapshot(creditsRecord, observedAt);
  if (primaryWindow === undefined && secondaryWindow === undefined && limitReached === undefined
      && planType === undefined && credits === undefined) {
    throw new Error("Provider account usage response contained no supported account fields.");
  }
  return {
    providerId,
    ...(primaryWindow === undefined ? {} : { primaryWindow }),
    ...(secondaryWindow === undefined ? {} : { secondaryWindow }),
    ...(limitReached === undefined ? {} : { limitReached }),
    ...(planType === undefined ? {} : { planType }),
    ...(credits === undefined ? {} : { credits }),
    observedAt
  };
}

function usageWindow(parent: Record<string, unknown>, name: string, observedAt: number): ProviderAccountUsageWindow | undefined {
  const value = parent[name];
  if (value === undefined || value === null) return undefined;
  const window = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (window === undefined) return undefined;
  const rawUsedPercent = normalizedFiniteNumber(window["used_percent"]);
  if (rawUsedPercent === undefined) return undefined;
  const usedPercent = Math.min(100, Math.max(0, rawUsedPercent));
  const seconds = optionalPositiveNumber(window, "limit_window_seconds");
  const explicitMinutes = optionalPositiveNumber(window, "window_minutes");
  const windowMinutes = explicitMinutes === undefined
    ? (seconds === undefined ? undefined : Math.max(1, Math.round(seconds / 60)))
    : Math.round(explicitMinutes);
  const boundedWindowMinutes = windowMinutes !== undefined
      && Number.isSafeInteger(windowMinutes)
      && windowMinutes <= 10 * 366 * 24 * 60
    ? windowMinutes
    : undefined;
  const resetSeconds = optionalPositiveNumber(window, "reset_at");
  const resetAfterSeconds = optionalPositiveNumber(window, "reset_after_seconds");
  const candidateResetAt = resetSeconds !== undefined
    ? Math.round(resetSeconds * 1_000)
    : (resetAfterSeconds === undefined ? undefined : Math.round(observedAt + resetAfterSeconds * 1_000));
  const resetAt = Number.isSafeInteger(candidateResetAt) ? candidateResetAt : undefined;
  return {
    usedPercent,
    ...(boundedWindowMinutes === undefined ? {} : { windowMinutes: boundedWindowMinutes }),
    ...(resetAt === undefined ? {} : { resetAt })
  };
}

function creditsSnapshot(value: Record<string, unknown>, observedAt: number): ProviderAccountCreditsSnapshot | undefined {
  const explicitHasCredits = normalizedBoolean(value["has_credits"]);
  const explicitUnlimited = normalizedBoolean(value["unlimited"]);
  const rawBalance = value["balance"];
  let balance: string | undefined;
  if (rawBalance !== undefined && rawBalance !== null) {
    const normalized = typeof rawBalance === "number" && Number.isFinite(rawBalance)
      ? String(rawBalance)
      : typeof rawBalance === "string" ? rawBalance.trim() : "";
    if (normalized !== "" && normalized.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(normalized)) balance = normalized;
  }
  if (explicitHasCredits === undefined && explicitUnlimited === undefined && balance === undefined) return undefined;
  return {
    ...(explicitHasCredits === undefined ? {} : { hasCredits: explicitHasCredits }),
    ...(explicitUnlimited === undefined ? {} : { unlimited: explicitUnlimited }),
    ...(balance === undefined ? {} : { balance }),
    observedAt
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider account usage ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(parent: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = parent[name];
  if (value === undefined || value === null) return undefined;
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalBoolean(parent: Record<string, unknown>, name: string): boolean | undefined {
  const value = parent[name];
  if (value === undefined || value === null) return undefined;
  return typeof value === "boolean" ? value : undefined;
}

function optionalText(parent: Record<string, unknown>, name: string, maximumLength: number): string | undefined {
  const value = parent[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function optionalPositiveNumber(parent: Record<string, unknown>, name: string): number | undefined {
  const value = parent[name];
  if (value === undefined || value === null) return undefined;
  const number = normalizedFiniteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function normalizedFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 64 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function normalizedBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

function identityKey(identity: ProviderAccountUsageCredentialIdentity): string;
function identityKey(identity: undefined): undefined;
function identityKey(identity: ProviderAccountUsageCredentialIdentity | undefined): string | undefined;
function identityKey(identity: ProviderAccountUsageCredentialIdentity | undefined): string | undefined {
  return identity === undefined
    ? undefined
    : `${identity.providerId}\u0000${identity.catalogGeneration}\u0000${identity.providerGeneration}\u0000${identity.authGeneration}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Provider account usage ${label} is outside its valid range.`);
  }
  return value;
}

function safeHeaderValue(value: string, maximumLength: number): string {
  if (value.length < 1 || value.length > maximumLength || /[^\u0020-\u007e]/u.test(value)) {
    throw new Error("Provider account usage credential header is invalid.");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
