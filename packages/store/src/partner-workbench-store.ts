import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  PARTNER_WORKBENCH_MAX_JUDGMENTS,
  PARTNER_WORKBENCH_MAX_PROJECTS,
  PARTNER_WORKBENCH_NEXT_MAX,
  PARTNER_WORKBENCH_REF_MAX,
  PARTNER_WORKBENCH_TASK_ID_MAX,
  PARTNER_WORKBENCH_TITLE_MAX,
  boundPartnerWorkbenchJudgments,
  type PartnerWorkbenchJudgment,
  type PartnerWorkbenchProject,
  type PartnerWorkbenchState
} from "@joko/core";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_PATH = 32_768;
const MAX_REVISION = BigInt(Number.MAX_SAFE_INTEGER);
const PARTNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export class PartnerWorkbenchStoreError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "resource_exhausted" | "not_found" | "unavailable", message: string) {
    super(message);
    this.name = "PartnerWorkbenchStoreError";
  }
}

/** One current-v1 file in the existing managed Partner home. Runtime task states
 * are projections and are deliberately absent from this durable authority. */
export class PartnerWorkbenchStore {
  readonly #homesRoot: string;
  readonly #now: () => number;
  readonly #writes = new Map<string, Promise<unknown>>();

  constructor(homesRoot: string, options: { readonly now?: () => number } = {}) {
    this.#homesRoot = resolve(homesRoot);
    this.#now = options.now ?? Date.now;
  }

  async read(partnerId: string): Promise<PartnerWorkbenchState> {
    partnerHomeDirectoryName(partnerId);
    try {
      const file = await this.#file(partnerId);
      await this.#checkHome(partnerId);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATE_BYTES) throw invalidState();
      const handle = await open(file, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_STATE_BYTES) throw invalidState();
        const buffer = Buffer.alloc(opened.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset > opened.size) throw invalidState();
        return parseState(buffer.subarray(0, offset).toString("utf8"), partnerId);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { partnerId, revision: 1n, projects: [], judgments: [] };
      throw error;
    }
  }

  addProject(partnerId: string, expectedRevision: bigint, project: string): Promise<PartnerWorkbenchState> {
    const path = projectPath(project);
    return this.#mutate(partnerId, expectedRevision, (state) => {
      const rest = state.projects.filter((entry) => entry.path !== path);
      if (rest.length >= PARTNER_WORKBENCH_MAX_PROJECTS) throw new PartnerWorkbenchStoreError("resource_exhausted", "The workbench project limit has been reached.");
      return { ...state, projects: [{ path, addedAt: timestamp(this.#now()) }, ...rest] };
    });
  }

  removeProject(partnerId: string, expectedRevision: bigint, project: string): Promise<PartnerWorkbenchState> {
    const path = projectPath(project);
    return this.#mutate(partnerId, expectedRevision, (state) => {
      if (!state.projects.some((entry) => entry.path === path)) throw new PartnerWorkbenchStoreError("not_found", "The project is no longer in this workbench.");
      return { ...state, projects: state.projects.filter((entry) => entry.path !== path) };
    });
  }

