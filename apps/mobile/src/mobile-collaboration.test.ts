import { clone, create } from "@bufbuild/protobuf";
import { CollaborationGoalTreeSchema, CollaborationGoalStatus, CollaborationWorkerStatus, PermissionMode, encodeModelSpeed, type CollaborationService } from "@joko/contracts";
import type { Client } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { createMobileCollaborationRpc, mobileWorkerInitialTask, mobileWorkerLabel, normalizeMobileWorkerForm, projectMobileCollaborationTree, type MobileWorkerForm, type MobileWorkerTarget } from "./mobile-collaboration";
import { MobileWorkerStorage } from "./mobile-worker-storage";

const tree = () => create(CollaborationGoalTreeSchema, {
  goal: { goalId: "goal", leadId: "lead", leadSessionId: "task", backendId: "backend", targetId: "target", sessionGeneration: 7n,
    backendInstanceGeneration: 2n, title: "Team", objective: "Coordinate work", status: CollaborationGoalStatus.ACTIVE,
    createdAt: { seconds: 1_792_000_000n }, updatedAt: { seconds: 1_792_000_001n }, revision: { value: 3n } },
  workers: [{ workerId: "worker", goalId: "goal", sessionId: "worker-task", sessionGeneration: 9n, backendInstanceGeneration: 2n,
    label: "developer", role: "developer", assignment: "", route: { backendId: "backend", targetId: "target", permissionMode: PermissionMode.AUTO },
    status: CollaborationWorkerStatus.IDLE, createdAt: { seconds: 1_792_000_000n }, updatedAt: { seconds: 1_792_000_001n }, revision: { value: 2n } }]
});
const form = { role: "developer", targetId: "target", initialTask: "", permissionMode: PermissionMode.AUTO };
describe("mobile collaboration contract and local recovery", () => {
  it("normalizes optional tasks without turning pending lead text into a worker assignment", () => {
    expect(normalizeMobileWorkerForm({ ...form, role: "  reviewer  " })).toMatchObject({ role: "reviewer", initialTask: "" });
    expect(mobileWorkerInitialTask("", "Lead input")).toBe("");
    expect(mobileWorkerInitialTask("Review files", "Lead input")).toContain("do not treat it as a replacement task.\nLead input");
    expect(mobileWorkerLabel("developer", tree().workers)).toBe("developer-2");
    expect(() => normalizeMobileWorkerForm({ ...form, role: "x".repeat(33) })).toThrow();
  });
  it("projects a ready waiting worker and rejects foreign membership, parent cycles and route collisions", () => {
    const value = tree(); expect(projectMobileCollaborationTree(value, "goal", "worker-task").workers[0]?.assignment).toBe("");
    expect(() => projectMobileCollaborationTree(value, "goal", "foreign")).toThrow("another task");
    const cycle = tree(); cycle.workers[0]!.parentWorkerId = "worker"; expect(() => projectMobileCollaborationTree(cycle, "goal", "task")).toThrow("parent");
    const duplicate = tree(); duplicate.workers.push({ ...duplicate.workers[0]!, workerId: "duplicate" });
    expect(() => projectMobileCollaborationTree(duplicate, "goal", "task")).toThrow("worker");
  });
  it.each(["fast", "ULTRAFAST", 0, null, undefined])("rejects an unknown worker model speed %s", speed => {
    expect(() => normalizeMobileWorkerForm({ ...form, model: { providerId: "provider", modelId: "model",
      fastMode: speed as unknown as NonNullable<MobileWorkerForm["model"]>["fastMode"] } })).toThrow("selected worker model");
  });
  it.each([false, true, "ultrafast"] as const)("sends empty initial work and exact speed %s while rejecting altered results or retired writes", async speed => {
    const result = tree(); result.workers[0]!.route = { ...result.workers[0]!.route!, providerId: "provider", modelId: "model", effort: "high", ...encodeModelSpeed(speed) };
    const createWorker = vi.fn(async () => ({ tree: result, worker: result.workers[0] }));
    const rpc = createMobileCollaborationRpc({ createCollaborationWorker: createWorker } as unknown as Client<typeof CollaborationService>, "task", 7n, signal => signal.throwIfAborted());
    const exact = { ...form, model: { providerId: "provider", modelId: "model", effortId: "high", fastMode: speed } }, signal = new AbortController().signal;
    await rpc.createWorker(result.goal!, exact, "developer", "request", signal);
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ operationId: "request", callerLeadSessionId: "task", assignment: "", providerId: "provider", effort: "high", ...encodeModelSpeed(speed) }), { signal });
    result.workers[0]!.route!.modelId = "foreign";
    await expect(rpc.createWorker(result.goal!, exact, "developer", "other", signal)).rejects.toThrow("requested role and route");
    const retired = new AbortController(); retired.abort(); await expect(rpc.createWorker(result.goal!, exact, "developer", "retired", retired.signal)).rejects.toThrow();
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
  it("remembers route settings without role/task text and converges stale preferences against the current catalog", async () => {
    const values = new Map<string, string>(), storage = new MobileWorkerStorage({ getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } });
    const target: MobileWorkerTarget = { id: "target", name: "Project", backendId: "backend", backendName: "Backend", models: [], permissionModes: [PermissionMode.ASK, PermissionMode.AUTO], canSetEffort: true, canSetFastMode: true };
    await storage.remember("profile", target, { ...form, role: "Private role", initialTask: "Private initial task", model: { providerId: "provider", modelId: "removed-model", fastMode: true } });
    const raw = [...values.values()][0]!; expect(raw).not.toContain("Private");
    expect(await storage.defaults("profile", [target], target.id)).toEqual(form);
    expect(await storage.defaults("other-profile", [target], target.id)).toEqual(form);
    const identity = { profileId: "profile", connectionId: "connection", serverId: "node", sessionId: "task", generation: "7" };
    await storage.save(identity, { ...form, initialTask: "Recover this work" });
    expect(await storage.read(identity)).toMatchObject({ initialTask: "Recover this work" });
    expect(await storage.read({ ...identity, generation: "8" })).toBeUndefined();
    await storage.clear({ ...identity, connectionId: "replacement" }); expect(await storage.read(identity)).toBeDefined();
    await storage.clear(identity); expect(await storage.read(identity)).toBeUndefined();
  });
});
