import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdapterContext } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ProviderCatalogManager } from "./credential-manager.js";
import type { McpRouter } from "./mcp-router.js";

const KEYS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_SKIP_VERSION_CHECK", "TEMP", "TMP", "TMPDIR",
  "JOKO_PI_CONTROL_FILE", "JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE", "JOKO_PI_WORKSPACE_ROOT", "JOKO_PI_PRODUCT_SESSION_ID",
  "JOKO_PI_TARGET_ID", "JOKO_PI_GENERATION", "JOKO_PI_SPAWN_IDENTITY", "JOKO_PI_APPEND_SYSTEM_PROMPT_HASH", "JOKO_PI_RESET_RECEIPT_ROOT",
  "JOKO_PI_REMOTE_RECOVERY_IDENTITY", "JOKO_PI_RUNTIME_POLICY", "JOKO_PI_ARTIFACT_CAPACITY_BYTES", "JOKO_PI_MCP_DESCRIPTOR_FILE",
  "JOKO_PI_MCP_TOKEN", "JOKO_PI_SUBAGENT_PRODUCT_SESSION_ID", "JOKO_PI_SUBAGENT_RUN_ROOT", "JOKO_PI_SUBAGENT_NODE_EXECUTABLE"] as const;
const MODEL_KEYS = ["id", "name", "api", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"];

/** Runtime capability authorization crosses the peer; source Provider keys and native login never do. */
export class PartnerHomeInference {
  constructor(private readonly options: { readonly store: OperationalStore; readonly providers: ProviderCatalogManager;
    readonly router: McpRouter; readonly fetch: typeof fetch; readonly isHome: (targetId: string) => boolean }) {}
  available(backendId: string, providerId: string, modelId: string): boolean {
    return this.options.providers.describeInferenceRoute(backendId, providerId, modelId) !== undefined;
  }
  async prepare(input: { readonly context: AdapterContext; readonly agentHome: string; readonly environment: Readonly<NodeJS.ProcessEnv> }): Promise<{
    readonly environment: Readonly<Record<string, string>>; readonly discardNativeAuth: true;
  } | undefined> {
    if (!input.context.target.remoteWorkspace || !this.options.isHome(input.context.target.id)) return undefined;
    const { context } = input, descriptorPath = input.environment["JOKO_PI_MCP_DESCRIPTOR_FILE"];
    if (!descriptorPath || !input.environment["JOKO_PI_MCP_TOKEN"]) throw new Error("A private execution channel is required for this Partner home.");
    const original = JSON.parse(await readFile(join(input.agentHome, "models.json"), "utf8")) as { providers?: Record<string, { models?: Record<string, unknown>[] }> };
    const providers: Record<string, unknown> = {};
    for (const [providerId, provider] of Object.entries(original.providers ?? {})) {
      const models = (provider.models ?? []).filter(model => typeof model.id === "string" && this.available(context.target.backendId, providerId, model.id))
        .map(model => Object.fromEntries(MODEL_KEYS.filter(key => model[key] !== undefined).map(key => [key, model[key]])));
      if (!models.length) continue;
      const first = this.options.providers.get(context.target.backendId, providerId).provider;
      providers[providerId] = { api: first.api, apiKey: "$JOKO_PI_MCP_TOKEN", authHeader: true,
        baseUrl: `http://127.0.0.1:1/internal/partner-home-inference/${encodeURIComponent(context.sessionId)}/${encodeURIComponent(providerId)}`,
        headers: { "x-joko-pi-generation": "$JOKO_PI_GENERATION" }, models };
    }
    if (!context.modelSelection || !this.available(context.target.backendId, context.modelSelection.providerId, context.modelSelection.modelId)
      || !providers[context.modelSelection.providerId]) throw new Error("The selected model has no private authority inference route.");
    const environment: Record<string, string> = {};
    for (const key of KEYS) if (typeof input.environment[key] === "string") environment[key] = input.environment[key]!;
    environment["JOKO_PI_SECRET_ENV_NAMES"] = JSON.stringify(["JOKO_PI_MCP_TOKEN"]);
    environment["JOKO_PI_NATIVE_AUTH_PROVIDER_IDS"] = "[]"; environment["JOKO_PI_NATIVE_AUTHENTICATED_PROVIDER_IDS"] = "[]";
    environment["JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES"] = JSON.stringify(["JOKO_PI_MCP_TOKEN", "JOKO_PI_GENERATION"]);
    environment["JOKO_PI_SUBAGENT_PROVIDER_CREDENTIAL_ENV_NAMES"] = JSON.stringify(Object.fromEntries(Object.keys(providers)
      .map(id => [id, ["JOKO_PI_MCP_TOKEN", "JOKO_PI_GENERATION"]])));
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
    delete descriptor.nativeAuthLease;
    descriptor.homeInferenceModels = "agent-home/models.json";
    await atomic(join(input.agentHome, "models.json"), { providers });
    await atomic(join(input.agentHome, "settings.json"), {});
    await atomic(join(input.agentHome, "auth.json"), {});
    await atomic(descriptorPath, descriptor);
    return { environment, discardNativeAuth: true };
  }
  async request(input: { readonly authorization: string | undefined; readonly generation: number; readonly sessionId: string;
    readonly providerId: string; readonly path: string; readonly body: unknown; readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly signal: AbortSignal }): Promise<Response> {
    const session = this.options.store.getSession(input.sessionId).descriptor;
    if (!this.options.isHome(session.targetId) || session.remoteWorkspace?.kind !== "device_peer") throw new Error("Partner inference owner is unavailable.");
    const authority = this.options.router.captureBridgeProductScope({ authorization: input.authorization, generation: input.generation,
      sessionId: session.id, targetId: session.targetId });
    if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new Error("Invalid inference request.");
    const body = input.body as Record<string, unknown>;
    // The managed model catalog also authorizes configured subagent and fallback routes for this exact active turn.
    if (typeof body.model !== "string" || !this.available(session.backendId, input.providerId, body.model)
      || !this.options.store.listRuns({ sessionId: session.id, activeOnly: true, limit: 1 }).length) throw new Error("No current Partner turn owns this model request.");
    const route = this.options.providers.resolveInferenceRoute(session.backendId, input.providerId, body.model);
    if (!route || !validPath(route.api, input.path)) throw new Error("The selected model route is unavailable.");
    const revision = route.generationId;
    const assertCurrent = () => { input.signal.throwIfAborted(); authority.assertCurrent();
      if (this.options.providers.describeInferenceRoute(session.backendId, input.providerId, body.model as string)?.generationId !== revision) throw new Error("Model route changed."); };
    assertCurrent();
    const base = new URL(route.baseUrl.endsWith("/") ? route.baseUrl : `${route.baseUrl}/`);
    const suffix = input.path.endsWith("/compact") ? "/compact" : input.path.endsWith("/count_tokens") ? "/count_tokens" : "";
    const endpoint = route.requestPath === undefined ? new URL(input.path.replace(/^\//u, ""), base)
      : new URL(`${route.requestPath.replace(/\/$/u, "")}${suffix}`, base.origin);
    if (endpoint.origin !== base.origin) throw new Error("Invalid model endpoint.");
    const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream, application/json" });
    for (const name of ["anthropic-version", "anthropic-beta", "openai-beta"]) { const value = input.headers[name]; if (typeof value === "string") headers.set(name, value); }
    for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
    if (route.authorization) headers.set("authorization", route.authorization);
    const response = await this.options.fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: input.signal });
    assertCurrent();
    if (!response.ok || !response.body) { await response.body?.cancel(); return new Response("Model request failed.", { status: response.status >= 400 && response.status <= 599 ? response.status : 502 }); }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      try { assertCurrent(); const chunk = await reader.read(); assertCurrent(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); }
      catch (error) { await reader.cancel().catch(() => undefined); controller.error(error); }
    }, async cancel() { await reader.cancel(); } });
    return new Response(stream, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  }
}
function validPath(api: string, path: string): boolean {
  return api === "anthropic-messages" ? ["/messages", "/v1/messages", "/messages/count_tokens", "/v1/messages/count_tokens"].includes(path)
    : api === "openai-responses" ? ["/responses", "/responses/compact"].includes(path)
      : api === "openai-completions" && path === "/chat/completions";
}
async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, file);
}
