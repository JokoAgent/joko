import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow, ProviderAccountModelUsageWindow } from "@joko/core";
import type { ClaudeSdkAccountUsage } from "./sdk-runtime.js";

const THROTTLE_MS = 180_000;
const INITIAL_BACKOFF_MS = 5 * 60_000;
const MAXIMUM_BACKOFF_MS = 30 * 60_000;
interface AccountUsageDependencies {
  readonly readIdentity: () => Promise<string | undefined>;
  readonly fetchSnapshot: (signal: AbortSignal) => Promise<ProviderAccountUsageSnapshot>;
  readonly now: () => number;
}

/** Plan quota is a native account fact, independent of task token and cost usage. */
export function parseClaudeAccountUsage(input: ClaudeSdkAccountUsage, providerId: string, observedAt: number): ProviderAccountUsageSnapshot {
  const base = { providerId, observedAt, ...(text(input.subscriptionType) === undefined ? {} : { planType: text(input.subscriptionType)! }) };
  if (!input.rateLimitsAvailable) return base;
  const rates = record(input.rateLimits);
  if (rates === undefined || Buffer.byteLength(JSON.stringify(rates), "utf8") > 256 * 1024) throw unavailable();
  let primaryWindow: ProviderAccountUsageWindow | undefined;
  let secondaryWindow: ProviderAccountUsageWindow | undefined;
  const modelWindows: ProviderAccountModelUsageWindow[] = [];
  if (Array.isArray(rates["limits"])) {
    if (rates["limits"].length > 128) throw unavailable();
    for (const value of rates["limits"]) {
      const row = record(value), scope = record(row?.["scope"]), model = record(scope?.["model"]);
      const window = usageWindow(row?.["percent"], row?.["resets_at"], row?.["severity"]);
      if (window === undefined) continue;
      if (row?.["kind"] === "session") primaryWindow = { ...window, windowMinutes: 300 };
      else if (row?.["kind"] === "weekly_all") secondaryWindow = { ...window, windowMinutes: 10_080 };
      else if (row?.["kind"] === "weekly_scoped" && text(model?.["display_name"]) !== undefined) {
        const modelId = text(model?.["id"]);
        modelWindows.push({ displayName: text(model!["display_name"])!, ...(modelId === undefined ? {} : { modelId }),
          window: { ...window, windowMinutes: 10_080 } });
      }
    }
  }
  primaryWindow ??= nativeWindow(rates["five_hour"], 300);
  secondaryWindow ??= nativeWindow(rates["seven_day"], 10_080);
  if (Array.isArray(rates["model_scoped"])) {
    if (rates["model_scoped"].length > 128) throw unavailable();
    for (const value of rates["model_scoped"]) {
      const row = record(value), displayName = text(row?.["display_name"]), window = nativeWindow(row, 10_080);
      const family = modelFamily(displayName);
      if (displayName !== undefined && window !== undefined && !modelWindows.some(item => family === undefined
        ? item.displayName === displayName : scopedWindowBelongsToFamily(item, family))) {
        modelWindows.push({ displayName, window });
      }
    }
  }
  for (const [key, displayName] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"], ["seven_day_fable", "Fable"]] as const) {
    const window = nativeWindow(rates[key], 10_080);
    if (window !== undefined && !modelWindows.some(item => scopedWindowBelongsToFamily(item, displayName.toLowerCase()))) {
      modelWindows.push({ displayName, window });
    }
  }
  if (primaryWindow === undefined && secondaryWindow === undefined && modelWindows.length === 0) throw unavailable();
  const extra = record(rates["extra_usage"]);
  const extraUsage = extra === undefined || typeof extra["is_enabled"] !== "boolean" ? undefined : {
    enabled: extra["is_enabled"],
    ...(percent(extra["utilization"]) === undefined ? {} : { usedPercent: percent(extra["utilization"])! }),
    ...(nonnegative(extra["used_credits"]) === undefined ? {} : { usedCredits: nonnegative(extra["used_credits"])! }),
    ...(nonnegative(extra["monthly_limit"]) === undefined ? {} : { monthlyLimit: nonnegative(extra["monthly_limit"])! })
  };
  return { ...base, ...(primaryWindow === undefined ? {} : { primaryWindow }), ...(secondaryWindow === undefined ? {} : { secondaryWindow }),
    ...(modelWindows.length === 0 ? {} : { modelWindows }), ...(extraUsage === undefined ? {} : { extraUsage }) };
}

export class ClaudeAccountUsageCache {
  readonly #dependencies: AccountUsageDependencies;
  #identity: string | undefined;
  #snapshot: ProviderAccountUsageSnapshot | undefined;
  #flight: { readonly identity: string; readonly controller: AbortController; readonly promise: Promise<ProviderAccountUsageSnapshot | undefined> } | undefined;
  #lastRefreshAt = 0;
  #backoffMs = 0;
  #backoffUntil = 0;

