import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CollaborationGoalStatus, CollaborationSessionRole, ListCollaborationGoalsRequestSchema, ListCollaborationGoalsResponseSchema } from "@joko/contracts";
import { SuggestSessionTitleRequestSchema, SuggestSessionTitleResponseSchema, SessionTitleSuggestionStatus } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { mobileNetwork, type PairedCredential } from "./network";

const credential: PairedCredential = { profileId: "profile", origin: "https://node.example", serverId: "server", connectionId: "connection",
  deviceId: "phone", displayName: "Phone", authKey: "header-fixture-key" };
afterEach(() => vi.restoreAllMocks());
it("suggests only through the authenticated generated session contract and preserves non-success statuses", async () => {
  let response = create(SuggestSessionTitleResponseSchema, { title: "Draft only", status: SessionTitleSuggestionStatus.OK });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/joko.v1.SessionService/SuggestSessionTitle");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential.authKey}`);
    expect(fromBinary(SuggestSessionTitleRequestSchema, new Uint8Array(init!.body as Uint8Array))).toMatchObject({ sessionId: "task" });
    return new Response(toBinary(SuggestSessionTitleResponseSchema, response), { headers: { "content-type": "application/proto" } });
  });
  expect(await mobileNetwork.suggestSessionTitle(credential, "task")).toMatchObject({ title: "Draft only", status: SessionTitleSuggestionStatus.OK });
  response = create(SuggestSessionTitleResponseSchema, { status: SessionTitleSuggestionStatus.NO_MATERIAL });
  expect(await mobileNetwork.suggestSessionTitle(credential, "task")).toMatchObject({ title: "", status: SessionTitleSuggestionStatus.NO_MATERIAL });
  const controller = new AbortController(); controller.abort();
  await expect(mobileNetwork.suggestSessionTitle(credential, "task", controller.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("reads exact authenticated generated task access, including archived worker membership and lead presentation", async () => {
  let response = create(ListCollaborationGoalsResponseSchema);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/joko.v1.CollaborationService/ListCollaborationGoals");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential.authKey}`);
    expect(fromBinary(ListCollaborationGoalsRequestSchema, new Uint8Array(init!.body as Uint8Array)))
      .toMatchObject({ sessionId: "task", includeArchived: true });
    return new Response(toBinary(ListCollaborationGoalsResponseSchema, response), { headers: { "content-type": "application/proto" } });
  });
  expect(await mobileNetwork.readTaskHeaderRole(credential, "task")).toBe("ordinary");
  response = create(ListCollaborationGoalsResponseSchema, { access: [{ goal: { goalId: "goal", leadSessionId: "task" }, role: CollaborationSessionRole.LEAD }] });
  expect(await mobileNetwork.readTaskHeaderRole(credential, "task")).toBe("lead");
  response = create(ListCollaborationGoalsResponseSchema, { access: [{ goal: { goalId: "goal", leadSessionId: "lead", status: CollaborationGoalStatus.ARCHIVED },
    role: CollaborationSessionRole.WORKER, workerId: "member" }] });
  expect(await mobileNetwork.readTaskHeaderRole(credential, "task")).toBe("worker"); expect(fetcher).toHaveBeenCalledTimes(3);
});
it("rejects foreign, ambiguous and untyped task access and cancels before dispatch", async () => {
  let response = create(ListCollaborationGoalsResponseSchema);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(toBinary(ListCollaborationGoalsResponseSchema, response), { headers: { "content-type": "application/proto" } }));
  const controller = new AbortController(); controller.abort();
  await expect(mobileNetwork.readTaskHeaderRole(credential, "task", controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  for (const access of [
    [{ goal: { goalId: "goal", leadSessionId: "other" }, role: CollaborationSessionRole.LEAD }],
    [{ goal: { goalId: "goal", leadSessionId: "task" }, role: CollaborationSessionRole.WORKER, workerId: "member" }],
    [{ goal: { goalId: "goal", leadSessionId: "task" }, role: CollaborationSessionRole.UNSPECIFIED }],
    [{ goal: { goalId: "lead-goal", leadSessionId: "task" }, role: CollaborationSessionRole.LEAD },
      { goal: { goalId: "worker-goal", leadSessionId: "lead" }, role: CollaborationSessionRole.WORKER, workerId: "member" }],
    ["one", "two"].map(goalId => ({ goal: { goalId, leadSessionId: "lead" }, role: CollaborationSessionRole.WORKER, workerId: "member" }))
  ]) {
    response = create(ListCollaborationGoalsResponseSchema, { access });
    await expect(mobileNetwork.readTaskHeaderRole(credential, "task")).rejects.toThrow("task header access");
  }
});
