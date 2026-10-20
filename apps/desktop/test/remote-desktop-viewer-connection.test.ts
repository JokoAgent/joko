import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopService, DevicePeerRouteIdentitySchema, RemoteDesktopFailureSchema, RemoteDesktopFailureReason,
  type DesktopRemoteDesktopViewerOwner } from "@joko/contracts";
import { DesktopRemoteDesktopViewerConnection } from "../src/remote-desktop-viewer-connection.js";

const OWNER: DesktopRemoteDesktopViewerOwner = { profileId: "profile", serverId: "node", deviceId: "controller",
  origin: "https://node.example", connectionGeneration: 1 };
const PEER = create(DevicePeerRouteIdentitySchema, { targetDeviceId: "host", relationId: "relation",
  routeGeneration: 1n, relationRevision: { value: 1n }, targetDeviceRevision: { value: 1n } });
const LEASE = { leaseId: "lease", display: { displayId: "display", name: "Display", width: 1200, height: 800 },
  controlling: false, controlGeneration: 1n };
type Handler = (input: Record<string, unknown>) => Promise<object> | object;

function fixture(handlers: Record<string, Handler> = {}) {
  let current: DesktopRemoteDesktopViewerOwner | undefined = OWNER;
  const reads = vi.fn(async () => "A".repeat(43));
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = {
    async unary(method, _signal, _timeout, _header, input) {
      const body = input as Record<string, unknown>;
      calls.push({ name: method.localName, input: body });
      const output = await (handlers[method.localName]?.(body) ?? (method.localName === "getServerInfo" ? { server: { serverId: "node" } } :
        method.localName === "listRemoteDesktopHosts" ? { hosts: [{ route: PEER }] } :
        method.localName === "startRemoteDesktop" ? { peer: PEER, lease: LEASE } : { peer: PEER }));
      return { stream: false, method, service: method.parent, header: new Headers(), trailer: new Headers(), message: create(method.output, output as MessageInitShape<typeof method.output>) };
    }, stream() { throw new Error("No streams in this fixture."); }
  };
  const factory = vi.fn(() => transport);
  const connection = new DesktopRemoteDesktopViewerConnection(OWNER, "host", {
    current: () => current, readAuthKey: reads, transport: factory
  });
  const request = async (name: keyof typeof RemoteDesktopService.method, input: Record<string, unknown> = {}, guard?: () => void) => {
    const method = RemoteDesktopService.method[name];
    return connection.request(name, toBinary(method.input, create(method.input, input)), guard);
  };
  return { connection, request, calls, reads, factory, change: (owner?: DesktopRemoteDesktopViewerOwner) => { current = owner; } };
}

