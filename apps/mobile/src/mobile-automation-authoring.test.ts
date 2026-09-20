import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  ExtraDirectoryAccess,
  ExtraDirectorySchema,
  ModelDescriptorSchema,
  ModelInputModality,
  ModelOutputModality,
  PermissionMode,
  ProviderDescriptorSchema,
  ScheduleDeletionResultSchema,
  ScheduleExecutionMode,
  ScheduleGeneratedSessionDisposition,
  ScheduleSessionMode,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  WorkspaceDescriptorSchema,
  WorkspaceKind,
  capabilityNames,
  type Capability,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import type { MobileAutomationSchedule } from "./mobile-automation";
import {
  applyMobileAutomationTemplate,
  buildMobileAutomationScheduleInput,
  createMobileAutomationDraft,
  mobileAutomationExtraDirectoryOptions,
  mobileAutomationTemplates,
  projectMobileAutomationDeletionResult
} from "./mobile-automation-authoring";

describe("mobile Automation authoring", () => {
  it("builds all current v1 agent fields from current target authority", () => {
    const owner = authoringOwner();
    const draft = {
      ...createMobileAutomationDraft(owner, undefined, Date.UTC(2026, 8, 21)),
      name: "Daily review",
      recurrence: "interval" as const,
      expression: "90",
      intervalAnchorAt: 12_000,
      inputText: "Inspect the repository",
      permissionMode: "auto" as const,
      planMode: true,
      useWorktree: true,
      worktreeSourceRef: "refs/heads/main",
      refreshWorktreeRemote: true,
      extraDirectoryIds: ["extra"],
      silentWhenIdle: true,
      notifyDesktop: false,
      expireAtExpression: "2026-09-22T12:00",
      overlapPolicy: "skip" as const,
      misfirePolicy: "skip" as const
    };
    const result = buildMobileAutomationScheduleInput(owner, draft, undefined, {
      targetId: "target",
      eligibility: "eligible",
      canRefreshRemote: true,
      sources: [{ ref: "refs/heads/main", commit: "abc123", displayName: "main", remote: false, current: true }]
    }, Date.UTC(2026, 8, 21));

    expect(result.target.targetId).toBe("target");
    expect(result.schedule).toMatchObject({
      displayName: "Daily review",
      backendId: "backend",
      targetId: "target",
      sessionMode: ScheduleSessionMode.FRESH,
      timeZone: "Asia/Shanghai",
      execution: {
        executionMode: ScheduleExecutionMode.AGENT,
        permissionMode: PermissionMode.AUTO,
        planMode: true,
        useWorktree: true,
        worktreeSourceRef: "refs/heads/main",
        refreshWorktreeRemote: true,
        extraDirectoryIds: ["extra"],
        silentWhenIdle: true,
        notify: { desktop: false }
      }
    });
    expect(result.schedule.recurrence?.kind.case).toBe("interval");
    expect(result.schedule.input?.parts[0]?.content).toEqual({ case: "text", value: "Inspect the repository" });
    expect(mobileAutomationExtraDirectoryOptions(owner, "target")).toEqual([
      { id: "extra", path: "D:\\shared", access: "readWrite" }
    ]);
  });

  it("applies the six Joko templates without hiding required parameters", () => {
    const owner = authoringOwner();
    const draft = createMobileAutomationDraft(owner);
    expect(mobileAutomationTemplates()).toHaveLength(6);
    expect(() => applyMobileAutomationTemplate(draft, "topic-radar")).toThrow(/Enter topic to follow/);
    expect(applyMobileAutomationTemplate(draft, "topic-radar", "AI agents")).toMatchObject({
      name: "Domain radar",
      recurrence: "cron",
      expression: "0 9 * * 1-5",
      inputText: expect.stringContaining("AI agents")
    });
  });

  it("fails closed when execution or Worktree authority drifts", () => {
    const owner = authoringOwner();
    const base = createMobileAutomationDraft(owner);
    const scriptWithAgentOptions = {
      ...base,
      name: "Script",
      executionMode: "script" as const,
      scriptCommand: "node task.mjs",
      model: { providerId: "provider", modelId: "model", effortId: "high", fastMode: true }
    };
    expect(() => buildMobileAutomationScheduleInput(owner, scriptWithAgentOptions, undefined, undefined)).toThrow(/Script Automations require/);
    const worktree = { ...base, name: "Worktree", inputText: "Run", useWorktree: true };
    expect(() => buildMobileAutomationScheduleInput(owner, worktree, undefined, {
      targetId: "target", eligibility: "unsafe", canRefreshRemote: false, sources: []
    })).toThrow(/Reload and confirm isolated Worktree support/);

    expect(buildMobileAutomationScheduleInput(owner, { ...worktree, enabled: false }, undefined, {
      targetId: "target", eligibility: "unavailable", canRefreshRemote: false, sources: []
    }).schedule.execution?.useWorktree).toBe(true);
  });

  it("accepts the configured default model snapshot even when model switching is unavailable", () => {
    const original = authoringOwner();
    const backend = original.backends[0]!;
    const owner = create(SnapshotSchema, {
      ...original,
      backends: [create(BackendDescriptorSchema, {
        ...backend,
        capabilities: create(CapabilityManifestSchema, {
          schemaVersion: backend.capabilities!.schemaVersion,
          revision: backend.capabilities!.revision,
          capabilities: backend.capabilities!.capabilities.filter((capability) => capability.name !== capabilityNames.modelSwitch)
        })
      })]
    });
    const draft = { ...createMobileAutomationDraft(owner), name: "Default model", inputText: "Run" };

    expect(buildMobileAutomationScheduleInput(owner, draft, undefined, undefined).schedule.execution?.model)
      .toMatchObject({ model: { providerId: "provider", modelId: "model" }, effortId: "low", fastMode: false });
  });

  it("preserves an unchanged saved model snapshot after its route leaves the live catalog", () => {
    const original = authoringOwner();
    const owner = create(SnapshotSchema, { ...original, models: [] });
    const existing: MobileAutomationSchedule = {
      scheduleId: "schedule",
      displayName: "Saved model",
      state: "enabled",
      source: "dialogue",
      backendId: "backend",
      targetId: "target",
      sessionMode: "fresh",
      recurrence: "manual",
      recurrenceLabel: "Manual",
      recurrenceExpression: "",
      timeZone: "Asia/Shanghai",
      inputText: "Run",
      editableInputText: "Run",
      executionMode: "agent",
      model: { providerId: "provider", modelId: "retired-model", effortId: "high", fastMode: false },
      permissionMode: "ask",
      planMode: false,
      useWorktree: false,
      refreshWorktreeRemote: false,
      extraDirectoryIds: [],
      silentWhenIdle: false,
      notifyDesktop: true,
      overlapPolicy: "queue",
      misfirePolicy: "runOnce",
      unreadRunCount: 0,
      recentRuns: [],
      revision: { value: 2n, etag: "schedule-r2" },
      generation: 1n
    };
    const draft = createMobileAutomationDraft(owner, existing);

    expect(buildMobileAutomationScheduleInput(owner, draft, existing, undefined).schedule.execution?.model)
      .toMatchObject({ model: { providerId: "provider", modelId: "retired-model" }, effortId: "high" });
    expect(() => buildMobileAutomationScheduleInput(owner, {
      ...draft,
      model: { ...draft.model!, effortId: "low" }
    }, existing, undefined)).toThrow(/model route is no longer available/);
  });

  it("validates typed deletion outcomes against the requested manifest", () => {
    const result = create(ScheduleDeletionResultSchema, {
      scheduleId: "schedule",
      generatedSessionDisposition: ScheduleGeneratedSessionDisposition.ARCHIVE,
      generatedSessionIds: ["session-a", "session-b"],
      completedSessionIds: ["session-a"],
      failures: [{ sessionId: "session-b", message: "Task is still running" }],
      inflightCount: 1
    });
    expect(projectMobileAutomationDeletionResult(result, "schedule", "archive")).toMatchObject({
      scheduleId: "schedule",
      disposition: "archive",
      completedSessionIds: ["session-a"],
      failures: [{ sessionId: "session-b" }]
    });
    expect(() => projectMobileAutomationDeletionResult(result, "other", "archive")).toThrow(/another Automation operation/);
  });
});

