import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PartnerGroupPlan, PartnerGroupRecord } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { EphemeralWorktreeService } from "@joko/worktree";
import type { PartnerGroupWorkDirectories } from "./partner-group-manager.js";
import { createPartnerGroupWorkDir, partnerGroupFolderPath } from "./partner-group-work-dir.js";
import { checkPartnerWorkbenchProject } from "./partner-workbench-project.js";
import { moveManagedWorkspaceToTrash } from "./managed-workspace-trash.js";

const SCOPE = "partner-group-worktrees", execute = promisify(execFile);
interface WorktreeOwner { readonly version: 1; readonly groupId: string; readonly planId: string; readonly projectDir: string;
  readonly phase: "preparing" | "ready"; readonly path?: string; readonly branch?: string; readonly leaseId?: string; }

/** One approved plan owns one original Worktree service lease, retained after group deletion. */
export class PartnerGroupWorkspaces implements PartnerGroupWorkDirectories {
  readonly #worktrees: EphemeralWorktreeService;
  #root: string | undefined;
  constructor(readonly store: OperationalStore, readonly dataDirectory: string) {
    this.#worktrees = new EphemeralWorktreeService({ storageRoot: join(dataDirectory, "group-worktrees") });
  }
  async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true }); this.#root = await realpath(this.dataDirectory);
    const owners = this.store.listSettings("service").filter(setting => setting.scopeId === SCOPE);
    const retained = owners.map(owner => { readOwner(owner.value); return owner.key; });
    const result = await this.#worktrees.initialize({ retainSessionIds: retained });
    if (!result.ok) throw unavailable();
  }
  async validateProject(path: string): Promise<string> {
    await checkPartnerWorkbenchProject(path, { managedDataDirectory: this.dataDirectory, homeDirectory: homedir(), caseInsensitive: process.platform !== "linux" });
    const canonical = await realpath(path), info = await lstat(canonical); if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable(); return canonical;
  }
  #helpers(plan?: PartnerGroupPlan) {
    return createPartnerGroupWorkDir({ ownerRoot: () => this.#root ?? (() => { throw unavailable(); })(),
      detectRepo: async directory => {
        const result = await this.#worktrees.detectCwd(directory);
        if (result.ok) return { gitInstalled: true, isGitRepo: true };
        if (result.error.code === "NOT_GIT_REPOSITORY") return { gitInstalled: true, isGitRepo: false };
        if (result.error.code === "GIT_NOT_FOUND") return { gitInstalled: false, isGitRepo: false };
        throw unavailable();
      },
      prepareWorktree: async projectDir => {
        if (!plan) throw unavailable(); const key = `group-plan:${plan.id}`;
        const existing = this.store.findSetting("service", SCOPE, key), saved = existing && readOwner(existing.value);
        if (saved && (saved.groupId !== plan.groupId || saved.planId !== plan.id || saved.projectDir !== projectDir)) throw unavailable();
        if (!saved) this.store.setSetting("service", SCOPE, key, { version: 1, groupId: plan.groupId, planId: plan.id, projectDir, phase: "preparing" } satisfies WorktreeOwner);
        const acquired = await this.#worktrees.acquire({ sessionId: key, cwd: projectDir, refreshRemote: false });
        if (!acquired.ok) return { ok: false, message: "The plan worktree could not be prepared." };
        const lease = acquired.value.lease;
        this.store.setSetting("service", SCOPE, key, { version: 1, groupId: plan.groupId, planId: plan.id, projectDir,
          phase: "ready", path: lease.path, branch: lease.branch, leaseId: lease.id } satisfies WorktreeOwner);
        return { ok: true, sessionId: key, workingDir: lease.path, branch: lease.branch };
      },
      git: async (args, cwd) => (await execute("git", [...args], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout,
      trashItem: async fullPath => { await moveManagedWorkspaceToTrash({ managedRoot: this.#root!, workspaceRoot: fullPath, targetId: `group:${plan?.groupId ?? "files"}`, operationId: `group-trash:${fullPath}` }); }
    });
  }
  async prepare(group: PartnerGroupRecord, plan: PartnerGroupPlan, assertCurrent: () => void): Promise<{ readonly path: string; readonly branch: string | null }> {
    assertCurrent();
    if (plan.groupId !== group.id || !this.#root) throw unavailable();
    if (plan.workDir !== null) {
      const actual = await realpath(plan.workDir); assertCurrent();
      const info = await lstat(actual); if (actual !== plan.workDir || !info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      if (plan.branch !== null) {
        const saved = this.store.findSetting("service", SCOPE, `group-plan:${plan.id}`), owner = saved && readOwner(saved.value);
        if (owner?.phase !== "ready" || owner.path !== actual || owner.branch !== plan.branch || !owner.leaseId) throw unavailable();
        const preview = await this.#worktrees.previewRemoval({ sessionId: `group-plan:${plan.id}`, leaseId: owner.leaseId });
        assertCurrent(); if (!preview.ok || preview.value.state !== "active") throw unavailable();
        const branch = (await execute("git", ["symbolic-ref", "--short", "HEAD"], { cwd: actual, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
        assertCurrent(); if (branch !== plan.branch) throw unavailable();
      }
      return { path: actual, branch: plan.branch };
    }
    const prepared = await this.#helpers(plan).prepare({ groupId: group.id, projectDir: group.projectDir }); assertCurrent();
    if (!prepared.ok) throw unavailable();
    const path = await realpath(prepared.workDir); assertCurrent(); return { path, branch: prepared.branch };
  }
  snapshot(path: string): Promise<ReadonlyMap<string, string>> { return this.#helpers().snapshot(path); }
  changedFiles(path: string, before: ReadonlyMap<string, string>): Promise<readonly string[]> { return this.#helpers().changedFiles(path, new Map(before)); }
  async trashGroup(groupId: string): Promise<void> {
    if (!this.#root) throw unavailable(); const folder = dirname(partnerGroupFolderPath(this.#root, groupId));
    const exists = await lstat(folder).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!exists) return;
    await moveManagedWorkspaceToTrash({ managedRoot: this.#root, workspaceRoot: folder, targetId: groupId, operationId: `group-trash:${groupId}` });
  }
  dispose(): void { this.#worktrees.dispose(); }
}
function unavailable(): Error { return new Error("The approved group working directory is unavailable."); }
function readOwner(value: unknown): WorktreeOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable(); const row = value as Record<string, unknown>;
  if (row.version !== 1 || ["groupId", "planId", "projectDir"].some(key => typeof row[key] !== "string" || !row[key])
    || !["preparing", "ready"].includes(String(row.phase)) || Object.keys(row).some(key => !["version", "groupId", "planId", "projectDir", "phase", "path", "branch", "leaseId"].includes(key))
    || row.phase === "ready" && ["path", "branch", "leaseId"].some(key => typeof row[key] !== "string" || !row[key])) throw unavailable();
  return value as WorktreeOwner;
}
