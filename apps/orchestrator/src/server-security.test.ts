import { createConnection } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";

import { createInternalServer, createPublicServer, isExtensionMainViewRequest, ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import { ConnectionManager } from "./connection-manager.js";

describe("Orchestrator Web content security policy", () => {
  it("preserves explicitly enabled private LAN HTTP without opening public or link-local business routes", async () => {
    const application = { config: { publicOrigin: "http://192.168.1.20:4318", allowInsecureLan: true,
      webDirectory: "unused-server-test-web", corsOrigins: [] },
      store: {}, connections: {}, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {},
      workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
    } as unknown as OrchestratorApplication;
    const server = await createPublicServer(application); server.log.level = "silent";
    server.post("/lan-contract-test", async () => ({ accepted: true }));
    try {
      expect((await server.inject({ method: "POST", url: "/lan-contract-test", remoteAddress: "192.168.1.21" })).json()).toEqual({ accepted: true });
      for (const remoteAddress of ["203.0.113.2", "169.254.169.254", "fe80::1"]) {
        expect((await server.inject({ method: "POST", url: "/lan-contract-test", remoteAddress })).statusCode).toBe(426);
      }
      expect((await server.inject({ method: "POST", url: "/lan-contract-test", remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "192.168.1.21" } })).statusCode).toBe(200);
    } finally { await server.close(); }
    const restricted = await createPublicServer({ ...application, config: { ...application.config, allowInsecureLan: false } });
    restricted.log.level = "silent";
    restricted.post("/lan-contract-test", async () => ({ accepted: true }));
    try {
      expect((await restricted.inject({ method: "POST", url: "/lan-contract-test", remoteAddress: "192.168.1.21" })).statusCode).toBe(426);
    } finally { await restricted.close(); }
  });

  it("retires an active ordinary HTTP response after its connection is durably revoked", async () => {
    const store = new OperationalStore(":memory:");
    const connections = new ConnectionManager(store);
    const challenge = connections.issuePairing("HTTP owner");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "HTTP owner" });
    const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: "unused-server-test-web", corsOrigins: [] },
      store, connections, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {},
      workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
    } as unknown as OrchestratorApplication;
    const server = await createPublicServer(application); server.log.level = "silent";
    server.get("/http-revocation-test", async (_request, reply) => {
      const { PassThrough } = await import("node:stream");
      const body = new PassThrough(); body.write("ready"); reply.type("application/octet-stream"); return reply.send(body);
    });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${origin}/http-revocation-test`, { headers: { authorization: `Bearer ${paired.authKey}` } });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
      connections.revoke(paired.connection.id);
      expect(store.getConnection(paired.connection.id).state).toBe("revoked");
      await expect(reader.read()).rejects.toBeDefined();
    } finally { await server.close(); store.close(); }
  });

  it("allows the served top-level Web to request its own microphone and keeps extension surfaces restricted", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-web-permission-policy-"));
    await Promise.all([
      writeFile(join(root, "index.html"), "<!doctype html><title>Joko</title>"),
      writeFile(join(root, "isolated-surface.html"), "<!doctype html><script src='./isolated-surface.js'></script>"),
      writeFile(join(root, "isolated-surface.js"), "void 0;"),
      writeFile(join(root, "app.js"), "void 0;")
    ]);
    const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: root, corsOrigins: [] },
      store: {}, connections: {}, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {},
      workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
    } as unknown as OrchestratorApplication;
    const server = await createPublicServer(application);
    server.log.level = "silent";
    try {
      const page = await server.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.headers["permissions-policy"]).toBe("camera=(), microphone=(self), geolocation=()");
      const bootstrap = await server.inject({ method: "GET", url: "/isolated-surface.html" });
      expect(bootstrap.headers["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(bootstrap.headers["x-frame-options"]).toBeUndefined();
      expect((await server.inject({ method: "GET", url: "/isolated-surface.js" })).headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect((await server.inject({ method: "GET", url: "/app.js" })).headers["cross-origin-resource-policy"]).toBe("same-site");
      const extension = await server.inject({ method: "GET",
        url: `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"b".repeat(64)}/index.html` });
      expect(extension.headers["permissions-policy"]).toContain("microphone=()");
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("closes unstarted public TCP connections without aborting an in-flight HTTP request", async () => {
    const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: "unused-server-test-web" },
      store: {}, connections: {}, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {},
      workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
    } as unknown as OrchestratorApplication;
    const server = await createPublicServer(application); server.log.level = "silent";
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.post("/in-flight-owner-test", async () => { entered(); await held; return { completed: true }; });
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    const idle = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) });
    let closed = false;
    try {
      await new Promise<void>((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
      const response = fetch(`${url}/in-flight-owner-test`, { method: "POST" });
      await started;
      const closing = server.close().then(() => { closed = true; });
      await vi.waitFor(() => expect(idle.destroyed).toBe(true), { timeout: 2_000 });
      expect(closed).toBe(false);
      release();
      expect(await (await response).json()).toEqual({ completed: true });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
      await closing;
    } finally { idle.destroy(); release(); await server.close(); }
  });

  it("cancels an in-flight internal MCP call when its HTTP owner disconnects", async () => {
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    const application = { mcpRouter: {
      executeBridgeCall: async ({ signal }: { signal: AbortSignal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
        return { content: [], isError: true };
      }
    } } as unknown as OrchestratorApplication;
    const server = await createInternalServer(application);
    const url = await server.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    try {
      const pending = fetch(`${url}/internal/mcp`, { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", "x-joko-pi-generation": "1" },
        body: JSON.stringify({ requestId: "cancel", generation: 1, sessionId: "session", targetId: "target", serverId: "server", toolName: "audio" }) });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      await aborted;
    } finally { controller.abort(); await server.close(); }
  });

  it("permits the bundled fonts, authenticated media URLs, and self-hosted diagram runtime", () => {
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("font-src 'self' data:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("media-src 'self' blob: data:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY)
      .toContain("img-src 'self' blob: data: https://weixin.qq.com https://*.weixin.qq.com");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' blob:");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-eval'");
    expect(ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY).toContain("frame-src 'self'");
  });

  it("recognizes only exact opaque Extension surface routes", () => {
    const route = `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"b".repeat(64)}/index.html`;
    expect(isExtensionMainViewRequest(route)).toBe(true);
    expect(isExtensionMainViewRequest(`${route}?debug=1`)).toBe(false);
    expect(isExtensionMainViewRequest(route.replace("extension_surface_", "surface_"))).toBe(false);
    expect(isExtensionMainViewRequest(route.replace(`/${"b".repeat(64)}/`, "/short/"))).toBe(false);
    expect(isExtensionMainViewRequest("/v1/extensions/main-views/")).toBe(false);
  });

  it("accepts only the typed CSS read transform method and MIME at an existing surface path", async () => {
    const serve = vi.fn(async () => ({ status: 200, mimeType: "text/css", contentLength: 6, body: Buffer.from("body{}") }));
    const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: "unused-server-test-web", corsOrigins: [] }, extensionMainViews: { serve },
      store: {}, connections: {}, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {} } as unknown as OrchestratorApplication;
    const server = await createPublicServer(application); server.log.level = "silent";
    const url = `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"b".repeat(64)}/index.html`;
    try {
      expect((await server.inject({ method: "GET", url, headers: { "x-joko-isolated-document": "style-text" } })).statusCode).toBe(400);
      expect((await server.inject({ method: "POST", url, headers: { "x-joko-isolated-document": "style-text", "content-type": "text/plain" }, payload: "body{}" })).statusCode).toBe(400);
      expect(serve).not.toHaveBeenCalled();
      const response = await server.inject({ method: "POST", url, headers: { "x-joko-isolated-document": "style-text", "content-type": "text/css" }, payload: "body{}" });
      expect(response.statusCode).toBe(200);
      expect(serve).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", materializeAsset: "style", inlineStyle: "body{}" }));
    } finally { await server.close(); }
  });
});
