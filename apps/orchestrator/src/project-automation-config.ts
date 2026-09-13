import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  ScheduleInputSchema,
  ScheduleSessionMode,
  type ScheduleInput
} from "@joko/contracts";
import { redactSecrets } from "@joko/core";
import type {
  OperationalStore,
  ScheduleRecord,
  UpsertScheduleInput
} from "@joko/store";

export const PROJECT_AUTOMATION_CONFIG_PATH = ".joko/automations/schedules.json";
const PROJECT_AUTOMATION_SEGMENTS = [".joko", "automations", "schedules.json"] as const;
const PROJECT_AUTOMATION_SNAPSHOT_KEY = "projectAutomation";
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const MAXIMUM_PROJECT_SCHEDULES = 1_000;
const PROJECT_CONFIG_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export interface ProjectAutomationEntry {
  readonly id: string;
  readonly schedule: ScheduleInput;
}

export interface ProjectAutomationOrigin {
  readonly targetId: string;
  readonly configId: string;
}

export interface ProjectAutomationReconcileResult {
  readonly targetId: string;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: "missing" | "invalid" | null;
}

export type ProjectScheduleMaterializer = (
  id: string,
  input: ScheduleInput,
  at: number,
  existing?: ScheduleRecord
) => UpsertScheduleInput;

type LoadedProjectAutomationConfig =
  | { readonly kind: "loaded"; readonly entries: readonly ProjectAutomationEntry[] }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string };

