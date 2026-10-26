import { createSocket } from "node:dgram";
import { once } from "node:events";
import { create } from "@bufbuild/protobuf";
import { RemoteDesktopIceCandidateSchema, RemoteDesktopIceExchangeResultSchema } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { createDatagramBridge, type DatagramConfig, type DatagramMappingOptions, type DatagramMapping } from "@jokoagent/linkspan-connectors/datagram";
import { afterEach, expect, it, vi } from "vitest";
import { LinkspanRemoteDesktopUdpMapping, type MediaUdpInput } from "./linkspan-media-udp.js";
import type { OrchestratorConfig } from "./config.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fingerprint = `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`;
const candidate = (port: number, suffix = "1", mid = 0) => create(RemoteDesktopIceCandidateSchema, {
  candidate: `candidate:${suffix} 1 udp 2122260223 127.0.0.1 ${port} typ host generation 0 ufrag ufragA`, sdpMid: String(mid), sdpMLineIndex: mid, usernameFragment: "ufragA"
});
const sdp = (port?: number) => ["v=0", "a=ice-ufrag:ufragA", "a=ice-pwd:privateNativeIcePassword12345", fingerprint,
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", ...(port === undefined ? [] : [`a=${candidate(port).candidate}`]), "a=end-of-candidates", ""].join("\r\n");
const budget = { paidEnabled: false, maximumBytes: 65536, maximumSessionMs: 60000 };
const pinggy: DatagramConfig = { provider: "pinggy", runtime: "sdk", sdkDirectory: "prepared-pinggy-sdk", budget };

async function fixture(options: { readonly local?: () => boolean; readonly startup?: () => Promise<void>; readonly failCleanup?: () => boolean; readonly pid?: number; readonly configuration?: DatagramConfig; readonly sdkOwned?: boolean } = {}) {
  const store = new OperationalStore(":memory:");
  const connection = store.createConnection({ id: "controller-connection", deviceId: "controller", device: { kind: "web", platform: "web", defaultName: "Controller" }, name: "Controller", authKeyDigest: "controller-digest" });
  const configuration: DatagramConfig = options.configuration ?? { provider: "pangolin", helper: { executable: process.execPath, version: "pangolin-embedded-1", target: `${process.platform}-${process.arch}`, sha256: "a".repeat(64) }, budget: { paidEnabled: false, maximumBytes: 65536, maximumSessionMs: 60000 }, publicHost: "udp.example", publicPort: 32145, endpoint: "https://pangolin.example", siteId: "dedicated", siteSecret: "private-publisher-secret", remoteNodeId: "owned-node" };
  const config = { remoteDesktopUdp: { entryId: "entrance" }, dataDirectory: "unused", workspace: { root: "unused" } } as OrchestratorConfig;
  let bridgePort = 0; const closed = vi.fn(); const resolvedHosts: string[] = [];
  const start = vi.fn(async (_configuration: DatagramConfig, input: DatagramMappingOptions): Promise<DatagramMapping> => {
    expect(store.getOperation(input.requestId).status).toBe("started");
    const bridge = await createDatagramBridge(input.localTarget, configuration.budget); bridgePort = bridge.port;
    const resource = { provider: configuration.provider, requestId: input.requestId, id: `udp:${input.requestId}`, ...(options.sdkOwned ? {} : { processId: options.pid ?? 999_999_999 }), executableSha256: "a".repeat(64), createdByHost: true };
    input.onResource?.(resource); await options.startup?.();
    let ended!: (result: { reason: "stopped" }) => void; let closePromise: Promise<void> | undefined;
    const lifetime = new Promise<{ reason: "stopped" }>(resolve => { ended = resolve; });
    const close = (): Promise<void> => {
      closePromise ??= (async () => { if (options.failCleanup?.()) throw new Error("private-publisher-error"); closed(); await bridge.close(); ended({ reason: "stopped" }); })(); return closePromise;
    };
    cleanups.push(() => bridge.close());
    return { kind: `${configuration.provider}.udp` as DatagramMapping["kind"], mapping: { protocol: "udp", publicHost: configuration.publicHost ?? "allocated-udp.example", publicPort: bridge.port, localAddress: input.localTarget.address, localPort: input.localTarget.port, ownerId: input.localTarget.ownerId, requestId: input.requestId, expiresAt: Date.now() + 60000 }, resource, closed: lifetime, close };
  });
  const createProvider = () => new LinkspanRemoteDesktopUdpMapping({ config, store, serverId: "node-server", configuration, start,
    isLocalDesktopRoute: () => options.local?.() ?? true, resolvePublicAddress: async host => { resolvedHosts.push(host); return "198.51.100.7"; } });
  const provider = createProvider(); await provider.initialize();
  cleanups.push(async () => { await provider.close().catch(() => {}); store.close(); });
  const lease = new AbortController(); const request = new AbortController();
  const input: MediaUdpInput = { controllerConnectionId: connection.id, hostConnectionId: "local-main-connection", identity: { targetDeviceId: "local-main", targetDeviceRevision: 1n, relationId: "relation", relationRevision: 1n, routeGeneration: 7 }, leaseId: "media-lease", attemptId: "original-attempt", lifetimeSignal: lease.signal, signal: request.signal,
    assertCurrent: () => { lease.signal.throwIfAborted(); } };
  return { store, provider, createProvider, input, lease, request, start, closed, resolvedHosts, bridgePort: () => bridgePort };
}

it("maps only an authenticated same-host UDP candidate, preserves SDP identity, and carries real packets to the exact capture socket", async () => {
  const socket = createSocket("udp4"); socket.on("message", (data, remote) => socket.send(data, remote.port, remote.address));
  await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => socket.close(() => resolve())));
  const target = socket.address().port; const f = await fixture();
  const answer = await f.provider.mapAnswer(f.input, sdp(target));
  expect(answer).toContain(fingerprint); expect(answer).toContain("a=ice-pwd:privateNativeIcePassword12345"); expect(answer).toContain(`a=${candidate(target).candidate}`);
  expect(answer).toContain(`198.51.100.7 ${f.bridgePort()} typ srflx raddr 127.0.0.1 rport ${target}`); expect(f.start).toHaveBeenCalledTimes(1);
  const client = createSocket("udp4"); cleanups.push(() => new Promise<void>(resolve => client.close(() => resolve())));
  const reply = once(client, "message"); client.send(Buffer.from("DTLS-SRTP-test-packet"), f.bridgePort(), "127.0.0.1"); expect((await reply)[0].toString()).toBe("DTLS-SRTP-test-packet");
  const publicState = JSON.stringify(f.store.listSettings().map(record => record.value));
  expect(publicState).not.toContain("private-publisher-secret"); expect(publicState).not.toContain("privateNativeIcePassword12345"); expect(publicState).not.toContain(fingerprint);
  await f.provider.releaseLease(f.input.leaseId); expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value).toMatchObject({ state: "closed" });
});

