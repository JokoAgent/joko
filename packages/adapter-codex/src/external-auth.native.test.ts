import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBackendAdapter } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { useCodexHistoryHome } from "./external-auth.js";
import type { JsonObject } from "./protocol.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];
function token(revision = "initial") {
  return `test.${Buffer.from(JSON.stringify({ sub: "owned-user", email: "owned@example.invalid", revision, exp: 4102444800,
    "https://api.openai.com/auth": { chatgpt_account_id: "owned-account", chatgpt_plan_type: "enterprise" } })).toString("base64url")}.not-a-signature`;
}
function environment(home: string) {
  return useCodexHistoryHome({ PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "",
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home }, home);
}

describe.skipIf(!binary)("published native ephemeral account contract", () => {
  it("installs a private API key in memory and leaves the native history credential file untouched", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-ephemeral-key-"))), auth = join(home, "auth.json");
    const sentinel = "unrelated private history credential sentinel"; await writeFile(auth, sentinel);
    const host = new AppServerHost({ requireEphemeralAuth: true, apiKeyAuth: async () => "private-fixture-api-key",
      transport: { command: binary!, cwd: home, env: environment(home), args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="ephemeral"'] } });
    try {
      await host.ensureStarted(); expect(host.initializeResult?.userAgent).toContain("0.159.2");
      expect((await host.request("config/read", { includeLayers: false })).value).toMatchObject({ config: { cli_auth_credentials_store: "ephemeral" } });
      expect((await host.request("account/read", { refreshToken: false })).value).toMatchObject({ account: { type: "apiKey" } });
      expect(await readFile(auth, "utf8")).toBe(sentinel);
    } finally { await host.shutdown(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  }, 30_000);

  it.each([false, true])("keeps owner refresh private after native 401 and an explicit retry (revoked=%s)", async revoked => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-native-account-"))), home = join(root, "private-history"), accountHome = join(root, "account");
    await Promise.all([mkdir(home), mkdir(accountHome)]);
    const ownerAuth = join(accountHome, "auth.json"), historyAuth = join(home, "auth.json"), sentinel = "history credentials never read or replaced";
    await writeFile(historyAuth, sentinel);
    await writeFile(ownerAuth, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { id_token: token(), access_token: token(), refresh_token: "private-owner-refresh", account_id: "owned-account" } }));
    const wire: { authorization: string | undefined; account: string | string[] | undefined }[] = [], refreshes: unknown[] = [], routes: string[] = [];
    const server = createServer(async (request, response) => {
      routes.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url === "/oauth/token") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        refreshes.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(revoked ? 400 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(revoked ? { error: { code: "refresh_token_invalidated", message: "Fixture credential revoked" } }
          : { id_token: token("refreshed"), access_token: token("refreshed"), refresh_token: "private-owner-refresh-new" })); return;
      }
      if (request.method === "POST" && request.url?.endsWith("/responses")) {
        request.resume(); wire.push({ authorization: request.headers.authorization, account: request.headers["chatgpt-account-id"] });
        if (request.headers.authorization !== `Bearer ${token("refreshed")}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "token_expired", message: "Provided authentication token is expired." } })); return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {
          id: "private-native-response", object: "response", created_at: 1, status: "completed", model: "gpt-6-astra", output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`); return;
      }
      if (request.url?.endsWith("/config/bundle")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ requirements_toml: { enterprise_managed: [{ id: "fixture-network", name: "Fixture network", contents: "[application.network]\nenabled = false\n" }] } })); return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url?.endsWith("/accounts/check") ? { accounts: ["owned-account"].map(id => ({ id,
        workspace_backend_origin: `https://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, account_routing_override: "NO_CONSTRAINT" })),
        default_account_id: "owned-account" } : { models: [] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing private model listener.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const argumentsFor = (store: string) => ["app-server", "--listen", "stdio://", "--disable", "plugins", "--disable", "remote_plugin", "-c", `cli_auth_credentials_store=${JSON.stringify(store)}`,
      "-c", 'model_provider="probe"', "-c", 'model_providers.probe.name="Probe"', "-c", `model_providers.probe.base_url=${JSON.stringify(baseUrl)}`,
      "-c", 'model_providers.probe.wire_api="responses"', "-c", "model_providers.probe.requires_openai_auth=true",
      "-c", "model_providers.probe.stream_max_retries=0", "-c", "model_providers.probe.request_max_retries=0", "-c", `chatgpt_base_url=${JSON.stringify(baseUrl + "/backend-api/")}`];
    const owner = new CodexBackendAdapter({ instanceGeneration: 1, profileDirectory: accountHome, appServer: { transport: {
      command: binary!, cwd: root, args: argumentsFor("file"), env: { ...environment(accountHome), CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${baseUrl}/oauth/token` } } } });
    let host: AppServerHost | undefined;
    try {
      const authority = await owner.captureHostedAuthentication(); if (authority.kind !== "chatgpt") throw new Error("Missing original OAuth authority.");
      const reads: boolean[] = [];
      host = new AppServerHost({ requireEphemeralAuth: true, externalAuth: { readTokens: async (refresh, stale) => {
        reads.push(refresh); return authority.readTokens(refresh, stale);
      } }, transport: { command: binary!, cwd: root, args: argumentsFor("ephemeral"), env: environment(home), requestTimeoutMs: 20_000 } });
      await host.ensureStarted(); expect(host.initializeResult?.userAgent).toContain("0.159.2");
      expect((await host.request("account/read", { refreshToken: false })).value).toMatchObject({ account: { type: "chatgpt", email: "owned@example.invalid" } });
      const started = (await host.request("thread/start", { model: "gpt-6-astra", cwd: root, approvalPolicy: "never", sandbox: "read-only" })).value as JsonObject;
      const thread = started["thread"] as JsonObject, id = thread["id"] as string;
      let completed!: (value: unknown) => void; let completion = new Promise<unknown>(resolve => { completed = resolve; });
      await host.subscribe(id, host.generation, { onRequest: async () => undefined, onDisconnect: () => undefined,
        onNotification: (method, params) => { if (method === "turn/completed") completed(params); } });
      await host.request("turn/start", { threadId: id, input: [{ type: "text", text: "native authentication fixture" }] });
      let finished = await completion as { turn: { status: string; error?: unknown } };
      if (!revoked && finished.turn.status === "failed") {
        // The pinned SDK's first automatic retry can invalidate its network
        // policy. Preserve that observed failure; this explicit user retry is
        // only a contract check, never a production retry or policy bypass.
        expect(finished.turn.error).toMatchObject({ message: "Fatal error: application network policy is unavailable" });
        await host.request("account/read", { refreshToken: false });
        completion = new Promise<unknown>(resolve => { completed = resolve; });
        await host.request("turn/start", { threadId: id, input: [{ type: "text", text: "explicit retry after native account reload" }] });
        finished = await completion as typeof finished;
      }
      expect(finished.turn.status, JSON.stringify({ error: finished.turn.error, reads, refreshCount: refreshes.length, routes,
        wire: wire.map(value => ({ refreshed: value.authorization === `Bearer ${token("refreshed")}`, account: value.account })) }))
        .toBe(revoked ? "failed" : "completed");
      expect(reads).toEqual([false, true]); expect(refreshes).toHaveLength(1);
      expect(refreshes[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "private-owner-refresh" });
      expect(wire).toEqual([{ authorization: `Bearer ${token()}`, account: "owned-account" },
        ...(revoked ? [] : [{ authorization: `Bearer ${token("refreshed")}`, account: "owned-account" }])]);
      const credentials = JSON.parse(await readFile(ownerAuth, "utf8"));
      expect(credentials.tokens.refresh_token).toBe(revoked ? "private-owner-refresh" : "private-owner-refresh-new");
      expect(await readFile(historyAuth, "utf8")).toBe(sentinel);
    } finally {
      await host?.shutdown(); await owner.dispose(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);
});
