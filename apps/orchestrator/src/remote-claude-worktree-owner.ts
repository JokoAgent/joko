import { createHash } from "node:crypto";
import { posix as remotePath } from "node:path";

import type { SessionWorktreeBinding } from "@joko/core";
import {
  RemoteGitCheckoutError,
  RemoteGitCheckoutService,
  type RemoteGitCheckoutAuthority,
  type RemoteGitCheckoutInspection,
  type RemoteGitCheckoutLease,
  type RemoteGitCheckoutPlan
} from "@joko/remote-ssh";
import type { OperationalStore, RemoteHostRecord, StoredTarget } from "@joko/store";

import { probeRemoteClaudeInstallation } from "./remote-claude-installation.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

/** Adapter-side remote checkout owner. The Target retains its source remote
 * binding; a Session worktree carries the effective POSIX cwd separately. */
export class RemoteClaudeWorktreeOwner {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #registry: Pick<RemoteHostRegistry, "captureProcessAuthority" | "execute">;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getTarget">;
    readonly registry: Pick<RemoteHostRegistry, "captureProcessAuthority" | "execute">;
  }) {
    this.#store = options.store;
    this.#registry = options.registry;
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
    if (captured.authority.hostRevision !== plan.authority.hostRevision) {
      throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    }
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
    const captured = await this.#registry.captureProcessAuthority(remote.hostTargetId, remote.hostId, signal);
    captured.assertCurrent();
    if (captured.host.status.state !== "ready" || captured.host.trust === undefined
      || captured.host.ownerId.length === 0 || captured.host.targetId !== remote.hostTargetId) {
      throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    }
    const processes = captured.lease.processes;
    if (captured.lease.capabilities.processStreaming !== true || processes === undefined) {
      throw new RemoteGitCheckoutError("UNAVAILABLE");
    }
    const installation = await probeRemoteClaudeInstallation(
      processes, remote.workspaceRoot, captured.assertCurrent, signal
    );
    captured.assertCurrent();
    if (installation.state !== "ready" || installation.workspaceRoot !== remote.workspaceRoot) {
      throw new RemoteGitCheckoutError("UNAVAILABLE");
    }
    const identity = hostIdentity(captured.host);
    const authority: RemoteGitCheckoutAuthority = Object.freeze({
      hostOwnerId: captured.host.ownerId,
      hostTargetId: remote.hostTargetId,
      hostId: remote.hostId,
      hostIdentity: identity,
      targetId: target.descriptor.id,
      targetRevision: target.revision.toString(),
      hostRevision: captured.hostRevision.toString()
    });
    const assertCurrent = (): void => {
      captured.assertCurrent();
      const current = this.#store.getTarget(target.descriptor.id);
      if (current.revision !== target.revision
        || current.descriptor.backendId !== target.descriptor.backendId
        || current.descriptor.remoteWorkspace?.hostTargetId !== remote.hostTargetId
        || current.descriptor.remoteWorkspace?.hostId !== remote.hostId
        || current.descriptor.remoteWorkspace?.workspaceRoot !== remote.workspaceRoot) {
        throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
      }
    };
    assertCurrent();
    const service = new RemoteGitCheckoutService({
      storageRoot: remotePath.join(installation.runtimeRoot, "worktrees"),
      nodeExecutable: installation.nodeExecutable,
      assertCurrent: (expected) => {
        assertCurrent();
        if (!sameStableAuthority(authority, expected)
          || authority.targetRevision !== expected.targetRevision) {
          throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
        }
      },
      execute: async (options) => {
        assertCurrent();
        const outcome = await this.#registry.execute(remote.hostTargetId, remote.hostId, options);
        assertCurrent();
        if (hostIdentity(outcome.host) !== identity || outcome.host.ownerId !== authority.hostOwnerId) {
          throw new RemoteGitCheckoutError("AUTHORITY_CHANGED", true);
        }
        return outcome.result;
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
  return left.hostOwnerId === right.hostOwnerId
    && left.hostTargetId === right.hostTargetId
    && left.hostId === right.hostId
    && left.hostIdentity === right.hostIdentity
    && left.targetId === right.targetId;
}

function hostIdentity(host: RemoteHostRecord): string {
  if (host.trust === undefined) throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
  return `sha256:${createHash("sha256").update(JSON.stringify({
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    algorithm: host.trust.algorithm,
    fingerprint: host.trust.fingerprint
  }), "utf8").digest("hex")}`;
}
