import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@joko/core";
import { createHostedAgentClaudeWebFetch } from "./hosted-agent-claude-web-network.js";

describe("Claude Source WebFetch", () => {
  it("asks on Source before fetching a real private HTTP page and converts its HTML", async () => {
    const requests: { readonly host: string | undefined; readonly cookie: string | undefined }[] = [];
    const server = createServer((req, res) => { requests.push({ host: req.headers.host, cookie: req.headers.cookie });
      res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<title>Source page</title><h1>Heading</h1><p>Hello <strong>Source</strong>.</p><script>private script content</script>"); });
    await listen(server); const interaction = vi.fn(async () => ({ kind: "selected" as const, value: "allow_once" }));
    const f = fixture(interaction), fetch = createHostedAgentClaudeWebFetch(f);
    try {
      const result = await fetch({ url: origin(server) + "/page" }, f.context.signal);
      expect(result).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("Heading") }] });
      expect(JSON.stringify(result)).toContain("Source page"); expect(JSON.stringify(result)).not.toContain("private script content");
      expect(interaction).toHaveBeenCalledOnce(); expect(requests).toHaveLength(1); expect(requests[0]?.cookie).toBeUndefined();
    } finally { await close(server); }
  });
  it("pins the approved Source address through a real HTTP CONNECT proxy and preserves the original Host", async () => {
    let forwardedHost: string | undefined, tunnelTarget: string | undefined;
    const target = createServer((req, res) => { forwardedHost = req.headers.host; res.setHeader("content-type", "text/plain"); res.end("SOURCE PROXY PAGE"); });
    await listen(target); const sockets = new Set<Duplex>();
    const proxy = createServer(); proxy.on("connect", (req, socket, head) => {
      tunnelTarget = req.url; sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      const upstream = connect(Number(new URL(origin(target)).port), "127.0.0.1"); sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    }); await listen(proxy);
    const f = fixture(), fetch = createHostedAgentClaudeWebFetch({ ...f, lookup: async () => ["127.0.0.1"], resolveProxy: async () => origin(proxy) });
    try {
      const port = new URL(origin(target)).port, url = `http://source-site.example:${port}/article`;
      expect(await fetch({ url }, f.context.signal)).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("SOURCE PROXY PAGE") }] });
      expect(tunnelTarget).toBe(`127.0.0.1:${port}`); expect(forwardedHost).toBe(`source-site.example:${port}`);
    } finally { for (const socket of sockets) socket.destroy(); await Promise.all([close(proxy), close(target)]); }
  });
  it("returns a cross-host redirect without dispatching to the new host", async () => {
    const f = fixture(), request = vi.fn(async (_input: { readonly addresses: readonly string[] }) => ({ response: new Response(null, { status: 302, headers: { location: "https://other-site.example/private" } }), release: async () => {} }));
    const fetch = createHostedAgentClaudeWebFetch({ ...f, lookup: async () => ["93.184.216.34"], request });
    const result = await fetch({ url: "https://source-site.example/article" }, f.context.signal);
    expect(result).toMatchObject({ isError: false, content: [{ text: expect.stringContaining("https://other-site.example/private") }] });
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]?.[0]).toMatchObject({ addresses: ["93.184.216.34"] });
  });
  it("rejects denied private destinations and ignores DNS answers after the original policy changed", async () => {
    const deny = fixture(async () => ({ kind: "selected", value: "deny_once" })), request = vi.fn();
    const fetch = createHostedAgentClaudeWebFetch({ ...deny, lookup: async () => ["::ffff:127.0.0.1"], request });
    expect(await fetch({ url: "https://source-site.example/" }, deny.context.signal)).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    let revision = "one", settle!: (value: readonly string[]) => void;
    const pending = new Promise<readonly string[]>(resolve => { settle = resolve; });
    const stale = createHostedAgentClaudeWebFetch({ ...fixture(), readPolicy: () => ({ revision, permissionMode: "ask", planMode: false, approvedRoots: [], confirmCredentials: true }),
      lookup: () => pending, request });
    const operation = stale({ url: "https://source-site.example/" }, new AbortController().signal); revision = "two"; settle(["93.184.216.34"]);
    await expect(operation).rejects.toMatchObject({ code: "STALE_AUTHORITY" }); expect(request).not.toHaveBeenCalled();
  });
});

function fixture(requestInteraction: AdapterContext["requestInteraction"] = async () => ({ kind: "selected", value: "allow_once" })) {
  const context: AdapterContext = { sessionId: "source-task", generation: 1, backendInstanceGeneration: 1, operationId: "source-input",
    target: { id: "source-target", backendId: "source-backend", displayName: "Source", workspaceRoot: process.cwd(), managed: false, trusted: false },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction, artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("No Artifact expected."); } };
  return { context, assertCurrent: () => context.signal.throwIfAborted(), readPolicy: () => ({ revision: "one", permissionMode: "ask" as const, planMode: false, approvedRoots: [], confirmCredentials: true }) };
}
function origin(server: Server): string { const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing Source HTTP fixture."); return `http://127.0.0.1:${address.port}`; }
async function listen(server: Server): Promise<void> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
