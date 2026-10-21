import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { parseExtensionNetwork } from "./network-manifest.js";
import { prepareExtensionOAuth, refreshExtensionOAuth, scopedFetch, type ExtensionOAuthClient } from "./oauth-flow.js";

const network = (oauth: unknown = {}) => ({ hosts: ["auth.example.test", "api.example.test"], secrets: [{ key: "account", label: "Account", source: "oauth", inject: { header: "Authorization", format: "Bearer {value}" },
  oauth: { authorizeUrl: "https://auth.example.test/authorize", tokenUrl: "https://auth.example.test/token", ...(oauth as object) } }] });
const scope = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
function client(options: Record<string, unknown> = {}): ExtensionOAuthClient {
  const declaration = parseExtensionNetwork(network({ clientId: "public-client", ...options }));
  return { ...declaration.secrets![0]!.oauth!, clientId: "public-client", hosts: declaration.hosts };
}

it("validates the declared OAuth endpoints, scopes, identity and protocol-owned parameters", () => {
  const parsed = parseExtensionNetwork(network({ clientId: "public-client", clientSecret: "installed-app-value", scopes: ["mail.read", "mail.send"], pkce: true, scopeDelimiter: ",", redirectPort: 40870,
    extraAuthorizeParams: { access_type: "offline" }, identity: { url: "https://api.example.test/me", labelPath: "user.email", displayTemplate: "{team} · {user.name}", avatarPath: "user.picture" } }));
  expect(parsed.secrets![0]).toMatchObject({ source: "oauth", oauth: { scopes: ["mail.read", "mail.send"], identity: { labelPath: "user.email" } } });
  for (const invalid of [{ authorizeUrl: "http://auth.example.test/authorize" }, { tokenUrl: "https://other.example.test/token" }, { clientSecret: "unpaired-value" }, { clientId: "invalid client" },
    { scopes: ["read", "read"] }, { scopes: ["two scopes"] }, { pkce: "true" }, { redirectPort: 80 }, { extraAuthorizeParams: { state: "forged" } }, { tokenBroker: "external" },
    { identity: { url: "https://other.example.test/me", labelPath: "email" } }, { identity: { url: "https://api.example.test/me", labelPath: "email", displayTemplate: "static" } }]) {
    expect(() => parseExtensionNetwork(network(invalid))).toThrow();
  }
  const mixed = network(); Object.assign(mixed.secrets[0]!, { exchange: { url: "https://auth.example.test/token", bodyFormat: "key={value}", tokenPath: "token" } });
  expect(() => parseExtensionNetwork(mixed)).toThrow();
});

it("keeps the PKCE verifier private and exchanges a matching callback exactly once", async () => {
  const config = client({ scopes: ["mail.read"], clientSecret: "private-client-fixture" }), prepared = await prepareExtensionOAuth(config, scope());
  const url = new URL(prepared.offer.authorizeUrl), callback = new URL(prepared.offer.callbackUrl);
  expect(callback.hostname).toBe("127.0.0.1"); expect(callback.pathname).toBe("/callback"); expect(prepared.offer.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("scope")).toBe("mail.read");
  let receipt: URLSearchParams | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => { receipt = new URLSearchParams(String(init?.body)); return new Response(JSON.stringify({ access_token: "private-access-fixture", refresh_token: "private-refresh-fixture", expires_in: 120 })); });
  const result = await prepared.exchange({ state: prepared.offer.state, code: "private-code-fixture" }, fetchImpl as typeof fetch);
  expect(result).toMatchObject({ ok: true, tokens: { accessToken: "private-access-fixture", refreshToken: "private-refresh-fixture" } });
  expect(receipt!.get("redirect_uri")).toBe(prepared.offer.callbackUrl); expect(receipt!.get("client_secret")).toBe("private-client-fixture");
  expect(createHash("sha256").update(receipt!.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  expect(JSON.stringify(prepared.offer)).not.toContain(receipt!.get("code_verifier")!); expect(JSON.stringify(prepared.offer)).not.toContain("private-client-fixture");
  await expect(prepared.exchange({ state: prepared.offer.state, code: "other" }, fetchImpl as typeof fetch)).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledOnce();
});

it("rejects mismatched callbacks, retired owners and occupied ports without stopping another listener", async () => {
  const prepared = await prepareExtensionOAuth(client(), scope()), fetchImpl = vi.fn();
  await expect(prepared.exchange({ state: "wrong", code: "code" }, fetchImpl)).rejects.toThrow(); expect(fetchImpl).not.toHaveBeenCalled();
  let current = true, started!: () => void, finish!: (value: Response) => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), waiting = new Promise<Response>(resolve => { finish = resolve; });
  const owned = await prepareExtensionOAuth(client(), { signal: new AbortController().signal, assertCurrent: () => { if (!current) throw new Error("Retired"); } });
  const pending = owned.exchange({ state: owned.offer.state, code: "code" }, (async () => { started(); return waiting; }) as typeof fetch);
  const rejected = expect(pending).rejects.toThrow("Retired"); await ready; current = false; finish(new Response('{"access_token":"late-private-token"}')); await rejected;
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing listener");
    await expect(prepareExtensionOAuth(client({ redirectPort: address.port }), scope())).rejects.toThrow("port is unavailable"); expect(server.listening).toBe(true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("bounds endpoint bodies and exposes only typed refresh failures", async () => {
  const options = { ...scope(), client: client(), fetch: (async () => new Response('{"error":"invalid_grant","error_description":"private-provider-value"}', { status: 400 })) as typeof fetch };
  expect(await refreshExtensionOAuth(options, "private-old-refresh")).toEqual({ ok: false, error: "INVALID_GRANT" });
  const absentExpiry = await refreshExtensionOAuth({ ...options, fetch: (async () => new Response('{"access_token":"private-new-access"}')) as typeof fetch }, "private-old-refresh");
  expect(absentExpiry).toEqual({ ok: true, tokens: { accessToken: "private-new-access", refreshToken: "private-old-refresh", expiresAt: null, grantedScope: null } });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } });
  expect(await refreshExtensionOAuth({ ...options, fetch: (async () => new Response(stream)) as typeof fetch }, "refresh")).toEqual({ ok: false, error: "REFRESH_FAILED" }); expect(cancelled).toBe(true);
});

it("checks redirects and drops credential headers and POST bodies when the redirect changes their scope", async () => {
  const sent: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = (async (input, init) => { sent.push({ url: String(input), method: init?.method ?? "GET", body: init?.body, auth: new Headers(init?.headers).get("authorization") });
    return sent.length === 1 ? new Response(null, { status: 303, headers: { location: "https://api.example.test/result" } }) : new Response("{}"); }) as typeof fetch;
  await scopedFetch({ ...scope(), client: client(), fetch: fetchImpl }, "https://auth.example.test/token", { method: "POST", body: "private-body", headers: { authorization: "Bearer private-access", "content-type": "application/x-www-form-urlencoded" } });
  expect(sent).toEqual([{ url: "https://auth.example.test/token", method: "POST", body: "private-body", auth: "Bearer private-access" }, { url: "https://api.example.test/result", method: "GET", body: null, auth: null }]);
  const denied = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://other.example.test/token" } }));
  await expect(scopedFetch({ ...scope(), client: client(), fetch: denied }, "https://auth.example.test/token", { method: "POST", body: "private-body" })).rejects.toThrow(); expect(denied).toHaveBeenCalledOnce();
});
