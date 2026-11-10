import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackendAdapter } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { FakeCodexAppServer, type ScriptedRpcTransport } from "./testing.js";
import type { CodexHostedAuthenticationAuthority } from "./hosted-authentication.js";
import { remoteRpcFault } from "./errors.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

function tokens(account = "owned-account", revision = "initial", subject = "owned-user") {
  const jwt = `test.${Buffer.from(JSON.stringify({ sub: subject, revision, exp: 4102444800,
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" } })).toString("base64url")}.not-a-signature`;
  return { id_token: jwt, access_token: jwt, refresh_token: "private-owner-refresh-token", account_id: account };
}
async function fixture(apiKey = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-account-owner-"))), authPath = join(home, "auth.json");
  await writeFile(authPath, JSON.stringify(apiKey ? { OPENAI_API_KEY: "private-original-api-key" } : { auth_mode: "chatgpt", tokens: tokens() }));
  const fake = new FakeCodexAppServer(); fake.codexHome = home;
  const resetFake = new FakeCodexAppServer(); resetFake.codexHome = home;
  resetFake.reviewConfig = { cli_auth_credentials_store: "ephemeral" };
  resetFake.accountRateLimits["rateLimitResetCredits"] = { availableCount: 1, credits: null };
  const resetTransports: ScriptedRpcTransport[] = [];
  const host = new AppServerHost({ transportFactory: () => fake.createTransport() });
  const adapter = new CodexBackendAdapter({ host, instanceGeneration: 1, appServer: {
    transportFactory: () => { const transport = resetFake.createTransport(); resetTransports.push(transport); return transport; }
  } });
  cleanups.push(async () => { await adapter.dispose(); await host.shutdown(); await rm(home, { recursive: true, force: true }); });
  return { home, authPath, fake, resetFake, resetTransports, host, adapter };
}
function oauth(authority: CodexHostedAuthenticationAuthority) {
  if (authority.kind !== "chatgpt") throw new Error("Expected native ChatGPT authority."); return authority;
}

