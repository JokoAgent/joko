import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore } from "@joko/store";
import type { PartnerGroupPlan, PartnerGroupRecord } from "@joko/core";
import { PartnerGroupWorkspaces } from "./partner-group-workspaces.js";
import { partnerGroupFolderPath } from "./partner-group-work-dir.js";

const execute = promisify(execFile), cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-group-workspaces-")), data = join(root, "data"), project = join(root, "project");
  await mkdir(project); await mkdir(data); const store = new OperationalStore(join(data, "operations.db"));
  let work = new PartnerGroupWorkspaces(store, data); await work.initialize();
  cleanups.push(async () => { work.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  const group: PartnerGroupRecord = { id: "group-files", revision: 1, name: "Work", replyMode: "all", speakingMode: "auto", organizerPartnerId: null,
    projectDir: null, lifecycle: "active", memberIds: ["one", "two"], createdAt: 1, updatedAt: 1 };
  const plan: PartnerGroupPlan = { id: "plan-original", groupId: group.id, revision: 1, status: "running", requestText: "Build", attachments: [], organizerPartnerId: "one",
    organizerName: "One", steps: [{ position: 0, partnerId: "one", partnerName: "One", task: "Build", status: "running", resultMessageId: null, startedAt: 1, finishedAt: null }],
    currentStep: 0, workDir: null, branch: null, createdAt: 1, updatedAt: 1 };
  return { root, data, project, store, get work() { return work; }, group, plan, async reopen() { work.dispose(); work = new PartnerGroupWorkspaces(store, data); await work.initialize(); } };
}
describe("Partner group approved work directories", () => {
  it("keeps one real git worktree per plan, finds committed handoffs and retains it after group trash and restart", async () => {
    const f = await fixture(), git = (args: string[], cwd = f.project) => execute("git", args, { cwd, windowsHide: true });
    await git(["init"]); await writeFile(join(f.project, "initial.txt"), "Original"); await git(["add", "."]);
    await git(["-c", "user.name=Group Test", "-c", "user.email=group-test@invalid.example", "commit", "-m", "Initial"]);
    const projectDir = await f.work.validateProject(f.project), group = { ...f.group, projectDir };
    const location = await f.work.prepare(group, f.plan, () => undefined); expect(location.path).not.toBe(projectDir); expect(location.branch).toBeTruthy();
    const saved = { ...f.plan, workDir: location.path, branch: location.branch }, before = await f.work.snapshot(location.path);
    await writeFile(join(location.path, "result.txt"), "Result"); await git(["add", "."], location.path);
    await git(["-c", "user.name=Group Test", "-c", "user.email=group-test@invalid.example", "commit", "-m", "Result"], location.path);
    expect(await f.work.changedFiles(location.path, before)).toContain("result.txt");
    const folder = partnerGroupFolderPath(await realpath(f.data), group.id); await mkdir(folder, { recursive: true }); await f.work.trashGroup(group.id);
    expect(await stat(folder).then(() => true, () => false)).toBe(false); expect((await stat(location.path)).isDirectory()).toBe(true);
    await f.reopen(); expect(await f.work.prepare({ ...group, projectDir: null }, saved, () => undefined)).toEqual(location);
    await git(["switch", "-c", "unapproved-branch"], location.path);
    await expect(f.work.prepare(group, saved, () => undefined)).rejects.toThrow("approved group working directory");
    expect((await git(["status", "--porcelain"], f.project)).stdout).toBe("");
  });
  it("uses an approved ordinary directory, trashes owned files recoverably and refuses a missing saved directory", async () => {
    const f = await fixture(), projectDir = await f.work.validateProject(f.project);
    const ordinary = await f.work.prepare({ ...f.group, projectDir }, f.plan, () => undefined); expect(ordinary).toEqual({ path: projectDir, branch: null });
    const owned = await f.work.prepare(f.group, { ...f.plan, id: "plan-owned" }, () => undefined);
    const before = await f.work.snapshot(owned.path); await writeFile(join(owned.path, "handoff.txt"), "Done");
    expect(await f.work.changedFiles(owned.path, before)).toEqual(["handoff.txt"]);
    await f.work.trashGroup(f.group.id); await f.work.trashGroup(f.group.id);
    await expect(f.work.prepare(f.group, { ...f.plan, workDir: owned.path }, () => undefined)).rejects.toThrow();
  });
});
