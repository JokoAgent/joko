import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { HostedAgentBackendFactory } from "./hosted-agent-runtime.js";
import { ClaudeCodeOAuthAccount, type ClaudeCodeCredentialPort } from "@joko/adapter-claude-code";

const HEADER = "x-joko-hosted-native-scope";
const BODY_LIMIT = 32 * 1024 * 1024;
const UPSTREAM = "https://api.anthropic.com";
const PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const FORWARDED_HEADERS = new Set(["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent", "content-type", "accept", "x-app"]);

/** Transparent transport for the actual subscription SDK. The model computer
 * retains OAuth and networking; every native request proves the fixed shared
 * Provider/model scope before using that subscription. */
export async function createHostedAgentClaudeNativeTransport(options: {
  readonly creation: Parameters<HostedAgentBackendFactory["create"]>[0];
  readonly credentials: ClaudeCodeCredentialPort;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly environment: Readonly<Record<string, string>>; readonly secret: string;
  registerModels(models: readonly { readonly value: string; readonly resolvedModel?: string }[]): void; close(): Promise<void> }> {
  const { creation } = options;
  if (!creation.providerIds.includes("claude-code")) throw new Error("The native subscription is outside this hosted scope.");
  const secret = randomBytes(32).toString("base64url"), expected = Buffer.from(secret), lifetime = new AbortController();
  const account = new ClaudeCodeOAuthAccount({ credentials: options.credentials, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const requests = new Set<AbortController>(); let closing: Promise<void> | undefined, retainedBodyBytes = 0;
  let modelAliases = new Map<string, ReadonlySet<string>>();
  const assertCurrent = () => { creation.signal.throwIfAborted(); lifetime.signal.throwIfAborted(); creation.execution.assertCurrent(); };
  const server = createServer((request, response) => { void handle(request, response); });
  server.headersTimeout = 15_000; server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("The native subscription transport did not start.");
  const close = (): Promise<void> => closing ??= (async () => {
    lifetime.abort(); for (const abort of requests) abort.abort();
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await account.dispose();
  })();
  try { assertCurrent(); } catch (error) { await close(); throw error; }
  return { secret, environment: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    ANTHROPIC_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_CUSTOM_HEADERS: `${HEADER}: ${secret}`, NO_PROXY: "127.0.0.1,::1", no_proxy: "127.0.0.1,::1" },
    registerModels(models) {
      assertCurrent(); if (!Array.isArray(models) || models.length > 4096) throw new Error("The native model catalog exceeds its scope.");
      const aliases = new Map<string, Set<string>>();
      for (const model of models) {
        if (!model || typeof model.value !== "string" || !model.value || model.value.length > 512 || model.resolvedModel !== undefined
          && (typeof model.resolvedModel !== "string" || !model.resolvedModel || model.resolvedModel.length > 512)) throw new Error("The native model catalog is invalid.");
        for (const identity of [model.value, model.resolvedModel].filter((id): id is string => id !== undefined)) {
          const publicIds = aliases.get(identity) ?? new Set<string>(); publicIds.add(model.value); aliases.set(identity, publicIds);
        }
      }
      modelAliases = aliases;
    }, close };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(String(request.headers[HEADER] ?? ""));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { fail(response, 403); return; }
    if (requests.size >= 64) { fail(response, 429); return; }
    let path: URL; try { path = new URL(request.url ?? "", "http://127.0.0.1"); } catch { fail(response, 400); return; }
    if (request.method !== "POST" || !PATHS.has(path.pathname) || path.hash || path.search.length > 1024
      || [...path.searchParams.keys()].some(key => !["beta"].includes(key))) { fail(response, 404); return; }
    const abort = new AbortController(); requests.add(abort);
    const signal = AbortSignal.any([abort.signal, lifetime.signal, creation.signal, AbortSignal.timeout(10 * 60_000)]);
    const stopped = () => { if (!response.writableEnded) abort.abort(); };
    request.once("aborted", stopped); response.once("close", stopped);
    let retained = 0, authorization: Awaited<ReturnType<ClaudeCodeOAuthAccount["runtimeAuthorization"]>> = undefined;
    try {
      assertCurrent(); signal.throwIfAborted();
      const declared = request.headers["content-length"];
      if (declared !== undefined && (!/^\d{1,12}$/u.test(declared) || Number(declared) > BODY_LIMIT)) throw new Error("The native request exceeds its limit.");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { signal.throwIfAborted(); const data = Buffer.from(chunk); bytes += data.byteLength;
        if (bytes > BODY_LIMIT || retainedBodyBytes + data.byteLength > 64 * 1024 * 1024) throw new Error("The native request exceeds its limit.");
        retainedBodyBytes += data.byteLength; retained += data.byteLength; chunks.push(data); }
      const body = Buffer.concat(chunks), parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.model !== "string" || !parsed.model || parsed.model.length > 512) throw new Error("The native model identity is invalid.");
      const modelId = parsed.model;
      const allowedIdentities = [...new Set([modelId, ...(modelAliases.get(modelId) ?? [])])];
      const assertModel = () => {
        assertCurrent(); signal.throwIfAborted();
        if (authorization && !authorization.isCurrent()) throw new Error("The native subscription authorization changed.");
        for (const identity of allowedIdentities) {
          if (creation.trust === "guest" && (creation.providerId !== "claude-code" || !creation.modelIds.includes(identity))) continue;
          try { creation.assertModelAllowed("claude-code", identity); return; } catch { /* Other exact native aliases may name the same catalog model. */ }
        }
        throw new Error("The native model is outside this hosted scope.");
      };
      assertModel();
      authorization = await account.runtimeAuthorization(); assertModel();
      const oauthToken = authorization?.environment["CLAUDE_CODE_OAUTH_TOKEN"];
      if (!authorization || !authorization.isCurrent() || !oauthToken) throw new Error("The pinned native subscription is unavailable.");
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (FORWARDED_HEADERS.has(key) && typeof value === "string") headers.set(key, value);
      headers.delete("x-api-key"); headers.set("authorization", "Bearer " + oauthToken);
      headers.set("content-type", "application/json");
      const upstream = await (options.fetch ?? fetch)(UPSTREAM + path.pathname + path.search, { method: "POST", headers, body,
        signal, redirect: "manual", credentials: "omit" });
      assertModel();
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); throw new Error("Native subscription redirects are unavailable."); }
      response.statusCode = upstream.status; response.setHeader("cache-control", "no-store");
      const contentType = upstream.headers.get("content-type"); if (contentType) response.setHeader("content-type", contentType);
      for (const [key, value] of upstream.headers) if (key === "request-id" || key === "retry-after" || key.startsWith("anthropic-ratelimit-")) response.setHeader(key, value);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        try { for (;;) { assertModel(); const next = await reader.read(); assertModel(); if (next.done) break;
          if (!response.write(Buffer.from(next.value))) await once(response, "drain", { signal }); } }
        finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      assertModel(); response.end();
    } catch {
      if (response.headersSent) response.destroy(); else fail(response, signal.aborted ? 409 : 403);
    } finally { authorization?.release(); retainedBodyBytes -= retained; requests.delete(abort); request.off("aborted", stopped); response.off("close", stopped); }
  }
}
function fail(response: ServerResponse, status: number): void {
  if (!response.destroyed && !response.writableEnded) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "The hosted native Provider request is unavailable." } }));
}
