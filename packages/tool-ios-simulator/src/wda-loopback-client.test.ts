import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { WdaLoopbackClient } from "./wda-loopback-client.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function loopback(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback port was not allocated.");
  return address.port;
}

function client(controlPort: number, options: { timeoutMs?: number; maxResponseBytes?: number } = {}): WdaLoopbackClient {
  return new WdaLoopbackClient({ controlPort, cacheRoot: "/private/joko/wda-cache", instanceId: "instance-1",
    simulatorUdid: UDID, ...options });
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

it("uses exact loopback routes, verifies the device-bound process marker and manages a W3C session", async () => {
  let fingerprint = "";
  const calls: { method: string; path: string; body: string }[] = [];
  const port = await loopback((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({ method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      if (request.url === "/status") json(response, { value: { ready: true,
        build: { upgradedAt: fingerprint }, os: { name: "iOS", version: "19.0", sdkVersion: "19.0" } } });
      else if (request.method === "POST" && request.url === "/session") {
        json(response, { value: { sessionId: "SESSION-1", capabilities: { device: "iphone" } } });
      } else json(response, { value: null });
    });
  });
  const driver = client(port);
  fingerprint = driver.ownerFingerprint;
  expect(await driver.probe()).toMatchObject({ ready: true, osName: "iOS", osVersion: "19.0" });
  const session = await driver.createSession();
  expect(session).toMatchObject({ id: "SESSION-1", capabilities: { device: "iphone" } });
  await driver.deleteSession(session.id);
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
    "GET /status", "GET /status", "POST /session", "GET /status", "DELETE /session/SESSION-1"
  ]);
  expect(JSON.parse(calls[2]?.body ?? "")).toEqual({ capabilities: { alwaysMatch: {} } });
});

it("fails closed on foreign ownership, non-ready status, invalid session and unsafe local port", async () => {
  let status: unknown = { value: { ready: true, build: { upgradedAt: "foreign" } } };
  let postCount = 0;
  const port = await loopback((request, response) => {
    if (request.url === "/status") json(response, status);
    else { postCount += 1; json(response, { value: { error: "invalid session id", message: "private path" } }, 404); }
  });
  const driver = client(port);
  await expect(driver.createSession()).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  status = { value: { ready: false, build: { upgradedAt: driver.ownerFingerprint } } };
  await expect(driver.createSession()).rejects.toMatchObject({ code: "NOT_READY" });
  status = { value: { ready: true, build: { upgradedAt: driver.ownerFingerprint } } };
  await expect(driver.deleteSession("bad/id")).rejects.toMatchObject({ code: "INVALID_SESSION" });
  await expect(driver.deleteSession("SESSION-1")).rejects.toMatchObject({ code: "INVALID_SESSION", statusCode: 404 });
  expect(postCount).toBe(1);
  expect(() => client(80)).toThrow(/controlPort/u);
  expect(() => new WdaLoopbackClient({ controlPort: port, cacheRoot: "relative", instanceId: "instance-1",
    simulatorUdid: UDID })).toThrow(/owner identity/u);
});

it("rejects redirects, malformed responses and streamed byte overflow without following targets", async () => {
  let mode: "redirect" | "malformed" | "oversized" = "redirect";
  const port = await loopback((_request, response) => {
    if (mode === "redirect") { response.writeHead(302, { location: "http://example.invalid/private" }); response.end(); }
    else if (mode === "malformed") { response.writeHead(200); response.end("{}"); }
    else { response.writeHead(200, { "content-type": "application/json" }); response.write("{".repeat(30)); response.end("}".repeat(30)); }
  });
  const driver = client(port, { maxResponseBytes: 16 });
  await expect(driver.probe()).rejects.toMatchObject({ code: "PROTOCOL_ERROR", statusCode: 302 });
  mode = "malformed";
  await expect(driver.probe()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  mode = "oversized";
  await expect(driver.probe()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
});

it("bounds stalled loopback reads and distinguishes timeout from caller cancellation", async () => {
  let started!: () => void;
  let requestStarted = new Promise<void>(resolve => { started = resolve; });
  const port = await loopback((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    started();
  });
  const driver = client(port, { timeoutMs: 40 });
  await expect(driver.probe()).rejects.toMatchObject({ code: "TIMEOUT" });
  requestStarted = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  const pending = driver.probe(controller.signal);
  await requestStarted;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
});
