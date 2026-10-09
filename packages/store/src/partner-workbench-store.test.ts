import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartnerWorkbenchStore, partnerHomeDirectoryName } from "./partner-workbench-store.js";

const atomicFailure = vi.hoisted(() => ({ destination: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: async (...args: Parameters<typeof original.rename>) => {
    if (args[1] === atomicFailure.destination) throw new Error("Fixture atomic replacement unavailable");
    return original.rename(...args);
  } };
});

const roots: string[] = [];
afterEach(() => { atomicFailure.destination = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-workbench-store-")); roots.push(root);
  const home = join(root, partnerHomeDirectoryName("owner")); mkdirSync(home);
  let now = 1;
  return { root, home, store: new PartnerWorkbenchStore(root, { now: () => now++ }) };
}

describe("current-v1 workbench authority", () => {
  it("keeps the last complete authority and removes its own temporary file when atomic replacement fails", async () => {
    const { root, home, store } = fixture();
    const state = await store.addProject("owner", 1n, join(root, "project")); const file = join(home, "workbench.json");
    const original = readFileSync(file, "utf8"); atomicFailure.destination = file;
    await expect(store.addProject("owner", state.revision, join(root, "another"))).rejects.toThrow("Fixture atomic replacement unavailable");
    expect(readFileSync(file, "utf8")).toBe(original); expect(readdirSync(home)).toEqual(["workbench.json"]);
    expect(await store.read("owner")).toEqual(state);
  });

  it("serializes competing revisions and publishes one complete atomic file", async () => {
    const { root, home, store } = fixture();
    const initial = await store.read("owner");
    const results = await Promise.allSettled([store.addProject("owner", initial.revision, join(root, "a")), store.addProject("owner", initial.revision, join(root, "b"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    const state = await store.read("owner");
    expect(state.revision).toBe(2n); expect(state.projects).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, "workbench.json"), "utf8"))).toMatchObject({ version: 1, partnerId: "owner", revision: 2 });
    expect(readdirSync(home)).toEqual(["workbench.json"]);
  });

  it("withdraws a project without deleting its judgments, and restores their projection on a new grant", async () => {
    const { root, store } = fixture(); const path = join(root, "project");
    let state = await store.addProject("owner", 1n, path);
    state = await store.setJudgment("owner", state.revision, { taskId: "item:idea", project: path, title: "Useful idea", verdict: "idea", next: "Review the proposal" });
    state = await store.removeProject("owner", state.revision, path);
    expect(state.projects).toEqual([]); expect(state.judgments).toHaveLength(1);
    await expect(store.setJudgment("owner", state.revision, { taskId: "item:other", project: path, title: "Another", verdict: "done", next: null })).rejects.toMatchObject({ code: "not_found" });
    state = await store.addProject("owner", state.revision, path);
    expect(state.judgments[0]?.taskId).toBe("item:idea");
  });

  it("enforces 50 projects and evicts the oldest done judgment before unfinished work", async () => {
    const { root, store } = fixture();
    let state = await store.read("owner");
    for (let index = 0; index < 50; index++) state = await store.addProject("owner", state.revision, join(root, `project-${index}`));
    await expect(store.addProject("owner", state.revision, join(root, "project-51"))).rejects.toMatchObject({ code: "resource_exhausted" });
    const project = state.projects[0]!.path;
    state = await store.setJudgment("owner", state.revision, { taskId: "item:unfinished", project, title: "Keep this", verdict: "unfinished", next: "Continue" });
    for (let index = 0; index < 200; index++) state = await store.setJudgment("owner", state.revision, { taskId: `item:done-${index}`, project, title: "Done", verdict: "done", next: null });
    expect(state.judgments).toHaveLength(200);
    expect(state.judgments.some((row) => row.taskId === "item:unfinished")).toBe(true);
    expect(state.judgments.some((row) => row.taskId === "item:done-0")).toBe(false);
  });

  it("fails closed for incompatible or damaged files and leaves the authority untouched", async () => {
    const { root, home, store } = fixture(); const file = join(home, "workbench.json");
    for (const content of ["broken", JSON.stringify({ directories: [], tasks: {} }), JSON.stringify({ version: 1, partnerId: "another", revision: 1, projects: [], judgments: [] })]) {
      writeFileSync(file, content);
      await expect(store.read("owner")).rejects.toMatchObject({ code: "invalid" });
      await expect(store.addProject("owner", 1n, join(root, "project"))).rejects.toMatchObject({ code: "invalid" });
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });
});
