import type { RemoteWorkspaceBinding } from "@joko/core";
import type {
  RemoteFileTransportPort,
  RemoteForwardingTransportPort,
  RemoteProcessTransportPort,
  RemoteTerminalTransportPort
} from "@joko/remote-ssh";

import { createDevicePeerCapabilityPorts } from "./device-peer-capability-ports.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

export class RemoteExecutionUnavailableError extends Error {
  constructor(readonly capability: "files" | "process" | "terminal" | "forwarding") {
    super(`The remote ${capability} capability is unavailable.`);
    this.name = "RemoteExecutionUnavailableError";
  }
}

export interface RemoteFileAuthority {
  readonly kind: RemoteWorkspaceBinding["kind"];
  readonly binding: RemoteWorkspaceBinding;
  /** Stable machine/account identity used to isolate runtime-owned state. */
  readonly executionIdentity: string;
  /** Ephemeral transport/relation snapshot; changes on reconnect or reauthorization. */
  readonly authorityIdentity: string;
  readonly pathStyle: "posix" | "win32";
  readonly files: RemoteFileTransportPort;
  assertCurrent(): void;
}

export interface RemoteProcessAuthority {
  readonly kind: RemoteWorkspaceBinding["kind"];
  readonly binding: RemoteWorkspaceBinding;
  readonly executionIdentity: string;
  readonly authorityIdentity: string;
  readonly pathStyle: "posix" | "win32";
  readonly processes: RemoteProcessTransportPort;
  readonly forwarding?: RemoteForwardingTransportPort;
  assertCurrent(): void;
  assertForwardingCurrent(): void;
}

export interface RemoteTerminalAuthority {
  readonly kind: RemoteWorkspaceBinding["kind"];
  readonly binding: RemoteWorkspaceBinding;
  readonly executionIdentity: string;
  readonly authorityIdentity: string;
  readonly pathStyle: "posix" | "win32";
  readonly files: RemoteFileTransportPort;
  readonly processes: RemoteProcessTransportPort;
  readonly terminals: RemoteTerminalTransportPort;
  assertCurrent(): void;
}

export interface RemoteWorkspaceAuthority {
  readonly kind: RemoteWorkspaceBinding["kind"];
  readonly binding: RemoteWorkspaceBinding;
  readonly executionIdentity: string;
  readonly authorityIdentity: string;
  readonly pathStyle: "posix" | "win32";
  readonly files: RemoteFileTransportPort;
  readonly processes: RemoteProcessTransportPort;
  readonly forwarding?: RemoteForwardingTransportPort;
  assertCurrent(): void;
  assertForwardingCurrent(): void;
}

/**
 * The only location switch for remote execution. Business owners provide the
 * immutable Target/Session binding; this router returns one ephemeral exact
 * SSH lease or controller->Device route without exposing backend identifiers
 * to shared UI/Core code.
 */
export class RemoteExecutionRouter {
  constructor(private readonly dependencies: {
    readonly hosts: Pick<RemoteHostRegistry, "captureProcessAuthority" | "captureTransportAuthority">;
    readonly peers: DevicePeerOwner;
  }) {}

  async files(binding: RemoteWorkspaceBinding, signal?: AbortSignal): Promise<RemoteFileAuthority> {
    if (binding.kind === "ssh") {
      const captured = await this.dependencies.hosts.captureTransportAuthority(
        binding.hostTargetId,
        binding.hostId,
        signal
      );
      if (!captured.lease.capabilities.fileTransfer || captured.lease.files === undefined) {
        throw new RemoteExecutionUnavailableError("files");
      }
      return Object.freeze({
        kind: "ssh" as const,
        binding,
        executionIdentity: stableBindingIdentity(binding),
        authorityIdentity: sshAuthorityIdentity(captured.hostRevision, captured.leaseGeneration),
        pathStyle: "posix" as const,
        files: captured.lease.files,
        assertCurrent: captured.assertCurrent
      });
    }
    const authority = this.dependencies.peers.captureBinding(
      binding.controllerDeviceId,
      binding.targetDeviceId,
      ["files"]
    );
    const files = createDevicePeerCapabilityPorts({ owner: this.dependencies.peers, authority }).files;
    if (files === undefined) throw new RemoteExecutionUnavailableError("files");
    return Object.freeze({
      kind: "device_peer" as const,
      binding,
      executionIdentity: stableBindingIdentity(binding),
      authorityIdentity: peerAuthorityIdentity(authority),
      pathStyle: pathStyle(binding),
      files,
      assertCurrent: () => authority.assertCurrent(["files"])
    });
  }