/** Owns the checked-in project Schedule file and its durable Store projection. */
export class ProjectAutomationConfigController {
  readonly #store: OperationalStore;
  readonly #now: () => number;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly store: OperationalStore; readonly now?: () => number }) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  async reconcileAll(materialize: ProjectScheduleMaterializer): Promise<readonly ProjectAutomationReconcileResult[]> {
    const results: ProjectAutomationReconcileResult[] = [];
    for (const target of this.#store.listTargets()) {
      if (target.descriptor.managed || target.descriptor.remoteWorkspace !== undefined) continue;
      results.push(await this.reconcileTarget(target.descriptor.id, materialize));
    }
    return results;
  }

  async reconcileTarget(
    targetId: string,
    materialize: ProjectScheduleMaterializer
  ): Promise<ProjectAutomationReconcileResult> {
    return this.#serializedWrite(() => this.#reconcileTarget(targetId, materialize));
  }

  async #reconcileTarget(
    targetId: string,
    materialize: ProjectScheduleMaterializer
  ): Promise<ProjectAutomationReconcileResult> {
    const target = this.#projectTarget(targetId);
    const read = await this.#read(target.descriptor.workspaceRoot);
    const current = this.#projectSchedules(targetId);
    if (read.kind !== "loaded") {
      for (const schedule of current) this.#store.deleteSchedule(schedule.id, schedule.revision);
      return {
        targetId,
        inserted: 0,
        updated: 0,
        deleted: current.length,
        skipped: read.kind
      };
    }

    const byConfigId = new Map(current.map((schedule) => [scheduleProjectAutomationOrigin(schedule.executionSnapshot)!.configId, schedule]));
    const desiredIds = new Set(read.entries.map((entry) => entry.id));
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    const at = this.#now();

    for (const entry of read.entries) {
      const existing = byConfigId.get(entry.id);
      const normalized = projectScheduleInput(entry.schedule, target.descriptor.backendId, targetId, existing?.enabled);
      const candidate = materialize(projectScheduleId(targetId, entry.id), normalized, at, existing);
      const withOrigin: UpsertScheduleInput = {
        ...candidate,
        executionSnapshot: withScheduleProjectAutomationOrigin(candidate.executionSnapshot, { targetId, configId: entry.id }),
        ...(existing === undefined ? {} : { expectedRevision: existing.revision })
      };
      if (existing === undefined) {
        this.#store.upsertSchedule(withOrigin);
        inserted += 1;
      } else if (!sameProjectSchedule(existing, withOrigin)) {
        this.#store.upsertSchedule(withOrigin);
        updated += 1;
      }
    }

    for (const schedule of current) {
      const origin = scheduleProjectAutomationOrigin(schedule.executionSnapshot)!;
      if (desiredIds.has(origin.configId)) continue;
      this.#store.deleteSchedule(schedule.id, schedule.revision);
      deleted += 1;
    }
    return { targetId, inserted, updated, deleted, skipped: null };
  }

  async upsert(targetId: string, configId: string, schedule: ScheduleInput): Promise<void> {
    await this.upsertWithCommit(targetId, configId, schedule, async () => undefined);
  }

  async upsertWithCommit<T>(
    targetId: string,
    configId: string,
    schedule: ScheduleInput,
    commit: () => Promise<T>
  ): Promise<T> {
    validateProjectConfigId(configId);
    const target = this.#projectTarget(targetId);
    const normalized = projectScheduleInput(schedule, target.descriptor.backendId, targetId);
    return this.#serializedWrite(async () => {
      const read = await this.#read(target.descriptor.workspaceRoot);
      if (read.kind === "invalid") throw new Error(`Project automation configuration is invalid: ${read.reason}`);
      const entries = read.kind === "loaded" ? read.entries : [];
      await this.#write(target.descriptor.workspaceRoot, [
        ...entries.filter((entry) => entry.id !== configId),
        { id: configId, schedule: normalized }
      ]);
      return this.#commitOrRestore(target.descriptor.workspaceRoot, read, commit);
    });
  }

  async remove(targetId: string, configId: string): Promise<void> {
    await this.removeWithCommit(targetId, configId, async () => undefined);
  }

  async removeWithCommit<T>(targetId: string, configId: string, commit: () => Promise<T>): Promise<T> {
    validateProjectConfigId(configId);
    const target = this.#projectTarget(targetId);
    return this.#serializedWrite(async () => {
      const read = await this.#read(target.descriptor.workspaceRoot);
      if (read.kind === "missing") return commit();
      if (read.kind === "invalid") throw new Error(`Project automation configuration is invalid: ${read.reason}`);
      await this.#write(
        target.descriptor.workspaceRoot,
        read.entries.filter((entry) => entry.id !== configId)
      );
      return this.#commitOrRestore(target.descriptor.workspaceRoot, read, commit);
    });
  }

  generateConfigId(name: string): string {
    const base = name.toLocaleLowerCase("en")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "automation";
    return `${base}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  }

  #projectTarget(targetId: string) {
    const target = this.#store.getTarget(targetId);
    if (target.descriptor.managed || target.descriptor.remoteWorkspace !== undefined) {
      throw new Error("Project automation configuration requires a local user-project Target.");
    }
    if (!isAbsolute(target.descriptor.workspaceRoot)) {
      throw new Error("Project automation Target workspace must be absolute.");
    }
    return target;
  }

  #projectSchedules(targetId: string): readonly ScheduleRecord[] {
    return this.#store.listSchedules({ targetId }).filter((schedule) => {
      const origin = scheduleProjectAutomationOrigin(schedule.executionSnapshot);
      return origin?.targetId === targetId;
    });
  }

  async #read(workspaceRoot: string): Promise<LoadedProjectAutomationConfig> {
    let paths: Awaited<ReturnType<typeof projectConfigPaths>>;
    try {
      paths = await projectConfigPaths(workspaceRoot, false);
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      return { kind: "invalid", reason: publicFailure(error) };
    }
    let info;
    try {
      info = await lstat(paths.file);
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      return { kind: "invalid", reason: publicFailure(error) };
    }
    if (!info.isFile() || info.isSymbolicLink()) return { kind: "invalid", reason: "schedules.json is not a regular file" };
    const size = (await stat(paths.file)).size;
    if (size > MAXIMUM_CONFIG_BYTES) return { kind: "invalid", reason: "schedules.json is too large" };
    try {
      const content = await readFile(paths.file, "utf8");
      if (redactSecrets(content) !== content) return { kind: "invalid", reason: "credential material is forbidden" };
      const parsed = JSON.parse(content) as unknown;
      return { kind: "loaded", entries: parseProjectAutomationFile(parsed) };
    } catch (error) {
      return { kind: "invalid", reason: publicFailure(error) };
    }
  }

  async #write(workspaceRoot: string, entries: readonly ProjectAutomationEntry[]): Promise<void> {
    const paths = await projectConfigPaths(workspaceRoot, true);
    const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id, "en"));
    const file = {
      version: 1,
      schedules: ordered.map((entry) => ({
        id: entry.id,
        schedule: toJson(ScheduleInputSchema, entry.schedule)
      }))
    };
    const content = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAXIMUM_CONFIG_BYTES) {
      throw new Error("Project automation configuration is too large.");
    }
    if (redactSecrets(content) !== content) {
      throw new Error("Project automation configuration cannot contain credential material.");
    }
    const temporary = join(paths.directory, `schedules.json.tmp.${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, paths.file);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #commitOrRestore<T>(
    workspaceRoot: string,
    previous: Exclude<LoadedProjectAutomationConfig, { readonly kind: "invalid" }>,
    commit: () => Promise<T>
  ): Promise<T> {
    try {
      return await commit();
    } catch (error) {
      try {
        if (previous.kind === "loaded") {
          await this.#write(workspaceRoot, previous.entries);
        } else {
          const paths = await projectConfigPaths(workspaceRoot, false);
          await rm(paths.file, { force: true });
        }
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "The durable operation failed and its project automation configuration could not be restored."
        );
      }
      throw error;
    }
  }

  async #serializedWrite<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#writeTail.then(action, action);
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function scheduleProjectAutomationOrigin(value: unknown): ProjectAutomationOrigin | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[PROJECT_AUTOMATION_SNAPSHOT_KEY];
  if (!isRecord(raw) || raw["format"] !== 1) return undefined;
  const targetId = raw["targetId"];
  const configId = raw["configId"];
  if (typeof targetId !== "string" || targetId.trim() === "" || typeof configId !== "string" || !PROJECT_CONFIG_ID.test(configId)) {
    return undefined;
  }
  return { targetId, configId };
}

