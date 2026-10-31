import type { ProviderCatalogManager } from "./credential-manager.js";

export const PROVIDER_ACCOUNT_BALANCE_CAPABILITY = "provider.account_balance";
export interface AccountBalanceIntegration {
  readonly kind: "deepseek" | "zhipu";
  readonly endpoint: string;
  readonly dashboardUrl: string;
}
export interface AccountBalanceIdentity {
  readonly backendId: string;
  readonly providerId: string;
  readonly key: string;
  readonly reference?: string;
  readonly native: boolean;
  readonly integration: AccountBalanceIntegration;
}
export interface AccountBalanceWindow { readonly usedPercent: number; readonly resetAt?: number }
export type AccountBalanceSnapshot = {
  readonly kind: "deepseek"; readonly isAvailable: boolean;
  readonly balances: readonly { readonly currency: string; readonly totalBalance: string; readonly grantedBalance: string; readonly toppedUpBalance: string }[];
} | { readonly kind: "zhipu"; readonly noPlan: boolean; readonly level?: string; readonly fiveHour?: AccountBalanceWindow; readonly weekly?: AccountBalanceWindow };
export interface AccountBalanceResult {
  readonly status: "unsupported" | "unavailable" | "ready";
  readonly error?: "no-credentials" | "auth" | "rate-limited" | "network" | "server" | "invalid-response" | "throttled";
  readonly stale?: boolean;
  readonly retryAt?: number;
  readonly dashboardUrl?: string;
  readonly observedAt?: number;
  readonly snapshot?: AccountBalanceSnapshot;
}

/** Only fixed official endpoints may receive the original API key. */
export function accountBalanceIntegration(baseUrl: string | undefined): AccountBalanceIntegration | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
  if (url.origin === "https://api.deepseek.com") return { kind: "deepseek", endpoint: "https://api.deepseek.com/user/balance", dashboardUrl: "https://platform.deepseek.com/usage" };
  if (url.origin !== "https://open.bigmodel.cn" && url.origin !== "https://api.z.ai") return undefined;
  if (url.pathname !== "/api/anthropic" && !url.pathname.startsWith("/api/anthropic/") && !url.pathname.startsWith("/api/coding/")) return undefined;
  return { kind: "zhipu", endpoint: `${url.origin}/api/monitor/usage/quota/limit`, dashboardUrl: url.origin === "https://api.z.ai"
    ? "https://z.ai/manage-apikey/coding-plan/personal/my-plan" : "https://www.bigmodel.cn/coding-plan/personal/usage" };
}

interface CacheEntry { readonly identity: string; readonly result: AccountBalanceResult; readonly expiresAt: number; readonly attemptedAt: number; readonly retryAt: number }
interface Pending { readonly identity: string; readonly controller: AbortController; readonly promise: Promise<AccountBalanceResult>; waiters: number }
class BalanceError extends Error {
  constructor(readonly code: NonNullable<AccountBalanceResult["error"]>, readonly retryAt?: number) { super(code); }
}

/** Bounded, non-secret account cache, fenced by the catalog and sealed credential generation. */
export class ProviderAccountBalanceProvider {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Pending>();
  constructor(readonly providers: Pick<ProviderCatalogManager, "describeAccountBalance" | "useAccountBalanceCredential">,
    readonly fetcher: typeof fetch = globalThis.fetch, readonly now: () => number = Date.now) {}

