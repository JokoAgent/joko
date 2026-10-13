import type { OperationalStore, PartnerStore } from "@joko/store";
import type { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import type { DurableWorkspaceRunCapture, WorkspaceRunOutput } from "./workspace-run-capture.js";

export interface PartnerTaskOutputRow {
  readonly kind: "task" | "delegation";
  readonly id: string;
  readonly partnerId: string;
  readonly parentSessionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly execution: number;
  readonly revision: bigint;
  readonly runIds: readonly string[];
  readonly readiness: "pending" | "ready" | "unavailable";
  readonly files: readonly { readonly path: string; readonly status: "added" | "modified" | "renamed" }[];
  readonly truncated: boolean;
}

interface OutputSource extends Omit<PartnerTaskOutputRow, "readiness" | "files" | "truncated"> {
  readonly active: boolean;
  readonly sessionGeneration: number;
}

export class PartnerTaskOutputChangedError extends Error {
  constructor() { super("The Partner task output source changed. Refresh before opening its task."); }
}

/** Requester-owned task inventory over exact durable Run captures. */
export class PartnerTaskOutputProjection {
  constructor(
    readonly store: OperationalStore,
    readonly tasks: Pick<PartnerSessionTaskManager, "list">,
    readonly partners: Pick<PartnerStore, "getPartner" | "listDelegations">,
    readonly capture: Pick<DurableWorkspaceRunCapture, "readRunOutput">
  ) {}

  async list(partnerId: string): Promise<readonly PartnerTaskOutputRow[]> {
    const partner = this.partners.getPartner(partnerId);
    const sources = this.sources(partnerId);
    const rows = await Promise.all(sources.map(async source => {
      const captures = await Promise.all(source.runIds.map(async runId => {
        try {
          const run = this.store.getRun(runId).descriptor;
          if (run.sessionId !== source.sessionId) return { readiness: "unavailable", changes: [] } satisfies WorkspaceRunOutput;
          const queue = this.store.findQueueItemByRunId(source.sessionId, runId);
          if (queue?.backendAcceptedAt === undefined) return undefined;
          return await this.capture.readRunOutput(source.sessionId, runId);
        } catch { return { readiness: "unavailable", changes: [] } satisfies WorkspaceRunOutput; }
      }));
      let readiness: PartnerTaskOutputRow["readiness"] = source.active ? "pending" : "ready";
      const byPath = new Map<string, "added" | "modified" | "deleted" | "renamed">();
      let invalid = false;
      for (const result of captures) {
        if (result === undefined) continue;
        if (result.readiness === "unavailable") readiness = "unavailable";
        else if (result.readiness === "pending" && readiness !== "unavailable") readiness = "pending";
        for (const file of result.changes) {
          if (!validOutputPath(file.path) || !["added", "modified", "deleted", "renamed"].includes(file.status)) { invalid = true; continue; }
          byPath.set(file.path, file.status);
        }
      }
      if (invalid || (!source.active && captures.every(result => result === undefined))) readiness = "unavailable";
      const files = [...byPath].flatMap(([path, status]) => status === "deleted" ? [] : [{ path, status }]);
      const { active: _active, sessionGeneration: _generation, ...identity } = source;
      return { ...identity, readiness, files: files.slice(0, 64), truncated: files.length > 64 } satisfies PartnerTaskOutputRow;
    }));
    const current = this.partners.getPartner(partnerId);
    if (current.revision !== partner.revision || current.canonicalSessionId !== partner.canonicalSessionId
      || current.lifecycle !== partner.lifecycle || !sameSources(sources, this.sources(partnerId))) throw new PartnerTaskOutputChangedError();
    return rows;
  }

  private sources(partnerId: string): readonly OutputSource[] {
    const tasks = this.tasks.list(partnerId).filter(task => task.sessionId !== undefined).map(task => ({
      kind: "task" as const, id: task.id, partnerId, parentSessionId: task.parentSessionId, sessionId: task.sessionId!, title: task.title,
      execution: task.execution, runIds: [...task.executionRunIds],
      revision: this.store.getSetting("service", "partner.session-tasks", task.id).revision,
      active: ["preparing", "queued", "running", "waiting", "unknown"].includes(task.status)
    }));
    const delegations = this.partners.listDelegations(partnerId).filter(row => row.requesterPartnerId === partnerId && row.childSessionId !== undefined).map(row => ({
      kind: "delegation" as const, id: row.id, partnerId, parentSessionId: row.parentSessionId, sessionId: row.childSessionId!, title: row.title,
      execution: 1, revision: row.revision, runIds: row.runId === undefined ? [] : [row.runId],
      active: ["preparing", "queued", "running", "waiting", "unknown"].includes(row.status)
    }));
    return [...tasks, ...delegations].flatMap(source => {
      try {
        const session = this.store.getSession(source.sessionId).descriptor;
        return session.deletedAt === undefined ? [{ ...source, sessionGeneration: session.binding.generation }] : [];
      } catch { return []; }
    });
  }
}

export function validOutputPath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 1024
    && !/[\u0000-\u001f\u007f\\]/u.test(path) && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function sameSources(left: readonly OutputSource[], right: readonly OutputSource[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const current = right[index];
    return current !== undefined && source.kind === current.kind && source.id === current.id && source.revision === current.revision
      && source.parentSessionId === current.parentSessionId && source.sessionId === current.sessionId && source.execution === current.execution
      && source.sessionGeneration === current.sessionGeneration
      && source.runIds.length === current.runIds.length && source.runIds.every((runId, ordinal) => runId === current.runIds[ordinal]);
  });
}
