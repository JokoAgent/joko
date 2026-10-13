import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboundStreamingFetch } from "./outbound-streaming-fetch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The loopback fixture address is unavailable.");
  return address.port;
}

async function tunnel(originPort: number): Promise<string> {
  const upstreamSockets = new Set<Socket>();
  const proxy = createServer();
  proxy.on("connect", (_request, client, head) => {
    const upstream = connect(originPort, "127.0.0.1");
    upstreamSockets.add(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length !== 0) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => { upstreamSockets.delete(upstream); client.destroy(); });
  });
  const port = await listen(proxy);
  cleanups.push(async () => { for (const socket of upstreamSockets) socket.destroy(); });
  return `http://127.0.0.1:${port}`;
}

describe("managed download streaming transport", () => {
  it("returns proxied headers and a prefix before the response finishes, then releases the transport at EOF", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const origin = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "12" });
      response.write("first-");
      void pending.then(() => response.end("second"));
    });
    const originPort = await listen(origin);
    const proxy = await tunnel(originPort);
    const fetchDownload = createOutboundStreamingFetch({ environmentProxyForTarget: () => undefined, resolveProxy: () => proxy });
    const response = await fetchDownload(`http://127.0.0.1:${originPort}/asset`, { signal: AbortSignal.timeout(3000) });
    expect(response.headers.get("content-length")).toBe("12");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first-");
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it.each(["cancel", "abort"] as const)("retires an unfinished proxy body on %s without waiting for the remaining asset", async retirement => {
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const origin = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("prefix");
      response.once("close", disconnected);
    });
    const originPort = await listen(origin);
    const proxy = await tunnel(originPort);
    const controller = new AbortController();
    const fetchDownload = createOutboundStreamingFetch({ environmentProxyForTarget: () => proxy });
    const response = await fetchDownload(`http://127.0.0.1:${originPort}/unfinished`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    if (retirement === "cancel") await reader.cancel();
    else controller.abort(new Error("The managed download was retired."));
    await closed;
    reader.releaseLock();
  });

  it("retires a pending proxy lookup before any download dispatch and ignores its late result", async () => {
    let release!: (proxy: null) => void;
    const pending = new Promise<null>(resolve => { release = resolve; });
    let requests = 0;
    const origin = createServer((_request, response) => { requests += 1; response.end("unexpected"); });
    const port = await listen(origin);
    const controller = new AbortController();
    const fetchDownload = createOutboundStreamingFetch({ environmentProxyForTarget: () => undefined, resolveProxy: () => pending });
    const reading = fetchDownload(`http://127.0.0.1:${port}/asset`, { signal: controller.signal });
    controller.abort(new Error("The download owner changed."));
    await expect(reading).rejects.toThrow("The download owner changed.");
    release(null);
    await Promise.resolve();
    expect(requests).toBe(0);
  });
});