it("binds frp, rathole and native SDK UDP publications to the original capture authority and exact packet socket", async () => {
  const socket = createSocket("udp4"); socket.on("message", (data, remote) => socket.send(data, remote.port, remote.address));
  await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => socket.close(() => resolve())));
  const target = socket.address().port;
  const helper = { executable: process.execPath, version: "fixed-fixture-target", target: `${process.platform}-${process.arch}`, sha256: "a".repeat(64) };
  const configurations: DatagramConfig[] = [
    { provider: "frp", helper, budget, publicHost: "udp.example", publicPort: 32145, remotePort: 32145,
      serverAddress: "relay.example", serverPort: 7000, serverName: "relay.example", serverCaPool: "prepared-relay-ca", token: "private-frp-token" },
    { provider: "rathole", helper, budget, publicHost: "udp.example", publicPort: 32145,
      remoteAddress: "relay.example:2333", serviceName: "owned-media", token: "private-rathole-token", transport: { type: "noise", remotePublicKey: "a".repeat(44) } },
    pinggy
  ];
  for (const configuration of configurations) {
    let local = true;
    const f = await fixture({ configuration, sdkOwned: configuration.provider === "pinggy", local: () => local });
    const answer = await f.provider.mapAnswer(f.input, sdp(target));
    expect(answer).toContain(fingerprint); expect(answer).toContain(`a=${candidate(target).candidate}`); expect(answer).toContain(`198.51.100.7 ${f.bridgePort()} typ srflx`);
    expect(f.start.mock.calls[0]?.[0]).toEqual(configuration);
    expect(f.resolvedHosts).toEqual([configuration.publicHost ?? "allocated-udp.example"]);
    const client = createSocket("udp4"); cleanups.push(() => new Promise<void>(resolve => client.close(() => resolve())));
    const reply = once(client, "message"); client.send(Buffer.from(`${configuration.provider}:original-media-packet`), f.bridgePort(), "127.0.0.1");
    expect((await reply)[0].toString()).toBe(`${configuration.provider}:original-media-packet`);
    const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value as { provider: string; requestId: string; state: string };
    expect(record.provider).toBe(configuration.provider);
    expect(f.store.getOperation(record.requestId).body).toMatchObject({ leaseId: f.input.leaseId, attemptId: f.input.attemptId, hostConnectionId: f.input.hostConnectionId, controllerConnectionId: f.input.controllerConnectionId, routeGeneration: f.input.identity.routeGeneration });
    local = false;
    expect(await f.provider.mapAnswer(f.input, sdp(target))).toBe(sdp(target)); expect(f.start).toHaveBeenCalledTimes(1);
    await f.provider.retireLocalCapture({ hostConnectionId: f.input.hostConnectionId, targetDeviceId: f.input.identity.targetDeviceId, leaseId: f.input.leaseId, attemptId: f.input.attemptId });
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(f.store.findSetting<{ state: string }>("service", "orchestrator", `runtime.linkspan.media_udp.${record.requestId}`)?.value.state).toBe("closed");
  }
});

