import type { Duplex, Readable, Writable } from "node:stream";

import {
  RemoteDesktopFailureReason,
  type RemoteDesktopClipboardContent,
  type RemoteDesktopCapabilities,
  type RemoteDesktopControlState,
  type RemoteDesktopFrameResult,
  type RemoteDesktopIceCandidate,
  type RemoteDesktopIceExchangeResult,
  type RemoteDesktopInputEvent,
  type RemoteDesktopLease,
  type RemoteDesktopOfferResult,
  type RemoteDesktopPermissions,
  type RemoteDesktopPresentationProof,
  type RemoteDesktopStartMode,
  type RemoteDesktopVideoSettings
} from "@joko/contracts";

export type DevicePeerFileKind = "file" | "directory" | "symbolic_link" | "other";

export interface DevicePeerFileStat {
  readonly kind: DevicePeerFileKind;
  readonly size: number;
  readonly modifiedAt: number;
  readonly mode: number;
}

export interface DevicePeerDirectoryEntry {
  readonly name: string;
  readonly kind: DevicePeerFileKind;
}

export interface DevicePeerFileReadRequest {
  readonly path: string;
  readonly maximumBytes: number;
  /** Return a bounded prefix when the file is larger instead of failing closed. */
  readonly allowTruncated?: boolean;
  readonly signal?: AbortSignal;
}

export interface DevicePeerFileWriteRequest {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode?: number;
  readonly createParents?: boolean;
  readonly atomic?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Capability-neutral filesystem boundary. Its shape deliberately matches the
 * existing remote filesystem port without importing an SSH Host identity.
 */
export interface DevicePeerFileTransportPort {
  realpath(path: string, signal?: AbortSignal): Promise<string>;
  stat(path: string, signal?: AbortSignal): Promise<DevicePeerFileStat>;
  list(path: string, signal?: AbortSignal): Promise<readonly DevicePeerDirectoryEntry[]>;
  read(request: DevicePeerFileReadRequest): Promise<Uint8Array>;
  write(request: DevicePeerFileWriteRequest): Promise<void>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number; readonly signal?: AbortSignal }
  ): Promise<void>;
  rename(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void>;
  remove(path: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
}

export interface DevicePeerProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * A spawned process remains an ephemeral route-owned stream. No process input,
 * output, environment, or handle is a durable product authority.
 */
export interface DevicePeerProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

/** Capability-neutral process boundary, structurally compatible with remote execution ports. */
export interface DevicePeerProcessTransportPort {
  open(request: DevicePeerProcessStartRequest): Promise<DevicePeerProcessHandle>;
}

/** No environment overrides: the target device account owns the terminal environment. */
export interface DevicePeerTerminalStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** Cancels creation only; detached when the handle is delivered. */
  readonly signal?: AbortSignal;
}

export interface DevicePeerTerminalExit {
  readonly exitCode: number;
  readonly signal?: number;
  readonly failureCode?: string;
  readonly processExitConfirmed?: boolean;
}

export interface DevicePeerTerminalHandle {
  readonly pid?: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: DevicePeerTerminalExit) => void): { dispose(): void };
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  pause(): void;
  resume(): void;
}

export interface DevicePeerTerminalTransportPort {
  open(request: DevicePeerTerminalStartRequest): Promise<DevicePeerTerminalHandle>;
}

export interface DevicePeerRemoteDesktopHostRequest {
  /** Authenticated controller Device injected by the service route owner. */
  readonly controllerDeviceId: string;
  readonly signal: AbortSignal;
}

export interface DevicePeerRemoteDesktopLeaseRequest extends DevicePeerRemoteDesktopHostRequest {
  readonly leaseId: string;
}

/**
 * Target-host Remote Desktop boundary. Implementations live only in a trusted
 * Desktop Main process; screen, signaling, input, and lease values remain
 * transient and must never be persisted or exposed to a renderer bridge.
 */
