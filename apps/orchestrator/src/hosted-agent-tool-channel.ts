import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HostedAgentExecutorError } from "./hosted-agent-executor.js";

const MAXIMUM_BYTES = 64 * 1024 * 1024;
export interface HostedAgentToolChannel {
  /** Private native-process descriptor. Never a public URL or Session field. */
  readonly endpoint: string;
  readonly bearer: string;
  close(): Promise<void>;
}
export async function createHostedAgentToolChannel(options: {
  readonly execute: (request: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
  readonly assertCurrent: () => void;
}): Promise<HostedAgentToolChannel> {
  const bearer = randomBytes(32).toString("base64url"), authorization = Buffer.from("Bearer " + bearer);
  const lifetime = new AbortController(), active = new Set<AbortController>();
  let retainedBodyBytes = 0;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 0; // Shell requests have their own bounded native deadline.
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const listen = new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  try { await listen; options.assertCurrent(); }
  catch { await stop(server); throw new Error("Hosted Agent tool channel could not start."); }
  const address = server.address();
  if (!address || typeof address === "string") { await stop(server); throw new Error("Hosted Agent tool channel has no listener."); }
  const endpoint = `http://127.0.0.1:${address.port}/hosted-agent`;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { fail(response, 403, "ACCESS_DENIED"); return; }
    if (request.method !== "POST" || request.url !== "/hosted-agent/execute"
      || request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { fail(response, 400, "INVALID_REQUEST"); return; }
    if (lifetime.signal.aborted || active.size >= 64) { fail(response, 503, "RESOURCE_EXHAUSTED"); return; }
    const abort = new AbortController(); active.add(abort);
    const signal = AbortSignal.any([abort.signal, lifetime.signal]);
    const disconnected = () => { if (!response.writableEnded) abort.abort(); };
    request.once("aborted", disconnected); response.once("close", disconnected);
    let retained = 0;
    try {
      assertCurrent(); signal.throwIfAborted();
      const declared = request.headers["content-length"];
      if (declared !== undefined && (!/^\d{1,12}$/u.test(declared) || Number(declared) > MAXIMUM_BYTES)) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        signal.throwIfAborted(); const data = Buffer.from(chunk); bytes += data.byteLength;
        if (bytes > MAXIMUM_BYTES || retainedBodyBytes + data.byteLength > MAXIMUM_BYTES) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
        retainedBodyBytes += data.byteLength; retained += data.byteLength; chunks.push(data);
      }
      let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HostedAgentExecutorError("INVALID_REQUEST"); }
      assertCurrent(); signal.throwIfAborted();
      const value = await options.execute(parsed, signal);
      assertCurrent(); signal.throwIfAborted();
      const body = JSON.stringify({ format: 1, ok: true, value });
      if (Buffer.byteLength(body) > MAXIMUM_BYTES) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
      if (!response.destroyed) response.end(body);
    } catch (error) {
      const code = error instanceof HostedAgentExecutorError ? error.code : signal.aborted ? "STALE_AUTHORITY" : "EXECUTOR_FAILED";
      fail(response, code === "INVALID_REQUEST" ? 400 : code === "ACCESS_DENIED" ? 403 : 409, code);
    } finally {
      retainedBodyBytes -= retained;
      request.removeListener("aborted", disconnected); response.removeListener("close", disconnected); active.delete(abort);
    }
  }
  function assertCurrent(): void {
    try { options.assertCurrent(); } catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
  }
  return { endpoint, bearer, close() { return closing ??= (async () => {
    lifetime.abort(); for (const abort of active) abort.abort(); await stop(server);
  })(); } };
}
function fail(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status).end(JSON.stringify({ format: 1, ok: false, error: { code } }));
}
async function stop(server: Server): Promise<void> {
  server.closeAllConnections(); if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
