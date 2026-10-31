import { describe, expect, it, vi } from "vitest";
import { accountBalanceIntegration, parseDeepSeekBalance, parseZhipuBalance, ProviderAccountBalanceProvider, type AccountBalanceIdentity } from "./provider-account-balance.js";

const balance = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "123456789.123456789", granted_balance: "0.000", topped_up_balance: "123456789.123456789" }] };
function fixture(baseUrl = "https://api.deepseek.com/v1") {
  let now = 1_800_000_000_000;
  let identity: AccountBalanceIdentity | undefined = { backendId: "pi", providerId: "provider", key: "account-one", reference: "ref-one", native: false, integration: accountBalanceIntegration(baseUrl)! };
  const credentials = { describeAccountBalance: vi.fn((backendId: string, providerId: string) => identity?.backendId === backendId && identity.providerId === providerId ? identity : undefined),
    async useAccountBalanceCredential<T>(original: AccountBalanceIdentity, run: (key: string) => Promise<T>): Promise<T> { expect(original).toBe(identity); return await run("private-account-key"); } };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(balance));
  const reader = new ProviderAccountBalanceProvider(credentials, fetcher, () => now);
  return { reader, fetcher, credentials, advance: (ms: number) => { now += ms; }, replace: (next?: AccountBalanceIdentity) => { identity = next; }, identity: () => identity!, now: () => now };
}
describe("official API-key account data", () => {
  it.each(["https://proxy.example/v1", "https://api.deepseek.com.evil.test/v1", "http://api.deepseek.com", "https://name@api.deepseek.com", "https://api.deepseek.com:444/v1", "https://open.bigmodel.cn/api/paas/v4", "https://api.z.ai/api/paas/v4", "https://api.z.ai/api/anthropic-unrelated"])("does not claim %s", url => {
    expect(accountBalanceIntegration(url)).toBeUndefined();
  });
  it("parses balances without numeric rounding and rejects missing, malformed or invented values", () => {
    expect(parseDeepSeekBalance(balance)).toMatchObject({ kind: "deepseek", balances: [{ totalBalance: "123456789.123456789", grantedBalance: "0.000" }] });
    for (const bad of [{}, { ...balance, is_available: "true" }, { ...balance, balance_infos: [{ currency: "CNY", total_balance: 0 }] }]) expect(() => parseDeepSeekBalance(bad)).toThrow();
  });
  it("uses explicit plan units even when the weekly window resets first, and sorts unclassified windows", () => {
    expect(parseZhipuBalance({ data: { level: "pro", limits: [
      { type: "TOKENS_LIMIT", unit: 6, percentage: 25, nextResetTime: 1000 },
      { type: "CREDIT_LIMIT", unit: 3, percentage: 105, nextResetTime: 2000 }
    ] } })).toEqual({ kind: "zhipu", noPlan: false, level: "pro", fiveHour: { usedPercent: 100, resetAt: 2000 }, weekly: { usedPercent: 25, resetAt: 1000 } });
    expect(parseZhipuBalance({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 42, nextResetTime: 2000 }, { type: "TOKENS_LIMIT", percentage: 0 }] } }))
      .toMatchObject({ fiveHour: { usedPercent: 0 }, weekly: { usedPercent: 42, resetAt: 2000 } });
    expect(parseZhipuBalance({ success: false, msg: "no coding plan / not subscribed" })).toEqual({ kind: "zhipu", noPlan: true });
    expect(() => parseZhipuBalance({ success: false, msg: "other business error" })).toThrow();
  });
  it("uses only the fixed official endpoint, caches normal reads, and throttles manual refresh", async () => {
    const f = fixture();
    expect(await f.reader.get("pi", "provider")).toMatchObject({ status: "ready", snapshot: { kind: "deepseek" }, dashboardUrl: "https://platform.deepseek.com/usage" });
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith("https://api.deepseek.com/user/balance", expect.objectContaining({ method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json", authorization: "Bearer private-account-key" } }));
    await f.reader.get("pi", "provider"); await f.reader.get("pi", "provider", true); expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(15_000); await f.reader.get("pi", "provider", true); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await f.reader.get("pi", "provider"))).not.toContain("private-account-key"); f.reader.dispose();
  });
  it.each(["https://open.bigmodel.cn/api/anthropic", "https://api.z.ai/api/coding/paas/v4"])("uses the matching region and bare API key for %s", async url => {
    const f = fixture(url); f.fetcher.mockResolvedValueOnce(Response.json({ data: { limits: [] } }));
    expect(await f.reader.get("pi", "provider")).toMatchObject({ status: "ready", snapshot: { kind: "zhipu", noPlan: false } });
    expect(f.fetcher).toHaveBeenCalledWith(`${new URL(url).origin}/api/monitor/usage/quota/limit`, expect.objectContaining({ headers: expect.objectContaining({ authorization: "private-account-key" }) }));
    f.reader.dispose();
  });
  it("keeps the last observation after upstream failure and respects the entire retry window", async () => {
    const f = fixture(); const first = await f.reader.get("pi", "provider"); f.advance(300_001);
    f.fetcher.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    expect(await f.reader.get("pi", "provider")).toMatchObject({ status: "ready", error: "rate-limited", stale: true, observedAt: first.observedAt, retryAt: f.now() + 120_000 });
    f.advance(119_999); await f.reader.get("pi", "provider", true); expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(1); expect(await f.reader.get("pi", "provider", true)).toMatchObject({ status: "ready", stale: false }); expect(f.fetcher).toHaveBeenCalledTimes(3); f.reader.dispose();
  });
  it("drops cached and late data when the exact key changes, and isolates Backend identities", async () => {
    const f = fixture(); await f.reader.get("pi", "provider");
    expect(await f.reader.get("claude", "provider")).toEqual({ status: "unsupported" });
    f.advance(300_001); let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.reader.get("pi", "provider");
    f.replace({ ...f.identity(), key: "account-two", reference: "ref-two" });
    expect(await f.reader.get("pi", "provider")).toMatchObject({ status: "ready", stale: false });
    finish(Response.json({ ...balance, balance_infos: [{ ...balance.balance_infos[0], total_balance: "999999" }] }));
    expect((await pending).snapshot).toBeUndefined();
    expect(JSON.stringify(await f.reader.get("pi", "provider"))).not.toContain("999999");
    f.replace(); expect(await f.reader.get("pi", "provider")).toEqual({ status: "unsupported" }); f.reader.dispose();
  });
  it("shares a pending query until its last reader retires, then ignores the late response", async () => {
    const f = fixture(); let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = new AbortController(), two = new AbortController();
    const first = f.reader.get("pi", "provider", false, one.signal), second = f.reader.get("pi", "provider", false, two.signal);
    one.abort(); await expect(first).rejects.toThrow(); expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    two.abort(); await expect(second).rejects.toThrow(); expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(Response.json(balance)); expect(await f.reader.get("pi", "provider")).toMatchObject({ status: "ready" }); expect(f.fetcher).toHaveBeenCalledTimes(2); f.reader.dispose();
  });
  it.each([401, 403, 500, 400])("classifies HTTP %s without leaking the raw response", async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("private server diagnostics", { status }));
    const result = await f.reader.get("pi", "provider");
    expect(result).toMatchObject({ status: "unavailable", error: status < 404 ? status === 400 ? "invalid-response" : "auth" : "server" });
    expect(JSON.stringify(result)).not.toContain("private"); f.reader.dispose();
  });
  it("rejects oversized bodies and redirected results", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("x".repeat(65_537)));
    expect(await f.reader.get("pi", "provider")).toMatchObject({ error: "invalid-response" });
    f.advance(15_000); const redirected = Response.json(balance); Object.defineProperty(redirected, "redirected", { value: true }); f.fetcher.mockResolvedValueOnce(redirected);
    expect(await f.reader.get("pi", "provider", true)).toMatchObject({ error: "network" }); f.reader.dispose();
  });
});
