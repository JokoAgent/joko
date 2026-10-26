import { createServer, type Socket } from "node:net";
import { acceptStream } from "@jokoagent/linkspan-noise";
import { createNodeStreamCarrier } from "@jokoagent/linkspan-http-connect/node";
import type { OrchestratorApplication } from "./application.js";
import { serveLinkspanChannel } from "./linkspan-server.js";

/** A process-owned Noise target for a selected HTTP CONNECT publisher. It never
 * accepts HTTP, serves a frontend, or binds a public network interface. */
export function createLinkspanTcpIngress(application: OrchestratorApplication, input: {
  readonly backendOrigin: string;
  readonly signal?: AbortSignal;
}) {
  const identity = application.linkspanIdentity;
  if (identity === undefined) throw new Error("The endpoint identity is unavailable.");
  input.signal?.throwIfAborted();
  const shutdown = new AbortController();
  const sockets = new Set<Socket>(), serving = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    if (shutdown.signal.aborted || sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setNoDelay(true);
    const pending = (async () => {
      const carrier = createNodeStreamCarrier(socket, { signal: shutdown.signal });
      const channel = await acceptStream(carrier, { identity, signal: shutdown.signal, deadline: Date.now() + 10_000 });
      await serveLinkspanChannel(application, channel, input.backendOrigin, shutdown.signal);
    })().catch(() => { socket.destroy(); }).finally(() => { sockets.delete(socket); serving.delete(pending); });
    serving.add(pending);
  });
  const interrupted = (): void => { void close().catch(() => {}); };
  input.signal?.addEventListener("abort", interrupted, { once: true });
  server.on("error", interrupted);
  if (input.signal?.aborted) interrupted();

  async function close(): Promise<void> {
    return closing ??= (async () => {
      shutdown.abort(new Error("The original TCP endpoint was retired."));
      input.signal?.removeEventListener("abort", interrupted);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => {
        if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve(); else reject(error);
      }));
      await Promise.all(serving);
    })();
  }

  return {
    async listen(): Promise<{ readonly address: "127.0.0.1"; readonly port: number }> {
      shutdown.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          server.removeListener("listening", ready); server.removeListener("error", failed);
          shutdown.signal.removeEventListener("abort", cancelled);
        };
        const ready = (): void => { cleanup(); resolve(); };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        const cancelled = (): void => { cleanup(); reject(shutdown.signal.reason); };
        server.once("listening", ready); server.once("error", failed);
        shutdown.signal.addEventListener("abort", cancelled, { once: true });
        try { server.listen({ host: "127.0.0.1", port: 0 }); } catch (error) { failed(error as Error); }
      });
      if (shutdown.signal.aborted) { await close(); shutdown.signal.throwIfAborted(); }
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The encrypted TCP endpoint did not acquire a port.");
      return Object.freeze({ address: "127.0.0.1" as const, port: address.port });
    },
    close
  };
}
