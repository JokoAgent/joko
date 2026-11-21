import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create, extract, list } from "tar";
import { StoreError, type ConnectionRecord, type OperationalStore } from "@joko/store";
import { workerSystemPrompt } from "./collaboration-goal-manager.js";

const manifestName = "task-copy.json";
const validPart = /^(?:workspace-[0-9]{1,3}\.tar\.gz|worker-[0-9]{1,3}\.jshare)$/u;
const maximumWorkers = 128;
const maximumManifestBytes = 20 * 1024 * 1024;
const backendIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface CopiedWorker {
  readonly workspace: number;
  readonly backendId: string;
  readonly managed: boolean;
  readonly parent?: number;
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
  readonly status: "idle" | "completed" | "failed" | "stopped" | "archived";
}

export interface CopiedGoal {
  readonly title: string;
  readonly objective: string;
  readonly maximumWorkers?: number;
  readonly workers: readonly CopiedWorker[];
}

export interface TaskCopyLayout {
  readonly format: 1;
  readonly workspaces: number;
  readonly goal?: CopiedGoal;
}

export interface StagedTaskCopyWorker extends CopiedWorker { readonly operationId: string; readonly sessionId: string }
export type StagedTaskCopyGoal = Omit<CopiedGoal, "workers"> & { readonly workers: readonly StagedTaskCopyWorker[] };
export type TaskCopyImportRole = { readonly kind: "worker" } | { readonly kind: "lead"; readonly goal: StagedTaskCopyGoal };

export function taskCopyWorkspaceName(index: number): string { return `workspace-${index}.tar.gz`; }
export function taskCopyWorkerName(index: number): string { return `worker-${index}.jshare`; }

function parts(layout: TaskCopyLayout): string[] {
  return [
    manifestName,
    ...Array.from({ length: layout.workspaces }, (_, i) => taskCopyWorkspaceName(i)),
    ...(layout.goal?.workers.map((_, i) => taskCopyWorkerName(i)) ?? [])
  ];
}

export async function packageTaskCopyLayout(root: string, layout: TaskCopyLayout): Promise<string> {
  const archive = join(root, "copy.tar");
  await writeFile(join(root, manifestName), JSON.stringify(layout), { flag: "wx", mode: 0o600 });
  await create({ cwd: root, file: archive, portable: true, noMtime: true, strict: true }, parts(layout));
  return archive;
}

export async function unpackTaskCopyLayout(archive: string, root: string, maximum: number, check: () => void): Promise<TaskCopyLayout> {
  const seen = new Map<string, number>();
  let bytes = 0;
  await list({ file: archive, strict: true, onReadEntry(entry) {
    check();
    const { path, size, type } = entry;
    if (type !== "File" || seen.has(path) || !Number.isSafeInteger(size) || size < 1 || (bytes += size) > maximum
      || seen.size >= maximumWorkers * 2 + 2 || (path === manifestName ? size > maximumManifestBytes : !validPart.test(path))) throw invalid();
    seen.set(path, size);
  } });
  if (!seen.has(manifestName)) throw invalid();
  await extract({ cwd: root, file: archive, strict: true, preservePaths: false, noMtime: true, filter(path, entry) {
    check();
    if (!("type" in entry) || entry.type !== "File" || seen.get(path) !== entry.size) throw invalid();
    return true;
  } });
  const layout = parseLayout(JSON.parse(await readFile(join(root, manifestName), "utf8")));
  const expected = parts(layout);
  if (expected.length !== seen.size || expected.some(name => !seen.has(name))) throw invalid();
  return layout;
}

function parseLayout(value: unknown): TaskCopyLayout {
  const input = record(value);
  if (!input || input["format"] !== 1 || !integer(input["workspaces"], 1, maximumWorkers + 1)) throw invalid();
  const workspaces = input["workspaces"];
  if (input["goal"] === undefined && workspaces === 1) return { format: 1, workspaces };
  const raw = record(input["goal"]);
  if (!raw || !boundedText(raw["title"], 256) || !boundedText(raw["objective"], 32_000)
    || (raw["maximumWorkers"] !== undefined && !integer(raw["maximumWorkers"], 1, maximumWorkers))
    || !Array.isArray(raw["workers"]) || raw["workers"].length > maximumWorkers
    || workspaces > raw["workers"].length + 1) throw invalid();
  const usedWorkspaces = new Set([0]);
  const workers = raw["workers"].map((value, index): CopiedWorker => {
    const worker = record(value);
    if (!worker || !integer(worker["workspace"], 0, workspaces - 1) || !boundedText(worker["backendId"], 256)
      || !backendIdPattern.test(worker["backendId"]) || typeof worker["managed"] !== "boolean"
      || (worker["parent"] !== undefined && !integer(worker["parent"], 0, index - 1))
      || !boundedText(worker["label"], 64) || !boundedText(worker["role"], 128) || !boundedText(worker["assignment"], 32_000, true)
      || !copyableWorkerStatus(worker["status"])) throw invalid();
    usedWorkspaces.add(worker["workspace"]);
    return { workspace: worker["workspace"], backendId: worker["backendId"], managed: worker["managed"], parent: worker["parent"], label: worker["label"],
      role: worker["role"], assignment: worker["assignment"], status: worker["status"] };
  });
  if (usedWorkspaces.size !== workspaces) throw invalid();
  return { format: 1, workspaces, goal: { title: raw["title"], objective: raw["objective"], maximumWorkers: raw["maximumWorkers"], workers } };
}

