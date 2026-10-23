import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackendAdapter } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { FakeCodexAppServer } from "./testing.js";
import type { CodexHostedAuthenticationAuthority } from "./hosted-authentication.js";

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
  const host = new AppServerHost({ transportFactory: () => fake.createTransport() });
  const adapter = new CodexBackendAdapter({ host, instanceGeneration: 1 });
  cleanups.push(async () => { await adapter.dispose(); await host.shutdown(); await rm(home, { recursive: true, force: true }); });
  return { home, authPath, fake, host, adapter };
}
function oauth(authority: CodexHostedAuthenticationAuthority) {
  if (authority.kind !== "chatgpt") throw new Error("Expected native ChatGPT authority."); return authority;
}

describe("original native account authority", () => {
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
