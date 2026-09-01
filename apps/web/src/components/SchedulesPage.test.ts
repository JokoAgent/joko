import { describe, expect, it } from "vitest";

import type { BackendView, ModelView, ScheduleView, SessionView, TargetView } from "../model.js";
import { scheduleDraft } from "./SchedulesPage.js";

const target: TargetView = {
  id: "target-one",
  backendId: "backend-one",
  name: "Project",
  workspaceId: "workspace-one",
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

const globallyAvailableModel: ModelView = {
  backendId: "backend-one",
  providerId: "global-provider",
  providerName: "Global Provider",
  modelId: "global-model",
  name: "Global Model",
  available: true,
  supportsImages: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsFast: false,
  efforts: ["medium"],
  contextWindow: 128_000,
  maximumOutputTokens: 8_192,
  inputCostMicrosPerMillion: 0,
  outputCostMicrosPerMillion: 0,
  currencyCode: "USD"
};

function session(model?: ModelView): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 0n,
    ...(model === undefined ? {} : { model, effort: "medium" }),
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

describe("Schedule editor execution defaults", () => {
  it("keeps task-default model fields empty when the selected task has no saved model selection", () => {
    const draft = scheduleDraft(undefined, [target], [session()], [globallyAvailableModel]);

    expect(draft).toMatchObject({
      targetId: target.id,
      sessionMode: "fresh",
      sessionId: "",
      providerId: "",
      modelId: ""
    });
    expect(draft.effort).toBeUndefined();
  });

  it("uses the selected task model when a saved model selection exists", () => {
    const draft = scheduleDraft(undefined, [target], [session(globallyAvailableModel)], [globallyAvailableModel]);

    expect(draft).toMatchObject({
      providerId: globallyAvailableModel.providerId,
      modelId: globallyAvailableModel.modelId,
      effort: "medium"
    });
  });

  it("preserves a persistent schedule's durable task binding while editing", () => {
    const existing = {
      id: "schedule-one",
      name: "Persistent",
      backendId: "backend-one",
      targetId: "target-one",
      source: "user" as const,
      sessionMode: "persistent" as const,
      sessionId: "session-one",
      enabled: true,
      kind: "manual" as const,
      expression: "",
      timezone: "UTC",
      inputText: "Continue",
      executionMode: "agent" as const,
      useWorktree: false,
      refreshWorktreeRemote: false,
      permissionMode: "ask" as const,
      planMode: false,
      extraDirectoryIds: ["extra-worktree"],
      silentWhenIdle: false,
      notifyDesktop: true,
      overlapPolicy: "queue" as const,
      misfirePolicy: "runOnce" as const,
      unreadRunCount: 0,
      history: []
    };

    expect(scheduleDraft(existing, [target], [session()], [globallyAvailableModel])).toMatchObject({
      sessionMode: "persistent",
      sessionId: "session-one",
      extraDirectoryIds: ["extra-worktree"]
    });
  });

  it("defaults only to a healthy text-capable target when Backend choices differ", () => {
    const blockedTarget = { ...target, id: "target-blocked", backendId: "backend-blocked", name: "Blocked" };
    const backends: BackendView[] = [
      backend("backend-blocked", false),
      backend("backend-one", true)
    ];

    expect(scheduleDraft(undefined, [blockedTarget, target], [session()], [globallyAvailableModel], backends).targetId).toBe(target.id);
  });

  it("edits a one-shot wall clock in the schedule's IANA timezone", () => {
    const existing: ScheduleView = {
      id: "schedule-zone",
      name: "Shanghai morning",
      backendId: "backend-one",
      targetId: "target-one",
      source: "user",
      sessionMode: "fresh",
      enabled: true,
      kind: "once",
      expression: new Date(Date.UTC(2026, 7, 24, 1, 30)).toISOString(),
      timezone: "Asia/Shanghai",
      inputText: "Continue",
      executionMode: "agent",
      useWorktree: true,
      worktreeSourceRef: "refs/heads/feature/schedule",
      refreshWorktreeRemote: true,
      permissionMode: "ask",
      planMode: false,
      extraDirectoryIds: [],
      silentWhenIdle: false,
      notifyDesktop: true,
      overlapPolicy: "queue",
      misfirePolicy: "runOnce",
      unreadRunCount: 0,
      history: []
    };

    expect(scheduleDraft(existing, [target], [session()], [globallyAvailableModel])).toMatchObject({
      expression: "2026-08-24T09:30",
      useWorktree: true,
      worktreeSourceRef: "refs/heads/feature/schedule",
      refreshWorktreeRemote: true
    });
  });

  it("preserves script capabilities, expiration, notifications, and the managed hook", () => {
    const existing: ScheduleView = {
      id: "schedule-script",
      name: "Script",
      backendId: "backend-one",
      targetId: "target-one",
      source: "user",
      sessionMode: "fresh",
      enabled: true,
      kind: "manual",
      expression: "",
      timezone: "Asia/Shanghai",
      inputText: "",
      executionMode: "script",
      useWorktree: false,
      refreshWorktreeRemote: false,
      script: { command: "node automation.mjs", timeoutMs: 45_000, capabilities: ["sessions.dispatch"] },
      permissionMode: "ask",
      planMode: false,
      extraDirectoryIds: [],
      silentWhenIdle: false,
      notifyDesktop: false,
      expireAt: Date.UTC(2026, 7, 25, 1, 30),
      preRunHook: { command: "node hook.mjs", filePath: "D:\\workspace\\hook.mjs", timeoutMs: 5_000 },
      overlapPolicy: "skip",
      misfirePolicy: "skip",
      unreadRunCount: 0,
      history: []
    };

    expect(scheduleDraft(existing, [target], [session()], [globallyAvailableModel])).toMatchObject({
      executionMode: "script",
      sessionMode: "fresh",
      scriptCommand: "node automation.mjs",
      scriptTimeoutMs: 45_000,
      scriptDispatchSessions: true,
      notifyDesktop: false,
      expireAtExpression: "2026-08-25T09:30",
      preRunHook: { command: "node hook.mjs", filePath: "D:\\workspace\\hook.mjs", timeoutMs: 5_000 }
    });
  });
});

function backend(id: string, text: boolean): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["input.text", { name: "input.text", supported: text, options: [] }],
      ["model.switch", { name: "model.switch", supported: true, options: [] }],
      ["model.effort", { name: "model.effort", supported: true, options: [] }],
      ["model.fast_mode", { name: "model.fast_mode", supported: true, options: [] }],
      ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto"] }],
      ["plan_mode", { name: "plan_mode", supported: true, options: [] }]
    ])
  };
}
