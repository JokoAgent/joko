import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { create } from "@bufbuild/protobuf";
import { createPiAdapter, type PiProcessHandle, type PiProcessSpec } from "@joko/adapter-pi";
import * as contract from "@joko/contracts";
import {
  JokoError,
  type AdapterContext,
  type ApprovedDirectory,
  type BackendAdapter,
  type CreateNativeSessionInput,
  type ContextRebuildInput,
  type EventPayload,
  type InteractionDecision,
  type InteractionPayload,
  type ImportPortableNativeSessionInput,
  type NativeHistoryProjectedEvent,
  type NativeHistoryProjection,
  type NativeSessionBinding,
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogResult,
  type NativeSessionForkResult,
  type NativeSessionState,
  type PermissionMode,
  type PolicySnapshot,
  type PortableNativeSession,
  type PromptInput,
  type RuntimeCommand,
  type RuntimeToolCatalog,
  type SubagentControlInput,
  type SubagentRunDetail,
  type UserShellInput,
  type UserShellResult
} from "@joko/core";
import {
  CODEX_LIKE_PROFILE,
  FakeBackendAdapter,
  MINIMAL_PROFILE,
  PI_LIKE_PROFILE,
  type FakeAdapterProfile
} from "@joko/testkit";
import {
  InvalidStateTransitionError,
  OperationalStore,
  OperationConflictError,
  OperationPreviouslyFailedError,
  type PersistedEvent,
  type QueueItemRecord,
  RevisionConflictError,
  StoreError
} from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  createPortableSessionManifest,
  decodePortableSessionPackage,
  encodePortableSessionPackage
} from "./portable-session-package.js";
import {
  decodePortableSessionProjection,
  encodePortableSessionProjection
} from "./portable-session-projection.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { SessionHost, type WorkspaceRunCapture } from "./session-host.js";
import { activeNativeTimeline } from "./snapshot-projector.js";
import { NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD } from "./native-history.js";
import {
  materializedNativeStateObservation,
  nativeBindingFingerprint,
  nativeStateObservationIsCurrent,
  SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
} from "./native-state-observation.js";
import { materializedSessionRuntimeState, SESSION_RUNTIME_STATE_SETTING_KEY } from "./session-runtime-state.js";
import { materializedRuntimeCommands, SESSION_RUNTIME_COMMANDS_SETTING_KEY } from "./runtime-command-state.js";
import { providerRateLimitSettingKey } from "./provider-rate-limit.js";

const cleanups: Array<() => Promise<void> | void> = [];

const CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT = {
  useWorktree: false,
  refreshWorktreeRemote: false,
  scheduler: {
    format: 1,
    silentWhenIdle: false,
    notify: { desktop: true },
    executionMode: "agent"
  }
} as const;

const MUTABLE_RUNTIME_POLICY_PROFILE: FakeAdapterProfile = {
  ...PI_LIKE_PROFILE,
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.filter((capability) =>
      capability.key !== "permission.modes" && capability.key !== "permission.change"),
    { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] },
    { key: "permission.change", supported: true }
  ]
};

const BLANK_NATIVE_RECOVERY_PROFILE: FakeAdapterProfile = {
  ...MUTABLE_RUNTIME_POLICY_PROFILE,
  id: "blank-native-recovery",
  displayName: "Blank native recovery",
  capabilities: MUTABLE_RUNTIME_POLICY_PROFILE.capabilities.map((capability) =>
    capability.key === "model.fast_mode" ? { key: capability.key, supported: true } : capability),
  models: MUTABLE_RUNTIME_POLICY_PROFILE.models.map((model) => ({ ...model, supportsFastMode: true }))
};

function switchWithoutFastProfile(
  id: string,
  effortSupported: boolean,
  planModeSupported: boolean
): FakeAdapterProfile {
  return {
    ...MUTABLE_RUNTIME_POLICY_PROFILE,
    id,
    displayName: id,
    capabilities: MUTABLE_RUNTIME_POLICY_PROFILE.capabilities.map((capability) => {
      if (capability.key === "model.effort") {
        return effortSupported
          ? { key: capability.key, supported: true }
          : { key: capability.key, supported: false, reason: "upstream_missing" };
      }
      if (capability.key === "model.fast_mode") {
        return { key: capability.key, supported: false, reason: "upstream_missing" };
      }
      if (capability.key === "plan_mode") {
        return planModeSupported
          ? { key: capability.key, supported: true }
          : { key: capability.key, supported: false, reason: "upstream_missing" };
      }
      return capability;
    }),
    models: PI_LIKE_PROFILE.models.map((model) => ({ ...model, supportsFastMode: false }))
  };
}

function fakeHistoryEvent(
  nativeEntryId: string,
  projectionKind: string,
  payload: EventPayload,
  emittedAt?: number
): NativeHistoryProjectedEvent {
  return {
    nativeEntryId,
    projectionKind,
    contentIndex: 0,
    ...(emittedAt === undefined ? {} : { emittedAt }),
    payload,
    metadata: {
      namespace: "fake.native_history",
      fields: { nativeEntryId }
    }
  };
}

function portableWorkerRun(sessionId: string, index: number): SubagentRunDetail {
  const id = `worker-${index}`;
  return {
    id,
    sessionId,
    logicalAgentId: id,
    identityAliases: [],
    providerRunIds: [],
    state: "completed",
    title: `Worker ${index + 1}`,
    summary: `Result ${index + 1}`,
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: false,
      steer: false,
      followUp: false,
      resume: false,
      parentContext: "snapshot"
    },
    startedAt: 1_000 + index,
    updatedAt: 2_000 + index,
    endedAt: 2_000 + index,
    activity: [],
    children: [],
    returnedResult: `Result ${index + 1}`
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SessionHost", () => {
  it("rejects new task admission before native effects when its Backend is disabled", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { backendEnabled: () => false });

    await expect(fixture.host.createSession({
      operationId: "create-disabled-backend",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Disabled Backend",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).rejects.toMatchObject({ storedError: { code: "BACKEND_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
    expect(fixture.store.listSessions({ includeArchived: true })).toHaveLength(0);
  });

  it("chooses an enabled catalog route when the native default route is disabled", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, {
      modelRoutingEnabled: (_backendId, providerId, modelId) =>
        providerId === "vision" && modelId === "multimodal"
    });

    const created = await fixture.host.createSession({
      operationId: "create-enabled-default-route",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Enabled route",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });

    expect(createNative).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "vision", modelId: "multimodal" }),
      expect.anything()
    );
    expect(fixture.store.getSession(created.value.sessionId).descriptor).toMatchObject({
      providerId: "vision",
      modelId: "multimodal"
    });
  });

  it("explicitly selects an enabled route when the published catalog has already removed disabled defaults", async () => {
    const enabledModel = PI_LIKE_PROFILE.models.find((model) =>
      model.providerId === "vision" && model.modelId === "multimodal")!;
    const adapter = new FakeBackendAdapter({
      ...PI_LIKE_PROFILE,
      id: "filtered-model-catalog",
      displayName: "Filtered model catalog",
      models: [enabledModel]
    });
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelAccessRestricted: () => true });

    await fixture.host.createSession({
      operationId: "create-from-filtered-model-catalog",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Filtered route",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });

    expect(createNative).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "vision", modelId: "multimodal" }),
      expect.anything()
    );
  });

  it("rejects an unspecified route when access restrictions leave no advertised model", async () => {
    const adapter = new FakeBackendAdapter({
      ...PI_LIKE_PROFILE,
      id: "empty-filtered-model-catalog",
      displayName: "Empty filtered model catalog",
      models: []
    });
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelAccessRestricted: () => true });

    await expect(fixture.host.createSession({
      operationId: "create-without-enabled-model",
      connection: fixture.connection,
      targetId: "target-one",
      title: "No enabled route",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
  });

  it("fails closed when a non-switching Backend cannot prove its native default remains enabled", async () => {
    const adapter = new FakeBackendAdapter({
      ...PI_LIKE_PROFILE,
      id: "restricted-native-default",
      displayName: "Restricted native default",
      capabilities: PI_LIKE_PROFILE.capabilities.map((capability) =>
        capability.key === "model.switch"
          ? { key: capability.key, supported: false, reason: "upstream_missing" as const }
          : capability)
    });
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelAccessRestricted: () => true });

    await expect(fixture.host.createSession({
      operationId: "create-with-uncertain-native-default",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Uncertain default",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
  });

  it("rejects a new native child when its inherited route cannot be proven enabled", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelAccessRestricted: () => true });

    await expect(fixture.host.createSession({
      operationId: "create-restricted-native-child",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Restricted native child",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: { kind: "new", parentNativeReference: "native://unresolved-parent" }
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
  });

  it("rejects a new native child after its known parent route becomes disabled", async () => {
    let routeEnabled = true;
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, {
      modelRoutingEnabled: () => routeEnabled,
      modelAccessRestricted: () => !routeEnabled
    });
    const parentId = (await fixture.host.createSession({
      operationId: "create-parent-before-route-disabled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Parent route",
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const parentReference = fixture.store.getSession(parentId).descriptor.binding.opaqueRef;
    routeEnabled = false;

    await expect(fixture.host.createSession({
      operationId: "create-child-after-route-disabled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Disabled parent route",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: { kind: "new", parentNativeReference: parentReference }
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).toHaveBeenCalledOnce();
  });

  it("rejects a derived task after its source route becomes disabled", async () => {
    let routeEnabled = true;
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const cloneNative = vi.spyOn(adapter, "clone");
    const fixture = await createFixture(adapter, {
      modelRoutingEnabled: () => routeEnabled,
      modelAccessRestricted: () => !routeEnabled
    });
    const sourceSessionId = (await fixture.host.createSession({
      operationId: "create-source-before-derived-route-disabled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Derived route source",
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    routeEnabled = false;

    await expect(fixture.host.deriveSession({
      operationId: "clone-after-source-route-disabled",
      connection: fixture.connection,
      sourceSessionId,
      title: "Disabled derived route",
      kind: "clone"
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(cloneNative).not.toHaveBeenCalled();
  });

  it("rejects a disabled route from service-owned task creation", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelRoutingEnabled: () => false });

    await expect(fixture.host.createServiceSession({
      operationId: "create-disabled-service-route",
      serviceKind: "session_handoff",
      targetId: "target-one",
      title: "Disabled service route",
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
  });

  it("allows an admitted Attempt to finish on its exact Backend instance generation", async () => {
    const adapter = new InstanceGenerationCaptureFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-instance-generation-fence",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Instance generation fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    fixture.host.enqueueInput({
      operationId: "send-instance-generation-fence",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "capture", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.context !== undefined);
    const context = adapter.context!;
    advanceBackendInstanceGeneration(fixture.store, adapter.id);

    await context.emit({ type: "status", key: "fixture.admitted", text: "owned by admitted generation" });
    const decision = context.requestInteraction({
      id: "interaction-retired-instance",
      kind: "permission",
      title: "Admitted instance",
      toolName: "fixture",
      summary: "Must remain owned by the admitted Attempt",
      risk: "low",
      choices: ["allow", "deny"]
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;
    fixture.host.resolveInteraction(
      interaction.id,
      interaction.generation,
      { kind: "confirmed", confirmed: false },
      "resolve-admitted-instance"
    );
    await expect(decision).resolves.toEqual({ kind: "confirmed", confirmed: false });

    expect(fixture.store.listEvents({ sessionId }).some((event) =>
      event.payload.type === "status" && event.payload.key === "fixture.admitted"
    )).toBe(true);
    expect(fixture.store.getInteraction(interaction.id).status).toBe("resolved");
  });

  it("drops unadmitted callbacks from a retired Backend instance generation", async () => {
    const adapter = new InstanceGenerationCaptureFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-unadmitted-instance-fence",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Unadmitted instance fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const context = adapter.creationContext!;
    advanceBackendInstanceGeneration(fixture.store, adapter.id);

    await context.emit({
      type: "compaction",
      compactionId: "retired-instance-compaction",
      state: "started",
      reason: "late callback"
    });
    await context.emit({ type: "status", key: "fixture.retired", text: "must be dropped" });
    await expect(context.requestInteraction({
      id: "interaction-unadmitted-instance",
      kind: "permission",
      title: "Retired instance",
      toolName: "fixture",
      summary: "Must be cancelled",
      risk: "low",
      choices: ["allow", "deny"]
    })).resolves.toEqual({ kind: "cancelled" });

    expect(fixture.store.listEvents({ sessionId }).some((event) =>
      event.payload.type === "status" && event.payload.key === "fixture.retired"
    )).toBe(false);
    expect(fixture.store.findSetting("session", sessionId, "runtime.compaction.dispatch.queue")).toBeUndefined();
    expect(fixture.store.listEvents({ sessionId }).some((event) =>
      event.payload.type === "compaction" && event.payload.compactionId === "retired-instance-compaction"
    )).toBe(false);
    expect(fixture.store.listInteractions({ sessionId })).toEqual([]);
  });

  it("continues a safely interrupted turn and switches source on the second bounded recovery", async () => {
    const adapter = new RuntimeRecoveryFakeAdapter();
    const fixture = await createFixture(adapter, {
      sessionRuntimeFallbackEnabled: () => true,
      sessionRuntimeFallbackContext: () => ({
        availableProviderIds: new Set(["provider-a", "provider-b"])
      }),
      sessionRuntimeRecoveryDelayMs: () => 0
    });
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-recovery",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime recovery",
      providerId: "provider-a",
      modelId: "reasoner",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    fixture.host.enqueueInput({
      operationId: "send-runtime-recovery",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "recover safely", images: [], files: [], mentions: [], disposition: "prompt" }
    });

    await eventually(() => adapter.prompts.length === 3 && fixture.store.listRuns({
      sessionId,
      states: ["completed"],
      limit: 10
    }).length === 1, 5_000);
    expect(adapter.prompts).toEqual(["recover safely", "recover safely", "recover safely"]);
    expect(adapter.modelSelections).toContainEqual({ providerId: "provider-b", modelId: "reasoner" });
    expect(fixture.host.getSessionRuntimeControl(sessionId)).toMatchObject({
      baseline: { providerId: "provider-a", modelId: "reasoner" },
      effective: { providerId: "provider-b", modelId: "reasoner" },
      fallbackHop: 1,
      visitedRoutes: ["provider-a\0reasoner", "provider-b\0reasoner"]
    });
    const events = fixture.store.listEvents({ sessionId, order: "asc", limit: 1_000 });
    const recoveries = events.filter((event) => event.payload.type === "runtime_recovery");
    expect(recoveries.map((event) => event.payload.type === "runtime_recovery" ? event.payload.state : undefined))
      .toEqual(["waiting", "running", "failed", "waiting", "running", "succeeded"]);
    const continuationMessages = events.filter((event) => event.payload.type === "message_complete"
      && event.payload.automaticContinuation !== undefined);
    expect(continuationMessages).toHaveLength(2);
    expect(new Set(continuationMessages.map((event) => event.payload.type === "message_complete"
      ? event.payload.automaticContinuation?.recoveryId
      : undefined))).toEqual(new Set(recoveries
      .filter((event) => event.payload.type === "runtime_recovery" && event.payload.state === "running")
      .map((event) => event.payload.type === "runtime_recovery" ? event.payload.recoveryId : undefined)));
  });

  it("keeps a temporary route when the owner changes only effort and Fast", async () => {
    const adapter = new RuntimeRecoveryFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-axes",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime axes",
      providerId: "provider-a",
      modelId: "reasoner",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.setSessionRuntimeControl({
      sessionId,
      expectedGeneration: 0,
      patch: { providerId: "provider-b", modelId: "reasoner" }
    });

    const observed = await fixture.host.applyUserSessionRuntimeAxes(sessionId, {
      effort: "high",
      fastMode: false
    });
    const stored = fixture.store.getSession(sessionId);
    fixture.store.updateSession(sessionId, { effort: "high", fastMode: false }, stored.revision);

    expect(observed).toMatchObject({ providerId: "provider-b", modelId: "reasoner", effort: "high" });
    expect(fixture.host.getSessionRuntimeControl(sessionId)).toMatchObject({
      baseline: { providerId: "provider-a", modelId: "reasoner", effort: "high" },
      effective: { providerId: "provider-b", modelId: "reasoner", effort: "high" }
    });
  });

  it.each([
    ["Codex-shaped", switchWithoutFastProfile("switch-no-fast-a", false, false)],
    ["Claude-Code-shaped", switchWithoutFastProfile("switch-no-fast-b", true, true)]
  ])("switches models and restores legal overrides without touching unchanged axes for %s runtimes", async (_name, profile) => {
    const adapter = new SwitchWithoutFastFakeAdapter(profile);
    const fixture = await createFixture(adapter);
    const create = (operationId: string) => fixture.host.createSession({
      operationId,
      connection: fixture.connection,
      targetId: "target-one",
      title: operationId,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });

    const routedSessionId = (await create(`create-${profile.id}-runtime-route`)).value.sessionId;
    await expect(fixture.host.setSessionRuntimeControl({
      sessionId: routedSessionId,
      expectedGeneration: 0,
      patch: { providerId: "vision", modelId: "multimodal" }
    })).resolves.toMatchObject({ status: "applied" });

    const settingsSessionId = (await create(`create-${profile.id}-settings`)).value.sessionId;
    await expect(fixture.host.applySessionSettings(settingsSessionId, {
      providerId: "vision",
      modelId: "multimodal",
      effort: "medium",
      fastMode: false
    }, { requireNativeObservation: true })).resolves.toMatchObject({
      providerId: "vision",
      modelId: "multimodal",
      effort: "medium",
      fastMode: false
    });

    const overrideSessionId = (await create(`create-${profile.id}-override`)).value.sessionId;
    const queued = fixture.host.enqueueInput({
      operationId: `send-${profile.id}-override`,
      connection: fixture.connection,
      sessionId: overrideSessionId,
      prompt: { text: "switch once", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { providerId: "vision", modelId: "multimodal" }
    });
    await eventually(() =>
      fixture.store.getRun(queued.value.runId).descriptor.state === "completed" &&
      adapter.modelSelections.length === 4);
    await expect(fixture.host.inspect(overrideSessionId)).resolves.toMatchObject({
      providerId: "test",
      modelId: "text"
    });

    expect(adapter.modelSelections).toEqual([
      { providerId: "vision", modelId: "multimodal" },
      { providerId: "vision", modelId: "multimodal" },
      { providerId: "vision", modelId: "multimodal" },
      { providerId: "test", modelId: "text" }
    ]);
    expect(adapter.effortSelections).toEqual([]);
    expect(adapter.unsupportedControlCalls).toEqual([]);
    expect(adapter.resumeCalls).toBe(0);
    expect(adapter.closeCalls).toBe(0);
  });

  it("re-reads the exact resumed binding before applying settings to a sleeping runtime", async () => {
    const adapter = new SwitchWithoutFastFakeAdapter(
      switchWithoutFastProfile("sleeping-settings-generation", true, true)
    );
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-sleeping-settings-generation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Sleeping settings generation",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const before = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await fixture.host.closeIfActive(sessionId);

    await expect(fixture.host.applySessionSettings(sessionId, {
      providerId: "vision",
      modelId: "multimodal",
      permissionMode: "auto"
    }, { requireNativeObservation: true })).resolves.toMatchObject({
      providerId: "vision",
      modelId: "multimodal"
    });

    const current = fixture.store.getSession(sessionId).descriptor.binding.generation;
    expect(current).toBeGreaterThan(before);
    expect(adapter.modelContexts.at(-1)).toMatchObject({ sessionId, generation: current });
    expect(adapter.permissionContexts.at(-1)).toMatchObject({ sessionId, generation: current });
    expect(adapter.modelContexts.at(-1)?.backendInstanceGeneration).toBe(
      fixture.store.getBackend(adapter.id).descriptor.instanceGeneration
    );
  });

  it("rejects unsupported runtime and per-turn control axes before durable or Adapter mutation", async () => {
    const base = switchWithoutFastProfile("immutable-runtime-axes", false, false);
    const adapter = new SwitchWithoutFastFakeAdapter({
      ...base,
      capabilities: base.capabilities.map((capability) =>
        ["model.switch", "model.effort", "permission.change", "plan_mode"].includes(capability.key)
          ? { key: capability.key, supported: false, reason: "upstream_missing" }
          : capability)
    });
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-immutable-runtime-axes",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Immutable runtime axes",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    await expect(fixture.host.setSessionRuntimeControl({
      sessionId,
      expectedGeneration: 0,
      patch: { providerId: "vision", modelId: "multimodal" }
    })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
    expect(() => fixture.host.enqueueInput({
      operationId: "unsupported-model-override",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "model", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { providerId: "vision", modelId: "multimodal" }
    })).toThrow(expect.objectContaining({ publicError: expect.objectContaining({ code: "TURN_OVERRIDE_MODEL_UNSUPPORTED" }) }));
    expect(() => fixture.host.enqueueInput({
      operationId: "unsupported-effort-override",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "effort", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { effort: "high" }
    })).toThrow(expect.objectContaining({ publicError: expect.objectContaining({ code: "TURN_OVERRIDE_EFFORT_UNSUPPORTED" }) }));
    expect(() => fixture.host.enqueueInput({
      operationId: "unsupported-permission-override",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "permission", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { permissionMode: "auto" }
    })).toThrow(expect.objectContaining({ publicError: expect.objectContaining({ code: "TURN_OVERRIDE_PERMISSION_UNSUPPORTED" }) }));
    expect(() => fixture.host.enqueueInput({
      operationId: "unsupported-plan-override",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "plan", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { planMode: true }
    })).toThrow(expect.objectContaining({ publicError: expect.objectContaining({ code: "TURN_OVERRIDE_PLAN_MODE_UNSUPPORTED" }) }));
    await expect(fixture.host.applySessionSettings(sessionId, { permissionMode: "auto" }))
      .rejects.toMatchObject({ publicError: { code: "SESSION_PERMISSION_MODE_UNSUPPORTED" } });
    await expect(fixture.host.applySessionSettings(sessionId, { planMode: true }))
      .rejects.toMatchObject({ publicError: { code: "SESSION_PLAN_MODE_UNSUPPORTED" } });

    expect(fixture.store.listQueueItems({ sessionId })).toEqual([]);
    expect(adapter.modelSelections).toEqual([]);
    expect(adapter.effortSelections).toEqual([]);
    expect(adapter.unsupportedControlCalls).toEqual([]);
  });

  it("fails an unavailable same-model effort reset before activating a sleeping runtime", async () => {
    const base = switchWithoutFastProfile("no-effort-reset", true, false);
    const adapter = new SwitchWithoutFastFakeAdapter({
      ...base,
      models: base.models.map((model) => model.providerId === "test" && model.modelId === "text"
        ? { ...model, thinkingLevels: [] }
        : model)
    });
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-no-effort-reset",
      connection: fixture.connection,
      targetId: "target-one",
      title: "No effort reset",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.closeIfActive(sessionId);

    await expect(fixture.host.applyUserSessionRuntimeAxes(sessionId, { effort: null }))
      .rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
    expect(adapter.resumeCalls).toBe(0);
    expect(adapter.effortSelections).toEqual([]);
  });

  it("reconciles protocol-valid native history after service recovery without publishing replay or redispatching durable input", { timeout: 20_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-host-service-recovery-"));
    const store = new OperationalStore(join(directory, "store.db"));
    const repository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository,
      ingestRoots: [directory]
    });
    await artifacts.initialize();
    const nativeEntries: Record<string, unknown>[] = [];
    const processes: HostServiceRecoveryProcess[] = [];
    const piRoot = join(directory, "pi");
    const createAdapter = (recovering: boolean) => createPiAdapter({
      agentHome: join(piRoot, recovering ? "generation-2" : "generation-1"),
      sessionRoot: join(piRoot, "sessions"),
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      includeManagedSubagentTools: () => false,
      validateRemoteWorkspace: async () => undefined,
      processFactory: (spec) => {
        const processHandle = new HostServiceRecoveryProcess(spec, nativeEntries, { recovering });
        processes.push(processHandle);
        return processHandle;
      }
    });
    const firstAdapter = createAdapter(false);
    const firstHost = new SessionHost(store, artifacts, [firstAdapter]);
    let recoveredHost: SessionHost | undefined;
    try {
      await firstHost.initialize();
      const target = {
        id: "remote-target",
        backendId: "pi",
        displayName: "Remote target",
        workspaceRoot: "/workspace",
        remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" },
        managed: true,
        trusted: true
      } as const;
      await firstHost.registerTarget(target);
      const connection = store.createConnection({
        id: "service-recovery-connection",
        name: "Test device",
        authKeyDigest: "digest"
      });
      const sessionId = (await firstHost.createSession({
        operationId: "service-recovery-create",
        connection,
        targetId: target.id,
        title: "Service recovery",
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const dispatch = firstHost.enqueueInput({
        operationId: "service-recovery-input",
        connection,
        sessionId,
        prompt: {
          text: "persisted input",
          images: [],
          files: [],
          mentions: [],
          disposition: "prompt"
        }
      });
      await eventually(() => store.getQueueItem(dispatch.value.queueItemId).state === "backend_accepted");
      expect(store.getRun(dispatch.value.runId).descriptor.state).toBe("running");
      const recoveredAdapter = createAdapter(true);
      recoveredHost = new SessionHost(store, artifacts, [recoveredAdapter]);
      await recoveredHost.initialize();
      expect(store.getQueueItem(dispatch.value.queueItemId).state).toBe("dispatch_unknown");
      expect(store.getRun(dispatch.value.runId).descriptor.state).toBe("dispatch_unknown");
      await recoveredHost.inspect(sessionId);

      expect(processes).toHaveLength(2);
      expect(processes[0]!.spec.args).toContain("--session-id");
      expect(processes[1]!.spec.args).toContain("--session");
      expect(processes[1]!.spec.env.JOKO_PI_REMOTE_RECOVERY_IDENTITY)
        .toBe(processes[0]!.spec.env.JOKO_PI_REMOTE_RECOVERY_IDENTITY);
      expect(processes[0]!.spec.env.JOKO_PI_REMOTE_RECOVERY_IDENTITY).toMatch(/^[a-f0-9]{64}$/u);
      expect(processes[1]!.commands.filter((command: Record<string, unknown>) => command.type === "prompt")).toHaveLength(0);
      expect(store.getQueueItem(dispatch.value.queueItemId).state).toBe("completed");
      expect(store.getRun(dispatch.value.runId).descriptor.state).toBe("completed");
      expect(store.getAttempt(store.getRun(dispatch.value.runId).descriptor.activeAttemptId!).descriptor.error).toBeUndefined();
      const projectedText = store.listEvents({ sessionId })
        .filter((event) => event.payload.type === "message_complete")
        .flatMap((event) => event.payload.type === "message_complete"
          ? event.payload.blocks.filter((block) => block.kind === "text").map((block) => block.text)
          : []);
      expect(projectedText.filter((text) => text === "completed while service was unavailable")).toHaveLength(1);
      expect(projectedText).not.toContain("stale replay must remain private");
      expect(processes[1]!.commands.slice(0, 3).map((command: Record<string, unknown>) => command.type))
        .toEqual(["clear_queue", "abort", "get_state"]);
    } finally {
      await recoveredHost?.dispose().catch(() => undefined);
      await firstHost.dispose().catch(() => undefined);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "has no accepted native suffix",
      initialPrefix: false,
      mutate(entries: Record<string, unknown>[]) {
        entries.splice(0);
      }
    },
    {
      label: "has a different native user fingerprint",
      initialPrefix: true,
      mutate(entries: Record<string, unknown>[]) {
        const message = entries.at(-2)?.["message"];
        if (message !== null && typeof message === "object" && !Array.isArray(message)) {
          (message as Record<string, unknown>)["content"] = [{ type: "text", text: "different input" }];
        }
      }
    },
    {
      label: "has no terminal assistant entry",
      initialPrefix: true,
      mutate(entries: Record<string, unknown>[]) {
        entries.splice(entries.length - 1, 1);
      }
    }
  ])("keeps an uncertain dispatch fenced when recovered native history $label", { timeout: 20_000 }, async ({ initialPrefix, mutate }) => {
    const directory = mkdtempSync(join(tmpdir(), "joko-host-service-recovery-unsafe-"));
    const store = new OperationalStore(join(directory, "store.db"));
    const repository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository,
      ingestRoots: [directory]
    });
    await artifacts.initialize();
    const nativeEntries: Record<string, unknown>[] = initialPrefix ? [
      {
        type: "message",
        id: "service-recovery-prefix-user",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "existing history" }],
          timestamp: 1
        }
      },
      {
        type: "message",
        id: "service-recovery-prefix-assistant",
        parentId: "service-recovery-prefix-user",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "existing answer" }],
          api: "openai-completions",
          provider: "local",
          model: "test-model",
          usage: hostServiceZeroUsage(),
          stopReason: "stop",
          timestamp: 2
        }
      }
    ] : [];
    const processes: HostServiceRecoveryProcess[] = [];
    const piRoot = join(directory, "pi");
    const createAdapter = (recovering: boolean) => createPiAdapter({
      agentHome: join(piRoot, recovering ? "generation-2" : "generation-1"),
      sessionRoot: join(piRoot, "sessions"),
      versionProbe: async () => "pi 99.1.0",
      providers: [{
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        keyless: true,
        models: [{ id: "test-model", contextWindow: 32_768, maxTokens: 4_096 }]
      }],
      includeManagedSubagentTools: () => false,
      validateRemoteWorkspace: async () => undefined,
      processFactory: (spec) => {
        const processHandle = new HostServiceRecoveryProcess(spec, nativeEntries, { recovering });
        processes.push(processHandle);
        return processHandle;
      }
    });
    const firstHost = new SessionHost(store, artifacts, [createAdapter(false)]);
    let recoveredHost: SessionHost | undefined;
    try {
      await firstHost.initialize();
      const target = {
        id: "remote-target",
        backendId: "pi",
        displayName: "Remote target",
        workspaceRoot: "/workspace",
        remoteWorkspace: { hostId: "host-a", workspaceRoot: "/workspace" },
        managed: true,
        trusted: true
      } as const;
      await firstHost.registerTarget(target);
      const connection = store.createConnection({
        id: "service-recovery-connection",
        name: "Test device",
        authKeyDigest: "digest"
      });
      const sessionId = (await firstHost.createSession({
        operationId: "service-recovery-create",
        connection,
        targetId: target.id,
        title: "Service recovery",
        providerId: "local",
        modelId: "test-model",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const dispatch = firstHost.enqueueInput({
        operationId: "service-recovery-input",
        connection,
        sessionId,
        prompt: {
          text: "persisted input",
          images: [],
          files: [],
          mentions: [],
          disposition: "prompt"
        }
      });
      await eventually(() => store.getQueueItem(dispatch.value.queueItemId).state === "backend_accepted");
      mutate(nativeEntries);

      recoveredHost = new SessionHost(store, artifacts, [createAdapter(true)]);
      await recoveredHost.initialize();
      await recoveredHost.inspect(sessionId);

      expect(processes).toHaveLength(2);
      expect(processes[1]!.commands.filter((command) => command.type === "prompt")).toHaveLength(0);
      expect(store.getQueueItem(dispatch.value.queueItemId).state).toBe("dispatch_unknown");
      expect(store.getRun(dispatch.value.runId).descriptor.state).toBe("dispatch_unknown");
    } finally {
      await recoveredHost?.dispose().catch(() => undefined);
      await firstHost.dispose().catch(() => undefined);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a fresh reviewer after its inherited source route becomes disabled", async () => {
    let routeEnabled = true;
    const adapter = new BackgroundTaskRuntimeFakeAdapter();
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, {
      modelRoutingEnabled: () => routeEnabled,
      modelAccessRestricted: () => !routeEnabled
    });
    const sourceSessionId = (await fixture.host.createSession({
      operationId: "create-review-source-before-route-disabled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Review source",
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const created = fixture.store.createReviewRun({
      id: "review-disabled-route",
      sourceSessionId,
      targetKind: "task",
      evidenceSeal: reviewSeal(),
      attachments: []
    });
    routeEnabled = false;

    await expect(fixture.host.createFreshReviewer({
      reviewRunId: created.run.id,
      sourceSessionId,
      sourceLeaseFencingToken: created.sourceLease.fencingToken,
      targetId: "target-one",
      providerId: "test",
      modelId: "text",
      runtimePolicy: "review_read_only",
      nativeStart: { kind: "new" },
      permissionMode: "ask",
      planMode: false,
      fastMode: false
    })).rejects.toMatchObject({ publicError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).toHaveBeenCalledOnce();
  });

  it("admits a fresh reviewer only through its durable accepted queue and retains its isolated task timeline", async () => {
    const adapter = new BackgroundTaskRuntimeFakeAdapter();
    const fixture = await createFixture(adapter);
    const sourceSessionId = (await fixture.host.createSession({
      operationId: "create-review-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Review source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const created = fixture.store.createReviewRun({
      id: "review-host-run",
      sourceSessionId,
      targetKind: "task",
      evidenceSeal: reviewSeal(),
      attachments: []
    });
    const { reviewerSessionId } = await fixture.host.createFreshReviewer({
      reviewRunId: created.run.id,
      sourceSessionId,
      sourceLeaseFencingToken: created.sourceLease.fencingToken,
      targetId: "target-one",
      runtimePolicy: "review_read_only",
      nativeStart: { kind: "new" },
      permissionMode: "ask",
      planMode: false,
      fastMode: false
    });
    fixture.store.attachReviewSession({
      reviewRunId: created.run.id,
      reviewerSessionId,
      sourceLeaseFencingToken: created.sourceLease.fencingToken,
      expectedRunRevision: created.run.revision
    });
    const eventsBeforeDeniedPayloads = fixture.store.listEvents({ sessionId: reviewerSessionId }).length;
    for (const payload of [
      {
        type: "background_task" as const,
        taskId: "review-background-task",
        title: "Forbidden background work",
        state: "running"
      },
      {
        type: "subagent_run" as const,
        run: { ...portableWorkerRun(reviewerSessionId, 0), state: "running" as const, endedAt: undefined }
      }
    ]) {
      await expect(adapter.emitPayload(payload)).rejects.toMatchObject({
        publicError: { code: "REVIEW_RUNTIME_EVENT_DENIED", stateMayHaveChanged: false }
      });
    }
    expect(fixture.store.listEvents({ sessionId: reviewerSessionId })).toHaveLength(eventsBeforeDeniedPayloads);

    const dispatch = await fixture.host.enqueueInitialPrompt({
      operationId: "review-initial:review-host-run",
      reviewRunId: created.run.id,
      reviewerSessionId,
      prompt: { text: "review prompt", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await expect(dispatch.accepted).resolves.toBeUndefined();
    await expect(dispatch.outcome).resolves.toEqual({
      state: "completed",
      visibleResult: `Reply from ${fixture.adapter.id}: review prompt`
    });
    const payloadTypes = fixture.store.listEvents({ sessionId: reviewerSessionId }).map((event) => event.payload.type);
    expect(payloadTypes).toContain("queue_update");
    expect(payloadTypes).toContain("run_state");
    expect(payloadTypes).toContain("text_delta");
    expect(payloadTypes.filter((type) => type === "message_complete")).toHaveLength(2);
    const messages = fixture.store.listEvents({ sessionId: reviewerSessionId })
      .filter((event) => event.payload.type === "message_complete")
      .map((event) => event.payload);
    expect(messages).toEqual([
      { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "review prompt" }] },
      {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: `Reply from ${fixture.adapter.id}: review prompt` }]
      }
    ]);
    expect(fixture.store.listEvents({ sessionId: sourceSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.blocks.some((block) =>
        block.kind === "text" && block.text.includes("review prompt")
      )
    )).toBe(false);
    expect(() => fixture.host.enqueueInput({
      operationId: "forged-review-input",
      connection: fixture.connection,
      sessionId: reviewerSessionId,
      prompt: { text: "second prompt", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrow("host-owned Review queue");
    await expect(fixture.host.restart(reviewerSessionId)).rejects.toThrow("cannot be restarted");
    await expect(fixture.host.executeUserShell(reviewerSessionId, { command: "pwd", excludeFromContext: true }))
      .rejects.toThrow("shell execution is disabled");
    await expect(fixture.host.cancelBackgroundTask(reviewerSessionId, "review-background-task"))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_CANCEL_REVIEWER_DENIED" } });
    await fixture.host.closeReviewer(reviewerSessionId);

    const currentBackend = fixture.store.getBackend(fixture.adapter.id).descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: fixture.adapter.id,
      adapterKind: currentBackend.adapterKind
    });
    const replacement = new FakeBackendAdapter(PI_LIKE_PROFILE);
    await expect(fixture.host.replaceBackendInstance({
      backendId: fixture.adapter.id,
      expectedCurrentGeneration: currentBackend.instanceGeneration,
      perform: async (hooks) => {
        await hooks.preparePrevious(replacement, reservation.generation);
        const published = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...currentBackend, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: currentBackend.instanceGeneration
        });
        if (published.status !== "published") throw new Error("Fixture replacement publication lost its fence.");
        hooks.activateCurrent();
      }
    })).resolves.toBeUndefined();
    expect(fixture.host.currentAdapter(fixture.adapter.id)).toBe(replacement);
  });

  it("gates native discovery independently from native resume across fake Backend profiles", async () => {
    const resumable = await createFixture(new FakeBackendAdapter(PI_LIKE_PROFILE));
    await expect(resumable.host.listNativeSessions("target-one")).resolves.toMatchObject([
      { nativeSessionId: "native-resumable" }
    ]);

    const discoveryOnly = await createFixture(new FakeBackendAdapter(CODEX_LIKE_PROFILE));
    await expect(discoveryOnly.host.listNativeSessions("target-one")).resolves.toMatchObject([
      { nativeSessionId: "native-read-only" }
    ]);

    const undiscoverable = await createFixture(new FakeBackendAdapter(MINIMAL_PROFILE));
    await expect(undiscoverable.host.listNativeSessions("target-one"))
      .rejects.toMatchObject({ publicError: { code: "NATIVE_SESSION_DISCOVERY_UNSUPPORTED", phase: "capability" } });
  });

  it("caches completed native task scans while keeping refresh and invalidation generation-safe", async () => {
    let monotonicNow = 1_000;
    const adapter = new CatalogScanFakeAdapter();
    const fixture = await createFixture(adapter, { monotonicNow: () => monotonicNow });
    for (const [id, nativeReference] of [
      ["session-catalog-placement", "catalog://existing-placement"],
      ["session-catalog-binding", "catalog://existing-binding"]
    ] as const) {
      fixture.store.createSession({
        id,
        backendId: adapter.id,
        targetId: "target-one",
        title: id,
        binding: { opaqueRef: nativeReference, generation: 1 },
        pinned: false,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        createdAt: 1,
        updatedAt: 1
      });
    }
    const firstVisible = nativeCatalogResult("first").entries[0]!;
    const placementMismatch = {
      ...nativeCatalogResult("placement-mismatch").entries[0]!,
      nativeReference: "catalog://existing-placement",
      projectDirectory: undefined,
      placement: "dialogue" as const
    };
    const firstResult: NativeSessionCatalogResult = {
      entries: [
        firstVisible,
        placementMismatch,
        {
          ...nativeCatalogResult("binding").entries[0]!,
          nativeReference: "catalog://existing-binding",
          existingMatch: "binding"
        },
        {
          ...nativeCatalogResult("managed").entries[0]!,
          workingDirectory: fixture.directory,
          projectDirectory: undefined,
          placement: "dialogue"
        }
      ],
      rejectedCount: 0
    };
    const firstVisibleResult = { entries: [firstVisible, placementMismatch], rejectedCount: 0 };

    const first = fixture.host.scanNativeSessionCatalog(adapter.id);
    const joined = fixture.host.scanNativeSessionCatalog(adapter.id);
    expect(adapter.scans).toHaveLength(1);
    adapter.scans[0]!.resolve(firstResult);
    await expect(Promise.all([first, joined])).resolves.toEqual([firstVisibleResult, firstVisibleResult]);

    const authorized = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id);
    expect(authorized).toMatchObject({
      existingCount: 2,
      result: { entries: firstVisibleResult.entries }
    });

    await expect(fixture.host.scanNativeSessionCatalog(adapter.id)).resolves.toEqual(firstVisibleResult);
    expect(adapter.scans).toHaveLength(1);
    monotonicNow = 30_999;
    await expect(fixture.host.scanNativeSessionCatalog(adapter.id)).resolves.toEqual(firstVisibleResult);
    expect(adapter.scans).toHaveLength(1);

    monotonicNow = 31_000;
    const expiredScan = fixture.host.scanNativeSessionCatalog(adapter.id);
    const refreshedResult = nativeCatalogResult("refreshed");
    const forcedScan = fixture.host.scanNativeSessionCatalog(adapter.id, true);
    expect(adapter.scans).toHaveLength(3);
    adapter.scans[2]!.resolve(refreshedResult);
    await expect(forcedScan).resolves.toBe(refreshedResult);
    adapter.scans[1]!.resolve(nativeCatalogResult("stale"));
    await expect(expiredScan).rejects.toThrow(/superseded/u);

    await expect(fixture.host.scanNativeSessionCatalog(adapter.id)).resolves.toBe(refreshedResult);
    expect(adapter.scans).toHaveLength(3);
    fixture.host.invalidateNativeSessionCatalog(adapter.id);
    const invalidatedScan = fixture.host.scanNativeSessionCatalog(adapter.id);
    expect(adapter.scans).toHaveLength(4);
    const invalidatedResult = nativeCatalogResult("invalidated");
    adapter.scans[3]!.resolve(invalidatedResult);
    await expect(invalidatedScan).resolves.toBe(invalidatedResult);
  });

  it("replaces an active runtime once under the next product generation", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const closeSession = vi.spyOn(adapter, "closeSession");
    const resumeSession = vi.spyOn(adapter, "resumeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-restart-generation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime restart generation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const before = fixture.store.getSession(sessionId).descriptor.binding;

    await fixture.host.restart(sessionId);

    const after = fixture.store.getSession(sessionId).descriptor.binding;
    expect(after).toMatchObject({
      opaqueRef: before.opaqueRef,
      nativeSessionId: before.nativeSessionId,
      generation: before.generation + 1
    });
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(
      before,
      expect.objectContaining({ sessionId, generation: before.generation, binding: before })
    );
    expect(resumeSession).toHaveBeenCalledExactlyOnceWith(
      before,
      expect.objectContaining({ sessionId, generation: before.generation + 1 })
    );
    await expect(fixture.host.inspect(sessionId)).resolves.toMatchObject({
      binding: expect.objectContaining({ generation: before.generation + 1 })
    });
  });

  it("rejects runtime restart when durable background work is active", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-busy-runtime-restart",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Busy runtime restart",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const before = fixture.store.getSession(sessionId).descriptor.binding;
    appendSessionEvent(fixture.store, sessionId, "restart-background-running", 10, {
      type: "background_task",
      taskId: "restart-background",
      title: "Background",
      state: "running"
    });

    await expect(fixture.host.restart(sessionId)).rejects.toThrow(
      "only after every affected task has no active or queued work"
    );
    expect(closeSession).not.toHaveBeenCalled();
    expect(fixture.store.getSession(sessionId).descriptor.binding).toEqual(before);
  });

  it("keeps input accepted during restart fenced until the next runtime generation", async () => {
    const adapter = new GatedLifecycleCloseFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-restart-queue-fence",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime restart queue fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const beforeGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;
    adapter.closeArmed = true;

    const restarting = fixture.host.restart(sessionId);
    await adapter.closeGate.entered;
    const activeEffect = vi.fn(async () => undefined);
    await expect(fixture.host.applyToActiveSessions({ backendId: adapter.id }, activeEffect)).resolves.toEqual([]);
    expect(activeEffect).not.toHaveBeenCalled();
    const queued = fixture.host.enqueueInput({
      operationId: "accept-during-runtime-restart",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "dispatch after restart", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await nextTurn();
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(adapter.sendCalls).toBe(0);

    adapter.closeGate.release();
    await restarting;
    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
    expect(adapter.sendCalls).toBe(1);
    expect(fixture.store.getSession(sessionId).descriptor.binding.generation).toBe(beforeGeneration + 1);
  });

  it("rejects restart and Backend replacement while an admitted native setter is in flight", async () => {
    const adapter = new GatedNativeSetterFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-native-setter-replacement-fence",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Native setter replacement fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    adapter.gateSetName = true;
    const setting = fixture.host.setName(sessionId, "renamed");
    await adapter.setNameGate.entered;
    const current = fixture.store.getBackend(adapter.id).descriptor;
    const perform = vi.fn(async () => undefined);

    await expect(fixture.host.restart(sessionId)).rejects.toThrow(
      "only after every affected task has no active or queued work"
    );
    await expect(fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform
    })).rejects.toThrow("native side effect");
    expect(perform).not.toHaveBeenCalled();
    expect(adapter.closeCalls).toBe(0);

    adapter.setNameGate.release();
    await setting;
    expect(adapter.setNameCalls).toBe(1);
  });

  it("serializes process-wide Backend effects against replacement admission", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const fixture = await createFixture(adapter);
    const current = fixture.store.getBackend(adapter.id).descriptor;
    const effectGate = new AsyncGate();
    const backendEffect = vi.fn(async (ownedAdapter: BackendAdapter, generation: number) => {
      expect(ownedAdapter).toBe(adapter);
      expect(generation).toBe(current.instanceGeneration);
      effectGate.enter();
      await effectGate.wait;
      return "settled";
    });
    const pendingEffect = fixture.host.invokeBackendAdapter(adapter.id, backendEffect);
    await effectGate.entered;
    const blockedPerform = vi.fn(async () => undefined);

    await expect(fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: blockedPerform
    })).rejects.toThrow(/native side effect/iu);
    expect(blockedPerform).not.toHaveBeenCalled();

    effectGate.release();
    await expect(pendingEffect).resolves.toBe("settled");
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: adapter.id,
      adapterKind: current.adapterKind
    });
    const replacement = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const candidateGate = new AsyncGate();
    const replacing = fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: async (hooks) => {
        candidateGate.enter();
        await candidateGate.wait;
        await hooks.preparePrevious(replacement, reservation.generation);
        const published = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...current, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: current.instanceGeneration
        });
        if (published.status !== "published") throw new Error("Fixture replacement publication lost its fence.");
        hooks.activateCurrent();
      }
    });
    await candidateGate.entered;
    const fencedEffect = vi.fn(async () => undefined);
    await expect(fixture.host.invokeBackendAdapter(adapter.id, fencedEffect))
      .rejects.toThrow(/being replaced/iu);
    expect(fencedEffect).not.toHaveBeenCalled();

    candidateGate.release();
    await replacing;
    expect(fixture.host.currentAdapter(adapter.id)).toBe(replacement);
  });

  it("fences admission, switches the exact Backend instance, and restores previously active idle tasks", async () => {
    const previous = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const replacement = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const closePrevious = vi.spyOn(previous, "closeSession");
    const resumeReplacement = vi.spyOn(replacement, "resumeSession");
    const fixture = await createFixture(previous);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-backend-instance-replacement",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Backend instance replacement",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const beforeBinding = fixture.store.getSession(sessionId).descriptor.binding;
    const current = fixture.store.getBackend(previous.id).descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: previous.id,
      adapterKind: current.adapterKind
    });
    const candidateGate = new AsyncGate();

    const replacing = fixture.host.replaceBackendInstance({
      backendId: previous.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: async (hooks) => {
        candidateGate.enter();
        await candidateGate.wait;
        await hooks.preparePrevious(replacement, reservation.generation);
        const publication = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...current, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: current.instanceGeneration
        });
        if (publication.status !== "published") throw new Error("Fixture publication lost its generation fence.");
        const durableLookup = vi.spyOn(fixture.store, "getBackend").mockImplementation(() => {
          throw new Error("post-publication lookup must not occur during activation");
        });
        expect(() => hooks.activateCurrent()).not.toThrow();
        durableLookup.mockRestore();
      }
    });
    await candidateGate.entered;

    const fencedSetName = vi.spyOn(previous, "setName");
    await expect(fixture.host.setName(sessionId, "must not start"))
      .rejects.toThrow("process instance is being replaced");
    expect(fencedSetName).not.toHaveBeenCalled();

    expect(() => fixture.host.enqueueInput({
      operationId: "admission-during-backend-replacement",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "must not queue", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrow("process instance is being replaced");
    expect(fixture.store.findOperation("admission-during-backend-replacement")).toBeUndefined();

    candidateGate.release();
    await replacing;

    expect(fixture.host.currentAdapter(previous.id)).toBe(replacement);
    expect(closePrevious).toHaveBeenCalledWith(
      beforeBinding,
      expect.objectContaining({ backendInstanceGeneration: current.instanceGeneration })
    );
    expect(resumeReplacement).toHaveBeenCalledWith(
      beforeBinding,
      expect.objectContaining({ backendInstanceGeneration: reservation.generation })
    );
    const replacementBinding = fixture.store.getSession(sessionId).descriptor.binding;
    expect(replacementBinding.generation).toBe(beforeBinding.generation + 1);

    fixture.host.invalidateRuntime({
      backendId: previous.id,
      backendInstanceGeneration: current.instanceGeneration,
      sessionId,
      // Deliberately use the new runtime's product generation. The old
      // process callback must be fenced by Backend instance generation first.
      generation: replacementBinding.generation
    });
    expect(fixture.host.isSessionActive(sessionId)).toBe(true);

    fixture.host.invalidateRuntime({
      backendId: replacement.id,
      backendInstanceGeneration: reservation.generation,
      sessionId,
      generation: replacementBinding.generation
    });
    expect(fixture.host.isSessionActive(sessionId)).toBe(false);
  });

  it("hard-retires only the fenced old Adapter when an idle runtime close exceeds its deadline", async () => {
    const previous = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const replacement = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const closeGate = new AsyncGate();
    vi.spyOn(previous, "closeSession").mockImplementation(async () => {
      closeGate.enter();
      await closeGate.wait;
    });
    const forceDispose = vi.fn(async () => { closeGate.release(); });
    Object.defineProperty(previous, "forceDispose", { value: forceDispose });
    const fixture = await createFixture(previous, { backendRetirementTimeoutMs: 5 });
    const sessionId = (await fixture.host.createSession({
      operationId: "create-hung-backend-retirement",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Hung Backend retirement",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const current = fixture.store.getBackend(previous.id).descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: previous.id,
      adapterKind: current.adapterKind
    });

    await expect(fixture.host.replaceBackendInstance({
      backendId: previous.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: async (hooks) => {
        await hooks.preparePrevious(replacement, reservation.generation);
        const publication = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...current, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: current.instanceGeneration
        });
        if (publication.status !== "published") throw new Error("Fixture publication lost its generation fence.");
        hooks.activateCurrent();
      }
    })).resolves.toBeUndefined();

    await closeGate.entered;
    expect(forceDispose).toHaveBeenCalledOnce();
    expect(fixture.host.currentAdapter(previous.id)).toBe(replacement);
    expect(fixture.host.isSessionActive(sessionId)).toBe(true);
    expect(fixture.store.getBackend(previous.id).descriptor.instanceGeneration).toBe(reservation.generation);
  });

  it("never labels a late old-Adapter resume as the newly published Backend generation", async () => {
    const adapter = new GatedResumeFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-activation-instance-race",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Activation instance race",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.closeIfActive(sessionId);
    const activation = fixture.host.inspect(sessionId);
    await adapter.resumeGate.entered;

    advanceBackendInstanceGeneration(fixture.store, adapter.id);
    adapter.resumeGate.release();

    await expect(activation).rejects.toThrow("process instance changed while native activation was in progress");
    expect(fixture.host.isSessionActive(sessionId)).toBe(false);
    expect(adapter.resumeContexts).toHaveLength(1);
    expect(adapter.resumeContexts[0]?.backendInstanceGeneration).toBe(0);
  });

  it("restores every detached idle task when previous-instance preparation fails", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const fixture = await createFixture(adapter);
    const sessionIds: string[] = [];
    for (const ordinal of [1, 2]) {
      sessionIds.push((await fixture.host.createSession({
        operationId: `create-backend-prepare-failure-${ordinal}`,
        connection: fixture.connection,
        targetId: "target-one",
        title: `Backend prepare failure ${ordinal}`,
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId);
    }
    const resume = vi.spyOn(adapter, "resumeSession");
    const nativeClose = adapter.closeSession.bind(adapter);
    let closeCalls = 0;
    vi.spyOn(adapter, "closeSession").mockImplementation(async (binding, context) => {
      closeCalls += 1;
      if (closeCalls === 2) throw new Error("prepare close failed");
      await nativeClose(binding, context);
    });
    const current = fixture.store.getBackend(adapter.id).descriptor;

    await expect(fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: async (hooks) => {
        await hooks.preparePrevious(adapter, current.instanceGeneration + 1);
        throw new Error("must not publish");
      }
    })).rejects.toThrow("prepare close failed");

    expect(fixture.host.currentAdapter(adapter.id)).toBe(adapter);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(sessionIds.every((sessionId) => fixture.host.isSessionActive(sessionId))).toBe(true);
    expect(fixture.store.getBackend(adapter.id).descriptor.instanceGeneration).toBe(current.instanceGeneration);
  });

  it("returns only a durable, identity-matching Session export BlobRef", async () => {
    const fixture = await createFixture();
    const sessionId = (await fixture.host.createSession({
      operationId: "create-export-validation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Export validation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const sourcePath = join(fixture.directory, "session-export.html");
    writeFileSync(sourcePath, "<!doctype html><title>Export validation</title>");
    const exportSession = vi.spyOn(fixture.adapter, "exportSession").mockImplementation((context) =>
      context.storeArtifact(sourcePath, { fileName: "session-export.html", mimeType: "text/html" })
    );

    const artifact = await fixture.host.exportSession(sessionId);
    expect(artifact).toEqual(fixture.store.getArtifact(artifact.id).blob);

    exportSession.mockResolvedValue({ ...artifact, sha256: "f".repeat(64) });
    await expect(fixture.host.exportSession(sessionId)).rejects.toThrow(
      "Session export Blob reference does not match the durable Artifact."
    );

    exportSession.mockResolvedValue({ ...artifact, id: "missing-export-artifact" });
    await expect(fixture.host.exportSession(sessionId)).rejects.toThrow("Artifact does not exist or has expired.");
  });

  it("exports a password-protected portable task with native and product history", async () => {
    const adapter = new PortableFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-portable-export",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Portable export",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const session = fixture.store.getSession(sessionId).descriptor;
    fixture.store.appendEvent({
      backendId: session.backendId,
      targetId: session.targetId,
      sessionId,
      generation: session.binding.generation,
      traceId: "portable-export-message",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "portable history" }]
      }
    });
    fixture.store.appendEvent({
      backendId: session.backendId,
      targetId: session.targetId,
      sessionId,
      generation: session.binding.generation,
      traceId: "portable-export-internal-continuation",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Continue internally" }],
        automaticContinuation: { recoveryId: "portable-recovery" }
      }
    });

    const result = await fixture.host.exportPortableSession({
      sessionId,
      password: "correct horse battery staple",
      applicationVersion: "1.2.3"
    });
    expect(result).toMatchObject({ fidelity: "full", messageCount: 1, mediaCount: 0, workerCount: 0 });
    expect(fixture.store.getArtifact(result.artifact.id).blob).toEqual(result.artifact);
    const encoded = await fixture.artifacts.readBlob(result.artifact);
    const decoded = decodePortableSessionPackage(encoded.data, { password: "correct horse battery staple" });
    expect(decoded.manifest).toMatchObject({
      applicationVersion: "1.2.3",
      title: "Portable export",
      backendCapability: "native-portable-session-v1",
      nativeHistoryEntry: "native/main.jsonl"
    });
    const projection = decodePortableSessionProjection(
      decoded.entries.find((entry) => entry.path === "projection/messages.json")!.bytes
    );
    expect(projection.messages).toEqual([expect.objectContaining({
      role: "user",
      blocks: [{ kind: "text", text: "portable history" }]
    })]);
  });

  it("exports exactly 256 delegated runs and fails typed for the 257th instead of silently clipping collaboration history", async () => {
    const fixture = await createFixture(new PortableFakeAdapter());
    const sessionId = (await fixture.host.createSession({
      operationId: "create-portable-workers",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Portable workers",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const requests: Array<{ readonly pageToken?: string; readonly limit?: number }> = [];
    let total = 256;
    const listing = vi.spyOn(fixture.store, "listSubagentRuns").mockImplementation((input) => {
      requests.push({ pageToken: input.pageToken, limit: input.limit });
      const offset = Number(input.pageToken ?? "0");
      const count = Math.min(input.limit ?? 100, total - offset);
      const next = offset + count;
      return {
        runs: Array.from({ length: count }, (_, index) => portableWorkerRun(sessionId, offset + index)),
        ...(next < total ? { nextPageToken: String(next) } : {}),
        totalSize: total,
        snapshotCursor: 1n
      };
    });
    try {
      const result = await fixture.host.exportPortableSession({ sessionId });
      expect(result.workerCount).toBe(total);
      expect(requests).toEqual([
        { pageToken: undefined, limit: 100 },
        { pageToken: "100", limit: 100 },
        { pageToken: "200", limit: 56 }
      ]);
      const encoded = await fixture.artifacts.readBlob(result.artifact);
      const decoded = decodePortableSessionPackage(encoded.data);
      expect(decoded.manifest.workers).toHaveLength(total);
      const collaboration = JSON.parse(Buffer.from(decoded.entries.find((entry) => entry.path === "collaboration/workers.json")!.bytes).toString("utf8")) as { readonly detail: readonly unknown[] };
      expect(collaboration.detail).toHaveLength(total);
      expect(collaboration.detail.at(-1)).toMatchObject({ id: "worker-255" });

      requests.length = 0;
      total = 257;
      await expect(fixture.host.exportPortableSession({ sessionId })).rejects.toMatchObject({
        publicError: { code: "PORTABLE_SESSION_EXPORT_FORMAT_LIMIT_EXCEEDED", stateMayHaveChanged: false }
      });
      expect(requests).toEqual([{ pageToken: undefined, limit: 100 }]);
    } finally {
      listing.mockRestore();
    }
  });

  it("exports exactly 100000 messages and returns a typed failure for the 100001st", { timeout: 30_000 }, async () => {
    const adapter = new PortableFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-portable-boundary",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Portable boundary",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "portable-boundary-source", 1, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "x" }]
    });
    const source = fixture.store.findEvent("portable-boundary-source")!;
    let total = 100_000;
    const queries: Array<{ readonly afterCursor?: bigint; readonly limit?: number }> = [];
    const history = vi.spyOn(fixture.store, "listEvents").mockImplementation((query = {}) => {
      queries.push(query);
      const offset = Number(query.afterCursor ?? 0n);
      const count = Math.min(query.limit ?? 1_000, Math.max(0, total - offset));
      if (count === 0) return [];
      const pageEvent = { ...source, globalCursor: BigInt(offset + count) };
      return Array<PersistedEvent>(count).fill(pageEvent);
    });
    try {
      await expect(fixture.host.exportPortableSession({ sessionId })).resolves.toMatchObject({
        messageCount: 100_000
      });
      expect(queries.map((query) => query.afterCursor)).toEqual([undefined, 100_000n]);

      queries.length = 0;
      total = 100_001;
      await expect(fixture.host.exportPortableSession({ sessionId })).rejects.toMatchObject({
        publicError: { code: "PORTABLE_SESSION_EXPORT_FORMAT_LIMIT_EXCEEDED", stateMayHaveChanged: false }
      });
      expect(queries.map((query) => query.afterCursor)).toEqual([undefined, 100_000n]);
    } finally {
      history.mockRestore();
    }
  });

  it("imports a portable task exactly once, rejects duplicates, and replaces only when explicit", async () => {
    const adapter = new PortableFakeAdapter();
    const fixture = await createFixture(adapter);
    const sourceSessionId = (await fixture.host.createSession({
      operationId: "create-portable-import-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Portable import source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const source = fixture.store.getSession(sourceSessionId).descriptor;
    fixture.store.appendEvent({
      backendId: source.backendId,
      targetId: source.targetId,
      sessionId: sourceSessionId,
      generation: source.binding.generation,
      traceId: "portable-import-source-message",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "restored history" }]
      }
    });
    const exported = await fixture.host.exportPortableSession({
      sessionId: sourceSessionId,
      password: "correct horse battery staple"
    });
    const request = {
      operationId: "import-portable-task",
      connection: fixture.connection,
      targetId: "target-one",
      package: exported.artifact,
      password: "correct horse battery staple",
      title: "Restored portable task",
      fastMode: false,
      permissionMode: "ask" as const,
      planMode: false,
      overwrite: false
    };

    await expect(fixture.host.importPortableSession({ ...request, password: "wrong password value" }))
      .rejects.toThrow();
    expect(fixture.store.findOperation(request.operationId)).toBeUndefined();

    const cancelledDraft = await fixture.host.inspectPortableSessionImport({
      connection: fixture.connection,
      package: exported.artifact
    });
    fixture.host.cancelPortableSessionImport({ connection: fixture.connection, draftId: cancelledDraft.draftId });
    await expect(fixture.host.unlockPortableSessionImport({
      connection: fixture.connection,
      draftId: cancelledDraft.draftId,
      password: request.password
    })).rejects.toMatchObject({ publicError: { code: "PORTABLE_SESSION_DRAFT_EXPIRED" } });

    const draft = await fixture.host.inspectPortableSessionImport({
      connection: fixture.connection,
      package: exported.artifact
    });
    expect(draft).toMatchObject({ encrypted: true, passwordRequired: true });
    expect(draft.preview).toBeUndefined();
    await expect(fixture.host.unlockPortableSessionImport({
      connection: fixture.connection,
      draftId: draft.draftId,
      password: "wrong password value"
    })).rejects.toThrow();
    const unlocked = await fixture.host.unlockPortableSessionImport({
      connection: fixture.connection,
      draftId: draft.draftId,
      password: request.password
    });
    expect(unlocked).toMatchObject({
      encrypted: true,
      passwordRequired: false,
      preview: {
        title: "Portable import source",
        workspaceKind: "dialogue",
        fidelity: "full",
        messageCount: 1,
        mediaCount: 0,
        workerCount: 0,
        nativeHistory: true
      }
    });

    const imported = await fixture.host.commitPortableSessionImport({
      operationId: request.operationId,
      connection: request.connection,
      draftId: draft.draftId,
      targetId: request.targetId,
      title: request.title,
      fastMode: request.fastMode,
      permissionMode: request.permissionMode,
      planMode: request.planMode,
      overwrite: request.overwrite
    });
    expect(imported).toMatchObject({
      replayed: false,
      value: {
        fidelity: "full",
        messageCount: 1,
        mediaCount: 0,
        workerCount: 0,
        replacedSessionIds: []
      }
    });
    const importedSession = fixture.store.getSession(imported.value.sessionId).descriptor;
    expect(importedSession.title).toBe("Restored portable task");
    expect(adapter.importedNativeText).toEqual(["{\"type\":\"session\",\"id\":\"portable-native\"}\n"]);
    expect(fixture.store.listEvents({ sessionId: imported.value.sessionId })
      .filter((event) => event.payload.type === "message_complete")
      .map((event) => event.payload)).toEqual([{
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "restored history" }]
      }]);
    expect(JSON.stringify(fixture.store.getOperation(request.operationId).body)).not.toContain(request.password);

    await expect(fixture.host.importPortableSession(request)).resolves.toMatchObject({
      replayed: true,
      value: { sessionId: imported.value.sessionId }
    });
    expect(adapter.importedNativeText).toHaveLength(1);

    await expect(fixture.host.importPortableSession({
      ...request,
      operationId: "import-portable-task-duplicate"
    })).rejects.toMatchObject({ publicError: { code: "PORTABLE_SESSION_IMPORT_CONFLICT" } });

    const replacement = await fixture.host.importPortableSession({
      ...request,
      operationId: "import-portable-task-replacement",
      title: "Replaced portable task",
      overwrite: true
    });
    expect(replacement.value.replacedSessionIds).toEqual([imported.value.sessionId]);
    expect(fixture.store.getSession(imported.value.sessionId).descriptor.deletedAt).toEqual(expect.any(Number));
    expect(fixture.store.getSession(replacement.value.sessionId).descriptor.title).toBe("Replaced portable task");
    expect(adapter.importedNativeText).toHaveLength(2);
  });

  it("rejects a product-only portable import before creating a disabled model route", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const createNative = vi.spyOn(adapter, "createSession");
    const fixture = await createFixture(adapter, { modelRoutingEnabled: () => false });
    const encoded = encodePortableSessionPackage({
      manifest: createPortableSessionManifest({
        exportedAt: new Date(1_800_000_000_000).toISOString(),
        applicationVersion: "test",
        title: "Product-only package",
        workspaceKind: "dialogue",
        backendCapability: "product-history",
        fidelity: "product_only",
        messageCount: 0,
        mediaCount: 0
      }),
      entries: [{
        path: "projection/messages.json",
        kind: "projection",
        mediaType: "application/json",
        bytes: encodePortableSessionProjection({ format: 1, messages: [] })
      }]
    });
    const portablePackage = await fixture.artifacts.ingestBytes(encoded, {
      fileName: "product-only.joko-session",
      mimeType: "application/octet-stream"
    });

    await expect(fixture.host.importPortableSession({
      operationId: "import-disabled-product-only-route",
      connection: fixture.connection,
      targetId: "target-one",
      package: portablePackage,
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      overwrite: false
    })).rejects.toMatchObject({ storedError: { code: "MODEL_ACCESS_DISABLED", stateMayHaveChanged: false } });
    expect(createNative).not.toHaveBeenCalled();
  });

  it("persists a native import activation failure and retries activation without creating another task", async () => {
    const adapter = new PortableFakeAdapter();
    const fixture = await createFixture(adapter);
    const sourceSessionId = (await fixture.host.createSession({
      operationId: "create-portable-recovery-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Portable recovery source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const exported = await fixture.host.exportPortableSession({ sessionId: sourceSessionId });
    const request = {
      operationId: "import-portable-recovery",
      connection: fixture.connection,
      targetId: "target-one",
      package: exported.artifact,
      title: "Imported recovery task",
      fastMode: false,
      permissionMode: "ask" as const,
      planMode: false,
      overwrite: false
    };

    adapter.portableActivationFailuresRemaining = 1;
    const imported = await fixture.host.importPortableSession(request);
    expect(imported.value).toMatchObject({
      status: "imported_activation_failed",
      activationError: {
        code: "PORTABLE_SESSION_ACTIVATION_FAILED",
        message: "portable activation unavailable for [REDACTED]"
      }
    });
    const importedSessionId = imported.value.sessionId;
    const sessionCount = fixture.store.listSessions({ includeArchived: true, includeDeleted: true }).length;
    expect(adapter.importedNativeText).toHaveLength(1);

    await expect(fixture.host.retryPortableSessionActivation({
      connection: fixture.connection,
      sessionId: importedSessionId
    })).resolves.toEqual({ sessionId: importedSessionId, status: "ready" });
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(sessionCount);

    await expect(fixture.host.importPortableSession(request)).resolves.toMatchObject({
      replayed: true,
      value: { sessionId: importedSessionId, status: "ready" }
    });
    expect(adapter.importedNativeText).toHaveLength(1);
  });

  it("executes user shell capability without Backend identity branches and fences concurrent generations", async () => {
    const adapter = new GatedUserShellFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-user-shell",
      connection: fixture.connection,
      targetId: "target-one",
      title: "User shell",
      fastMode: false,
      permissionMode: "bypassPermissions",
      planMode: false
    })).value.sessionId;

    const first = fixture.host.executeUserShell(sessionId, { command: "  pwd  ", excludeFromContext: true });
    await adapter.waitForStart();
    expect(adapter.inputs).toEqual([{ command: "pwd", excludeFromContext: true }]);
    await expect(fixture.host.executeUserShell(sessionId, { command: "echo second", excludeFromContext: false }))
      .rejects.toMatchObject({ publicError: { code: "USER_SHELL_ALREADY_RUNNING" } });

    await fixture.host.abortUserShell(sessionId);
    await fixture.host.abortUserShell(sessionId);
    await expect(first).resolves.toMatchObject({ cancelled: true });
    expect(adapter.abortCount).toBe(1);

    const stale = fixture.host.executeUserShell(sessionId, { command: "echo stale", excludeFromContext: false });
    await adapter.waitForStart(2);
    const oldGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;
    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration: fixture.store.getBackend(adapter.id).descriptor.instanceGeneration,
      sessionId,
      generation: oldGeneration
    });
    await fixture.host.resume(sessionId);
    adapter.complete({ output: "late", exitCode: 0, cancelled: false, truncated: false });
    await expect(stale).rejects.toMatchObject({
      name: "StaleGenerationError",
      expected: oldGeneration,
      received: oldGeneration + 1
    });
  });

  it("gates user shell by capability and applies ask/auto/bypass policy without exposing the command", async () => {
    const unsupported = await createFixture(new FakeBackendAdapter(CODEX_LIKE_PROFILE));
    const unsupportedSession = (await unsupported.host.createSession({
      operationId: "create-user-shell-unsupported",
      connection: unsupported.connection,
      targetId: "target-one",
      title: "Unsupported shell",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await expect(unsupported.host.executeUserShell(unsupportedSession, { command: "pwd", excludeFromContext: false }))
      .rejects.toMatchObject({ publicError: { code: "USER_SHELL_UNSUPPORTED" } });

    const policyAdapter = new GatedUserShellFakeAdapter();
    const policy = await createFixture(policyAdapter);
    const policySession = (await policy.host.createSession({
      operationId: "create-user-shell-policy",
      connection: policy.connection,
      targetId: "target-one",
      title: "Policy shell",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const asked = policy.host.executeUserShell(policySession, { command: "pwd", excludeFromContext: false });
    await eventually(() => policy.store.listInteractions({ sessionId: policySession, status: "open" }).length === 1);
    expect(policyAdapter.inputs).toEqual([]);
    await expect(policy.host.executeUserShell(policySession, { command: "git status", excludeFromContext: false }))
      .rejects.toMatchObject({ publicError: { code: "USER_SHELL_ALREADY_RUNNING" } });
    const permission = policy.store.listInteractions({ sessionId: policySession, status: "open" })[0]!;
    expect(permission.payload).toMatchObject({
      kind: "permission",
      toolName: "bash",
      risk: "low",
      choices: ["allow_once", "deny_once"]
    });
    expect(JSON.stringify(permission.payload)).not.toContain("pwd");
    policy.host.resolveInteraction(
      permission.id,
      permission.generation,
      { kind: "selected", value: "allow_once" },
      "allow-user-shell"
    );
    await policyAdapter.waitForStart();
    policyAdapter.complete({ output: "safe", exitCode: 0, cancelled: false, truncated: false });
    await expect(asked).resolves.toMatchObject({ output: "safe" });

    const policyStored = policy.store.getSession(policySession);
    policy.store.updateSession(policySession, { permissionMode: "auto" }, policyStored.revision);
    await policy.host.applySessionSettings(policySession, { permissionMode: "auto" });
    const safeAuto = policy.host.executeUserShell(policySession, { command: "git status", excludeFromContext: true });
    await policyAdapter.waitForStart(2);
    expect(policy.store.listInteractions({ sessionId: policySession, status: "open" })).toHaveLength(0);
    policyAdapter.complete({ output: "clean", exitCode: 0, cancelled: false, truncated: false });
    await expect(safeAuto).resolves.toMatchObject({ output: "clean" });

    const denied = policy.host.executeUserShell(policySession, { command: "npm install", excludeFromContext: false });
    const denial = expect(denied).rejects.toMatchObject({ publicError: { code: "USER_SHELL_PERMISSION_DENIED" } });
    await eventually(() => policy.store.listInteractions({ sessionId: policySession, status: "open" }).length === 1);
    const ambiguous = policy.store.listInteractions({ sessionId: policySession, status: "open" })[0]!;
    expect(ambiguous.payload).toMatchObject({ kind: "permission", risk: "medium" });
    policy.host.resolveInteraction(
      ambiguous.id,
      ambiguous.generation,
      { kind: "selected", value: "deny_once" },
      "deny-user-shell"
    );
    await denial;
    expect(policyAdapter.inputs).toHaveLength(2);
  });

  it("hot-applies ordered owner rules to active user shell authorization and revokes stale approval", async () => {
    const adapter = new GatedUserShellFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-user-shell-ordered-policy",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Ordered policy shell",
      fastMode: false,
      permissionMode: "bypassPermissions",
      planMode: false
    })).value.sessionId;
    const replaceRule = async (effect: contract.PolicyEffect): Promise<void> => {
      fixture.store.setSetting("service", "orchestrator", "settings.policy", create(contract.PolicySettingsSchema, {
        rules: [create(contract.PolicyRuleSchema, {
          policyRuleId: "workspace-command",
          effect,
          subjectKind: contract.PolicySubjectKind.COMMAND,
          toolName: "bash",
          ceiling: contract.PermissionRisk.CRITICAL,
          enabled: true,
          priority: 10
        })]
      }));
      await fixture.host.refreshPolicySettings();
    };

    await replaceRule(contract.PolicyEffect.ASK);
    expect(adapter.policySnapshots.at(-1)?.rules).toEqual([
      expect.objectContaining({ id: "workspace-command", effect: "ask", subjectKind: "command" })
    ]);
    const pending = fixture.host.executeUserShell(sessionId, { command: "npm install", excludeFromContext: false });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    expect(adapter.inputs).toHaveLength(0);

    await replaceRule(contract.PolicyEffect.ALLOW);
    await expect(pending).rejects.toMatchObject({ publicError: { code: "USER_SHELL_POLICY_CHANGED" } });
    expect(fixture.store.listInteractions({ sessionId, status: "open" })).toHaveLength(0);

    const allowed = fixture.host.executeUserShell(sessionId, { command: "npm install", excludeFromContext: true });
    await adapter.waitForStart();
    adapter.complete({ output: "installed", exitCode: 0, cancelled: false, truncated: false });
    await expect(allowed).resolves.toMatchObject({ output: "installed" });

    await replaceRule(contract.PolicyEffect.DENY);
    await expect(fixture.host.executeUserShell(sessionId, { command: "pwd", excludeFromContext: false }))
      .rejects.toMatchObject({ publicError: { code: "USER_SHELL_PERMISSION_DENIED" } });
    expect(adapter.inputs).toHaveLength(1);
  });

  it("runs one user shell concurrently with both an active and newly dispatched Run", async () => {
    const adapter = new GatedUserShellFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-concurrent-shell",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Concurrent shell",
      fastMode: false,
      permissionMode: "bypassPermissions",
      planMode: false
    })).value.sessionId;

    fixture.store.createRun({
      id: "active-run-before-user-shell",
      sessionId,
      source: "user",
      state: "running",
      createdAt: Date.now(),
      startedAt: Date.now()
    });
    const shellDuringRun = fixture.host.executeUserShell(sessionId, { command: "pwd", excludeFromContext: false });
    await adapter.waitForStart();
    adapter.complete({ output: "during run", exitCode: 0, cancelled: false, truncated: false });
    await expect(shellDuringRun).resolves.toMatchObject({ output: "during run" });
    fixture.store.updateRunState({ runId: "active-run-before-user-shell", state: "completed", traceId: "complete-test-run" });

    const shellBeforeRun = fixture.host.executeUserShell(sessionId, { command: "git status", excludeFromContext: true });
    await adapter.waitForStart(2);
    const queued = fixture.host.enqueueInput({
      operationId: "dispatch-during-shell",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "run alongside shell", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.sendCalls === 1);
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).not.toBe("accepted");
    expect(adapter.sendCalls).toBe(1);
    adapter.complete({ output: "alongside dispatch", exitCode: 0, cancelled: false, truncated: false });
    await expect(shellBeforeRun).resolves.toMatchObject({ output: "alongside dispatch" });
  });

  it("settles prompt, joined steer, and Pi follow-up Runs exactly once without crossing output events", async () => {
    const adapter = new SingleSettlementFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-continuation-lifecycle",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Continuation lifecycle",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const prompt = fixture.host.enqueueInput({
      operationId: "continuation-prompt",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "initial", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    const steer = fixture.host.enqueueInput({
      operationId: "continuation-steer",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "steer", images: [], files: [], mentions: [], disposition: "steer" }
    });
    const followUp = fixture.host.enqueueInput({
      operationId: "continuation-follow-up",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "follow", images: [], files: [], mentions: [], disposition: "follow_up" }
    });

    await eventually(() => [prompt, steer, followUp].every((execution) =>
      fixture.store.getQueueItem(execution.value.queueItemId).state === "backend_accepted"));
    await adapter.emitAcceptedUserMessages(sessionId);
    expect(new Map(fixture.store.listEvents({ sessionId })
      .filter((event) => event.payload.type === "message_complete" && event.payload.role === "user")
      .map((event) => [event.runId, event.payload.type === "message_complete" ? event.payload.inputDelivery : undefined])))
      .toEqual(new Map([
        [prompt.value.runId, "prompt"],
        [steer.value.runId, "steer"],
        [followUp.value.runId, "follow_up"]
      ]));
    await adapter.settle(sessionId);
    await eventually(() => [prompt, steer, followUp].every((execution) =>
      fixture.store.getRun(execution.value.runId).descriptor.state === "completed"));

    expect(adapter.nativeSettlements).toBe(1);
    for (const execution of [prompt, steer, followUp]) {
      expect(fixture.store.getQueueItem(execution.value.queueItemId).state).toBe("completed");
      expect(fixture.store.listEvents({ sessionId }).filter((event) =>
        event.runId === execution.value.runId && event.payload.type === "done")).toHaveLength(1);
    }
    const outputRuns = fixture.store.listEvents({ sessionId })
      .filter((event) => event.payload.type === "text_delta")
      .map((event) => event.runId);
    expect(outputRuns).toEqual([prompt.value.runId, prompt.value.runId, followUp.value.runId]);
    expect(outputRuns).not.toContain(steer.value.runId);
  });

  it("turns an idle steer/follow-up into typed terminal failures instead of stranded native queues", async () => {
    const adapter = new SingleSettlementFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-idle-continuation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Idle continuation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const inputs = (["steer", "follow_up"] as const).map((disposition) => fixture.host.enqueueInput({
      operationId: `idle-${disposition}`,
      connection: fixture.connection,
      sessionId,
      prompt: { text: disposition, images: [], files: [], mentions: [], disposition }
    }));

    await eventually(() => inputs.every((execution) =>
      fixture.store.getRun(execution.value.runId).descriptor.state === "failed"));
    expect(inputs.map((execution) => fixture.store.getRun(execution.value.runId).descriptor.error?.code)).toEqual([
      "PI_STEER_REQUIRES_ACTIVE_RUN",
      "PI_FOLLOW_UP_REQUIRES_ACTIVE_RUN"
    ]);
    expect(inputs.map((execution) => fixture.store.getQueueItem(execution.value.queueItemId).state)).toEqual(["failed", "failed"]);
  });

  it("fans abort across every participant in the shared native lifecycle", async () => {
    const adapter = new SingleSettlementFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-aborted-continuation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Abort continuation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const executions = (["prompt", "steer", "follow_up"] as const).map((disposition) => fixture.host.enqueueInput({
      operationId: `abort-${disposition}`,
      connection: fixture.connection,
      sessionId,
      prompt: { text: disposition, images: [], files: [], mentions: [], disposition }
    }));
    await eventually(() => executions.every((execution) =>
      fixture.store.getQueueItem(execution.value.queueItemId).state === "backend_accepted"));

    await fixture.host.abort(sessionId, executions[0]!.value.runId);
    await eventually(() => executions.every((execution) =>
      fixture.store.getRun(execution.value.runId).descriptor.state === "aborted"));
    expect(adapter.nativeSettlements).toBe(1);
    expect(executions.map((execution) => fixture.store.getQueueItem(execution.value.queueItemId).state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled"
    ]);
  });

  it("keeps an uncertain joined dispatch fenced while settling the known prompt and follow-up", async () => {
    const adapter = new SingleSettlementFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-uncertain-continuation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Uncertain continuation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const prompt = fixture.host.enqueueInput({
      operationId: "uncertain-continuation-prompt",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "prompt", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(prompt.value.queueItemId).state === "backend_accepted");
    adapter.failNextSteerUncertain = true;
    const steer = fixture.host.enqueueInput({
      operationId: "uncertain-continuation-steer",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "steer", images: [], files: [], mentions: [], disposition: "steer" }
    });
    const followUp = fixture.host.enqueueInput({
      operationId: "uncertain-continuation-follow-up",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "follow", images: [], files: [], mentions: [], disposition: "follow_up" }
    });
    await eventually(() => fixture.store.getQueueItem(steer.value.queueItemId).state === "dispatch_unknown");
    await eventually(() => fixture.store.getQueueItem(followUp.value.queueItemId).state === "backend_accepted");

    await adapter.settle(sessionId);
    await eventually(() => fixture.store.getRun(prompt.value.runId).descriptor.state === "completed");
    await eventually(() => fixture.store.getRun(followUp.value.runId).descriptor.state === "completed");
    expect(fixture.store.getRun(steer.value.runId).descriptor).toMatchObject({
      state: "dispatch_unknown",
      error: { code: "PI_STEER_DISPATCH_UNKNOWN", stateMayHaveChanged: true }
    });
    expect(fixture.store.getQueueItem(steer.value.queueItemId)).toMatchObject({
      state: "dispatch_unknown",
      error: { code: "PI_STEER_DISPATCH_UNKNOWN", stateMayHaveChanged: true }
    });
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.runId === steer.value.runId && event.payload.type === "done")).toHaveLength(1);
  });

  it("durably accepts an idempotent prompt and settles only from the adapter done event", async () => {
    const fixture = await createFixture();
    const created = await fixture.host.createSession({
      operationId: "create-one",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Daily task",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: true
    });
    const sessionId = created.value.sessionId;
    const prompt = { text: "hello", images: [], files: [], mentions: [], disposition: "prompt" } as const;
    const first = fixture.host.enqueueInput({
      operationId: "send-one",
      connection: fixture.connection,
      sessionId,
      prompt
    });
    const replay = fixture.host.enqueueInput({
      operationId: "send-one",
      connection: fixture.connection,
      sessionId,
      prompt
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(fixture.store.getOperation("send-one").body).toEqual({ sessionId, prompt, source: "user" });
    await eventually(() => fixture.store.getRun(first.value.runId).descriptor.state === "completed");
    expect(fixture.store.getQueueItem(first.value.queueItemId).state).toBe("completed");
    expect(materializedSessionRuntimeState(
      fixture.store.getSetting("session", sessionId, SESSION_RUNTIME_STATE_SETTING_KEY).value
    )?.usage).toMatchObject({ totalTokens: 20, contextTokens: 20, contextWindow: 32_000 });
    expect(fixture.store.listUsageLedger({ ownerId: "orchestrator" })).toEqual([
      expect.objectContaining({
        sessionId,
        providerId: "test",
        modelId: "text",
        totalTokens: 20,
        costComplete: true,
        estimated: false
      })
    ]);
    expect(fixture.store.listEvents({ sessionId }).at(-1)?.payload.type).toBe("queue_update");
  });

  it("applies a model price override only to the matching Backend identity", async () => {
    const primary = new TokenPricedScheduleUsageFakeAdapter("priced-backend-primary");
    const secondary = new TokenPricedScheduleUsageFakeAdapter("priced-backend-secondary");
    const fixture = await createMultiAdapterFixture([primary, secondary]);
    await fixture.host.registerTarget({
      id: "target-priced-primary",
      backendId: primary.id,
      displayName: "Primary priced target",
      workspaceRoot: fixture.directory,
      managed: true,
      trusted: true
    });
    await fixture.host.registerTarget({
      id: "target-priced-secondary",
      backendId: secondary.id,
      displayName: "Secondary priced target",
      workspaceRoot: fixture.directory,
      managed: true,
      trusted: true
    });
    const connection = fixture.store.createConnection({
      id: "connection-priced-backends",
      name: "Priced Backend test device",
      authKeyDigest: "digest"
    });
    fixture.store.upsertModelPriceOverride({
      ownerId: "orchestrator",
      backendId: primary.id,
      providerId: "test",
      modelId: "text",
      currencyCode: "CNY",
      inputCostMicrosPerMillion: 10_000_000,
      outputCostMicrosPerMillion: 20_000_000
    });

    const createAndRun = async (operation: string, targetId: string) => {
      const sessionId = (await fixture.host.createSession({
        operationId: `create-${operation}`,
        connection,
        targetId,
        title: operation,
        providerId: "test",
        modelId: "text",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const queued = fixture.host.enqueueInput({
        operationId: `send-${operation}`,
        connection,
        sessionId,
        prompt: { text: "measure", images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
    };
    await createAndRun("priced-primary", "target-priced-primary");
    await createAndRun("priced-secondary", "target-priced-secondary");

    const ledger = fixture.store.listUsageLedger({ ownerId: "orchestrator" });
    expect(ledger.find((row) => row.backendId === primary.id)).toMatchObject({
      currencyCode: "CNY",
      costMicros: 20_000_000
    });
    expect(ledger.find((row) => row.backendId === secondary.id)).toMatchObject({
      currencyCode: "USD",
      costMicros: 5_000_000
    });
  });

  it("accounts cumulative delegated-run usage independently without inflating parent context", async () => {
    const fixture = await createFixture(new DelegatedUsageFakeAdapter());
    const sessionId = (await fixture.host.createSession({
      operationId: "create-delegated-usage",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delegated usage",
      providerId: "test",
      modelId: "text",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const queued = fixture.host.enqueueInput({
      operationId: "send-delegated-usage",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "delegate", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");

    const runtimeUsage = materializedSessionRuntimeState(
      fixture.store.getSetting("session", sessionId, SESSION_RUNTIME_STATE_SETTING_KEY).value
    )?.usage;
    expect(runtimeUsage).toMatchObject({ totalTokens: 20, contextTokens: 20, contextWindow: 32_000 });
    const ledger = fixture.store.listUsageLedger({ ownerId: "orchestrator" });
    expect(ledger.find((row) => row.providerId === "test" && row.modelId === "text"))
      .toMatchObject({ totalTokens: 20, costMicros: 1_000 });
    expect(ledger.find((row) => row.providerId === "vision" && row.modelId === "multimodal"))
      .toMatchObject({ inputTokens: 20, outputTokens: 10, totalTokens: 30, costMicros: 5_000 });
    expect(fixture.store.summarizeUsageLedger({ ownerId: "orchestrator" }))
      .toMatchObject({ inputTokens: 32, outputTokens: 18, totalTokens: 50, costMicros: 6_000 });
  });

  it("records a terminal Provider limit for the effective turn model and clears it after live usage succeeds", async () => {
    const adapter = new ProviderLimitFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-provider-limit",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Provider limit",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const overrides = { providerId: "vision", modelId: "multimodal" } as const;
    const limited = fixture.host.enqueueInput({
      operationId: "provider-limit-failure",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "first", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides
    });

    await eventually(() => fixture.store.getRun(limited.value.runId).descriptor.state === "failed");
    const settingKey = providerRateLimitSettingKey("fake-pi-like", "vision");
    expect(fixture.store.findSetting("service", "orchestrator", settingKey)?.value).toEqual({
      limited: true,
      resetsAt: expect.any(Number),
      observedAt: expect.any(Number)
    });
    expect(fixture.store.findSetting("service", "orchestrator", providerRateLimitSettingKey("fake-pi-like", "test"))).toBeUndefined();

    const recovered = fixture.host.enqueueInput({
      operationId: "provider-limit-recovered",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "second", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides
    });
    await eventually(() => fixture.store.getRun(recovered.value.runId).descriptor.state === "completed");
    expect(fixture.store.findSetting("service", "orchestrator", settingKey)).toBeUndefined();
  });

  it("creates a durable normal product task for a service handoff", async () => {
    const fixture = await createFixture();
    const created = await fixture.host.createServiceSession({
      operationId: "create-service-handoff",
      serviceKind: "session_handoff",
      targetId: "target-one",
      title: "Delegated task",
      providerId: "test",
      modelId: "text",
      effort: "high",
      fastMode: false,
      permissionMode: "auto",
      planMode: true
    });
    const replay = await fixture.host.createServiceSession({
      operationId: "create-service-handoff",
      serviceKind: "session_handoff",
      targetId: "target-one",
      title: "Delegated task",
      providerId: "test",
      modelId: "text",
      effort: "high",
      fastMode: false,
      permissionMode: "auto",
      planMode: true
    });

    expect(created.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, value: created.value });
    expect(fixture.store.getOperation("create-service-handoff")).toMatchObject({
      kind: "create_session_handoff",
      status: "completed",
      body: {
        targetId: "target-one",
        title: "Delegated task",
        serviceKind: "session_handoff"
      }
    });
    expect(fixture.store.getSession(created.value.sessionId).descriptor).toMatchObject({
      targetId: "target-one",
      title: "Delegated task",
      providerId: "test",
      modelId: "text",
      effort: "high",
      permissionMode: "auto",
      planMode: true,
      archived: false
    });
  });

  it("persists the authenticated origin task on service handoff admission", async () => {
    const fixture = await createFixture();
    const originSessionId = (await fixture.host.createSession({
      operationId: "create-handoff-origin",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Origin",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const targetSessionId = (await fixture.host.createSession({
      operationId: "create-handoff-target",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Target",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const prompt = {
      text: "continue this task",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    } as const;
    const admitted = fixture.host.enqueueServiceInput({
      operationId: "handoff-origin-owned-input",
      sessionId: targetSessionId,
      originSessionId,
      source: "system",
      prompt
    });

    expect(fixture.store.getOperation("handoff-origin-owned-input").body).toEqual({
      sessionId: targetSessionId,
      prompt,
      source: "system",
      originSessionId
    });
    expect(fixture.store.getQueueItem(admitted.value.queueItemId)).toMatchObject({
      sessionId: targetSessionId,
      operationId: "handoff-origin-owned-input",
      body: prompt
    });
    expect(() => fixture.host.enqueueServiceInput({
      operationId: "invalid-scheduled-origin",
      sessionId: targetSessionId,
      originSessionId,
      source: "schedule",
      prompt
    })).toThrow("Only system Session handoffs may carry an origin task.");
  });

  it("carries inline input metadata onto live and refreshed native user events", async () => {
    const adapter = new QuoteGateFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-quote-gate",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Quote gate",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const quoted = fixture.host.enqueueInput({
      operationId: "send-quote-gate",
      connection: fixture.connection,
      sessionId,
      prompt: {
        text: "> <!-- joko-selection-quote -->\n> selected\n\nreply",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt",
        quotesEncoded: true,
        pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }]
      }
    });
    await eventually(() => fixture.store.getRun(quoted.value.runId).descriptor.state === "completed");
    await eventually(() => fixture.store.listEvents({ sessionId }).filter((event) => event.pi?.entryId === "quote-entry-1").length === 2);
    expect(fixture.store.listEvents({ sessionId }).filter((event) => event.pi?.entryId === "quote-entry-1").map((event) => event.payload))
      .toEqual([
        expect.objectContaining({
          type: "message_complete",
          role: "user",
          quotesEncoded: true,
          pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }],
          inputDelivery: "prompt"
        }),
        expect.objectContaining({
          type: "message_complete",
          role: "user",
          quotesEncoded: true,
          pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }],
          inputDelivery: "prompt"
        })
      ]);
    const generationBeforeResume = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await fixture.host.detach(sessionId);
    await expect(fixture.host.resume(sessionId)).resolves.toBeDefined();
    expect(fixture.store.getSession(sessionId).descriptor.binding.generation).toBeGreaterThan(generationBeforeResume);
    expect(activeNativeTimeline(fixture.store.listEvents({ sessionId }))
      .filter((event) => event.id.startsWith("native-event-") && event.pi?.entryId === "quote-entry-1")
      .map((event) => event.payload)).toEqual([
        expect.objectContaining({
          type: "message_complete",
          quotesEncoded: true,
          pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }],
          inputDelivery: "prompt"
        })
      ]);

    const typedMarker = fixture.host.enqueueInput({
      operationId: "send-typed-marker",
      connection: fixture.connection,
      sessionId,
      prompt: {
        text: "> <!-- joko-selection-quote -->\n> typed by the user",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }
    });
    await eventually(() => fixture.store.getRun(typedMarker.value.runId).descriptor.state === "completed");
    await eventually(() => fixture.store.listEvents({ sessionId }).filter((event) => event.pi?.entryId === "quote-entry-2").length === 2);
    expect(fixture.store.listEvents({ sessionId }).filter((event) => event.pi?.entryId === "quote-entry-2")
      .every((event) => event.payload.type === "message_complete" && event.payload.quotesEncoded !== true)).toBe(true);

    const repeated = fixture.host.enqueueInput({
      operationId: "send-repeated-quote-text",
      connection: fixture.connection,
      sessionId,
      prompt: {
        text: "> <!-- joko-selection-quote -->\n> selected\n\nreply",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt",
        pastedTextRanges: [{ start: 0, end: 1, display: "Pasted prefix" }]
      }
    });
    await eventually(() => fixture.store.getRun(repeated.value.runId).descriptor.state === "completed");
    await eventually(() => fixture.store.listEvents({ sessionId }).some((event) => (
      event.id.startsWith("native-event-") && event.pi?.entryId === "quote-entry-3"
    )));
    expect(fixture.store.listEvents({ sessionId }).find((event) => (
      event.id.startsWith("native-event-") && event.pi?.entryId === "quote-entry-3"
    ))?.payload).toMatchObject({
      type: "message_complete",
      role: "user",
      pastedTextRanges: [{ start: 0, end: 1, display: "Pasted prefix" }],
      inputDelivery: "prompt"
    });

    expect(() => fixture.host.enqueueInput({
      operationId: "send-invalid-paste-range",
      connection: fixture.connection,
      sessionId,
      prompt: {
        text: "😀",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt",
        pastedTextRanges: [{ start: 1, end: 2, display: "split" }]
      }
    })).toThrow("ordered, non-overlapping UTF-16 spans");
    expect(fixture.store.findOperation("send-invalid-paste-range")).toBeUndefined();
  });

  it("buffers a synchronous terminal until Backend acceptance commits, then settles Queue and Run", async () => {
    const fixture = await createFixture(new ImmediateTerminalFakeAdapter());
    const sessionId = (await fixture.host.createSession({
      operationId: "create-synchronous-terminal",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Synchronous terminal",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const execution = fixture.host.enqueueInput({
      operationId: "send-synchronous-terminal",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "/synchronous-extension", images: [], files: [], mentions: [], disposition: "prompt" }
    });

    await eventually(() => fixture.store.getRun(execution.value.runId).descriptor.state === "completed");

    expect(fixture.store.getQueueItem(execution.value.queueItemId).state).toBe("completed");
    const terminalEvents = fixture.store.listEvents({ sessionId }).filter((event) =>
      event.runId === execution.value.runId && event.payload.type === "done"
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.pi).toMatchObject({
      rpcEventType: "extension_command_completed",
      payload: { case: "diagnostic", value: { nativeEventType: "extension_command_completed" } }
    });
  });

  it("returns from a paused drain without polling claimNextQueueItem", async () => {
    const adapter = new SendCountingFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-paused-no-spin",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Paused no spin",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.setQueuePaused({
      sessionId,
      paused: true,
      reason: "Hold dispatch",
      connectionId: fixture.connection.id,
      traceId: "test:pause:no-spin"
    });
    const claim = vi.spyOn(fixture.store, "claimNextQueueItem");

    const queued = fixture.host.enqueueInput({
      operationId: "enqueue-paused-no-spin",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "hold", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    fixture.host.requestQueueDrain(sessionId);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("queued");
    expect(claim).not.toHaveBeenCalled();
    expect(adapter.sendCalls).toBe(0);
  });

  it("dispatches a durably accepted paused item exactly once after resume wakes the session", async () => {
    const adapter = new SendCountingFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-paused-resume",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Paused resume",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.setQueuePaused({
      sessionId,
      paused: true,
      reason: "Owner review",
      connectionId: fixture.connection.id,
      traceId: "test:pause:resume"
    });
    const claim = vi.spyOn(fixture.store, "claimNextQueueItem");
    const queued = fixture.host.enqueueInput({
      operationId: "enqueue-paused-resume",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "resume me", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(adapter.sendCalls).toBe(0);

    fixture.store.setQueuePaused({ sessionId, paused: false, traceId: "test:resume" });
    fixture.host.requestQueueDrain(sessionId);
    fixture.host.requestQueueDrain(sessionId);
    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");

    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("completed");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(adapter.sendCalls).toBe(1);
  });

  it("keeps an idle prompt durably accepted throughout manual compaction, then dispatches it exactly once", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-manual-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Manual compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const claim = vi.spyOn(fixture.store, "claimNextQueueItem");

    const compacting = fixture.host.compact(sessionId);
    // The shutdown probe covers the synchronous explicit-flight window before
    // Pi has emitted a native compaction observation.
    expect(fixture.host.inspectRuntimeActivity()).toContain("compaction");
    await adapter.manualCompactionStarted;
    const queued = fixture.host.enqueueInput({
      operationId: "prompt-during-manual-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "after compact", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    fixture.host.requestQueueDrain(sessionId);
    fixture.host.requestQueueDrain(sessionId);
    await nextTurn();

    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("queued");
    expect(claim).not.toHaveBeenCalled();
    expect(adapter.sentDispositions).toEqual([]);

    adapter.finishManualCompaction("completed");
    await compacting;
    expect(fixture.host.inspectRuntimeActivity()).not.toContain("compaction");
    expect(fixture.store.listEvents({ sessionId }).some((event) =>
      event.metadata?.namespace === "fake.native_history" &&
      event.payload.type === "compaction" &&
      event.payload.summary === "Persisted fake compacted context"
    )).toBe(true);
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");

    expect(claim).toHaveBeenCalledTimes(1);
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
  });

  it("coalesces identical manual compactions and rejects conflicting instructions without a second native effect", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-manual-compaction-single-flight",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Manual compaction single-flight",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    const first = fixture.host.compact(sessionId, " preserve decisions ");
    await adapter.manualCompactionStarted;
    const joined = fixture.host.compact(sessionId, "preserve decisions");
    await expect(fixture.host.compact(sessionId, "use different instructions")).rejects.toMatchObject({
      publicError: { code: "COMPACTION_IN_PROGRESS", stateMayHaveChanged: false }
    });

    adapter.finishManualCompaction("completed");
    await expect(Promise.all([first, joined])).resolves.toEqual(["compacted", "compacted"]);
    expect(adapter.manualCompactionCalls).toBe(1);
  });

  it("transfers an explicit compaction queue window across inactive-session activation", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-inactive-manual-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Inactive manual compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const generationBeforeActivation = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await fixture.host.detach(sessionId);

    const compacting = fixture.host.compact(sessionId);
    const queued = fixture.host.enqueueInput({
      operationId: "steer-during-inactive-manual-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "survive activation", images: [], files: [], mentions: [], disposition: "steer" }
    });
    await adapter.manualCompactionStarted;

    const generationAfterActivation = fixture.store.getSession(sessionId).descriptor.binding.generation;
    expect(generationAfterActivation).toBeGreaterThan(generationBeforeActivation);
    expect(fixture.store.getSetting(
      "session",
      sessionId,
      "runtime.compaction.dispatch.queue"
    ).value).toMatchObject({
      generation: generationAfterActivation,
      baselineQueueItemIds: [],
      heldQueueItemIds: [queued.value.queueItemId]
    });

    adapter.finishManualCompaction("completed");
    await compacting;
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");
    expect(fixture.store.getQueueItem(queued.value.queueItemId).disposition).toBe("prompt");
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
  });

  it.each(["failed", "aborted"] as const)(
    "releases the durable compaction queue after a %s manual compaction",
    async (outcome) => {
      const adapter = new CompactionQueueFakeAdapter();
      const fixture = await createFixture(adapter);
      const sessionId = (await fixture.host.createSession({
        operationId: `create-${outcome}-compaction-queue`,
        connection: fixture.connection,
        targetId: "target-one",
        title: `${outcome} compaction queue`,
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const compacting = fixture.host.compact(sessionId);
      await adapter.manualCompactionStarted;
      const queued = fixture.host.enqueueInput({
        operationId: `prompt-during-${outcome}-compaction`,
        connection: fixture.connection,
        sessionId,
        prompt: { text: `after ${outcome}`, images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await nextTurn();
      expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");

      adapter.finishManualCompaction(outcome);
      await expect(compacting).rejects.toThrow(outcome === "aborted" ? "cancelled" : "failed");
      await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");

      expect(adapter.sentDispositions).toEqual(["prompt"]);
      await adapter.settle(sessionId);
      await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
    }
  );

  it("uses exact native state to fence a compaction-start delivery window and wakes from its terminal event", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-observed-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Observed compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const inspectionsBefore = adapter.compactingInspections;
    adapter.forceNativeCompaction(sessionId);
    const queued = fixture.host.enqueueInput({
      operationId: "prompt-during-observed-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "native observation", images: [], files: [], mentions: [], disposition: "prompt" }
    });

    await eventually(() => adapter.compactingInspections > inspectionsBefore);
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(adapter.sentDispositions).toEqual([]);

    await adapter.finishNativeCompaction(sessionId);
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
  });

  it("promotes the first ordinary post-compaction continuation to a durable prompt", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-promoted-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Promoted compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.beginNativeCompaction(sessionId);
    const queued = fixture.host.enqueueInput({
      operationId: "steer-promoted-after-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "become a prompt", images: [], files: [], mentions: [], disposition: "steer" }
    });
    await nextTurn();
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");

    await adapter.finishNativeCompaction(sessionId, false);
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");

    expect(fixture.store.getQueueItem(queued.value.queueItemId).disposition).toBe("prompt");
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
  });

  it("promotes post-window input when compaction ends before drain can mark it held", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-terminal-race-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Terminal race compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.beginNativeCompaction(sessionId);
    const queued = fixture.host.enqueueInput({
      operationId: "steer-before-immediate-compaction-terminal",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "terminal raced drain", images: [], files: [], mentions: [], disposition: "steer" }
    });

    // Deliberately do not yield: the terminal owns promotion even when the
    // dispatcher has not yet persisted this accepted item in heldQueueItemIds.
    await adapter.finishNativeCompaction(sessionId, false);
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");

    expect(fixture.store.getQueueItem(queued.value.queueItemId).disposition).toBe("prompt");
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
  });

  it("reconciles a durably held compaction continuation after SessionHost restart", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-recovered-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Recovered compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.beginNativeCompaction(sessionId);
    const queued = fixture.host.enqueueInput({
      operationId: "steer-recovered-after-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "survive restart", images: [], files: [], mentions: [], disposition: "steer" }
    });
    await nextTurn();
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(fixture.store.getSetting(
      "session",
      sessionId,
      "runtime.compaction.dispatch.queue"
    ).value).toMatchObject({ format: 1, heldQueueItemIds: [queued.value.queueItemId] });

    await fixture.host.dispose();
    const restartedAdapter = new CompactionQueueFakeAdapter();
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();

    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "backend_accepted");
    expect(fixture.store.getQueueItem(queued.value.queueItemId).disposition).toBe("prompt");
    expect(fixture.store.findSetting(
      "session",
      sessionId,
      "runtime.compaction.dispatch.queue"
    )).toBeUndefined();
    expect(restartedAdapter.sentDispositions).toEqual(["prompt"]);
    await restartedAdapter.settle(sessionId);
    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
  });

  it("dispatches a catalogued extension command immediately past held ordinary compaction input", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-extension-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Extension compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.beginNativeCompaction(sessionId);
    const ordinary = fixture.host.enqueueInput({
      operationId: "ordinary-before-extension-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "/not-catalogued", images: [], files: [], mentions: [], disposition: "steer" }
    });
    const extension = fixture.host.enqueueInput({
      operationId: "extension-during-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "/extension", images: [], files: [], mentions: [], disposition: "follow_up" }
    });

    await eventually(() => fixture.store.getRun(extension.value.runId).descriptor.state === "completed");
    expect(fixture.store.getQueueItem(ordinary.value.queueItemId).state).toBe("accepted");
    expect(fixture.store.getQueueItem(extension.value.queueItemId)).toMatchObject({
      state: "completed",
      disposition: "prompt"
    });
    expect(adapter.sentDispositions).toEqual(["prompt"]);

    await adapter.finishNativeCompaction(sessionId, false);
    await eventually(() => fixture.store.getQueueItem(ordinary.value.queueItemId).state === "backend_accepted");
    expect(fixture.store.getQueueItem(ordinary.value.queueItemId).disposition).toBe("prompt");
    expect(adapter.sentDispositions).toEqual(["prompt", "prompt"]);
    await adapter.settle(sessionId);
  });

  it("does not transfer a cancelled extension command's compaction bypass to the next item", async () => {
    const adapter = new GatedCompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-cancelled-extension-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Cancelled extension compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.beginNativeCompaction(sessionId);
    const ordinary = fixture.host.enqueueInput({
      operationId: "ordinary-before-cancelled-extension",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "ordinary", images: [], files: [], mentions: [], disposition: "steer" }
    });
    const extension = fixture.host.enqueueInput({
      operationId: "cancelled-extension-during-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "/extension", images: [], files: [], mentions: [], disposition: "follow_up" }
    });
    await adapter.extensionClassificationStarted;

    const editQueueItem = fixture.store.editQueueItem.bind(fixture.store);
    vi.spyOn(fixture.store, "editQueueItem").mockImplementation((input) => {
      const updated = editQueueItem(input);
      if (input.traceId === `compaction:${extension.value.queueItemId}:immediate-disposition`) {
        // Run after classification/reordering has returned its bypass grant,
        // but before drain resumes and performs the final durable claim.
        queueMicrotask(() => {
          fixture.store.cancelQueueItem({
            queueItemId: extension.value.queueItemId,
            traceId: "test:cancel-classified-extension"
          });
        });
      }
      return updated;
    });
    adapter.releaseExtensionClassification();

    await eventually(() => fixture.store.getQueueItem(extension.value.queueItemId).state === "cancelled");
    await nextTurn();
    expect(fixture.store.getQueueItem(ordinary.value.queueItemId)).toMatchObject({
      state: "accepted",
      disposition: "steer"
    });
    expect(adapter.sentDispositions).toEqual([]);

    await adapter.finishNativeCompaction(sessionId, false);
    await eventually(() => fixture.store.getQueueItem(ordinary.value.queueItemId).state === "backend_accepted");
    expect(fixture.store.getQueueItem(ordinary.value.queueItemId).disposition).toBe("prompt");
    expect(adapter.sentDispositions).toEqual(["prompt"]);
    await adapter.settle(sessionId);
  });

  it("holds steer and follow-up together during native compaction and flushes each exactly once", async () => {
    const adapter = new CompactionQueueFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-continuation-compaction-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Continuation compaction queue",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const prompt = fixture.host.enqueueInput({
      operationId: "compaction-continuation-prompt",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "initial", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(prompt.value.queueItemId).state === "backend_accepted");
    await adapter.beginNativeCompaction(sessionId);
    const claim = vi.spyOn(fixture.store, "claimNextQueueItem");
    const steer = fixture.host.enqueueInput({
      operationId: "steer-during-native-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "steer", images: [], files: [], mentions: [], disposition: "steer" }
    });
    const followUp = fixture.host.enqueueInput({
      operationId: "follow-up-during-native-compaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "follow", images: [], files: [], mentions: [], disposition: "follow_up" }
    });
    await nextTurn();

    expect([steer, followUp].map((item) => fixture.store.getQueueItem(item.value.queueItemId).state))
      .toEqual(["accepted", "accepted"]);
    expect(claim).not.toHaveBeenCalled();
    expect(adapter.sentDispositions).toEqual(["prompt"]);

    // Pi can answer get_state(false) before the queued compaction_end event
    // carrying willRetry reaches Orchestrator. That observation must not guess false
    // and promote the steer while exact terminal metadata is still pending.
    adapter.endNativeCompactionState(sessionId);
    fixture.host.requestQueueDrain(sessionId);
    await nextTurn();
    expect(fixture.store.getQueueItem(steer.value.queueItemId)).toMatchObject({
      state: "accepted",
      disposition: "steer"
    });

    await adapter.finishNativeCompaction(sessionId, true);
    await eventually(() => [steer, followUp].every((item) =>
      fixture.store.getQueueItem(item.value.queueItemId).state === "backend_accepted"));

    expect(claim).toHaveBeenCalledTimes(2);
    expect(adapter.sentDispositions).toEqual(["prompt", "steer", "follow_up"]);
    await adapter.settle(sessionId);
    await eventually(() => [prompt, steer, followUp].every((item) =>
      fixture.store.getRun(item.value.runId).descriptor.state === "completed"));
  });

  it("preserves paused accepted work without dispatch while recovery initializes", async () => {
    const fixture = await createFixture(new SendCountingFakeAdapter());
    const sessionId = (await fixture.host.createSession({
      operationId: "create-paused-recovery",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Paused recovery",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.setQueuePaused({
      sessionId,
      paused: true,
      reason: "Restart while held",
      connectionId: fixture.connection.id,
      traceId: "test:pause:recovery"
    });
    const queued = fixture.host.enqueueInput({
      operationId: "enqueue-paused-recovery",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "recover me", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await fixture.host.dispose();

    const restartedAdapter = new SendCountingFakeAdapter();
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    try {
      await restartedHost.initialize();
      await new Promise((resolve) => setImmediate(resolve));
      expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("queued");
      expect(fixture.store.getQueueControl(sessionId).paused).toBe(true);
      expect(restartedAdapter.sendCalls).toBe(0);
    } finally {
      await restartedHost.dispose();
    }
  });

  it("fences uncertain dispatches and can restore and derive native sessions without stale contexts", async () => {
    const fixture = await createFixture();
    const sourceId = (await fixture.host.createSession({
      operationId: "create-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.adapter.injectFault(sourceId, "dispatch_unknown");
    const queued = fixture.host.enqueueInput({
      operationId: "uncertain-send",
      connection: fixture.connection,
      sessionId: sourceId,
      prompt: { text: "side effect", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "dispatch_unknown");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("dispatch_unknown");

    fixture.adapter.clearFault(sourceId);
    appendSessionEvent(fixture.store, sourceId, "fork-visible-anchor", Date.now(), {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "Visible fork boundary" }]
    });
    const derived = await fixture.host.deriveSession({
      operationId: "fork-one",
      connection: fixture.connection,
      sourceSessionId: sourceId,
      title: "Fork",
      kind: "fork",
      entryId: "root",
      sourceMessage: { messageId: "fork-visible-anchor", eventId: "fork-visible-anchor" }
    });
    expect(await fixture.host.inspect(sourceId)).toMatchObject({ permissionMode: "ask" });
    expect(await fixture.host.inspect(derived.value.sessionId)).toMatchObject({ permissionMode: "ask" });
    expect(fixture.store.getSession(derived.value.sessionId).descriptor.binding.opaqueRef).toContain("/fork/root");
  });

  it("drops only a matching unexpectedly exited runtime so the next operation resumes its durable binding", async () => {
    const adapter = new ResumeCountingFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-exit",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime exit",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const generation = fixture.store.getSession(sessionId).descriptor.binding.generation;
    const backendInstanceGeneration = fixture.store.getBackend(adapter.id).descriptor.instanceGeneration;

    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration,
      sessionId,
      generation: generation + 1
    });
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(0);

    fixture.host.invalidateRuntime({ backendId: adapter.id, backendInstanceGeneration, sessionId, generation });
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(1);
    expect(fixture.store.getSession(sessionId).descriptor.binding.generation).toBe(generation + 1);
  });

  it("terminalizes background tasks only for the unexpectedly exited runtime generation", async () => {
    let monotonicNow = 0;
    const adapter = new BackgroundTaskRuntimeFakeAdapter();
    const fixture = await createFixture(adapter, { monotonicNow: () => monotonicNow });
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-exit-background-task",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime exit background task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const firstGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;
    const backendInstanceGeneration = fixture.store.getBackend(adapter.id).descriptor.instanceGeneration;
    const backgroundEvents = () => fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "background_task"
    );

    await adapter.emitBackgroundTask({
      taskId: "shared-subagent",
      parentTaskId: "batch-one",
      title: "scout subagent",
      state: "waiting",
      detail: "Waiting for delegated work.",
      progressRatio: 0.35,
      startedAt: 1_234
    });
    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration,
      sessionId,
      generation: firstGeneration + 1
    });
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(0);
    expect(backgroundEvents()).toHaveLength(1);

    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration,
      sessionId,
      generation: firstGeneration
    });
    expect(backgroundEvents().at(-1)).toMatchObject({
      generation: firstGeneration,
      payload: {
        type: "background_task",
        taskId: "shared-subagent",
        parentTaskId: "batch-one",
        title: "scout subagent",
        state: "failed",
        detail: "Backend runtime exited before this background task completed.",
        progressRatio: 0.35,
        startedAt: 1_234,
        endedAt: expect.any(Number),
        error: {
          code: "BACKGROUND_TASK_RUNTIME_LOST",
          message: "The backend runtime exited before this background task completed.",
          phase: "runtime",
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Resume the task and retry the background operation after checking its latest durable activity."
        }
      }
    });

    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(1);
    const secondGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await adapter.emitBackgroundTask({
      taskId: "shared-subagent",
      title: "replacement subagent",
      state: "running"
    });
    const beforeLateExit = backgroundEvents();

    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration,
      sessionId,
      generation: firstGeneration
    });
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(1);
    expect(backgroundEvents()).toEqual(beforeLateExit);
    expect(backgroundEvents().at(-1)).toMatchObject({
      generation: secondGeneration,
      payload: { type: "background_task", title: "replacement subagent", state: "running" }
    });

    fixture.host.invalidateRuntime({
      backendId: adapter.id,
      backendInstanceGeneration,
      sessionId,
      generation: secondGeneration
    });
    expect(backgroundEvents().at(-1)).toMatchObject({
      generation: secondGeneration,
      payload: { type: "background_task", title: "replacement subagent", state: "failed" }
    });
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(2);
    monotonicNow = 1_001;
    await expect(fixture.host.reapIdleRuntimes(1_000)).resolves.toEqual([sessionId]);
  });

  it("persists one observable active-to-terminal background task edge", async () => {
    const adapter = new BackgroundTaskRuntimeFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-background-edge",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Background edge",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    await adapter.emitBackgroundTask({
      taskId: "subagent-one",
      title: "Subagent",
      state: "running"
    });
    expect(fixture.store.hasActiveSessionBackgroundTasks(sessionId)).toBe(true);
    await adapter.emitBackgroundTask({
      taskId: "subagent-one",
      title: "Subagent",
      state: "completed"
    });
    expect(fixture.store.hasActiveSessionBackgroundTasks(sessionId)).toBe(false);
    expect(fixture.store.listEvents({ sessionId }).filter((event) => event.payload.type === "background_task")
      .map((event) => event.payload.type === "background_task" ? event.payload.state : ""))
      .toEqual(["running", "completed"]);
  });

  it("stops only a durably owned active background task and can route it after a Host restart", async () => {
    const adapter = new BackgroundTaskCancellationFakeAdapter();
    const fixture = await createFixture(adapter);
    const otherSessionId = (await fixture.host.createSession({
      operationId: "create-background-cancel-other",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Other background task owner",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const sessionId = (await fixture.host.createSession({
      operationId: "create-background-cancel-owner",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Background task owner",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const originalGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;

    await adapter.emitBackgroundTask({
      taskId: "owned-background-task",
      title: "Owned background task",
      state: "waiting",
      startedAt: 1_000
    });

    await expect(fixture.host.cancelBackgroundTask("", "owned-background-task"))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_SESSION_REQUIRED" } });
    await expect(fixture.host.cancelBackgroundTask(sessionId, "  "))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_ID_REQUIRED" } });
    await expect(fixture.host.cancelBackgroundTask(sessionId, "unknown-background-task"))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_NOT_ACTIVE" } });
    await expect(fixture.host.cancelBackgroundTask(otherSessionId, "owned-background-task"))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_NOT_ACTIVE" } });
    expect(adapter.cancellations).toEqual([]);

    await fixture.host.dispose();
    const restartedAdapter = new BackgroundTaskCancellationFakeAdapter();
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();
    await restartedHost.mutate({
      operationId: "cancel-background-operation",
      connection: fixture.connection,
      kind: "cancelBackgroundTask",
      body: { sessionId, taskId: "owned-background-task" },
      effect: () => restartedHost.cancelBackgroundTask(
        sessionId,
        "owned-background-task",
        "cancel-background-operation"
      ),
      commit: () => ({ accepted: true })
    });

    expect(restartedAdapter.cancellations).toHaveLength(1);
    expect(restartedAdapter.cancellations[0]).toMatchObject({
      taskId: "owned-background-task",
      sessionId
    });
    expect(restartedAdapter.cancellations[0]!.generation).toBeGreaterThan(originalGeneration);
    expect(fixture.store.listSessionBackgroundTaskEvents(sessionId).at(-1)).toMatchObject({
      operationId: "cancel-background-operation",
      payload: {
        type: "background_task",
        taskId: "owned-background-task",
        state: "cancelled"
      }
    });
    expect(fixture.store.hasActiveSessionBackgroundTasks(sessionId)).toBe(false);
  });

  it("delivers a detached delegated-run control without reactivating its parent runtime", async () => {
    const adapter = new DetachedSubagentControlFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-detached-subagent-control",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Detached delegated control",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const runId = "detached-worker";
    appendSessionEvent(fixture.store, sessionId, "detached-worker-visible", Date.now(), {
      type: "subagent_run",
      run: {
        ...portableWorkerRun(sessionId, 0),
        id: runId,
        logicalAgentId: runId,
        state: "running",
        endedAt: undefined,
        capabilities: {
          viewActivity: true,
          viewReturnedResult: true,
          viewFullTranscript: true,
          stop: true,
          steer: true,
          followUp: true,
          resume: false,
          parentContext: "snapshot"
        }
      }
    });
    await fixture.host.detach(sessionId);
    adapter.failOnResume = true;

    await fixture.host.controlSubagent(sessionId, { runId, action: "stop" }, "detached-control-operation");

    expect(adapter.resumeCalls).toBe(0);
    expect(adapter.controls).toEqual([{
      input: { runId, action: "stop" },
      operationId: "detached-control-operation"
    }]);
  });

  it("deletes detached native persistence without reactivating its parent runtime", async () => {
    const adapter = new DetachedSessionDeletionFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-detached-session-deletion",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Detached native deletion",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const binding = fixture.store.getSession(sessionId).descriptor.binding;
    await fixture.host.detach(sessionId);
    adapter.failOnResume = true;

    await fixture.host.deleteNativeSession(sessionId);

    expect(adapter.resumeCalls).toBe(0);
    expect(adapter.deletions).toEqual([{ binding, sessionId }]);
  });

  it("does not reactivate a runtime when durable cleanup replays after a later effect failed", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const resumeSession = vi.spyOn(adapter, "resumeSession");
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-idempotent-runtime-close",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Idempotent cleanup",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    await fixture.host.closeIfActive(sessionId);
    // A workspace release can fail after the runtime close. The durable
    // manifest then replays this phase before retrying that later effect.
    await fixture.host.closeIfActive(sessionId);

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("rejects archive while a workspace command is live and aborts it before delete closes the runtime", async () => {
    const adapter = new GatedUserShellFakeAdapter();
    const closeSession = vi.spyOn(adapter, "closeSession");
    const abortUserShell = vi.spyOn(adapter, "abortUserShell");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-lifecycle-shell",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Lifecycle shell",
      fastMode: false,
      permissionMode: "bypassPermissions",
      planMode: false
    })).value.sessionId;
    const shell = fixture.host.executeUserShell(sessionId, {
      command: "long-running-command",
      excludeFromContext: true
    });
    await adapter.waitForStart();

    expect(() => fixture.host.assertSessionLifecycleIdle(sessionId)).toThrow(/only after.*idle/iu);
    expect(closeSession).not.toHaveBeenCalled();

    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-lifecycle-shell",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });
    await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
    await expect(shell).resolves.toMatchObject({ cancelled: true, exitCode: 130 });
    await fixture.host.closeIfActive(sessionId);

    expect(abortUserShell).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(abortUserShell.mock.invocationCallOrder[0]).toBeLessThan(closeSession.mock.invocationCallOrder[0]!);
  });

  it("dismisses an open interaction before destructive lifecycle close waits for the Run to settle", async () => {
    const adapter = new InteractionFakeAdapter({
      id: "delete-lifecycle-interaction",
      kind: "permission",
      title: "Allow the pending action?",
      toolName: "bash",
      summary: "write output",
      risk: "high",
      choices: ["allow_once", "deny_once"]
    });
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-delete-lifecycle-interaction",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Lifecycle interaction",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.host.enqueueInput({
      operationId: "send-delete-lifecycle-interaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "wait for permission", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;

    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-lifecycle-interaction",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });
    await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
    await fixture.host.closeIfActive(sessionId);

    expect(fixture.store.getInteraction(interaction.id)).toMatchObject({
      status: "dismissed",
      dismissalReason: "The task is being removed while this interaction is pending."
    });
    expect(adapter.decision).toEqual({ kind: "cancelled" });
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-started active runtime effect before destructive close", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-delete-lifecycle-active-effect",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Lifecycle active effect",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const gate = new AsyncGate();
    const applying = fixture.host.applyToActiveSessions({ backendId: adapter.id }, async () => {
      gate.enter();
      await gate.wait;
    });
    await gate.entered;
    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-lifecycle-active-effect",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });
    const cleanup = (async () => {
      await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
      await fixture.host.closeIfActive(sessionId);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(closeSession).not.toHaveBeenCalled();
    gate.release();
    await applying;
    await cleanup;
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("terminalizes active background work when destructive lifecycle close removes its runtime", async () => {
    const adapter = new BackgroundTaskRuntimeFakeAdapter();
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-delete-lifecycle-background",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Lifecycle background task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await adapter.emitBackgroundTask({
      taskId: "delete-owned-background-task",
      title: "Background work",
      state: "running"
    });
    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-lifecycle-background",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });

    await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
    await fixture.host.closeIfActive(sessionId);

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(fixture.store.hasActiveSessionBackgroundTasks(sessionId)).toBe(false);
    expect(fixture.store.listSessionBackgroundTaskEvents(sessionId).at(-1)).toMatchObject({
      payload: {
        type: "background_task",
        taskId: "delete-owned-background-task",
        state: "failed",
        error: { code: "BACKGROUND_TASK_RUNTIME_LOST" }
      }
    });
  });

  it("does not activate a dormant runtime while replaying lifecycle close", async () => {
    const adapter = new GatedLifecycleCloseFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-dormant-lifecycle-close",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Dormant lifecycle close",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.closeIfActive(sessionId);
    adapter.closeCalls = 0;
    adapter.resumeCalls = 0;
    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-dormant-lifecycle-close",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });

    await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
    await fixture.host.closeIfActive(sessionId);

    expect(adapter.closeCalls).toBe(0);
    expect(adapter.resumeCalls).toBe(0);
  });

  it("keeps admission fenced while an active lifecycle close is awaiting the Backend", async () => {
    const adapter = new GatedLifecycleCloseFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-gated-lifecycle-close",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Gated lifecycle close",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-gated-lifecycle-close",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });
    adapter.closeArmed = true;
    await fixture.host.prepareSessionLifecycleClose(sessionId, "delete");
    const closing = fixture.host.closeIfActive(sessionId);
    await adapter.closeGate.entered;

    expect(() => fixture.host.enqueueInput({
      operationId: "enqueue-during-gated-lifecycle-close",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "must remain fenced", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrow(/lifecycle transition is in progress/iu);
    await expect(fixture.host.inspect(sessionId)).rejects.toThrow(/lifecycle transition is in progress/iu);
    expect(fixture.store.listRuns({ sessionId })).toHaveLength(0);
    await expect(fixture.host.restart(sessionId)).rejects.toThrow(/lifecycle transition is in progress/iu);
    const currentBackend = fixture.store.getBackend(adapter.id).descriptor;
    const replacementEffect = vi.fn(async () => undefined);
    await expect(fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: currentBackend.instanceGeneration,
      perform: replacementEffect
    })).rejects.toThrow(/native side effect|lifecycle owner/iu);
    expect(replacementEffect).not.toHaveBeenCalled();

    adapter.closeGate.release();
    await closing;
    expect(adapter.closeCalls).toBe(1);
  });

  it("asks the Backend to recover detached delegated observation on service startup", async () => {
    const firstAdapter = new DetachedSubagentObservationFakeAdapter();
    const fixture = await createFixture(firstAdapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-detached-observation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Detached observation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const generation = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await fixture.host.dispose();

    const restartedAdapter = new DetachedSubagentObservationFakeAdapter();
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();

    expect(restartedAdapter.resumeCalls).toBe(0);
    expect(restartedAdapter.observations).toEqual([{ sessionId, generation }]);
  });

  it("reconciles detached delegated observers on the published replacement generation without resuming dormant tasks", async () => {
    const previous = new DetachedSubagentObservationFakeAdapter();
    const fixture = await createFixture(previous);
    const activeSessionId = (await fixture.host.createSession({
      operationId: "create-replacement-detached-active",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Replacement detached active",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const dormantSessionId = (await fixture.host.createSession({
      operationId: "create-replacement-detached-dormant",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Replacement detached dormant",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.closeIfActive(dormantSessionId);
    const current = fixture.store.getBackend(previous.id).descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: previous.id,
      adapterKind: current.adapterKind
    });
    const replacement = new DetachedSubagentObservationFakeAdapter();
    replacement.failObservationSessionId = activeSessionId;

    await expect(fixture.host.replaceBackendInstance({
      backendId: previous.id,
      expectedCurrentGeneration: current.instanceGeneration,
      perform: async (hooks) => {
        await hooks.preparePrevious(replacement, reservation.generation);
        const published = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...current, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: current.instanceGeneration
        });
        if (published.status !== "published") throw new Error("Fixture replacement publication lost its fence.");
        hooks.activateCurrent();
      }
    })).resolves.toBeUndefined();

    expect(fixture.host.currentAdapter(previous.id)).toBe(replacement);
    expect(replacement.observations.map((observation) => observation.sessionId).sort()).toEqual(
      [activeSessionId, dormantSessionId].sort()
    );
    expect(replacement.backendInstanceGenerations).toEqual([
      reservation.generation,
      reservation.generation
    ]);
    expect(replacement.resumeCalls).toBe(1);
    expect(fixture.host.isSessionActive(activeSessionId)).toBe(true);
    expect(fixture.host.isSessionActive(dormantSessionId)).toBe(false);
  });

  it("fails background task cancellation closed when unsupported and durably records Adapter failure", async () => {
    const unsupportedAdapter = new BackgroundTaskRuntimeFakeAdapter();
    const describeUnsupported = unsupportedAdapter.describe.bind(unsupportedAdapter);
    vi.spyOn(unsupportedAdapter, "describe").mockImplementation(async () => {
      const descriptor = await describeUnsupported();
      const capabilities = new Map(descriptor.capabilities);
      capabilities.set("background.tasks.cancel", {
        key: "background.tasks.cancel",
        supported: true
      });
      return { ...descriptor, capabilities };
    });
    const unsupported = await createFixture(unsupportedAdapter);
    const unsupportedSessionId = (await unsupported.host.createSession({
      operationId: "create-background-cancel-unsupported",
      connection: unsupported.connection,
      targetId: "target-one",
      title: "Unsupported background cancellation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await unsupportedAdapter.emitBackgroundTask({
      taskId: "unsupported-background-task",
      title: "Unsupported background task",
      state: "running"
    });
    await expect(unsupported.host.cancelBackgroundTask(unsupportedSessionId, "unsupported-background-task"))
      .rejects.toMatchObject({ publicError: { code: "BACKGROUND_TASK_CANCEL_UNSUPPORTED" } });

    const failingAdapter = new BackgroundTaskCancellationFakeAdapter();
    failingAdapter.failure = new Error("simulated background cancellation failure");
    const failing = await createFixture(failingAdapter);
    const failingSessionId = (await failing.host.createSession({
      operationId: "create-background-cancel-failure",
      connection: failing.connection,
      targetId: "target-one",
      title: "Failing background cancellation",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await failingAdapter.emitBackgroundTask({
      taskId: "failing-background-task",
      title: "Failing background task",
      state: "running"
    });
    const mutationBody = { sessionId: failingSessionId, taskId: "failing-background-task" };
    await expect(failing.host.mutate({
      operationId: "cancel-background-failure-operation",
      connection: failing.connection,
      kind: "cancelBackgroundTask",
      body: mutationBody,
      effect: () => failing.host.cancelBackgroundTask(
        failingSessionId,
        "failing-background-task",
        "cancel-background-failure-operation"
      ),
      commit: () => ({ accepted: true })
    })).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(failing.store.getOperation("cancel-background-failure-operation")).toMatchObject({
      status: "failed",
      kind: "cancelBackgroundTask",
      error: {
        code: "EFFECT_FAILED",
        message: "simulated background cancellation failure",
        stateMayHaveChanged: true
      }
    });
    expect(failing.store.hasActiveSessionBackgroundTasks(failingSessionId)).toBe(true);
    expect(failingAdapter.cancellations).toHaveLength(1);
  });

  it("fails and safely aborts a Backend-accepted Run after a bounded interval with no durable progress", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new RunSilenceFakeAdapter();
      const fixture = await createFixture(adapter, { runSilenceTimeoutMs: 100 });
      const sessionId = (await fixture.host.createSession({
        operationId: "create-run-silence-timeout",
        connection: fixture.connection,
        targetId: "target-one",
        title: "Run silence timeout",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const queued = fixture.host.enqueueInput({
        operationId: "run-silence-timeout",
        connection: fixture.connection,
        sessionId,
        prompt: { text: "be completely silent", images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("backend_accepted");
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("running");

      await vi.advanceTimersByTimeAsync(99);
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("running");
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.store.getQueueItem(queued.value.queueItemId)).toMatchObject({
        state: "failed",
        error: { code: "BACKEND_RUN_SILENCE_TIMEOUT", phase: "stream", stateMayHaveChanged: true }
      });
      expect(fixture.store.getRun(queued.value.runId).descriptor).toMatchObject({
        state: "failed",
        error: { code: "BACKEND_RUN_SILENCE_TIMEOUT", retryable: true }
      });
      const events = fixture.store.listEvents({ sessionId });
      const terminalIndex = events.findIndex((event) =>
        event.payload.type === "error" && event.payload.error.code === "BACKEND_RUN_SILENCE_TIMEOUT"
      );
      const failedStateIndex = events.findIndex((event) =>
        event.payload.type === "run_state" && event.payload.state === "failed"
      );
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(failedStateIndex).toBeGreaterThan(terminalIndex);
      expect(adapter.abortCalls).toBe(1);
      expect(adapter.closeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an accepted-Run runtime when silence recovery abort does not make it observably idle", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new RunSilenceFakeAdapter();
      adapter.abortLeavesRuntimeBusy = true;
      const fixture = await createFixture(adapter, { runSilenceTimeoutMs: 100 });
      const sessionId = (await fixture.host.createSession({
        operationId: "create-run-silence-close",
        connection: fixture.connection,
        targetId: "target-one",
        title: "Run silence close",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const queued = fixture.host.enqueueInput({
        operationId: "run-silence-close",
        connection: fixture.connection,
        sessionId,
        prompt: { text: "remain busy after abort", images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.store.getRun(queued.value.runId).descriptor).toMatchObject({
        state: "failed",
        error: { code: "BACKEND_RUN_SILENCE_TIMEOUT" }
      });
      expect(adapter.abortCalls).toBe(1);
      expect(adapter.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the accepted-Run silence window from durably persisted heartbeat events", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new RunSilenceFakeAdapter();
      const fixture = await createFixture(adapter, { runSilenceTimeoutMs: 100 });
      const sessionId = (await fixture.host.createSession({
        operationId: "create-run-silence-heartbeat",
        connection: fixture.connection,
        targetId: "target-one",
        title: "Run heartbeat",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const queued = fixture.host.enqueueInput({
        operationId: "run-silence-heartbeat",
        connection: fixture.connection,
        sessionId,
        prompt: { text: "long healthy tool", images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await vi.advanceTimersByTimeAsync(0);

      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(90);
        await adapter.heartbeat();
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("running");
      expect(fixture.store.listEvents({ sessionId }).filter((event) =>
        event.payload.type === "status" && event.payload.key === "long-tool-heartbeat"
      )).toHaveLength(3);
      expect(adapter.abortCalls).toBe(0);

      await fixture.host.abort(sessionId, queued.value.runId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses accepted-Run silence detection for explicit interaction and active background work", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new RunSilenceFakeAdapter();
      const fixture = await createFixture(adapter, { runSilenceTimeoutMs: 100 });
      const sessionId = (await fixture.host.createSession({
        operationId: "create-run-silence-pauses",
        connection: fixture.connection,
        targetId: "target-one",
        title: "Run explicit waits",
        fastMode: false,
        permissionMode: "ask",
        planMode: false
      })).value.sessionId;
      const queued = fixture.host.enqueueInput({
        operationId: "run-silence-pauses",
        connection: fixture.connection,
        sessionId,
        prompt: { text: "wait explicitly", images: [], files: [], mentions: [], disposition: "prompt" }
      });
      await vi.advanceTimersByTimeAsync(0);

      adapter.requestExplicitInteraction("run-silence-question");
      await vi.advanceTimersByTimeAsync(500);
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("running");
      expect(adapter.abortCalls).toBe(0);
      fixture.host.resolveInteraction(
        "run-silence-question",
        fixture.store.getSession(sessionId).descriptor.binding.generation,
        { kind: "question", answers: {} },
        "test:run-silence-question"
      );

      await adapter.emitBackgroundTask("running");
      await vi.advanceTimersByTimeAsync(500);
      expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("running");
      expect(adapter.abortCalls).toBe(0);

      await adapter.emitBackgroundTask("completed");
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.getRun(queued.value.runId).descriptor).toMatchObject({
        state: "failed",
        error: { code: "BACKEND_RUN_SILENCE_TIMEOUT" }
      });
      expect(adapter.abortCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lazily resumes stored sessions and reclaims only truly idle runtimes", async () => {
    let monotonicNow = 0;
    const adapter = new ResumeCountingFakeAdapter();
    const fixture = await createFixture(adapter, { monotonicNow: () => monotonicNow });
    const sessionId = (await fixture.host.createSession({
      operationId: "create-idle-runtime",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Idle runtime",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    monotonicNow = 999;
    await expect(fixture.host.reapIdleRuntimes(1_000)).resolves.toEqual([]);
    monotonicNow = 1_001;
    await expect(fixture.host.reapIdleRuntimes(1_000)).resolves.toEqual([sessionId]);
    expect(adapter.detachCalls).toBe(1);
    await fixture.host.inspect(sessionId);
    expect(adapter.resumeCalls).toBe(1);

    await fixture.host.dispose();
    const restarted = new ResumeCountingFakeAdapter();
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restarted], {
      monotonicNow: () => monotonicNow
    });
    await restartedHost.initialize();
    expect(restarted.resumeCalls).toBe(0);
    await restartedHost.inspect(sessionId);
    expect(restarted.resumeCalls).toBe(1);
    await restartedHost.dispose();
  });

  it("recreates a crash-recovered blank native task from its exact durable launch profile", async () => {
    const originalAdapter = new BlankNativeRecoveryFakeAdapter();
    const fixture = await createFixture(originalAdapter);
    const appendSystemPrompt = "Keep the recovered runtime on its original private launch policy.";
    const sessionId = (await fixture.host.createSession({
      operationId: "create-crash-recovered-blank-native",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Crash-recovered blank native",
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      appendSystemPrompt
    })).value.sessionId;
    const original = fixture.store.getSession(sessionId).descriptor.binding;
    expect(fixture.store.listEvents({ sessionId }).some((event) =>
      event.payload.type === "runtime_commands_changed"
    )).toBe(true);
    expect(fixture.store.nativeBlankRecoveryEligible(sessionId)).toBe(true);

    await fixture.host.dispose();
    const recoveredAdapter = new BlankNativeRecoveryFakeAdapter();
    recoveredAdapter.failResumeWithoutSideEffects = true;
    recoveredAdapter.throwOnHistoryRead = true;
    const recoveredHost = new SessionHost(fixture.store, fixture.artifacts, [recoveredAdapter]);
    cleanups.push(() => recoveredHost.dispose());
    await recoveredHost.initialize();

    await expect(recoveredHost.inspect(sessionId)).resolves.toMatchObject({
      binding: expect.objectContaining({ generation: original.generation + 2 }),
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: true,
      permissionMode: "auto"
    });
    expect(recoveredAdapter.createInputs).toEqual([expect.objectContaining({
      target: expect.objectContaining({ id: "target-one" }),
      name: "Crash-recovered blank native",
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      appendSystemPrompt,
      nativeStart: { kind: "new" }
    })]);
    expect(recoveredAdapter.createContexts[0]).toMatchObject({
      sessionId,
      generation: original.generation + 2,
      appendSystemPrompt
    });
    expect(recoveredAdapter.planSelections.at(-1)).toEqual({ sessionId, enabled: true });
    expect(recoveredAdapter.historyReads).toBe(0);
    expect(fixture.store.getSession(sessionId).descriptor).toMatchObject({
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      appendSystemPrompt
    });
  });

  it("never grants blank recovery to a native task created from a parent", async () => {
    const adapter = new BlankNativeRecoveryFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-native-child-with-parent",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Native child with parent",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: {
        kind: "new",
        parentNativeReference: "fake://discovery/resumable"
      }
    })).value.sessionId;

    expect(fixture.store.nativeBlankRecoveryEligible(sessionId)).toBe(false);
    await fixture.host.closeIfActive(sessionId);
    const createsBeforeRecovery = adapter.createInputs.length;
    adapter.failResumeWithoutSideEffects = true;

    await expect(fixture.host.inspect(sessionId)).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP", stateMayHaveChanged: false }
    });
    expect(adapter.createInputs).toHaveLength(createsBeforeRecovery);
  });

  it("never recreates a native task after retained history or any accepted input", async () => {
    const adapter = new BlankNativeRecoveryFakeAdapter();
    const fixture = await createFixture(adapter);
    const createBlank = async (operationId: string): Promise<string> => (await fixture.host.createSession({
      operationId,
      connection: fixture.connection,
      targetId: "target-one",
      title: operationId,
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    const historySessionId = await createBlank("create-blank-with-retained-history");
    const historySession = fixture.store.getSession(historySessionId).descriptor;
    fixture.store.appendEvent({
      backendId: historySession.backendId,
      targetId: historySession.targetId,
      sessionId: historySessionId,
      generation: historySession.binding.generation,
      traceId: "retained-native-history-proof",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "retained" }],
        nativeHistory: { identity: { entryId: "retained-root" } }
      },
      metadata: { namespace: "joko.native_history", fields: { nativeEntryId: "retained-root" } }
    });
    await fixture.host.closeIfActive(historySessionId);

    const acceptedSessionId = await createBlank("create-blank-with-accepted-input");
    fixture.store.setQueuePaused({
      sessionId: acceptedSessionId,
      paused: true,
      reason: "Hold the accepted first input",
      connectionId: fixture.connection.id,
      traceId: "blank-recovery:accepted-input"
    });
    fixture.host.enqueueInput({
      operationId: "accept-first-input-before-runtime-loss",
      connection: fixture.connection,
      sessionId: acceptedSessionId,
      prompt: { text: "Already accepted", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await fixture.host.closeIfActive(acceptedSessionId);

    expect(fixture.store.nativeBlankRecoveryEligible(historySessionId)).toBe(false);
    expect(fixture.store.nativeBlankRecoveryEligible(acceptedSessionId)).toBe(false);
    const createsBeforeRecovery = adapter.createInputs.length;
    adapter.failResumeWithoutSideEffects = true;
    await expect(fixture.host.inspect(historySessionId)).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP", stateMayHaveChanged: false }
    });
    await expect(fixture.host.inspect(acceptedSessionId)).rejects.toMatchObject({
      publicError: { code: "NATIVE_SESSION_CONTINUITY_GAP", stateMayHaveChanged: false }
    });
    expect(adapter.createInputs).toHaveLength(createsBeforeRecovery);
  });

  it("closes a newly created blank recovery runtime when its durable binding CAS loses", async () => {
    const adapter = new BlankNativeRecoveryFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-blank-recovery-cas-loss",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Blank recovery CAS loss",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.closeIfActive(sessionId);
    adapter.failResumeWithoutSideEffects = true;
    const rebind = vi.spyOn(fixture.store, "rebindNativeBlankSession")
      .mockImplementationOnce(() => { throw new StoreError("forced blank recovery CAS loss"); });

    await expect(fixture.host.inspect(sessionId)).rejects.toThrow("forced blank recovery CAS loss");

    expect(rebind).toHaveBeenCalledOnce();
    const recoveredBinding = adapter.createdBindings.at(-1)!;
    expect(adapter.closedBindings).toContainEqual(recoveredBinding);
    expect(fixture.store.getSession(sessionId).descriptor.binding).not.toEqual(recoveredBinding);
    expect(fixture.store.nativeBlankRecoveryEligible(sessionId)).toBe(true);
  });

  it("restores an inactive runtime without invoking unsupported live control axes", async () => {
    const adapter = new UnsupportedResumeControlsFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-unsupported-resume-controls",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Unsupported resume controls",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    const beforeGeneration = fixture.store.getSession(sessionId).descriptor.binding.generation;
    await fixture.host.closeIfActive(sessionId);
    await expect(fixture.host.inspect(sessionId)).resolves.toMatchObject({
      binding: expect.objectContaining({ generation: beforeGeneration + 1 })
    });
    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.unsupportedControlCalls).toEqual([]);
  });

  it("closes a resumed runtime when a supported profile restore fails", async () => {
    const adapter = new FailingResumeControlFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-failing-resume-control",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Failing resume control",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    await fixture.host.closeIfActive(sessionId);
    adapter.closeCalls = 0;
    adapter.failFastRestore = true;
    await expect(fixture.host.inspect(sessionId)).rejects.toThrow(/resume Fast restore failed/u);
    expect(adapter.closeCalls).toBe(1);
    adapter.failFastRestore = false;
    await expect(fixture.host.inspect(sessionId)).resolves.toBeDefined();
  });

  it("applies hot settings only to active runtimes without resuming sleeping sessions", async () => {
    let monotonicNow = 0;
    const adapter = new SettingsTrackingFakeAdapter();
    const fixture = await createFixture(adapter, { monotonicNow: () => monotonicNow });
    const create = (operationId: string) => fixture.host.createSession({
      operationId,
      connection: fixture.connection,
      targetId: "target-one",
      title: operationId,
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const activeId = (await create("create-hot-settings-active")).value.sessionId;
    const sleepingId = (await create("create-hot-settings-sleeping")).value.sessionId;

    monotonicNow = 1_001;
    expect(await fixture.host.reapIdleRuntimes(1_000)).toEqual(expect.arrayContaining([activeId, sleepingId]));
    await fixture.host.inspect(activeId);
    expect(adapter.resumeCalls).toBe(1);

    const applied = await fixture.host.applyToActiveSessions({ backendId: adapter.id }, async (sessionId, runtime, context) => {
      await runtime.setAutoCompaction(false, context);
      await runtime.setAutoRetry(false, context);
      expect(sessionId).toBe(activeId);
    });

    expect(applied).toEqual([activeId]);
    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.autoCompactionUpdates).toEqual([{ sessionId: activeId, enabled: false }]);
    expect(adapter.autoRetryUpdates).toEqual([{ sessionId: activeId, enabled: false }]);
    expect(fixture.store.getSession(sleepingId).descriptor.binding.generation).toBe(1);
  });

  it("returns a generation-fenced native observation after a model change so callers persist Pi's clamped effort", async () => {
    const adapter = new ClampingModelFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-model-clamp",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Model clamp",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    const state = await fixture.host.applySessionSettings(sessionId, {
      providerId: "vision",
      modelId: "multimodal"
    }, { requireNativeObservation: true });

    expect(state).toMatchObject({
      providerId: "vision",
      modelId: "multimodal",
      effort: "low",
      fastMode: false
    });
    const observation = materializedNativeStateObservation(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value);
    expect(observation?.state).toMatchObject({
      providerId: "vision",
      modelId: "multimodal",
      effort: "low"
    });
  });

  it("attempts every Adapter shutdown, records redacted diagnostics, and throws the failures", async () => {
    const secret = "sk-shutdownsecret123456";
    const failure = new JokoError({
      code: "PI_DISPOSE_INCOMPLETE",
      message: `Pi shutdown could not confirm ${secret}`,
      phase: "shutdown",
      retryable: true,
      stateMayHaveChanged: true,
      recovery: `Inspect the runtime without exposing ${secret}.`
    });
    const failing = new DisposeTrackingFakeAdapter("dispose-failing", failure);
    const successful = new DisposeTrackingFakeAdapter("dispose-successful");
    const fixture = await createMultiAdapterFixture([failing, successful]);

    let thrown: unknown;
    try {
      await fixture.host.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([failure]);
    expect(failing.disposeCalls).toBe(1);
    expect(successful.disposeCalls).toBe(1);
    const diagnostics = fixture.store.listDiagnostics({ component: `adapter_shutdown:${failing.id}` });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", code: "PI_DISPOSE_INCOMPLETE" });
    const diagnosticBody = JSON.stringify({ message: diagnostics[0]!.message, details: diagnostics[0]!.details });
    expect(diagnosticBody).not.toContain(secret);
    expect(diagnosticBody).toContain("[REDACTED]");
  });

  it("disposes every Adapter without diagnostics when all shutdowns succeed", async () => {
    const first = new DisposeTrackingFakeAdapter("dispose-first");
    const second = new DisposeTrackingFakeAdapter("dispose-second");
    const fixture = await createMultiAdapterFixture([first, second]);

    await expect(fixture.host.dispose()).resolves.toBeUndefined();

    expect(first.disposeCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
    expect(fixture.store.listDiagnostics().filter((item) => item.component.startsWith("adapter_shutdown:"))).toEqual([]);
  });

  it("joins a dispatch interrupted by Adapter shutdown before disposal returns", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-dispose-drain",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Dispose drain",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    adapter.injectFault(sessionId, "hang");
    const queued = fixture.host.enqueueInput({
      operationId: "send-dispose-drain",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "hold during shutdown", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "dispatching");

    await expect(fixture.host.dispose()).resolves.toBeUndefined();

    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("dispatching");
  });

  it("claims due schedules durably and dispatches them without a live UI connection", async () => {
    const fixture = await createFixture(new QuoteGateFakeAdapter());
    const sessionId = (await fixture.host.createSession({
      operationId: "create-scheduled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Scheduled",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const scheduledAt = Date.now() - 10;
    fixture.store.upsertSchedule({
      id: "schedule-one",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "One shot",
      kind: "one_shot",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "scheduled prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: scheduledAt
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => scheduledAt + 10_000,
      misfireGraceMs: 1_000
    });
    await scheduler.tick();
    const history = fixture.store.listScheduleRuns("schedule-one");
    expect(history).toHaveLength(1);
    await eventually(() => fixture.store.getRun(history[0]!.runId).descriptor.state === "completed");
    expect(fixture.store.getSchedule("schedule-one").enabled).toBe(false);
    const dispatchOperation = fixture.store.listOperations().find((operation) => operation.kind === "schedule_dispatch");
    expect(dispatchOperation?.body).toMatchObject({ scheduleId: "schedule-one", scheduleName: "One shot" });
    const scheduledUserEvents = fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "message_complete" && event.payload.role === "user"
    );
    expect(scheduledUserEvents.length).toBeGreaterThan(0);
    expect(scheduledUserEvents.every((event) => event.payload.type === "message_complete" && event.payload.automationOrigin?.scheduleId === "schedule-one" && event.payload.inputDelivery === "scheduler")).toBe(true);
    expect(scheduledUserEvents[0]?.payload).toMatchObject({ automationOrigin: {
      kind: "scheduler",
      scheduleId: "schedule-one",
      scheduleName: "One shot",
      runId: history[0]!.runId
    } });
  });

  it("treats an empty Schedule extra-directory selection as no override", async () => {
    const fixture = await createFixture(new FakeBackendAdapter(CODEX_LIKE_PROFILE));
    const sessionId = (await fixture.host.createSession({
      operationId: "create-schedule-without-extra-directories",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Scheduled without extra directories",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.upsertSchedule({
      id: "schedule-without-extra-directories",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "No extra directories",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "scheduled prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        extraDirectoryIds: []
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    const dispatched = await scheduler.runNowWithResult("schedule-without-extra-directories", "empty-extra-directories");
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");

    const queued = fixture.store.listQueueItems({ sessionId });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.state).toBe("completed");
    expect(queued[0]?.executionOverrides).toBeUndefined();
  });

  it("does not classify an empty scheduler scan as shutdown-blocking activity", async () => {
    const fixture = await createFixture();
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    let observedDuringScan: boolean | undefined;
    vi.spyOn(fixture.store, "listDueSchedules").mockImplementation(() => {
      observedDuringScan = scheduler.hasInFlightActivity();
      return [];
    });

    await scheduler.tick();

    expect(observedDuringScan).toBe(false);
    expect(scheduler.hasInFlightActivity()).toBe(false);
  });

  it("classifies a Schedule occurrence before its product Session exists as shutdown-blocking", async () => {
    const adapter = new GatedFakeAdapter();
    const fixture = await createFixture(adapter);
    fixture.store.upsertSchedule({
      id: "schedule-activity-window",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Activity window",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "hold before native creation", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const gate = adapter.holdCreate();
    const onActivityTransition = vi.fn();
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, { onActivityTransition });

    const dispatch = scheduler.runNow("schedule-activity-window", "activity-window");
    await gate.entered;

    expect(scheduler.hasInFlightActivity()).toBe(true);
    expect(scheduler.runtimeSnapshot()).toMatchObject({
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: 8,
      inFlightRuns: [{
        scheduleId: "schedule-activity-window",
        scheduleName: "Activity window",
        source: "run-now",
        executionMode: "agent",
        phase: "running"
      }]
    });
    gate.release();
    await dispatch;
    expect(scheduler.hasInFlightActivity()).toBe(false);
    expect(scheduler.runtimeSnapshot()).toMatchObject({ inFlight: 0, slotsInUse: 0 });
    expect(onActivityTransition).toHaveBeenCalledTimes(2);
  });

  it("fences deletion through awaited task creation while keep leaves the generated task usable", async () => {
    const adapter = new GatedFakeAdapter();
    const fixture = await createFixture(adapter);
    const scheduleInput = {
      id: "schedule-delete-resolve-race",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh" as const,
      name: "Delete resolve race",
      kind: "manual" as const,
      timezone: "UTC",
      enabled: true,
      prompt: { text: "must be fenced", images: [], files: [], mentions: [], disposition: "prompt" as const },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue" as const,
      misfirePolicy: "run_once" as const
    };
    fixture.store.upsertSchedule(scheduleInput);
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    const gate = adapter.holdCreate();

    const dispatch = scheduler.runNow(scheduleInput.id, "delete-resolve-race-run");
    await gate.entered;
    const deletion = scheduler.beginScheduleDeletion(scheduleInput.id, "delete-resolve-race-operation");
    expect(scheduler.isScheduleDeletionFenced(scheduleInput.id)).toBe(true);
    gate.release();
    const occurrenceRunIds = await deletion;
    await dispatch;

    expect(fixture.store.listRuns({ activeOnly: true })).toHaveLength(0);
    expect(fixture.store.listQueueItems().filter((item) =>
      item.state === "accepted" || item.state === "dispatching"
    )).toHaveLength(0);
    const manifest = fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-resolve-race-operation",
      scheduleId: scheduleInput.id,
      disposition: "keep",
      occurrenceRunIds,
      at: 10
    });
    expect(manifest.generatedSessionIds).toHaveLength(1);
    const generatedSessionId = manifest.generatedSessionIds[0]!;
    const resumeSession = vi.spyOn(adapter, "resumeSession");
    await fixture.host.closeIfActive(generatedSessionId);
    await expect(fixture.host.inspect(generatedSessionId)).resolves.toBeDefined();
    await fixture.host.resume(generatedSessionId);
    const admitted = fixture.host.enqueueInput({
      operationId: "send-during-schedule-delete",
      connection: fixture.connection,
      sessionId: generatedSessionId,
      prompt: { text: "keep remains usable", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getRun(admitted.value.runId).descriptor.state === "completed", 5_000);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(fixture.store.listRuns({ sessionId: generatedSessionId, activeOnly: true })).toHaveLength(0);
    expect(fixture.store.listScheduleRuns(scheduleInput.id)).toEqual([
      expect.objectContaining({ status: "aborted" })
    ]);
    expect(fixture.store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: [],
      failures: [],
      at: 11
    }).state).toBe("completed");
    scheduler.releaseScheduleDeletion(scheduleInput.id, manifest.operationId);
    expect(scheduler.isScheduleDeletionFenced(scheduleInput.id)).toBe(false);

    fixture.store.upsertSchedule({ ...scheduleInput, now: 12 });
    await scheduler.runNow(scheduleInput.id, "delete-resolve-race-recreated");
    const recreated = fixture.store.listScheduleRuns(scheduleInput.id)[0]!;
    await eventually(() => fixture.store.getRun(recreated.runId).descriptor.state === "completed", 5_000);
  });

  it("keeps a dormant generated task fenced across service restart until its manifest completes", async () => {
    const fixture = await createFixture();
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-delete-restart-fence",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Restart deletion fence",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "stay dormant", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const created = await fixture.host.createScheduledSession({
      operationId: "create-restart-fenced-session",
      targetId: "target-one",
      title: schedule.name,
      automationOrigin: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "restart-fenced-run",
        scheduleRevision: schedule.revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    await fixture.host.closeIfActive(created.value.sessionId);
    const manifest = fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-restart-fenced-session",
      scheduleId: schedule.id,
      disposition: "delete",
      occurrenceRunIds: [],
      at: 10
    });
    await fixture.host.dispose();

    const restartedAdapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const resumeSession = vi.spyOn(restartedAdapter, "resumeSession");
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();

    await expect(restartedHost.inspect(created.value.sessionId)).rejects.toThrow(/deletion is in progress/u);
    await expect(restartedHost.resume(created.value.sessionId)).rejects.toThrow(/deletion is in progress/u);
    expect(resumeSession).not.toHaveBeenCalled();

    expect(fixture.store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: manifest.generatedSessionIds,
      failures: [],
      at: 11
    }).state).toBe("completed");
    await expect(restartedHost.inspect(created.value.sessionId)).rejects.toThrow(/archived or deleted/iu);
    await expect(restartedHost.resume(created.value.sessionId)).rejects.toThrow(/archived or deleted/iu);
    expect(() => restartedHost.enqueueInput({
      operationId: "send-after-generated-delete",
      connection: fixture.connection,
      sessionId: created.value.sessionId,
      prompt: { text: "stale client", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrow(/archived or deleted/iu);
    expect(() => fixture.store.createRun({
      id: "run-after-generated-delete",
      sessionId: created.value.sessionId,
      source: "user",
      state: "queued",
      createdAt: 12
    })).toThrow(/archived or deleted/iu);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("drains accepted generated-task work after restart while a keep deletion remains pending", async () => {
    const fixture = await createFixture(new SendCountingFakeAdapter());
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-keep-restart",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Keep generated task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "keep working", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const created = await fixture.host.createScheduledSession({
      operationId: "create-keep-restart-session",
      targetId: "target-one",
      title: schedule.name,
      automationOrigin: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "keep-restart-run",
        scheduleRevision: schedule.revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const sessionId = created.value.sessionId;
    fixture.store.setQueuePaused({
      sessionId,
      paused: true,
      reason: "Hold until restart",
      connectionId: fixture.connection.id,
      traceId: "test:keep-restart:pause"
    });
    const queued = fixture.host.enqueueInput({
      operationId: "enqueue-keep-restart",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "survive restart", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    const manifest = fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-schedule-keep-restart",
      scheduleId: schedule.id,
      disposition: "keep",
      occurrenceRunIds: [],
      at: 10
    });
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("accepted");
    expect(() => fixture.store.upsertSchedule({
      ...schedule,
      name: "Blocked update",
      expectedRevision: fixture.store.getSchedule(schedule.id).revision,
      now: 11
    })).toThrow(/deletion/iu);
    await fixture.host.dispose();
    fixture.store.setQueuePaused({ sessionId, paused: false, traceId: "test:keep-restart:resume" });

    const restartedAdapter = new SendCountingFakeAdapter();
    const closeSession = vi.spyOn(restartedAdapter, "closeSession");
    const resumeSession = vi.spyOn(restartedAdapter, "resumeSession");
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();

    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
    await expect(restartedHost.inspect(sessionId)).resolves.toBeDefined();
    const second = restartedHost.enqueueInput({
      operationId: "enqueue-during-keep-cleanup",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "still usable", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getRun(second.value.runId).descriptor.state === "completed");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(restartedAdapter.sendCalls).toBe(2);
    expect(closeSession).not.toHaveBeenCalled();
    expect(fixture.store.getScheduleDeletionCleanup(manifest.operationId).state).toBe("pending");
  });

  it("waits for a claimed workspace-capture dispatch to quiesce before generated-task cleanup", async () => {
    const capture = new GatedWorkspaceRunCapture();
    const adapter = new SendCountingFakeAdapter();
    const fixture = await createFixture(adapter, { workspaceCapture: capture });
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-delete-capture-flight",
      backendId: adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Capture flight deletion",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "capture", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const created = await fixture.host.createScheduledSession({
      operationId: "create-capture-flight-session",
      targetId: "target-one",
      title: schedule.name,
      automationOrigin: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "capture-flight-origin",
        scheduleRevision: schedule.revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const closeSession = vi.spyOn(adapter, "closeSession");
    const queued = fixture.host.enqueueInput({
      operationId: "send-capture-flight",
      connection: fixture.connection,
      sessionId: created.value.sessionId,
      prompt: { text: "never dispatch", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await capture.beforeRunGate.entered;
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("dispatching");

    const manifest = fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-capture-flight",
      scheduleId: schedule.id,
      disposition: "delete",
      at: Date.now()
    });
    let closeSettled = false;
    const close = fixture.host.closeIfActive(created.value.sessionId).then(() => { closeSettled = true; });
    const workspaceCleanup = vi.fn();
    await nextTurn();

    expect(closeSettled).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
    expect(workspaceCleanup).not.toHaveBeenCalled();

    capture.beforeRunGate.release();
    await close;
    workspaceCleanup();
    const completed = fixture.store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: manifest.generatedSessionIds,
      failures: [],
      at: Date.now()
    });

    expect(adapter.sendCalls).toBe(0);
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("cancelled");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("aborted");
    expect(capture.abortedRunIds).toEqual([queued.value.runId]);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(workspaceCleanup).toHaveBeenCalledTimes(1);
    expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(workspaceCleanup.mock.invocationCallOrder[0]!);
    expect(completed.state).toBe("completed");
    expect(fixture.store.getSession(created.value.sessionId).descriptor.deletedAt).toBeDefined();
  });

  it("stops a gated multi-setting turn override before close or Backend send during generated-task deletion", async () => {
    const adapter = new GatedTurnOverrideFakeAdapter();
    const fixture = await createFixture(adapter);
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-delete-override-flight",
      backendId: adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Override flight deletion",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "override", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const created = await fixture.host.createScheduledSession({
      operationId: "create-override-flight-session",
      targetId: "target-one",
      title: schedule.name,
      automationOrigin: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId: "override-flight-origin",
        scheduleRevision: schedule.revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    adapter.overrideArmed = true;
    const queued = fixture.host.enqueueInput({
      operationId: "send-override-flight",
      connection: fixture.connection,
      sessionId: created.value.sessionId,
      prompt: { text: "never dispatch", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { permissionMode: "auto", planMode: true }
    });
    await adapter.overrideGate.entered;

    const manifest = fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-override-flight",
      scheduleId: schedule.id,
      disposition: "delete",
      at: Date.now()
    });
    let closeSettled = false;
    const close = fixture.host.closeIfActive(created.value.sessionId).then(() => { closeSettled = true; });
    await nextTurn();
    expect(closeSettled).toBe(false);
    expect(adapter.calls).toEqual(["permission:start"]);

    adapter.overrideGate.release();
    await close;
    fixture.store.finalizeScheduleDeletionCleanup({
      operationId: manifest.operationId,
      completedSessionIds: manifest.generatedSessionIds,
      failures: [],
      at: Date.now()
    });

    expect(adapter.permissionOverrideCalls).toBe(1);
    expect(adapter.planOverrideCalls).toBe(0);
    expect(adapter.sendCalls).toBe(0);
    expect(adapter.calls).toEqual(["permission:start", "permission:end", "close"]);
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("cancelled");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("aborted");
    expect(fixture.store.getSession(created.value.sessionId).descriptor.deletedAt).toBeDefined();
  });

  it("does not restore turn overrides after deletion interrupts an in-flight Backend send", async () => {
    const adapter = new GatedSendingDeletionFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-sending-lifecycle-race",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Sending lifecycle race",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    adapter.sendArmed = true;
    adapter.closeArmed = true;
    const queued = fixture.host.enqueueInput({
      operationId: "send-during-lifecycle-delete",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "interrupt this send", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { permissionMode: "auto" }
    });
    await adapter.sendGate.entered;
    const manifest = fixture.store.prepareSessionLifecycleCleanup({
      operationId: "delete-during-backend-send",
      sessionId,
      disposition: "delete",
      at: Date.now()
    });
    const close = fixture.host.closeIfActive(sessionId);
    await adapter.closeGate.entered;

    adapter.sendGate.release();
    await nextTurn();
    expect(adapter.restoredPermissionModes).toEqual(["auto"]);
    adapter.closeGate.release();
    await close;
    fixture.store.advanceSessionLifecycleCleanup({
      operationId: manifest.operationId,
      phase: "close",
      at: Date.now()
    });
    fixture.store.finalizeSessionLifecycleCleanup({
      operationId: manifest.operationId,
      at: Date.now()
    });

    expect(adapter.closeCalls).toBe(1);
    expect(adapter.sendCalls).toBe(1);
    expect(adapter.restoredPermissionModes).toEqual(["auto"]);
    expect(fixture.store.getQueueItem(queued.value.queueItemId).state).toBe("cancelled");
    expect(fixture.store.getRun(queued.value.runId).descriptor.state).toBe("aborted");
    expect(fixture.store.getSession(sessionId).descriptor.deletedAt).toBeDefined();
  });

  it("runs a pre-run gate before task creation and keeps a zero-token skipped history row", async () => {
    const fixture = await createFixture();
    const hookPath = join(fixture.directory, "scripts", "schedule-checks", "skip.mjs");
    const executePreRunHook = vi.fn(async () => ({
      status: "skipped" as const,
      decision: "skip" as const,
      exitCode: 2,
      durationMs: 7,
      stdout: "nothing changed",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false
    }));
    const validatePreRunHookBinding = vi.fn(async () => hookPath);
    fixture.store.upsertSchedule({
      id: "schedule-pre-run-skip",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Skip before task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "must not be sent", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent",
          preRunHook: { command: `joko-node "${hookPath}"`, filePath: hookPath, timeoutMs: 5_000 }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, {
      executePreRunHook,
      validatePreRunHookBinding
    });

    const dispatched = await scheduler.runNowWithResult("schedule-pre-run-skip", "pre-run-skip");

    expect(dispatched).toMatchObject({ status: "skipped" });
    expect(dispatched).not.toHaveProperty("sessionId");
    expect(fixture.store.listSessions()).toHaveLength(0);
    expect(fixture.store.listQueueItems()).toHaveLength(0);
    expect(() => fixture.store.getRun(dispatched.runId)).toThrow();
    expect(fixture.store.listScheduleRuns("schedule-pre-run-skip")).toEqual([
      expect.objectContaining({
        runId: dispatched.runId,
        status: "skipped",
        finishedAt: expect.any(Number),
        detail: expect.objectContaining({
          costAttribution: "zero",
          preRunHook: expect.objectContaining({ status: "skipped", decision: "skip", exitCode: 2 })
        })
      })
    ]);
    expect(validatePreRunHookBinding).toHaveBeenCalledOnce();
    expect(executePreRunHook).toHaveBeenCalledWith(expect.objectContaining({
      command: `joko-node "${hookPath}"`,
      cwd: fixture.directory,
      stdinPayload: expect.objectContaining({
        event: "schedule-pre-run",
        scheduleId: "schedule-pre-run-skip",
        runId: dispatched.runId
      })
    }));
  });

  it("joins a passed pre-run gate to the same real Run and finalizes its durable history", async () => {
    const fixture = await createFixture();
    const hookPath = join(fixture.directory, "scripts", "schedule-checks", "pass.mjs");
    const executePreRunHook = vi.fn(async () => ({
      status: "passed" as const,
      decision: "run" as const,
      exitCode: 0,
      durationMs: 3,
      stdout: "ready",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false
    }));
    fixture.store.upsertSchedule({
      id: "schedule-pre-run-pass",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Pass before task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "send after pass", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent",
          preRunHook: { command: `joko-node "${hookPath}"`, filePath: hookPath }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, {
      executePreRunHook,
      validatePreRunHookBinding: async () => hookPath
    });

    const dispatched = await scheduler.runNowWithResult("schedule-pre-run-pass", "pre-run-pass");
    expect(dispatched).toMatchObject({ status: "queued", sessionId: expect.any(String) });
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");

    const history = fixture.store.listScheduleRuns("schedule-pre-run-pass");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      runId: dispatched.runId,
      sessionId: dispatched.sessionId,
      status: "success",
      finishedAt: expect.any(Number),
      detail: {
        preRunHook: expect.objectContaining({ status: "passed", decision: "run", exitCode: 0 })
      }
    });
    expect(fixture.store.getRun(dispatched.runId).descriptor.sessionId).toBe(dispatched.sessionId);
    expect(executePreRunHook).toHaveBeenCalledOnce();
  });

  it("disables an expired schedule before any pre-run gate or task effect", async () => {
    const fixture = await createFixture();
    const executePreRunHook = vi.fn();
    fixture.store.upsertSchedule({
      id: "schedule-expired-extension",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Expired",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "must not run", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent",
          expireAt: 9_999
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      now: 1_000
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => 10_000,
      executePreRunHook
    });

    await expect(scheduler.runNowWithResult("schedule-expired-extension", "expired-extension"))
      .rejects.toThrow("expired");
    expect(fixture.store.getSchedule("schedule-expired-extension").enabled).toBe(false);
    expect(fixture.store.listScheduleRuns("schedule-expired-extension")).toHaveLength(0);
    expect(fixture.store.listSessions()).toHaveLength(0);
    expect(executePreRunHook).not.toHaveBeenCalled();
  });

  it("runs a script Schedule to durable zero-cost success without fabricating a product Session or core Run", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.directory, "schedule-complete.mjs");
    writeFileSync(scriptPath, [
      "import { createInterface } from 'node:readline';",
      "const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of lines) {",
      "  const frame = JSON.parse(line);",
      "  if (frame.type === 'start') console.log(JSON.stringify({ protocol: 'joko-schedule-script/1', type: 'complete', resultText: 'probe complete' }));",
      "}"
    ].join("\n"), "utf8");
    fixture.store.upsertSchedule({
      id: "schedule-script-zero-cost",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Script probe",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "script",
          scriptConfig: {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
            capabilities: []
          }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });

    const result = await new ScheduleCoordinator(fixture.store, fixture.host)
      .runNowWithResult("schedule-script-zero-cost", "script-zero-cost");
    expect(result).toMatchObject({ status: "success" });
    expect(result).not.toHaveProperty("sessionId");
    expect(fixture.store.listSessions()).toHaveLength(0);
    expect(() => fixture.store.getRun(result.runId)).toThrow();
    expect(fixture.store.listScheduleRuns("schedule-script-zero-cost")).toEqual([
      expect.objectContaining({
        runId: result.runId,
        status: "success",
        finishedAt: expect.any(Number),
        detail: {
          script: {
            status: "completed",
            durationMs: expect.any(Number),
            stderrTruncated: false,
            resultText: "probe complete"
          },
          costAttribution: "zero"
        }
      })
    ]);
  });

  it("lets a granted script capability durably create and dispatch a linked product task", async () => {
    const fixture = await createFixture();
    const scriptPath = join(fixture.directory, "schedule-dispatch.mjs");
    writeFileSync(scriptPath, [
      "import { createInterface } from 'node:readline';",
      "const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of lines) {",
      "  const frame = JSON.parse(line);",
      "  if (frame.type === 'start') {",
      "    console.log(JSON.stringify({ protocol: 'joko-schedule-script/1', type: 'call', id: 'dispatch-1', method: 'sessions.dispatch', params: { message: 'inspect the workspace', title: 'Dispatched task' } }));",
      "  } else if (frame.type === 'call_result') {",
      "    if (!frame.ok) process.exit(4);",
      "    console.log(JSON.stringify({ protocol: 'joko-schedule-script/1', type: 'complete', resultText: 'task queued', primarySessionId: frame.result.target_session_id }));",
      "  }",
      "}"
    ].join("\n"), "utf8");
    fixture.store.upsertSchedule({
      id: "schedule-script-dispatch",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Script dispatcher",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "script",
          scriptConfig: {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
            capabilities: ["sessions.dispatch"]
          }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });

    const result = await new ScheduleCoordinator(fixture.store, fixture.host)
      .runNowWithResult("schedule-script-dispatch", "script-dispatch");
    expect(result).toMatchObject({ status: "success", sessionId: expect.any(String) });
    const taskId = result.sessionId!;
    expect(fixture.store.getSession(taskId).descriptor.title).toBe("Dispatched task");
    expect(() => fixture.store.getRun(result.runId)).toThrow();
    const nestedRun = fixture.store.listRuns({ sessionId: taskId })[0];
    expect(nestedRun).toBeDefined();
    await eventually(() => fixture.store.getRun(nestedRun!.descriptor.id).descriptor.state === "completed");
    expect(fixture.store.listScheduleRuns("schedule-script-dispatch")[0]).toMatchObject({
      runId: result.runId,
      sessionId: taskId,
      status: "success",
      detail: { script: { resultText: "task queued" }, costAttribution: "zero" }
    });
  });

  it("aborts an in-flight script Schedule without creating a product task", async () => {
    const fixture = await createFixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const executeScript = vi.fn(async (input: { readonly signal?: AbortSignal }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(new Error("script execution aborted"));
        input.signal?.addEventListener("abort", fail, { once: true });
        if (input.signal?.aborted) fail();
      });
      throw new Error("unreachable");
    });
    fixture.store.upsertSchedule({
      id: "schedule-script-abort",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Abort script",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "script",
          scriptConfig: { command: "node never.mjs", capabilities: [] }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const coordinator = new ScheduleCoordinator(fixture.store, fixture.host, {
      executeScript: executeScript as never
    });

    const running = coordinator.runNowWithResult("schedule-script-abort", "script-abort");
    await entered;
    await coordinator.abortSchedule("schedule-script-abort");
    await expect(running).resolves.toMatchObject({ status: "aborted" });
    expect(fixture.store.listSessions()).toHaveLength(0);
    expect(fixture.store.listScheduleRuns("schedule-script-abort")[0]).toMatchObject({
      status: "aborted",
      detail: { script: { status: "aborted" }, costAttribution: "zero" }
    });
  });

  it("marks an orphaned running script as interrupted on restart instead of replaying its side effects", async () => {
    const fixture = await createFixture();
    fixture.store.upsertSchedule({
      id: "schedule-script-recovery",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Recover script",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "script",
          scriptConfig: { command: "node unknown.mjs", capabilities: [] }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    fixture.store.recordScheduleOccurrence({
      scheduleId: "schedule-script-recovery",
      runId: "run-script-orphan",
      firedAt: 1_000,
      status: "running",
      detail: {
        script: { status: "running" },
        cadence: { preserveNextRun: true },
        costAttribution: "zero"
      }
    });
    const executeScript = vi.fn();
    const coordinator = new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => 2_000,
      executeScript: executeScript as never
    });

    coordinator.start();
    coordinator.stop();
    expect(executeScript).not.toHaveBeenCalled();
    expect(fixture.store.listScheduleRuns("schedule-script-recovery")).toEqual([
      expect.objectContaining({
        runId: "run-script-orphan",
        status: "interrupted",
        finishedAt: 2_000,
        detail: {
          script: {
            status: "interrupted",
            error: "Service restarted before script completion was confirmed."
          },
          cadence: { preserveNextRun: true },
          costAttribution: "zero"
        }
      })
    ]);
    coordinator.start();
    coordinator.stop();
    expect(fixture.store.listScheduleRuns("schedule-script-recovery")).toHaveLength(1);
  });

  it("creates a distinct product task for every fresh Schedule fire and records both task links", async () => {
    const fixture = await createFixture();
    fixture.store.upsertSchedule({
      id: "schedule-fresh",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Fresh task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "fresh prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "auto",
        planMode: true
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    await scheduler.runNow("schedule-fresh", "fresh-one");
    const first = fixture.store.listScheduleRuns("schedule-fresh")[0]!;
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await scheduler.runNow("schedule-fresh", "fresh-two");
    const history = fixture.store.listScheduleRuns("schedule-fresh");
    await eventually(() => fixture.store.getRun(history[0]!.runId).descriptor.state === "completed");

    expect(new Set(history.map((run) => run.sessionId)).size).toBe(2);
    expect(fixture.store.getSchedule("schedule-fresh").sessionMode).toBe("fresh");
    expect(fixture.store.getSchedule("schedule-fresh").sessionId).toBeUndefined();
    for (const run of history) {
      expect(fixture.store.getRun(run.runId).descriptor.sessionId).toBe(run.sessionId);
      expect(fixture.store.getSession(run.sessionId!).descriptor).toMatchObject({
        targetId: "target-one",
        permissionMode: "auto",
        planMode: true
      });
    }
  });

  it("attributes non-subscription exact and delegated usage as actual Schedule cost", async () => {
    const usageMoneyKind = vi.fn((_backendId: string, _providerId: string) => "actual-cost" as const);
    const fixture = await createFixture(new ScheduleUsageFakeAdapter(), {
      usageMoneyKind
    });
    fixture.store.upsertSchedule({
      id: "schedule-usage",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Usage task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "measure usage", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        providerId: "test",
        modelId: "text",
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    await scheduler.runNow("schedule-usage", "usage-one");
    const dispatched = fixture.store.listScheduleRuns("schedule-usage")[0]!;
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");

    expect(fixture.store.findScheduleRunByRunId(dispatched.runId)).toMatchObject({
      status: "success",
      detail: {
        costAttribution: "mixed",
        costMoney: {
          amount: 0.349,
          currency: "USD",
          approximate: false,
          kind: "actual-cost",
          estimateReasons: []
        }
      }
    });
    expect(usageMoneyKind).toHaveBeenCalledWith(fixture.adapter.id, "test");
  });

  it("keeps token-priced metered usage in actual cost when the runtime reports no cost", async () => {
    const fixture = await createFixture(new TokenPricedScheduleUsageFakeAdapter(), {
      usageMoneyKind: () => "actual-cost"
    });
    fixture.store.upsertSchedule({
      id: "schedule-token-priced-actual-cost",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Token-priced actual cost",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "measure token-priced usage", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        providerId: "test",
        modelId: "text",
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });

    await new ScheduleCoordinator(fixture.store, fixture.host)
      .runNow("schedule-token-priced-actual-cost", "token-priced-actual-cost");
    const dispatched = fixture.store.listScheduleRuns("schedule-token-priced-actual-cost")[0]!;
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");
    const detail = fixture.store.findScheduleRunByRunId(dispatched.runId)?.detail;

    expect(detail).toMatchObject({
      costAttribution: "exact",
      costMoney: {
        amount: expect.any(Number),
        currency: "USD",
        approximate: true,
        kind: "actual-cost",
        estimateReasons: ["reference-price"]
      }
    });
    expect(Number((detail as { readonly costMoney?: { readonly amount?: number } } | undefined)
      ?.costMoney?.amount ?? 0)).toBeGreaterThan(4.9);
    expect(detail).not.toHaveProperty("estimatedValueMoney");
  });

  it("attributes subscription Pi usage as value estimate without inventing actual spend", async () => {
    const fixture = await createFixture(new ScheduleUsageFakeAdapter(), {
      usageMoneyKind: () => "subscription-value"
    });
    fixture.store.upsertSchedule({
      id: "schedule-subscription-usage",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Subscription usage task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "measure subscription value", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        providerId: "test",
        modelId: "text",
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    await scheduler.runNow("schedule-subscription-usage", "subscription-usage-one");
    const dispatched = fixture.store.listScheduleRuns("schedule-subscription-usage")[0]!;
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");

    expect(fixture.store.findScheduleRunByRunId(dispatched.runId)).toMatchObject({
      status: "success",
      detail: {
        costAttribution: "mixed",
        estimatedValueMoney: {
          amount: 0.349,
          currency: "USD",
          approximate: true,
          kind: "value-estimate",
          estimateReasons: ["subscription-value", "reference-price"]
        }
      }
    });
    expect(fixture.store.findScheduleRunByRunId(dispatched.runId)?.detail).not.toHaveProperty("costMoney");
    expect(fixture.store.listUsageLedger({ ownerId: "orchestrator" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ estimated: true })])
    );
  });

  it("fails closed to reference value when the exact Backend has no billing provenance", async () => {
    const usageMoneyKind = vi.fn((_backendId: string, _providerId: string) => "reference-value" as const);
    const fixture = await createFixture(new ScheduleUsageFakeAdapter(), {
      usageMoneyKind
    });
    fixture.store.upsertSchedule({
      id: "schedule-unknown-provider-usage",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "fresh",
      name: "Unknown Provider usage task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "measure unverified value", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        // Runtime model metadata can still exist after its billing Provider
        // catalog entry was removed. The injected provenance is authoritative.
        providerId: "test",
        modelId: "text",
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    await scheduler.runNow("schedule-unknown-provider-usage", "unknown-provider-usage-one");
    const dispatched = fixture.store.listScheduleRuns("schedule-unknown-provider-usage")[0]!;
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");
    const detail = fixture.store.findScheduleRunByRunId(dispatched.runId)?.detail;

    expect(detail).toMatchObject({
      costAttribution: "mixed",
      estimatedValueMoney: {
        amount: 0.349,
        kind: "value-estimate",
        estimateReasons: ["reference-price"]
      }
    });
    expect(detail).not.toHaveProperty("costMoney");
    expect(usageMoneyKind).toHaveBeenCalledWith(fixture.adapter.id, "test");
    expect(fixture.store.listUsageLedger({ ownerId: "orchestrator" })).toEqual(
      expect.arrayContaining([expect.objectContaining({
        backendId: fixture.adapter.id,
        providerId: "test",
        estimated: true
      })])
    );
  });

  it("durably rebinds and reuses the first generated task for persistent Schedule fires", async () => {
    const fixture = await createFixture();
    fixture.store.upsertSchedule({
      id: "schedule-persistent",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "persistent",
      name: "Persistent task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "persistent prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);

    await scheduler.runNow("schedule-persistent", "persistent-one");
    const first = fixture.store.listScheduleRuns("schedule-persistent")[0]!;
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    const bound = fixture.store.getSchedule("schedule-persistent");
    expect(bound.sessionId).toBe(first.sessionId);

    await scheduler.runNow("schedule-persistent", "persistent-two");
    const history = fixture.store.listScheduleRuns("schedule-persistent");
    await eventually(() => fixture.store.getRun(history[0]!.runId).descriptor.state === "completed");

    expect(history.map((run) => run.sessionId)).toEqual([first.sessionId, first.sessionId]);
    expect(fixture.store.listOperations().filter((operation) => operation.kind === "create_scheduled_session")).toHaveLength(1);
  });

  it("advances intervals from their durable anchor instead of their creation time", async () => {
    const fixture = await createFixture();
    const sessionId = (await fixture.host.createSession({
      operationId: "create-anchored-scheduled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Anchored schedule",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const anchorAt = 1_234;
    const scheduledAt = 21_234;
    fixture.store.upsertSchedule({
      id: "schedule-anchored-interval",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "Anchored interval",
      kind: "interval",
      expression: "10000",
      anchorAt,
      timezone: "UTC",
      enabled: true,
      prompt: { text: "anchored prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: scheduledAt,
      now: 9_000
    });

    await new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => scheduledAt + 10,
      misfireGraceMs: 1_000
    }).tick();

    expect(fixture.store.getSchedule("schedule-anchored-interval")).toMatchObject({
      anchorAt,
      createdAt: 9_000,
      lastRunAt: scheduledAt,
      nextRunAt: 31_234
    });
  });

  it("persists an invalid execution snapshot as failed and advances the due occurrence exactly once", async () => {
    const fixture = await createFixture();
    const sessionId = (await fixture.host.createSession({
      operationId: "create-invalid-scheduled-snapshot",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Invalid scheduled snapshot",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const anchorAt = 10_000;
    const scheduledAt = 20_000;
    fixture.store.upsertSchedule({
      id: "schedule-invalid-snapshot",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "Invalid snapshot",
      kind: "interval",
      expression: "10000",
      anchorAt,
      timezone: "UTC",
      enabled: true,
      prompt: { text: "must fail before dispatch", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        providerId: "test",
        modelId: "text",
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: scheduledAt,
      now: 15_000
    });
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => scheduledAt + 10,
      misfireGraceMs: 1_000
    });

    await scheduler.tick();

    const history = fixture.store.listScheduleRuns("schedule-invalid-snapshot");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "failed",
      detail: {
        code: "TURN_OVERRIDE_MODEL_BASELINE_MISSING",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
    expect(fixture.store.getRun(history[0]!.runId).descriptor).toMatchObject({
      state: "failed",
      error: { code: "TURN_OVERRIDE_MODEL_BASELINE_MISSING" }
    });
    expect(fixture.store.listQueueItems({ sessionId, states: ["failed"] })).toHaveLength(1);
    expect(fixture.store.getSchedule("schedule-invalid-snapshot")).toMatchObject({
      lastRunAt: scheduledAt,
      nextRunAt: 30_000
    });

    await scheduler.tick();
    expect(fixture.store.listScheduleRuns("schedule-invalid-snapshot")).toHaveLength(1);
  });

  it("applies and restores a durable scheduled Fast Mode snapshot", async () => {
    const adapter = new PolicyFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-fast-scheduled",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Fast scheduled",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const scheduledAt = Date.now();
    const schedule = fixture.store.upsertSchedule({
      id: "schedule-fast",
      backendId: adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "Fast snapshot",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "scheduled fast", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        providerId: "vision",
        modelId: "multimodal",
        effort: "high",
        fastMode: true,
        permissionMode: "auto",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    const dispatched = fixture.host.enqueueScheduledInput({
      operationId: "dispatch-fast-schedule",
      schedule,
      sessionId,
      scheduledAt
    });
    await eventually(() => fixture.store.getRun(dispatched.value.runId).descriptor.state === "completed");
    expect(adapter.sentPolicies).toContainEqual(expect.objectContaining({
      text: "scheduled fast",
      providerId: "vision",
      modelId: "multimodal",
      fastMode: true
    }));
    expect(adapter.currentPolicy).toMatchObject({ providerId: "test", modelId: "text", fastMode: false });
  });

  it("queues or skips a due occurrence according to its durable overlap policy", async () => {
    const fixture = await createFixture();
    const queueSessionId = (await fixture.host.createSession({
      operationId: "create-overlap-queue",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Queue overlap",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const skipSessionId = (await fixture.host.createSession({
      operationId: "create-overlap-skip",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Skip overlap",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const scheduledAt = Date.now() - 10;
    for (const [sessionId, runId] of [[queueSessionId, "busy-queue"], [skipSessionId, "busy-skip"]] as const) {
      fixture.store.createRun({
        id: runId,
        sessionId,
        source: "user",
        state: "running",
        createdAt: scheduledAt - 1_000,
        startedAt: scheduledAt - 1_000
      });
    }
    const baseSchedule = {
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound" as const,
      name: "Overlap",
      kind: "one_shot" as const,
      timezone: "UTC",
      enabled: true,
      prompt: { text: "scheduled prompt", images: [], files: [], mentions: [], disposition: "prompt" as const },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      misfirePolicy: "run_once" as const,
      nextRunAt: scheduledAt
    };
    fixture.store.upsertSchedule({
      ...baseSchedule,
      id: "schedule-overlap-queue",
      sessionId: queueSessionId,
      overlapPolicy: "queue"
    });
    fixture.store.upsertSchedule({
      ...baseSchedule,
      id: "schedule-overlap-skip",
      sessionId: skipSessionId,
      overlapPolicy: "skip"
    });

    await new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => scheduledAt + 10,
      misfireGraceMs: 1_000
    }).tick();

    expect(fixture.store.listScheduleRuns("schedule-overlap-queue")[0]).toMatchObject({ status: "queued" });
    expect(fixture.store.listQueueItems({ sessionId: queueSessionId, states: ["accepted"] })).toHaveLength(1);
    expect(fixture.store.listScheduleRuns("schedule-overlap-skip")[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "task is busy; overlap policy is skip" }
    });
    expect(fixture.store.listQueueItems({ sessionId: skipSessionId })).toHaveLength(0);
  });

  it("records an expired occurrence as skipped when its durable misfire policy says skip", async () => {
    const fixture = await createFixture();
    const sessionId = (await fixture.host.createSession({
      operationId: "create-misfire-skip",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Skip misfire",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const scheduledAt = Date.now() - 10_000;
    fixture.store.upsertSchedule({
      id: "schedule-misfire-skip",
      backendId: fixture.adapter.id,
      targetId: "target-one",
      sessionMode: "bound",
      sessionId,
      name: "Skip stale occurrence",
      kind: "one_shot",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "stale", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        ...CURRENT_AGENT_SCHEDULE_EXECUTION_SNAPSHOT,
        permissionMode: "ask",
        planMode: false
      },
      overlapPolicy: "queue",
      misfirePolicy: "skip",
      nextRunAt: scheduledAt
    });

    await new ScheduleCoordinator(fixture.store, fixture.host, {
      now: () => scheduledAt + 10_000,
      misfireGraceMs: 1_000
    }).tick();

    expect(fixture.store.listScheduleRuns("schedule-misfire-skip")[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "misfire grace elapsed; misfire policy is skip" }
    });
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(0);
    expect(fixture.store.getSchedule("schedule-misfire-skip").enabled).toBe(false);
  });

  it("keeps effectful mutations started until the awaited effect succeeds and then replays the result", async () => {
    const fixture = await createFixture();
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effects = 0;
    const pending = fixture.host.mutate({
      operationId: "effect-success",
      connection: fixture.connection,
      kind: "archive_target",
      body: { targetId: "target-one", archived: true },
      commit: (store) => {
        store.setSetting("service", "global", "effect-success", { committed: true });
        return { archived: true };
      },
      effect: async () => {
        effects += 1;
        await effectGate;
      }
    });

    expect(fixture.store.getOperation("effect-success")).toMatchObject({
      status: "started",
      completionMode: "external_effect"
    });
    expect("response" in fixture.store.getOperation("effect-success")).toBe(false);
    expect(fixture.store.findSetting("service", "global", "effect-success")).toBeUndefined();
    releaseEffect();
    const completed = await pending;
    expect(completed).toMatchObject({ replayed: false, value: { archived: true } });
    expect(completed.operation.status).toBe("completed");
    expect(fixture.store.getSetting("service", "global", "effect-success").value).toEqual({ committed: true });

    const replay = await fixture.host.mutate({
      operationId: "effect-success",
      connection: fixture.connection,
      kind: "archive_target",
      body: { archived: true, targetId: "target-one" },
      commit: () => ({ archived: false }),
      effect: async () => {
        effects += 1;
      }
    });
    expect(replay).toMatchObject({ replayed: true, value: { archived: true } });
    expect(effects).toBe(1);
  });

  it("records a typed tombstone when an awaited mutation effect rejects", async () => {
    const fixture = await createFixture();
    let commits = 0;
    const mutation = {
      operationId: "effect-failure",
      connection: fixture.connection,
      kind: "delete_native_session",
      body: { sessionId: "native-one" },
      commit: (store: OperationalStore) => {
        commits += 1;
        store.setSetting("service", "global", "failed-effect-commit", { deleted: true });
        return { deleted: true };
      },
      effect: async () => {
        throw new Error("native delete failed sk-abcdefghijklmnop");
      }
    } as const;

    await expect(fixture.host.mutate(mutation)).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(fixture.store.getOperation("effect-failure")).toMatchObject({
      status: "failed",
      error: {
        code: "EFFECT_FAILED",
        message: "native delete failed [REDACTED]",
        stateMayHaveChanged: true,
        retryable: false
      }
    });
    expect(commits).toBe(0);
    expect(fixture.store.findSetting("service", "global", "failed-effect-commit")).toBeUndefined();
    await expect(fixture.host.mutate(mutation)).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
  });

  it("preserves a nested operation's public failure instead of replacing it with its idempotency wrapper", async () => {
    const fixture = await createFixture();
    const piFailure = {
      code: "PI_PROCESS_IDENTITY_UNAVAILABLE",
      message: "Pi exited before its managed spawn identity could be recorded",
      phase: "spawn",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Retry after inspecting Pi startup diagnostics."
    } as const;

    await expect(fixture.host.mutate({
      operationId: "outer-create-session",
      connection: fixture.connection,
      kind: "createSession",
      body: { targetId: "target-one" },
      commit: () => ({ sessionId: "never-created" }),
      effect: async () => {
        await fixture.host.mutate({
          operationId: "inner-create-session",
          connection: fixture.connection,
          kind: "create_session",
          body: { targetId: "target-one" },
          commit: () => ({ sessionId: "never-created" }),
          effect: async () => { throw new JokoError(piFailure); }
        });
      }
    })).rejects.toBeInstanceOf(OperationPreviouslyFailedError);

    expect(fixture.store.getOperation("inner-create-session")).toMatchObject({
      status: "failed",
      error: piFailure
    });
    expect(fixture.store.getOperation("outer-create-session")).toMatchObject({
      status: "failed",
      error: piFailure
    });
  });

  it("rechecks a mutation fence after the awaited effect and rolls back the final commit on conflict", async () => {
    const fixture = await createFixture();
    const initial = fixture.store.setSetting("service", "global", "mutation-fence", { owner: "initial" });
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let commits = 0;
    const pending = fixture.host.mutate({
      operationId: "effect-fence-conflict",
      connection: fixture.connection,
      kind: "fenced_effect",
      body: { expectedRevision: initial.revision.toString() },
      precondition: (store) => {
        const current = store.getSetting("service", "global", "mutation-fence");
        if (current.revision !== initial.revision) {
          throw new RevisionConflictError("Setting", "mutation-fence", initial.revision, current.revision);
        }
      },
      commit: (store) => {
        commits += 1;
        store.setSetting("service", "global", "mutation-fence", { owner: "effect" });
        return { applied: true };
      },
      effect: async () => effectGate
    });

    expect(fixture.store.getOperation("effect-fence-conflict").status).toBe("started");
    const concurrent = fixture.store.setSetting("service", "global", "mutation-fence", { owner: "concurrent" });
    releaseEffect();
    await expect(pending).rejects.toBeInstanceOf(OperationPreviouslyFailedError);

    expect(commits).toBe(0);
    expect(fixture.store.getSetting("service", "global", "mutation-fence")).toMatchObject({
      value: { owner: "concurrent" },
      revision: concurrent.revision
    });
    expect(fixture.store.getOperation("effect-fence-conflict")).toMatchObject({
      status: "failed",
      error: { code: "EFFECT_FAILED", stateMayHaveChanged: true, retryable: false }
    });
  });

  it("claims native creation before calling the adapter and never repeats a failed native effect", async () => {
    const adapter = new GatedFakeAdapter();
    const fixture = await createFixture(adapter);
    const gate = adapter.holdCreate();
    const input = {
      operationId: "create-claimed-first",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Claimed first",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    } as const;
    const pending = fixture.host.createSession(input);
    await gate.entered;

    expect(fixture.store.getOperation(input.operationId)).toMatchObject({
      status: "started",
      completionMode: "external_effect"
    });
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(0);
    await expect(fixture.host.createSession({ ...input, title: "Conflicting title" }))
      .rejects.toBeInstanceOf(OperationConflictError);
    gate.release();
    const created = await pending;
    expect(fixture.store.getSession(created.value.sessionId).descriptor.title).toBe("Claimed first");

    const replay = await fixture.host.createSession(input);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(created.value);
    expect(adapter.createCalls).toBe(1);

    adapter.failCreates = true;
    const failedInput = { ...input, operationId: "create-native-failed", title: "Must not commit" };
    await expect(fixture.host.createSession(failedInput)).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(adapter.createCalls).toBe(2);
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })
      .some((session) => session.descriptor.title === "Must not commit")).toBe(false);
    await expect(fixture.host.createSession(failedInput)).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(adapter.createCalls).toBe(2);
  });

  it("claims native derivation before fork and replays the completed product task without a second fork", async () => {
    const adapter = new GatedFakeAdapter();
    adapter.forkEditorText = `  restore this draft sk-abcdefghijklmnop ${"x".repeat(65_537)}\n`;
    const frozen: Array<{ readonly sessionId: string; readonly targetId: string }> = [];
    const fixture = await createFixture(adapter, {
      freezeToolPolicies: (sessionId, targetId) => { frozen.push({ sessionId, targetId }); }
    });
    const sourceId = (await fixture.host.createSession({
      operationId: "derive-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sourceId, "derive-source-message", 10, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "Source boundary" }]
    });
    const gate = adapter.holdFork();
    const input = {
      operationId: "derive-claimed-first",
      connection: fixture.connection,
      sourceSessionId: sourceId,
      title: "Derived",
      kind: "fork",
      entryId: "root",
      sourceMessage: { messageId: "derive-source-message", eventId: "derive-source-message" }
    } as const;
    const pending = fixture.host.deriveSession(input);
    await gate.entered;

    expect(fixture.store.getOperation(input.operationId)).toMatchObject({
      status: "started",
      completionMode: "external_effect"
    });
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
    await expect(fixture.host.restart(sourceId)).rejects.toThrow(
      "only after every affected task has no active or queued work"
    );
    const currentBackend = fixture.store.getBackend(adapter.id).descriptor;
    const replacementEffect = vi.fn(async () => undefined);
    await expect(fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: currentBackend.instanceGeneration,
      perform: replacementEffect
    })).rejects.toThrow(/native side effect/iu);
    expect(replacementEffect).not.toHaveBeenCalled();
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(1);
    gate.release();
    const derived = await pending;
    expect(frozen).toEqual([
      { sessionId: sourceId, targetId: "target-one" },
      { sessionId: derived.value.sessionId, targetId: "target-one" }
    ]);
    expect(fixture.store.getSession(derived.value.sessionId).descriptor.title).toBe("Derived");
    expect(fixture.store.getSession(derived.value.sessionId).descriptor.derivationOrigin).toEqual({
      kind: "fork",
      sourceSessionId: sourceId,
      sourceMessageId: "derive-source-message",
      sourceEventId: "derive-source-message"
    });
    expect(fixture.store.getOperation(input.operationId).body).toMatchObject({
      sourceMessageId: "derive-source-message",
      sourceEventId: "derive-source-message"
    });
    expect(fixture.store.listEvents({ sessionId: derived.value.sessionId })
      .some((event) => event.payload.type === "session_changed")).toBe(true);
    expect(adapter.forkCalls).toBe(1);
    const editorEffects = fixture.store.listEvents({ sessionId: derived.value.sessionId })
      .filter((event) => event.payload.type === "extension_ui_effect" && event.payload.effect === "editor_text");
    expect(editorEffects).toHaveLength(1);
    expect(editorEffects[0]).toMatchObject({
      operationId: input.operationId,
      generation: fixture.store.getSession(derived.value.sessionId).descriptor.binding.generation,
      payload: { type: "extension_ui_effect", effect: "editor_text", text: `  restore this draft [REDACTED] ${"x".repeat(65_537)}\n` },
      metadata: { namespace: "joko.native_fork", fields: { effect: "editor_text" } }
    });
    expect(editorEffects[0]?.pi).toBeUndefined();

    const replay = await fixture.host.deriveSession(input);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(derived.value);
    expect(adapter.forkCalls).toBe(1);
    expect(fixture.store.listEvents({ sessionId: derived.value.sessionId })
      .filter((event) => event.payload.type === "extension_ui_effect" && event.payload.effect === "editor_text"))
      .toHaveLength(1);
  });

  it("snapshots a private append prompt for fresh creation, restart, and derivation", async () => {
    const adapter = new PersonalizationPromptFakeAdapter();
    const fixture = await createFixture(adapter);
    const prompt = "Keep answers concise and explain risky changes before editing.";
    const created = await fixture.host.createSession({
      operationId: "create-personalized",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Personalized",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      appendSystemPrompt: prompt
    });
    const sessionId = created.value.sessionId;

    expect(adapter.createInputs).toHaveLength(1);
    expect(adapter.createInputs[0]?.appendSystemPrompt).toBe(prompt);
    expect(adapter.createContexts[0]?.appendSystemPrompt).toBe(prompt);
    expect(fixture.store.getSession(sessionId).descriptor.appendSystemPrompt).toBe(prompt);
    expect(fixture.store.getOperation("create-personalized").body).toMatchObject({
      appendSystemPromptSha256: createHash("sha256").update(prompt).digest("hex")
    });
    expect(JSON.stringify(fixture.store.getOperation("create-personalized").body)).not.toContain(prompt);

    await fixture.host.close(sessionId);
    await fixture.host.resume(sessionId);
    expect(adapter.resumeContexts.at(-1)?.appendSystemPrompt).toBe(prompt);

    const derived = await fixture.host.deriveSession({
      operationId: "clone-personalized",
      connection: fixture.connection,
      sourceSessionId: sessionId,
      title: "Personalized clone",
      kind: "clone"
    });
    expect(fixture.store.getSession(derived.value.sessionId).descriptor.appendSystemPrompt).toBe(prompt);

    await expect(fixture.host.createSession({
      operationId: "create-personalized-too-long",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Too long",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      appendSystemPrompt: "x".repeat(8_001)
    })).rejects.toMatchObject({ publicError: { code: "APPEND_SYSTEM_PROMPT_TOO_LONG" } });
    await expect(fixture.host.createSession({
      operationId: "create-personalized-nul",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Invalid NUL",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      appendSystemPrompt: "valid prefix\0invalid suffix"
    })).rejects.toMatchObject({ publicError: { code: "APPEND_SYSTEM_PROMPT_INVALID" } });
    expect(adapter.createInputs).toHaveLength(1);
  });

  it("does not create a product Session when the native fork is cancelled", async () => {
    const adapter = new GatedFakeAdapter();
    adapter.forkFailure = new JokoError({
      code: "PI_SESSION_CHANGE_CANCELLED",
      message: "Pi fork was cancelled.",
      phase: "session",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Keep using the source Session."
    });
    const fixture = await createFixture(adapter);
    const sourceId = (await fixture.host.createSession({
      operationId: "cancelled-fork-source",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Source",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    appendSessionEvent(fixture.store, sourceId, "cancelled-fork-message", 10, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "Source boundary" }]
    });

    await expect(fixture.host.deriveSession({
      operationId: "cancelled-fork",
      connection: fixture.connection,
      sourceSessionId: sourceId,
      title: "Must not exist",
      kind: "fork",
      entryId: "root",
      sourceMessage: { messageId: "cancelled-fork-message", eventId: "cancelled-fork-message" }
    })).rejects.toBeInstanceOf(OperationPreviouslyFailedError);

    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true }))
      .toHaveLength(1);
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })[0]?.descriptor.id)
      .toBe(sourceId);
  });

  it("serializes duplicate native attaches and commits only one live product binding", async () => {
    const adapter = new ManagedAttachFakeAdapter();
    const fixture = await createFixture(adapter);
    const gate = adapter.holdCreate();
    const nativeReference = join(fixture.directory, "managed.jsonl");
    const base = {
      connection: fixture.connection,
      targetId: "target-one",
      title: "Attached",
      fastMode: false,
      permissionMode: "ask" as const,
      planMode: false,
      nativeStart: { kind: "attach" as const, nativeReference }
    };
    const first = fixture.host.createSession({ ...base, operationId: "attach-first" });
    await gate.entered;
    const second = fixture.host.createSession({ ...base, operationId: "attach-second" });
    gate.release();
    const attached = await first;
    await expect(second).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(adapter.createCalls).toBe(1);
    expect(fixture.store.getSession(attached.value.sessionId).descriptor.binding.opaqueRef).toBe(nativeReference);
    expect(fixture.store.listSessions()).toHaveLength(1);
  });

  it("persists the attached runtime observation instead of replaying draft model and permission defaults", async () => {
    const adapter = new ObservedAttachFakeAdapter();
    const setPlanMode = vi.spyOn(adapter, "setPlanMode");
    const fixture = await createFixture(adapter);
    const result = await fixture.host.createSession({
      operationId: "attach-observed-runtime",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Observed attachment",
      providerId: "stale-provider",
      modelId: "stale-model",
      effort: "stale-effort",
      fastMode: true,
      permissionMode: "bypassPermissions",
      planMode: true,
      nativeStart: { kind: "attach", nativeReference: "managed://observed-runtime" }
    });

    expect(adapter.attachedCreateInput).toEqual(expect.objectContaining({
      nativeStart: { kind: "attach", nativeReference: "managed://observed-runtime" },
      fastMode: false,
      permissionMode: "ask"
    }));
    expect(adapter.attachedCreateInput).not.toHaveProperty("providerId");
    expect(adapter.attachedCreateInput).not.toHaveProperty("modelId");
    expect(adapter.attachedCreateInput).not.toHaveProperty("effort");
    expect(fixture.store.getSession(result.value.sessionId).descriptor).toMatchObject({
      binding: {
        opaqueRef: "managed://observed-runtime",
        nativeSessionId: "managed-native",
        generation: 1
      },
      providerId: "vision",
      modelId: "multimodal",
      fastMode: false,
      permissionMode: "auto",
      planMode: false
    });
    expect(fixture.store.getSession(result.value.sessionId).descriptor.effort).toBeUndefined();
    expect(setPlanMode).not.toHaveBeenCalled();
  });

  it("imports a catalog task as a dormant binding while preserving placement, archive state, and native ordering", async () => {
    const adapter = new CatalogImportFakeAdapter();
    const secondaryAdapter = new CatalogImportFakeAdapter({
      ...PI_LIKE_PROFILE,
      id: "catalog-import-secondary",
      displayName: "Catalog import secondary"
    });
    const closeSession = vi.spyOn(adapter, "closeSession");
    let monotonicNow = 1_000;
    const fixture = await createFixture(adapter, {
      monotonicNow: () => monotonicNow,
      additionalAdapters: [secondaryAdapter]
    });
    const catalogWorkspace = resolve("C:/catalog-workspace");
    await fixture.host.registerTarget({
      id: "target-catalog",
      backendId: adapter.id,
      displayName: "Catalog target",
      workspaceRoot: catalogWorkspace,
      managed: false,
      trusted: true
    });
    await fixture.host.registerTarget({
      id: "target-catalog-secondary",
      backendId: secondaryAdapter.id,
      displayName: "Secondary catalog target",
      workspaceRoot: resolve("C:/catalog-workspace-secondary"),
      managed: false,
      trusted: true
    });
    adapter.catalogEntry = {
      nativeReference: "managed://dialogue-history",
      nativeSessionId: "managed-native",
      title: "Recovered dialogue",
      workingDirectory: catalogWorkspace,
      createdAt: 23,
      modifiedAt: 123,
      archived: true,
      placement: "dialogue",
      existingMatch: "binding_and_placement"
    };
    adapter.additionalCatalogEntries = [{
      ...adapter.catalogEntry,
      nativeReference: "managed://second-dialogue-history",
      nativeSessionId: "managed-native-second",
      title: "Recovered second dialogue",
      createdAt: 24,
      modifiedAt: 124
    }];
    const snapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
    const alternateSnapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id);
    expect(alternateSnapshot.token).not.toBe(snapshot.token);
    const result = await fixture.host.createSession({
      operationId: "attach-dialogue-placement",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Client supplied title",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: snapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://dialogue-history" }
    });

    const imported = fixture.store.getSession(result.value.sessionId).descriptor;
    expect(imported.projectId).toBeUndefined();
    expect(imported).toMatchObject({
      title: "Recovered dialogue",
      archived: true,
      createdAt: 23,
      updatedAt: 123
    });
    expect(adapter.createCalls).toBe(0);
    expect(adapter.catalogBindingCalls).toBe(1);
    expect(closeSession).not.toHaveBeenCalled();

    const second = await fixture.host.createSession({
      operationId: "attach-second-dialogue-placement",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Second client supplied title",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 24, modifiedAt: 124, snapshotToken: snapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://second-dialogue-history" }
    });
    expect(fixture.store.getSession(second.value.sessionId).descriptor.title).toBe("Recovered second dialogue");
    expect(adapter.catalogBindingCalls).toBe(2);

    await expect(fixture.host.createSession({
      operationId: "attach-dialogue-placement-replay",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Repeated catalog import",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: alternateSnapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://dialogue-history" }
    })).rejects.toMatchObject({
      storedError: { message: expect.stringMatching(/already used/u) }
    });
    expect(adapter.catalogBindingCalls).toBe(2);

    await expect(fixture.host.createSession({
      operationId: "attach-cross-backend-catalog-token",
      connection: fixture.connection,
      targetId: "target-catalog-secondary",
      title: "Cross Backend catalog token",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: alternateSnapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://dialogue-history" }
    })).rejects.toMatchObject({
      storedError: { message: expect.stringMatching(/snapshot is no longer available/u) }
    });
    expect(secondaryAdapter.catalogBindingCalls).toBe(0);

    adapter.catalogEntry = {
      ...adapter.catalogEntry,
      nativeReference: "managed://hidden-history",
      nativeSessionId: "managed-native-hidden",
      workingDirectory: fixture.directory
    };
    adapter.additionalCatalogEntries = [];
    const hiddenSnapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
    expect(hiddenSnapshot).toMatchObject({ existingCount: 1, result: { entries: [] } });
    await expect(fixture.host.createSession({
      operationId: "attach-hidden-dialogue-placement",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Hidden catalog import",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: hiddenSnapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://hidden-history" }
    })).rejects.toMatchObject({
      storedError: { message: expect.stringMatching(/no longer present/u) }
    });
    expect(adapter.catalogBindingCalls).toBe(2);

    adapter.catalogEntry = {
      ...adapter.catalogEntry,
      nativeReference: "managed://expired-history",
      nativeSessionId: "managed-native-expired",
      workingDirectory: catalogWorkspace
    };
    const expiredSnapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
    monotonicNow += 10 * 60_000;
    await expect(fixture.host.createSession({
      operationId: "attach-expired-catalog-token",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Expired catalog token",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: expiredSnapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://expired-history" }
    })).rejects.toMatchObject({
      storedError: { message: expect.stringMatching(/snapshot is no longer available/u) }
    });
    expect(adapter.catalogBindingCalls).toBe(2);

    adapter.catalogEntry = {
      ...adapter.catalogEntry,
      nativeReference: "managed://old-generation-history",
      nativeSessionId: "managed-native-old-generation"
    };
    const oldGenerationSnapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
    const currentBackend = fixture.store.getBackend(adapter.id).descriptor;
    const reservation = fixture.store.reserveBackendInstanceGeneration({
      backendId: adapter.id,
      adapterKind: currentBackend.adapterKind
    });
    const replacement = new CatalogImportFakeAdapter();
    await fixture.host.replaceBackendInstance({
      backendId: adapter.id,
      expectedCurrentGeneration: currentBackend.instanceGeneration,
      perform: async (hooks) => {
        await hooks.preparePrevious(replacement, reservation.generation);
        const published = fixture.store.publishBackendInstanceDescriptor({
          descriptor: { ...currentBackend, instanceGeneration: reservation.generation },
          expectedCurrentGeneration: currentBackend.instanceGeneration
        });
        if (published.status !== "published") throw new Error("Fixture Backend publication lost its fence.");
        hooks.activateCurrent();
      }
    });
    await expect(fixture.host.createSession({
      operationId: "attach-old-generation-catalog-token",
      connection: fixture.connection,
      targetId: "target-catalog",
      title: "Old generation catalog token",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      initialPlacement: "dialogue",
      catalogImport: { archived: true, createdAt: 23, modifiedAt: 123, snapshotToken: oldGenerationSnapshot.token },
      nativeStart: { kind: "attach", nativeReference: "managed://old-generation-history" }
    })).rejects.toMatchObject({
      storedError: { message: expect.stringMatching(/snapshot is no longer available/u) }
    });
    expect(replacement.catalogBindingCalls).toBe(0);
  });

  it("authoritatively validates catalog reclassification without overwriting newer local presentation", async () => {
    const adapter = new CatalogImportFakeAdapter();
    const fixture = await createFixture(adapter);
    const catalogWorkspace = resolve("C:/catalog-reclassification");
    await fixture.host.registerTarget({
      id: "target-catalog",
      backendId: adapter.id,
      displayName: "Catalog target",
      workspaceRoot: catalogWorkspace,
      managed: false,
      trusted: true
    });
    fixture.store.createSession({
      id: "session-catalog-reclassification",
      backendId: adapter.id,
      targetId: "target-catalog",
      projectId: "target-catalog",
      title: "Local title",
      binding: { opaqueRef: "managed://reclassification", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 50,
      updatedAt: 200
    });
    const presentation = async (modifiedAt: number, overrides: Partial<NativeSessionCatalogEntry> = {}) => {
      const catalogEntry: NativeSessionCatalogEntry = {
        nativeReference: "managed://reclassification",
        nativeSessionId: "native-reclassification",
        title: "Native title",
        workingDirectory: catalogWorkspace,
        createdAt: 50,
        modifiedAt,
        archived: true,
        placement: "dialogue",
        existingMatch: "binding_and_placement",
        ...overrides
      };
      adapter.catalogEntry = catalogEntry;
      const snapshot = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
      return fixture.host.validateCatalogSessionReclassification({
        sessionId: "session-catalog-reclassification",
        archived: catalogEntry.archived,
        modifiedAt: catalogEntry.modifiedAt,
        snapshotToken: snapshot.token
      });
    };

    await expect(presentation(100)).resolves.toEqual({
      title: "Local title",
      archived: false,
      modifiedAt: 200
    });
    await expect(presentation(200)).resolves.toEqual({
      title: "Native title",
      archived: true,
      modifiedAt: 200
    });
    await expect(presentation(201, { existingMatch: "binding" })).rejects.toThrow(/eligible/u);

    const mismatchSession = fixture.store.createSession({
      id: "session-catalog-project-mismatch",
      backendId: adapter.id,
      targetId: "target-catalog",
      title: "Dialogue task",
      binding: { opaqueRef: "managed://project-mismatch", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 50,
      updatedAt: 200
    });
    fixture.store.moveSessionProject({
      sessionId: mismatchSession.descriptor.id,
      expectedRevision: mismatchSession.revision,
      movedAt: 200
    });
    adapter.catalogEntry = {
      nativeReference: "managed://project-mismatch",
      nativeSessionId: "native-project-mismatch",
      title: "Native title",
      workingDirectory: catalogWorkspace,
      projectDirectory: join(catalogWorkspace, "different-project"),
      createdAt: 50,
      modifiedAt: 202,
      archived: true,
      placement: "project",
      existingMatch: "binding_and_placement"
    };
    const mismatched = await fixture.host.scanNativeSessionCatalogSnapshot(adapter.id, true);
    await expect(fixture.host.validateCatalogSessionReclassification({
      sessionId: "session-catalog-project-mismatch",
      projectId: "target-catalog",
      archived: true,
      modifiedAt: 202,
      snapshotToken: mismatched.token
    })).rejects.toThrow(/selected project Target/u);
  });

  it("fails an attach before product commit when inspection reports a different native binding", async () => {
    const adapter = new ObservedAttachFakeAdapter();
    adapter.reportDifferentBinding = true;
    const closeSession = vi.spyOn(adapter, "closeSession");
    const fixture = await createFixture(adapter);

    await expect(fixture.host.createSession({
      operationId: "attach-mismatched-observation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Mismatched attachment",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: { kind: "attach", nativeReference: "managed://expected-runtime" }
    })).rejects.toMatchObject({
      storedError: { code: "NATIVE_SESSION_CONTINUITY_GAP", stateMayHaveChanged: true }
    });

    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(0);
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("hydrates native history only for attach and never probes a blank fresh task", async () => {
    const adapter = new ManagedAttachFakeAdapter();
    adapter.historyFailure = new Error("blank native task has no queryable history yet");
    const fixture = await createFixture(adapter);

    await expect(fixture.host.createSession({
      operationId: "create-blank-native-history",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Blank native task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).resolves.toMatchObject({ value: { sessionId: expect.any(String) } });
    expect(adapter.historyContexts).toEqual([]);

    adapter.historyFailure = undefined;
    adapter.history = {
      events: [fakeHistoryEvent("attached-root", "message_user", {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Existing native history" }]
      })],
      activeEntryId: "attached-root"
    };
    const attached = await fixture.host.createSession({
      operationId: "attach-queryable-native-history",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Attached native task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: { kind: "attach", nativeReference: "managed://queryable-history" }
    });

    expect(adapter.historyContexts).toEqual([
      expect.objectContaining({ sessionId: attached.value.sessionId, generation: 1 })
    ]);
    expect(fixture.store.listEvents({ sessionId: attached.value.sessionId }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            fields: expect.objectContaining({ nativeEntryId: "attached-root" })
          })
        })
      ]));
  });

  it("hydrates attached native history before success and keeps repeated branch syncs idempotent", async () => {
    const adapter = new ManagedAttachFakeAdapter();
    adapter.history = {
      events: [
        fakeHistoryEvent("root-user", "message_user", {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "Root" }]
        }, 1_000),
        fakeHistoryEvent("branch-a", "message_assistant", {
          type: "message_complete",
          role: "assistant",
          blocks: [{ kind: "text", text: "Branch A" }]
        }, 2_000),
        fakeHistoryEvent("branch-b", "unknown", {
          type: "status",
          key: "fake.history.unknown.future_native_entry",
          text: "Unknown fake entry preserved"
        }, 3_000),
        fakeHistoryEvent("custom-message", "custom_message", {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "Hydrated custom context" }]
        }, 4_000)
      ],
      activeEntryId: "custom-message"
    };
    const fixture = await createFixture(adapter);
    const result = await fixture.host.createSession({
      operationId: "attach-with-history",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Attached history",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      nativeStart: { kind: "attach", nativeReference: "managed://existing-history" }
    });
    const sessionId = result.value.sessionId;
    const initial = fixture.store.listEvents({ sessionId, limit: 100 });
    expect(initial
      .filter((event) => event.metadata?.namespace === "fake.native_history")
      .map((event) => event.metadata?.fields["nativeEntryId"])).toEqual([
      "root-user",
      "branch-a",
      "branch-b",
      "custom-message"
    ]);
    expect(initial.find((event) => event.metadata?.fields["nativeEntryId"] === "branch-b")?.payload).toMatchObject({
      type: "status",
      key: "fake.history.unknown.future_native_entry"
    });
    expect(initial.find((event) => event.metadata?.fields["nativeEntryId"] === "custom-message")?.payload).toMatchObject({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "Hydrated custom context" }]
    });
    expect(initial.find((event) => event.payload.type === "native_session_changed")?.payload)
      .toMatchObject({ type: "native_session_changed", leafId: "custom-message" });

    await fixture.host.navigateTree(sessionId, "custom-message", false);
    expect(fixture.store.listEvents({ sessionId, limit: 100 })).toHaveLength(initial.length);

    adapter.history = { ...adapter.history, activeEntryId: "branch-b" };
    await fixture.host.navigateTree(sessionId, "branch-b", false);
    const switched = fixture.store.listEvents({ sessionId, limit: 100 });
    expect(switched).toHaveLength(initial.length + 1);
    expect(switched.at(-1)?.payload).toMatchObject({ type: "native_session_changed", leafId: "branch-b" });
    expect(switched.some((event) => event.metadata?.fields["nativeEntryId"] === "branch-a")).toBe(true);

    adapter.historyFailure = new Error("invalid native history response");
    await expect(fixture.host.navigateTree(sessionId, "root-user", false))
      .rejects.toThrow("invalid native history response");
    const afterRejectedSync = fixture.store.listEvents({ sessionId, limit: 100 });
    expect(afterRejectedSync).toHaveLength(switched.length);
    expect(afterRejectedSync.at(-1)?.payload).toMatchObject({ type: "native_session_changed", leafId: "branch-b" });
    expect(materializedSessionRuntimeState(
      fixture.store.getSetting("session", sessionId, SESSION_RUNTIME_STATE_SETTING_KEY).value
    )?.activeNativeEntryId).toBe("branch-b");
  });

  it("preserves accepted user metadata found in the 100001st Event during native history sync", { timeout: 20_000 }, async () => {
    const adapter = new ManagedAttachFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-native-history-boundary",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Native history boundary",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const session = fixture.store.getSession(sessionId).descriptor;
    const nativeEntryId = "native-history-tail";
    const accepted = fixture.store.appendEvent({
      id: "accepted-native-history-tail",
      backendId: session.backendId,
      targetId: session.targetId,
      sessionId,
      generation: session.binding.generation,
      traceId: "accepted-native-history-tail",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "tail input" }],
        quotesEncoded: true,
        pastedTextRanges: [{ start: 0, end: 4, display: "Pasted text (1 line)" }],
        nativeHistory: { identity: { entryId: nativeEntryId } }
      },
      pi: quoteGateMetadata(nativeEntryId).pi,
      metadata: {
        namespace: "joko.native_history",
        fields: {
          [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: nativeBindingFingerprint(session.binding.opaqueRef)
        }
      }
    });
    adapter.history = {
      events: [{
        nativeEntryId,
        projectionKind: "message_user",
        contentIndex: 0,
        payload: {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "tail input" }]
        },
        metadata: quoteGateMetadata(nativeEntryId)
      }],
      activeEntryId: nativeEntryId
    };
    const filler: PersistedEvent = {
      ...accepted,
      id: "native-history-filler",
      globalCursor: 100_000n,
      payload: { type: "status", key: "test.native_history_filler", text: "" }
    };
    const queries: Array<{ readonly afterCursor?: bigint; readonly limit?: number }> = [];
    const history = vi.spyOn(fixture.store, "listEvents").mockImplementation((query = {}) => {
      queries.push(query);
      if (query.afterCursor === undefined) return Array<PersistedEvent>(100_000).fill(filler);
      if (query.afterCursor === 100_000n) return [{ ...accepted, globalCursor: 100_001n }];
      return [];
    });
    try {
      await fixture.host.navigateTree(sessionId, nativeEntryId, false);
    } finally {
      history.mockRestore();
    }

    const projection = fixture.store.listEvents({ sessionId, limit: 100 }).find((event) =>
      event.id !== accepted.id
      && event.pi?.entryId === nativeEntryId
      && event.payload.type === "message_complete"
    );
    expect(projection?.payload).toMatchObject({
      quotesEncoded: true,
      pastedTextRanges: [{ start: 0, end: 4, display: "Pasted text (1 line)" }]
    });
    expect(queries.map((query) => query.afterCursor)).toEqual([
      undefined,
      100_000n,
      undefined,
      100_000n
    ]);
  });

  it("deduplicates one tool image artifact across online output, native settlement, and reconnect sync", async () => {
    const adapter = new ToolImageHistoryFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-tool-image-history",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Tool image history",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const execution = fixture.host.enqueueInput({
      operationId: "run-tool-image-history",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "read image", images: [], files: [], mentions: [], disposition: "prompt" }
    });

    await eventually(() => fixture.store.getRun(execution.value.runId).descriptor.state === "completed");
    const settled = fixture.store.listEvents({ sessionId, limit: 100 });
    const artifactEvents = settled.filter((event) => event.payload.type === "artifact");
    const toolResults = settled.filter((event) => event.payload.type === "tool_result");
    expect(artifactEvents).toHaveLength(1);
    expect(toolResults).toHaveLength(2);
    expect(new Set(toolResults.flatMap((event) => event.payload.type === "tool_result"
      ? (event.payload.parts ?? []).filter((part) => part.kind === "image").map((part) => part.blob.id)
      : []))).toEqual(new Set([artifactEvents[0]!.payload.type === "artifact" ? artifactEvents[0]!.payload.artifact.id : ""]));

    await fixture.host.detach(sessionId);
    await fixture.host.resume(sessionId);
    const restarted = fixture.store.listEvents({ sessionId, limit: 100 });
    expect(restarted.filter((event) => event.payload.type === "artifact")).toHaveLength(1);
    expect(restarted.filter((event) => event.payload.type === "tool_result")).toHaveLength(2);

    await fixture.host.navigateTree(sessionId, "native-tool-image", false);
    const reconnected = fixture.store.listEvents({ sessionId, limit: 100 });
    expect(reconnected.filter((event) => event.payload.type === "artifact")).toHaveLength(1);
    expect(reconnected.filter((event) => event.payload.type === "tool_result")).toHaveLength(2);
    expect(JSON.stringify(reconnected.map((event) => event.payload))).not.toContain("base64");
  });

  it("applies scoped turn policy, restores it after settlement, and delays overridden steer", async () => {
    const adapter = new PolicyFakeAdapter();
    const fixture = await createFixture(adapter);
    const extraPath = join(fixture.directory, "approved-extra");
    mkdirSync(extraPath);
    const extra = await fixture.host.extraDirectories.add({
      workspaceId: "target-one",
      serverPath: extraPath,
      access: "read_only"
    });
    const sessionId = (await fixture.host.createSession({
      operationId: "policy-session",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Policy",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const first = fixture.host.enqueueInput({
      operationId: "policy-first",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "first", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    const steered = fixture.host.enqueueInput({
      operationId: "policy-steer",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "steer", images: [], files: [], mentions: [], disposition: "steer" },
      overrides: {
        providerId: "vision",
        modelId: "multimodal",
        effort: "high",
        fastMode: true,
        permissionMode: "auto",
        planMode: true,
        extraDirectoryIds: [extra.id]
      }
    });
    expect(fixture.store.getQueueItem(steered.value.queueItemId).executionOverrides).toMatchObject({
      modelId: "multimodal",
      extraDirectoryIds: [extra.id]
    });
    await eventually(() => fixture.store.getRun(first.value.runId).descriptor.state === "completed");
    await eventually(() => fixture.store.getRun(steered.value.runId).descriptor.state === "completed");
    expect(adapter.sentPolicies.map((value) => value.text)).toEqual(["first", "steer"]);
    expect(adapter.sentPolicies[1]).toMatchObject({
      providerId: "vision",
      modelId: "multimodal",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      extraDirectoryIds: [extra.id]
    });
    expect(adapter.currentPolicy).toMatchObject({
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      extraDirectoryIds: [extra.id]
    });
  });

  it("gates extra-directory policy by capability and rejects a manifest without its live setter", async () => {
    const disabledAdapter = new ExtraDirectoryContextFakeAdapter();
    const disabled = await createFixture(disabledAdapter);
    const disabledPath = join(disabled.directory, "disabled-extra");
    mkdirSync(disabledPath);
    await disabled.host.extraDirectories.add({
      workspaceId: "target-one",
      serverPath: disabledPath,
      access: "read_only"
    });
    await disabled.host.createSession({
      operationId: "disabled-extra-session",
      connection: disabled.connection,
      targetId: "target-one",
      title: "Disabled extra directory",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    expect(disabledAdapter.createdWithExtraDirectoryIds).toEqual([[]]);
    await disabled.host.refreshTargetExtraDirectories("target-one");
    expect(disabledAdapter.liveExtraDirectoryIds).toEqual([]);

    const inconsistentAdapter = new FakeBackendAdapter({
      ...MINIMAL_PROFILE,
      id: "extra-directory-manifest-only",
      capabilities: [
        ...MINIMAL_PROFILE.capabilities,
        { key: "workspace.extra_dirs", supported: true, options: ["read_write"] }
      ]
    });
    const inconsistent = await createFixture(inconsistentAdapter);
    const inconsistentPath = join(inconsistent.directory, "inconsistent-extra");
    mkdirSync(inconsistentPath);
    await inconsistent.host.extraDirectories.add({
      workspaceId: "target-one",
      serverPath: inconsistentPath,
      access: "read_write"
    });
    await expect(inconsistent.host.refreshTargetExtraDirectories("target-one"))
      .rejects.toMatchObject({ publicError: { code: "BACKEND_CAPABILITY_INCONSISTENT" } });
  });

  it("rejects Fast Mode before dispatch when the effective model is not explicitly eligible", async () => {
    const fixture = await createFixture();
    await expect(fixture.host.createSession({
      operationId: "unsupported-fast-create",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Unsupported fast",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: true,
      permissionMode: "ask",
      planMode: false
    })).rejects.toMatchObject({ publicError: { code: "FAST_MODE_MODEL_UNSUPPORTED", stateMayHaveChanged: false } });

    const sessionId = (await fixture.host.createSession({
      operationId: "standard-fast-baseline",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Standard",
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    expect(() => fixture.host.enqueueInput({
      operationId: "unsupported-fast-turn",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "fast", images: [], files: [], mentions: [], disposition: "prompt" },
      overrides: { fastMode: true }
    })).toThrow(expect.objectContaining({ publicError: expect.objectContaining({ code: "FAST_MODE_MODEL_UNSUPPORTED" }) }));
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(0);
  });

  it("owns exactly one opened and one resolved event for an Adapter interaction", async () => {
    const adapter = new InteractionFakeAdapter({
      id: "confirm-single-owner",
      kind: "extension_confirm",
      extensionId: "generic-extension",
      title: "Continue?",
      message: "Proceed"
    });
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-interaction-single-owner",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Single interaction owner",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const execution = fixture.host.enqueueInput({
      operationId: "send-interaction-single-owner",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "confirm", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;

    fixture.host.resolveInteraction(
      interaction.id,
      interaction.generation,
      { kind: "confirmed", confirmed: true },
      "resolve-single-owner"
    );
    await eventually(() => fixture.store.getRun(execution.value.runId).descriptor.state === "completed");

    expect(fixture.store.getQueueItem(execution.value.queueItemId).state).toBe("completed");
    expect(fixture.store.getInteraction(interaction.id).status).toBe("resolved");
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_opened" && event.payload.interaction.id === interaction.id
    )).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_resolved" && event.payload.interactionId === interaction.id
    )).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_dismissed" && event.payload.interactionId === interaction.id
    )).toHaveLength(0);
  });

  it("durably dismisses an Interaction when its Backend cancels the native request", async () => {
    const adapter = new AdapterCancellationInteractionFake();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-backend-cancelled-interaction",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Backend cancelled interaction",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const execution = fixture.host.enqueueInput({
      operationId: "send-backend-cancelled-interaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "request approval", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;

    adapter.cancelNativeInteraction();

    await eventually(() => fixture.store.getInteraction(interaction.id).status === "dismissed");
    expect(fixture.store.getInteraction(interaction.id)).toMatchObject({
      dismissalReason: "The Backend cancelled its native interaction request."
    });
    await eventually(() => adapter.decision?.kind === "cancelled");
    await eventually(() => fixture.store.getRun(execution.value.runId).descriptor.state === "completed");
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_dismissed" && event.payload.interactionId === interaction.id
    )).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_resolved" && event.payload.interactionId === interaction.id
    )).toHaveLength(0);
  });

  it("durably dismisses a timed Pi extension interaction when its native deadline expires", async () => {
    const adapter = new InteractionFakeAdapter({
      id: "timed-confirm-host",
      kind: "extension_confirm",
      extensionId: "generic-extension",
      title: "Continue quickly?",
      message: "Proceed",
      timeoutMs: 30
    });
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-timed-interaction",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Timed interaction",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const execution = fixture.host.enqueueInput({
      operationId: "send-timed-interaction",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "confirm", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;

    await eventually(() => fixture.store.getInteraction(interaction.id).status === "dismissed");
    expect(fixture.store.getInteraction(interaction.id)).toMatchObject({
      dismissalReason: "The Pi extension interaction expired."
    });
    await eventually(() => adapter.decision?.kind === "cancelled");
    await eventually(() => fixture.store.getRun(execution.value.runId).descriptor.state === "completed");
    expect(() => fixture.host.resolveInteraction(
      interaction.id,
      interaction.generation,
      { kind: "confirmed", confirmed: true },
      "late-timed-answer"
    )).toThrow(InvalidStateTransitionError);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_dismissed" && event.payload.interactionId === interaction.id
    )).toHaveLength(1);
  });

  it("durably dismisses pending interactions before a policy change and rejects every late approval", async () => {
    const adapter = new InteractionFakeAdapter({
      id: "permission-one",
      kind: "permission",
      title: "Run command?",
      toolName: "bash",
      summary: "write output",
      risk: "high",
      choices: ["allow_once", "deny_once"]
    });
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-interaction-policy",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Policy fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.host.enqueueInput({
      operationId: "send-interaction-policy",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "run", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listInteractions({ sessionId, status: "open" }).length === 1);
    const interaction = fixture.store.listInteractions({ sessionId, status: "open" })[0]!;

    await fixture.host.applySessionSettings(sessionId, { permissionMode: "auto" });

    expect(fixture.store.getInteraction(interaction.id)).toMatchObject({
      status: "dismissed",
      dismissalReason: "Execution policy changed while the interaction was pending."
    });
    await eventually(() => adapter.decision?.kind === "cancelled");
    expect(() => fixture.host.resolveInteraction(
      interaction.id,
      interaction.generation,
      { kind: "confirmed", confirmed: true },
      "late-approval"
    )).toThrow(InvalidStateTransitionError);
    expect(adapter.decision).toEqual({ kind: "cancelled" });
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_opened" && event.payload.interaction.id === interaction.id
    )).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_dismissed" && event.payload.interactionId === interaction.id
    )).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "interaction_resolved" && event.payload.interactionId === interaction.id
    )).toHaveLength(0);
  });

  it("keeps Pi extension terminal titles out of the product session while generation-fencing the client effect", async () => {
    const title = "T".repeat(140);
    const adapter = new TitleFakeAdapter(title);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-extension-title",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Original title",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const queued = fixture.host.enqueueInput({
      operationId: "send-extension-title",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "title", images: [], files: [], mentions: [], disposition: "prompt" }
    });

    await eventually(() => fixture.store.getRun(queued.value.runId).descriptor.state === "completed");
    expect(fixture.store.getSession(sessionId).descriptor.title).toBe("Original title");

    const current = fixture.store.getSession(sessionId);
    fixture.store.updateSession(sessionId, {
      binding: {
        ...current.descriptor.binding,
        generation: current.descriptor.binding.generation + 1
      }
    }, current.revision);
    await adapter.emitCapturedTitle("Stale title");

    expect(fixture.store.getSession(sessionId).descriptor.title).toBe("Original title");
    const titleEvents = fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "status" && event.payload.key === "pi.extension.title"
    );
    expect(titleEvents).toHaveLength(1);
  });

  it("persists one exact, redacted Pi observation and marks it stale without replacing it after inspection failure", async () => {
    const adapter = new PiStateFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-native-state-observation",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Observed Pi state",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const stored = fixture.store.getSession(sessionId);
    const initial = materializedNativeStateObservation(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;

    expect(initial.pi).toMatchObject({
      nativeSessionName: "task [REDACTED]",
      nativeSessionFileDisplay: "native.jsonl",
      activeLeafId: "leaf-current",
      autoRetry: true
    });
    expect(JSON.stringify(initial)).not.toContain("service-secret");
    expect(nativeStateObservationIsCurrent(
      initial,
      stored.descriptor.binding.generation,
      stored.descriptor.binding.opaqueRef
    )).toBe(true);

    adapter.failInspections = true;
    await expect(fixture.host.inspect(sessionId)).rejects.toThrow("native state unavailable");
    const stale = materializedNativeStateObservation(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;
    expect(stale.observedAt).toBe(initial.observedAt);
    expect(stale.pi).toEqual(initial.pi);
    expect(stale.staleAt).toBeGreaterThanOrEqual(initial.observedAt);
    expect(nativeStateObservationIsCurrent(
      stale,
      stored.descriptor.binding.generation,
      stored.descriptor.binding.opaqueRef
    )).toBe(false);
  });

  it("keeps native state observations scoped to their product Session", async () => {
    const adapter = new PiStateFakeAdapter();
    const fixture = await createFixture(adapter);
    const create = (operationId: string, title: string) => fixture.host.createSession({
      operationId,
      connection: fixture.connection,
      targetId: "target-one",
      title,
      fastMode: false,
      permissionMode: "ask" as const,
      planMode: false
    });
    const firstId = (await create("create-native-state-first", "First state")).value.sessionId;
    const secondId = (await create("create-native-state-second", "Second state")).value.sessionId;
    const firstBefore = materializedNativeStateObservation(fixture.store.getSetting(
      "session", firstId, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;
    const secondBefore = materializedNativeStateObservation(fixture.store.getSetting(
      "session", secondId, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;

    adapter.failSessionId = firstId;
    await expect(fixture.host.inspect(firstId)).rejects.toThrow("native state unavailable");
    const firstAfter = materializedNativeStateObservation(fixture.store.getSetting(
      "session", firstId, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;
    const secondAfter = materializedNativeStateObservation(fixture.store.getSetting(
      "session", secondId, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
    ).value)!;
    expect(firstAfter.staleAt).toBeDefined();
    expect(secondAfter).toEqual(secondBefore);
    expect(firstAfter.pi?.nativeSessionId).toBe(firstBefore.pi?.nativeSessionId);
    expect(firstAfter.pi?.nativeSessionId).not.toBe(secondAfter.pi?.nativeSessionId);
  });

  it("persists normalized runtime commands and emits exactly once only when the live catalog changes", async () => {
    const adapter = new RuntimeCommandsFakeAdapter([
      { name: "zeta", description: "Last", source: "prompt", path: "z.md", loaded: true },
      { name: "alpha", description: "First", source: "skill", path: "a/SKILL.md", loaded: true }
    ]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-commands",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime commands",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    const initial = materializedRuntimeCommands(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    ).value)!;
    expect(initial.commands.map((command) => command.name)).toEqual(["zeta", "alpha"]);
    const events = () => fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "runtime_commands_changed"
    );
    expect(events()).toHaveLength(1);
    const initialRevision = fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    ).revision;

    await expect(fixture.host.getCommands(sessionId)).resolves.toEqual(initial.commands);
    expect(events()).toHaveLength(1);
    expect(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    ).revision).toBe(initialRevision);

    const observationsAtPublication: NonNullable<ReturnType<typeof materializedRuntimeCommands>>[] = [];
    const unsubscribe = fixture.store.subscribe((event) => {
      if (event.payload.type !== "runtime_commands_changed") return;
      const observation = materializedRuntimeCommands(fixture.store.getSetting(
        "session",
        sessionId,
        SESSION_RUNTIME_COMMANDS_SETTING_KEY
      ).value);
      if (observation !== undefined) observationsAtPublication.push(observation);
    });
    adapter.commands = [
      { name: "review", description: "Review", source: "extension", path: "review.ts", loaded: true },
      { name: "alpha", description: "First", source: "skill", path: "a/SKILL.md", loaded: true }
    ];
    await expect(fixture.host.getCommands(sessionId)).resolves.toEqual(adapter.commands);
    unsubscribe();
    expect(observationsAtPublication.at(-1)?.commands).toEqual(adapter.commands);
    expect(events().at(-1)?.payload).toEqual({
      type: "runtime_commands_changed",
      commands: adapter.commands
    });

    const retained = fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    );
    adapter.failNextCommands = true;
    await expect(fixture.host.getCommands(sessionId)).rejects.toThrow("runtime command discovery failed");
    expect(events()).toHaveLength(2);
    expect(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    )).toEqual(retained);
  });

  it("reads a live runtime tool catalog through the active generation without persisting an invented registry", async () => {
    const adapter = new RuntimeToolsFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-tools",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime tools",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const beforeEvents = fixture.store.listEvents({ sessionId });

    await expect(fixture.host.getRuntimeTools(sessionId)).resolves.toEqual(adapter.catalog);

    expect(adapter.contexts).toEqual([{ sessionId, generation: fixture.store.getSession(sessionId).descriptor.binding.generation }]);
    expect(fixture.store.listEvents({ sessionId })).toEqual(beforeEvents);
  });

  it("fails closed when an Adapter does not implement live runtime tool discovery", async () => {
    const fixture = await createFixture(new FakeBackendAdapter(PI_LIKE_PROFILE));
    const sessionId = (await fixture.host.createSession({
      operationId: "create-runtime-tools-unsupported",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Runtime tools unsupported",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;

    await expect(fixture.host.getRuntimeTools(sessionId)).rejects.toThrow("does not expose a live runtime tool registry");
  });

  it("ignores a command observation that returns after its runtime generation is stale", async () => {
    const adapter = new RuntimeCommandsFakeAdapter([
      { name: "before", description: "Before", source: "prompt", loaded: true }
    ]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-stale-runtime-commands",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Stale runtime commands",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    adapter.commands = [{ name: "after", description: "After", source: "prompt", loaded: true }];
    const gate = adapter.holdNextCommands();
    const pending = fixture.host.getCommands(sessionId);
    await gate.entered;
    const stored = fixture.store.getSession(sessionId);
    fixture.store.updateSession(sessionId, {
      binding: { ...stored.descriptor.binding, generation: stored.descriptor.binding.generation + 1 }
    }, stored.revision);
    gate.release();

    await expect(pending).resolves.toEqual([
      { name: "before", description: "Before", source: "prompt", loaded: true }
    ]);
    expect(materializedRuntimeCommands(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    ).value)?.commands.map((command) => command.name)).toEqual(["before"]);
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "runtime_commands_changed"
    )).toHaveLength(1);
  });

  it("keeps the durable catalog equal across host restart and generation refresh", async () => {
    const commands: readonly RuntimeCommand[] = [
      { name: "review", description: "Review", source: "extension", path: "review.ts", loaded: true }
    ];
    const fixture = await createFixture(new RuntimeCommandsFakeAdapter(commands));
    const sessionId = (await fixture.host.createSession({
      operationId: "create-restarted-runtime-commands",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Restarted runtime commands",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    await fixture.host.dispose();

    const restartedAdapter = new RuntimeCommandsFakeAdapter(commands);
    const restartedHost = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter]);
    cleanups.push(() => restartedHost.dispose());
    await restartedHost.initialize();
    await expect(restartedHost.getCommands(sessionId)).resolves.toEqual(commands);

    const session = fixture.store.getSession(sessionId);
    const observation = materializedRuntimeCommands(fixture.store.getSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    ).value);
    expect(observation).toMatchObject({ generation: session.descriptor.binding.generation, commands });
    expect(fixture.store.listEvents({ sessionId }).filter((event) =>
      event.payload.type === "runtime_commands_changed"
    )).toHaveLength(1);
  });

  it("deletes the complete assistant turn and rebuilds before the next dispatch", async () => {
    const adapter = new MessageDeleteFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-message-delete",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delete messages",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "delete-user-1", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "surviving user context" }]
    });
    appendSessionEvent(fixture.store, sessionId, "delete-delta", 20, {
      type: "text_delta", blockId: "delete-block", delta: "remove streamed output"
    });
    appendSessionEvent(fixture.store, sessionId, "delete-assistant-1", 21, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "remove assistant one" }]
    });
    appendSessionEvent(fixture.store, sessionId, "delete-assistant-2", 22, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "remove assistant two" }]
    });
    const generation = fixture.store.getSession(sessionId).descriptor.binding.generation;
    fixture.store.openInteraction({
      sessionId,
      generation,
      payload: {
        id: "delete-question",
        kind: "question",
        title: "Question",
        prompt: "remove this question too",
        fields: []
      },
      traceId: "test:delete-question",
      createdAt: 23
    });
    fixture.store.resolveInteraction(
      "delete-question",
      generation,
      { answers: {} },
      "test:delete-question:resolved",
      undefined,
      24
    );
    const questionEventId = fixture.store.listEvents({ sessionId }).find((event) =>
      event.payload.type === "interaction_opened" && event.payload.interaction.id === "delete-question")!.id;
    appendSessionEvent(fixture.store, sessionId, "delete-user-2", 30, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "keep next user" }]
    });
    appendSessionEvent(fixture.store, sessionId, "delete-assistant-3", 31, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "keep next answer" }]
    });

    const deleted = await fixture.host.deleteSessionMessage({
      operationId: "delete-assistant-turn",
      connection: fixture.connection,
      sessionId,
      eventId: "delete-assistant-1",
      body: { sessionId, eventId: "delete-assistant-1" },
      result: (eventIds) => eventIds
    });
    expect(deleted.value).toEqual(["delete-delta", "delete-assistant-1", "delete-assistant-2", questionEventId]);
    const visibleEventIds = fixture.store.listEvents({ sessionId }).map((event) => event.id);
    expect(visibleEventIds).toEqual(expect.arrayContaining(["delete-user-1", "delete-user-2", "delete-assistant-3"]));
    expect(visibleEventIds).not.toEqual(expect.arrayContaining(["delete-delta", "delete-assistant-1", "delete-assistant-2"]));
    expect(fixture.store.listInteractions({ sessionId })).toEqual([]);
    await expect(fixture.host.inspect(sessionId)).rejects.toMatchObject({
      publicError: { code: "SESSION_CONTEXT_REBUILD_PENDING" }
    });

    const queued = fixture.host.enqueueInput({
      operationId: "message-delete-next-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "next prompt", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "completed");
    expect(adapter.sequence[0]).toBe("rebuild");
    expect(adapter.sequence).toContain("send:next prompt");
    expect(adapter.rebuildInputs[0]?.messages.map((message) => ({
      role: message.role,
      text: message.blocks.filter((block) => block.kind === "text")
        .map((block) => block.kind === "text" ? block.text : "").join("\n")
    }))).toEqual([
      { role: "user", text: "surviving user context" },
      { role: "user", text: "keep next user" },
      { role: "assistant", text: "keep next answer" }
    ]);
    expect(fixture.store.findPendingContextRebuild(sessionId)).toBeUndefined();
    expect(fixture.store.getSession(sessionId).descriptor.binding.opaqueRef).toContain("/rebuild/");
  });

  it("deletes a user message that is the 100001st visible Event", { timeout: 20_000 }, async () => {
    const adapter = new MessageDeleteFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-message-delete-boundary",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delete boundary",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "delete-user-tail", 100_001, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "tail user" }]
    });
    const tail = fixture.store.findEvent("delete-user-tail")!;
    const filler: PersistedEvent = {
      ...tail,
      id: "delete-boundary-filler",
      globalCursor: 100_000n,
      payload: { type: "status", key: "test.delete_boundary_filler", text: "" }
    };
    const queries: Array<{ readonly afterCursor?: bigint; readonly limit?: number }> = [];
    const history = vi.spyOn(fixture.store, "listEvents").mockImplementation((query = {}) => {
      queries.push(query);
      if (query.afterCursor === undefined) return Array<PersistedEvent>(100_000).fill(filler);
      if (query.afterCursor === 100_000n) return [{ ...tail, globalCursor: 100_001n }];
      return [];
    });
    try {
      const deleted = await fixture.host.deleteSessionMessage({
        operationId: "delete-user-tail-operation",
        connection: fixture.connection,
        sessionId,
        eventId: tail.id,
        body: { sessionId, eventId: tail.id },
        result: (eventIds) => eventIds
      });
      expect(deleted.value).toEqual([tail.id]);
    } finally {
      history.mockRestore();
    }
    expect(fixture.store.findEvent(tail.id)).toBeUndefined();
    const cursors = queries.map((query) => query.afterCursor);
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(cursors.length % 2).toBe(0);
    for (let index = 0; index < cursors.length; index += 2) {
      expect(cursors.slice(index, index + 2)).toEqual([undefined, 100_000n]);
    }
  });

  it("classifies a continuation whose queue record is after the first 100000 items", { timeout: 20_000 }, async () => {
    const adapter = new MessageDeleteFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-message-delete-queue-boundary",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delete queue boundary",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.store.createRun({
      id: "delete-steer-run",
      sessionId,
      source: "user",
      state: "completed",
      createdAt: 1
    });
    appendSessionEvent(fixture.store, sessionId, "delete-queue-user-one", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "first user" }]
    });
    appendSessionEvent(fixture.store, sessionId, "delete-queue-assistant-one", 11, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "first output" }]
    });
    const session = fixture.store.getSession(sessionId).descriptor;
    fixture.store.appendEvent({
      id: "delete-queue-hidden-steer",
      backendId: session.backendId,
      targetId: session.targetId,
      sessionId,
      runId: "delete-steer-run",
      generation: session.binding.generation,
      emittedAt: 12,
      traceId: "delete-queue-hidden-steer",
      payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "steer" }] }
    });
    appendSessionEvent(fixture.store, sessionId, "delete-queue-assistant-two", 13, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "second output" }]
    });
    appendSessionEvent(fixture.store, sessionId, "delete-queue-user-two", 14, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "next user" }]
    });
    const original = fixture.store.listQueueItems.bind(fixture.store);
    const filler = { id: "queue-filler", runId: "queue-filler-run", disposition: "prompt" } as QueueItemRecord;
    const continuation = {
      id: "queue-continuation-tail",
      runId: "delete-steer-run",
      disposition: "steer"
    } as QueueItemRecord;
    const queue = vi.spyOn(fixture.store, "listQueueItems").mockImplementation((options = {}) => {
      if (options.limit !== 100_000) return original(options);
      if ((options.offset ?? 0) === 0) return Array<QueueItemRecord>(100_000).fill(filler);
      if (options.offset === 100_000) return [continuation];
      return [];
    });
    try {
      const deleted = await fixture.host.deleteSessionMessage({
        operationId: "delete-queue-boundary-operation",
        connection: fixture.connection,
        sessionId,
        eventId: "delete-queue-assistant-two",
        body: { sessionId, eventId: "delete-queue-assistant-two" },
        result: (eventIds) => eventIds
      });
      expect(deleted.value).toEqual([
        "delete-queue-assistant-one",
        "delete-queue-hidden-steer",
        "delete-queue-assistant-two"
      ]);
    } finally {
      queue.mockRestore();
    }
  });

  it("keeps the prompt accepted when context rebuild fails and safely retries the claim", async () => {
    const adapter = new MessageDeleteFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-message-delete-retry",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delete retry",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "delete-retry-user", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "remove just this user" }]
    });
    await fixture.host.deleteSessionMessage({
      operationId: "delete-user-row",
      connection: fixture.connection,
      sessionId,
      eventId: "delete-retry-user",
      body: { sessionId, eventId: "delete-retry-user" },
      result: (eventIds) => eventIds
    });
    adapter.failRebuild = true;
    const queued = fixture.host.enqueueInput({
      operationId: "message-delete-retained-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "must not be lost", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.rebuildInputs.length === 1 && fixture.store.findPendingContextRebuild(sessionId)?.state === "pending");
    expect(fixture.store.getQueueItem(queued.value.queueItemId)).toMatchObject({
      state: "accepted",
      body: { text: "must not be lost" }
    });
    expect(adapter.sequence).not.toContain("send:must not be lost");

    adapter.failRebuild = false;
    fixture.host.requestQueueDrain(sessionId);
    await eventually(() => fixture.store.getQueueItem(queued.value.queueItemId).state === "completed");
    expect(adapter.rebuildInputs).toHaveLength(2);
    expect(adapter.sequence).toContain("send:must not be lost");
    expect(fixture.store.findPendingContextRebuild(sessionId)).toBeUndefined();
  });

  it("rebuilds a context-window failure and replays one unchanged safe user prompt", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow", "success"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-safe",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Context recovery",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "context-survivor", 10, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "surviving context marker" }]
    });

    const source = fixture.host.enqueueInput({
      operationId: "context-overflow-safe-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "retry exactly once", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listQueueItems({ sessionId }).length === 2 &&
      fixture.store.listQueueItems({ sessionId }).every((item) => item.state === "completed" || item.state === "failed"));

    const queueItems = fixture.store.listQueueItems({ sessionId });
    const replay = queueItems.find((item) => item.id !== source.value.queueItemId)!;
    expect(fixture.store.getQueueItem(source.value.queueItemId).state).toBe("failed");
    expect(replay).toMatchObject({
      state: "completed",
      body: { text: "retry exactly once", disposition: "prompt" }
    });
    const replayRun = fixture.store.getRun(replay.runId).descriptor;
    expect(replayRun).toMatchObject({ source: "system", parentRunId: source.value.runId, state: "completed" });
    expect(adapter.sequence.filter((entry) => entry === "send:retry exactly once")).toHaveLength(2);
    expect(adapter.sequence.indexOf("rebuild")).toBeGreaterThan(adapter.sequence.indexOf("send:retry exactly once"));
    expect(adapter.sequence.at(-1)).toBe("send:retry exactly once");
    expect(adapter.rebuildInputs[0]).toMatchObject({ reason: "context_overflow" });
    expect(adapter.rebuildInputs[0]?.handoff).toContain("surviving context marker");
    expect(adapter.rebuildInputs[0]?.handoff).not.toContain("retry exactly once");
    expect(fixture.store.listEvents({ sessionId }).find((event) =>
      event.payload.type === "context_rebuild"
    )?.payload).toMatchObject({
      type: "context_rebuild",
      reason: "context_overflow",
      replayScheduled: true
    });
  });

  it("hands every surviving message and complete long text to context rebuilds", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow", "success"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-complete-handoff",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Complete context handoff",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const longMessage = `long-context-start-${"x".repeat(40_000)}-long-context-end`;
    for (let index = 0; index < 401; index += 1) {
      appendSessionEvent(fixture.store, sessionId, `complete-handoff-${index}`, 10 + index, {
        type: "message_complete",
        role: index % 2 === 0 ? "user" : "assistant",
        blocks: [{
          kind: "text",
          text: index === 200 ? longMessage : `surviving-context-${index}`
        }]
      });
    }

    const source = fixture.host.enqueueInput({
      operationId: "context-overflow-complete-handoff-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "trigger complete handoff", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listQueueItems({ sessionId }).length === 2 &&
      fixture.store.listQueueItems({ sessionId }).every((item) => item.state === "completed" || item.state === "failed"));

    expect(fixture.store.getQueueItem(source.value.queueItemId).state).toBe("failed");
    expect(adapter.rebuildInputs).toHaveLength(1);
    const handoff = adapter.rebuildInputs[0]!.handoff;
    expect(handoff).toContain("surviving-context-0");
    expect(handoff).toContain("surviving-context-400");
    expect(handoff).toContain("long-context-start-");
    expect(handoff).toContain("-long-context-end");
    expect(handoff).not.toContain("trigger complete handoff");
  });

  it("orders the fenced overflow replay ahead of a later accepted prompt", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow", "success", "success"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-order",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Context replay ordering",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.host.enqueueInput({
      operationId: "context-overflow-order-source",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "replay before later", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    fixture.host.enqueueInput({
      operationId: "context-overflow-order-later",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "later accepted prompt", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listQueueItems({ sessionId }).length === 3 &&
      fixture.store.listQueueItems({ sessionId }).every((item) => item.state === "completed" || item.state === "failed"));
    expect(adapter.sequence.filter((entry) => entry.startsWith("send:"))).toEqual([
      "send:replay before later",
      "send:replay before later",
      "send:later accepted prompt"
    ]);
  });

  it("does not automatically replay a context failure after assistant output", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow_with_output", "success"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-output",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Context side effects",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const source = fixture.host.enqueueInput({
      operationId: "context-overflow-output-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "do not duplicate me", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(source.value.queueItemId).state === "failed" &&
      fixture.store.findPendingContextRebuild(sessionId)?.reason === "context_overflow");
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(1);
    expect(adapter.sequence.filter((entry) => entry === "send:do not duplicate me")).toHaveLength(1);
    expect(adapter.rebuildInputs).toHaveLength(0);
    expect(fixture.store.findPendingContextRebuild(sessionId)).toMatchObject({
      sourceInputPending: false,
      replaySafe: false
    });

    const next = fixture.host.enqueueInput({
      operationId: "context-overflow-output-next",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "continue explicitly", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(next.value.queueItemId).state === "completed");
    expect(adapter.sequence.filter((entry) => entry === "send:do not duplicate me")).toHaveLength(1);
    expect(adapter.sequence).toEqual(expect.arrayContaining([
      "send:do not duplicate me",
      "rebuild",
      "send:continue explicitly"
    ]));
    expect(adapter.rebuildInputs[0]?.handoff).toContain("do not duplicate me");
    expect(adapter.rebuildInputs[0]?.handoff).toContain("partial observable answer");
    expect(fixture.store.listRuns({ sessionId }).some((run) => run.descriptor.source === "system")).toBe(false);
  });

  it("leaves an external dispatch owner in charge of retrying a safe overflow", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-owner",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Context owner fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const source = fixture.host.enqueueServiceInput({
      operationId: "context-overflow-owned-input",
      sessionId,
      source: "system",
      prompt: { text: "owner must retry", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(source.value.queueItemId).state === "failed" &&
      fixture.store.findPendingContextRebuild(sessionId)?.reason === "context_overflow");
    expect(fixture.store.findPendingContextRebuild(sessionId)).toMatchObject({
      sourceInputPending: true,
      replaySafe: false
    });
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(1);
    expect(adapter.sequence.filter((entry) => entry === "send:owner must retry")).toHaveLength(1);
    expect(adapter.rebuildInputs).toHaveLength(0);
  });

  it("defers prompt-timeout rebuilding until a later explicit send and never replays the timed-out input", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["prompt_timeout", "success"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-prompt-timeout",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Prompt timeout recovery",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "timeout-survivor", 10, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "previous completed answer" }]
    });
    const timedOut = fixture.host.enqueueInput({
      operationId: "prompt-timeout-source",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "uncertain timed-out input", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(timedOut.value.queueItemId).state === "dispatch_unknown" &&
      fixture.store.findPendingContextRebuild(sessionId)?.reason === "prompt_timeout");
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(1);
    expect(adapter.rebuildInputs).toHaveLength(0);

    const next = fixture.host.enqueueInput({
      operationId: "prompt-timeout-next",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "new explicit input", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.getQueueItem(next.value.queueItemId).state === "completed");
    expect(fixture.store.getQueueItem(timedOut.value.queueItemId)).toMatchObject({
      state: "failed",
      error: { code: "NATIVE_CONTEXT_REPLACED", stateMayHaveChanged: true }
    });
    expect(adapter.sequence.filter((entry) => entry === "send:uncertain timed-out input")).toHaveLength(1);
    expect(adapter.sequence).toEqual(expect.arrayContaining([
      "send:uncertain timed-out input",
      "rebuild",
      "send:new explicit input"
    ]));
    expect(adapter.rebuildInputs[0]?.reason).toBe("prompt_timeout");
    expect(adapter.rebuildInputs[0]?.handoff).toContain("previous completed answer");
    expect(adapter.rebuildInputs[0]?.handoff).not.toContain("uncertain timed-out input");
    expect(fixture.store.listRuns({ sessionId }).some((run) => run.descriptor.source === "system")).toBe(false);
    expect(fixture.store.listEvents({ sessionId }).find((event) =>
      event.payload.type === "context_rebuild"
    )?.payload).toMatchObject({ reason: "prompt_timeout", replayScheduled: false });
  });

  it("never recursively replays the Host-owned overflow replay", async () => {
    const adapter = new NativeContextRecoveryFakeAdapter(["context_overflow", "context_overflow"]);
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-context-overflow-loop-fence",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Context replay loop fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    fixture.host.enqueueInput({
      operationId: "context-overflow-loop-source",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "one replay maximum", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => fixture.store.listQueueItems({ sessionId }).length === 2 &&
      fixture.store.listQueueItems({ sessionId }).every((item) => item.state === "failed") &&
      fixture.store.findPendingContextRebuild(sessionId)?.replaySafe === false);
    expect(adapter.sequence.filter((entry) => entry === "send:one replay maximum")).toHaveLength(2);
    expect(fixture.store.listQueueItems({ sessionId })).toHaveLength(2);
    expect(fixture.store.listRuns({ sessionId }).filter((run) => run.descriptor.source === "system")).toHaveLength(1);
  });

  it("fences queue admission for the full native-close deletion window", async () => {
    const adapter = new MessageDeleteFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-message-delete-admission",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Delete admission fence",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "delete-admission-user", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "delete while close is gated" }]
    });
    const close = adapter.holdClose();
    const deletion = fixture.host.deleteSessionMessage({
      operationId: "delete-admission-row",
      connection: fixture.connection,
      sessionId,
      eventId: "delete-admission-user",
      body: { sessionId, eventId: "delete-admission-user" },
      result: (eventIds) => eventIds
    });
    await close.entered;
    expect(() => fixture.host.enqueueInput({
      operationId: "delete-admission-racing-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "must be rejected before persistence", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrowError(expect.objectContaining({ publicError: expect.objectContaining({ code: "SESSION_MESSAGE_DELETE_IN_PROGRESS" }) }));
    expect(() => fixture.store.getOperation("delete-admission-racing-input")).toThrow();
    close.release();
    await expect(deletion).resolves.toMatchObject({ value: ["delete-admission-user"] });
  });

  it("clears context in place while switching to a fresh empty native Session", async () => {
    const adapter = new SessionResetFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-session-reset",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Clear in place",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "reset-old-user", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "old context" }]
    });
    appendSessionEvent(fixture.store, sessionId, "reset-old-assistant", 11, {
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "old answer" }]
    });
    const before = fixture.store.getSession(sessionId);

    const cleared = await fixture.host.resetSession({
      operationId: "clear-session-context",
      connection: fixture.connection,
      sessionId,
      body: { sessionId },
      result: (session) => ({ id: session.descriptor.id, title: session.descriptor.title })
    });

    const after = fixture.store.getSession(sessionId);
    expect(cleared.value).toEqual({ id: sessionId, title: "Clear in place" });
    expect(fixture.store.listSessions()).toHaveLength(1);
    expect(after.descriptor.binding.opaqueRef).not.toBe(before.descriptor.binding.opaqueRef);
    expect(after.descriptor.binding.nativeSessionId).not.toBe(before.descriptor.binding.nativeSessionId);
    expect(after.descriptor.binding.generation).toBeGreaterThan(before.descriptor.binding.generation);
    expect(adapter.resetCalls).toBe(1);
    expect(fixture.store.listEvents({ sessionId }).map((event) => event.payload.type)).toEqual(["session_reset"]);
    expect(fixture.store.listEvents({ sessionId, includeTombstoned: true }).map((event) => event.id))
      .toEqual(expect.arrayContaining(["reset-old-user", "reset-old-assistant"]));
  });

  it("fails closed on native reset failure and allows a new operation to retry", async () => {
    const adapter = new SessionResetFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-session-reset-retry",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Clear retry",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "reset-retry-old", 10, {
      type: "message_complete", role: "user", blocks: [{ kind: "text", text: "must remain on failure" }]
    });
    const originalOpaqueRef = fixture.store.getSession(sessionId).descriptor.binding.opaqueRef;
    adapter.failReset = true;

    await expect(fixture.host.resetSession({
      operationId: "clear-session-failed",
      connection: fixture.connection,
      sessionId,
      body: { sessionId },
      result: (session) => session.descriptor.id
    })).rejects.toBeInstanceOf(OperationPreviouslyFailedError);
    expect(fixture.store.getSession(sessionId).descriptor.binding.opaqueRef).toBe(originalOpaqueRef);
    expect(fixture.store.listEvents({ sessionId }).some((event) => event.id === "reset-retry-old")).toBe(true);
    expect(fixture.store.getOperation("clear-session-failed").error).toMatchObject({
      code: "SESSION_RESET_EFFECT_FAILED",
      retryable: true
    });

    adapter.failReset = false;
    await expect(fixture.host.resetSession({
      operationId: "clear-session-retry-success",
      connection: fixture.connection,
      sessionId,
      body: { sessionId },
      result: (session) => session.descriptor.id
    })).resolves.toMatchObject({ value: sessionId });
    expect(fixture.store.listEvents({ sessionId }).map((event) => event.payload.type)).toEqual(["session_reset"]);
  });

  it("rejects durable background work and fences prompt admission for the full reset effect", async () => {
    const adapter = new SessionResetFakeAdapter();
    const fixture = await createFixture(adapter);
    const sessionId = (await fixture.host.createSession({
      operationId: "create-session-reset-admission",
      connection: fixture.connection,
      targetId: "target-one",
      title: "Clear admission",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    appendSessionEvent(fixture.store, sessionId, "reset-background-running", 10, {
      type: "background_task", taskId: "background-1", title: "Background", state: "running"
    });
    await expect(fixture.host.resetSession({
      operationId: "clear-session-background-rejected",
      connection: fixture.connection,
      sessionId,
      body: { sessionId },
      result: (session) => session.descriptor.id
    })).rejects.toMatchObject({ publicError: { code: "SESSION_RESET_NOT_IDLE", retryable: true } });
    appendSessionEvent(fixture.store, sessionId, "reset-background-done", 11, {
      type: "background_task", taskId: "background-1", title: "Background", state: "completed"
    });

    const resetGate = adapter.holdReset();
    const reset = fixture.host.resetSession({
      operationId: "clear-session-admission",
      connection: fixture.connection,
      sessionId,
      body: { sessionId },
      result: (session) => session.descriptor.id
    });
    await resetGate.entered;
    expect(() => fixture.host.enqueueInput({
      operationId: "clear-session-racing-input",
      connection: fixture.connection,
      sessionId,
      prompt: { text: "must not be queued", images: [], files: [], mentions: [], disposition: "prompt" }
    })).toThrowError(expect.objectContaining({ publicError: expect.objectContaining({ code: "SESSION_RESET_IN_PROGRESS" }) }));
    expect(() => fixture.store.getOperation("clear-session-racing-input")).toThrow();
    resetGate.release();
    await expect(reset).resolves.toMatchObject({ value: sessionId });
  });
});

function appendSessionEvent(
  store: OperationalStore,
  sessionId: string,
  eventId: string,
  emittedAt: number,
  payload: EventPayload
): void {
  const session = store.getSession(sessionId).descriptor;
  store.appendEvent({
    id: eventId,
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId,
    generation: session.binding.generation,
    emittedAt,
    traceId: `test:${eventId}`,
    payload
  });
}

function reviewSeal() {
  const dimensions = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)] as const;
  return {
    version: 1 as const,
    conversationSha256: dimensions[0],
    workspaceSha256: dimensions[1],
    filesSha256: dimensions[2],
    artifactsSha256: dimensions[3],
    sealSha256: createHash("sha256")
      .update("joko.review.freshness/v1")
      .update("\0")
      .update("seal")
      .update("\0")
      .update(JSON.stringify(dimensions))
      .digest("hex")
  };
}

interface HostServiceRecoveryProcessOptions {
  readonly recovering: boolean;
  readonly outcome?: "completed" | "aborted" | "failed";
  readonly persistNativeTurn?: boolean;
  readonly mutatePrefixOnPrompt?: boolean;
}

class HostServiceRecoveryProcess extends EventEmitter implements PiProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid: number;
  readonly serviceRecovery: { readonly required: true } | undefined;
  readonly spec: PiProcessSpec;
  readonly commands: Record<string, unknown>[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #entries: Record<string, unknown>[];
  readonly #options: HostServiceRecoveryProcessOptions;
  readonly #sessionFile: string;
  readonly #sessionId: string;
  #pending = Buffer.alloc(0);

  constructor(
    spec: PiProcessSpec,
    entries: Record<string, unknown>[],
    options: HostServiceRecoveryProcessOptions
  ) {
    super();
    this.spec = spec;
    this.#entries = entries;
    this.#options = options;
    this.serviceRecovery = options.recovering ? { required: true } : undefined;
    this.pid = options.recovering ? 702 : 701;
    const sessionDirectory = hostServiceArgument(spec.args, "--session-dir");
    const resumedSession = hostServiceOptionalArgument(spec.args, "--session");
    this.#sessionId = hostServiceOptionalArgument(spec.args, "--session-id") ??
      (resumedSession === undefined ? "host-service-recovered" : basename(resumedSession, extname(resumedSession)));
    this.#sessionFile = resumedSession ??
      join(sessionDirectory, `${this.#sessionId}.jsonl`);
    mkdirSync(dirname(this.#sessionFile), { recursive: true });
    if (resumedSession === undefined) {
      writeFileSync(this.#sessionFile, `${JSON.stringify({
        type: "session",
        version: 3,
        id: this.#sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: spec.cwd
      })}\n`);
      for (const entry of entries) writeFileSync(this.#sessionFile, `${JSON.stringify(entry)}\n`, { flag: "a" });
    }
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          this.#pending = Buffer.concat([this.#pending, chunk]);
          let newline: number;
          while ((newline = this.#pending.indexOf(0x0a)) >= 0) {
            const command = JSON.parse(this.#pending.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
            this.#pending = this.#pending.subarray(newline + 1);
            this.#handle(command);
          }
          callback();
        } catch (error) {
          callback(error as Error);
        }
      }
    });
    if (options.recovering) {
      queueMicrotask(() => {
        this.#send({ type: "response", id: "old-service-request", command: "prompt", success: true });
        this.#send({ type: "message_start", message: { role: "assistant", content: [] } });
        this.#send({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "stale replay must remain private" }] }
        });
      });
    }
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.signalCode = typeof signal === "string" ? signal : null;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", 0, this.signalCode));
    return true;
  }

  #send(value: unknown): void {
    this.stdout.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  }

  #success(command: Record<string, unknown>, data?: unknown): void {
    this.#send({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data })
    });
  }

  #handle(command: Record<string, unknown>): void {
    this.commands.push(command);
    switch (command.type) {
      case "clear_queue":
        this.#success(command, { steering: [], followUp: [] });
        return;
      case "get_state":
        this.#success(command, {
          model: {
            provider: "local",
            id: "test-model",
            name: "Test Model",
            api: "openai-completions",
            reasoning: true,
            input: ["text"],
            contextWindow: 32_768,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          },
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: this.#sessionFile,
          sessionId: this.#sessionId,
          autoCompactionEnabled: true,
          messageCount: this.#entries.length,
          pendingMessageCount: 0
        });
        return;
      case "get_session_stats":
        this.#success(command, {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextUsage: { tokens: 0, contextWindow: 32_768, percent: 0 }
        });
        return;
      case "get_tree":
        this.#success(command, { tree: [], leafId: hostServiceLeafId(this.#entries) ?? null });
        return;
      case "get_entries":
        this.#success(command, { entries: this.#entries, leafId: hostServiceLeafId(this.#entries) ?? null });
        return;
      case "get_commands": {
        const bridge = hostServiceArgumentValues(this.spec.args, "--extension").at(-1) ?? "managed-bridge";
        this.#success(command, {
          commands: ["plan", "joko-navigate-tree", "joko-rebuild-context", "joko-reset-context"].map((name) => ({
            name,
            source: "extension",
            sourceInfo: { path: bridge, scope: "temporary" }
          }))
        });
        return;
      }
      case "prompt": {
        if (this.#options.mutatePrefixOnPrompt && this.#entries.length > 0) {
          const message = this.#entries[0]?.["message"];
          if (message !== null && typeof message === "object" && !Array.isArray(message)) {
            (message as Record<string, unknown>)["content"] = [{ type: "text", text: "mutated prefix" }];
          }
        }
        if (this.#options.persistNativeTurn !== false) {
          const parentId = hostServiceLeafId(this.#entries);
          const user = {
            type: "message",
            id: "service-recovery-user",
            parentId: parentId ?? null,
            timestamp: new Date(10).toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: String(command.message ?? "") }],
              timestamp: 10
            }
          };
          const outcome = this.#options.outcome ?? "completed";
          const assistant = {
            type: "message",
            id: "service-recovery-assistant",
            parentId: user.id,
            timestamp: new Date(11).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "completed while service was unavailable" }],
              api: "openai-completions",
              provider: "local",
              model: "test-model",
              usage: hostServiceZeroUsage(),
              stopReason: outcome === "completed" ? "stop" : outcome === "aborted" ? "aborted" : "error",
              timestamp: 11,
              ...(outcome === "failed" ? { errorMessage: "provider failed" } : {})
            }
          };
          this.#entries.push(user, assistant);
          writeFileSync(this.#sessionFile, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`, { flag: "a" });
        }
        this.#success(command);
        return;
      }
      case "set_model":
        this.#success(command, {
          provider: String(command.provider ?? "local"),
          id: String(command.modelId ?? "test-model"),
          name: "Test Model",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          contextWindow: 32_768,
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        });
        return;
      case "switch_session":
        this.#success(command, { cancelled: false });
        return;
      default:
        this.#success(command);
    }
  }
}

function hostServiceArgument(args: readonly string[], name: string): string {
  const value = hostServiceOptionalArgument(args, name);
  if (value === undefined) throw new Error(`Missing process argument ${name}.`);
  return value;
}

function hostServiceOptionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.lastIndexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function hostServiceArgumentValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) values.push(args[index + 1]!);
  }
  return values;
}

function hostServiceLeafId(entries: readonly Record<string, unknown>[]): string | undefined {
  const id = entries.at(-1)?.["id"];
  return typeof id === "string" ? id : undefined;
}

class RuntimeRecoveryFakeAdapter extends FakeBackendAdapter {
  readonly prompts: string[] = [];
  readonly modelSelections: Array<{ readonly providerId: string; readonly modelId: string }> = [];
  #failuresRemaining = 2;

  constructor() {
    const baseModel = PI_LIKE_PROFILE.models[0]!;
    super({
      ...PI_LIKE_PROFILE,
      id: "runtime-recovery-fake",
      models: [
        { ...baseModel, providerId: "provider-a", modelId: "reasoner", thinkingLevels: ["off", "medium", "high"] },
        { ...baseModel, providerId: "provider-b", modelId: "reasoner", thinkingLevels: ["off", "medium", "high"] }
      ]
    });
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.prompts.push(input.text);
    await context.emit({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: input.text }]
    });
    if (this.#failuresRemaining <= 0) return super.send(input, context);
    this.#failuresRemaining -= 1;
    await context.emit({
      type: "error",
      terminal: true,
      error: {
        code: "UPSTREAM_OVERLOAD",
        message: "The selected route is at capacity.",
        phase: "retry",
        retryable: false,
        stateMayHaveChanged: true,
        recovery: "Select another connected source."
      }
    });
    await context.emit({ type: "done", outcome: "failed" });
  }

  override async setModel(providerId: string, modelId: string, context: AdapterContext) {
    this.modelSelections.push({ providerId, modelId });
    return super.setModel(providerId, modelId, context);
  }
}

class InstanceGenerationCaptureFakeAdapter extends FakeBackendAdapter {
  creationContext?: AdapterContext;
  context?: AdapterContext;

  constructor() {
    super({ ...MINIMAL_PROFILE, id: "instance-generation-capture" });
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.creationContext = context;
    return super.createSession(input, context);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    this.context = context;
  }
}

function advanceBackendInstanceGeneration(store: OperationalStore, backendId: string): number {
  const current = store.getBackend(backendId).descriptor;
  const reservation = store.reserveBackendInstanceGeneration({
    backendId,
    adapterKind: current.adapterKind
  });
  const publication = store.publishBackendInstanceDescriptor({
    descriptor: { ...current, instanceGeneration: reservation.generation },
    ...(reservation.expectedCurrentGeneration === undefined
      ? {}
      : { expectedCurrentGeneration: reservation.expectedCurrentGeneration })
  });
  if (publication.status !== "published") throw new Error("Fixture Backend publication lost its generation fence.");
  return reservation.generation;
}

async function createFixture(
  adapter: FakeBackendAdapter = new FakeBackendAdapter(PI_LIKE_PROFILE),
  hostOptions: {
    readonly workspaceCapture?: WorkspaceRunCapture;
    readonly monotonicNow?: () => number;
    readonly freezeToolPolicies?: (sessionId: string, targetId: string) => void;
    readonly runSilenceTimeoutMs?: number;
    readonly backendRetirementTimeoutMs?: number;
    readonly usageMoneyKind?: (
      backendId: string,
      providerId: string
    ) => "actual-cost" | "subscription-value" | "reference-value";
    readonly backendEnabled?: (backendId: string) => boolean;
    readonly providerRoutingEnabled?: (backendId: string, providerId: string) => boolean;
    readonly modelRoutingEnabled?: (backendId: string, providerId: string, modelId: string) => boolean;
    readonly modelAccessRestricted?: (backendId: string) => boolean;
    readonly sessionRuntimeFallbackEnabled?: () => boolean;
    readonly sessionRuntimeFallbackContext?: (backendId: string) => {
      readonly availableProviderIds: ReadonlySet<string>;
      readonly explicitDefault?: { readonly providerId: string; readonly modelId: string };
    };
    readonly sessionRuntimeRecoveryDelayMs?: (attempt: number) => number;
    readonly additionalAdapters?: readonly FakeBackendAdapter[];
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "joko-host-"));
  const store = new OperationalStore(join(directory, "store.db"));
  const repository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository, ingestRoots: [directory] });
  await artifacts.initialize();
  const { additionalAdapters = [], ...sessionHostOptions } = hostOptions;
  const host = new SessionHost(store, artifacts, [adapter, ...additionalAdapters], sessionHostOptions);
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: adapter.id,
    displayName: "Target",
    workspaceRoot: directory,
    managed: true,
    trusted: true
  });
  const connection = store.createConnection({
    id: "connection-one",
    name: "Test device",
    authKeyDigest: "digest"
  });
  cleanups.push(async () => {
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, adapter, host, artifacts, connection, directory };
}

async function createMultiAdapterFixture(adapters: readonly FakeBackendAdapter[]) {
  const directory = mkdtempSync(join(tmpdir(), "joko-host-dispose-"));
  const store = new OperationalStore(join(directory, "store.db"));
  const repository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository, ingestRoots: [directory] });
  await artifacts.initialize();
  const host = new SessionHost(store, artifacts, adapters);
  await host.initialize();
  cleanups.push(async () => {
    await host.dispose().catch(() => undefined);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, host, artifacts, directory };
}

class CatalogScanFakeAdapter extends FakeBackendAdapter {
  readonly scans: Array<{
    readonly resolve: (result: NativeSessionCatalogResult) => void;
  }> = [];

  constructor() {
    super({
      ...MINIMAL_PROFILE,
      id: "catalog-scan",
      displayName: "Catalog scan",
      capabilities: [
        ...MINIMAL_PROFILE.capabilities.filter((capability) => capability.key !== "session.catalog"),
        { key: "session.catalog", supported: true }
      ]
    });
  }

  scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> {
    return new Promise((resolve) => {
      this.scans.push({ resolve });
    });
  }
}

function nativeCatalogResult(title: string): NativeSessionCatalogResult {
  return {
    entries: [{
      nativeReference: `catalog://${title}`,
      nativeSessionId: title,
      title,
      workingDirectory: "C:/workspace",
      projectDirectory: "C:/workspace",
      createdAt: 500,
      modifiedAt: 1_000,
      archived: false,
      placement: "project",
      existingMatch: "binding_and_placement"
    }],
    rejectedCount: 0
  };
}

class PortableFakeAdapter extends FakeBackendAdapter {
  readonly importedNativeText: string[] = [];
  portableActivationFailuresRemaining = 0;

  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      id: "portable-fake",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities,
        { key: "session.portable_transfer", supported: true }
      ]
    });
  }

  async exportPortableNativeSession(context: AdapterContext): Promise<PortableNativeSession> {
    if (context.binding === undefined) throw new Error("Portable export requires a binding.");
    const bytes = Buffer.from("{\"type\":\"session\",\"id\":\"portable-native\"}\n", "utf8");
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      nativeSessionId: context.binding.nativeSessionId ?? "portable-native"
    };
  }

  async importPortableNativeSession(
    input: ImportPortableNativeSessionInput,
    signal: AbortSignal
  ): Promise<NativeSessionBinding> {
    if (signal.aborted) throw signal.reason;
    this.importedNativeText.push(Buffer.from(input.bytes).toString("utf8"));
    const nativeSessionId = input.nativeSessionId ?? `portable-native-${this.importedNativeText.length}`;
    return {
      opaqueRef: `fake://${this.id}/portable/${nativeSessionId}`,
      nativeSessionId,
      generation: input.generation
    };
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    if (binding.opaqueRef.includes("/portable/") && this.portableActivationFailuresRemaining > 0) {
      this.portableActivationFailuresRemaining -= 1;
      throw new Error("portable activation unavailable for sk-abcdefghijklmnop");
    }
    return super.resumeSession(binding, context);
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    if (context.binding?.opaqueRef.includes("/portable/") !== true) return { events: [] };
    return {
      events: [fakeHistoryEvent("portable-native-message", "message_assistant", {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "restored history" }]
      })],
      activeEntryId: "portable-native-message"
    };
  }
}

class AsyncGate {
  readonly entered: Promise<void>;
  readonly wait: Promise<void>;
  readonly #markEntered: () => void;
  readonly #release: () => void;

  constructor() {
    let markEntered!: () => void;
    let release!: () => void;
    this.entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    this.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#markEntered = markEntered;
    this.#release = release;
  }

  enter(): void {
    this.#markEntered();
  }

  release(): void {
    this.#release();
  }
}

class GatedNativeSetterFakeAdapter extends FakeBackendAdapter {
  readonly setNameGate = new AsyncGate();
  gateSetName = false;
  setNameCalls = 0;
  closeCalls = 0;

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "gated-native-setter" });
  }

  override async setName(name: string, context: AdapterContext): Promise<void> {
    this.setNameCalls += 1;
    if (this.gateSetName) {
      this.setNameGate.enter();
      await this.setNameGate.wait;
    }
    await super.setName(name, context);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    await super.closeSession(binding, context);
  }
}

class GatedUserShellFakeAdapter extends FakeBackendAdapter {
  readonly inputs: UserShellInput[] = [];
  readonly policySnapshots: PolicySnapshot[] = [];
  abortCount = 0;
  sendCalls = 0;
  #pending: {
    readonly resolve: (result: UserShellResult) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  readonly #startWaiters: Array<() => void> = [];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async executeUserShell(input: UserShellInput, _context: AdapterContext): Promise<UserShellResult> {
    this.inputs.push(input);
    for (const wake of this.#startWaiters.splice(0)) wake();
    return new Promise<UserShellResult>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls += 1;
    await super.send(input, context);
  }

  async setPolicySnapshot(context: AdapterContext): Promise<void> {
    if (context.policySnapshot !== undefined) this.policySnapshots.push(context.policySnapshot);
  }

  override async abortUserShell(_context: AdapterContext): Promise<void> {
    this.abortCount += 1;
    this.complete({ output: "", exitCode: 130, cancelled: true, truncated: false });
  }

  async waitForStart(count = 1): Promise<void> {
    if (this.inputs.length >= count) return;
    await new Promise<void>((resolve) => this.#startWaiters.push(resolve));
    if (this.inputs.length < count) await this.waitForStart(count);
  }

  complete(result: UserShellResult): void {
    const pending = this.#pending;
    if (pending === undefined) throw new Error("No fake user shell is pending.");
    this.#pending = undefined;
    pending.resolve(result);
  }

  fail(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) throw new Error("No fake user shell is pending.");
    this.#pending = undefined;
    pending.reject(error);
  }
}

class SendCountingFakeAdapter extends FakeBackendAdapter {
  sendCalls = 0;

  constructor(profile: FakeAdapterProfile = PI_LIKE_PROFILE) {
    super(profile);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls += 1;
    await super.send(input, context);
  }
}

class GatedWorkspaceRunCapture implements WorkspaceRunCapture {
  readonly beforeRunGate = new AsyncGate();
  readonly abortedRunIds: string[] = [];

  async captureBeforeRun(): Promise<void> {
    this.beforeRunGate.enter();
    await this.beforeRunGate.wait;
  }

  async captureAfterRun(): Promise<void> {}

  abortRun(input: { readonly runId: string }): void {
    this.abortedRunIds.push(input.runId);
  }
}

class GatedTurnOverrideFakeAdapter extends SendCountingFakeAdapter {
  readonly overrideGate = new AsyncGate();
  readonly calls: string[] = [];
  overrideArmed = false;
  permissionOverrideCalls = 0;
  planOverrideCalls = 0;

  constructor() {
    super(MUTABLE_RUNTIME_POLICY_PROFILE);
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    if (!this.overrideArmed) {
      await super.setPermissionMode(mode, context);
      return;
    }
    this.permissionOverrideCalls += 1;
    this.calls.push("permission:start");
    this.overrideGate.enter();
    await this.overrideGate.wait;
    this.calls.push("permission:end");
  }

  override async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    if (this.overrideArmed) {
      this.planOverrideCalls += 1;
      this.calls.push("plan");
    }
    await super.setPlanMode(enabled, context);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.calls.push("send");
    await super.send(input, context);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.calls.push("close");
    await super.closeSession(binding, context);
  }
}

class GatedLifecycleCloseFakeAdapter extends SendCountingFakeAdapter {
  readonly closeGate = new AsyncGate();
  closeArmed = false;
  closeCalls = 0;
  resumeCalls = 0;

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeCalls += 1;
    return super.resumeSession(binding, context);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    if (this.closeArmed) {
      this.closeGate.enter();
      await this.closeGate.wait;
    }
    await super.closeSession(binding, context);
  }
}

class GatedSendingDeletionFakeAdapter extends SendCountingFakeAdapter {
  readonly sendGate = new AsyncGate();
  readonly closeGate = new AsyncGate();
  readonly restoredPermissionModes: PermissionMode[] = [];
  sendArmed = false;
  closeArmed = false;
  closeCalls = 0;

  constructor() {
    super(MUTABLE_RUNTIME_POLICY_PROFILE);
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    if (this.sendArmed) this.restoredPermissionModes.push(mode);
    await super.setPermissionMode(mode, context);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    if (!this.sendArmed) return super.send(input, context);
    this.sendCalls += 1;
    this.sendGate.enter();
    await this.sendGate.wait;
    throw new Error("native send interrupted by task deletion");
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    if (this.closeArmed) {
      this.closeGate.enter();
      await this.closeGate.wait;
    }
    await super.closeSession(binding, context);
  }
}

class ProviderLimitFakeAdapter extends FakeBackendAdapter {
  #calls = 0;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    this.#calls += 1;
    if (this.#calls === 1) {
      await context.emit({
        type: "error",
        terminal: true,
        error: {
          code: "PI_PROVIDER_REQUEST_FAILED",
          message: "The account usage limit has been reached. Try again in 1 h.",
          phase: "stream",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Retry after the Provider limit resets."
        }
      });
      await context.emit({ type: "done", outcome: "failed" });
      return;
    }
    await context.emit({
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        contextTokens: 2,
        contextWindow: 32_000,
        cost: 0
      }
    });
    await context.emit({ type: "done", outcome: "completed" });
  }
}

function hostServiceZeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

class DelegatedUsageFakeAdapter extends FakeBackendAdapter {
  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      id: "delegated-usage-fake",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities,
        { key: "subagents.list", supported: true },
        { key: "subagents.detail", supported: true }
      ]
    });
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    const base = {
      ...portableWorkerRun(context.sessionId, 0),
      id: "delegated-usage-worker",
      logicalAgentId: "delegated-usage-worker",
      route: { providerId: "vision", modelId: "multimodal" }
    };
    const observations = [
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002 },
      { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUsd: 0.005 }
    ] as const;
    for (const [index, usage] of observations.entries()) {
      await context.emit({
        type: "subagent_run",
        run: {
          ...base,
          state: index === observations.length - 1 ? "completed" : "running",
          updatedAt: base.updatedAt + index,
          ...(index === observations.length - 1 ? {} : { endedAt: undefined }),
          usage
        }
      });
    }
    await context.emit({ type: "done", outcome: "completed" });
  }
}

class ScheduleUsageFakeAdapter extends FakeBackendAdapter {
  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities,
        { key: "subagents.list", supported: true },
        { key: "subagents.detail", supported: true }
      ]
    });
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({
      type: "usage",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 20,
        contextTokens: 20,
        contextWindow: 32_000,
        cost: 0.25
      }
    });
    await context.emit({
      type: "subagent_run",
      run: {
        ...portableWorkerRun(context.sessionId, 0),
        id: "schedule-usage-worker",
        logicalAgentId: "schedule-usage-worker",
        route: { providerId: "vision", modelId: "multimodal" },
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0.1 }
      }
    });
    await context.emit({ type: "done", outcome: "completed" });
  }
}

class TokenPricedScheduleUsageFakeAdapter extends FakeBackendAdapter {
  constructor(id = "token-priced-schedule-usage-fake") {
    super({
      ...PI_LIKE_PROFILE,
      id,
      models: PI_LIKE_PROFILE.models.map((model) => model.modelId === "text"
        ? { ...model, cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 } }
        : model)
    });
  }

  override async inspectSession(
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<NativeSessionState> {
    const { usage: _initialUsage, ...state } = await super.inspectSession(binding, context);
    return state;
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({
      type: "usage",
      usage: tokenPricedUsage()
    });
    await context.emit({ type: "done", outcome: "completed" });
  }
}

function tokenPricedUsage() {
  return {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_500_000,
    contextTokens: 1_500_000,
    contextWindow: 2_000_000,
    cost: 0
  };
}

class MessageDeleteFakeAdapter extends FakeBackendAdapter {
  readonly rebuildInputs: ContextRebuildInput[] = [];
  readonly sequence: string[] = [];
  failRebuild = false;
  #closeGate: AsyncGate | undefined;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  holdClose(): AsyncGate {
    const gate = new AsyncGate();
    this.#closeGate = gate;
    return gate;
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    const gate = this.#closeGate;
    this.#closeGate = undefined;
    if (gate !== undefined) {
      gate.enter();
      await gate.wait;
    }
    await super.closeSession(binding, context);
  }

  override async rebuildContext(input: ContextRebuildInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.rebuildInputs.push(input);
    this.sequence.push("rebuild");
    if (this.failRebuild) throw new Error("synthetic context rebuild failure");
    return super.rebuildContext(input, context);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sequence.push(`send:${input.text}`);
    await super.send(input, context);
  }
}

type NativeContextRecoveryBehavior =
  | "context_overflow"
  | "context_overflow_with_output"
  | "prompt_timeout"
  | "success";

class NativeContextRecoveryFakeAdapter extends MessageDeleteFakeAdapter {
  readonly #behaviors: NativeContextRecoveryBehavior[];

  constructor(behaviors: readonly NativeContextRecoveryBehavior[]) {
    super();
    this.#behaviors = [...behaviors];
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    const behavior = this.#behaviors.shift() ?? "success";
    if (behavior === "success") {
      await super.send(input, context);
      return;
    }
    this.sequence.push(`send:${input.text}`);
    if (behavior === "prompt_timeout") {
      throw new JokoError({
        code: "PI_PROMPT_ACCEPTANCE_TIMEOUT",
        message: "The native prompt acceptance deadline expired.",
        phase: "dispatch",
        retryable: false,
        stateMayHaveChanged: true,
        recovery: "Replace the native context before another explicit send."
      });
    }
    await context.emit({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: input.text }]
    });
    if (behavior === "context_overflow_with_output") {
      await context.emit({ type: "text_delta", blockId: "partial-overflow-output", delta: "partial observable answer" });
      await context.emit({
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "partial observable answer" }]
      });
    }
    await context.emit({
      type: "error",
      terminal: true,
      error: {
        code: "CONTEXT_OVERFLOW",
        message: "The provider rejected a request beyond the context window.",
        phase: "stream",
        retryable: false,
        stateMayHaveChanged: true,
        recovery: "Replace the native context before another input."
      }
    });
    await context.emit({ type: "done", outcome: "failed" });
  }
}

class SessionResetFakeAdapter extends FakeBackendAdapter {
  resetCalls = 0;
  failReset = false;
  #resetGate: AsyncGate | undefined;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  holdReset(): AsyncGate {
    const gate = new AsyncGate();
    this.#resetGate = gate;
    return gate;
  }

  override async resetContext(context: AdapterContext): Promise<NativeSessionBinding> {
    this.resetCalls += 1;
    const gate = this.#resetGate;
    this.#resetGate = undefined;
    if (gate !== undefined) {
      gate.enter();
      await gate.wait;
    }
    if (this.failReset) throw new Error("synthetic context reset failure");
    return super.resetContext(context);
  }
}

class RuntimeCommandsFakeAdapter extends FakeBackendAdapter {
  commands: readonly RuntimeCommand[];
  failNextCommands = false;
  #commandsGate: AsyncGate | undefined;

  constructor(commands: readonly RuntimeCommand[]) {
    super(PI_LIKE_PROFILE);
    this.commands = commands;
  }

  holdNextCommands(): AsyncGate {
    const gate = new AsyncGate();
    this.#commandsGate = gate;
    return gate;
  }

  override async getCommands(_context: AdapterContext): Promise<readonly RuntimeCommand[]> {
    const gate = this.#commandsGate;
    this.#commandsGate = undefined;
    if (gate !== undefined) {
      gate.enter();
      await gate.wait;
    }
    if (this.failNextCommands) {
      this.failNextCommands = false;
      throw new Error("runtime command discovery failed");
    }
    return this.commands;
  }
}

class RuntimeToolsFakeAdapter extends FakeBackendAdapter {
  readonly catalog: RuntimeToolCatalog = {
    runtimeGeneration: 1,
    observedAt: 1_234,
    tools: [{
      name: "search",
      description: "Search",
      inputSchema: { fields: [], allowsAdditionalFields: false },
      promptGuidelines: [],
      active: true,
      sourceInfo: { path: "search.ts", source: "search", scope: "project", origin: "top-level" }
    }]
  };
  readonly contexts: Array<{ readonly sessionId: string; readonly generation: number }> = [];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  async getRuntimeTools(context: AdapterContext): Promise<RuntimeToolCatalog> {
    this.contexts.push({ sessionId: context.sessionId, generation: context.generation });
    return this.catalog;
  }
}

class ImmediateTerminalFakeAdapter extends FakeBackendAdapter {
  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit(
      { type: "done", outcome: "completed" },
      {
        namespace: "pi.extension_command",
        fields: { command: "synchronous-extension" },
        pi: {
          rpcEventType: "extension_command_completed",
          payload: {
            case: "diagnostic",
            value: { command: "unknown", nativeEventType: "extension_command_completed" }
          }
        }
      }
    );
  }
}

class QuoteGateFakeAdapter extends FakeBackendAdapter {
  readonly #messages: Array<{ readonly id: string; readonly text: string }> = [];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    const id = `quote-entry-${this.#messages.length + 1}`;
    this.#messages.push({ id, text: input.text });
    await context.emit({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: input.text }]
    }, quoteGateMetadata(id));
    await context.emit({ type: "done", outcome: "completed" });
  }

  async getNativeHistoryProjection(_context: AdapterContext): Promise<NativeHistoryProjection> {
    const activeEntryId = this.#messages.at(-1)?.id;
    return {
      events: this.#messages.map(({ id, text }) => ({
        nativeEntryId: id,
        projectionKind: "message_user",
        contentIndex: 0,
        payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text }] },
        metadata: quoteGateMetadata(id)
      })),
      ...(activeEntryId === undefined ? {} : { activeEntryId })
    };
  }
}

function quoteGateMetadata(entryId: string): import("@joko/core").AdapterEventMetadata {
  return {
    namespace: "pi.message",
    fields: { nativeEntryId: entryId },
    pi: {
      rpcEventType: "message_end",
      entryId,
      contentIndex: 0,
      payload: {
        case: "messageLifecycle",
        value: {
          kind: "message_end",
          nativeMessageId: entryId,
          nativeEntryId: entryId,
          parentEntryId: "",
          role: "user",
          contentIndex: 0
        }
      }
    }
  };
}

class SingleSettlementFakeAdapter extends FakeBackendAdapter {
  readonly #lifecycles = new Map<string, {
    readonly prompt: AdapterContext;
    readonly steering: AdapterContext[];
    readonly followUps: AdapterContext[];
  }>();
  nativeSettlements = 0;
  failNextSteerUncertain = false;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    if (input.disposition === "prompt") {
      if (this.#lifecycles.has(context.sessionId)) throw continuationError("PI_PROMPT_REQUIRES_IDLE_RUNTIME");
      this.#lifecycles.set(context.sessionId, { prompt: context, steering: [], followUps: [] });
      return;
    }
    const lifecycle = this.#lifecycles.get(context.sessionId);
    if (lifecycle === undefined) {
      throw continuationError(input.disposition === "steer"
        ? "PI_STEER_REQUIRES_ACTIVE_RUN"
        : "PI_FOLLOW_UP_REQUIRES_ACTIVE_RUN");
    }
    if (input.disposition === "steer") {
      lifecycle.steering.push(context);
      if (this.failNextSteerUncertain) {
        this.failNextSteerUncertain = false;
        throw continuationError("PI_STEER_DISPATCH_UNKNOWN", true);
      }
    } else lifecycle.followUps.push(context);
  }

  override async abort(context: AdapterContext): Promise<void> {
    await this.finish(context.sessionId, "aborted", false);
  }

  async emitAcceptedUserMessages(sessionId: string): Promise<void> {
    const lifecycle = this.#lifecycles.get(sessionId);
    if (lifecycle === undefined) throw new Error("No active continuation lifecycle.");
    const participants = [
      { context: lifecycle.prompt, text: "initial" },
      ...lifecycle.steering.map((context) => ({ context, text: "steer" })),
      ...lifecycle.followUps.map((context) => ({ context, text: "follow" }))
    ];
    for (const participant of participants) {
      await participant.context.emit({
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: participant.text }]
      });
    }
  }

  async settle(sessionId: string, outcome: "completed" | "failed" = "completed"): Promise<void> {
    await this.finish(sessionId, outcome, true);
  }

  private async finish(
    sessionId: string,
    outcome: "completed" | "aborted" | "failed",
    emitOutput: boolean
  ): Promise<void> {
    const lifecycle = this.#lifecycles.get(sessionId);
    if (lifecycle === undefined) throw new Error("No active continuation lifecycle.");
    this.#lifecycles.delete(sessionId);
    this.nativeSettlements += 1;
    if (emitOutput) {
      await lifecycle.prompt.emit({ type: "text_delta", blockId: "prompt-1", delta: "native-response-1" });
      await lifecycle.prompt.emit({ type: "text_delta", blockId: "prompt-2", delta: "native-response-2" });
      for (const followUp of lifecycle.followUps) {
        await followUp.emit({ type: "text_delta", blockId: "follow-up", delta: "native-response-3" });
      }
    }
    for (const participant of [lifecycle.prompt, ...lifecycle.steering, ...lifecycle.followUps]) {
      await participant.emit({ type: "run_state", state: outcome });
      await participant.emit({ type: "done", outcome });
    }
  }
}

type FakeCompactionOutcome = "completed" | "failed" | "aborted";

class CompactionQueueFakeAdapter extends SingleSettlementFakeAdapter {
  readonly sentDispositions: PromptInput["disposition"][] = [];
  readonly manualCompactionStarted: Promise<void>;
  manualCompactionCalls = 0;
  compactingInspections = 0;
  readonly #contexts = new Map<string, AdapterContext>();
  readonly #compacting = new Set<string>();
  readonly #manualGate = new AsyncGate();
  #manualOutcome: FakeCompactionOutcome = "completed";
  #compactionHistoryReady = false;

  constructor() {
    super();
    this.manualCompactionStarted = this.#manualGate.entered;
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    const binding = await super.createSession(input, context);
    this.#contexts.set(context.sessionId, { ...context, binding });
    return binding;
  }

  override async inspectSession(
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<NativeSessionState> {
    this.#contexts.set(context.sessionId, context);
    const state = await super.inspectSession(binding, context);
    const compacting = this.#compacting.has(context.sessionId);
    if (compacting) this.compactingInspections += 1;
    return { ...state, compacting };
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.#contexts.set(context.sessionId, context);
    const extensionCommand = input.text.trim() === "/extension";
    if (this.#compacting.has(context.sessionId) && !extensionCommand) {
      throw new Error("Fake Backend received input during compaction.");
    }
    this.sentDispositions.push(input.disposition);
    if (extensionCommand) {
      await context.emit({ type: "done", outcome: "completed" });
      return;
    }
    await super.send(input, context);
  }

  async dispatchDuringCompaction(
    input: PromptInput,
    _context: AdapterContext
  ): Promise<PromptInput["disposition"] | undefined> {
    return input.text.trim() === "/extension" ? "prompt" : undefined;
  }

  override async compact(
    _customInstructions: string | undefined,
    context: AdapterContext
  ): Promise<"compacted"> {
    this.manualCompactionCalls += 1;
    const compactionId = `manual-compaction-${this.manualCompactionCalls}`;
    this.#contexts.set(context.sessionId, context);
    this.#compacting.add(context.sessionId);
    await context.emit({ type: "compaction", compactionId, state: "started", reason: "manual" });
    this.#manualGate.enter();
    await this.#manualGate.wait;
    this.#compacting.delete(context.sessionId);
    this.#compactionHistoryReady = this.#manualOutcome === "completed";
    await context.emit({
      type: "compaction",
      compactionId,
      state: this.#manualOutcome,
      reason: "manual",
      ...(this.#manualOutcome === "completed" ? { summary: "Fake compacted context" } : {})
    });
    if (this.#manualOutcome === "completed") return "compacted";
    const error = new Error(this.#manualOutcome === "aborted" ? "Compaction cancelled" : "Compaction failed");
    if (this.#manualOutcome === "aborted") error.name = "AbortError";
    throw error;
  }

  async getNativeHistoryProjection(_context: AdapterContext): Promise<NativeHistoryProjection> {
    if (!this.#compactionHistoryReady) return { events: [] };
    return {
      events: [fakeHistoryEvent("native-manual-compaction", "compaction", {
        type: "compaction",
        compactionId: "native-manual-compaction",
        state: "completed",
        reason: "manual",
        summary: "Persisted fake compacted context"
      })],
      activeEntryId: "native-manual-compaction"
    };
  }

  finishManualCompaction(outcome: FakeCompactionOutcome): void {
    this.#manualOutcome = outcome;
    this.#manualGate.release();
  }

  forceNativeCompaction(sessionId: string): void {
    this.#compacting.add(sessionId);
  }

  async beginNativeCompaction(sessionId: string): Promise<void> {
    this.#compacting.add(sessionId);
    await this.context(sessionId).emit({
      type: "compaction",
      compactionId: `automatic-compaction-${sessionId}`,
      state: "started",
      reason: "automatic"
    });
  }

  endNativeCompactionState(sessionId: string): void {
    this.#compacting.delete(sessionId);
  }

  async finishNativeCompaction(sessionId: string, willRetry = false): Promise<void> {
    this.#compacting.delete(sessionId);
    await this.context(sessionId).emit({
      type: "compaction",
      compactionId: `automatic-compaction-${sessionId}`,
      state: "completed",
      reason: "automatic",
      summary: "Fake automatic compacted context",
      willRetry
    });
  }

  private context(sessionId: string): AdapterContext {
    const context = this.#contexts.get(sessionId);
    if (context === undefined) throw new Error("No fake compaction context is available.");
    return context;
  }
}

class GatedCompactionQueueFakeAdapter extends CompactionQueueFakeAdapter {
  readonly extensionClassificationStarted: Promise<void>;
  readonly #extensionClassificationGate = new AsyncGate();

  constructor() {
    super();
    this.extensionClassificationStarted = this.#extensionClassificationGate.entered;
  }

  override async dispatchDuringCompaction(
    input: PromptInput,
    context: AdapterContext
  ): Promise<PromptInput["disposition"] | undefined> {
    if (input.text.trim() === "/extension") {
      this.#extensionClassificationGate.enter();
      await this.#extensionClassificationGate.wait;
    }
    return super.dispatchDuringCompaction(input, context);
  }

  releaseExtensionClassification(): void {
    this.#extensionClassificationGate.release();
  }
}

function continuationError(code: string, stateMayHaveChanged = false): JokoError {
  return new JokoError({
    code,
    message: code,
    phase: "dispatch",
    retryable: stateMayHaveChanged,
    stateMayHaveChanged,
    recovery: stateMayHaveChanged ? "Reconcile the native lifecycle." : "Submit a new prompt."
  });
}

class InteractionFakeAdapter extends FakeBackendAdapter {
  decision: InteractionDecision | undefined;

  constructor(private readonly interaction: InteractionPayload) {
    super(MUTABLE_RUNTIME_POLICY_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    this.decision = await context.requestInteraction(this.interaction);
    await context.emit({ type: "done", outcome: "completed" });
  }
}

class AdapterCancellationInteractionFake extends FakeBackendAdapter {
  decision: InteractionDecision | undefined;
  readonly #interactionAbort = new AbortController();

  constructor() {
    super(MUTABLE_RUNTIME_POLICY_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    this.decision = await context.requestInteraction({
      id: "backend-cancelled-native-interaction",
      kind: "permission",
      title: "Run native command?",
      toolName: "native-command",
      summary: "The native Backend may cancel this request independently.",
      risk: "medium",
      choices: ["allow", "deny"]
    }, { signal: this.#interactionAbort.signal });
    await context.emit({ type: "done", outcome: "completed" });
  }

  cancelNativeInteraction(): void {
    this.#interactionAbort.abort();
  }
}

class RunSilenceFakeAdapter extends FakeBackendAdapter {
  abortCalls = 0;
  closeCalls = 0;
  abortLeavesRuntimeBusy = false;
  #context: AdapterContext | undefined;

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "run-silence-fake", streamDelayMs: 60_000 });
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.#context = context;
    await super.send(input, context);
  }

  override async abort(context: AdapterContext): Promise<void> {
    this.abortCalls += 1;
    if (this.abortLeavesRuntimeBusy) return;
    await super.abort(context);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    await super.closeSession(binding, context);
  }

  async heartbeat(): Promise<void> {
    await this.context().emit({ type: "status", key: "long-tool-heartbeat", text: "running" });
  }

  requestExplicitInteraction(id: string): void {
    void this.context().requestInteraction({
      id,
      kind: "question",
      title: "Continue?",
      prompt: "Waiting for an explicit decision.",
      fields: []
    });
  }

  async emitBackgroundTask(state: "running" | "completed"): Promise<void> {
    await this.context().emit({
      type: "background_task",
      taskId: "long-background-task",
      title: "Long background task",
      state,
      ...(state === "completed" ? { endedAt: Date.now() } : {})
    });
  }

  private context(): AdapterContext {
    if (this.#context === undefined) throw new Error("No accepted Run context is available.");
    return this.#context;
  }
}

class PiStateFakeAdapter extends FakeBackendAdapter {
  failInspections = false;
  failSessionId: string | undefined;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    if (this.failInspections || this.failSessionId === context.sessionId) {
      throw new Error("native state unavailable");
    }
    const state = await super.inspectSession(binding, context);
    return {
      ...state,
      pi: {
        nativeSessionId: state.binding.nativeSessionId ?? context.sessionId,
        nativeSessionName: "task sk-abcdefghijklmnop",
        nativeSessionFileDisplay: "D:\\service-secret\\native.jsonl",
        model: { providerId: state.providerId ?? "provider", modelId: state.modelId ?? "model" },
        thinkingLevel: state.effort ?? "medium",
        streaming: state.streaming,
        compacting: state.compacting,
        steeringMode: "one_at_a_time",
        followUpMode: "one_at_a_time",
        autoCompaction: true,
        autoRetry: true,
        messageCount: 2,
        pendingMessageCount: state.pendingMessages,
        activeLeafId: "leaf-current"
      }
    };
  }
}

class TitleFakeAdapter extends FakeBackendAdapter {
  #capturedContext: AdapterContext | undefined;

  constructor(private readonly title: string) {
    super(PI_LIKE_PROFILE);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.#capturedContext = context;
    await context.emit({ type: "status", key: "pi.extension.title", text: this.title });
    await super.send(input, context);
  }

  async emitCapturedTitle(title: string): Promise<void> {
    if (this.#capturedContext === undefined) throw new Error("No Adapter context was captured.");
    await this.#capturedContext.emit({ type: "status", key: "pi.extension.title", text: title });
  }
}

class BlankNativeRecoveryFakeAdapter extends FakeBackendAdapter {
  readonly #nativeEpoch = randomUUID();
  failResumeWithoutSideEffects = false;
  readonly createInputs: CreateNativeSessionInput[] = [];
  readonly createContexts: AdapterContext[] = [];
  readonly createdBindings: NativeSessionBinding[] = [];
  readonly closedBindings: NativeSessionBinding[] = [];
  readonly planSelections: Array<{ readonly sessionId: string; readonly enabled: boolean }> = [];
  historyReads = 0;
  throwOnHistoryRead = false;

  constructor() {
    super(BLANK_NATIVE_RECOVERY_PROFILE);
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.createInputs.push(input);
    this.createContexts.push(context);
    const binding = await super.createSession(input, context);
    const mutable = binding as { opaqueRef: string; nativeSessionId?: string };
    mutable.opaqueRef = `${binding.opaqueRef}/${this.#nativeEpoch}/${this.createInputs.length}`;
    mutable.nativeSessionId = randomUUID();
    this.createdBindings.push({ ...binding });
    return binding;
  }

  override async resumeSession(
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<NativeSessionState> {
    if (this.failResumeWithoutSideEffects) {
      throw new JokoError({
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        message: "The blank native task was not materialized before runtime loss.",
        phase: "session_resume",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Recreate only when the durable blank-task authority still permits it."
      });
    }
    return super.resumeSession(binding, context);
  }

  override async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    this.planSelections.push({ sessionId: context.sessionId, enabled });
    await super.setPlanMode(enabled, context);
  }

  async getNativeHistoryProjection(_context: AdapterContext): Promise<NativeHistoryProjection> {
    this.historyReads += 1;
    if (this.throwOnHistoryRead) {
      throw new Error("Blank native runtime history is unavailable before its first accepted input.");
    }
    return { events: [] };
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closedBindings.push({ ...binding });
    await super.closeSession(binding, context);
  }
}

class ResumeCountingFakeAdapter extends FakeBackendAdapter {
  resumeCalls = 0;
  detachCalls = 0;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext) {
    this.resumeCalls += 1;
    return super.resumeSession(binding, context);
  }

  override async detachSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.detachCalls += 1;
    await super.detachSession(binding, context);
  }
}

class GatedResumeFakeAdapter extends FakeBackendAdapter {
  readonly resumeGate = new AsyncGate();
  readonly resumeContexts: AdapterContext[] = [];

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "gated-resume-instance" });
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeContexts.push(context);
    this.resumeGate.enter();
    await this.resumeGate.wait;
    return super.resumeSession(binding, context);
  }
}

class UnsupportedResumeControlsFakeAdapter extends FakeBackendAdapter {
  resumeCalls = 0;
  readonly unsupportedControlCalls: string[] = [];

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "unsupported-resume-controls" });
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext) {
    this.resumeCalls += 1;
    return super.resumeSession(binding, context);
  }

  override async setFastMode(_enabled: boolean, _context: AdapterContext): Promise<void> {
    this.unsupportedControlCalls.push("model.fast_mode");
    throw new Error("Unsupported fast mode setter must not be called.");
  }

  override async setPermissionMode(_mode: PermissionMode, _context: AdapterContext): Promise<void> {
    this.unsupportedControlCalls.push("permission.change");
    throw new Error("Unsupported permission setter must not be called.");
  }
}

class SwitchWithoutFastFakeAdapter extends FakeBackendAdapter {
  readonly modelSelections: Array<{ readonly providerId: string; readonly modelId: string }> = [];
  readonly effortSelections: string[] = [];
  readonly unsupportedControlCalls: string[] = [];
  readonly modelContexts: AdapterContext[] = [];
  readonly permissionContexts: AdapterContext[] = [];
  closeCalls = 0;
  resumeCalls = 0;

  constructor(profile: FakeAdapterProfile) {
    super(profile);
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeCalls += 1;
    return super.resumeSession(binding, context);
  }

  override async setModel(providerId: string, modelId: string, context: AdapterContext) {
    this.modelSelections.push({ providerId, modelId });
    this.modelContexts.push(context);
    return super.setModel(providerId, modelId, context);
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    this.permissionContexts.push(context);
    await super.setPermissionMode(mode, context);
  }

  override async setEffort(level: string, context: AdapterContext): Promise<void> {
    this.effortSelections.push(level);
    if (this.profile.capabilities.find((capability) => capability.key === "model.effort")?.supported !== true) {
      this.unsupportedControlCalls.push("model.effort");
      throw new Error("Unsupported effort setter must not be called.");
    }
    await super.setEffort(level, context);
  }

  override async setFastMode(_enabled: boolean, _context: AdapterContext): Promise<void> {
    this.unsupportedControlCalls.push("model.fast_mode");
    throw new Error("Unsupported Fast Mode setter must not be called.");
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    await super.closeSession(binding, context);
  }
}

class FailingResumeControlFakeAdapter extends FakeBackendAdapter {
  closeCalls = 0;
  failFastRestore = false;

  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      id: "failing-resume-control",
      capabilities: PI_LIKE_PROFILE.capabilities.map((capability) =>
        capability.key === "model.fast_mode" ? { key: capability.key, supported: true } : capability),
      models: PI_LIKE_PROFILE.models.map((model) => ({ ...model, supportsFastMode: true }))
    });
  }

  override async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    if (this.failFastRestore) throw new Error("resume Fast restore failed");
    await super.setFastMode(enabled, context);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.closeCalls += 1;
    await super.closeSession(binding, context);
  }
}

class DetachedSubagentControlFakeAdapter extends FakeBackendAdapter {
  readonly controls: Array<{ readonly input: SubagentControlInput; readonly operationId?: string }> = [];
  resumeCalls = 0;
  failOnResume = false;

  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      id: "detached-subagent-control",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities,
        { key: "subagents.list", supported: true },
        { key: "subagents.detail", supported: true },
        { key: "subagents.transcript", supported: true },
        { key: "subagents.stop", supported: true },
        { key: "subagents.steer", supported: true },
        { key: "subagents.follow_up", supported: true },
        { key: "subagents.resume", supported: true }
      ]
    });
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeCalls += 1;
    if (this.failOnResume) throw new Error("parent runtime must not be activated for detached control");
    return super.resumeSession(binding, context);
  }

  supportsDetachedSubagentControl(action: SubagentControlInput["action"]): boolean {
    return action !== "resume";
  }

  async controlSubagent(input: SubagentControlInput, context: AdapterContext): Promise<void> {
    this.controls.push({ input, ...(context.operationId === undefined ? {} : { operationId: context.operationId }) });
  }
}

class DetachedSubagentObservationFakeAdapter extends FakeBackendAdapter {
  readonly observations: Array<{ readonly sessionId: string; readonly generation: number }> = [];
  readonly backendInstanceGenerations: number[] = [];
  resumeCalls = 0;
  failObservationSessionId: string | undefined;

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "detached-subagent-observation" });
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeCalls += 1;
    return super.resumeSession(binding, context);
  }

  async observeDetachedSubagents(context: AdapterContext): Promise<void> {
    this.observations.push({ sessionId: context.sessionId, generation: context.generation });
    this.backendInstanceGenerations.push(context.backendInstanceGeneration!);
    if (context.sessionId === this.failObservationSessionId) throw new Error("observer reconciliation failed");
  }
}

class DetachedSessionDeletionFakeAdapter extends FakeBackendAdapter {
  readonly deletions: Array<{ readonly binding: NativeSessionBinding; readonly sessionId: string }> = [];
  resumeCalls = 0;
  failOnResume = false;

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "detached-session-deletion" });
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeCalls += 1;
    if (this.failOnResume) throw new Error("parent runtime must not be activated for detached deletion");
    return super.resumeSession(binding, context);
  }

  supportsDetachedSessionDeletion(): boolean {
    return true;
  }

  override async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.deletions.push({ binding, sessionId: context.sessionId });
    await super.deleteSession(binding, context);
  }
}

class PersonalizationPromptFakeAdapter extends FakeBackendAdapter {
  readonly createInputs: CreateNativeSessionInput[] = [];
  readonly createContexts: AdapterContext[] = [];
  readonly resumeContexts: AdapterContext[] = [];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.createInputs.push(input);
    this.createContexts.push(context);
    return super.createSession(input, context);
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeContexts.push(context);
    return super.resumeSession(binding, context);
  }
}

class BackgroundTaskRuntimeFakeAdapter extends ResumeCountingFakeAdapter {
  #context: AdapterContext | undefined;

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    const binding = await super.createSession(input, context);
    this.#context = context;
    return binding;
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext) {
    const state = await super.resumeSession(binding, context);
    this.#context = context;
    return state;
  }

  async emitBackgroundTask(
    payload: Omit<Extract<EventPayload, { readonly type: "background_task" }>, "type">
  ): Promise<void> {
    await this.emitPayload({ type: "background_task", ...payload });
  }

  async emitPayload(payload: EventPayload): Promise<void> {
    if (this.#context === undefined) throw new Error("No Adapter context was captured.");
    await this.#context.emit(payload);
  }
}

class BackgroundTaskCancellationFakeAdapter extends BackgroundTaskRuntimeFakeAdapter {
  readonly cancellations: Array<{
    readonly taskId: string;
    readonly sessionId: string;
    readonly generation: number;
  }> = [];
  failure: Error | undefined;

  override async describe() {
    const descriptor = await super.describe();
    const capabilities = new Map(descriptor.capabilities);
    capabilities.set("background.tasks.cancel", {
      key: "background.tasks.cancel",
      supported: true
    });
    return { ...descriptor, capabilities };
  }

  async cancelBackgroundTask(context: AdapterContext, taskId: string): Promise<void> {
    this.cancellations.push({
      taskId,
      sessionId: context.sessionId,
      generation: context.generation
    });
    if (this.failure !== undefined) throw this.failure;
    await context.emit({
      type: "background_task",
      taskId,
      title: "Cancelled background task",
      state: "cancelled",
      endedAt: Date.now()
    });
  }
}

class SettingsTrackingFakeAdapter extends ResumeCountingFakeAdapter {
  readonly autoCompactionUpdates: Array<{ readonly sessionId: string; readonly enabled: boolean }> = [];
  readonly autoRetryUpdates: Array<{ readonly sessionId: string; readonly enabled: boolean }> = [];

  override async setAutoCompaction(enabled: boolean, context: AdapterContext): Promise<void> {
    this.autoCompactionUpdates.push({ sessionId: context.sessionId, enabled });
  }

  override async setAutoRetry(enabled: boolean, context: AdapterContext): Promise<void> {
    this.autoRetryUpdates.push({ sessionId: context.sessionId, enabled });
  }
}

class ClampingModelFakeAdapter extends FakeBackendAdapter {
  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async setModel(providerId: string, modelId: string, context: AdapterContext) {
    const model = await super.setModel(providerId, modelId, context);
    if (providerId === "vision" && modelId === "multimodal") await super.setEffort("low", context);
    return model;
  }
}

class DisposeTrackingFakeAdapter extends FakeBackendAdapter {
  disposeCalls = 0;

  constructor(id: string, private readonly failure?: Error) {
    super({ ...PI_LIKE_PROFILE, id, displayName: id });
  }

  override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.failure !== undefined) throw this.failure;
    await super.dispose();
  }
}

class GatedFakeAdapter extends FakeBackendAdapter {
  createCalls = 0;
  forkCalls = 0;
  failCreates = false;
  forkEditorText: string | undefined;
  forkFailure: Error | undefined;
  #createGate: AsyncGate | undefined;
  #forkGate: AsyncGate | undefined;

  constructor(profile: FakeAdapterProfile = PI_LIKE_PROFILE) {
    super(profile);
  }

  holdCreate(): AsyncGate {
    const gate = new AsyncGate();
    this.#createGate = gate;
    return gate;
  }

  holdFork(): AsyncGate {
    const gate = new AsyncGate();
    this.#forkGate = gate;
    return gate;
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.createCalls += 1;
    const gate = this.#createGate;
    this.#createGate = undefined;
    if (gate !== undefined) {
      gate.enter();
      await gate.wait;
    }
    const binding = await super.createSession(input, context);
    if (this.failCreates) throw new Error("native create failed after changing native state");
    return binding;
  }

  override async fork(entryId: string, context: AdapterContext): Promise<NativeSessionForkResult> {
    this.forkCalls += 1;
    const gate = this.#forkGate;
    this.#forkGate = undefined;
    if (gate !== undefined) {
      gate.enter();
      await gate.wait;
    }
    if (this.forkFailure !== undefined) throw this.forkFailure;
    const result = await super.fork(entryId, context);
    return this.forkEditorText === undefined ? result : { ...result, editorText: this.forkEditorText };
  }
}

class ManagedAttachFakeAdapter extends GatedFakeAdapter {
  history: NativeHistoryProjection = { events: [] };
  historyFailure: Error | undefined;
  readonly historyContexts: AdapterContext[] = [];

  override async resolveNativeSessionReference(
    nativeReference: string,
    _target: import("@joko/core").TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding> {
    return { opaqueRef: nativeReference, nativeSessionId: "managed-native", generation };
  }

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    await super.createSession(input, context);
    return input.nativeStart?.kind === "attach"
      ? { opaqueRef: input.nativeStart.nativeReference, nativeSessionId: "managed-native", generation: context.generation }
      : { opaqueRef: `managed://${context.sessionId}`, nativeSessionId: context.sessionId, generation: context.generation };
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    this.historyContexts.push(context);
    if (this.historyFailure !== undefined) throw this.historyFailure;
    return this.history;
  }

  override async navigateTree(entryId: string, _summarize: boolean, _context: AdapterContext): Promise<void> {
    this.history = { ...this.history, activeEntryId: entryId };
  }
}

class ObservedAttachFakeAdapter extends ManagedAttachFakeAdapter {
  attachedCreateInput: CreateNativeSessionInput | undefined;
  reportDifferentBinding = false;

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.attachedCreateInput = input;
    return super.createSession(input, context);
  }

  override async inspectSession(
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<NativeSessionState> {
    const state = await super.inspectSession(binding, context);
    return {
      ...state,
      binding: this.reportDifferentBinding
        ? { ...state.binding, opaqueRef: "managed://different-runtime" }
        : state.binding,
      providerId: "vision",
      modelId: "multimodal",
      effort: undefined,
      fastMode: false,
      permissionMode: "auto",
      planMode: false
    };
  }
}

class CatalogImportFakeAdapter extends ObservedAttachFakeAdapter {
  catalogEntry: NativeSessionCatalogEntry | undefined;
  additionalCatalogEntries: readonly NativeSessionCatalogEntry[] = [];
  catalogBindingCalls = 0;

  override async describe(): Promise<import("@joko/core").BackendDescriptor> {
    const descriptor = await super.describe();
    return {
      ...descriptor,
      health: "unavailable",
      installationState: "not_installed",
      authenticationState: "signed_out",
      capabilities: new Map([
        ...descriptor.capabilities,
        ["session.resume", { key: "session.resume", supported: false, reason: "upstream_missing" }],
        ["session.catalog", { key: "session.catalog", supported: true }]
      ])
    };
  }

  async scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> {
    return {
      entries: this.catalogEntry === undefined
        ? this.additionalCatalogEntries
        : [this.catalogEntry, ...this.additionalCatalogEntries],
      rejectedCount: 0
    };
  }

  async bindCatalogSession(
    entry: NativeSessionCatalogEntry,
    generation: number
  ): Promise<NativeSessionBinding> {
    this.catalogBindingCalls += 1;
    return {
      opaqueRef: entry.nativeReference,
      ...(entry.nativeSessionId === undefined ? {} : { nativeSessionId: entry.nativeSessionId }),
      generation
    };
  }
}

class ToolImageHistoryFakeAdapter extends FakeBackendAdapter {
  #sent = false;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    const sourcePath = join(context.target.workspaceRoot, "pi-tool-image.png");
    writeFileSync(sourcePath, "stable tool image bytes");
    const image = await context.storeArtifact(sourcePath, { fileName: "pi-tool-image.png", mimeType: "image/png" });
    this.#sent = true;
    await context.emit({
      type: "tool_result",
      callId: "read-image",
      name: "read",
      output: "Image Size: 16x16.",
      parts: [
        { kind: "text", text: "Image Size: 16x16." },
        { kind: "image", blob: image, alt: "preview" }
      ],
      isError: false
    });
    await context.emit({ type: "done", outcome: "completed" });
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    if (!this.#sent) return { events: [] };
    const sourcePath = join(context.target.workspaceRoot, "pi-tool-image.png");
    const image = await context.storeArtifact(sourcePath, { fileName: "pi-tool-image.png", mimeType: "image/png" });
    return {
      events: [fakeHistoryEvent("native-tool-image", "tool_result", {
        type: "tool_result",
        callId: "read-image",
        name: "read",
        output: "Image Size: 16x16.",
        parts: [
          { kind: "text", text: "Image Size: 16x16." },
          { kind: "image", blob: image, alt: "preview" }
        ],
        isError: false
      })],
      activeEntryId: "native-tool-image"
    };
  }

  override async navigateTree(_entryId: string, _summarize: boolean, _context: AdapterContext): Promise<void> {}
}

class PolicyFakeAdapter extends FakeBackendAdapter {
  currentPolicy = {
    providerId: "test",
    modelId: "text",
    effort: "medium",
    fastMode: false,
    permissionMode: "ask" as PermissionMode,
    planMode: false,
    extraDirectoryIds: [] as string[]
  };
  readonly sentPolicies: Array<typeof this.currentPolicy & { text: string }> = [];

  constructor() {
    super({
      ...MUTABLE_RUNTIME_POLICY_PROFILE,
      streamDelayMs: 40,
      capabilities: [
        ...MUTABLE_RUNTIME_POLICY_PROFILE.capabilities.map((capability) =>
          capability.key === "model.fast_mode" ? { key: capability.key, supported: true } : capability),
        { key: "workspace.extra_dirs", supported: true, options: ["read_write"] }
      ],
      models: PI_LIKE_PROFILE.models.map((model) => ({ ...model, supportsFastMode: true }))
    });
  }

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.currentPolicy = {
      providerId: input.providerId ?? "test",
      modelId: input.modelId ?? "text",
      effort: input.effort ?? "medium",
      fastMode: input.fastMode,
      permissionMode: input.permissionMode,
      planMode: false,
      extraDirectoryIds: context.extraDirectories?.map((directory) => directory.id) ?? []
    };
    return super.createSession(input, context);
  }

  override async setModel(providerId: string, modelId: string, context: AdapterContext) {
    this.currentPolicy.providerId = providerId;
    this.currentPolicy.modelId = modelId;
    return super.setModel(providerId, modelId, context);
  }

  override async setEffort(level: string, context: AdapterContext): Promise<void> {
    this.currentPolicy.effort = level;
    await super.setEffort(level, context);
  }

  override async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    this.currentPolicy.fastMode = enabled;
    await super.setFastMode(enabled, context);
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    this.currentPolicy.permissionMode = mode;
    await super.setPermissionMode(mode, context);
  }

  override async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    this.currentPolicy.planMode = enabled;
    await super.setPlanMode(enabled, context);
  }

  async setExtraDirectories(directories: readonly ApprovedDirectory[], _context: AdapterContext): Promise<void> {
    this.currentPolicy.extraDirectoryIds = directories.map((directory) => directory.id);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sentPolicies.push({ ...this.currentPolicy, extraDirectoryIds: [...this.currentPolicy.extraDirectoryIds], text: input.text });
    await super.send(input, context);
  }
}

class ExtraDirectoryContextFakeAdapter extends FakeBackendAdapter {
  readonly createdWithExtraDirectoryIds: string[][] = [];
  readonly liveExtraDirectoryIds: string[][] = [];

  constructor() {
    super({ ...MINIMAL_PROFILE, id: "extra-directory-disabled" });
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.createdWithExtraDirectoryIds.push(context.extraDirectories?.map((directory) => directory.id) ?? []);
    return super.createSession(input, context);
  }

  async setExtraDirectories(directories: readonly ApprovedDirectory[], _context: AdapterContext): Promise<void> {
    this.liveExtraDirectoryIds.push(directories.map((directory) => directory.id));
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition did not become true in time.");
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
