import { PartnerDeletionPhase, PartnerDeletionFailure, type PartnerDeletion } from "./gen/joko/v1/partner_pb.js";

export interface PartnerDeletionView {
  readonly requestId: string;
  readonly partnerId: string;
  readonly phase: "closing" | "cleanup" | "completed";
  readonly failure?: "runtime_close_pending" | "home_cleanup_pending";
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface PartnerDeletionResult { readonly deletion?: PartnerDeletionView; readonly retired: boolean; }

export function projectPartnerDeletion(value: PartnerDeletion | undefined): PartnerDeletionView {
  if (!value || !/^[A-Za-z0-9_-]{16,80}$/u.test(value.requestId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.partnerId)) throw new Error("The Partner deletion identity is invalid.");
  const phase = value.phase === PartnerDeletionPhase.CLOSING ? "closing" : value.phase === PartnerDeletionPhase.CLEANUP ? "cleanup"
    : value.phase === PartnerDeletionPhase.COMPLETED ? "completed" : undefined;
  const failure = value.failure === PartnerDeletionFailure.UNSPECIFIED ? undefined
    : value.failure === PartnerDeletionFailure.RUNTIME_CLOSE_PENDING ? "runtime_close_pending"
      : value.failure === PartnerDeletionFailure.HOME_CLEANUP_PENDING ? "home_cleanup_pending" : undefined;
  if (!phase || value.failure !== PartnerDeletionFailure.UNSPECIFIED && !failure || phase === "completed" && failure) {
    throw new Error("The Partner deletion state is invalid.");
  }
  const time = (timestamp: PartnerDeletion["createdAt"]): number => {
    if (!timestamp || timestamp.seconds < 0n || !Number.isInteger(timestamp.nanos) || timestamp.nanos < 0 || timestamp.nanos >= 1_000_000_000) {
      throw new Error("The Partner deletion timestamp is invalid.");
    }
    const result = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
    if (!Number.isSafeInteger(result)) throw new Error("The Partner deletion timestamp is invalid.");
    return result;
  };
  const createdAt = time(value.createdAt); const updatedAt = time(value.updatedAt);
  if (updatedAt < createdAt) throw new Error("The Partner deletion timestamp changed backwards.");
  return { requestId: value.requestId, partnerId: value.partnerId, phase, ...(failure ? { failure } : {}), createdAt, updatedAt };
}
