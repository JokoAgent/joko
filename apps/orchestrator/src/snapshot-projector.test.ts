import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NotFoundError, OperationalStore } from "@joko/store";
import { AuthenticationState, BackgroundTaskState, CapabilitySupport, ProviderKind, ProviderLoginMethod, type SnapshotScope } from "@joko/contracts";

import { ProtoMappingError, toProtoProviderDescriptor, toProtoServerInfo } from "./proto-mapper.js";
import { EXTENSION_STATUSES_SETTING_KEY, EXTENSION_WIDGETS_SETTING_KEY } from "./extension-ui-state.js";
import { NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD } from "./native-history.js";
import { nativeBindingFingerprint } from "./native-state-observation.js";
import { SnapshotProjector } from "./snapshot-projector.js";
import { runtimeCommandsObservation, SESSION_RUNTIME_COMMANDS_SETTING_KEY } from "./runtime-command-state.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("SnapshotProjector", () => {
  it("projects Provider access and upstream pricing capability without Backend-ID branching", () => {
    const provider = toProtoProviderDescriptor(
      "backend-one",
      "provider-one",
      "openai-responses",
      true,
      2n,
      2_000,
      { accessKind: "subscription", providesModelPricing: false }
    );

    expect(provider.kind).toBe(ProviderKind.SUBSCRIPTION);
    expect(provider.capabilities?.capabilities).toContainEqual(expect.objectContaining({
      name: "model.pricing",
      support: CapabilitySupport.UPSTREAM_MISSING
    }));
  });

  it("projects an authoritative session snapshot at one revision/cursor/generation", () => {
    const fixture = createFixture();
    const projector = createProjector(fixture.store);
    fixture.store.setSetting("session", "session-1", EXTENSION_WIDGETS_SETTING_KEY, [{
      key: "checks",
      lines: ["Unit: passed"],
      placement: "below_editor",
      updatedAt: 9_500
    }]);
    fixture.store.setSetting("session", "session-1", EXTENSION_STATUSES_SETTING_KEY, [{
      key: "lint",
      text: "Checking",
      updatedAt: 9_600
    }]);
    fixture.store.setSetting(
      "session",
      "session-1",
      SESSION_RUNTIME_COMMANDS_SETTING_KEY,
      runtimeCommandsObservation(7, [
        { name: "review", description: "Review changes", source: "extension", path: "review.ts", loaded: true }
      ], 9_700)
    );
    const beforeCursor = fixture.store.listEvents().at(-1)?.globalCursor ?? 0n;

    const snapshot = projector.projectSessionSnapshot({
      sessionId: "session-1",
      recentTimelineItems: 2
    });

    expect(snapshot.scope?.kind.case).toBe("session");
    expect(snapshot.scope?.kind.case === "session" && snapshot.scope.kind.value).toMatchObject({
      sessionId: "session-1",
      recentTimelineItems: 2
    });
    expect(snapshot.revision?.value).toBeGreaterThan(0n);
    expect(snapshot.resumeCursor?.sequence).toBe(beforeCursor);
    expect(snapshot.generation).toBe(7n);
    expect(snapshot.backends.map((backend) => backend.backendId)).toEqual(["pi"]);
    expect(snapshot.targets.map((target) => target.targetId)).toEqual(["target-1"]);
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(["session-1"]);
    expect(snapshot.runs.map((run) => run.runId)).toContain("run-1");
    expect(snapshot.runs[0]?.attempts.map((attempt) => attempt.attemptId)).toContain("attempt-1");
    expect(snapshot.queueItems.map((item) => item.queueItemId)).toContain("queue-1");
    expect(snapshot.schedules.map((schedule) => schedule.scheduleId)).toContain("schedule-1");
    expect(snapshot.interactions.map((interaction) => interaction.interactionId)).toContain("interaction-1");
    expect(snapshot.artifacts.map((artifact) => artifact.artifactId)).toContain("artifact-1");
    expect(snapshot.toolLeases.map((lease) => lease.toolLeaseId)).toContain("lease-1");
    expect(snapshot.operations.map((operation) => operation.operationId)).toContain("operation-1");
    expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["workspace-1"]);
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["anthropic"]);
    expect(snapshot.models.map((model) => model.key?.modelId)).toEqual(["claude-test"]);
    expect(snapshot.timeline).toHaveLength(2);
    expect(snapshot.timeline.at(-1)?.payload?.kind.case).toBe("textDelta");
    expect(snapshot.extensionWidgets).toEqual([
      expect.objectContaining({ sessionId: "session-1", widgetKey: "checks", lines: ["Unit: passed"] })
    ]);
    expect(snapshot.extensionStatuses).toEqual([
      expect.objectContaining({ sessionId: "session-1", statusKey: "lint", statusText: "Checking" })
    ]);
    expect(snapshot.runtimeCommands).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        name: "review",
        description: "Review changes",
        loaded: true
      })
    ]);

    const productSession = snapshot.sessions[0];
    expect(productSession?.nativeBinding).toMatchObject({
      opaqueReference: "opaque:pi:session-1",
      runtimeGeneration: 7n,
      runtimeAttached: true
    });
    expect(productSession?.nativeBinding).not.toHaveProperty("nativeSessionId");
    expect(productSession?.context).toBeUndefined();
    expect(snapshot.nativeSessionTree).toBeUndefined();
  });

  it("projects the owner inventory without inventing a Pi timeline or context", () => {
    const fixture = createFixture();
    const snapshot = createProjector(fixture.store).projectOwnerSnapshot();

    expect(snapshot.scope?.kind.case).toBe("owner");
    expect(snapshot.generation).toBe(0n);
    expect(snapshot.connections.map((connection) => connection.connectionId)).toEqual(["connection-1"]);
    expect(snapshot.backends.map((backend) => backend.backendId)).toContain("pi");
    expect(snapshot.targets.map((target) => target.targetId)).toContain("target-1");
    expect(snapshot.sessions.map((session) => session.sessionId)).toContain("session-1");
    expect(snapshot.runs.map((run) => run.runId)).toContain("run-1");
    expect(snapshot.queueItems.map((item) => item.queueItemId)).toContain("queue-1");
    expect(snapshot.schedules.map((schedule) => schedule.scheduleId)).toContain("schedule-1");
    expect(snapshot.interactions.map((interaction) => interaction.interactionId)).toContain("interaction-1");
    expect(snapshot.operations.map((operation) => operation.operationId)).toContain("operation-1");
    expect(snapshot.workspaces.map((workspace) => workspace.workspaceId)).toContain("workspace-1");
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.nativeSessionTree).toBeUndefined();
  });

  it("projects durable derivation identity with availability that safely degrades when the source is hidden", () => {
    const fixture = createFixture();
    fixture.store.appendEvent({
      id: "derivation-source-event",
      emittedAt: 10_100,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 7,
      traceId: "derivation-source",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Source message" }]
      }
    });
    const source = fixture.store.getSession("session-1").descriptor;
    fixture.store.createSession({
      ...source,
      id: "session-derived",
      title: "Derived",
      binding: { opaqueRef: "opaque:pi:session-derived", generation: 0 },
      derivationOrigin: {
        kind: "clone",
        sourceSessionId: source.id,
        sourceMessageId: "derivation-source-event",
        sourceEventId: "derivation-source-event"
      },
      createdAt: 10_200,
      updatedAt: 10_200
    });

    expect(createProjector(fixture.store).projectOwnerSnapshot().sessions
      .find((session) => session.sessionId === "session-derived")?.derivationOrigin).toMatchObject({
        sourceSessionId: "session-1",
        sourceMessageId: "derivation-source-event",
        sourceEventId: "derivation-source-event",
        sourceSessionAvailable: true,
        sourceMessageAvailable: true
      });

    const currentSource = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", { archived: true }, currentSource.revision, 10_300);
    expect(createProjector(fixture.store).projectOwnerSnapshot().sessions
      .find((session) => session.sessionId === "session-derived")?.derivationOrigin).toMatchObject({
        sourceSessionAvailable: false,
        sourceMessageAvailable: false
      });
  });

  it("continues scoped operation projection past the former ten-thousand-record boundary", () => {
    const fixture = createFixture();
    const source = fixture.store.getOperation("operation-1");
    const offsets: number[] = [];
    vi.spyOn(fixture.store, "listOperations").mockImplementation((options = {}) => {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 500;
      offsets.push(offset);
      const remaining = Math.max(0, 10_001 - offset);
      return Array.from({ length: Math.min(limit, remaining) }, (_, index) => {
        const ordinal = offset + index;
        return {
          ...source,
          id: `operation-page-${ordinal}`,
          body: { sessionId: "session-1", ordinal },
          response: { accepted: true, resultCase: "acknowledgement", sessionId: "session-1" }
        };
      });
    });

    const snapshot = createProjector(fixture.store).projectSessionSnapshot({
      sessionId: "session-1",
      recentTimelineItems: 0
    });

    expect(snapshot.operations).toHaveLength(10_001);
    expect(snapshot.operations.at(-1)?.operationId).toBe("operation-page-10000");
    expect(offsets).toEqual([0, 10_000]);
  });

  it("restores content-free active background task fences in owner and Session snapshots", () => {
    const fixture = createFixture();
    const append = (id: string, state: "running" | "completed", emittedAt: number) => fixture.store.appendEvent({
      id,
      emittedAt,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 7,
      traceId: `background:${state}`,
      payload: {
        type: "background_task",
        taskId: "native-task-a",
        title: "secret-looking task title",
        state,
        detail: "credential-looking status must not enter the reconnect Snapshot"
      }
    });
    const started = append("background-running", "running", 8_300);
    const projector = createProjector(fixture.store);

    const owner = projector.projectOwnerSnapshot();
    expect(owner.timeline).toEqual([]);
    expect(owner.resumeCursor?.sequence).toBe(started.globalCursor);
    expect(owner.backgroundTasks).toEqual([expect.objectContaining({
      backgroundTaskId: "native-task-a",
      sessionId: "session-1",
      runId: "run-1",
      state: BackgroundTaskState.RUNNING,
      displayName: "",
      statusText: "",
      error: undefined
    })]);
    const serializedBackgroundTasks = JSON.stringify(
      owner.backgroundTasks,
      (_key, value) => typeof value === "bigint" ? value.toString() : value
    );
    expect(serializedBackgroundTasks).not.toContain("secret-looking");
    expect(serializedBackgroundTasks).not.toContain("credential-looking");

    const session = projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 0 });
    expect(session.backgroundTasks).toHaveLength(1);
    expect(session.backgroundTasks[0]?.sessionId).toBe("session-1");

    const completed = append("background-completed", "completed", 8_400);
    const reconnect = projector.projectOwnerSnapshot();
    expect(reconnect.resumeCursor?.sequence).toBe(completed.globalCursor);
    expect(reconnect.backgroundTasks).toEqual([]);
    expect(projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 0 }).backgroundTasks)
      .toEqual([]);
  });

  it("keeps runtime command observations scoped to their Session in owner reconnect snapshots", () => {
    const fixture = createFixture();
    fixture.store.createSession({
      id: "session-2",
      backendId: "pi",
      targetId: "target-1",
      title: "Second Session",
      binding: { opaqueRef: "opaque:pi:session-2", generation: 3 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 4_000,
      updatedAt: 4_000
    });
    fixture.store.setSetting(
      "session",
      "session-1",
      SESSION_RUNTIME_COMMANDS_SETTING_KEY,
      runtimeCommandsObservation(7, [
        { name: "review", description: "Review", source: "extension", loaded: true }
      ], 9_700)
    );
    fixture.store.setSetting(
      "session",
      "session-2",
      SESSION_RUNTIME_COMMANDS_SETTING_KEY,
      runtimeCommandsObservation(3, [
        { name: "release", description: "Release", source: "prompt", loaded: true }
      ], 9_800)
    );

    const snapshot = createProjector(fixture.store).projectOwnerSnapshot();
    expect(snapshot.runtimeCommands.map((command) => ({
      sessionId: command.sessionId,
      name: command.name
    }))).toEqual([
      { sessionId: "session-1", name: "review" },
      { sessionId: "session-2", name: "release" }
    ]);
  });

  it("uses the live Provider catalog for per-Provider model availability", () => {
    const fixture = createFixture();
    const anthropic = {
      ...toProtoProviderDescriptor("pi", "anthropic", "anthropic-messages", false, 9n, 9_000),
      displayName: "Anthropic subscription",
      kind: ProviderKind.SUBSCRIPTION,
      authenticationState: AuthenticationState.SIGNED_OUT,
      ownerManaged: true
    };
    const openaiCodex = {
      ...toProtoProviderDescriptor("pi", "openai-codex", "openai-responses", true, 10n, 9_500),
      displayName: "OpenAI Codex",
      kind: ProviderKind.SUBSCRIPTION,
      authenticationState: AuthenticationState.AUTHENTICATED,
      ownerManaged: true
    };
    const projector = new SnapshotProjector(fixture.store, {
      now: () => 10_000,
      idFactory: () => "snapshot-provider-catalog",
      server: () => toProtoServerInfo({
        serverId: "orchestrator-1",
        displayName: "Orchestrator",
        version: "0.1.0",
        apiVersion: "joko.v1",
        pairingEnabled: true
      }, 10_000),
      providerCatalog: () => [
        { provider: anthropic, available: false },
        { provider: openaiCodex, available: true }
      ]
    });

    const snapshot = projector.projectOwnerSnapshot();
    expect(snapshot.providers).toEqual([anthropic, openaiCodex]);
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({ available: false });
  });

  it("keeps identical Provider and model IDs distinct across Backend instances", () => {
    const fixture = createFixture();
    const original = fixture.store.getBackend("pi").descriptor;
    fixture.store.upsertBackend({
      ...original,
      id: "secondary-backend",
      displayName: "Secondary Backend"
    });

    const snapshot = createProjector(fixture.store).projectOwnerSnapshot();
    expect(snapshot.providers.map((provider) => [provider.backendId, provider.providerId])).toEqual([
      ["pi", "anthropic"],
      ["secondary-backend", "anthropic"]
    ]);
    expect(snapshot.models.map((model) => [model.backendId, model.key?.providerId, model.key?.modelId])).toEqual([
      ["pi", "anthropic", "claude-test"],
      ["secondary-backend", "anthropic", "claude-test"]
    ]);
  });

  it("projects an explicit signed-out Backend Provider before any models are discoverable", () => {
    const fixture = createFixture();
    const original = fixture.store.getBackend("pi").descriptor;
    fixture.store.upsertBackend({
      ...original,
      authenticationState: "signed_out",
      providers: [{
        providerId: "native-account",
        displayName: "Native account",
        api: "openai-responses",
        authenticationState: "signed_out",
        loginMethods: ["api_key"],
        supportsLogin: true,
        supportsLogout: false,
        supportsRefresh: true,
        supportsModelRefresh: true
      }],
      models: []
    });

    const snapshot = createProjector(fixture.store).projectOwnerSnapshot();
    expect(snapshot.providers).toEqual([expect.objectContaining({
      backendId: "pi",
      providerId: "native-account",
      displayName: "Native account",
      authenticationState: AuthenticationState.SIGNED_OUT,
      loginMethods: [ProviderLoginMethod.API_KEY]
    })]);
    expect(snapshot.models).toEqual([]);
  });

  it("rebuilds native history on the active leaf while retaining abandoned branch events", () => {
    const fixture = createFixture();
    const nativeReference = "opaque:pi:session-1";
    const appendNative = (id: string, parentEntryId: string | undefined, text: string) => fixture.store.appendEvent({
      id: `native-${id}`,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 7,
      traceId: `native-${id}`,
      payload: {
        type: "message_complete",
        role: id === "root" ? "user" : "assistant",
        blocks: [{ kind: "text", text }],
        nativeHistory: {
          identity: { entryId: id, ...(parentEntryId === undefined ? {} : { parentEntryId }) }
        }
      },
      metadata: {
        namespace: "backend.native_history",
        fields: {
          nativeHydration: true,
          [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: nativeBindingFingerprint(nativeReference)
        }
      }
    });
    appendNative("root", undefined, "Root");
    appendNative("branch-a", "root", "A");
    appendNative("branch-b", "root", "B");
    fixture.store.appendEvent({
      id: "leaf-a",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 7,
      traceId: "leaf-a",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "branch-a" }
    });

    const projector = createProjector(fixture.store);
    const first = projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 });
    expect(first.timeline.map((event) => event.eventId)).toContain("native-root");
    expect(first.timeline.map((event) => event.eventId)).toContain("native-branch-a");
    expect(first.timeline.map((event) => event.eventId)).not.toContain("native-branch-b");

    fixture.store.appendEvent({
      id: "leaf-b",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 7,
      traceId: "leaf-b",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "branch-b" }
    });
    const second = projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 });
    expect(second.timeline.map((event) => event.eventId)).toContain("native-root");
    expect(second.timeline.map((event) => event.eventId)).toContain("native-branch-b");
    expect(second.timeline.map((event) => event.eventId)).not.toContain("native-branch-a");
    expect(fixture.store.listEvents({ sessionId: "session-1", limit: 100 }).map((event) => event.id)).toEqual(expect.arrayContaining([
      "native-branch-a",
      "native-branch-b"
    ]));
  });

  it("fences native history to its binding fingerprint across rebinds", () => {
    const fixture = createFixture();
    const original = fixture.store.getSession("session-1");
    const oldGeneration = original.descriptor.binding.generation;
    const appendNative = (id: string, generation: number, nativeReference: string, text: string) => fixture.store.appendEvent({
      id,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation,
      traceId: id,
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text }],
        nativeHistory: { identity: { entryId: "reused-entry" } }
      },
      metadata: {
        namespace: "joko.native_history",
        fields: {
          [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: nativeBindingFingerprint(nativeReference)
        }
      }
    });
    appendNative("old-binding-entry", oldGeneration, original.descriptor.binding.opaqueRef, "old binding");
    const rebound = fixture.store.updateSession("session-1", {
      binding: { opaqueRef: "opaque:new-binding", generation: oldGeneration + 1 }
    }, original.revision);
    const newGeneration = rebound.descriptor.binding.generation;
    const projector = createProjector(fixture.store);
    expect(projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 }).timeline
      .map((event) => event.eventId)).not.toContain("old-binding-entry");
    fixture.store.appendEvent({
      id: "empty-rebind-marker",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: newGeneration,
      traceId: "empty-rebind-marker",
      payload: { type: "native_session_changed", opaqueRef: "opaque:new-binding" }
    });

    expect(projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 }).timeline
      .map((event) => event.eventId)).not.toContain("old-binding-entry");

    appendNative("new-binding-entry", newGeneration, "opaque:new-binding", "new binding");
    fixture.store.appendEvent({
      id: "active-rebind-marker",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: newGeneration,
      traceId: "active-rebind-marker",
      payload: { type: "native_session_changed", opaqueRef: "opaque:new-binding", leafId: "reused-entry" }
    });
    const timelineIds = projector.projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 }).timeline
      .map((event) => event.eventId);
    expect(timelineIds).toContain("new-binding-entry");
    expect(timelineIds).not.toContain("old-binding-entry");
  });

  it("keeps same-binding ancestors across runtime generations", () => {
    const fixture = createFixture();
    const nativeReference = fixture.store.getSession("session-1").descriptor.binding.opaqueRef;
    const bindingFingerprint = nativeBindingFingerprint(nativeReference);
    const appendNative = (id: string, parentEntryId: string | undefined, generation: number) => fixture.store.appendEvent({
      id: `cross-generation-${id}`,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation,
      traceId: `cross-generation-${id}`,
      payload: {
        type: "message_complete",
        role: id === "root" ? "user" : "assistant",
        blocks: [{ kind: "text", text: id }],
        nativeHistory: { identity: { entryId: id, ...(parentEntryId === undefined ? {} : { parentEntryId }) } }
      },
      metadata: {
        namespace: "joko.native_history",
        fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint }
      }
    });
    appendNative("root", undefined, 7);
    const stored = fixture.store.getSession("session-1");
    fixture.store.updateSession("session-1", {
      binding: { ...stored.descriptor.binding, generation: 8 }
    }, stored.revision);
    appendNative("leaf", "root", 8);
    fixture.store.appendEvent({
      id: "cross-generation-marker",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 8,
      traceId: "cross-generation-marker",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "leaf" }
    });

    const timelineIds = createProjector(fixture.store)
      .projectSessionSnapshot({ sessionId: "session-1", recentTimelineItems: 100 })
      .timeline.map((event) => event.eventId);
    expect(timelineIds).toEqual(expect.arrayContaining(["cross-generation-root", "cross-generation-leaf"]));
  });

  it("routes all seven protobuf scopes with store-authoritative filtering", () => {
    const fixture = createFixture();
    const projector = createProjector(fixture.store);
    const sessionScope: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "session",
        value: {
          $typeName: "joko.v1.SessionSnapshotScope",
          sessionId: "session-1",
          recentTimelineItems: 1
        }
      }
    };
    expect(projector.project(sessionScope).timeline).toHaveLength(1);

    const backend: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "backend",
        value: { $typeName: "joko.v1.BackendSnapshotScope", backendId: "pi" }
      }
    };
    expect(projector.project(backend).backends.map((item) => item.backendId)).toEqual(["pi"]);
    const target: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "target",
        value: { $typeName: "joko.v1.TargetSnapshotScope", targetId: "target-1" }
      }
    };
    expect(projector.project(target).targets.map((item) => item.targetId)).toEqual(["target-1"]);
    const workspace: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "workspace",
        value: { $typeName: "joko.v1.WorkspaceSnapshotScope", workspaceId: "workspace-1" }
      }
    };
    expect(projector.project(workspace).workspaces.map((item) => item.workspaceId)).toEqual(["workspace-1"]);
    const schedule: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "schedule",
        value: { $typeName: "joko.v1.ScheduleSnapshotScope", scheduleId: "schedule-1" }
      }
    };
    expect(projector.project(schedule).schedules.map((item) => item.scheduleId)).toEqual(["schedule-1"]);
    const tool: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "tool",
        value: { $typeName: "joko.v1.ToolSnapshotScope", toolProviderId: "browser" }
      }
    };
    const toolSnapshot = projector.project(tool);
    expect(toolSnapshot.toolLeases.map((item) => item.toolLeaseId)).toEqual(["lease-1"]);
    expect(toolSnapshot.schedules).toEqual([]);
    const owner: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: {
        case: "owner",
        value: { $typeName: "joko.v1.OwnerSnapshotScope" }
      }
    };
    expect(projector.project(owner).connections).toHaveLength(1);

    const missingScope: SnapshotScope = {
      $typeName: "joko.v1.SnapshotScope",
      kind: { case: undefined }
    };
    expect(() => projector.project(missingScope)).toThrow(ProtoMappingError);
    expect(() => projector.projectSessionSnapshot("missing-session")).toThrow(NotFoundError);
    expect(() => projector.projectSessionSnapshot({
      sessionId: "session-1",
      recentTimelineItems: 10_001
    })).toThrow(ProtoMappingError);
  });
});