  async workspace(binding: RemoteWorkspaceBinding, signal?: AbortSignal): Promise<RemoteWorkspaceAuthority> {
    if (binding.kind === "ssh") {
      const captured = await this.dependencies.hosts.captureProcessAuthority(
        binding.hostTargetId,
        binding.hostId,
        signal
      );
      if (!captured.lease.capabilities.fileTransfer || captured.lease.files === undefined
        || !captured.lease.capabilities.processStreaming || captured.lease.processes === undefined) {
        throw new RemoteExecutionUnavailableError("files");
      }
      return Object.freeze({
        kind: "ssh" as const,
        binding,
        executionIdentity: sshExecutionIdentity(binding, captured.host),
        authorityIdentity: sshAuthorityIdentity(captured.hostRevision, captured.leaseGeneration),
        pathStyle: "posix" as const,
        files: captured.lease.files,
        processes: captured.lease.processes,
        ...(captured.lease.capabilities.tcpForwarding && captured.lease.forwarding !== undefined
          ? { forwarding: captured.lease.forwarding }
          : {}),
        assertCurrent: captured.assertCurrent,
        assertForwardingCurrent: captured.assertForwardingCurrent
      });
    }
    const authority = this.dependencies.peers.captureBinding(
      binding.controllerDeviceId,
      binding.targetDeviceId,
      ["files", "process"]
    );
    const ports = createDevicePeerCapabilityPorts({ owner: this.dependencies.peers, authority });
    if (ports.files === undefined || ports.processes === undefined) {
      throw new RemoteExecutionUnavailableError("files");
    }
    return Object.freeze({
      kind: "device_peer" as const,
      binding,
      executionIdentity: stableBindingIdentity(binding),
      authorityIdentity: peerAuthorityIdentity(authority),
      pathStyle: pathStyle(binding),
      files: ports.files,
      processes: ports.processes,
      ...(authority.capabilities.includes("forwarding") && ports.forwarding !== undefined
        ? { forwarding: ports.forwarding }
        : {}),
      assertCurrent: () => authority.assertCurrent(["files", "process"]),
      assertForwardingCurrent: () => authority.assertCurrent(["files", "process", "forwarding"])
    });
  }

  async processes(binding: RemoteWorkspaceBinding, signal?: AbortSignal): Promise<RemoteProcessAuthority> {
    if (binding.kind === "ssh") {
      const captured = await this.dependencies.hosts.captureProcessAuthority(
        binding.hostTargetId,
        binding.hostId,
        signal
      );
      if (!captured.lease.capabilities.processStreaming || captured.lease.processes === undefined) {
        throw new RemoteExecutionUnavailableError("process");
      }
      return Object.freeze({
        kind: "ssh" as const,
        binding,
        executionIdentity: sshExecutionIdentity(binding, captured.host),
        authorityIdentity: sshAuthorityIdentity(captured.hostRevision, captured.leaseGeneration),
        pathStyle: "posix" as const,
        processes: captured.lease.processes,
        ...(captured.lease.capabilities.tcpForwarding && captured.lease.forwarding !== undefined
          ? { forwarding: captured.lease.forwarding }
          : {}),
        assertCurrent: captured.assertCurrent,
        assertForwardingCurrent: captured.assertForwardingCurrent
      });
    }
    const authority = this.dependencies.peers.captureBinding(
      binding.controllerDeviceId,
      binding.targetDeviceId,
      ["process"]
    );
    const ports = createDevicePeerCapabilityPorts({ owner: this.dependencies.peers, authority });
    if (ports.processes === undefined) throw new RemoteExecutionUnavailableError("process");
    return Object.freeze({
      kind: "device_peer" as const,
      binding,
      executionIdentity: stableBindingIdentity(binding),
      authorityIdentity: peerAuthorityIdentity(authority),
      pathStyle: pathStyle(binding),
      processes: ports.processes,
      ...(authority.capabilities.includes("forwarding") && ports.forwarding !== undefined
        ? { forwarding: ports.forwarding }
        : {}),
      assertCurrent: () => authority.assertCurrent(["process"]),
      assertForwardingCurrent: () => authority.assertCurrent(["process", "forwarding"])
    });
  }