function authoringOwner(): Snapshot {
  return create(SnapshotSchema, {
    snapshotId: "owner",
    scope: { kind: { case: "owner", value: {} } },
    generation: 3n,
    revision: { value: 8n, etag: "owner-r8" },
    server: { serverId: "server" },
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      displayName: "Backend",
      capabilities: create(CapabilityManifestSchema, {
        schemaVersion: "1",
        revision: { value: 2n },
        capabilities: capabilities()
      }),
      entityVersion: { revision: { value: 2n }, generation: 1n }
    })],
    targets: [create(TargetSchema, {
      targetId: "target",
      backendId: "backend",
      workspaceId: "workspace",
      displayName: "Project",
      state: TargetState.ACTIVE,
      version: { revision: { value: 4n, etag: "target-r4" }, generation: 1n }
    })],
    workspaces: [create(WorkspaceDescriptorSchema, {
      workspaceId: "workspace",
      targetId: "target",
      displayName: "Project",
      kind: WorkspaceKind.USER_PROJECT,
      serverPathDisplay: "D:\\project",
      trusted: true,
      version: { revision: { value: 4n }, generation: 1n }
    })],
    sessions: [create(SessionSchema, {
      sessionId: "session",
      backendId: "backend",
      targetId: "target",
      displayName: "Existing task",
      state: SessionState.IDLE,
      version: { revision: { value: 5n }, generation: 1n }
    })],
    extraDirectories: [create(ExtraDirectorySchema, {
      extraDirectoryId: "extra",
      workspaceId: "workspace",
      serverPathDisplay: "D:\\shared",
      access: ExtraDirectoryAccess.READ_WRITE,
      trusted: true,
      version: { revision: { value: 2n }, generation: 1n }
    })],
    models: [create(ModelDescriptorSchema, {
      backendId: "backend",
      key: { providerId: "provider", modelId: "model" },
      displayName: "Model",
      family: "model",
      contextWindowTokens: 128_000n,
      maximumOutputTokens: 8_000n,
      inputModalities: [ModelInputModality.TEXT],
      outputModalities: [ModelOutputModality.TEXT],
      effortLevels: [
        { effortId: "low", displayName: "Low", order: 0, defaultLevel: true },
        { effortId: "high", displayName: "High", order: 1 }
      ],
      supportsFastMode: true,
      available: true
    })],
    providers: [create(ProviderDescriptorSchema, {
      backendId: "backend", providerId: "provider", displayName: "Provider"
    })],
    settings: {
      revision: { value: 6n },
      backends: [{
        backendId: "backend",
        enabled: true,
        defaultModel: {
          model: { providerId: "provider", modelId: "model" }, effortId: "low", fastMode: false
        },
        defaultPermissionMode: PermissionMode.ASK,
        defaultPlanMode: false,
        modelAccess: {}
      }]
    }
  });
}

function capabilities(): Capability[] {
  const supported = (name: string) => create(CapabilitySchema, { name, support: CapabilitySupport.SUPPORTED });
  const model = (name: string, options: Record<string, boolean>) => create(CapabilitySchema, {
    name,
    support: CapabilitySupport.SUPPORTED,
    options: { kind: { case: "model", value: options } }
  });
  return [
    supported(capabilityNames.inputText),
    model(capabilityNames.modelList, { providerAware: true }),
    model(capabilityNames.modelSwitch, { providerAware: true, switchDuringSession: true }),
    model(capabilityNames.modelEffort, { providerAware: true, switchDuringSession: true, supportsEffort: true }),
    model(capabilityNames.modelFastMode, { providerAware: true, switchDuringSession: true, supportsFastMode: true }),
    create(CapabilitySchema, {
      name: capabilityNames.permissionModes,
      support: CapabilitySupport.SUPPORTED,
      options: { kind: { case: "permission", value: {
        modes: [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS],
        mutableDuringSession: true
      } } }
    }),
    supported(capabilityNames.planMode),
    supported(capabilityNames.workspaceExtraDirs)
  ];
}