  setJudgment(partnerId: string, expectedRevision: bigint, input: Omit<PartnerWorkbenchJudgment, "updatedAt">): Promise<PartnerWorkbenchState> {
    const judgment = parseJudgment({ ...input, updatedAt: timestamp(this.#now()) });
    return this.#mutate(partnerId, expectedRevision, (state) => {
      if (!state.projects.some((entry) => entry.path === judgment.project)) throw new PartnerWorkbenchStoreError("not_found", "The judgment project is no longer granted.");
      return { ...state, judgments: boundPartnerWorkbenchJudgments([...state.judgments.filter((entry) => entry.taskId !== judgment.taskId), judgment]) };
    });
  }

  deleteJudgment(partnerId: string, expectedRevision: bigint, taskId: string): Promise<PartnerWorkbenchState> {
    const id = text(taskId, PARTNER_WORKBENCH_TASK_ID_MAX);
    return this.#mutate(partnerId, expectedRevision, (state) => ({ ...state, judgments: state.judgments.filter((entry) => entry.taskId !== id) }));
  }

  rekeyJudgment(partnerId: string, expectedRevision: bigint, fromTaskId: string, toTaskId: string): Promise<PartnerWorkbenchState> {
    const from = text(fromTaskId, PARTNER_WORKBENCH_TASK_ID_MAX);
    const to = text(toTaskId, PARTNER_WORKBENCH_TASK_ID_MAX);
    return this.#mutate(partnerId, expectedRevision, (state) => {
      const previous = state.judgments.find((entry) => entry.taskId === from);
      if (previous === undefined || from === to) return state;
      return { ...state, judgments: [...state.judgments.filter((entry) => entry.taskId !== from && entry.taskId !== to), { ...previous, taskId: to }] };
    });
  }

  async #file(partnerId: string): Promise<string> {
    return join(await realpath(this.#homesRoot), partnerHomeDirectoryName(partnerId), "workbench.json");
  }

  async #checkHome(partnerId: string): Promise<void> {
    const root = await realpath(this.#homesRoot);
    for (const directory of [root, join(root, partnerHomeDirectoryName(partnerId))]) {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PartnerWorkbenchStoreError("unavailable", "The managed partner home is unavailable.");
    }
  }

  #mutate(partnerId: string, expectedRevision: bigint, change: (state: PartnerWorkbenchState) => PartnerWorkbenchState): Promise<PartnerWorkbenchState> {
    partnerHomeDirectoryName(partnerId);
    if (expectedRevision < 1n || expectedRevision >= MAX_REVISION) return Promise.reject(new PartnerWorkbenchStoreError("invalid", "A valid workbench revision is required."));
    const run = (this.#writes.get(partnerId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const current = await this.read(partnerId);
      if (current.revision !== expectedRevision) throw new PartnerWorkbenchStoreError("conflict", "The workbench changed. Reload its current revision.");
      const next = { ...change(current), revision: current.revision + 1n };
      await this.#write(next);
      return next;
    });
    this.#writes.set(partnerId, run);
    void run.finally(() => { if (this.#writes.get(partnerId) === run) this.#writes.delete(partnerId); }).catch(() => undefined);
    return run;
  }

  async #write(state: PartnerWorkbenchState): Promise<void> {
    await this.#checkHome(state.partnerId);
    const target = await this.#file(state.partnerId);
    const bytes = JSON.stringify({ version: 1, partnerId: state.partnerId, revision: Number(state.revision), projects: state.projects, judgments: state.judgments });
    if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new PartnerWorkbenchStoreError("resource_exhausted", "The workbench exceeds its storage budget.");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${bytes}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function parseState(raw: string, partnerId: string): PartnerWorkbenchState {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalidState(); }
  if (!record(value) || !keys(value, ["version", "partnerId", "revision", "projects", "judgments"]) || value.version !== 1 || value.partnerId !== partnerId
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Array.isArray(value.projects) || value.projects.length > PARTNER_WORKBENCH_MAX_PROJECTS
    || !Array.isArray(value.judgments) || value.judgments.length > PARTNER_WORKBENCH_MAX_JUDGMENTS) throw invalidState();
  const projects: PartnerWorkbenchProject[] = value.projects.map((entry: unknown) => {
    if (!record(entry) || !keys(entry, ["path", "addedAt"])) throw invalidState();
    return { path: projectPath(entry.path), addedAt: timestamp(entry.addedAt) };
  });
  const judgments = value.judgments.map(parseJudgment);
  if (new Set(projects.map((entry) => entry.path)).size !== projects.length || new Set(judgments.map((entry) => entry.taskId)).size !== judgments.length) throw invalidState();
  return { partnerId, revision: BigInt(value.revision), projects, judgments };
}

function parseJudgment(value: unknown): PartnerWorkbenchJudgment {
  if (!record(value) || !keys(value, ["taskId", "project", "title", "verdict", "next", "updatedAt"], ["ref"])
    || typeof value.verdict !== "string" || !["unfinished", "idea", "done"].includes(value.verdict)) throw invalidState();
  const next = value.next === null ? null : text(value.next, PARTNER_WORKBENCH_NEXT_MAX);
  if (value.verdict !== "done" && next === null) throw new PartnerWorkbenchStoreError("invalid", "An unfinished judgment requires a next step.");
  return {
    taskId: text(value.taskId, PARTNER_WORKBENCH_TASK_ID_MAX), project: projectPath(value.project),
    title: text(value.title, PARTNER_WORKBENCH_TITLE_MAX), verdict: value.verdict as PartnerWorkbenchJudgment["verdict"], next,
    ...(value.ref === undefined ? {} : { ref: text(value.ref, PARTNER_WORKBENCH_REF_MAX) }), updatedAt: timestamp(value.updatedAt)
  };
}

function projectPath(value: unknown): string {
  const path = text(value, MAX_PATH);
  if (!isAbsolute(path) || resolve(path) !== path) throw new PartnerWorkbenchStoreError("invalid", "A resolved absolute project directory is required.");
  return path;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidState();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value || CONTROL.test(value)) throw invalidState();
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function invalidState(): PartnerWorkbenchStoreError { return new PartnerWorkbenchStoreError("invalid", "The workbench must use the current state format."); }

export function partnerHomeDirectoryName(partnerId: string): string {
  if (!PARTNER_ID.test(partnerId)) throw invalidState();
  return `partner-${createHash("sha256").update(partnerId, "utf8").digest("hex").slice(0, 32)}`;
}