export interface DevicePeerRemoteDesktopHostPort {
  getCapabilities(request: DevicePeerRemoteDesktopHostRequest): Promise<RemoteDesktopCapabilities>;
  getPermissions(request: DevicePeerRemoteDesktopHostRequest): Promise<RemoteDesktopPermissions>;
  showPermissionGuide(request: DevicePeerRemoteDesktopHostRequest): Promise<void>;
  start(request: DevicePeerRemoteDesktopHostRequest & {
    readonly displayId: string;
    readonly mode: RemoteDesktopStartMode;
  }): Promise<RemoteDesktopLease>;
  heartbeat(request: DevicePeerRemoteDesktopLeaseRequest): Promise<RemoteDesktopControlState>;
  stop(request: DevicePeerRemoteDesktopLeaseRequest): Promise<void>;
  setControl(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly enabled: boolean;
  }): Promise<RemoteDesktopControlState>;
  setPresentation(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly enabled: boolean;
  }): Promise<RemoteDesktopControlState>;
  /** Read-only current proof; this call must never itself renew the lease. */
  probePresentation(request: DevicePeerRemoteDesktopLeaseRequest): Promise<RemoteDesktopPresentationProof>;
  sendInput(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly sequence: bigint;
    readonly events: readonly RemoteDesktopInputEvent[];
  }): Promise<void>;
  createOffer(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly attemptId: string;
    readonly offerSdp: string;
    readonly settings?: RemoteDesktopVideoSettings;
  }): Promise<RemoteDesktopOfferResult>;
  exchangeIce(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly attemptId: string;
    readonly candidates: readonly RemoteDesktopIceCandidate[];
    readonly after: number;
  }): Promise<RemoteDesktopIceExchangeResult>;
  getFrame(request: DevicePeerRemoteDesktopLeaseRequest): Promise<RemoteDesktopFrameResult>;
  /**
   * Synchronous target-side fence for control-scoped effects. This must read
   * the host's current authority directly and must not perform the effect.
   */
  isControlCurrent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }): boolean;
  copyClipboardText(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }): Promise<string>;
  pasteClipboardText(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly text: string;
  }): Promise<void>;
  copyClipboardContent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
  }): Promise<RemoteDesktopClipboardContent>;
  pasteClipboardContent(request: DevicePeerRemoteDesktopLeaseRequest & {
    readonly controlGeneration: bigint;
    readonly content: RemoteDesktopClipboardContent;
  }): Promise<void>;
  /** Route retirement is a hard media/input ownership boundary. */
  retire(): Promise<void>;
}

/** A definitive, typed host-domain rejection; transport failures stay generic. */
export class DevicePeerRemoteDesktopHostError extends Error {
  constructor(
    readonly reason: RemoteDesktopFailureReason,
    readonly retryable: boolean
  ) {
    super("Remote Desktop host request failed.");
    this.name = "DevicePeerRemoteDesktopHostError";
  }
}

export type DevicePeerLoopbackHost = "127.0.0.1" | "::1" | "localhost";

export interface DevicePeerForwardRequest {
  /** Destination is deliberately restricted to target-device loopback. */
  readonly destinationHost: DevicePeerLoopbackHost;
  readonly destinationPort: number;
  readonly signal?: AbortSignal;
}

export interface DevicePeerReverseForwardRequest {
  /** Service destination is deliberately restricted to controller loopback. */
  readonly localDestinationHost: DevicePeerLoopbackHost;
  readonly localDestinationPort: number;
  readonly remoteListenHost?: DevicePeerLoopbackHost;
  readonly signal?: AbortSignal;
}

export interface DevicePeerReverseForwardHandle {
  readonly remoteHost: DevicePeerLoopbackHost;
  readonly remotePort: number;
  close(): Promise<void>;
}

export interface DevicePeerForwardingTransportPort {
  open(request: DevicePeerForwardRequest): Promise<Duplex>;
  /** Exposes a controller listener on target-device loopback only. */
  listen(request: DevicePeerReverseForwardRequest): Promise<DevicePeerReverseForwardHandle>;
}

export interface DevicePeerCapabilityPorts {
  readonly files?: DevicePeerFileTransportPort;
  readonly processes?: DevicePeerProcessTransportPort;
  readonly terminals?: DevicePeerTerminalTransportPort;
  readonly forwarding?: DevicePeerForwardingTransportPort;
  readonly remoteDesktop?: DevicePeerRemoteDesktopHostPort;
}