it("recovers an SDK UDP publication only after its exact original service process has retired", async () => {
  let fail = true;
  const f = await fixture({ configuration: pinggy, sdkOwned: true, startup: async () => {
    if (fail) throw Object.assign(new Error("private-sdk-startup-failure"), { code: "outcome_unknown", outcome: "unknown" });
  } });
  expect(await f.provider.mapAnswer(f.input, sdp(4444))).toBe(sdp(4444));
  const request = { hostConnectionId: f.input.hostConnectionId, targetDeviceId: f.input.identity.targetDeviceId, leaseId: f.input.leaseId, attemptId: f.input.attemptId };
  await expect(f.provider.retireLocalCapture(request)).rejects.toThrow(/unconfirmed/u);
  const original = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!;
  const record = original.value as { requestId: string; ownerProcessId: number; ownerProcessIdentity: string; resource: { processId?: number }; state: string };
  expect(record.resource.processId).toBeUndefined(); expect(record.ownerProcessId).toBe(process.pid); expect(record.state).toBe("outcome_unknown");
  const live = f.createProvider(); await live.initialize();
  expect(await live.mapAnswer({ ...f.input, attemptId: "next-attempt" }, sdp(4444))).toBe(sdp(4444)); expect(f.start).toHaveBeenCalledTimes(1); await live.close();
  // The original owner is gone. Recovery only queries this exact process;
  // neither the saved operation nor the native SDK invocation is replayed.
  f.store.setSetting("service", "orchestrator", original.key, { ...record, ownerProcessId: 999_999_999 });
  fail = false;
  const recovered = f.createProvider(); await recovered.initialize();
  expect(f.store.findSetting<{ state: string }>("service", "orchestrator", original.key)?.value.state).toBe("closed");
  expect(f.store.getOperation(record.requestId).status).toBe("completed"); expect(f.start).toHaveBeenCalledTimes(1);
  expect(await recovered.mapAnswer({ ...f.input, attemptId: "next-attempt" }, sdp(4444))).toContain(" typ srflx ");
  expect(f.start).toHaveBeenCalledTimes(2); await recovered.close();
});