function createFixture(): { readonly store: OperationalStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-snapshot-projector-"));
  let nextId = 0;
  const store = new OperationalStore(path.join(directory, "operational.sqlite"), {
    now: () => 10_000,
    idFactory: () => `store-generated-${++nextId}`
  });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  store.createConnection({
    id: "connection-1",
    name: "Desktop",
    authKeyDigest: "opaque-auth-digest",
    pairedAt: 1_000
  });
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "latest-installed",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [{
      providerId: "anthropic",
      modelId: "claude-test",
      displayName: "Claude Test",
      api: "anthropic-messages",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsImages: true,
      thinkingLevels: ["high"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    }],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "pi",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  }, { workspaceId: "workspace-1", pinned: true });
  store.createSession({
    id: "session-1",
    backendId: "pi",
    targetId: "target-1",
    title: "Session",
    binding: {
      opaqueRef: "opaque:pi:session-1",
      nativeSessionId: "native-secret-that-must-not-project",
      generation: 7
    },
    pinned: true,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    providerId: "anthropic",
    modelId: "claude-test",
    effort: "high",
    fastMode: false,
    createdAt: 2_000,
    updatedAt: 3_000
  });
  store.createRun({
    id: "run-1",
    sessionId: "session-1",
    source: "user",
    state: "running",
    activeAttemptId: "attempt-1",
    createdAt: 4_000,
    startedAt: 4_100
  });
  store.createAttempt({
    id: "attempt-1",
    runId: "run-1",
    ordinal: 1,
    generation: 7,
    startedAt: 4_100
  });
  const prompt = { text: "hello", images: [], files: [], mentions: [], disposition: "prompt" as const };
  store.runOperation({ id: "operation-1", kind: "prompt", body: prompt }, (transaction) => {
    transaction.enqueueQueueItem({
      id: "queue-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      operationId: "operation-1",
      disposition: "prompt",
      body: prompt,
      createdAt: 4_000
    });
    return { queueItemId: "queue-1" };
  });
  store.upsertSchedule({
    id: "schedule-1",
    backendId: "pi",
    targetId: "target-1",
    sessionMode: "bound",
    sessionId: "session-1",
    name: "Every minute",
    kind: "cron",
    expression: "* * * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    prompt,
    executionSnapshot: {
      providerId: "anthropic",
      modelId: "claude-test",
      permissionMode: "ask",
      useWorktree: false,
      refreshWorktreeRemote: false,
      scheduler: {
        format: 1,
        silentWhenIdle: false,
        notify: { desktop: true },
        executionMode: "agent"
      }
    },
    overlapPolicy: "queue",
    misfirePolicy: "run_once",
    nextRunAt: 20_000,
    expectedRevision: 0n,
    now: 5_000
  });
  store.recordScheduleRun("schedule-1", "run-1", "running", { worker: "orchestrator" }, 5_100);
  store.openInteraction({
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    operationId: "operation-1",
    generation: 7,
    traceId: "interaction-open",
    createdAt: 6_000,
    payload: {
      id: "interaction-1",
      kind: "question",
      title: "Continue?",
      prompt: "Choose",
      fields: [{
        id: "answer",
        label: "Continue?",
        required: true,
        kind: "single",
        choices: [
          { id: "yes", label: "yes" },
          { id: "no", label: "no" }
        ]
      }]
    }
  });
  store.putArtifact({
    id: "artifact-1",
    sha256: "a".repeat(64),
    byteLength: 12,
    mimeType: "text/plain",
    fileName: "result.txt",
    storageKey: `sha256/aa/${"a".repeat(64)}`,
    sessionId: "session-1",
    runId: "run-1",
    purpose: "result",
    traceId: "artifact",
    createdAt: 7_000
  });
  store.acquireToolLease({
    id: "lease-1",
    toolId: "browser",
    sessionId: "session-1",
    runId: "run-1",
    generation: 7,
    expiresAt: 20_000,
    now: 8_000
  });
  store.appendEvent({
    id: "event-status",
    emittedAt: 8_100,
    backendId: "pi",
    targetId: "target-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    operationId: "operation-1",
    generation: 7,
    traceId: "status",
    payload: { type: "status", key: "working", text: "Working" }
  });
  store.appendEvent({
    id: "event-text",
    emittedAt: 8_200,
    backendId: "pi",
    targetId: "target-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    operationId: "operation-1",
    generation: 7,
    traceId: "text",
    payload: { type: "text_delta", blockId: "message-1", delta: "Hello" }
  });

  return { store };
}

function createProjector(store: OperationalStore): SnapshotProjector {
  let nextSnapshot = 0;
  return new SnapshotProjector(store, {
    now: () => 10_000,
    idFactory: () => `snapshot-${++nextSnapshot}`,
    server: () => toProtoServerInfo({
      serverId: "orchestrator-1",
      displayName: "Orchestrator",
      version: "0.1.0",
      apiVersion: "joko.v1",
      pairingEnabled: true
    }, 10_000)
  });
}
