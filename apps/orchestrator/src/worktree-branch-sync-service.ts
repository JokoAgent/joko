import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { AuthorizationError, NotFoundError, StoreClosedError, operationBodyHash, type OperationalStore } from "@joko/store";
import { WorktreeServiceError, type WorktreeBranchStatus, type WorktreeBranchSyncResult } from "@joko/worktree";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

interface Receipt {
  readonly operationId: string;
  readonly pending: boolean;
  readonly unknown: boolean;
  readonly updated: number;
  readonly status?: WorktreeBranchStatus;
  readonly errorCode?: string;
}
const kind = "worktree.branch.sync";
const opaqueRevision = (status: WorktreeBranchStatus, targetId: string, targetRevision: bigint): string =>
  operationBodyHash([status.revision, targetId, targetRevision.toString()]).slice("sha256:".length);
type BranchMethods = Pick<ServiceImpl<typeof contract.WorktreeService>,
  "getTargetWorktreeBranchStatus" | "syncTargetWorktreeBranch" | "getWorktreeBranchSyncOperation">;

/** Uses the existing authorized external-effect journal. Request disconnects
 * retire observation, while explicit revocation still fences each Git effect.
 * A service restart leaves started receipts unknown rather than re-running. */
export function createWorktreeBranchSyncService(coordinator: SessionWorktreeCoordinator | undefined, store: OperationalStore,
  authenticate: (context: HandlerContext) => unknown): BranchMethods {
  const active = new Set<string>();
  const connection = (context: HandlerContext) => {
    const value = authenticate(context) as { readonly connectionId?: string; readonly authKeyDigest?: string } | undefined;
    if (!value?.connectionId || !value.authKeyDigest) throw new ConnectError("Authenticated branch authority is unavailable.", Code.Unauthenticated);
    store.authorizeConnection(value.connectionId, value.authKeyDigest);
    return { connectionId: value.connectionId, authKeyDigest: value.authKeyDigest };
  };
  const scope = (targetId: string, context: HandlerContext) => {
    const owner = connection(context);
    if (!targetId || targetId.length > 256 || /[\p{Cc}\u2028\u2029]/u.test(targetId)) {
      throw new ConnectError("Select a valid repository Target.", Code.InvalidArgument);
    }
    const target = store.getTarget(targetId);
    if (!coordinator || !target.descriptor.trusted || target.descriptor.remoteWorkspace) {
      throw new ConnectError("Select a trusted local repository Target.", Code.FailedPrecondition);
    }
    const assertCurrent = () => {
      store.authorizeConnection(owner.connectionId, owner.authKeyDigest);
      const current = store.getTarget(targetId);
      if (current.revision !== target.revision || !current.descriptor.trusted || current.descriptor.remoteWorkspace
        || current.descriptor.workspaceRoot !== target.descriptor.workspaceRoot) {
        throw new ConnectError("The repository Target changed.", Code.Aborted);
      }
    };
    return { owner, target, assertCurrent, coordinator };
  };
  const id = (value: string): string => {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) throw new ConnectError("A stable branch operation ID is required.", Code.InvalidArgument);
    return `worktree-branch:${value}`;
  };
  const branchRef = (value: string): void => {
    if (value.length > 1_024 || !/^refs\/(?:heads|remotes)\//u.test(value) || /[\p{Cc}\u2028\u2029]/u.test(value)) {
      throw new ConnectError("Select a full branch ref.", Code.InvalidArgument);
    }
  };
  const proto = (value: Receipt) => create(contract.WorktreeBranchSyncOperationSchema, value);
  const read = (operationId: string, context: HandlerContext): Receipt => {
    const owner = connection(context), key = id(operationId), record = store.findOperation<Receipt>(key);
    if (!record || record.kind !== kind || record.connectionId !== owner.connectionId) {
      throw new ConnectError("This branch operation is unavailable for the original connection.", Code.NotFound);
    }
    if (record.status === "completed" && record.response) return record.response;
    return { operationId, pending: active.has(key), unknown: !active.has(key), updated: 0,
      ...(!active.has(key) ? { errorCode: "outcome_unknown" } : {}) };
  };
  const methods: BranchMethods = {
    getTargetWorktreeBranchStatus: async (request, context) => {
      const current = scope(request.targetId, context);
      branchRef(request.sourceRef);
      const status = await current.coordinator.branchStatus(current.target.descriptor, request.sourceRef, { signal: context.signal });
      current.assertCurrent(); context.signal.throwIfAborted();
      return create(contract.GetTargetWorktreeBranchStatusResponseSchema, {
        status: { ...status, revision: opaqueRevision(status, request.targetId, current.target.revision) }
      });
    },
    syncTargetWorktreeBranch: async (request, context) => {
      const owner = connection(context), key = id(request.operationId);
      branchRef(request.sourceRef);
      if (!/^[a-f0-9]{64}$/u.test(request.expectedRevision)) throw new ConnectError("Read the selected branch status before updating.", Code.InvalidArgument);
      const body = { targetId: request.targetId, sourceRef: request.sourceRef, expectedRevision: request.expectedRevision };
      const previous = store.findOperation<Receipt>(key);
      if (previous) {
        if (previous.kind !== kind || previous.connectionId !== owner.connectionId) throw new ConnectError("Branch operation is unavailable.", Code.PermissionDenied);
        if (previous.bodyHash !== operationBodyHash(body)) throw new ConnectError("This operation ID already names another branch request.", Code.AlreadyExists);
        return create(contract.SyncTargetWorktreeBranchResponseSchema, { operation: proto(read(request.operationId, context)) });
      }
      if (active.size >= 32) throw new ConnectError("Too many branch updates are running.", Code.ResourceExhausted);
      const current = scope(request.targetId, context);
      const before = await current.coordinator.branchStatus(current.target.descriptor, request.sourceRef, { signal: context.signal });
      const raced = store.findOperation<Receipt>(key);
      if (raced) {
        if (raced.kind !== kind || raced.connectionId !== owner.connectionId) throw new ConnectError("Branch operation is unavailable.", Code.PermissionDenied);
        if (raced.bodyHash !== operationBodyHash(body)) throw new ConnectError("This operation ID already names another branch request.", Code.AlreadyExists);
        return create(contract.SyncTargetWorktreeBranchResponseSchema, { operation: proto(read(request.operationId, context)) });
      }
      current.assertCurrent(); context.signal.throwIfAborted();
      if (opaqueRevision(before, request.targetId, current.target.revision) !== request.expectedRevision) {
        throw new ConnectError("The branch observation changed. Refresh its status.", Code.Aborted);
      }
      if (active.size >= 32) throw new ConnectError("Too many branch updates are running.", Code.ResourceExhausted);
      // Another request may have claimed this ID during the read. The Store's
      // atomic claim prevents a second native effect for the same request.
      const claim = store.claimAuthorizedDeferredEffectOperation<Receipt>(owner.connectionId, owner.authKeyDigest,
        { id: key, kind, body }, () => current.assertCurrent());
      if (claim.replayed) return create(contract.SyncTargetWorktreeBranchResponseSchema, { operation: proto(claim.value!) });
      active.add(key);
      void Promise.resolve().then(async () => {
        const result: WorktreeBranchSyncResult = await current.coordinator.syncBranch(current.target.descriptor,
          request.sourceRef, before.revision, current.assertCurrent);
        current.assertCurrent();
        store.completeAuthorizedDeferredEffectOperation<Receipt>(owner.connectionId, owner.authKeyDigest, key, claim.operation.bodyHash, () => {
          current.assertCurrent();
          return { operationId: request.operationId, pending: false, unknown: false, updated: result.updated,
            status: { ...result.status, revision: opaqueRevision(result.status, request.targetId, current.target.revision) } };
        });
      }).catch(() => { /* The started receipt remains visible as unknown; never redispatch. */ }).finally(() => active.delete(key));
      return create(contract.SyncTargetWorktreeBranchResponseSchema, { operation: proto({ operationId: request.operationId, pending: true, unknown: false, updated: 0 }) });
    },
    getWorktreeBranchSyncOperation: async (request, context) => create(contract.GetWorktreeBranchSyncOperationResponseSchema,
      { operation: proto(read(request.operationId, context)) })
  };
  const invoke = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof AuthorizationError) throw new ConnectError("The original repository connection is no longer authorized.", Code.PermissionDenied);
      if (error instanceof NotFoundError) throw new ConnectError("The selected repository is unavailable.", Code.NotFound);
      if (error instanceof StoreClosedError) throw new ConnectError("Repository authority is restarting.", Code.Unavailable);
      if (error instanceof WorktreeServiceError) throw new ConnectError("The selected branch could not be inspected safely.", error.code === "INVALID_ARGUMENT" ? Code.InvalidArgument : Code.FailedPrecondition);
      throw error;
    }
  };
  return {
    getTargetWorktreeBranchStatus: (request, context) => invoke(() => methods.getTargetWorktreeBranchStatus(request, context)),
    syncTargetWorktreeBranch: (request, context) => invoke(() => methods.syncTargetWorktreeBranch(request, context)),
    getWorktreeBranchSyncOperation: (request, context) => invoke(() => methods.getWorktreeBranchSyncOperation(request, context))
  };
}
