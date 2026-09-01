import type { RemoteSshErrorShape } from "./errors.js";

export const REMOTE_SSH_TEST_TIMEOUT_MS = 20_000;
export const REMOTE_SSH_EXECUTION_TIMEOUT_MS = 60_000;
export const REMOTE_SSH_MAXIMUM_EXECUTION_TIMEOUT_MS = 600_000;
export const REMOTE_SSH_MAXIMUM_OUTPUT_BYTES = 512 * 1_024;
export const REMOTE_SSH_MAXIMUM_INPUT_BYTES = 1_024 * 1_024;
export const REMOTE_SSH_MAXIMUM_COMMAND_BYTES = 256 * 1_024;

export interface RemoteSshOwnerScope {
  readonly ownerId: string;
  readonly targetId: string;
}

export interface RemoteSshCredentialRef {
  readonly id: string;
}

export type RemoteSshHostSource = "manual" | "ssh_config";

export interface RemoteSshConfigHost extends RemoteSshOwnerScope {
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly source: RemoteSshHostSource;
}

export interface RemoteSshHostInput extends RemoteSshOwnerScope {
  readonly id: string;
  readonly hostname: string;
  readonly port?: number;
  readonly user: string;
  /** Opaque runtime reference for secret-backed auth; absent for system-agent auth. */
  readonly credentialRef?: RemoteSshCredentialRef;
}

export interface RemoteSshHost extends RemoteSshOwnerScope {
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly credentialRef?: RemoteSshCredentialRef;
  readonly source: "manual";
}

export type RemoteSshStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "ready"
  | "failed";

export interface RemoteSshSnapshot {
  readonly host: Omit<RemoteSshHost, "credentialRef">;
  readonly status: RemoteSshStatus;
  readonly statusChangedAt: number;
  readonly error?: RemoteSshErrorShape;
}

export interface RemoteSshLogger {
  readonly debug?: (message: string, fields?: Readonly<Record<string, boolean | number | string>>) => void;
  readonly info?: (message: string, fields?: Readonly<Record<string, boolean | number | string>>) => void;
  readonly warn?: (message: string, fields?: Readonly<Record<string, boolean | number | string>>) => void;
}

export interface PresentedSshHostKey {
  readonly algorithm: string;
  readonly key: Uint8Array;
}

export interface SshHostKeyVerificationRequest extends PresentedSshHostKey {
  readonly hostname: string;
  readonly port: number;
}

export interface SshHostKeyVerification {
  readonly fingerprint: string;
  readonly disposition: "matched" | "pinned";
}

export interface SshHostKeyVerifierPort {
  verify(request: SshHostKeyVerificationRequest): Promise<SshHostKeyVerification>;
}

export interface SshHostKeyPinRequest {
  readonly id: string;
  readonly fingerprint: string;
}

export interface SshHostKeyPinStorePort {
  compareAndPin(request: SshHostKeyPinRequest): Promise<"matched" | "pinned">;
}

export interface AgentAuthConnectorRequest {
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly credentialRef?: RemoteSshCredentialRef;
  readonly signal: AbortSignal;
  readonly verifyHostKey: (key: PresentedSshHostKey) => Promise<void>;
  readonly onAuthenticating: () => void;
}

export interface AgentAuthConnection {
  /** Stable capabilities of this authenticated connection. */
  readonly capabilities?: RemoteSshTransportCapabilities;
  close(): Promise<void>;
  /** Optional transport capability. Inputs and connector failures must never be logged. */
  execute?(request: AgentAuthExecutionRequest): Promise<AgentAuthExecutionResult>;
  /** Optional long-lived remote process capability. */
  readonly processes?: RemoteProcessTransportPort;
  /** Optional remote filesystem capability. */
  readonly files?: RemoteFileTransportPort;
  /** Optional local-to-remote TCP stream capability. */
  readonly forwarding?: RemoteForwardingTransportPort;
}

export interface RemoteSshTransportCapabilities {
  readonly commandExecution: boolean;
  readonly processStreaming: boolean;
  readonly fileTransfer: boolean;
  readonly tcpForwarding: boolean;
}

/** Non-owning view of transports on the controller's authenticated connection. */
export interface RemoteSshTransportLease {
  readonly capabilities: RemoteSshTransportCapabilities;
  readonly processes?: RemoteProcessTransportPort;
  readonly files?: RemoteFileTransportPort;
  readonly forwarding?: RemoteForwardingTransportPort;
}

export type ResolvedSshAuthentication =
  | {
      readonly kind: "system_agent";
      /** Service-owned override. Requests and public contracts never select this path. */
      readonly endpoint?: string;
    }
  | {
      readonly kind: "private_key";
      /** Ephemeral bytes. Implementations must copy synchronously and release them after authentication. */
      readonly privateKey: Uint8Array;
      readonly passphrase?: Uint8Array;
    };