export function copyableWorkerStatus(value: unknown): value is CopiedWorker["status"] {
  return value === "idle" || value === "completed" || value === "failed" || value === "stopped" || value === "archived";
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function boundedText(input: unknown, maximum: number, empty = false): input is string {
  return typeof input === "string" && (empty || input.trim().length > 0) && [...input].length <= maximum && !input.includes("\0");
}

function integer(input: unknown, minimum: number, maximum: number): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= minimum && input <= maximum;
}

function invalid(): StoreError { return new StoreError("The task copy workspace and worker layout is invalid."); }

/** Publish all copied members in the same Store transaction as the new lead. */
export function publishTaskCopyGoal(store: OperationalStore, connection: ConnectionRecord, leadSessionId: string,
  originalOperationId: string, source: StagedTaskCopyGoal): number {
  const goalId = `task-copy-goal-${originalOperationId}`;
  const goal = store.createCollaborationGoal({ id: goalId, leadSessionId, title: source.title, objective: source.objective, maximumWorkers: source.maximumWorkers });
  const workers: string[] = [];
  const archived: { readonly id: string; readonly sessionId: string }[] = [];
  for (const [index, copied] of source.workers.entries()) {
    const session = store.getSession(copied.sessionId);
    const descriptor = session.descriptor;
    const imported = store.getOperation<{ readonly sessionId?: string }>(copied.operationId);
    if (imported.kind !== "import_portable_session" || imported.connectionId !== connection.id
      || imported.status !== "completed" || imported.response?.sessionId !== descriptor.id
      || !descriptor.hidden || descriptor.archived || descriptor.deletedAt !== undefined) throw invalid();
    const id = `${goalId}-worker-${index}`, operationId = `${copied.operationId}-bind`;
    store.runOperation({ id: operationId, connectionId: connection.id, kind: "bind_copied_collaboration_worker",
      body: { goalId, id, importOperationId: copied.operationId, sessionId: descriptor.id, assignment: "" } }, current => {
      const reserved = current.reserveCollaborationWorker({
        id, goalId, callerLeadSessionId: leadSessionId, expectedGoalRevision: current.getCollaborationGoal(goalId).revision,
        createOperationId: operationId, backendId: descriptor.backendId, targetId: descriptor.targetId, parentWorkerId: copied.parent === undefined ? undefined : workers[copied.parent],
        label: copied.label, role: copied.role, assignment: copied.assignment, providerId: descriptor.providerId, modelId: descriptor.modelId,
        effort: descriptor.effort, fastMode: descriptor.fastMode, permissionMode: descriptor.permissionMode, planMode: descriptor.planMode,
        softLimit: 128, hardLimit: 128, goalLimitCountsRuntimes: true
      });
      const bound = current.bindCollaborationWorkerSession({
        workerId: reserved.id, callerLeadSessionId: leadSessionId, expectedRevision: reserved.revision, sessionId: descriptor.id,
        expectedSessionGeneration: descriptor.binding.generation, expectedBackendInstanceGeneration: current.getBackend(descriptor.backendId).descriptor.instanceGeneration
      });
      current.updateCollaborationWorkerState({
        workerId: bound.id, callerLeadSessionId: leadSessionId, expectedRevision: bound.revision,
        status: copied.status === "archived" ? "stopped" : copied.status, runtimeReleased: true
      });
      const visible = current.updateSession(descriptor.id, { hidden: false }, session.revision);
      current.updateSessionPrivatePrompt(descriptor.id, workerSystemPrompt(goal, bound).slice(0, 8_000), visible.revision);
      return { workerId: id };
    });
    workers.push(id);
    if (copied.status === "archived") archived.push({ id, sessionId: descriptor.id });
  }
  // Even an archived parent must be visible while its children are linked.
  for (const copied of archived) {
    const worker = store.getCollaborationWorker(copied.id);
    store.updateCollaborationWorkerState({ workerId: worker.id, expectedRevision: worker.revision, status: "archived", runtimeReleased: true });
    store.updateSession(copied.sessionId, { archived: true });
  }
  return workers.length;
}
