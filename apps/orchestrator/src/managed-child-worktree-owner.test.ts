import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AdapterContext } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedChildWorktreeOwner } from "./managed-child-worktree-owner.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-private-child-")); roots.push(root);
  const repository = join(root, "repository"); await mkdir(repository);
  const git = async (...args: string[]) => execute("git", args, { cwd: repository, windowsHide: true });
  await git("init"); await git("config", "user.name", "Joko Test"); await git("config", "user.email", "test@invalid.example"); await git("config", "core.autocrlf", "false");
  await writeFile(join(repository, "main.txt"), "root\n"); await git("add", "main.txt"); await git("commit", "-m", "initial");
  const settings = new Map<string, unknown>();
  const target = { id: "target", backendId: "backend", workspaceRoot: repository, displayName: "Project", managed: true, trusted: true };
  const binding = { opaqueRef: "root-native", nativeSessionId: "root-native-session", generation: 3 };
  const session = { id: "session", backendId: "backend", targetId: target.id, binding };
  const queue = { id: "queue", sessionId: session.id, operationId: "operation", backendInstanceGeneration: 7 };
  const store = {
    getSession: () => ({ descriptor: session }), getTarget: () => ({ descriptor: target, revision: 4n }),
    getQueueItem: () => queue, listQueueItems: () => [queue], getOperation: () => ({ id: "operation" }),
    listSettings: () => [...settings].map(([key, value]) => ({ key, value })),
    findSetting: (_scope: string, _id: string, key: string) => settings.has(key) ? { value: settings.get(key) } : undefined,
    getSetting: (_scope: string, _id: string, key: string) => ({ value: settings.get(key) }),
    setSetting: (_scope: string, _id: string, key: string, value: unknown) => { settings.set(key, value); }
  } as unknown as OperationalStore;
  const coordinator = { effectiveTarget: () => target } as unknown as SessionWorktreeCoordinator;
  const options = { store, worktrees: () => coordinator, storageRoot: join(root, "child-workspaces"), currentBackend: () => ({ generation: 7, available: true }) };
  const owner = new ManagedChildWorktreeOwner(options); await owner.initialize();
  const context = { sessionId: session.id, generation: 3, backendInstanceGeneration: 7, operationId: "operation", target, binding } as AdapterContext;
  const prepare = (childTaskId: string, sourceWorkspaceRoot = repository, parentWorkspaceTaskId?: string) => owner.prepare({
    context, childTaskId, childSessionId: `native-${childTaskId}`, sourceWorkspaceRoot,
    ...(parentWorkspaceTaskId === undefined ? {} : { parentWorkspaceTaskId, parentTaskId: parentWorkspaceTaskId }), signal: new AbortController().signal
  });
  return { owner, options, prepare, repository, settings };
}

describe("private managed child checkout ownership", () => {
  it("derives a nested checkout from its exact isolated ancestor and retains changed output after writer retirement", async () => {
    const f = await fixture();
    const parent = await f.prepare("parent-task");
    await writeFile(join(parent.workspaceRoot, "parent-output.txt"), "parent result\n");
    const child = await f.prepare("child-task", parent.workspaceRoot, "parent-task");
    expect(child.workspaceRoot).not.toBe(parent.workspaceRoot);
    expect(await readFile(join(child.workspaceRoot, "parent-output.txt"), "utf8")).toBe("parent result\n");
    await child.verify(new AbortController().signal);
    expect(await child.release({ writerRetired: true })).toBe("preserved");
    expect(await parent.release({ writerRetired: true })).toBe("preserved");
    expect([...f.settings.values()].every(value => (value as { state: string }).state === "preserved")).toBe(true);
    f.owner.close();
  }, 60_000);

  it("keeps an unconfirmed native writer through owner restart and releases only an exact clean retirement", async () => {
    const f = await fixture();
    const child = await f.prepare("active-task");
    const restarted = new ManagedChildWorktreeOwner(f.options); await restarted.initialize();
    expect(await readFile(join(child.workspaceRoot, "main.txt"), "utf8")).toBe("root\n");
    expect([...f.settings.values()].some(value => (value as { writerRetired: boolean }).writerRetired)).toBe(false);
    expect(await child.release({ writerRetired: true })).toBe("released");
    expect([...f.settings.values()].some(value => (value as { state: string }).state === "released")).toBe(true);
    restarted.close(); f.owner.close();
  });
});
