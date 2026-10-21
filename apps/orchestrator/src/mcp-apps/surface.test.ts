import { Script } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicServer } from "../server.js";
import type { OrchestratorApplication } from "../application.js";
import { McpAppSurfaces } from "./surface.js";
import type { McpAppsHost } from "./host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  let current = true;
  const dispatch = vi.fn(async () => {}), poll = vi.fn(async () => []);
  const host = { assertViewAuthorized: vi.fn(async () => { if (!current) throw new Error("revoked"); }), dispatch, poll } as unknown as McpAppsHost;
  const surfaces = new McpAppSurfaces(host, "http://127.0.0.1:4318");
  const released = vi.fn();
  const url = surfaces.supply({ viewId: "view", html: "<!doctype html><p>private-view-document</p>",
    csp: "default-src 'none'; script-src 'unsafe-inline'", prefersBorder: true }, "viewer", "task", () => { if (!current) throw new Error("revoked"); }, released);
  const application = { mcpAppSurfaces: surfaces, config: { publicOrigin: "http://127.0.0.1:4318", webDirectory: "unused-mcp-app-test-web",
    allowInsecureLoopback: true, corsOrigins: [] }, store: {}, connections: {}, artifacts: {}, blobTransfers: {}, artifactRepository: {},
    workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {} } as unknown as OrchestratorApplication;
  const server = await createPublicServer(application); server.log.level = "silent";
  cleanups.push(() => server.close());
  const proxy = await server.inject({ method: "GET", url, headers: { "sec-fetch-dest": "iframe" } });
  const bridgeUrl = /fetch\("([^"]+)"/u.exec(proxy.body)?.[1];
  const resourceUrl = /frame.src="([^"]+)"/u.exec(proxy.body)?.[1];
  if (bridgeUrl === undefined || resourceUrl === undefined) throw new Error("Missing sandbox document routing");
  return { server, surfaces, url, proxy, bridgeUrl, resourceUrl, released, dispatch, poll, revoke: () => { current = false; } };
}

it("serves complete documents only in frames with an enforced opaque sandbox", async () => {
  const f = await fixture();
  expect(f.proxy.statusCode).toBe(200);
  expect(f.proxy.headers["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(f.proxy.headers["x-frame-options"]).toBeUndefined();
  expect(f.proxy.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(f.proxy.body).not.toContain("private-view-document");
  const script = /<script>([\s\S]*)<\/script>/u.exec(f.proxy.body)?.[1];
  expect(() => new Script(script!)).not.toThrow();
  const resource = await f.server.inject({ url: f.resourceUrl, headers: { "sec-fetch-dest": "iframe" } });
  expect(resource.body).toBe("<!doctype html><p>private-view-document</p>");
  expect(resource.headers["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(resource.headers["permissions-policy"]).toContain("microphone=()");
  expect(resource.headers["x-content-type-options"]).toBe("nosniff");
  expect((await f.server.inject({ url: f.url })).statusCode).toBe(403);
  expect((await f.server.inject({ url: f.resourceUrl })).statusCode).toBe(403);
});

it("accepts only the private proxy bridge and ignores caller-supplied task or View identities", async () => {
  const f = await fixture();
  const payload = { op: "message", sessionId: "other-task", viewId: "other-view", message: { jsonrpc: "2.0", method: "ping", id: 7 } };
  expect((await f.server.inject({ method: "POST", url: f.bridgeUrl, headers: { origin: "http://127.0.0.1:4318" }, payload })).statusCode).toBe(403);
  expect((await f.server.inject({ method: "POST", url: f.bridgeUrl, payload })).statusCode).toBe(403);
  const preflight = await f.server.inject({ method: "OPTIONS", url: f.bridgeUrl,
    headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  expect(preflight.headers["access-control-allow-origin"]).toBe("null");
  const response = await f.server.inject({ method: "POST", url: f.bridgeUrl, headers: { origin: "null" }, payload });
  expect(response.statusCode).toBe(200);
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith("viewer", "task", "view", payload.message);
  expect(response.headers["access-control-allow-origin"]).toBe("null");
});

it("revokes document and transport capabilities with their original connection and View", async () => {
  const f = await fixture();
  f.revoke();
  expect((await f.server.inject({ url: f.url, headers: { "sec-fetch-dest": "iframe" } })).statusCode).toBe(410);
  expect((await f.server.inject({ method: "POST", url: f.bridgeUrl, headers: { origin: "null" }, payload: { op: "poll", after: 0 } })).statusCode).toBe(410);
  f.surfaces.remove("view");
  expect(f.released).toHaveBeenCalledOnce();
  expect(f.poll).not.toHaveBeenCalled();
});
