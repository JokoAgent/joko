import { create, fromBinary, toBinary, type DescMethodUnary, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { isRemoteDesktopViewerDisplayGeometry } from "@joko/device-peer";
import {
  ConnectionService, RemoteDesktopService, RemoteDesktopFailureSchema, RemoteDesktopFailureReason, DevicePeerRouteIdentitySchema,
  sameDesktopRemoteDesktopViewerOwner, type DesktopRemoteDesktopViewerOwner,
  type DesktopRemoteDesktopViewerReply, type DevicePeerRouteIdentity, type RemoteDesktopLease,
  type RemoteDesktopCapabilities
} from "@joko/contracts";

export class DesktopRemoteDesktopViewerConnection {
  #retired = false;
  #pending = new Set<AbortController>();
  #peer?: DevicePeerRouteIdentity;
  #lease?: RemoteDesktopLease;
  #caps?: RemoteDesktopCapabilities;
  #sourceDisplayId?: string;
  #starting = false;
  #modePending = false;
  #modeUncertain = false;
  #geometryRevision = 0;
  #lastTransport?: Transport;
  constructor(readonly owner: DesktopRemoteDesktopViewerOwner, readonly targetDeviceId: string,
    private readonly deps: {
      readonly current: () => DesktopRemoteDesktopViewerOwner | undefined;
      readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
      readonly transport?: (origin: string, key?: string) => Transport;
    }) {}

  get lease(): RemoteDesktopLease | undefined { return this.#lease; }
  get caps(): RemoteDesktopCapabilities | undefined { return this.#caps; }
  get current(): boolean { return !this.#retired && sameDesktopRemoteDesktopViewerOwner(this.owner, this.deps.current()); }
  check(): void { if (!this.current) throw new ConnectError("Viewer authority retired.", Code.Canceled); }

  async #transport(signal: AbortSignal): Promise<Transport> {
    this.check();
    const factory = this.deps.transport ?? viewerTransport;
    const info = await createClient(ConnectionService, factory(this.owner.origin)).getServerInfo({}, { signal });
    this.check();
    if (info.server?.serverId !== this.owner.serverId) throw new ConnectError("Node identity changed.", Code.PermissionDenied);
    const key = await this.deps.readAuthKey(this.owner.profileId);
    this.check();
    if (key === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new ConnectError("Connection unavailable.", Code.Unauthenticated);
    const transport = factory(this.owner.origin, key);
    this.#lastTransport = transport;
    return transport;
  }

  async request(name: string, bytes: Uint8Array, guard: () => void = () => undefined): Promise<DesktopRemoteDesktopViewerReply> {
    return this.#request(name, bytes, guard);
  }

  async #request(name: string, bytes: Uint8Array, guard: () => void, lockLease?: RemoteDesktopLease,
    syncLease?: RemoteDesktopLease, credentials = false): Promise<DesktopRemoteDesktopViewerReply> {
    const credentialMethod = name === "getRemoteDesktopLockState" || name === "requestRemoteDesktopCredentials";
    const method = RemoteDesktopService.methods.find((item) => item.localName === name);
    if (method === undefined || method.methodKind !== "unary" || name === "listRemoteDesktopHosts" ||
      (credentialMethod && !credentials) || (credentials && !credentialMethod) ||
      !(bytes instanceof Uint8Array) || bytes.byteLength > (credentials ? 2 * 1024 * 1024 + 16 * 1024 : name === "transferRemoteDesktopClipboardContent" ? 256 * 1024 : 100_000)) {
      throw new TypeError("Invalid viewer request.");
    }
    const abort = new AbortController();
    this.#pending.add(abort);
    const starting = name === "startRemoteDesktop";
    const changingMode = name === "setRemoteDesktopDisplayMode";
    const fitting = name === "setRemoteDesktopViewerDisplay";
    const restoring = name === "restoreRemoteDesktopViewerDisplay";
    const changingGeometry = changingMode || fitting || restoring;
    let acquiredStart = false;
    let acquiredMode = false;
    let modeLease: RemoteDesktopLease | undefined;
    let modeCaps: RemoteDesktopCapabilities | undefined;
    const geometryLease = this.#lease;
    const geometryRevision = this.#geometryRevision;
    let requestLeaseId: string | undefined;
    let ordinaryStop = false;
    try {
      this.check();
      guard();
      if (starting && this.#starting) throw new ConnectError("Start already pending.", Code.ResourceExhausted);
      if (starting) { this.#starting = true; acquiredStart = true; }
      const transport = await this.#transport(abort.signal);
      if (this.#peer === undefined || name === "getRemoteDesktopCapabilities") {
        const catalog = await createClient(RemoteDesktopService, transport).listRemoteDesktopHosts({ page: { pageSize: 200 } }, { signal: abort.signal });
        this.check();
        const selected = catalog.hosts.find((host) => host.route?.targetDeviceId === this.targetDeviceId);
        if (selected?.route === undefined) throw new ConnectError("Target access unavailable.", Code.PermissionDenied);
        this.#peer = selected.route;
      }
      const input = fromBinary(method.input, bytes) as Message & { peer?: DevicePeerRouteIdentity; leaseId?: string; lockScreen?: boolean; controlGeneration?: bigint; displayId?: string };
      const mode = changingMode ? input as Message & { leaseId: string; controlGeneration: bigint; temporary: boolean } : undefined;
      const viewer = fitting || restoring ? input as Message & { leaseId: string; controlGeneration: bigint; width?: number; height?: number } : undefined;
      if (mode || viewer) {
        if (this.#modePending) throw new ConnectError("Display mode already pending.", Code.FailedPrecondition, undefined,
          [{ desc: RemoteDesktopFailureSchema, value: { reason: RemoteDesktopFailureReason.DISPLAY_BUSY } }]);
        if (this.#modeUncertain || !this.#lease?.controlling || input.leaseId !== this.#lease.leaseId ||
          input.controlGeneration !== this.#lease.controlGeneration ||
          (mode && (!this.#caps?.displayModes || mode.temporary && !this.#caps.resolutionRestore)) ||
          (viewer && (!this.#caps?.viewerDisplay || !this.#caps.viewerDisplayRestore
            || (this.#caps.platform !== "linux" && this.#caps.platform !== "darwin"))) ||
          (fitting && ![viewer?.width, viewer?.height].every(size => Number.isSafeInteger(size) && size! >= 320 && size! <= 2560))) {
          throw new ConnectError("Display geometry authority retired.", Code.FailedPrecondition);
        }
        modeLease = this.#lease; modeCaps = this.#caps; this.#modePending = true; acquiredMode = true;
        ++this.#geometryRevision;
      }
      const checkGeometry = (): void => {
        if (!geometryLease || changingGeometry || name === "stopRemoteDesktop" || input.leaseId === undefined) return;
        // A screenshot remains valid through a control-only transition. Capture
        // changes still fence it, including a change that settled while awaiting it.
        const changed = name === "getRemoteDesktopFrame"
          ? this.#geometryRevision !== geometryRevision
          : this.#lease?.controlGeneration !== geometryLease.controlGeneration;
        if (this.#modePending || this.#modeUncertain || this.#lease?.leaseId !== geometryLease.leaseId || changed) {
          throw new ConnectError("Display geometry occurrence retired.", Code.Canceled);
        }
      };
      const sync = name === "setRemoteDesktopClipboardSync" || name === "getRemoteDesktopClipboardVersion"
        ? (input as Message & { request?: { leaseId: string; controlGeneration: bigint; enabled?: boolean; syncGeneration?: bigint } }).request
        : name === "transferRemoteDesktopClipboardContent" ? (input as Message & {
          transfer?: { leaseId: string; controlGeneration: bigint; sync: boolean; syncGeneration: bigint }
        }).transfer : undefined;
      const syncRequest = name === "setRemoteDesktopClipboardSync" || name === "getRemoteDesktopClipboardVersion" ||
        (sync !== undefined && "sync" in sync && sync.sync);
      const checkSync = (): void => {
        if (!syncRequest) return;
        if (!syncLease || !sync || !this.#caps?.clipboardSync || this.#lease?.leaseId !== syncLease.leaseId ||
          this.#lease.controlGeneration !== syncLease.controlGeneration || sync.leaseId !== syncLease.leaseId ||
          sync.controlGeneration !== syncLease.controlGeneration || (name !== "setRemoteDesktopClipboardSync" && !this.#lease.controlling) ||
          (name === "setRemoteDesktopClipboardSync" && "enabled" in sync && sync.enabled && !this.#lease.controlling)) {
          throw new ConnectError("Clipboard sync belongs to the native viewer owner.", Code.FailedPrecondition);
        }
      };
      ordinaryStop = name === "stopRemoteDesktop" && !input.lockScreen;
      const mute = name === "setRemoteDesktopHostMute" ? (input as Message & {
        request?: { leaseId: string; controlGeneration: bigint; enabled: boolean }
      }).request : undefined;
      const privacy = name === "setRemoteDesktopPrivacyScreen" ? (input as Message & {
        request?: { leaseId: string; controlGeneration: bigint; enabled: boolean; lockOnExit: boolean }
      }).request : undefined;
      requestLeaseId = input.leaseId ?? (input as Message & { transfer?: { leaseId: string } }).transfer?.leaseId ?? mute?.leaseId ?? privacy?.leaseId ?? sync?.leaseId;
      const checkMute = (): void => {
        if (name !== "setRemoteDesktopHostMute") return;
        if (mute === undefined || this.#caps?.hostMute !== true || !this.#lease?.controlling ||
          mute.leaseId !== this.#lease.leaseId || mute.controlGeneration !== this.#lease.controlGeneration) {
          throw new ConnectError("Host mute control authority retired.", Code.FailedPrecondition);
        }
      };
      const checkPrivacy = (): void => {
        if (name !== "setRemoteDesktopPrivacyScreen") return;
        if (privacy === undefined || this.#caps?.privacyScreen !== true || !this.#lease?.controlling ||
          privacy.leaseId !== this.#lease.leaseId || privacy.controlGeneration !== this.#lease.controlGeneration) {
          throw new ConnectError("Privacy screen control authority retired.", Code.FailedPrecondition);
        }
      };
      const lockPeer = this.#peer;
      const checkLock = (): void => {
        if (name !== "stopRemoteDesktop" || !input.lockScreen) return;
        if (lockLease === undefined || this.#caps?.lockOnExit !== true || this.#lease?.leaseId !== lockLease.leaseId ||
          this.#lease.controlGeneration !== lockLease.controlGeneration || input.leaseId !== lockLease.leaseId ||
          input.controlGeneration !== lockLease.controlGeneration || lockPeer === undefined || this.#peer === undefined ||
          !sameRoute(lockPeer, this.#peer)) throw new ConnectError("Lock on exit authority retired.", Code.FailedPrecondition);
      };
      // The standalone document cannot select another target or route.
      if (input.peer !== undefined) throw new TypeError("Viewer requests cannot select a peer.");
      input.peer = this.#peer;
      if (requestLeaseId !== undefined && requestLeaseId !== this.#lease?.leaseId) {
        throw new ConnectError("Viewer lease retired.", Code.FailedPrecondition);
      }
      if (starting && this.#lease !== undefined) throw new ConnectError("Viewer already owns a lease.", Code.ResourceExhausted);
      this.check(); guard(); checkMute(); checkPrivacy(); checkLock(); checkSync(); checkGeometry();
      const response = await transport.unary(method as DescMethodUnary, abort.signal, 30_000, undefined, input);
      const output = response.message as Message & { peer?: DevicePeerRouteIdentity; lease?: RemoteDesktopLease; capabilities?: RemoteDesktopCapabilities;
        state?: { controlling: boolean; controlGeneration: bigint }; result?: { lease?: RemoteDesktopLease } };
      if (!this.current) {
        // Start may have reached the host before cancellation. Retire only its returned lease.
        if (output.lease !== undefined) await createClient(RemoteDesktopService, transport)
          .stopRemoteDesktop({ peer: this.#peer, leaseId: output.lease.leaseId }, { timeoutMs: 2_000 }).catch(() => undefined);
        this.check();
      }
      if (output.peer === undefined || !sameRoute(this.#peer!, output.peer)) {
        if (output.lease !== undefined) await createClient(RemoteDesktopService, transport)
          .stopRemoteDesktop({ peer: this.#peer, leaseId: output.lease.leaseId }, { timeoutMs: 2000 }).catch(() => undefined);
        throw new ConnectError("Peer response authority changed.", Code.PermissionDenied);
      }
      try { guard(); } catch (error) {
        if (name === "setRemoteDesktopControl" && requestLeaseId !== undefined && output.state?.controlling &&
          !this.#modePending && !this.#modeUncertain && (!this.#lease || this.#lease.controlGeneration === geometryLease?.controlGeneration)) {
          await createClient(RemoteDesktopService, transport).setRemoteDesktopControl({ peer: this.#peer,
            leaseId: requestLeaseId, enabled: false }, { timeoutMs: 2000 }).catch(() => undefined);
        }
        if (output.lease !== undefined) await createClient(RemoteDesktopService, transport)
          .stopRemoteDesktop({ peer: this.#peer, leaseId: output.lease.leaseId }, { timeoutMs: 2000 }).catch(() => undefined);
        throw error;
      }
      checkMute();
      checkPrivacy();
      checkLock();
      checkSync();
      checkGeometry();
      if (mode || viewer) {
        if (!modeLease || this.#lease?.leaseId !== modeLease.leaseId || this.#lease.controlGeneration !== modeLease.controlGeneration || !output.result) {
          throw new ConnectError("Display mode receipt is unavailable.", Code.Unknown);
        }
        const next = output.result.lease;
        if (viewer || mode?.temporary) {
          if (!next || next.leaseId !== modeLease.leaseId || next.controlling || next.controlGeneration <= modeLease.controlGeneration ||
            !next.display || !next.display.displayId ||
            (mode && next.display.displayId !== modeLease.display?.displayId && next.display.displayId !== this.#sourceDisplayId) ||
            (restoring && next.display.displayId !== this.#sourceDisplayId) ||
            (fitting && (next.display.displayId === this.#sourceDisplayId ||
              modeCaps?.displays.some(display => display.displayId === next.display!.displayId) ||
              !isRemoteDesktopViewerDisplayGeometry(modeCaps!.platform, viewer!.width!, viewer!.height!, next.display.width, next.display.height) ||
              modeLease.display?.displayId !== this.#sourceDisplayId && next.display.displayId !== modeLease.display?.displayId)) ||
            ![next.display.width, next.display.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 32_768)) {
            throw new ConnectError("Display mode receipt changed its captured authority.", Code.Unknown);
          }
          this.#lease = next;
        } else {
          if (next !== undefined) throw new ConnectError("Permanent display mode returned an unexpected lease.", Code.Unknown);
          this.#lease = undefined;
        }
        this.#modeUncertain = false;
      }
      if (starting && output.lease !== undefined) { this.#lease = output.lease; this.#sourceDisplayId = input.displayId || output.lease.display?.displayId; }
      if (output.capabilities !== undefined) this.#caps = output.capabilities;
      if (output.state !== undefined && this.#lease !== undefined && this.#lease.leaseId === requestLeaseId && output.state.controlGeneration >= this.#lease.controlGeneration) {
        this.#lease = { ...this.#lease, controlling: output.state.controlling, controlGeneration: output.state.controlGeneration };
      }
      if (name === "stopRemoteDesktop" && this.#lease?.leaseId === requestLeaseId) { this.#lease = undefined; this.#modeUncertain = false; }
      return { ok: true, bytes: toBinary(method.output, response.message) };
    } catch (error: unknown) {
      const failure = ConnectError.from(error);
      const reason = failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason;
      if (acquiredMode && ![RemoteDesktopFailureReason.DISPLAY_MODES_UNAVAILABLE, RemoteDesktopFailureReason.DISPLAY_MODE_MISSING,
        RemoteDesktopFailureReason.DISPLAY_BUSY, RemoteDesktopFailureReason.VIEW_ONLY].includes(reason ?? RemoteDesktopFailureReason.UNSPECIFIED)) {
        this.#modeUncertain = true;
        if (this.#lease?.leaseId === modeLease?.leaseId) this.#lease = { ...this.#lease!, controlling: false };
      }
      if (((reason === RemoteDesktopFailureReason.LEASE_EXPIRED && !this.#modeUncertain && (ordinaryStop || !acquiredMode && !this.#modePending &&
        this.#lease?.controlGeneration === geometryLease?.controlGeneration)) || (ordinaryStop && failure.code === Code.FailedPrecondition && reason === RemoteDesktopFailureReason.STOPPED)) &&
        this.#lease?.leaseId === requestLeaseId) { this.#lease = undefined; this.#modeUncertain = false; }
      return { ok: false, code: failure.code,
        reason: failure.findDetails(RemoteDesktopFailureSchema)[0]?.reason ?? RemoteDesktopFailureReason.UNSPECIFIED };
    } finally {
      if (acquiredStart) this.#starting = false;
      if (acquiredMode) this.#modePending = false;
      this.#pending.delete(abort);
    }
  }

  async call<N extends keyof typeof RemoteDesktopService.method>(name: N,
    input: Record<string, unknown>
  ): Promise<Message> {
    const method = RemoteDesktopService.method[name];
    const reply = await this.request(name, toBinary(method.input, create(method.input, input)));
    if (!reply.ok) throw new ConnectError("Remote Desktop request failed.", reply.code);
    return fromBinary(method.output, reply.bytes);
  }

  async credentialRequest(name: "getRemoteDesktopLockState" | "requestRemoteDesktopCredentials",
    input: Record<string, unknown>, guard: () => void): Promise<Message> {
    const method = RemoteDesktopService.method[name];
    const reply = await this.#request(name, toBinary(method.input, create(method.input, input)), guard, undefined, undefined, true);
    if (!reply.ok) throw new ConnectError("Native credential request failed.", reply.code, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: { reason: reply.reason } }]);
    return fromBinary(method.output, reply.bytes);
  }

  async syncRequest(name: "setRemoteDesktopClipboardSync" | "getRemoteDesktopClipboardVersion" | "transferRemoteDesktopClipboardContent",
    input: Record<string, unknown>, lease: RemoteDesktopLease, guard: () => void): Promise<DesktopRemoteDesktopViewerReply> {
    const method = RemoteDesktopService.method[name];
    return this.#request(name, toBinary(method.input, create(method.input, input)), guard, undefined, lease);
  }

  async stop(lockScreen = false, guard: () => void = () => undefined): Promise<void> {
    const lease = this.#lease;
    if (lease === undefined) return;
    const method = RemoteDesktopService.method.stopRemoteDesktop;
    const reply = await this.#request(method.localName, toBinary(method.input, create(method.input, {
      leaseId: lease.leaseId, lockScreen, controlGeneration: lockScreen ? lease.controlGeneration : 0n
    })), guard, lockScreen ? lease : undefined);
    if (!reply.ok) throw new ConnectError("Remote Desktop exit could not be confirmed.", reply.code);
  }

  retire(): void {
    const lease = this.#lease, peer = this.#peer, transport = this.#lastTransport;
    // Cleanup retains only the exact old lease; it cannot start, control or adopt another route.
    if (lease !== undefined && peer !== undefined && transport !== undefined) void createClient(RemoteDesktopService, transport)
      .stopRemoteDesktop({ peer, leaseId: lease.leaseId }, { timeoutMs: 2000 }).catch(() => undefined);
    this.#retired = true;
    for (const pending of this.#pending) pending.abort();
    this.#pending.clear();
    this.#lease = undefined;
    this.#caps = undefined;
    this.#lastTransport = undefined;
  }
}

function viewerTransport(origin: string, key?: string): Transport {
  return createConnectTransport({ baseUrl: origin, httpVersion: "1.1", useBinaryFormat: true, defaultTimeoutMs: 30_000,
    interceptors: key === undefined ? [] : [(next) => (request) => {
      request.header.set("authorization", `Bearer ${key}`);
      return next(request);
    }] });
}

function sameRoute(left: DevicePeerRouteIdentity, right: DevicePeerRouteIdentity): boolean {
  const a = toBinary(DevicePeerRouteIdentitySchema, left), b = toBinary(DevicePeerRouteIdentitySchema, right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
