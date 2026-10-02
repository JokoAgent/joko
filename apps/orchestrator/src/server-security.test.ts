import { createConnection } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { createInternalServer, createPublicServer, isExtensionMainViewRequest, ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY } from "./server.js";
import type { OrchestratorApplication } from "./application.js";

describe("Orchestrator Web content security policy", () => {
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
});