  constructor(dependencies: AccountUsageDependencies) { this.#dependencies = dependencies; }

  clear(): void {
    this.#flight?.controller.abort();
    this.#flight = undefined;
    this.#identity = undefined;
    this.#snapshot = undefined;
    this.#lastRefreshAt = 0;
    this.#backoffMs = 0;
    this.#backoffUntil = 0;
  }

  async observeNative(identity: string | undefined, providerId: string, info: unknown, observedAt: number): Promise<void> {
    if (identity === undefined || await this.#dependencies.readIdentity() !== identity) return;
    const row = record(info);
    if (row === undefined) return;
    const rawUtilization = typeof row["utilization"] === "number" && Number.isFinite(row["utilization"])
      ? row["utilization"] : undefined;
    const usedPercent = rawUtilization === undefined ? undefined : percent(rawUtilization <= 1 ? rawUtilization * 100 : rawUtilization);
    const rawReset = nonnegative(row["resetsAt"]);
    const resetAt = rawReset === undefined || rawReset === 0 ? undefined
      : Math.floor(rawReset > 1e12 ? rawReset : rawReset * 1_000);
    const window = usedPercent === undefined ? undefined : {
      usedPercent, ...(resetAt === undefined || !Number.isSafeInteger(resetAt) || resetAt > 253_402_300_799_000 ? {} : { resetAt })
    };
    const primaryWindow = row["rateLimitType"] === "five_hour" && window !== undefined ? { ...window, windowMinutes: 300 } : undefined;
    const secondaryWindow = row["rateLimitType"] === "seven_day" && window !== undefined ? { ...window, windowMinutes: 10_080 } : undefined;
    const status = row["status"];
    const limitReached = status === "rejected" ? true : status === "allowed" || status === "allowed_warning" ? false : undefined;
    if (primaryWindow === undefined && secondaryWindow === undefined && limitReached === undefined) return;
    if (this.#identity !== identity) { this.clear(); this.#identity = identity; }
    this.#snapshot = { ...this.#snapshot, providerId, observedAt,
      ...(primaryWindow === undefined ? {} : { primaryWindow }),
      ...(secondaryWindow === undefined ? {} : { secondaryWindow }),
      ...(limitReached === undefined ? {} : { limitReached }) };
  }

  async read(signal?: AbortSignal): Promise<ProviderAccountUsageSnapshot | undefined> {
    signal?.throwIfAborted();
    const identity = await this.#dependencies.readIdentity();
    signal?.throwIfAborted();
    if (identity !== this.#identity) { this.clear(); this.#identity = identity; }
    if (identity === undefined) return undefined;
    const now = this.#dependencies.now();
    if (this.#flight?.identity === identity) return this.#wait(this.#flight.promise, signal);
    if (now < this.#backoffUntil || this.#lastRefreshAt > 0 && now - this.#lastRefreshAt < THROTTLE_MS) {
      if (this.#snapshot === undefined) throw unavailable();
      return structuredClone(this.#snapshot);
    }
    const controller = new AbortController();
    this.#lastRefreshAt = now;
    const refresh = (async () => {
      try {
        const snapshot = await this.#dependencies.fetchSnapshot(controller.signal);
        const currentIdentity = await this.#dependencies.readIdentity();
        if (controller.signal.aborted || this.#identity !== identity || currentIdentity !== identity) return undefined;
        this.#snapshot = structuredClone(snapshot);
        this.#backoffMs = 0;
        this.#backoffUntil = 0;
        return snapshot;
      } catch {
        const currentIdentity = await this.#dependencies.readIdentity();
        if (controller.signal.aborted || this.#identity !== identity || currentIdentity !== identity) return undefined;
        this.#backoffMs = this.#backoffMs > 0 ? Math.min(this.#backoffMs * 2, MAXIMUM_BACKOFF_MS) : INITIAL_BACKOFF_MS;
        this.#backoffUntil = this.#dependencies.now() + this.#backoffMs;
        if (this.#snapshot === undefined) throw unavailable();
        return this.#snapshot;
      } finally {
        if (this.#flight?.controller === controller) this.#flight = undefined;
      }
    })();
    this.#flight = { identity, controller, promise: refresh };
    return this.#wait(refresh, signal);
  }

  async #wait(promise: Promise<ProviderAccountUsageSnapshot | undefined>, signal?: AbortSignal): Promise<ProviderAccountUsageSnapshot | undefined> {
    if (signal === undefined) { const value = await promise; return value === undefined ? undefined : structuredClone(value); }
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = () => reject(new Error("The account usage read was cancelled.")); });
    signal.addEventListener("abort", rejectCancelled, { once: true });
    if (signal.aborted) rejectCancelled();
    try { const value = await Promise.race([promise, cancelled]); return value === undefined ? undefined : structuredClone(value); }
    finally { signal.removeEventListener("abort", rejectCancelled); }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : undefined;
}
function nonnegative(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
function usageWindow(value: unknown, resetsAt: unknown, severity: unknown): ProviderAccountUsageWindow | undefined {
  const usedPercent = percent(value);
  if (usedPercent === undefined) return undefined;
  const resetAt = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  return { usedPercent, ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
    ...(text(severity) === undefined ? {} : { severity: text(severity)! }) };
}
function nativeWindow(value: unknown, windowMinutes: number): ProviderAccountUsageWindow | undefined {
  const row = record(value), window = usageWindow(row?.["utilization"], row?.["resets_at"], row?.["severity"]);
  return window === undefined ? undefined : { ...window, windowMinutes };
}
function modelFamily(value: string | undefined): string | undefined {
  let normalized = (value ?? "").trim().toLowerCase();
  const close = normalized.trimEnd().length - 1;
  if (close >= 0 && normalized[close] === "]") {
    const open = normalized.indexOf("[", normalized.lastIndexOf("]", close - 1) + 1);
    if (open >= 0 && open < close) normalized = normalized.slice(0, open);
  }
  for (const family of ["fable", "mythos", "opus", "sonnet", "haiku"]) if (normalized.includes(family)) return family;
  return undefined;
}
function scopedWindowBelongsToFamily(window: ProviderAccountModelUsageWindow, family: string): boolean {
  const fromId = modelFamily(window.modelId);
  return fromId === undefined ? window.displayName.trim().toLowerCase().includes(family) : fromId === family;
}
function unavailable(): Error { return new Error("Native account usage is unavailable."); }