describe("Desktop viewer connection authority", () => {
  it("adopts first and repeated viewer Fit, Restore and physical-mode source receipts on the same lease", async () => {
    const f: ReturnType<typeof fixture> = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform: "linux", displayModes: true, resolutionRestore: true, viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopControl: input => ({ peer: PEER, state: { controlling: input["enabled"], controlGeneration: f.connection.lease!.controlGeneration + 1n } }),
      setRemoteDesktopViewerDisplay: input => ({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: input["controlGeneration"] as bigint + 1n,
        display: { ...LEASE.display, displayId: "mirror", width: input["width"], height: input["height"] } } } }),
      restoreRemoteDesktopViewerDisplay: input => ({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: input["controlGeneration"] as bigint + 1n } } }),
      setRemoteDesktopDisplayMode: input => ({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: input["controlGeneration"] as bigint + 1n,
        display: { ...LEASE.display, width: 900, height: 600 } } } })
    });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    for (const [width, height] of [[1280, 720], [800, 600]]) {
      const generation = f.connection.lease!.controlGeneration;
      expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: generation, width, height })).ok).toBe(true);
      expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, controlGeneration: generation + 1n, display: { displayId: "mirror", width, height } });
      await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    }
    expect((await f.request("restoreRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: f.connection.lease!.controlGeneration })).ok).toBe(true);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, display: { displayId: "display" } });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: f.connection.lease!.controlGeneration, width: 1280, height: 720 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    expect((await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: f.connection.lease!.controlGeneration, modeId: "20", temporary: true })).ok).toBe(true);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, display: { displayId: "display", width: 900, height: 600 } });
    await f.connection.stop();
  });

  it("blocks viewer input, media and new starts while Fit is pending", async () => {
    const pending = deferred<object>();
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform: "linux", viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopViewerDisplay: () => pending.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const changing = f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("setRemoteDesktopViewerDisplay"));
    for (const name of ["sendRemoteDesktopInput", "getRemoteDesktopFrame", "createRemoteDesktopOffer"] as const) {
      expect((await f.request(name, { leaseId: "lease", sequence: 1n, attemptId: "mirror", offerSdp: "offer" })).ok).toBe(false);
      expect(f.calls.some(call => call.name === name)).toBe(false);
    }
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(false);
    expect(f.calls.filter(call => call.name === "startRemoteDesktop")).toHaveLength(1);
    pending.resolve({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n, display: { ...LEASE.display, displayId: "mirror", width: 1280, height: 720 } } } });
    expect((await changing).ok).toBe(true); await f.connection.stop();
  });

  it("keeps unknown viewer geometry until ordinary stop actually settles before a new source start", async () => {
    const stopped = deferred<object>(); let writes = 0;
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform: "linux", viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: true, controlGeneration: 3n } }),
      setRemoteDesktopViewerDisplay: () => { if (++writes > 1) throw new ConnectError("Receipt unavailable", Code.Unknown);
        return { peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n, display: { ...LEASE.display, displayId: "mirror", width: 1280, height: 720 } } } }; },
      stopRemoteDesktop: () => stopped.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 3n, width: 800, height: 600 })).ok).toBe(false);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, display: { displayId: "mirror" } });
    expect((await f.request("sendRemoteDesktopInput", { leaseId: "lease", sequence: 1n })).ok).toBe(false);
    const stopping = f.request("stopRemoteDesktop", { leaseId: "lease", lockScreen: false, controlGeneration: 0n });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("stopRemoteDesktop"));
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(false);
    stopped.resolve({ peer: PEER }); await stopping;
    expect(f.connection.lease).toBeUndefined();
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(true); f.connection.retire();
  });

  it.each(["dimensions", "capture", "lease", "control", "generation"])("retains the viewer handle after an invalid %s Fit receipt", async kind => {
    let writes = 0;
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform: "linux", viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: true, controlGeneration: 3n } }),
      setRemoteDesktopViewerDisplay: input => {
        if (++writes === 1) return { peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n, display: { ...LEASE.display, displayId: "mirror", width: 1280, height: 720 } } } };
        return { peer: PEER, result: { lease: { ...LEASE, leaseId: kind === "lease" ? "replacement" : "lease", controlling: kind === "control",
          controlGeneration: kind === "generation" ? 3n : 4n, display: { ...LEASE.display, displayId: kind === "capture" ? "second-mirror" : "mirror",
            width: kind === "dimensions" ? 900 : input["width"], height: input["height"] } } } };
      } });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 3n, width: 800, height: 600 })).ok).toBe(false);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, controlGeneration: 3n, display: { displayId: "mirror", width: 1280, height: 720 } });
    await f.connection.stop();
  });

  it.each([
    { platform: "darwin", width: 1, height: 1, accepted: true },
    { platform: "darwin", width: 640, height: 360, accepted: true },
    { platform: "darwin", width: 1280, height: 721, accepted: true },
    { platform: "darwin", width: 4096, height: 2304, accepted: true },
    { platform: "darwin", width: 1280, height: 722, accepted: false },
    { platform: "darwin", width: 4097, height: 2304, accepted: false },
    { platform: "linux", width: 640, height: 360, accepted: false }
  ])("adopts only $platform permitted logical Fit $width x $height", async ({ platform, width, height, accepted }) => {
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform,
      displays: [LEASE.display], viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopViewerDisplay: () => ({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n,
        display: { ...LEASE.display, displayId: "mirror", width, height } } } }) });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 })).ok).toBe(accepted);
    expect(f.connection.lease).toMatchObject(accepted
      ? { leaseId: "lease", controlling: false, controlGeneration: 2n, display: { displayId: "mirror", width, height } }
      : { leaseId: "lease", controlling: false, controlGeneration: 1n, display: LEASE.display });
    await f.connection.stop(); expect(f.connection.lease).toBeUndefined();
  });

  it.each(["win32", "", "unsupported"])("does not dispatch viewer Fit on unsupported captured platform %s", async platform => {
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform, viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }) });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 })).ok).toBe(false);
    expect(f.calls.some(call => call.name === "setRemoteDesktopViewerDisplay")).toBe(false); await f.connection.stop();
  });

  it.each(["darwin", "linux"])("uses dispatch-captured %s platform despite a later capability refresh", async initialPlatform => {
    const pending = deferred<object>(); let platform = initialPlatform;
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform, viewerDisplay: true, viewerDisplayRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopViewerDisplay: () => pending.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const changing = f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("setRemoteDesktopViewerDisplay"));
    platform = initialPlatform === "darwin" ? "linux" : "darwin"; await f.request("getRemoteDesktopCapabilities");
    pending.resolve({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n,
      display: { ...LEASE.display, displayId: "mirror", width: 640, height: 360 } } } });
    expect((await changing).ok).toBe(initialPlatform === "darwin"); await f.connection.stop();
  });

  it("retains Mac mirror responsibility when a Fit receipt captures another physical directory display", async () => {
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { platform: "darwin", viewerDisplay: true,
      viewerDisplayRestore: true, displays: [LEASE.display, { ...LEASE.display, displayId: "other-physical" }] } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopViewerDisplay: () => ({ peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n,
        display: { ...LEASE.display, displayId: "other-physical", width: 640, height: 360 } } } }) });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    expect((await f.request("setRemoteDesktopViewerDisplay", { leaseId: "lease", controlGeneration: 1n, width: 1280, height: 720 })).ok).toBe(false);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, display: LEASE.display });
    await f.connection.stop(); expect(f.connection.lease).toBeUndefined();
  });

  it("forwards finite capture pending without retiring a Linux portal lease", async () => {
    const pending = () => { throw new ConnectError("Local approval pending", Code.FailedPrecondition, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.CAPTURE_PENDING }) }]); };
    const f = fixture({ createRemoteDesktopOffer: pending, getRemoteDesktopFrame: pending });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    for (const name of ["createRemoteDesktopOffer", "getRemoteDesktopFrame"] as const) {
      expect(await f.request(name, { leaseId: "lease", attemptId: "portal", offerSdp: "offer" })).toMatchObject({ ok: false, reason: RemoteDesktopFailureReason.CAPTURE_PENDING });
      expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false });
    }
    expect(f.calls.some(call => call.name === "stopRemoteDesktop")).toBe(false); await f.connection.stop();
  });

  it("adopts same-lease temporary geometry and suppresses old media/control receipts", async () => {
    const frame = deferred<object>(); const grant = deferred<object>();
    const f = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { displayModes: true, resolutionRestore: true } }),
      setRemoteDesktopControl: input => input["enabled"] ? grant.promise : { peer: PEER },
      getRemoteDesktopFrame: () => frame.promise,
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopDisplayMode: () => ({ peer: PEER, result: { lease: { ...LEASE, display: { ...LEASE.display, width: 900, height: 600 }, controlGeneration: 2n } } })
    });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const oldFrame = f.request("getRemoteDesktopFrame", { leaseId: "lease" });
    const oldControl = f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    await vi.waitFor(() => expect(f.calls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(1));
    expect((await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: 1n, modeId: "20", temporary: true })).ok).toBe(true);
    frame.resolve({ peer: PEER, result: {} }); grant.resolve({ peer: PEER, state: { controlling: true, controlGeneration: 1n } });
    expect((await oldFrame).ok).toBe(false); expect((await oldControl).ok).toBe(false);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, controlGeneration: 2n, display: { width: 900, height: 600 } });
    expect(f.calls.filter(call => call.name === "setRemoteDesktopControl")).toHaveLength(1);
    await f.connection.stop();
  });

  it.each([true, false])("keeps an in-flight screenshot when control changes to %s without changing its capture", async enabled => {
    const frame = deferred<object>();
    const f = fixture({
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: !enabled } }),
      getRemoteDesktopFrame: () => frame.promise,
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: enabled, controlGeneration: 2n } })
    });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pendingFrame = f.request("getRemoteDesktopFrame", { leaseId: "lease" });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("getRemoteDesktopFrame"));
    expect((await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled })).ok).toBe(true);
    frame.resolve({ peer: PEER, result: { frame: { jpeg: new Uint8Array([255, 216, 255, 217]) } } });
    expect((await pendingFrame).ok).toBe(true);
    expect(f.connection.lease).toMatchObject({ ...LEASE, controlling: enabled, controlGeneration: 2n });
    await f.connection.stop();
  });

  it.each([true, false])("keeps an in-flight heartbeat when control changes to %s without changing its capture", async enabled => {
    const heartbeat = deferred<object>();
    const f = fixture({
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: !enabled } }),
      heartbeatRemoteDesktop: () => heartbeat.promise,
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: enabled, controlGeneration: 2n } })
    });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pending = f.request("heartbeatRemoteDesktop", { leaseId: "lease" });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("heartbeatRemoteDesktop"));
    expect((await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled })).ok).toBe(true);
    heartbeat.resolve({ peer: PEER, state: { controlling: !enabled, controlGeneration: 1n } });
    expect((await pending).ok).toBe(true);
    expect(f.connection.lease).toMatchObject({ ...LEASE, controlling: enabled, controlGeneration: 2n });
    await f.connection.stop();
  });

  it.each(["owner", "document", "peer", "capture"] as const)("rejects an in-flight heartbeat after its %s authority changes", async kind => {
    const heartbeat = deferred<object>();
    let documentCurrent = true;
    const f = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { displayModes: true, resolutionRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      heartbeatRemoteDesktop: () => heartbeat.promise,
      setRemoteDesktopDisplayMode: () => ({ peer: PEER, result: { lease: { ...LEASE,
        display: { ...LEASE.display, width: 900, height: 600 }, controlGeneration: 2n } } })
    });
    await f.request("getRemoteDesktopCapabilities");
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pending = f.request("heartbeatRemoteDesktop", { leaseId: "lease" }, () => {
      if (!documentCurrent) throw new ConnectError("Document retired.", Code.Canceled);
    });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("heartbeatRemoteDesktop"));
    if (kind === "owner") f.change({ ...OWNER, connectionGeneration: 2 });
    if (kind === "document") documentCurrent = false;
    if (kind === "capture") expect((await f.request("setRemoteDesktopDisplayMode", {
      leaseId: "lease", controlGeneration: 1n, modeId: "20", temporary: true
    })).ok).toBe(true);
    heartbeat.resolve({ peer: kind === "peer" ? { ...PEER, routeGeneration: 2n } : PEER,
      state: { controlling: true, controlGeneration: 9n } });
    expect((await pending).ok).toBe(false);
    expect(f.connection.lease?.controlGeneration).toBe(kind === "capture" ? 2n : 1n);
    f.connection.retire();
  });

  it("blocks input after an uncertain temporary write and accepts explicit old STOPPED cleanup before NEW", async () => {
    const f = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { displayModes: true, resolutionRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopDisplayMode: () => { throw new ConnectError("Restore pending", Code.FailedPrecondition, undefined,
        [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE }) }]); },
      stopRemoteDesktop: () => { throw new ConnectError("Old lease ended", Code.FailedPrecondition, undefined,
        [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.STOPPED }) }]); }
    });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    expect(await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: 1n, modeId: "20", temporary: true }))
      .toMatchObject({ ok: false, reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE });
    expect((await f.request("sendRemoteDesktopInput", { leaseId: "lease", controlGeneration: 1n, sequence: 1n })).ok).toBe(false);
    expect(f.calls.some(call => call.name === "sendRemoteDesktopInput")).toBe(false);
    await f.request("stopRemoteDesktop", { leaseId: "lease", lockScreen: false, controlGeneration: 0n });
    expect(f.connection.lease).toBeUndefined();
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 }); expect(f.connection.lease?.controlling).toBe(true);
    f.connection.retire();
  });

  it("ignores an old geometry expiry but retains a terminal mode handle for explicit cleanup", async () => {
    let rejectFrame!: (error: unknown) => void;
    const expired = () => new ConnectError("Retired geometry", Code.FailedPrecondition, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.LEASE_EXPIRED }) }]);
    const f = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { displayModes: true, resolutionRestore: true } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      getRemoteDesktopFrame: () => new Promise((_, reject) => { rejectFrame = reject; }),
      setRemoteDesktopDisplayMode: input => {
        if (input["controlGeneration"] === 2n) throw expired();
        return { peer: PEER, result: { lease: { ...LEASE, controlGeneration: 2n } } };
      },
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: true, controlGeneration: 2n } })
    });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pending = f.request("getRemoteDesktopFrame", { leaseId: "lease" }); await vi.waitFor(() => expect(rejectFrame).toBeTypeOf("function"));
    await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: 1n, modeId: "20", temporary: true });
    rejectFrame(expired()); await pending; expect(f.connection.lease?.controlGeneration).toBe(2n);
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: 2n, modeId: "30", temporary: true });
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, controlGeneration: 2n });
    await f.connection.stop(); expect(f.connection.lease).toBeUndefined();
  });

  it.each(["peer", "generation", "capability"] as const)("rejects a temporary mode with mismatched %s authority", async kind => {
    const f = fixture({
      getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { displayModes: true, resolutionRestore: kind !== "capability" } }),
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, controlling: true } }),
      setRemoteDesktopDisplayMode: () => ({ peer: PEER, result: { lease: { ...LEASE, leaseId: kind === "peer" ? "replacement" : "lease", controlGeneration: 2n } } })
    });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const reply = await f.request("setRemoteDesktopDisplayMode", { leaseId: "lease", controlGeneration: kind === "generation" ? 9n : 1n, modeId: "20", temporary: true });
    expect(reply.ok).toBe(false); expect(f.connection.lease?.leaseId).toBe("lease");
    expect(f.calls.filter(call => call.name === "setRemoteDesktopDisplayMode")).toHaveLength(kind === "peer" ? 1 : 0);
    f.connection.retire();
  });

  it("keeps credential RPCs out of generic renderer requests while trusted Main uses its captured route and larger envelope", async () => {
    const f = fixture({ requestRemoteDesktopCredentials: () => ({ peer: PEER, result: { result: { case: "exchanged", value: { ciphertext: "opaque-reply" } } } }) });
    await expect(f.request("getRemoteDesktopLockState")).rejects.toThrow("Invalid viewer request");
    await expect(f.request("requestRemoteDesktopCredentials")).rejects.toThrow("Invalid viewer request");
    expect(f.calls).toHaveLength(0);
    const request = { request: { case: "exchange", value: { handle: "11111111-1111-4111-8111-111111111111", ciphertext: "C".repeat(120_000) } } };
    await f.connection.credentialRequest("requestRemoteDesktopCredentials", { request }, () => undefined);
    expect(f.calls.at(-1)?.input).toMatchObject({ peer: PEER, request });
    f.change({ ...OWNER, connectionGeneration: 2 });
    await expect(f.connection.credentialRequest("getRemoteDesktopLockState", {}, () => undefined)).rejects.toMatchObject({ code: Code.Canceled });
    expect(f.calls.at(-1)?.name).toBe("requestRemoteDesktopCredentials");
  });

  it("requires the current privacy capability and exact controlling generation before and after the effect", async () => {
    const result = deferred<object>();
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { privacyScreen: true } }),
      setRemoteDesktopControl: (input) => ({ peer: PEER, state: { controlling: input["enabled"], controlGeneration: input["enabled"] ? 2n : 3n } }),
      setRemoteDesktopPrivacyScreen: () => result.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const request = { leaseId: "lease", controlGeneration: 2n, enabled: true, lockOnExit: true };
    expect((await f.request("setRemoteDesktopPrivacyScreen", { request })).ok).toBe(false);
    expect(f.calls.some(call => call.name === "setRemoteDesktopPrivacyScreen")).toBe(false);
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    const pending = f.request("setRemoteDesktopPrivacyScreen", { request });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("setRemoteDesktopPrivacyScreen"));
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: false });
    result.resolve({ peer: PEER, result: { enabled: true } }); expect((await pending).ok).toBe(false);
  });

  it("restricts clipboard sync primitives to the Main owner and rejects a late result after control retirement", async () => {
    const version = deferred<object>();
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { clipboardSync: true } }),
      setRemoteDesktopControl: (input) => ({ peer: PEER, state: { controlling: input["enabled"], controlGeneration: input["enabled"] ? 2n : 3n } }),
      setRemoteDesktopClipboardSync: () => ({ peer: PEER, result: { enabled: true, syncGeneration: 7n } }),
      getRemoteDesktopClipboardVersion: () => version.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    const request = { leaseId: "lease", controlGeneration: 2n, enabled: true };
    expect((await f.request("setRemoteDesktopClipboardSync", { request })).ok).toBe(false);
    expect(f.calls.some((call) => call.name === "setRemoteDesktopClipboardSync")).toBe(false);
    const lease = f.connection.lease!;
    expect((await f.connection.syncRequest("setRemoteDesktopClipboardSync", { request }, lease, () => undefined)).ok).toBe(true);
    expect((await f.request("transferRemoteDesktopClipboardContent", { transfer: {
      leaseId: "lease", controlGeneration: 2n, sync: true, syncGeneration: 7n, action: { case: "paste", value: { data: '{"text":"content"}' } }
    } })).ok).toBe(false);
    const pending = f.connection.syncRequest("getRemoteDesktopClipboardVersion", { request: {
      leaseId: "lease", controlGeneration: 2n, syncGeneration: 7n
    } }, lease, () => undefined);
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("getRemoteDesktopClipboardVersion"));
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: false });
    version.resolve({ peer: PEER, result: { version: "4" } }); expect((await pending).ok).toBe(false);
  });

  it("admits a view-only lock only through dedicated stop and retains its failure until explicit terminated-lease recovery", async () => {
    const failure = (reason: RemoteDesktopFailureReason) => new ConnectError("Exit failed", Code.FailedPrecondition, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason }) }]);
    const stop = vi.fn().mockRejectedValueOnce(failure(RemoteDesktopFailureReason.LOCK_FAILED))
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.LOCK_EXPIRED))
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED)).mockResolvedValue({ peer: PEER });
    let starts = 0;
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { lockOnExit: true } }), stopRemoteDesktop: stop,
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, leaseId: `lease-${++starts}` } }) });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    expect((await f.request("stopRemoteDesktop", { leaseId: "lease-1", lockScreen: true, controlGeneration: 1n })).ok).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    await expect(f.connection.stop(true)).rejects.toThrow("exit could not be confirmed");
    expect(f.calls.at(-1)?.input).toMatchObject({ leaseId: "lease-1", lockScreen: true, controlGeneration: 1n, peer: PEER });
    expect(f.connection.lease).toMatchObject({ leaseId: "lease-1", controlling: false, controlGeneration: 1n });
    await expect(f.connection.stop(true)).rejects.toThrow(); expect(f.connection.lease?.leaseId).toBe("lease-1");
    await expect(f.connection.stop()).rejects.toThrow(); expect(f.connection.lease).toBeUndefined();
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(true);
    expect(f.connection.lease?.leaseId).toBe("lease-2"); await f.connection.stop(true);
    expect(stop).toHaveBeenCalledTimes(4); expect(f.connection.lease).toBeUndefined();
  });

  it("rejects a delayed lock acknowledgement after the control occurrence changes and performs retirement with no lock", async () => {
    const stop = deferred<object>();
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { lockOnExit: true } }),
      stopRemoteDesktop: () => stop.promise, heartbeatRemoteDesktop: () => ({ peer: PEER, state: { controlling: false, controlGeneration: 2n } }) });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pending = f.connection.stop(true);
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("stopRemoteDesktop"));
    await f.request("heartbeatRemoteDesktop", { leaseId: "lease" }); stop.resolve({ peer: PEER });
    await expect(pending).rejects.toThrow("exit could not be confirmed");
    expect(f.connection.lease?.controlGeneration).toBe(2n); f.connection.retire();
    expect(f.calls.at(-1)?.input["leaseId"]).toBe("lease");
    expect(f.calls.at(-1)?.input["lockScreen"] ?? false).toBe(false);
    expect(f.calls.at(-1)?.input["controlGeneration"] ?? 0n).toBe(0n);
  });

  it("checks the exact host mute control generation before dispatch and after a delayed acknowledgement", async () => {
    const mute = deferred<object>();
    const f = fixture({ getRemoteDesktopCapabilities: () => ({ peer: PEER, capabilities: { hostMute: true } }),
      setRemoteDesktopControl: (input) => ({ peer: PEER, state: { controlling: input["enabled"], controlGeneration: input["enabled"] ? 2n : 3n } }),
      setRemoteDesktopHostMute: () => mute.promise });
    await f.request("getRemoteDesktopCapabilities"); await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    expect((await f.request("setRemoteDesktopHostMute", { request: { leaseId: "lease", controlGeneration: 1n, enabled: true } })).ok).toBe(false);
    expect(f.calls.filter((call) => call.name === "setRemoteDesktopHostMute")).toHaveLength(0);
    const pending = f.request("setRemoteDesktopHostMute", { request: { leaseId: "lease", controlGeneration: 2n, enabled: true } });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("setRemoteDesktopHostMute"));
    expect(f.calls.at(-1)?.input).toMatchObject({ peer: PEER, request: { leaseId: "lease", controlGeneration: 2n, enabled: true } });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: false });
    mute.resolve({ peer: PEER, result: { enabled: true } }); expect((await pending).ok).toBe(false);
    expect(f.connection.lease).toMatchObject({ leaseId: "lease", controlling: false, controlGeneration: 3n }); f.connection.retire();
  });

  it("pins the anonymous node before reading a credential and supplies only the selected target route", async () => {
    const f = fixture();
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(true);
    expect(f.factory).toHaveBeenNthCalledWith(1, OWNER.origin);
    expect(f.factory).toHaveBeenNthCalledWith(2, OWNER.origin, "A".repeat(43));
    expect(f.calls.at(-1)?.input["peer"]).toEqual(PEER);
    expect(f.connection.lease?.leaseId).toBe("lease");
    expect((await f.request("getRemoteDesktopCapabilities", { peer: { ...PEER, targetDeviceId: "other" } })).ok).toBe(false);
    const hijacked = fixture({ getServerInfo: () => ({ server: { serverId: "other" } }) });
    expect(await hijacked.request("startRemoteDesktop", { displayId: "display", mode: 1 })).toMatchObject({ ok: false, code: Code.PermissionDenied });
    expect(hijacked.reads).not.toHaveBeenCalled();
  });

  it("stops a start that completes after owner retirement without adopting or exposing its lease", async () => {
    const start = deferred<object>();
    const f = fixture({ startRemoteDesktop: () => start.promise });
    const pending = f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("startRemoteDesktop"));
    f.change({ ...OWNER, connectionGeneration: 2 }); f.connection.retire();
    start.resolve({ peer: PEER, lease: LEASE });
    expect((await pending).ok).toBe(false);
    expect(f.calls.at(-1)).toMatchObject({ name: "stopRemoteDesktop", input: { leaseId: "lease", peer: PEER } });
    expect(f.connection.lease).toBeUndefined();
  });

  it("keeps one pending start latch after rejecting a concurrent start", async () => {
    const start = deferred<object>();
    const f = fixture({ startRemoteDesktop: () => start.promise });
    const pending = f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("startRemoteDesktop"));
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(false);
    expect((await f.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(false);
    expect(f.calls.filter((call) => call.name === "startRemoteDesktop")).toHaveLength(1);
    start.resolve({ peer: PEER, lease: LEASE }); await pending; f.connection.retire();
  });

  it("retires a late positive control result after focus authority changes", async () => {
    const control = deferred<object>();
    const f = fixture({ setRemoteDesktopControl: (input) => input["enabled"] ? control.promise :
      { peer: PEER, state: { controlling: false, controlGeneration: 3n } } });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    let focused = true;
    const pending = f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true }, () => { if (!focused) throw new Error("Focus retired."); });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe("setRemoteDesktopControl"));
    focused = false; control.resolve({ peer: PEER, state: { controlling: true, controlGeneration: 2n } });
    expect((await pending).ok).toBe(false);
    expect(f.calls.at(-1)?.input["enabled"]).toBe(false);
    expect(f.connection.lease?.controlling).toBe(false); f.connection.retire();
  });

  it("rejects a mismatched reply peer and never leaks an error body through IPC", async () => {
    const f = fixture({ getRemoteDesktopCapabilities: () => { throw new ConnectError("private payload", Code.FailedPrecondition,
      undefined, [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.DISABLED }) }]); } });
    const reply = await f.request("getRemoteDesktopCapabilities");
    expect(reply).toEqual({ ok: false, code: Code.FailedPrecondition, reason: RemoteDesktopFailureReason.DISABLED });
    const wrong = fixture({ startRemoteDesktop: () => ({ peer: { ...PEER, routeGeneration: 2n }, lease: LEASE }) });
    expect((await wrong.request("startRemoteDesktop", { displayId: "display", mode: 1 })).ok).toBe(false);
    expect(wrong.calls.at(-1)?.name).toBe("stopRemoteDesktop"); expect(wrong.connection.lease).toBeUndefined();
  });

  it("keeps an unconfirmed stop lease for retry and ignores older control generations", async () => {
    const stop = vi.fn().mockRejectedValueOnce(new ConnectError("Lost response", Code.Unavailable)).mockResolvedValue({ peer: PEER });
    const f = fixture({ stopRemoteDesktop: stop,
      setRemoteDesktopControl: () => ({ peer: PEER, state: { controlling: true, controlGeneration: 3n } }),
      heartbeatRemoteDesktop: () => ({ peer: PEER, state: { controlling: false, controlGeneration: 2n } }) });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    await f.request("setRemoteDesktopControl", { leaseId: "lease", enabled: true });
    await f.request("heartbeatRemoteDesktop", { leaseId: "lease" });
    expect(f.connection.lease?.controlling).toBe(true);
    await expect(f.connection.stop()).rejects.toThrow(); expect(f.connection.lease?.leaseId).toBe("lease");
    await f.connection.stop(); expect(f.connection.lease).toBeUndefined();
  });

  it("carries a full portable Unicode clipboard chunk without applying the media request bound", async () => {
    const f = fixture();
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const data = "字".repeat(65536);
    expect((await f.request("transferRemoteDesktopClipboardContent", { transfer: {
      leaseId: "lease", controlGeneration: 1n, action: { case: "write", value: { transferId: "transfer", offset: 0, data } }
    } })).ok).toBe(true);
    expect(f.calls.at(-1)?.name).toBe("transferRemoteDesktopClipboardContent");
    f.connection.retire();
  });

  it.each(["stopRemoteDesktop", "heartbeatRemoteDesktop"] as const)("cannot retire a replacement lease with an old %s result", async (name) => {
    const old = deferred<object>(); let starts = 0, stops = 0;
    const f = fixture({
      startRemoteDesktop: () => ({ peer: PEER, lease: { ...LEASE, leaseId: `lease-${++starts}` } }),
      stopRemoteDesktop: () => name === "stopRemoteDesktop" && ++stops === 1 ? old.promise : { peer: PEER },
      heartbeatRemoteDesktop: () => old.promise
    });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    const pending = f.request(name, { leaseId: "lease-1" });
    await vi.waitFor(() => expect(f.calls.at(-1)?.name).toBe(name));
    await f.request("stopRemoteDesktop", { leaseId: "lease-1" });
    await f.request("startRemoteDesktop", { displayId: "display", mode: 1 });
    old.resolve({ peer: PEER, state: { controlling: false, controlGeneration: 10n } });
    expect((await pending).ok).toBe(name === "stopRemoteDesktop");
    expect(f.connection.lease).toMatchObject({ leaseId: "lease-2", controlGeneration: 1n });
    f.connection.retire();
  });
});

function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