it("keeps every native trickle candidate with independent bounded pagination and stable re-reads", async () => {
  const f = await fixture(); await f.provider.mapAnswer(f.input, sdp());
  const originals = Array.from({ length: 16 }, (_, index) => candidate(4444, String(index + 1)));
  const native = vi.fn(async (after: number) => create(RemoteDesktopIceExchangeResultSchema, { attemptId: f.input.attemptId, candidates: after === 0 ? originals : [], next: 16, complete: true }));
  const first = await f.provider.exchangeIce(f.input, 0, native); expect(first.candidates).toHaveLength(16); expect(first.next).toBe(16); expect(first.complete).toBe(false);
  expect(first.candidates).toEqual(originals);
  const second = await f.provider.exchangeIce(f.input, 16, native); expect(second.next).toBe(17); expect(second.complete).toBe(true);
  expect(second.candidates[0]?.candidate).toContain(" typ srflx ");
  expect([...first.candidates, ...second.candidates].filter(value => !value.candidate.includes(" typ srflx "))).toEqual(originals);
  expect(await f.provider.exchangeIce(f.input, 0, native)).toEqual(first); expect(native.mock.calls.map(([after]) => after)).toEqual([0, 16, 16]);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("does not map remote Desktop claims, mDNS, nonlocal IPs, other protocols or a changed ICE generation", async () => {
  let local = false; const f = await fixture({ local: () => local });
  expect(await f.provider.mapAnswer(f.input, sdp(4444))).toBe(sdp(4444)); expect(f.start).not.toHaveBeenCalled(); local = true;
  for (const line of [candidate(4444).candidate.replace("127.0.0.1", "unproven.local"), candidate(4444).candidate.replace("127.0.0.1", "192.0.2.11"), candidate(4444).candidate.replace(" udp ", " tcp "), candidate(4444).candidate.replace("ufragA", "otherUfrag")]) {
    const answer = sdp().replace("a=end-of-candidates", `a=${line}\r\na=end-of-candidates`); expect(await f.provider.mapAnswer(f.input, answer)).toBe(answer);
  }
  const value = { ...candidate(4444), usernameFragment: "otherUfrag" };
  const native = async () => create(RemoteDesktopIceExchangeResultSchema, { attemptId: f.input.attemptId, candidates: [value], next: 1, complete: true });
  expect((await f.provider.exchangeIce(f.input, 0, native)).candidates).toEqual([value]); expect(f.start).not.toHaveBeenCalled();
});

it("bounds the full native 128-candidate stream plus sixteen public mappings without losing originals", async () => {
  const f = await fixture();
  const answer = ["v=0", "a=ice-ufrag:ufragA", "a=ice-pwd:privateNativeIcePassword12345", fingerprint, ...Array.from({ length: 16 }, (_, index) => `m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:${index}`), ""].join("\r\n");
  await f.provider.mapAnswer(f.input, answer);
  const originals = Array.from({ length: 128 }, (_, index) => candidate(4444, String(index + 1), index % 16));
  const native = vi.fn(async (after: number) => create(RemoteDesktopIceExchangeResultSchema, { attemptId: f.input.attemptId, candidates: originals.slice(after, after + 16), next: Math.min(128, after + 16), complete: after + 16 >= 128 }));
  const all = []; let after = 0;
  for (;;) { const page = await f.provider.exchangeIce(f.input, after, native); expect(page.candidates.length).toBeLessThanOrEqual(16); all.push(...page.candidates); expect(page.next).toBe(after + page.candidates.length); after = page.next; if (page.complete) break; }
  expect(all).toHaveLength(144); expect(all.filter(value => !value.candidate.includes(" typ srflx "))).toEqual(originals);
  expect(native.mock.calls.map(([after]) => after)).toEqual([0, 16, 32, 48, 64, 80, 96, 112, 128]); expect(f.start).toHaveBeenCalledTimes(1);
});

it("does not lose a consumed native page when its optional public mapping is cancelled", async () => {
  let release!: () => void; const startup = new Promise<void>(resolve => { release = resolve; }); const f = await fixture({ startup: () => startup });
  await f.provider.mapAnswer(f.input, sdp()); const originals = Array.from({ length: 16 }, (_, index) => candidate(4444, String(index + 1)));
  const native = vi.fn(async (after: number) => create(RemoteDesktopIceExchangeResultSchema, { attemptId: f.input.attemptId, candidates: after === 0 ? originals : [], next: 16, complete: true }));
  const pending = f.provider.exchangeIce(f.input, 0, native); const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1)); f.request.abort(); release(); await rejected;
  const replay = await f.provider.exchangeIce({ ...f.input, signal: new AbortController().signal }, 0, native);
  expect(replay.candidates).toEqual(originals); expect(replay.complete).toBe(true); expect(native.mock.calls.map(([after]) => after)).toEqual([0, 16]);
});

it("retires a late helper instead of adopting it after cancellation or an attempt switch", async () => {
  let release!: () => void; const startup = new Promise<void>(resolve => { release = resolve; }); const f = await fixture({ startup: () => startup });
  const pending = f.provider.mapAnswer(f.input, sdp(4444)); const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1)); f.lease.abort(); release(); await rejected;
  await f.provider.releaseLease(f.input.leaseId); expect(f.closed).toHaveBeenCalledTimes(1);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value as { state: string; requestId: string };
  expect(record.state).toBe("closed"); expect(f.store.getOperation(record.requestId).status).toBe("completed");
});

