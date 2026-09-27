import type { Duplex, Readable, Writable } from "node:stream";

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
}
