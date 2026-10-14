import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";
import { ClaudeAccountUsageCache, parseClaudeAccountUsage } from "./account-usage.js";
import { ClaudeCodeOAuthAccount } from "./oauth-account.js";
import { CLAUDE_AGENT_SDK_CLI_VERSION, CLAUDE_AGENT_SDK_VERSION, type ClaudeSdkRuntime } from "./sdk-runtime.js";

describe("native account usage", () => {
  it("preserves known native windows, model scopes and extra usage without inventing absent values", () => {
    expect(parseClaudeAccountUsage({ rateLimitsAvailable: true, subscriptionType: "max", rateLimits: {
      five_hour: { utilization: 23, resets_at: "2026-10-16T00:00:00Z" },
      seven_day: { utilization: 40, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 65, resets_at: null }],
      seven_day_opus: { utilization: 12, resets_at: null },
      extra_usage: { is_enabled: true, utilization: null, used_credits: 500, monthly_limit: null }
    } }, "anthropic", 100)).toEqual({ providerId: "anthropic", observedAt: 100, planType: "max",
      primaryWindow: { usedPercent: 23, resetAt: Date.parse("2026-10-16T00:00:00Z"), windowMinutes: 300 },
      secondaryWindow: { usedPercent: 40, windowMinutes: 10_080 }, modelWindows: [
        { displayName: "Fable", window: { usedPercent: 65, windowMinutes: 10_080 } },
        { displayName: "Opus", window: { usedPercent: 12, windowMinutes: 10_080 } }
      ], extraUsage: { enabled: true, usedCredits: 500 } });
  });

  it("uses server meter kind and scope while ignoring unknown meters and null utilization", () => {
    const usage = parseClaudeAccountUsage({ rateLimitsAvailable: true, rateLimits: { limits: [
      { kind: "session", percent: 10, severity: "warning", resets_at: null },
      { kind: "weekly_scoped", percent: 20, scope: { model: { display_name: "Opus", id: "exact-model" } } },
      { kind: "future", percent: 90 }, { kind: "weekly_all", percent: null }
    ], seven_day: { utilization: null } } }, "anthropic", 1);
    expect(usage.primaryWindow).toEqual({ usedPercent: 10, windowMinutes: 300, severity: "warning" });
    expect(usage.modelWindows).toEqual([{ modelId: "exact-model", displayName: "Opus", window: { usedPercent: 20, windowMinutes: 10_080 } }]);
    expect(usage.secondaryWindow).toBeUndefined();
    expect(() => parseClaudeAccountUsage({ rateLimitsAvailable: true, rateLimits: {} }, "anthropic", 1)).toThrow("unavailable");
    expect(parseClaudeAccountUsage({ rateLimitsAvailable: false, rateLimits: null }, "anthropic", 1)).toEqual({ providerId: "anthropic", observedAt: 1 });
  });

  it("keeps the server model scope over same-family native fallback windows", () => {
    const usage = parseClaudeAccountUsage({ rateLimitsAvailable: true, rateLimits: {
      limits: [{ kind: "weekly_scoped", percent: 20, scope: { model: { display_name: "Claude Opus 4.8", id: "claude-opus-4-8[1m]" } } }],
      model_scoped: [{ display_name: "Opus", utilization: 30 }],
      seven_day_opus: { utilization: 40 }, seven_day_sonnet: { utilization: 50 }
    } }, "anthropic", 1);
    expect(usage.modelWindows).toEqual([
      { displayName: "Claude Opus 4.8", modelId: "claude-opus-4-8[1m]", window: { usedPercent: 20, windowMinutes: 10_080 } },
      { displayName: "Sonnet", window: { usedPercent: 50, windowMinutes: 10_080 } }
    ]);
  });

  it("deduplicates concurrent reads, throttles and retains same-account facts on a failed refresh", async () => {
    let now = 1, finish!: (value: { providerId: string; observedAt: number }) => void;
    const fetchSnapshot = vi.fn(() => new Promise<{ providerId: string; observedAt: number }>(resolve => { finish = resolve; }));
    const cache = new ClaudeAccountUsageCache({ readIdentity: async () => "account-a", fetchSnapshot, now: () => now });
    const first = cache.read(), second = cache.read();
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(1));
    finish({ providerId: "anthropic", observedAt: 1 });
    expect(await first).toEqual(await second);
    expect(await cache.read()).toEqual({ providerId: "anthropic", observedAt: 1 });
    now += 180_000;
    fetchSnapshot.mockRejectedValueOnce(new Error("private native error"));
    expect(await cache.read()).toEqual({ providerId: "anthropic", observedAt: 1 });
    now += 100;
    expect(await cache.read()).toEqual({ providerId: "anthropic", observedAt: 1 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("discards an in-flight result after account replacement or revocation", async () => {
    let identity: string | undefined = "account-a", finish!: (value: { providerId: string; observedAt: number }) => void;
    const fetchSnapshot = vi.fn(() => new Promise<{ providerId: string; observedAt: number }>(resolve => { finish = resolve; }));
    const cache = new ClaudeAccountUsageCache({ readIdentity: async () => identity, fetchSnapshot, now: () => 1 });
    const first = cache.read();
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(1));
    identity = undefined;
    expect(await cache.read()).toBeUndefined();
    finish({ providerId: "anthropic", observedAt: 1 });
    expect(await first).toBeUndefined();
    identity = "account-b";
    fetchSnapshot.mockRejectedValueOnce(new Error("private failure"));
    await expect(cache.read()).rejects.toThrow("Native account usage is unavailable");
  });

  it("merges actual native window fractions without dropping scoped quota or accepting another account", async () => {
    let identity = "account-a";
    const fetchSnapshot = vi.fn().mockResolvedValueOnce({ providerId: "anthropic", observedAt: 100,
      planType: "max", primaryWindow: { usedPercent: 10, windowMinutes: 300 },
      modelWindows: [{ displayName: "Scoped model", window: { usedPercent: 40, windowMinutes: 10_080 } }],
      extraUsage: { enabled: true, usedCredits: 30 }
    }).mockResolvedValueOnce({ providerId: "anthropic", observedAt: 200 });
    const cache = new ClaudeAccountUsageCache({ readIdentity: async () => identity, fetchSnapshot, now: () => 100 });
    await cache.read();
    await cache.observeNative("account-a", "anthropic", { rateLimitType: "five_hour", utilization: 0.25,
      resetsAt: 1_800_000_000, status: "allowed_warning" }, 110);
    expect(await cache.read()).toMatchObject({ planType: "max", observedAt: 110,
      primaryWindow: { usedPercent: 25, resetAt: 1_800_000_000_000 }, limitReached: false,
      modelWindows: [{ displayName: "Scoped model" }], extraUsage: { enabled: true, usedCredits: 30 }
    });
    identity = "account-b";
    await cache.observeNative("account-a", "anthropic", { rateLimitType: "five_hour", utilization: 1, status: "rejected" }, 120);
    expect(await cache.read()).toEqual({ providerId: "anthropic", observedAt: 200 });
  });

  it("gives an owned credential a private identity and replaces it on credential change", async () => {
    let serialized: string | undefined = credential("account-a");
    const account = new ClaudeCodeOAuthAccount({ credentials: {
      readSerialized: async () => serialized, compareAndSet: async () => false,
      restoreExact: async () => false, deleteExact: async () => { serialized = undefined; return true; }
    } });
    try {
      const first = await account.readUsageIdentity();
      expect(first).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await account.readUsageIdentity()).toBe(first);
      serialized = credential("account-b");
      expect(await account.readUsageIdentity()).not.toBe(first);
      serialized = undefined;
      expect(await account.readUsageIdentity()).toBeUndefined();
    } finally { await account.dispose(); }
  });

  it("reaches the native reader from the production Adapter and keeps raw credentials out of its snapshot", async () => {
    let serialized: string | undefined = credential("account-a");
    const readAccountUsage = vi.fn(async () => ({ rateLimitsAvailable: true, rateLimits: { five_hour: { utilization: 35 } } }));
    const runtime = {
      packageVersion: CLAUDE_AGENT_SDK_VERSION, bundledCliVersion: CLAUDE_AGENT_SDK_CLI_VERSION,
      supportsAccountUsage: true, readAccountUsage,
      probe: async () => ({ installed: true, packageVersion: CLAUDE_AGENT_SDK_VERSION, cliVersion: CLAUDE_AGENT_SDK_CLI_VERSION,
        initialization: { models: [], account: { subscriptionType: "max" }, commands: [], agents: [], outputStyle: "default", availableOutputStyles: [] } }),
      closeSessionOperations: async () => undefined,
      retireOwnedProcesses: async () => undefined
    } as unknown as ClaudeSdkRuntime;
    const adapter = new ClaudeCodeAdapter({ instanceGeneration: 1, runtime, credentialPort: {
      readSerialized: async () => serialized, compareAndSet: async () => false, restoreExact: async () => false,
      deleteExact: async () => { serialized = undefined; return true; }
    } });
    try {
      expect((await adapter.describe()).capabilities.get("provider.account_usage")?.supported).toBe(true);
      const value = await adapter.readAccountUsage("claude-code");
      expect(value.primaryWindow).toEqual({ usedPercent: 35, windowMinutes: 300 });
      expect(readAccountUsage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(value)).not.toContain("account-a");
      await adapter.logout();
      expect((await adapter.readAccountUsage("claude-code")).primaryWindow).toBeUndefined();
      expect(readAccountUsage).toHaveBeenCalledTimes(1);
    } finally { await adapter.dispose(); }
  });
});

function credential(identity: string): string {
  return JSON.stringify({ format: 1, type: "oauth", accessToken: `access-${identity}`, refreshToken: `refresh-${identity}`,
    expiresAt: Date.now() + 60 * 60_000, scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default" });
}
