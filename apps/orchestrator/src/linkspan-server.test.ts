import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport/node";
import { createConnectionFetch } from "@joko/connection-transport";
import { ConnectionService } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { createIdentity } from "@jokoagent/linkspan-noise";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createPublicServer } from "./server.js";
import { createLinkspanIngress } from "./linkspan-server.js";
import { ConnectionManager } from "./connection-manager.js";
import { ArtifactStore } from "./artifact-store.js";
import { BlobTransferCoordinator } from "./blob-transfers.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import type { OrchestratorApplication } from "./application.js";

it.each(["https", "webrtc"] as const)("connects real generated RPC and Blob handlers through %s and retires revoked streams", async transportKind => {
  const root = await mkdtemp(join(tmpdir(), "joko-linkspan-product-"));
  const store = new OperationalStore(join(root, "state.db"));
  const connections = new ConnectionManager(store);
  const identity = await createIdentity();
  const artifactRepository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: artifactRepository, ingestRoots: [root] });
  await artifacts.initialize();
  const blobTransfers = new BlobTransferCoordinator(artifacts);
  const application = { config: { publicOrigin: "http://127.0.0.1", webDirectory: join(root, "web"), corsOrigins: [] },
    serverId: "secure-node-test", linkspanIdentity: identity, store, connections, artifacts, blobTransfers,
    artifactRepository, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
  } as unknown as OrchestratorApplication;
  const backend = await createPublicServer(application, { secureBridge: true });
  backend.log.level = "silent";
  backend.get("/v1/revocation-test", async (_request, reply) => {
    const { PassThrough } = await import("node:stream");
    const body = new PassThrough(); body.write("ready"); reply.type("application/octet-stream"); return reply.send(body);
  });
  const backendOrigin = await backend.listen({ host: "127.0.0.1", port: 0 });
  const ingress = createLinkspanIngress(application, { backendOrigin });
  const origin = await ingress.listen({ host: "127.0.0.1", port: 0 });
  try {
    const endpoint = { origin, endpointPublicKey: identity.publicKey, transportKind };
    const fetcher = createConnectionFetch(endpoint);
    const client = createClient(ConnectionService, createConnectTransport({ baseUrl: origin, endpointPublicKey: identity.publicKey, transportKind, httpVersion: "1.1" }));
    expect((await client.getServerInfo({})).server?.endpointPublicKey).toBe(identity.publicKey);
    connections.openPairingWindow();
    const cancelled = await client.beginPairing({ deviceDisplayName: "Cancel", platform: "test" });
    expect((await client.cancelPairing({ challengeId: cancelled.challenge!.challengeId })).cancelled).toBe(true);
    const invitation = connections.issuePairing("Trusted owner");
    const paired = await client.completePairing({ challengeId: invitation.id, humanCode: invitation.code, deviceDisplayName: "Secure client" });
    const key = paired.result!.authKey;
    const data = new Uint8Array(2 * 1024 * 1024).fill(137);
    const ticket = await blobTransfers.beginUpload({ expectedSize: data.length, expectedSha256: createHash("sha256").update(data).digest("hex") });
    const upload = await fetcher(new URL(ticket.relativeEndpoint, origin), { method: "PUT", body: data, headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream" } });
    expect(upload.ok).toBe(true); await upload.arrayBuffer();
    expect(blobTransfers.completeUpload(ticket.uploadId).byteLength).toBe(data.length);
    const live = await fetcher(`${origin}/v1/revocation-test`, { headers: { authorization: `Bearer ${key}` } });
    const reader = live.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
    connections.revoke(paired.result!.connection!.connectionId);
    await expect(reader.read()).rejects.toBeDefined();
    expect((await fetch(`${origin}/v1/blobs/private`)).status).toBe(404);
    expect((await fetch(`${origin}/_linkspan/webrtc`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
    const wrongIdentity = await createIdentity();
    const wrong = createConnectionFetch({ origin, endpointPublicKey: wrongIdentity.publicKey, transportKind });
    await expect(wrong(`${origin}/joko.v1.ConnectionService/GetServerInfo`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).rejects.toThrow();
  } finally { await ingress.close(); await backend.close(); store.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("retires rejected upgrades even when the peer leaves its connection half open", async () => {
  const identity = await createIdentity();
  const ingress = createLinkspanIngress({ linkspanIdentity: identity } as OrchestratorApplication, { backendOrigin: "http://127.0.0.1:1" });
  const origin = new URL(await ingress.listen({ host: "127.0.0.1", port: 0 }));
  const peer = createConnection({ host: origin.hostname, port: Number(origin.port), allowHalfOpen: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(peer, "connect");
    const reply = once(peer, "data");
    peer.write("GET /rejected HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    expect(String((await reply)[0])).toContain("404");
    await Promise.race([ingress.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Rejected upgrade blocked listener retirement.")), 1_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); peer.destroy(); await ingress.close(); }
});

it("uses the production TLS listener for pinned WSS pairing and rejects a wrong endpoint behind a trusted certificate", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-direct-wss-"));
  let store: OperationalStore | undefined;
  let backend: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  let primary: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  let ingress: ReturnType<typeof createLinkspanIngress> | undefined;
  let connectorIngress: ReturnType<typeof createLinkspanIngress> | undefined;
  try {
    const certificatePath = join(root, "certificate.pem"), privateKeyPath = join(root, "private.pem");
    const opensslConfig = join(root, "tls.cnf");
    await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n");
    const gitOpenSsl = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "openssl.exe");
    execFileSync(process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes", "-config", opensslConfig, "-keyout", privateKeyPath, "-out", certificatePath],
      { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    const ca = await readFile(certificatePath);
    vi.stubGlobal("WebSocket", class extends WebSocket { constructor(url: string | URL) { super(url, { ca }); } });
    store = new OperationalStore(join(root, "state.db"));
    const connections = new ConnectionManager(store), identity = await createIdentity();
    const application = { config: { publicOrigin: "https://127.0.0.1", webDirectory: join(root, "web"), corsOrigins: [],
      tls: { certificatePath, privateKeyPath } }, serverId: "direct-wss-node", linkspanIdentity: identity, store, connections,
      workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {}
    } as unknown as OrchestratorApplication;
    backend = await createPublicServer(application, { secureBridge: true }); backend.log.level = "silent";
    const backendOrigin = await backend.listen({ host: "127.0.0.1", port: 0 });
    primary = await createPublicServer(application); primary.log.level = "silent";
    const origin = await primary.listen({ host: "127.0.0.1", port: 0 });
    ingress = createLinkspanIngress(application, { backendOrigin, server: primary.server });
    const client = createClient(ConnectionService, createConnectTransport({ baseUrl: origin, endpointPublicKey: identity.publicKey, httpVersion: "1.1" }));
    expect((await client.getServerInfo({})).server?.endpointPublicKey).toBe(identity.publicKey);
    const invitation = connections.issuePairing("Direct TLS owner");
    const paired = (await client.completePairing({ challengeId: invitation.id, humanCode: invitation.code, deviceDisplayName: "Direct WSS" })).result!;
    const owner = createClient(ConnectionService, createConnectTransport({ baseUrl: origin, endpointPublicKey: identity.publicKey, httpVersion: "1.1",
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] }));
    expect((await owner.listConnections({})).connections.some(connection => connection.connectionId === paired.connection!.connectionId)).toBe(true);
    const other = await createIdentity();
    const wrong = createClient(ConnectionService, createConnectTransport({ baseUrl: origin, endpointPublicKey: other.publicKey, httpVersion: "1.1" }));
    await expect(wrong.getServerInfo({})).rejects.toThrow(/identity|authenticated|key/iu);
    connectorIngress = createLinkspanIngress(application, { backendOrigin, tls: { cert: ca, key: await readFile(privateKeyPath) } });
    const connectorOrigin = await connectorIngress.listen({ host: "127.0.0.1", port: 0 });
    expect(new URL(connectorOrigin).protocol).toBe("https:");
    const connectorClient = createClient(ConnectionService, createConnectTransport({ baseUrl: connectorOrigin, endpointPublicKey: identity.publicKey, httpVersion: "1.1" }));
    expect((await connectorClient.getServerInfo({})).server?.endpointPublicKey).toBe(identity.publicKey);
    const { get } = await import("node:https");
    expect(await new Promise<number | undefined>((resolve, reject) => {
      get(`${connectorOrigin}/joko.v1.ConnectionService/GetServerInfo`, { ca }, response => {
        response.resume(); resolve(response.statusCode);
      }).once("error", reject);
    })).toBe(404);
  } finally {
    await connectorIngress?.close(); await ingress?.close(); await primary?.close(); await backend?.close(); store?.close(); vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