export interface ResolvedAgentAuthConnectorRequest extends Omit<AgentAuthConnectorRequest, "credentialRef"> {
  readonly authentication: ResolvedSshAuthentication;
}

export interface ResolvedAgentAuthConnectorPort {
  readonly capabilities: RemoteSshTransportCapabilities;
  connect(request: ResolvedAgentAuthConnectorRequest): Promise<AgentAuthConnection>;
}

export interface AgentAuthExecutionRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs: number;
  /** Per stdout/stderr stream, enforced while reading by the connector. */
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface AgentAuthExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: string;
  /** True when either stream hit maxOutputBytes and the remote command was stopped. */
  readonly outputCapped: boolean;
}

export interface RemoteProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface RemoteProcessHandle {
  readonly stdin: import("node:stream").Writable;
  readonly stdout: import("node:stream").Readable;
  readonly stderr: import("node:stream").Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface RemoteProcessTransportPort {
  open(request: RemoteProcessStartRequest): Promise<RemoteProcessHandle>;
}

export type RemoteFileKind = "file" | "directory" | "symbolic_link" | "other";

export interface RemoteFileStat {
  readonly kind: RemoteFileKind;
  readonly size: number;
  readonly modifiedAt: number;
  readonly mode: number;
}

export interface RemoteDirectoryEntry {
  readonly name: string;
  readonly kind: RemoteFileKind;
}

export interface RemoteFileReadRequest {
  readonly path: string;
  readonly maximumBytes: number;
  /** Return a bounded prefix when the file is larger instead of failing closed. */
  readonly allowTruncated?: boolean;
  readonly signal?: AbortSignal;
}

export interface RemoteFileWriteRequest {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode?: number;
  readonly createParents?: boolean;
  readonly atomic?: boolean;
  readonly signal?: AbortSignal;
}

export interface RemoteFileTransportPort {
  realpath(path: string, signal?: AbortSignal): Promise<string>;
  stat(path: string, signal?: AbortSignal): Promise<RemoteFileStat>;
  list(path: string, signal?: AbortSignal): Promise<readonly RemoteDirectoryEntry[]>;
  read(request: RemoteFileReadRequest): Promise<Uint8Array>;
  write(request: RemoteFileWriteRequest): Promise<void>;
  mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number; readonly signal?: AbortSignal }): Promise<void>;
  rename(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void>;
  remove(path: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
}

export interface RemoteForwardRequest {
  /** Destination is deliberately restricted to the remote loopback interface. */
  readonly destinationHost: "127.0.0.1" | "::1" | "localhost";
  readonly destinationPort: number;
  readonly signal?: AbortSignal;
}

export interface RemoteForwardingTransportPort {
  open(request: RemoteForwardRequest): Promise<import("node:stream").Duplex>;
  /** Exposes a service-node loopback listener on remote loopback only. */
  listen(request: RemoteReverseForwardRequest): Promise<RemoteReverseForwardHandle>;
}

export interface RemoteReverseForwardRequest {
  readonly localDestinationHost: "127.0.0.1" | "::1" | "localhost";
  readonly localDestinationPort: number;
  readonly remoteListenHost?: "127.0.0.1" | "::1" | "localhost";
  readonly signal?: AbortSignal;
}

export interface RemoteReverseForwardHandle {
  readonly remoteHost: "127.0.0.1" | "::1" | "localhost";
  readonly remotePort: number;
  close(): Promise<void>;
}

export interface RemoteSshExecutionOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type RemoteSshExecutionResult = AgentAuthExecutionResult;

export interface AgentAuthConnectorPort {
  connect(request: AgentAuthConnectorRequest): Promise<AgentAuthConnection>;
}

export type AgentAuthConnectorFailureCode =
  | "AUTHENTICATION_FAILED"
  | "CONNECTION_FAILED"
  | "CONNECTOR_UNAVAILABLE";

export class AgentAuthConnectorFailure extends Error {
  readonly retryable: boolean;

  constructor(readonly code: AgentAuthConnectorFailureCode) {
    super("The SSH connector reported a safe failure.");
    this.name = "AgentAuthConnectorFailure";
    this.retryable = code !== "AUTHENTICATION_FAILED";
  }
}

export interface RemoteSshTestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RemoteSshTestSuccess {
  readonly ok: true;
  readonly snapshot: RemoteSshSnapshot;
}

export interface RemoteSshTestFailure {
  readonly ok: false;
  readonly snapshot: RemoteSshSnapshot;
  readonly error: RemoteSshErrorShape;
}

export type RemoteSshTestResult = RemoteSshTestSuccess | RemoteSshTestFailure;
