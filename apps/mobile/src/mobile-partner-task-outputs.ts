import { PartnerTaskOutputFileStatus, PartnerTaskOutputReadiness, PartnerTaskOutputSourceKind,
  type ListPartnerTaskOutputsResponse } from "@joko/contracts";
import { validMobilePartnerId } from "./mobile-partner-private";

export interface MobilePartnerTaskOutput {
  readonly kind: "session-task" | "delegation";
  readonly id: string;
  readonly parentSessionId: string;
  readonly sessionId?: string;
  readonly execution: number;
  readonly revision: bigint;
  readonly runIds: readonly string[];
  readonly title: string;
  readonly readiness: "pending" | "ready" | "unavailable";
  readonly files: readonly { readonly path: string; readonly status: "added" | "modified" | "renamed" }[];
  readonly truncated: boolean;
}
export interface MobilePartnerTaskOutputs {
  readonly partnerId: string;
  readonly rows: readonly MobilePartnerTaskOutput[];
  readonly truncated: boolean;
}
const ENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TEXT = /^[^\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/u;
export function projectMobilePartnerTaskOutputs(value: ListPartnerTaskOutputsResponse, partnerId: string): MobilePartnerTaskOutputs {
  if (!validMobilePartnerId(partnerId) || value.partnerId !== partnerId || value.outputs.length > 200) throw invalid();
  const identities = new Set<string>();
  const rows = value.outputs.map(row => {
    const kind = row.sourceKind === PartnerTaskOutputSourceKind.SESSION_TASK ? "session-task"
      : row.sourceKind === PartnerTaskOutputSourceKind.DELEGATION ? "delegation" : undefined;
    const readiness = row.readiness === PartnerTaskOutputReadiness.PENDING ? "pending"
      : row.readiness === PartnerTaskOutputReadiness.READY ? "ready"
        : row.readiness === PartnerTaskOutputReadiness.UNAVAILABLE ? "unavailable" : undefined;
    const revision = row.sourceRevision?.value;
    if (!kind || !readiness || !ENTITY.test(row.sourceId) || !ENTITY.test(row.parentSessionId)
      || row.sessionId !== "" && !ENTITY.test(row.sessionId) || row.execution < 1n || row.execution > BigInt(Number.MAX_SAFE_INTEGER)
      || revision === undefined || revision < 1n || row.title.length > 2000 || !TEXT.test(row.title)
      || row.runIds.some(id => !ENTITY.test(id)) || new Set(row.runIds).size !== row.runIds.length
      || row.runIds.length > 0 && !row.sessionId || readiness === "ready" && (!row.sessionId || row.runIds.length === 0)
      || row.files.length > 64) throw invalid();
    const identity = `${kind}\u001f${row.sourceId}`;
    if (identities.has(identity)) throw invalid(); identities.add(identity);
    const paths = new Set<string>();
    const files = row.files.map(file => {
      const status = file.status === PartnerTaskOutputFileStatus.ADDED ? "added"
        : file.status === PartnerTaskOutputFileStatus.MODIFIED ? "modified"
          : file.status === PartnerTaskOutputFileStatus.RENAMED ? "renamed" : undefined;
      if (!status || !file.path || file.path.length > 1024 || !TEXT.test(file.path)
        || /^(?:[/\\]|[A-Za-z]:)/u.test(file.path) || file.path.split(/[/\\]/u).includes("..") || paths.has(file.path)) throw invalid();
      paths.add(file.path); return Object.freeze({ path: file.path, status });
    });
    return Object.freeze({ kind, id: row.sourceId, parentSessionId: row.parentSessionId,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}), execution: Number(row.execution), revision,
      runIds: Object.freeze([...row.runIds]), title: row.title, readiness, files: Object.freeze(files), truncated: row.truncated });
  });
  return Object.freeze({ partnerId, rows: Object.freeze(rows), truncated: value.truncated });
}
export function sameMobilePartnerTaskOutputSource(left: MobilePartnerTaskOutput, right: MobilePartnerTaskOutput): boolean {
  return left.kind === right.kind && left.id === right.id && left.parentSessionId === right.parentSessionId
    && left.sessionId === right.sessionId && left.execution === right.execution && left.revision === right.revision
    && left.runIds.length === right.runIds.length && left.runIds.every((id, index) => id === right.runIds[index]);
}
function invalid(): Error { return new Error("The Partner task output metadata is inconsistent."); }