  async get(backendId: string, providerId: string, forceRefresh = false, signal?: AbortSignal): Promise<AccountBalanceResult> {
    signal?.throwIfAborted();
    const slot = JSON.stringify([backendId, providerId]), identity = this.providers.describeAccountBalance(backendId, providerId);
    const previous = this.#cache.get(slot);
    if (!identity || previous && previous.identity !== identity.key) {
      this.#cache.delete(slot); this.#pending.get(slot)?.controller.abort(); this.#pending.delete(slot);
    }
    if (!identity) return { status: "unsupported" };
    const dashboardUrl = identity.integration.dashboardUrl;
    if (!identity.reference) return { status: "unavailable", error: "no-credentials", dashboardUrl };
    const cached = this.#cache.get(slot), now = this.now();
    if (cached && cached.retryAt > now) return { ...cached.result, error: cached.result.snapshot ? "rate-limited" : "throttled", stale: true, retryAt: cached.retryAt };
    if (cached && (forceRefresh ? now - cached.attemptedAt < 15_000 : cached.expiresAt > now)) return cached.result;
    let pending = this.#pending.get(slot);
    if (pending && pending.identity !== identity.key) { pending.controller.abort(); this.#pending.delete(slot); pending = undefined; }
    if (!pending) {
      // Prune only completed cache entries. Active requests keep their own retirement ownership.
      while (this.#cache.size >= 128) this.#cache.delete(this.#cache.keys().next().value!);
      if (this.#pending.size >= 32) return { status: "unavailable", error: "throttled", dashboardUrl };
      const controller = new AbortController();
      const promise = this.refresh(slot, identity, controller, cached).finally(() => {
        if (this.#pending.get(slot)?.controller === controller) this.#pending.delete(slot);
      });
      pending = { identity: identity.key, controller, promise, waiters: 0 }; this.#pending.set(slot, pending);
    }
    const current = pending; current.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([current.promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (--current.waiters === 0 && this.#pending.get(slot) === current) { current.controller.abort(); this.#pending.delete(slot); }
    }
  }
  dispose(): void { for (const pending of this.#pending.values()) pending.controller.abort(); this.#pending.clear(); this.#cache.clear(); }

  private async refresh(slot: string, identity: AccountBalanceIdentity, controller: AbortController, previous?: CacheEntry): Promise<AccountBalanceResult> {
    const current = () => !controller.signal.aborted && this.providers.describeAccountBalance(identity.backendId, identity.providerId)?.key === identity.key;
    const timer = setTimeout(() => controller.abort(), 10_000);
    let rejectAbort: (() => void) | undefined;
    let result: AccountBalanceResult;
    try {
      const snapshot = await Promise.race([this.providers.useAccountBalanceCredential(identity, async key => {
        if (!current()) throw new BalanceError("no-credentials");
        if (!key || key.length > 64 * 1024 || /[\u0000-\u001f\u007f]/u.test(key)) throw new BalanceError("no-credentials");
        const response = await this.fetcher(identity.integration.endpoint, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
          signal: controller.signal, headers: { accept: "application/json", authorization: identity.integration.kind === "zhipu" ? key : `Bearer ${key}`,
            ...(identity.integration.kind === "zhipu" ? { "content-type": "application/json", "accept-language": "en-US,en" } : {}) } });
        if (response.redirected) throw new BalanceError("network");
        if (response.status === 401 || response.status === 403) throw new BalanceError("auth");
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          throw new BalanceError("rate-limited", this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3_600_000) : 15_000));
        }
        if (response.status >= 500) throw new BalanceError("server");
        if (!response.ok) throw new BalanceError("invalid-response");
        const body = await boundedJson(response, controller.signal);
        return identity.integration.kind === "deepseek" ? parseDeepSeekBalance(body) : parseZhipuBalance(body);
      }), new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new BalanceError("network")); controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      })]);
      result = { status: "ready", snapshot, stale: false, observedAt: this.now(), dashboardUrl: identity.integration.dashboardUrl };
    } catch (error) {
      const code = error instanceof BalanceError ? error.code : "network";
      const stale = previous?.result.snapshot ? previous.result : undefined;
      result = { ...(stale ?? { status: "unavailable" as const }), error: code, stale: stale !== undefined, dashboardUrl: identity.integration.dashboardUrl,
        ...(error instanceof BalanceError && error.retryAt ? { retryAt: error.retryAt } : {}) };
    } finally { clearTimeout(timer); if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); }
    if (!current()) return { status: "unavailable", error: controller.signal.aborted ? "network" : "no-credentials" };
    this.#cache.set(slot, { identity: identity.key, result, expiresAt: result.error ? 0 : this.now() + 300_000, attemptedAt: this.now(), retryAt: result.retryAt ?? 0 });
    return result;
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 64 * 1024, size = response.headers.get("content-length");
  if (size !== null && (!/^\d+$/u.test(size) || Number(size) > limit) || !response.body) throw new BalanceError("invalid-response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      length += item.value.byteLength; if (length > limit) { void reader.cancel().catch(() => undefined); throw new BalanceError("invalid-response"); } chunks.push(item.value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new BalanceError("invalid-response"); }
  } finally { reader.releaseLock(); }
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BalanceError("invalid-response"); return value as Record<string, unknown>; }
export function parseDeepSeekBalance(value: unknown): AccountBalanceSnapshot {
  const body = record(value);
  if (typeof body["is_available"] !== "boolean" || !Array.isArray(body["balance_infos"])) throw new BalanceError("invalid-response");
  return { kind: "deepseek", isAvailable: body["is_available"], balances: body["balance_infos"].map(value => {
    const row = record(value), currency = row["currency"], totalBalance = row["total_balance"], grantedBalance = row["granted_balance"], toppedUpBalance = row["topped_up_balance"];
    const decimal = (v: unknown): v is string => typeof v === "string" && v.length <= 128 && /^-?\d+(?:\.\d+)?$/u.test(v);
    if (typeof currency !== "string" || !currency.trim() || currency.length > 16 || /[\u0000-\u001f\u007f]/u.test(currency)
      || !decimal(totalBalance) || !decimal(grantedBalance) || !decimal(toppedUpBalance)) throw new BalanceError("invalid-response");
    return { currency, totalBalance, grantedBalance, toppedUpBalance };
  }) };
}
export function parseZhipuBalance(value: unknown): AccountBalanceSnapshot {
  const body = record(value);
  if (body["success"] === false) {
    const msg = typeof body["msg"] === "string" ? body["msg"] : "";
    if (msg.replace(/[\s_-]/gu, "").toLowerCase().includes("codingplan") && /不存在|没有|未开通|not exist|not found|not have|doesn't have|no coding plan|not subscribed/u.test(msg)) return { kind: "zhipu", noPlan: true };
    throw new BalanceError("invalid-response");
  }
  const data = record(body["data"]), level = typeof data["level"] === "string" ? data["level"].trim().slice(0, 128) : undefined;
  let fiveHour: AccountBalanceWindow | undefined, weekly: AccountBalanceWindow | undefined;
  const unknown: AccountBalanceWindow[] = [];
  for (const item of Array.isArray(data["limits"]) ? data["limits"] : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue; const row = item as Record<string, unknown>;
    if (typeof row["type"] !== "string" || !["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(row["type"].toUpperCase())) continue;
    const percent = row["percentage"], reset = row["nextResetTime"];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const window: AccountBalanceWindow = { usedPercent: Math.max(0, Math.min(100, percent)), ...(typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 ? { resetAt: reset } : {}) };
    if (row["unit"] === 3 && !fiveHour) fiveHour = window; else if (row["unit"] === 6 && !weekly) weekly = window; else if (row["unit"] == null) unknown.push(window);
  }
  unknown.sort((a, b) => (a.resetAt ?? 0) - (b.resetAt ?? 0));
  for (const window of unknown) { if (!fiveHour) fiveHour = window; else if (!weekly) weekly = window; }
  return { kind: "zhipu", noPlan: false, ...(level ? { level } : {}), ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}