describe("original native account authority", () => {
  it("preserves a known reset receipt and retains an unclosed control SDK before admitting another request", async () => {
    const f = await fixture(), facts = await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    let canClose = false;
    const createTransport = f.resetFake.createTransport.bind(f.resetFake);
    vi.spyOn(f.resetFake, "createTransport").mockImplementation(() => {
      const transport = createTransport(), close = transport.close.bind(transport);
      transport.close = async () => { if (!canClose) throw new Error("Process exit is unconfirmed"); await close(); };
      return transport;
    });
    await expect(f.adapter.consumeAccountRateLimitReset({ providerId: "openai", accountKey: facts.accountKey,
      idempotencyKey: "bf748327-9ad7-47db-b9d0-d48571c494ac", assertCurrent() {} })).resolves.toBe("reset");
    expect(f.resetTransports[1]!.running).toBe(true);
    await expect(f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} }))
      .rejects.toMatchObject({ publicError: { code: "CODEX_ACCOUNT_CONTROL_BUSY" } });
    expect(f.resetTransports).toHaveLength(2);
    canClose = true;
    await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    expect(f.resetTransports).toHaveLength(3); expect(f.resetTransports.every(transport => !transport.running)).toBe(true);
    expect(f.resetTransports.flatMap(transport => transport.requests).filter(request => request.method === "account/rateLimitResetCredit/consume")).toHaveLength(1);
  });

  it("serializes account control-plane processes and retires an aborted queued read before starting another SDK", async () => {
    const f = await fixture(); let finish!: () => void, reads = 0;
    const gate = new Promise<void>(resolve => { finish = resolve; }), createTransport = f.resetFake.createTransport.bind(f.resetFake);
    vi.spyOn(f.resetFake, "createTransport").mockImplementation(() => {
      const transport = createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => { if (method === "account/rateLimits/read") { reads++; await gate; } return request(method, params, options); };
      return transport;
    });
    const first = f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    await vi.waitFor(() => expect(reads).toBe(1));
    const abort = new AbortController(), second = expect(f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {}, signal: abort.signal })).rejects.toThrow();
    abort.abort(); expect(f.resetTransports).toHaveLength(1); finish(); await first; await second;
    expect(f.resetTransports).toHaveLength(1); expect(f.resetTransports[0]!.running).toBe(false);
  });

  it("renews an expired read through the original SDK once, then starts a freshly authenticated control-plane host", async () => {
    const f = await fixture(); await f.adapter.captureHostedAuthentication();
    const original = f.fake.transport!, request = original.request.bind(original);
    original.request = async (method, params, options) => {
      if (method === "account/read" && params && typeof params === "object" && !Array.isArray(params) && params["refreshToken"] === true) {
        await writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: tokens("owned-account", "refreshed") }));
      }
      return request(method, params, options);
    };
    let reads = 0; const createTransport = f.resetFake.createTransport.bind(f.resetFake);
    vi.spyOn(f.resetFake, "createTransport").mockImplementation(() => {
      const transport = createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => {
        if (method === "account/rateLimits/read" && reads++ === 0) throw remoteRpcFault(-32000, "HTTP 401 token_expired", undefined, undefined, method);
        return request(method, params, options);
      };
      return transport;
    });
    await expect(f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} })).resolves.toMatchObject({ credits: { availableCount: 1 } });
    expect(original.requests.filter(value => value.method === "account/read")).toHaveLength(1);
    expect(f.resetTransports).toHaveLength(2); expect(f.resetTransports.every(transport => !transport.running)).toBe(true);
    expect(f.resetTransports[1]!.requests.find(value => value.method === "account/login/start")?.params)
      .toMatchObject({ accessToken: tokens("owned-account", "refreshed").access_token, chatgptAccountId: "owned-account" });
    expect(f.resetTransports.flatMap(transport => transport.requests).some(value => value.method === "account/rateLimitResetCredit/consume")).toBe(false);
  });

  it("classifies only a correlated expired quota read for renewal and never retains native error text", () => {
    const error = remoteRpcFault(-32000, "HTTP 401 token_expired private-native-text", undefined, undefined, "account/rateLimits/read");
    expect(error.accountTokenExpired).toBe(true); expect(error.message).not.toContain("private-native-text");
    for (const message of ["HTTP 401 token_revoked", "HTTP 401 token_expired refresh_token_reused", "HTTP 500 token_expired", "HTTP 401 unauthorized"]) {
      expect(remoteRpcFault(-32000, message, undefined, undefined, "account/rateLimits/read").accountTokenExpired).toBe(false);
    }
    expect(remoteRpcFault(-32000, "HTTP 401 token_expired", undefined, undefined, "account/rateLimitResetCredit/consume").accountTokenExpired).toBe(false);
  });

  it("reads native reset credit details without exposing credentials and distinguishes the ordinary quota bucket", async () => {
    const f = await fixture(), at = Date.now(), seconds = Math.floor(at / 1000);
    f.resetFake.accountRateLimits = { rateLimits: { primary: { usedPercent: 30, windowMinutes: 300, resetsAt: seconds + 60 } },
      rateLimitsByLimitId: { codex_model: { secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: seconds + 500000 } },
        __default__: { secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: seconds + 500000 } },
        codex: { secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt: seconds + 500000 } } },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: "private-credit-id", resetType: "codexRateLimits", status: "available",
        grantedAt: seconds - 10, expiresAt: seconds + 1800, title: "Quota reset", description: "One account reset" }] } };
    const facts = await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    expect(facts.accountKey).toMatch(/^[a-f0-9]{64}$/u); expect(facts.accountLabel).toBe("…ccount");
    expect(facts.ordinaryQuota).toMatchObject({ secondaryWindow: { usedPercent: 20 }, creditsDepleted: false });
    expect(facts.credits).toEqual({ availableCount: 1, details: [{ creditId: "private-credit-id", resetType: "codexRateLimits", status: "available",
      grantedAt: (seconds - 10) * 1000, expiresAt: (seconds + 1800) * 1000, title: "Quota reset", description: "One account reset" }] });
    expect(JSON.stringify(facts)).not.toContain(tokens().access_token); expect(JSON.stringify(facts)).not.toContain("owned-account");
    expect(f.fake.threads.size).toBe(0);
    expect(f.fake.transport!.requests.some(request => request.method.startsWith("account/rateLimit"))).toBe(false);
    expect(f.resetTransports[0]!.requests.find(request => request.method === "account/login/start")?.params)
      .toMatchObject({ type: "chatgptAuthTokens", chatgptAccountId: "owned-account", accessToken: tokens().access_token });
    expect(f.resetTransports[0]!.running).toBe(false);
    expect(JSON.parse(await readFile(f.authPath, "utf8")).tokens.refresh_token).toBe("private-owner-refresh-token");
    f.resetFake.accountRateLimits["rateLimitResetCredits"] = { availableCount: 1, credits: null };
    expect((await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} })).credits).toEqual({ availableCount: 1 });
    f.resetFake.accountRateLimits["rateLimitResetCredits"] = { availableCount: 1, credits: [] };
    expect((await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} })).credits).toEqual({ availableCount: 1, details: [] });
  });

  it("reuses the exact native reset parameters after an ambiguous response and rejects another account before dispatch", async () => {
    const f = await fixture();
    f.resetFake.accountRateLimits["rateLimitResetCredits"] = { availableCount: 1, credits: [{ id: "private-credit-id", resetType: "codexRateLimits", status: "available", grantedAt: 1_700_000_000, expiresAt: null }] };
    const facts = await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    const input = { providerId: "openai", accountKey: facts.accountKey, idempotencyKey: "e9eb179f-e530-412a-9c98-9105e4623e20", creditId: "private-credit-id", assertCurrent() {} };
    f.resetFake.loseNextResetCreditResponse = true;
    await expect(f.adapter.consumeAccountRateLimitReset(input)).rejects.toMatchObject({ publicError: { stateMayHaveChanged: true } });
    f.resetFake.resetCreditOutcome = "alreadyRedeemed";
    await expect(f.adapter.consumeAccountRateLimitReset(input)).resolves.toBe("alreadyRedeemed");
    const requests = f.resetTransports.flatMap(transport => transport.requests).filter(request => request.method === "account/rateLimitResetCredit/consume");
    expect(requests.map(request => request.params)).toEqual([{ idempotencyKey: input.idempotencyKey, creditId: input.creditId }, { idempotencyKey: input.idempotencyKey, creditId: input.creditId }]);
    expect(requests.every(request => request.options.mutation && typeof request.options.beforeDispatchAsync === "function")).toBe(true);
    await writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: tokens("other-workspace") }));
    await expect(f.adapter.consumeAccountRateLimitReset(input)).rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(f.resetTransports.flatMap(transport => transport.requests).filter(request => request.method === "account/rateLimitResetCredit/consume")).toHaveLength(2);
    expect(f.fake.threads.size).toBe(0);
  });

  it.each(["account", "authority", "login"] as const)("checks the original reset %s at the native write queue head", async boundary => {
    const f = await fixture(); let current = true;
    const assertCurrent = () => { if (!current) throw new Error("The original reset authority ended"); };
    const facts = await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent });
    const createTransport = f.resetFake.createTransport.bind(f.resetFake);
    vi.spyOn(f.resetFake, "createTransport").mockImplementation(() => {
      const transport = createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => {
        if (method === "account/rateLimitResetCredit/consume") {
          if (boundary === "account") await writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: tokens("other-workspace") }));
          else if (boundary === "login") await f.adapter.beginLogin({ method: "oauth_browser" });
          else current = false;
        }
        return request(method, params, options);
      };
      return transport;
    });
    await expect(f.adapter.consumeAccountRateLimitReset({ providerId: "openai", accountKey: facts.accountKey, idempotencyKey: "b601fd8c-e4b1-46dc-abfe-ac884219470a", assertCurrent }))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: false } });
    expect(f.resetTransports.flatMap(transport => transport.requests).filter(request => request.method === "account/rateLimitResetCredit/consume")).toHaveLength(0);
  });

  it("drops a reset result when the account changes after the original native response", async () => {
    const f = await fixture(), facts = await f.adapter.readAccountRateLimitResets({ providerId: "openai", assertCurrent() {} });
    const createTransport = f.resetFake.createTransport.bind(f.resetFake);
    vi.spyOn(f.resetFake, "createTransport").mockImplementation(() => {
      const transport = createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => {
        const result = await request(method, params, options);
        if (method === "account/rateLimitResetCredit/consume") await writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: tokens("other-workspace") }));
        return result;
      };
      return transport;
    });
    await expect(f.adapter.consumeAccountRateLimitReset({ providerId: "openai", accountKey: facts.accountKey, idempotencyKey: "13e2e506-aec2-46a9-8b4d-381124abdb3b", assertCurrent() {} }))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: true } });
    expect(f.resetTransports.flatMap(transport => transport.requests).filter(request => request.method === "account/rateLimitResetCredit/consume")).toHaveLength(1);
  });

  it("coalesces concurrent refreshes through the original SDK and never hands out the refresh token", async () => {
    const f = await fixture(), first = oauth(await f.adapter.captureHostedAuthentication()), second = oauth(await f.adapter.captureHostedAuthentication());
    const initial = await first.readTokens(false); expect(initial.accessToken).toBe(tokens().access_token);
    expect(JSON.stringify(initial)).not.toContain("private-owner-refresh-token");
    const transport = f.fake.transport!, request = transport.request.bind(transport);
    let complete!: () => void; const refreshes = vi.fn(async () => {
      await new Promise<void>(resolve => { complete = resolve; });
      await writeFile(f.authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: tokens("owned-account", "refreshed") }));
    });
    transport.request = async (method, params, options) => {
      if (method === "account/read" && params && typeof params === "object" && !Array.isArray(params) && params["refreshToken"] === true) await refreshes();
      return request(method, params, options);
    };
    const a = first.readTokens(true, initial.accessToken), b = second.readTokens(true, initial.accessToken);
    await vi.waitFor(() => expect(refreshes).toHaveBeenCalledTimes(1)); complete();
    const result = await Promise.all([a, b]);
    expect(result).toEqual([expect.objectContaining({ accessToken: tokens("owned-account", "refreshed").access_token }),
      expect.objectContaining({ accessToken: tokens("owned-account", "refreshed").access_token })]);
    expect(refreshes).toHaveBeenCalledTimes(1);
    await first.readTokens(true, initial.accessToken); expect(refreshes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.authPath, "utf8")).tokens.refresh_token).toBe("private-owner-refresh-token");
    expect(transport.requests.filter(value => value.method === "account/login/start")).toEqual([]);
  });

  it.each(["account", "subject"] as const)("rejects an external %s replacement before requesting refresh", async changed => {
    const f = await fixture(), authority = oauth(await f.adapter.captureHostedAuthentication()), original = await authority.readTokens(false);
    await writeFile(f.authPath, JSON.stringify({ tokens: tokens(changed === "account" ? "foreign-account" : "owned-account", "replaced", changed === "subject" ? "foreign-user" : "owned-user") }));
    await expect(authority.readTokens(true, original.accessToken)).rejects.toThrow("account changed");
    expect(f.fake.transport!.requests.filter(value => value.method === "account/read")).toEqual([]);
  });

  it("rejects a refresh whose original login is revoked while the original SDK is answering", async () => {
    const f = await fixture(), authority = oauth(await f.adapter.captureHostedAuthentication()), original = await authority.readTokens(false);
    const transport = f.fake.transport!, request = transport.request.bind(transport); let complete!: () => void;
    const refreshes = vi.fn(async () => { await new Promise<void>(resolve => { complete = resolve; }); });
    transport.request = async (method, params, options) => {
      if (method === "account/read") await refreshes(); return request(method, params, options);
    };
    const refreshing = expect(authority.readTokens(true, original.accessToken)).rejects.toThrow();
    await vi.waitFor(() => expect(refreshes).toHaveBeenCalledTimes(1)); await f.adapter.logout(); complete(); await refreshing;
    await expect(authority.readTokens(false)).rejects.toThrow();
    expect(refreshes).toHaveBeenCalledTimes(1);
  });

  it("rejects failed refreshes instead of replaying the rejected access token", async () => {
    const f = await fixture(), authority = oauth(await f.adapter.captureHostedAuthentication()), original = await authority.readTokens(false);
    await expect(authority.readTokens(true, original.accessToken)).rejects.toThrow("refresh is unavailable");
    expect(f.fake.transport!.requests.filter(value => value.method === "account/read")).toHaveLength(1);
  });

  it("pins native API keys and revokes an old reader when the original Backend closes", async () => {
    const f = await fixture(true), authority = await f.adapter.captureHostedAuthentication();
    if (authority.kind !== "api_key") throw new Error("Expected native API key authority.");
    expect(await authority.readApiKey()).toBe("private-original-api-key");
    await writeFile(f.authPath, JSON.stringify({ OPENAI_API_KEY: "private-replacement-api-key" }));
    await expect(authority.readApiKey()).rejects.toThrow("account changed");
    const replacement = await f.adapter.captureHostedAuthentication(); await f.adapter.dispose();
    if (replacement.kind !== "api_key") throw new Error("Expected replacement native API key authority.");
    await expect(replacement.readApiKey()).rejects.toThrow();
  });
});
