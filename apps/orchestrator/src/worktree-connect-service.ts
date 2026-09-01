import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { NotFoundError, StoreClosedError, type OperationalStore } from "@joko/store";

import {
  SessionWorktreeCoordinator,
  SessionWorktreeCoordinatorError,
  type TargetWorktreeEligibility
} from "./session-worktree-coordinator.js";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 500;

/** Read-only capability boundary used before a client snapshots first-Send intent. */
export function createWorktreeConnectService(
  coordinator: SessionWorktreeCoordinator | undefined,
  store: OperationalStore,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.WorktreeService> {
  return {
    probeTargetWorktree: async (request, context) => worktreeRpc(async () => {
      authenticate(context);
      const target = store.getTarget(publicTargetId(request.targetId));
      const probe = await requireCoordinator(coordinator).probe(target.descriptor);
      return create(contract.ProbeTargetWorktreeResponseSchema, {
        targetId: probe.targetId,
        eligibility: toProtoEligibility(probe.eligibility),
        repositoryRootDisplay: probe.repositoryRoot ?? "",
        currentBranch: probe.currentBranch ?? "",
        headCommit: probe.headCommit ?? "",
        canRefreshRemote: probe.canRefreshRemote
      });
    }),

    listTargetWorktreeSources: async (request, context) => worktreeRpc(async () => {
      authenticate(context);
      const target = store.getTarget(publicTargetId(request.targetId));
      const probe = await requireCoordinator(coordinator).probe(target.descriptor);
      if (probe.eligibility !== "eligible") {
        throw new ConnectError("The selected Target cannot create an isolated workspace.", Code.FailedPrecondition);
      }
      const sources = await requireCoordinator(coordinator).listSources(target.descriptor);
      const page = paginate(sources, request.page);
      return create(contract.ListTargetWorktreeSourcesResponseSchema, {
        sources: page.values.map((source) => create(contract.WorktreeSourceOptionSchema, {
          ref: source.ref,
          commit: source.commit,
          displayName: source.name,
          remote: source.kind === "remote",
          current: source.current
        })),
        page: page.info
      });
    })
  } satisfies ServiceImpl<typeof contract.WorktreeService>;
}

function requireCoordinator(value: SessionWorktreeCoordinator | undefined): SessionWorktreeCoordinator {
  if (value === undefined) throw new ConnectError("Isolated workspaces are unavailable.", Code.Unimplemented);
  return value;
}

function publicTargetId(value: string): string {
  if (
    value === "" || value !== value.trim() || value.length > 256 ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) throw new ConnectError("target_id is invalid.", Code.InvalidArgument);
  return value;
}

function toProtoEligibility(value: TargetWorktreeEligibility): contract.WorktreeEligibility {
  switch (value) {
    case "eligible": return contract.WorktreeEligibility.ELIGIBLE;
    case "not_git_repository": return contract.WorktreeEligibility.NOT_GIT_REPOSITORY;
    case "already_linked": return contract.WorktreeEligibility.ALREADY_LINKED;
    case "unsafe": return contract.WorktreeEligibility.UNSAFE;
    case "unavailable": return contract.WorktreeEligibility.UNAVAILABLE;
  }
}

function paginate<T>(
  values: readonly T[],
  request: contract.PageRequest | undefined
): { readonly values: readonly T[]; readonly info: contract.PageInfo } {
  const offset = decodePageToken(request?.pageToken ?? "");
  if (offset > values.length) {
    throw new ConnectError("Worktree page token is outside the current source catalog.", Code.FailedPrecondition);
  }
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);
  const selected = values.slice(offset, offset + size);
  const next = offset + selected.length;
  return {
    values: selected,
    info: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodePageToken(next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

function encodePageToken(offset: number): string {
  return Buffer.from(`joko-worktree-page:${offset}`, "utf8").toString("base64url");
}

function decodePageToken(token: string): number {
  if (token === "") return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("canonical");
    const match = /^joko-worktree-page:(\d+)$/u.exec(decoded);
    if (match?.[1] === undefined) throw new Error("format");
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("range");
    return offset;
  } catch {
    throw new ConnectError("Worktree page_token is malformed.", Code.InvalidArgument);
  }
}

async function worktreeRpc<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof NotFoundError) throw new ConnectError("Target was not found.", Code.NotFound);
    if (error instanceof StoreClosedError) throw new ConnectError("Worktree storage is unavailable.", Code.Unavailable);
    if (error instanceof SessionWorktreeCoordinatorError) {
      if (error.code === "ABORTED") throw new ConnectError("The Worktree request was cancelled.", Code.Canceled);
      if (error.code === "INVALID_ARGUMENT") throw new ConnectError("The Worktree request is invalid.", Code.InvalidArgument);
      if (error.code === "SOURCE_NOT_FOUND") throw new ConnectError("The requested Worktree source was not found.", Code.NotFound);
      if (error.code === "OPERATION_TIMEOUT") throw new ConnectError("The Worktree request timed out.", Code.DeadlineExceeded);
      if (error.code === "GIT_NOT_FOUND" || error.code === "DISPOSED" || error.code === "NOT_INITIALIZED") {
        throw new ConnectError("Worktree support is unavailable.", Code.Unavailable);
      }
      throw new ConnectError("The Worktree request is unsafe for the selected Target.", Code.FailedPrecondition);
    }
    throw new ConnectError("Orchestrator could not complete the Worktree request.", Code.Internal);
  }
}
