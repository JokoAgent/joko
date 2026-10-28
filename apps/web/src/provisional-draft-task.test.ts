import { expect, it, vi } from "vitest";
import type { NewSessionDraft, ProvisionalTaskReceipt, SessionPreparationView } from "./model.js";
import { ProvisionalDraftTask } from "./provisional-draft-task.js";

const draft: NewSessionDraft = { targetId: "project", expectedTargetRevision: 2n, name: "New task", nativeStart: { kind: "fresh" },
  providerId: "account", modelId: "model", effort: "medium", fastMode: false, permissionMode: "ask", planMode: false };
function fixture() {
  let receipt: ProvisionalTaskReceipt | undefined, current = true;
  const observations = new Map<string, SessionPreparationView>();
  const api = { createSession: vi.fn(async (input: NewSessionDraft) => {
    expect(receipt?.operationId).toBe(input.operationId); expect(receipt?.draftId).toBe(input.provisionalDraftId);
    observations.set(input.operationId!, { state: "succeeded", sessionId: "prepared", generation: 1n, provisionalDraftId: input.provisionalDraftId });
    return { sessionId: "prepared", generation: 1n };
  }), readSessionPreparation: vi.fn(async (id: string) => observations.get(id) ?? { state: "pending" as const }),
  prewarmSession: vi.fn(async (_sessionId: string, _draftId?: string) => undefined),
  discardProvisionalSession: vi.fn(async (_sessionId: string, _draftId: string, _operationId: string) => undefined) };
  const task = () => new ProvisionalDraftTask({ api, read: () => receipt, save: async next => { receipt = next; }, isCurrent: () => current });
  return { api, task, observations, read: () => receipt, revoke: () => { current = false; } };
}

it("coalesces input preparation, keeps body local, and first send adopts the same exact task", async () => {
  const f = fixture(), task = f.task();
  await Promise.all([task.prepare(draft), task.prepare(draft)]);
  expect(f.api.createSession).toHaveBeenCalledOnce(); expect(f.api.prewarmSession).toHaveBeenCalledWith("prepared", f.read()?.draftId);
  const first = await task.take(draft), same = await task.take(draft);
  expect(first.reuseProvisionalSessionId).toBe("prepared"); expect(same).toEqual(first);
  expect(JSON.stringify(f.read())).not.toContain("first input");
  await task.accepted(); expect(f.read()).toBeUndefined(); expect(f.api.discardProvisionalSession).not.toHaveBeenCalled();
});

it("cold-restores an unknown native creation by its original Operation without creating another task", async () => {
  const f = fixture(); f.api.createSession.mockRejectedValueOnce(new Error("lost native creation response"));
  await expect(f.task().prepare(draft)).rejects.toThrow("lost native"); const receipt = f.read()!;
  const restarted = f.task(); await restarted.prepare(draft);
  await expect(restarted.take(draft)).rejects.toThrow("unresolved");
  expect(f.api.createSession).toHaveBeenCalledOnce();
  f.observations.set(receipt.operationId, { state: "succeeded", sessionId: "original-native-task", generation: 1n, provisionalDraftId: receipt.draftId });
  expect(await restarted.take(draft)).toMatchObject({ reuseProvisionalSessionId: "original-native-task", provisionalDraftId: receipt.draftId });
  expect(f.api.createSession).toHaveBeenCalledOnce();
});

it("keeps the original discard receipt after uncertain closure and does not rebuild with changed settings", async () => {
  const f = fixture(), task = f.task(); await task.prepare(draft);
  f.api.discardProvisionalSession.mockRejectedValueOnce(new Error("native close unknown"));
  await expect(task.prepare({ ...draft, effort: "high" })).rejects.toThrow("unknown");
  const discardId = f.read()!.discardOperationId;
  expect(f.api.createSession).toHaveBeenCalledOnce();
  await task.prepare({ ...draft, effort: "high" });
  expect(f.api.discardProvisionalSession.mock.calls.map(call => call[2])).toEqual([discardId, discardId]);
  expect(f.api.createSession).toHaveBeenCalledTimes(2);
});

it("retains a terminal creation failure when the native effect may still exist", async () => {
  const f = fixture(); f.api.createSession.mockRejectedValueOnce(new Error("lost response"));
  await expect(f.task().prepare(draft)).rejects.toThrow();
  const receipt = f.read()!;
  f.observations.set(receipt.operationId, { state: "failed", error: "original native result unknown", stateMayHaveChanged: true });
  await expect(f.task().prepare({ ...draft, effort: "high" })).rejects.toThrow("original native result unknown");
  expect(f.api.createSession).toHaveBeenCalledOnce(); expect(f.read()?.operationId).toBe(receipt.operationId);
});

it("keeps old-account preparation out of a new draft owner", async () => {
  const f = fixture(), task = f.task(); await task.prepare(draft); f.revoke();
  await expect(task.take(draft)).rejects.toThrow("owner changed");
  await expect(task.retire()).rejects.toThrow("owner changed");
  expect(f.api.discardProvisionalSession).not.toHaveBeenCalled(); expect(f.read()?.sessionId).toBe("prepared");
});
