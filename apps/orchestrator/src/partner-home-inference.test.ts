import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogManager } from "./credential-manager.js";
import type { McpRouter } from "./mcp-router.js";
import { PartnerHomeInference } from "./partner-home-inference.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function fixture() {
  const providers = { describeInferenceRoute: vi.fn((_backendId: string, _providerId: string, modelId: string) => modelId === "model" ? { generationId: "provider-generation" } : undefined),
    get: () => ({ provider: { api: "openai-responses" } }), resolveInferenceRoute: vi.fn(() => ({ generationId: "provider-generation", api: "openai-responses",
      baseUrl: "https://provider.example/v1", authorization: "Bearer source-provider-key", headers: { "x-provider-account": "private-provider-account" } })) };
  const session = { id: "partner-session", targetId: "home-target", backendId: "managed", providerId: "managed-provider", modelId: "model",
    remoteWorkspace: { kind: "device_peer", controllerDeviceId: "phone", targetDeviceId: "computer", workspaceRoot: "/home/person/partner" } };
  const store = { getSession: () => ({ descriptor: session }), listRuns: vi.fn(() => [{ descriptor: { id: "admitted-run" } }]) };
  const assertCurrent = vi.fn(), router = { captureBridgeProductScope: vi.fn(() => ({ assertCurrent })) };
  const fetch = vi.fn(async () => new Response("data: private response\n\n", { status: 200, headers: { "content-type": "text/event-stream", "x-secret-upstream": "must-not-forward" } }));
  const inference = new PartnerHomeInference({ store: store as unknown as OperationalStore, providers: providers as unknown as ProviderCatalogManager,
    router: router as unknown as McpRouter, fetch, isHome: id => id === "home-target" });
  return { inference, providers, store, router, assertCurrent, fetch, session };
}
describe("Partner home private inference transport", () => {
  it("replaces source auth/config/env with a Session capability and a bounded managed model catalog", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "joko-home-inference-")); directories.push(root);
    const agentHome = join(root, "agent-home"); await mkdir(agentHome);
    const descriptor = join(root, "mcp.json");
    await writeFile(descriptor, JSON.stringify({ endpoint: "http://127.0.0.1:4318/internal/mcp", generation: 2,
      nativeAuthLease: { endpoint: "http://127.0.0.1:4318/internal/pi-native-auth", providerIds: ["native-login"] } }));
    await writeFile(join(agentHome, "models.json"), JSON.stringify({ providers: { "managed-provider": {
      baseUrl: "https://source.example/v1", api: "openai-responses", apiKey: "$SOURCE_API_KEY", headers: { authorization: "$SOURCE_AUTH" },
      models: [{ id: "model", name: "Configured model", contextWindow: 100000, maxTokens: 10000, malicious: "source-api-key" }] } } }));
    await writeFile(join(agentHome, "settings.json"), JSON.stringify({ defaultProvider: "native-login", sourceSetting: true }));
    await writeFile(join(agentHome, "auth.json"), JSON.stringify({ "native-login": { refresh: "source-native-refresh" } }));
    const context = { sessionId: "partner-session", generation: 2, modelSelection: { providerId: "managed-provider", modelId: "model" },
      target: { id: "home-target", backendId: "managed", remoteWorkspace: f.session.remoteWorkspace } } as unknown as AdapterContext;
    const prepared = await f.inference.prepare({ context, agentHome, environment: { SOURCE_API_KEY: "source-api-key", SOURCE_AUTH: "source-header-auth",
      HTTP_PROXY: "http://proxy-user:proxy-password@proxy.example", HOME: "/source/home", JOKO_PI_MCP_DESCRIPTOR_FILE: descriptor,
      JOKO_PI_MCP_TOKEN: "runtime-capability", JOKO_PI_GENERATION: "2", JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN: "source-native-reservation" } });
    expect(prepared?.discardNativeAuth).toBe(true);
    expect(prepared?.environment).toEqual(expect.objectContaining({ JOKO_PI_MCP_TOKEN: "runtime-capability", JOKO_PI_GENERATION: "2" }));
    for (const key of ["SOURCE_API_KEY", "SOURCE_AUTH", "HTTP_PROXY", "HOME", "JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN"]) expect(prepared!.environment).not.toHaveProperty(key);
    const files = await Promise.all(["models.json", "settings.json", "auth.json"].map(file => readFile(join(agentHome, file), "utf8")));
    for (const value of [...files, JSON.stringify(prepared!.environment), await readFile(descriptor, "utf8")]) {
      expect(value).not.toMatch(/source-api-key|source-header-auth|source-native-refresh|proxy-password|source-native-reservation/u);
    }
    const models = JSON.parse(files[0]!); expect(models.providers["managed-provider"]).toMatchObject({ apiKey: "$JOKO_PI_MCP_TOKEN", authHeader: true,
      baseUrl: "http://127.0.0.1:1/internal/partner-home-inference/partner-session/managed-provider" });
    expect(JSON.parse(files[1]!)).toEqual({}); expect(JSON.parse(files[2]!)).toEqual({});
    expect(JSON.parse(await readFile(descriptor, "utf8")).nativeAuthLease).toBeUndefined();
  });
  it("uses credentials only at the authority fetch boundary and never forwards target credentials or upstream secret headers", async () => {
    const f = fixture(); const response = await f.inference.request({ authorization: "Bearer runtime-capability", generation: 2,
      sessionId: "partner-session", providerId: "managed-provider", path: "/responses", body: { model: "model", input: "User input", stream: true },
      headers: { authorization: "Bearer injected-key", "x-api-key": "injected-key" }, signal: new AbortController().signal });
    expect(f.router.captureBridgeProductScope).toHaveBeenCalledWith({ authorization: "Bearer runtime-capability", generation: 2, sessionId: "partner-session", targetId: "home-target" });
    const [url, init] = f.fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://provider.example/v1/responses");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer source-provider-key");
    expect((init.headers as Headers).get("x-api-key")).toBeNull(); expect(response.headers.get("x-secret-upstream")).toBeNull();
    expect(await response.text()).toContain("private response");
    f.store.listRuns.mockReturnValue([]);
    await expect(f.inference.request({ authorization: "Bearer runtime-capability", generation: 2, sessionId: "partner-session", providerId: "managed-provider",
      path: "/responses", body: { model: "model" }, headers: {}, signal: new AbortController().signal })).rejects.toThrow("No current Partner turn");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("rejects an unconfigured model and a changed native capability before making any external request", async () => {
    const f = fixture(); const input = { authorization: "Bearer runtime-capability", generation: 2, sessionId: "partner-session", providerId: "managed-provider",
      path: "/responses", body: { model: "different-model" }, headers: {}, signal: new AbortController().signal };
    await expect(f.inference.request(input)).rejects.toThrow("No current Partner turn");
    f.assertCurrent.mockImplementation(() => { throw new Error("Retired native generation"); });
    await expect(f.inference.request({ ...input, body: { model: "model" } })).rejects.toThrow("Retired native generation"); expect(f.fetch).not.toHaveBeenCalled();
  });
});