it("retains unknown cleanup and blocks another publication while its exact process is still live", async () => {
  const f = await fixture({ failCleanup: () => true, pid: process.pid }); await f.provider.mapAnswer(f.input, sdp(4444));
  await expect(f.provider.releaseLease(f.input.leaseId)).rejects.toThrow(/unconfirmed/u);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value as { state: string; requestId: string };
  expect(record.state).toBe("outcome_unknown"); expect(f.store.getOperation(`${record.requestId}:retire`).status).toBe("started");
  const resumed = f.createProvider(); await resumed.initialize();
  expect(await resumed.mapAnswer({ ...f.input, attemptId: "next-attempt" }, sdp(4444))).toBe(sdp(4444)); expect(f.start).toHaveBeenCalledTimes(1); await resumed.close();
});

it("can confirm a late original process exit on an explicit cleanup retry without recreating or killing a helper", async () => {
  const f = await fixture({ failCleanup: () => true }); await f.provider.mapAnswer(f.input, sdp(4444));
  const request = { hostConnectionId: f.input.hostConnectionId, targetDeviceId: f.input.identity.targetDeviceId, leaseId: f.input.leaseId, attemptId: f.input.attemptId };
  await expect(f.provider.retireLocalCapture(request)).rejects.toThrow(/unconfirmed/u);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value as { state: string; requestId: string };
  expect(f.store.getOperation(`${record.requestId}:retire`).status).toBe("started");
  await f.provider.retireLocalCapture(request);
  expect(f.store.findSetting<{ state: string }>("service", "orchestrator", `runtime.linkspan.media_udp.${record.requestId}`)?.value.state).toBe("closed");
  expect(f.store.getOperation(`${record.requestId}:retire`).status).toBe("completed"); expect(f.start).toHaveBeenCalledTimes(1);
});

it("never acknowledges capture retirement after an uncertain startup with a still-live original helper", async () => {
  const f = await fixture({ pid: process.pid, startup: async () => { throw Object.assign(new Error("private-startup-failure"), { code: "outcome_unknown", outcome: "unknown" }); } });
  expect(await f.provider.mapAnswer(f.input, sdp(4444))).toBe(sdp(4444));
  const request = { hostConnectionId: f.input.hostConnectionId, targetDeviceId: f.input.identity.targetDeviceId, leaseId: f.input.leaseId, attemptId: f.input.attemptId };
  await expect(f.provider.retireLocalCapture(request)).rejects.toThrow(/startup cleanup is unconfirmed/u);
  await expect(f.provider.retireLocalCapture(request)).rejects.toThrow(/unconfirmed/u);
  const record = f.store.listSettingsByKeyPrefix("service", "orchestrator", "runtime.linkspan.media_udp.")[0]!.value as { state: string; requestId: string };
  expect(record.state).toBe("outcome_unknown"); expect(f.store.getOperation(`${record.requestId}:retire`).status).toBe("started"); expect(f.start).toHaveBeenCalledTimes(1);
});

it("requires the original local Main for capture retirement and never retires another attempt", async () => {
  const f = await fixture(); await f.provider.mapAnswer(f.input, sdp(4444));
  const request = { hostConnectionId: f.input.hostConnectionId, targetDeviceId: f.input.identity.targetDeviceId, leaseId: f.input.leaseId, attemptId: f.input.attemptId };
  await expect(f.provider.retireLocalCapture({ ...request, hostConnectionId: "another-host" })).rejects.toThrow(/another/u); expect(f.closed).not.toHaveBeenCalled();
  await f.provider.retireLocalCapture({ ...request, attemptId: "stale-attempt" }); expect(f.closed).not.toHaveBeenCalled();
  await f.provider.retireLocalCapture(request); expect(f.closed).toHaveBeenCalledTimes(1);
  await f.provider.retireLocalCapture(request); expect(f.closed).toHaveBeenCalledTimes(1);
});
it("retires the original mapping when the ICE password changes under the same attempt identity", async () => {
  const f = await fixture(); await f.provider.mapAnswer(f.input, sdp(4444));
  await expect(f.provider.mapAnswer(f.input, sdp(4444).replace("privateNativeIcePassword12345", "replacementIcePassword12345"))).rejects.toThrow(/identity changed/u);
  expect(f.closed).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1);
});
