import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JokoError, type NativeAccountRateLimitResetConsume, type NativeAccountRateLimitResetOperations, type NativeAccountRateLimitResetSnapshot } from "@joko/core";
import { DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, providerAccountResetOperationId } from "@joko/contracts";
import { OperationalStore, RevisionConflictError } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAccountResets, shouldAutomaticallyResetAccount, accountResetQuotaRestored, type AccountResetRequest } from "./provider-account-resets.js";

const NOW = 1_800_000_000_000, ACCOUNT = "a".repeat(64), OTHER = "b".repeat(64);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function snapshot(): NativeAccountRateLimitResetSnapshot {
  return { providerId: "openai", accountKey: ACCOUNT, accountLabel: "…ccount",
    usage: { providerId: "openai", observedAt: NOW, secondaryWindow: { usedPercent: 100, windowMinutes: 10080, resetAt: NOW + 5 * 86_400_000 } },
    ordinaryQuota: { secondaryWindow: { usedPercent: 100, windowMinutes: 10080, resetAt: NOW + 5 * 86_400_000 }, creditsDepleted: false },
    credits: { availableCount: 2, details: [
      { creditId: "private-credit-first", resetType: "codexRateLimits", status: "available", grantedAt: NOW - 10_000, expiresAt: NOW + 60_000 },
      { creditId: "private-credit-second", resetType: "codexRateLimits", status: "available", grantedAt: NOW - 20_000, expiresAt: NOW + 3_600_000 }
    ] } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-account-resets-")), file = join(root, "operations.db");
  let store = new OperationalStore(file), now = NOW, facts = snapshot(), backend = true;
  let onRead: (() => void | Promise<void>) | undefined, onConsume: ((input: NativeAccountRateLimitResetConsume) => void | Promise<void>) | undefined;
  const requests: { accountKey: string; idempotencyKey: string; creditId?: string }[] = [], restored = vi.fn(async () => undefined), warn = vi.fn();
  const port: NativeAccountRateLimitResetOperations = {
    readAccountRateLimitResets: vi.fn<NativeAccountRateLimitResetOperations["readAccountRateLimitResets"]>(async input => { input.assertCurrent(); await onRead?.(); input.assertCurrent(); return structuredClone(facts); }),
    consumeAccountRateLimitReset: vi.fn<NativeAccountRateLimitResetOperations["consumeAccountRateLimitReset"]>(async input => {
      input.assertCurrent(); if (input.accountKey !== facts.accountKey) throw new JokoError({ code: "ACCOUNT_CHANGED", message: "Account changed", phase: "dispatch", retryable: true, stateMayHaveChanged: false, recovery: "Restore the original account." });
      requests.push({ accountKey: input.accountKey, idempotencyKey: input.idempotencyKey, ...(input.creditId ? { creditId: input.creditId } : {}) });
      await onConsume?.(input); input.assertCurrent(); return "reset";
    })
  };
  const createManager = () => new ProviderAccountResets({ store, now: () => now, restored, warn,
    withAccount: async (backendId, providerId, action) => {
      const current = () => { if (!backend || backendId !== "codex" || providerId !== "openai") throw new Error("Original Backend unavailable"); };
      current(); return action(port, current);
    } });
  let manager = createManager();
  cleanups.push(async () => { await manager.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { get store() { return store; }, get manager() { return manager; }, get facts() { return facts; }, set facts(value) { facts = value; },
    set onRead(value: typeof onRead) { onRead = value; }, set onConsume(value: typeof onConsume) { onConsume = value; },
    requests, port, restored, warn, advance: (milliseconds: number) => { now += milliseconds; }, retire: () => { backend = false; },
    read: () => manager.read("codex", "openai", () => {}),
    claim: (offerId: string, operationId = providerAccountResetOperationId(offerId, "fixture-owner")) => {
      store.claimDeferredEffectOperation({ id: operationId, kind: "consumeProviderAccountReset", body: { payload: { case: "consumeProviderAccountReset",
        value: { backendId: "codex", providerId: "openai", accountKey: ACCOUNT, offerId } } } }); return operationId;
    },
    async restart() { await manager.dispose(); store.close(); store = new OperationalStore(file); store.recoverStartup("cold-account-reset-owner"); manager = createManager(); }
  };
}
const request = (offerId: string, accountKey = ACCOUNT): AccountResetRequest => ({ backendId: "codex", providerId: "openai", accountKey, offerId });
const unknown = () => new JokoError({ code: "RESET_RESPONSE_LOST", message: "Native response lost", phase: "dispatch", retryable: true, stateMayHaveChanged: true, recovery: "Retry the original reset." });

describe("account reset operational ownership", () => {
  it("keeps private credit parameters and the same SDK attempt across an ambiguous response and a cold Store", async () => {
    const f = fixture(), view = await f.read(), offer = view.defaultOffer!;
    expect(offer.offerId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(view, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain("private-credit");
    expect(view.credits.map(credit => credit.expiresAt)).toEqual([NOW + 60_000, NOW + 3_600_000]);
    const operationId = f.claim(offer.offerId); f.onConsume = () => { throw unknown(); };
    await expect(f.manager.consume(request(offer.offerId), operationId, () => {})).rejects.toMatchObject({ publicError: { stateMayHaveChanged: true } });
    f.store.claimDeferredEffectOperation({ id: "unrelated-unsafe-write", kind: "native_create", body: { original: true } });
    await f.restart();
    expect(f.store.getOperation(operationId).status).toBe("started");
    expect(f.store.getOperation("unrelated-unsafe-write")).toMatchObject({ status: "failed", error: { code: "EFFECT_OUTCOME_UNKNOWN" } });
    const restored = await f.read(); expect(restored.defaultOffer).toMatchObject({ offerId: offer.offerId, retryOnly: true });
    expect(restored.credits.every(credit => credit.offer === undefined)).toBe(true);
    f.facts = { ...f.facts, accountKey: OTHER };
    await expect(f.manager.consume(request(offer.offerId), operationId, () => {})).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(f.manager.hasAttempt(request(offer.offerId))).toBe(true);
    f.facts = { ...f.facts, accountKey: ACCOUNT };
    f.onConsume = undefined;
    await expect(f.manager.consume(request(offer.offerId), operationId, () => {})).resolves.toMatchObject({ outcome: "reset" });
    expect(f.requests).toEqual([0, 1].map(() => ({ accountKey: ACCOUNT, idempotencyKey: offer.offerId, creditId: "private-credit-first" })));
    expect(JSON.stringify(f.store.getOperation(operationId).body)).not.toContain("private-credit");
  });

  it("shares one in-flight offer, blocks another credit, and preserves a known result when the subsequent refresh fails", async () => {
    const f = fixture(), view = await f.read(), first = view.credits[0]!.offer!, second = view.credits[1]!.offer!;
    let finish!: () => void; f.onConsume = () => new Promise<void>(resolve => { finish = resolve; });
    const operation = f.claim(first.offerId), other = f.claim(second.offerId), joinedOperation = f.claim(first.offerId, "another-wrapper");
    const original = f.manager.consume(request(first.offerId), operation, () => {}), joined = f.manager.consume(request(first.offerId), joinedOperation, () => {});
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await expect(f.manager.consume(request(second.offerId), other, () => {})).rejects.toMatchObject({ reason: "reset_in_progress" });
    f.onRead = () => { throw new Error("Quota refresh failed"); }; finish();
    expect((await Promise.all([original, joined])).map(value => value.outcome)).toEqual(["reset", "reset"]);
    expect(f.warn).toHaveBeenCalled(); expect(f.restored).not.toHaveBeenCalled();
    await expect(f.manager.consume(request(first.offerId), operation, () => {})).resolves.toMatchObject({ outcome: "reset" });
    expect(f.requests).toHaveLength(1);
    f.onRead = undefined; f.advance(600_001); await f.restart(); await f.read();
    await expect(f.manager.consume(request(first.offerId), operation, () => {})).resolves.toMatchObject({ outcome: "reset" });
    expect(f.requests).toHaveLength(1);
  });

  it("distinguishes absent counts, count-only credits and authoritative empty details, and expires unused offers", async () => {
    const f = fixture(); f.facts = { ...f.facts, credits: undefined };
    const missing = await f.read(); expect(missing.availableCount).toBeUndefined(); expect(missing.defaultOffer).toBeUndefined();
    f.facts = { ...f.facts, credits: { availableCount: 2 } };
    const countOnly = await f.read(); expect(countOnly.detailsAvailable).toBe(false); expect(countOnly.defaultOffer).toBeDefined();
    f.advance(600_001); const operationId = f.claim(countOnly.defaultOffer!.offerId);
    await expect(f.manager.consume(request(countOnly.defaultOffer!.offerId), operationId, () => {})).rejects.toMatchObject({ reason: "offer_expired" });
    expect(f.requests).toEqual([]);
    f.facts = { ...f.facts, credits: { availableCount: 2, details: [] } };
    const empty = await f.read(); expect(empty.detailsAvailable).toBe(true); expect(empty.defaultOffer).toBeUndefined();
  });

  it("commits account-bound settings with the public Operation and rejects a stale settings revision atomically", async () => {
    const f = fixture(), settings = { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true };
    const prepare = () => f.manager.prepareSettings({ backendId: "codex", providerId: "openai", accountKey: ACCOUNT, expectedRevision: 0n, settings }, () => {});
    const first = await prepare(), stale = await prepare();
    f.store.runOperation({ id: "settings-first", kind: "updateProviderAccountResetSettings", body: settings }, () => { first(); return { accepted: true }; });
    expect(() => f.store.runOperation({ id: "settings-stale", kind: "updateProviderAccountResetSettings", body: settings }, () => { stale(); return { accepted: true }; })).toThrow(RevisionConflictError);
    expect(f.store.findOperation("settings-stale")).toMatchObject({ status: "failed", error: { name: "RevisionConflictError" } });
    expect((await f.read()).automaticSettings.enabled).toBe(true);
    f.facts = { ...f.facts, accountKey: OTHER };
    expect((await f.read()).automaticSettings).toEqual(DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS);
    f.facts = { ...f.facts, accountKey: ACCOUNT };
    const view = await f.read(), restore = await f.manager.prepareSettings({ backendId: "codex", providerId: "openai", accountKey: ACCOUNT, expectedRevision: view.settingsRevision, settings: null }, () => {});
    f.store.transaction(restore); expect((await f.read()).customized).toBe(false);
  });

  it("defaults automation off and never takes over a manual unknown attempt", async () => {
    const f = fixture(); await f.manager.checkAutomatic(); expect(f.requests).toEqual([]);
    const view = await f.read(), offer = view.defaultOffer!, operationId = f.claim(offer.offerId);
    f.onConsume = () => { throw unknown(); };
    await expect(f.manager.consume(request(offer.offerId), operationId, () => {})).rejects.toBeDefined();
    const save = await f.manager.prepareSettings({ backendId: "codex", providerId: "openai", accountKey: ACCOUNT, expectedRevision: 0n,
      settings: { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true } }, () => {}); f.store.transaction(save);
    await f.manager.checkAutomatic(); expect(f.requests).toHaveLength(1);
    expect(f.store.listOperations().some(operation => operation.kind === "automaticProviderAccountReset")).toBe(false);
  });

  it("recovers its own automatic unknown attempt with the original key and records a known receipt before refreshing waiters", async () => {
    const f = fixture(), save = await f.manager.prepareSettings({ backendId: "codex", providerId: "openai", accountKey: ACCOUNT, expectedRevision: 0n,
      settings: { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true } }, () => {}); f.store.transaction(save);
    f.onConsume = () => { throw unknown(); }; await f.manager.checkAutomatic(); expect(f.requests).toHaveLength(1);
    const original = f.requests[0]!; await f.restart(); f.advance(30_001); f.onConsume = () => {
      const reset = { usedPercent: 0, windowMinutes: 10080, resetAt: NOW + 5 * 86_400_000 };
      f.facts = { ...f.facts, usage: { ...f.facts.usage, secondaryWindow: reset }, ordinaryQuota: { secondaryWindow: reset, creditsDepleted: false } };
    };
    await f.manager.checkAutomatic(); expect(f.requests).toEqual([original, original]); expect(f.restored).toHaveBeenCalled();
    const operation = f.store.getOperation(`provider-account-reset:${original.idempotencyKey}`);
    expect(operation.status).toBe("completed"); expect(operation.response).toMatchObject({ providerAccountReset: { outcome: "reset" } });
    expect((await f.read()).lastAutomaticUse).toBe(NOW + 30_001);
  });

  it("uses only the ordinary weekly bucket for low-quota rules and requires actual future usage for expiry rules", () => {
    const facts = snapshot(), settings = { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true, expiring: false };
    expect(shouldAutomaticallyResetAccount(facts, settings, undefined, NOW)).toBe(true);
    expect(shouldAutomaticallyResetAccount({ ...facts, ordinaryQuota: undefined }, settings, undefined, NOW)).toBe(false);
    expect(shouldAutomaticallyResetAccount({ ...facts, ordinaryQuota: { ...facts.ordinaryQuota!, creditsDepleted: true } }, settings, undefined, NOW)).toBe(false);
    expect(shouldAutomaticallyResetAccount(facts, { ...settings, minimumDays: 6 }, undefined, NOW)).toBe(false);
    const unused = { ...facts, usage: { providerId: "openai", observedAt: NOW, primaryWindow: { usedPercent: 0, resetAt: NOW + 1000 } }, ordinaryQuota: undefined };
    expect(shouldAutomaticallyResetAccount(unused, { ...settings, expiring: true }, NOW + 500, NOW)).toBe(false);
    expect(shouldAutomaticallyResetAccount(facts, { ...settings, lowQuota: false, expiring: true }, NOW + 3_600_000, NOW)).toBe(true);
    expect(shouldAutomaticallyResetAccount(facts, { ...settings, lowQuota: false, expiring: true }, NOW + 3_600_001, NOW)).toBe(false);
  });

  it("restores each waiting model from its own longest matching quota bucket and never borrows another model's windows", () => {
    const facts = snapshot(), window = (usedPercent: number) => ({ usedPercent, resetAt: NOW + 60_000 });
    const quota = { ...facts, usage: { ...facts.usage, buckets: [
      { id: "codex", displayName: "Codex", primaryWindow: window(0) },
      { id: "short", displayName: "GPT-5.3-Codex", primaryWindow: window(100) },
      { id: "spark", displayName: "GPT-5.3-Codex-Spark", primaryWindow: window(0) }
    ] } };
    expect(accountResetQuotaRestored(quota, "gpt-5.3-codex-spark")).toBe(true);
    expect(accountResetQuotaRestored(quota, "gpt-5.3-codex")).toBe(false);
    expect(accountResetQuotaRestored(quota, "unrelated-model")).toBe(true);
    expect(accountResetQuotaRestored({ ...quota, usage: { ...quota.usage, buckets: quota.usage.buckets.slice(1) } }, "unrelated-model")).toBe(false);
    expect(accountResetQuotaRestored({ ...facts, usage: { ...facts.usage, secondaryWindow: { usedPercent: 100, resetAt: NOW - 1 } } })).toBe(true);
  });
});
