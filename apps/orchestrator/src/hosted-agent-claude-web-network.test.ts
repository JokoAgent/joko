import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
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
  it.each(["first address succeeds", "origin disconnects", "all addresses denied", "authorization revoked", "request cancelled"] as const)(
    "keeps the approved Source CONNECT boundary when %s", async (outcome) => {
      const tunnels: (string | undefined)[] = [];
      const originHosts: (string | undefined)[] = [];
      const sockets = new Set<Duplex>();
      const controller = new AbortController();
      let revision = "one";
      const target = createServer((req, res) => {
        originHosts.push(req.headers.host);
        if (outcome === "origin disconnects") {
          req.socket.destroy();
          return;
        }
        res.setHeader("content-type", "text/plain");
        res.end("SOURCE PROXY PAGE");
      });
      const proxy = createServer();
      proxy.on("connect", (req, socket, head) => {
        tunnels.push(req.url);
        trackSocket(sockets, socket);
        if (outcome === "first address succeeds" || outcome === "origin disconnects") {
          relayTunnel(sockets, socket, serverPort(target), "HTTP/1.1 200 Connection Established\r\n\r\n", head);
          return;
        }
        if (outcome === "authorization revoked") revision = "revoked";
        if (outcome === "request cancelled") controller.abort();
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      });
      const f = fixture();
      const fetch = createHostedAgentClaudeWebFetch({ ...f, readPolicy: () => ({ ...f.readPolicy(), revision }),
        lookup: async () => ["127.0.0.1", "127.0.0.2"], resolveProxy: async () => origin(proxy) });
      try {
        await listen(target);
        await listen(proxy);
        const port = serverPort(target);
        const request = fetch({ url: `http://source-site.example:${port}/article` }, controller.signal);
        if (outcome === "authorization revoked") {
          await expect(request).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
        } else if (outcome === "request cancelled") {
          await expect(request).rejects.toMatchObject({ name: "AbortError" });
        } else if (outcome === "first address succeeds") {
          await expect(request).resolves.toMatchObject({ isError: false, content: [{ text: expect.stringContaining("SOURCE PROXY PAGE") }] });
        } else {
          await expect(request).resolves.toMatchObject({ isError: true });
        }
        expect(tunnels).toEqual(outcome === "all addresses denied" ? [`127.0.0.1:${port}`, `127.0.0.2:${port}`] : [`127.0.0.1:${port}`]);
        expect(originHosts).toEqual(outcome === "first address succeeds" || outcome === "origin disconnects" ? [`source-site.example:${port}`] : []);
      } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all([close(proxy), close(target)]);
      }
    }
  );

  it.each(["http", "https"] as const)("retries a rejected CONNECT through an authenticated %s proxy with the original HTTPS identity", async (scheme) => {
    const identity = await sourceTestIdentity();
    const originalCertificates = getCACertificates();
    const sockets = new Set<Duplex>();
    const attempts: { authority: string | undefined; authentication: string | undefined }[] = [];
    const serverNames: (string | false | null)[] = [];
    const originHeaders: { host: string | undefined; proxyAuthorization: string | undefined }[] = [];
    const target = createHttpsServer(identity, (req, res) => {
      originHeaders.push({ host: req.headers.host, proxyAuthorization: req.headers["proxy-authorization"] as string | undefined });
      res.setHeader("content-type", "text/plain");
      res.end("PINNED TLS PAGE");
    });
    target.on("secureConnection", (socket) => serverNames.push(socket.servername));
    const proxy: HttpServer = scheme === "https" ? createHttpsServer(identity) : createServer();
    proxy.on("connect", (req, socket, head) => {
      attempts.push({ authority: req.url, authentication: req.headers["proxy-authorization"] as string | undefined });
      trackSocket(sockets, socket);
      if (req.url === `[2606:4700:4700::1111]:${serverPort(target)}`) {
        relayTunnel(sockets, socket, serverPort(target), "HTTP/1.1 200 Connection Established\r\n\r\n", head);
      } else socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    try {
      setDefaultCACertificates([...originalCertificates, identity.cert]);
      await listen(target);
      await listen(proxy);
      const proxyUrl = new URL(origin(proxy, scheme));
      proxyUrl.username = "fixture-user";
      proxyUrl.password = "fixture-pass";
      const f = fixture();
      const fetch = createHostedAgentClaudeWebFetch({ ...f, lookup: async () => ["93.184.216.34", "2606:4700:4700::1111"],
        resolveProxy: async () => proxyUrl.href });
      const port = serverPort(target);
      expect(await fetch({ url: `https://source-site.example:${port}/article` }, f.context.signal))
        .toMatchObject({ isError: false, content: [{ text: expect.stringContaining("PINNED TLS PAGE") }] });
      const authentication = `Basic ${Buffer.from("fixture-user:fixture-pass").toString("base64")}`;
      expect(attempts).toEqual([
        { authority: `93.184.216.34:${port}`, authentication },
        { authority: `[2606:4700:4700::1111]:${port}`, authentication }
      ]);
      expect(serverNames).toEqual(["source-site.example"]);
      expect(originHeaders).toEqual([{ host: `source-site.example:${port}`, proxyAuthorization: undefined }]);
    } finally {
      setDefaultCACertificates(originalCertificates);
      for (const socket of sockets) socket.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
  }, 25_000);

  it("tries the next pinned address after SOCKS5 rejects a CONNECT", async () => {
    const sockets = new Set<Duplex>();
    const attempts: Buffer[] = [];
    const addresses = ["127.0.0.1", "127.0.0.2"];
    const requestLength = 5 + addresses[0]!.length + 2;
    const target = createServer((_req, res) => { res.setHeader("content-type", "text/plain"); res.end("SOCKS SOURCE PAGE"); });
    const proxy = createTcpServer((socket) => {
      trackSocket(sockets, socket);
      readSocketFrame(socket, 3, () => {
        socket.write(Buffer.from([5, 0]));
        readSocketFrame(socket, requestLength, (request) => {
          attempts.push(request.subarray(0, requestLength));
          if (request[3] === 3 && request.subarray(5, requestLength - 2).toString() === addresses[1]) {
            relayTunnel(sockets, socket, serverPort(target), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), request.subarray(requestLength));
          } else socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      });
    });
    try {
      await listen(target);
      await listen(proxy);
      const f = fixture();
      const fetch = createHostedAgentClaudeWebFetch({ ...f, lookup: async () => addresses,
        resolveProxy: async () => origin(proxy, "socks5") });
      const port = serverPort(target);
      expect(await fetch({ url: `http://source-site.example:${port}/article` }, f.context.signal))
        .toMatchObject({ isError: false, content: [{ text: expect.stringContaining("SOCKS SOURCE PAGE") }] });
      expect(attempts).toEqual(addresses.map((address) => Buffer.concat([
        Buffer.from([5, 1, 0, 3, address.length]), Buffer.from(address), Buffer.from([port >> 8, port & 0xff])
      ])));
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([close(proxy), close(target)]);
    }
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
function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Source network fixture.");
  return address.port;
}
function origin(server: Server, scheme = "http"): string { return `${scheme}://127.0.0.1:${serverPort(server)}`; }
async function listen(server: Server): Promise<void> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function close(server: Server & { closeAllConnections?: () => void }): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
}

function relayTunnel(sockets: Set<Duplex>, socket: Duplex, port: number, handshake: string | Buffer, head: Buffer): void {
  const upstream = connect(port, "127.0.0.1");
  trackSocket(sockets, upstream);
  upstream.once("connect", () => {
    socket.write(handshake);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function readSocketFrame(socket: Socket, length: number, onFrame: (frame: Buffer) => void): void {
  let received = Buffer.alloc(0);
  const receive = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    if (received.length < length) return;
    socket.off("data", receive);
    onFrame(received);
  };
  socket.on("data", receive);
}

async function sourceTestIdentity(): Promise<{ cert: Buffer; key: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "joko-source-web-tls-"));
  try {
    const cert = join(root, "cert.pem");
    const key = join(root, "key.pem");
    const config = join(root, "tls.cnf");
    await writeFile(config, ["[req]", "distinguished_name=dn", "prompt=no", "x509_extensions=extensions", "[dn]",
      "CN=source-site.example", "[extensions]", "subjectAltName=DNS:source-site.example,IP:127.0.0.1",
      "basicConstraints=critical,CA:TRUE", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign", "extendedKeyUsage=serverAuth", ""].join("\n"));
    const gitOpenSsl = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "openssl.exe");
    execFileSync(process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes", "-config", config, "-keyout", key, "-out", cert],
      { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    return { cert: await readFile(cert), key: await readFile(key) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
