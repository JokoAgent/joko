import { posix, win32 } from "node:path";

import type { SessionWorktreeBinding } from "@joko/core";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import {
  RemoteGitCheckoutError,
  RemoteGitCheckoutService,
  type RemoteGitCheckoutAuthority,
  type RemoteGitCheckoutExecutionOptions,
  type RemoteGitCheckoutInspection,
  type RemoteGitCheckoutLease,
  type RemoteGitCheckoutPlan,
  type RemoteProcessTransportPort,
  type RemoteSshExecutionResult
} from "@joko/remote-ssh";
import type { OperationalStore, StoredTarget } from "@joko/store";

import { devicePeerClaudeInstallation, probeRemoteClaudeInstallation } from "./remote-claude-installation.js";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";

/** Adapter-side remote checkout owner. The Target retains its source remote
 * binding; a Session worktree carries the effective POSIX cwd separately. */
export class RemoteClaudeWorktreeOwner {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #remoteExecution: Pick<RemoteExecutionRouter, "processes">;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getTarget">;
    readonly remoteExecution: Pick<RemoteExecutionRouter, "processes">;
  }) {
    this.#store = options.store;
    this.#remoteExecution = options.remoteExecution;
  }

  async plan(input: {
    readonly target: StoredTarget;
    readonly sessionId: string;
    readonly sourceSessionId: string;
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly sourceLease?: RemoteGitCheckoutLease;
    readonly signal?: AbortSignal;
  }): Promise<RemoteGitCheckoutPlan | undefined> {
    const current = this.#store.getTarget(input.target.descriptor.id);
    if (current.revision !== input.target.revision) throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    const captured = await this.#capture(current, input.signal);
    try {
      return await captured.service.plan({
        sessionId: input.sessionId,
        sourceSessionId: input.sourceSessionId,
        workspaceId: input.workspaceId,
        sourceCwd: input.sourceCwd,
        ...(input.sourceLease === undefined ? {} : { sourceLease: input.sourceLease }),
        authority: captured.authority
      }, input.signal);
    } catch (error) {
      if (error instanceof RemoteGitCheckoutError && error.code === "NOT_GIT_REPOSITORY") return undefined;
      throw error;
    }
  }

  async derive(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<RemoteGitCheckoutLease> {
    const captured = await this.#captureFor(plan.remote, signal);
    return captured.service.derive(plan, signal);
  }

  async inspectExact(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<RemoteGitCheckoutInspection> {
    return (await this.#captureFor(plan.remote, signal)).service.inspectExact(plan, signal);
  }

  async cleanupPending(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<"absent" | "released" | "preserved"> {
    return (await this.#captureFor(plan.remote, signal)).service.cleanupPending(plan, signal);
  }

  async assertExact(sessionId: string, binding: SessionWorktreeBinding, signal?: AbortSignal): Promise<void> {
    const lease = remoteLeaseFromBinding(sessionId, binding);
    await (await this.#captureFor(lease.remote, signal)).service.assertExact(lease, signal);
  }

  async releaseExact(sessionId: string, binding: SessionWorktreeBinding, signal?: AbortSignal): Promise<"released" | "preserved"> {
    const lease = remoteLeaseFromBinding(sessionId, binding);
    return (await this.#captureFor(lease.remote, signal)).service.releaseExact(lease, signal);
  }

  async #captureFor(
    expected: RemoteGitCheckoutAuthority & { readonly manifestId: string },
    signal?: AbortSignal
  ): Promise<{ readonly authority: RemoteGitCheckoutAuthority; readonly service: RemoteGitCheckoutService }> {
    const target = this.#store.getTarget(expected.targetId);
    const captured = await this.#capture(target, signal);
    if (!sameStableAuthority(captured.authority, expected)
      || captured.authority.targetRevision !== expected.targetRevision) {
      throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    }
    return captured;
  }

  async #capture(
    target: StoredTarget,
    signal?: AbortSignal
  ): Promise<{ readonly authority: RemoteGitCheckoutAuthority; readonly service: RemoteGitCheckoutService }> {
    const remote = target.descriptor.remoteWorkspace;
    if (remote === undefined || !target.descriptor.trusted || !target.descriptor.managed) {
      throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    }
    const captured = await this.#remoteExecution.processes(remote, signal);
    captured.assertCurrent();
    const remotePath = captured.pathStyle === "win32" ? win32 : posix;
    const processes = captured.processes;
    const installation = captured.kind === "device_peer"
      ? await devicePeerClaudeInstallation(remote.workspaceRoot, captured.pathStyle)
      : await probeRemoteClaudeInstallation(processes, remote.workspaceRoot, captured.assertCurrent, signal);
    captured.assertCurrent();
    if (installation.state !== "ready" || installation.workspaceRoot !== remote.workspaceRoot) {
      throw new RemoteGitCheckoutError("UNAVAILABLE");
    }
    const authority: RemoteGitCheckoutAuthority = Object.freeze({
      targetId: target.descriptor.id,
      binding: remote,
      executionIdentity: captured.executionIdentity,
      targetRevision: target.revision.toString()
    });
    const assertCurrent = (): void => {
      captured.assertCurrent();
      const current = this.#store.getTarget(target.descriptor.id);
      const currentRemote = current.descriptor.remoteWorkspace;
      if (current.revision !== target.revision
        || current.descriptor.backendId !== target.descriptor.backendId
        || currentRemote === undefined || !sameBinding(currentRemote, remote)) {
        throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
      }
    };
    assertCurrent();
    const service = new RemoteGitCheckoutService({
      storageRoot: remotePath.join(installation.runtimeRoot, "worktrees"),
      nodeExecutable: installation.runtimeEntrypoint === "device_peer"
        ? DEVICE_PEER_RUNTIME_EXECUTABLES.node
        : installation.nodeExecutable,
      pathStyle: captured.pathStyle,
      assertCurrent: (expected) => {
        assertCurrent();
        if (!sameStableAuthority(authority, expected)
          || authority.targetRevision !== expected.targetRevision) {
          throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
        }
      },
      execute: async (options) => {
        assertCurrent();
        const outcome = await executeRemoteProcess(processes, remote.workspaceRoot, options);
        assertCurrent();
        return outcome;
      }
    });
    return { authority, service };
  }
}

export function remoteLeaseFromBinding(sessionId: string, binding: SessionWorktreeBinding): RemoteGitCheckoutLease {
  if (binding.remote === undefined || binding.state !== "active"
    || binding.workspaceId !== `worktree-${sessionId}`
    || binding.sourceStrategy !== "explicit" || binding.sourceRefreshed !== false) {
    throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  }
  return {
    id: binding.leaseId,
    sessionId,
    path: binding.path,
    repositoryRoot: binding.repositoryRoot,
    branch: binding.branch,
    source: {
      ref: binding.sourceRef,
      commit: binding.sourceCommit,
      strategy: "explicit",
      refreshed: false
    },
    acquiredAt: binding.acquiredAt,
    remote: binding.remote
  };
}

export function remoteBindingFromLease(workspaceId: string, lease: RemoteGitCheckoutLease): SessionWorktreeBinding {
  return {
    leaseId: lease.id,
    workspaceId,
    path: lease.path,
    repositoryRoot: lease.repositoryRoot,
    branch: lease.branch,
    sourceRef: lease.source.ref,
    sourceCommit: lease.source.commit,
    sourceStrategy: lease.source.strategy,
    sourceRefreshed: lease.source.refreshed,
    remote: lease.remote,
    state: "active",
    acquiredAt: lease.acquiredAt,
    updatedAt: Date.now()
  };
}

function sameStableAuthority(left: RemoteGitCheckoutAuthority, right: RemoteGitCheckoutAuthority): boolean {
  return left.targetId === right.targetId
    && left.executionIdentity === right.executionIdentity
    && sameBinding(left.binding, right.binding);
}

function sameBinding(
  left: RemoteGitCheckoutAuthority["binding"],
  right: RemoteGitCheckoutAuthority["binding"]
): boolean {
  return left.kind === right.kind && JSON.stringify(left) === JSON.stringify(right);
}

async function executeRemoteProcess(
  processes: RemoteProcessTransportPort,
  workspaceRoot: string,
  options: RemoteGitCheckoutExecutionOptions
): Promise<RemoteSshExecutionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  timeout.unref?.();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const handle = await processes.open({
      executable: options.executable,
      args: [...options.args],
      cwd: options.cwd ?? workspaceRoot,
      signal: controller.signal
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputCapped = false;
    const maximumBytes = 1024 * 1024;
    const collect = (target: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const accepted = Math.max(0, Math.min(value.byteLength, maximumBytes - current));
      if (accepted > 0) target.push(value.subarray(0, accepted));
      if (stream === "stdout") stdoutBytes += accepted;
      else stderrBytes += accepted;
      if (accepted < value.byteLength) {
        outputCapped = true;
        controller.abort();
        handle.kill("SIGKILL");
      }
    };
    handle.stdout.on("data", collect(stdout, "stdout"));
    handle.stderr.on("data", collect(stderr, "stderr"));
    return await new Promise<RemoteSshExecutionResult>((resolve, reject) => {
      const fail = (error: Error): void => reject(error);
      handle.once("error", fail);
      handle.once("exit", (code, signalCode) => resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        ...(signalCode === null ? {} : { signal: signalCode }),
        outputCapped
      }));
      if (options.input === undefined) handle.stdin.end();
      else handle.stdin.end(options.input, "utf8");
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
