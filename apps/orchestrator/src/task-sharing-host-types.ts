import type * as contract from "@joko/contracts";
import type { OperationalStore, SharedTaskAuthor, TaskShareGuestProof } from "@joko/store";

export interface TaskShareLease {
  readonly proof: TaskShareGuestProof;
  readonly scope: contract.TaskShareScope;
  readonly author: SharedTaskAuthor;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export type PreparedTaskShareOperation =
  | { readonly kind: "transactional";
      readonly commit: (store: OperationalStore, author: SharedTaskAuthor) => Uint8Array;
      readonly afterCommit?: () => void }
  | { readonly kind: "effect";
      readonly execute: (author: SharedTaskAuthor, signal: AbortSignal) => Promise<Uint8Array> };

/** Only fixed shared-task capabilities cross this trusted composition port.
 * It is not a public RPC dispatcher and must not manufacture a Connection. */
export interface TaskSharingRuntimePort {
  canShare(sessionId: string): boolean;
  snapshot(lease: TaskShareLease, signal: AbortSignal): Promise<contract.Snapshot>;
  read(lease: TaskShareLease, method: contract.TaskShareMethod, requestBytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  prepareOperation(lease: TaskShareLease, request: contract.SubmitOperationRequest): PreparedTaskShareOperation;
  projectEvent(lease: TaskShareLease, event: import("@joko/store").PersistedEvent): contract.Event | undefined;
}
