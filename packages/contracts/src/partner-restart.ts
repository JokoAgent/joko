import { PartnerRestartPhase, type PartnerRestart } from "./gen/joko/v1/partner_pb.js";

export interface PartnerRestartView {
  readonly requestId: string;
  readonly partnerId: string;
  readonly phase: "closing" | "ready";
  readonly runtimeClosePending: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface PartnerRestartResult { readonly restart?: PartnerRestartView; readonly retired: boolean; }
export function projectPartnerRestart(value: PartnerRestart | undefined): PartnerRestartView {
  if (!value || !/^[A-Za-z0-9_-]{16,80}$/u.test(value.requestId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.partnerId)) throw new Error("The Partner restart identity is invalid.");
  const phase = value.phase === PartnerRestartPhase.CLOSING ? "closing" : value.phase === PartnerRestartPhase.READY ? "ready" : undefined;
  if (!phase || phase === "ready" && value.runtimeClosePending) throw new Error("The Partner restart state is invalid.");
  const time = (timestamp: PartnerRestart["createdAt"]): number => {
    if (!timestamp || timestamp.seconds < 0n || !Number.isInteger(timestamp.nanos) || timestamp.nanos < 0 || timestamp.nanos >= 1_000_000_000) {
      throw new Error("The Partner restart timestamp is invalid.");
    }
    const result = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
    if (!Number.isSafeInteger(result)) throw new Error("The Partner restart timestamp is invalid.");
    return result;
  };
  const createdAt = time(value.createdAt); const updatedAt = time(value.updatedAt);
  if (updatedAt < createdAt) throw new Error("The Partner restart timestamp changed backwards.");
  return { requestId: value.requestId, partnerId: value.partnerId, phase,
    runtimeClosePending: value.runtimeClosePending, createdAt, updatedAt };
}
