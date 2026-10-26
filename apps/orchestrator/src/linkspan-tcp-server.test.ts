import { once } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { createIdentity, connectStream } from "@jokoagent/linkspan-noise";
import { createHttpFetch } from "@jokoagent/linkspan-http";
import { createNodeStreamCarrier } from "@jokoagent/linkspan-http-connect/node";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import { createLinkspanTcpIngress } from "./linkspan-tcp-server.js";
import type { OrchestratorApplication } from "./application.js";

it("requires the original Noise pin for real pairing/RPC and retires a live request on whole-Device revocation", async () => {
  const store = new OperationalStore(":memory:"), connections = new ConnectionManager(store), identity = await createIdentity();
  const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: "not-a-web-directory", corsOrigins: [] },
    serverId: "tcp-node", linkspanIdentity: identity, store, connections,
    workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
  } as unknown as OrchestratorApplication;
  const backend = await createPublicServer(application, { secureBridge: true }); backend.log.level = "silent";
  let backendRequests = 0;
  backend.addHook("onRequest", async () => { backendRequests++; });
  backend.get("/v1/tcp-live", async (_request, reply) => { const body = new PassThrough(); body.write("ready"); return reply.send(body); });
  const backendOrigin = await backend.listen({ host: "127.0.0.1", port: 0 });
  const ingress = createLinkspanTcpIngress(application, { backendOrigin });
  const target = await ingress.listen();
  const origin = "https://logical-tcp.example";
  const dial = (expectedPublicKey: string) => async (options: OperationOptions) => {
    const socket = createConnection({ host: target.address, port: target.port });
    try {
      await once(socket, "connect", { signal: options.signal });
      return await connectStream(createNodeStreamCarrier(socket, { signal: options.signal }), { ...options, expectedPublicKey });
    } catch (error) { socket.destroy(); throw error; }
  };
  const fetcher = createHttpFetch({ origin, connect: dial(identity.publicKey) });
  const rpc = (method: string, body: unknown, authKey?: string) => fetcher(`${origin}/joko.v1.ConnectionService/${method}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(authKey === undefined ? {} : { authorization: `Bearer ${authKey}` }) }
  });
  try {
    const wrong = createHttpFetch({ origin, connect: dial((await createIdentity()).publicKey) });
    await expect(wrong(`${origin}/joko.v1.ConnectionService/GetServerInfo`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).rejects.toThrow();
    expect(backendRequests).toBe(0);
    expect((await (await rpc("GetServerInfo", {})).json() as { server: { endpointPublicKey: string } }).server.endpointPublicKey).toBe(identity.publicKey);
    const denied = await rpc("ListConnections", {}); expect(denied.status).toBe(401); await denied.arrayBuffer();
    const invitation = connections.issuePairing("Trusted TCP owner");
    const paired = await (await rpc("CompletePairing", { challengeId: invitation.id, humanCode: invitation.code, deviceDisplayName: "TCP client" })).json() as {
      result: { authKey: string; connection: { deviceId: string; connectionId: string } }
    };
    const listed = await rpc("ListConnections", {}, paired.result.authKey); expect(listed.ok).toBe(true); await listed.arrayBuffer();
    const live = await fetcher(`${origin}/v1/tcp-live`, { headers: { authorization: `Bearer ${paired.result.authKey}` } });
    const reader = live.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
    connections.revokeDevice(paired.result.connection.deviceId);
    await expect(reader.read()).rejects.toBeDefined();
    const retired = await rpc("ListConnections", {}, paired.result.authKey); expect(retired.status).toBe(401); await retired.arrayBuffer();
    expect(store.getConnection(paired.result.connection.connectionId).state).toBe("revoked");
  } finally { await ingress.close(); await backend.close(); store.close(); }
}, 30_000);

it("never forwards plaintext HTTP and retires silent half-open sockets on its original owner's cancellation", async () => {
  const identity = await createIdentity(), controller = new AbortController();
  const ingress = createLinkspanTcpIngress({ linkspanIdentity: identity } as OrchestratorApplication,
    { backendOrigin: "http://127.0.0.1:1", signal: controller.signal });
  const target = await ingress.listen();
  const peers = [createConnection({ host: target.address, port: target.port, allowHalfOpen: true }),
    createConnection({ host: target.address, port: target.port, allowHalfOpen: true })];
  const authenticatedSocket = createConnection({ host: target.address, port: target.port });
  let authenticated: Awaited<ReturnType<typeof connectStream>> | undefined;
  const received: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const peer of peers) { peer.on("error", () => {}); peer.on("data", bytes => received.push(bytes)); }
  try {
    await Promise.all([...peers, authenticatedSocket].map(peer => once(peer, "connect")));
    authenticated = await connectStream(createNodeStreamCarrier(authenticatedSocket), { expectedPublicKey: identity.publicKey, deadline: Date.now() + 3_000 });
    await new Promise<void>((resolve, reject) => peers[0]!.write("GET /joko.v1.ConnectionService/GetServerInfo HTTP/1.1\r\nHost: localhost\r\n\r\n", error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => setImmediate(resolve));
    // A half-open client retains its writable side after FIN, while rejecting
    // its unread plaintext can produce a reset. Both retire the server side.
    const ended = Promise.all(peers.map(peer => peer.readableEnded || peer.closed ? undefined : new Promise<void>(resolve => {
      const done = (): void => { peer.removeListener("end", done); peer.removeListener("close", done); resolve(); };
      peer.once("end", done); peer.once("close", done);
    })));
    controller.abort();
    let serverRetired = false, channelRetired = false;
    await Promise.race([Promise.all([ingress.close().then(() => { serverRetired = true; }), ended,
      authenticated.closed.then(() => { channelRetired = true; })]), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`TCP endpoint cancellation did not settle: ${JSON.stringify({ serverRetired, channelRetired,
        peers: peers.map(peer => ({ ended: peer.readableEnded, closed: peer.closed, destroyed: peer.destroyed })) })}`)), 1_000);
    })]);
    expect(Buffer.concat(received).toString("utf8")).not.toContain("HTTP/");
    await expect(ingress.listen()).rejects.toBeDefined();
  } finally { if (timer !== undefined) clearTimeout(timer); authenticated?.abort(); authenticatedSocket.destroy(); for (const peer of peers) peer.destroy(); await ingress.close(); }
});