  async terminal(binding: RemoteWorkspaceBinding, signal?: AbortSignal): Promise<RemoteTerminalAuthority> {
    if (binding.kind === "ssh") {
      const captured = await this.dependencies.hosts.captureProcessAuthority(
        binding.hostTargetId,
        binding.hostId,
        signal
      );
      if (!captured.lease.capabilities.fileTransfer || captured.lease.files === undefined
        || !captured.lease.capabilities.processStreaming || captured.lease.processes === undefined
        || !captured.lease.capabilities.interactiveTerminal || captured.lease.terminals === undefined) {
        throw new RemoteExecutionUnavailableError("terminal");
      }
      return Object.freeze({
        kind: "ssh" as const,
        binding,
        executionIdentity: sshExecutionIdentity(binding, captured.host),
        authorityIdentity: sshAuthorityIdentity(captured.hostRevision, captured.leaseGeneration),
        pathStyle: "posix" as const,
        files: captured.lease.files,
        processes: captured.lease.processes,
        terminals: captured.lease.terminals,
        assertCurrent: captured.assertCurrent
      });
    }
    const authority = this.dependencies.peers.captureBinding(
      binding.controllerDeviceId,
      binding.targetDeviceId,
      ["files", "process", "terminal"]
    );
    const ports = createDevicePeerCapabilityPorts({ owner: this.dependencies.peers, authority });
    if (ports.files === undefined || ports.processes === undefined || ports.terminals === undefined) {
      throw new RemoteExecutionUnavailableError("terminal");
    }
    return Object.freeze({
      kind: "device_peer" as const,
      binding,
      executionIdentity: stableBindingIdentity(binding),
      authorityIdentity: peerAuthorityIdentity(authority),
      pathStyle: pathStyle(binding),
      files: ports.files,
      processes: ports.processes,
      terminals: ports.terminals,
      assertCurrent: () => authority.assertCurrent(["files", "process", "terminal"])
    });
  }
}

function stableBindingIdentity(binding: RemoteWorkspaceBinding): string {
  return binding.kind === "ssh"
    ? JSON.stringify({ kind: "ssh", hostTargetId: binding.hostTargetId, hostId: binding.hostId })
    : JSON.stringify({
        kind: "device_peer",
        controllerDeviceId: binding.controllerDeviceId,
        targetDeviceId: binding.targetDeviceId
      });
}

function sshExecutionIdentity(
  binding: Extract<RemoteWorkspaceBinding, { readonly kind: "ssh" }>,
  host: {
    readonly ownerId: string;
    readonly hostname: string;
    readonly port: number;
    readonly user: string;
    readonly trust?: { readonly algorithm: string; readonly fingerprint: string };
  }
): string {
  if (host.ownerId.length === 0 || host.user.length === 0 || host.trust === undefined
    || host.trust.algorithm.length === 0 || host.trust.fingerprint.length === 0) {
    throw new RemoteExecutionUnavailableError("process");
  }
  return JSON.stringify({
    kind: "ssh",
    hostTargetId: binding.hostTargetId,
    hostId: binding.hostId,
    ownerId: host.ownerId,
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    algorithm: host.trust.algorithm,
    fingerprint: host.trust.fingerprint
  });
}

function sshAuthorityIdentity(hostRevision: bigint, leaseGeneration: number): string {
  return JSON.stringify({ hostRevision: hostRevision.toString(), leaseGeneration });
}

function peerAuthorityIdentity(authority: {
  readonly controllerDeviceId: string;
  readonly identity: {
    readonly targetDeviceId: string;
    readonly targetDeviceRevision: bigint;
    readonly relationId: string;
    readonly relationRevision: bigint;
    readonly routeGeneration: number;
  };
}): string {
  return JSON.stringify({
    controllerDeviceId: authority.controllerDeviceId,
    targetDeviceId: authority.identity.targetDeviceId,
    targetDeviceRevision: authority.identity.targetDeviceRevision.toString(),
    relationId: authority.identity.relationId,
    relationRevision: authority.identity.relationRevision.toString(),
    routeGeneration: authority.identity.routeGeneration
  });
}

function pathStyle(binding: RemoteWorkspaceBinding): "posix" | "win32" {
  if (binding.kind === "ssh") return "posix";
  return /^[A-Za-z]:[\\/]/u.test(binding.workspaceRoot) || binding.workspaceRoot.startsWith("\\\\")
    ? "win32"
    : "posix";
}