export function withScheduleProjectAutomationOrigin(
  value: unknown,
  origin: ProjectAutomationOrigin
): Readonly<Record<string, unknown>> {
  validateProjectConfigId(origin.configId);
  if (origin.targetId.trim() === "") throw new Error("Project automation Target ID is required.");
  return {
    ...(isRecord(value) ? value : {}),
    [PROJECT_AUTOMATION_SNAPSHOT_KEY]: {
      format: 1,
      targetId: origin.targetId,
      configId: origin.configId
    }
  };
}

export function withoutScheduleProjectAutomationOrigin(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const { [PROJECT_AUTOMATION_SNAPSHOT_KEY]: _origin, ...rest } = value;
  return rest;
}

export function projectScheduleId(targetId: string, configId: string): string {
  validateProjectConfigId(configId);
  const digest = createHash("sha256").update(targetId).update("\0").update(configId).digest("hex").slice(0, 32);
  return `project-schedule-${digest}`;
}

function projectScheduleInput(
  input: ScheduleInput,
  backendId: string,
  targetId: string,
  enabled = true
): ScheduleInput {
  if (input.sessionMode === ScheduleSessionMode.BOUND || input.sessionId !== "") {
    throw new Error("Project automations cannot bind a specific product task.");
  }
  return create(ScheduleInputSchema, {
    ...input,
    backendId,
    targetId,
    sessionId: "",
    sessionMode: input.sessionMode === ScheduleSessionMode.PERSISTENT
      ? ScheduleSessionMode.PERSISTENT
      : ScheduleSessionMode.FRESH,
    enabled
  });
}

function parseProjectAutomationFile(value: unknown): readonly ProjectAutomationEntry[] {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["schedules"])) {
    throw new Error("Expected a version 1 project automation file.");
  }
  if (value["schedules"].length > MAXIMUM_PROJECT_SCHEDULES) {
    throw new Error("Project automation file has too many schedules.");
  }
  const ids = new Set<string>();
  return value["schedules"].map((raw) => {
    if (!isRecord(raw) || typeof raw["id"] !== "string") throw new Error("Project automation entry is invalid.");
    validateProjectConfigId(raw["id"]);
    if (ids.has(raw["id"])) throw new Error("Project automation IDs must be unique.");
    ids.add(raw["id"]);
    if (!("schedule" in raw)) throw new Error("Project automation entry has no Schedule.");
    const schedule = fromJson(ScheduleInputSchema, raw["schedule"] as JsonValue, { ignoreUnknownFields: false });
    return { id: raw["id"], schedule };
  });
}

async function projectConfigPaths(workspaceRoot: string, createDirectory: boolean): Promise<{
  readonly root: string;
  readonly directory: string;
  readonly file: string;
}> {
  const resolvedRoot = resolve(workspaceRoot);
  const root = await realpath(resolvedRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Project workspace is not a regular directory.");
  let directory = root;
  for (const segment of PROJECT_AUTOMATION_SEGMENTS.slice(0, -1)) {
    directory = join(directory, segment);
    if (createDirectory) await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project automation directory is unsafe.");
    const canonical = await realpath(directory);
    if (!isWithin(root, canonical)) throw new Error("Project automation directory escaped the workspace.");
    directory = canonical;
  }
  return { root, directory, file: join(directory, PROJECT_AUTOMATION_SEGMENTS.at(-1)!) };
}

function sameProjectSchedule(existing: ScheduleRecord, candidate: UpsertScheduleInput): boolean {
  return existing.backendId === candidate.backendId &&
    existing.targetId === candidate.targetId &&
    existing.sessionMode === candidate.sessionMode &&
    existing.sessionId === candidate.sessionId &&
    existing.name === candidate.name &&
    existing.kind === candidate.kind &&
    existing.expression === candidate.expression &&
    existing.anchorAt === candidate.anchorAt &&
    existing.timezone === candidate.timezone &&
    existing.enabled === candidate.enabled &&
    isDeepStrictEqual(existing.prompt, candidate.prompt) &&
    isDeepStrictEqual(existing.executionSnapshot, candidate.executionSnapshot) &&
    existing.overlapPolicy === candidate.overlapPolicy &&
    existing.misfirePolicy === candidate.misfirePolicy &&
    existing.nextRunAt === candidate.nextRunAt;
}

function validateProjectConfigId(value: string): void {
  if (!PROJECT_CONFIG_ID.test(value)) {
    throw new Error("Project automation ID must be lowercase kebab-case ASCII.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function publicFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return redactSecrets(message).slice(0, 512);
}
