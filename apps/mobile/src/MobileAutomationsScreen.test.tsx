// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  BackendSettingsSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  OwnerSnapshotScopeSchema,
  PermissionMode,
  SessionSchema,
  SessionState,
  SettingsSnapshotSchema,
  SnapshotSchema,
  SnapshotScopeSchema,
  TargetSchema,
  TargetState,
  WorkspaceDescriptorSchema,
  WorkspaceKind,
  capabilityNames,
  type Snapshot
} from "@joko/contracts";
import { emptyMobileFilesState } from "./workspace-files";
import type { MobileState } from "./mobile-client";
import type {
  MobileAutomationRun,
  MobileAutomationSchedule,
  MobileAutomationsState
} from "./mobile-automation";
import {
  MobileAutomationsScreen,
  type MobileAutomationsClient,
  type MobileAutomationsColors
} from "./MobileAutomationsScreen";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({ width: 390, alert: vi.fn() }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled,
    numberOfLines: _numberOfLines, contentContainerStyle: _contentContainerStyle, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      contentContainerStyle?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-selected": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    Alert: { alert: native.alert },
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, value, onChangeText, editable = true, multiline, ...props }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      editable?: boolean;
      multiline?: boolean;
    }) => React.createElement(multiline ? "textarea" : "input", {
      ...props,
      "aria-label": accessibilityLabel,
      value,
      disabled: !editable,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText?.(event.target.value),
      style: undefined
    }),
    View: element("div"),
    useWindowDimensions: () => ({ width: native.width, height: 844, scale: 1, fontScale: 1 })
  };
});

const colors: MobileAutomationsColors = {
  background: "#fafafa",
  surface: "#fff",
  ink: "#111",
  muted: "#666",
  border: "#ddd",
  accent: "#f90",
  negative: "#b00",
  brandBackground: "#fff0d0"
};

const completedRun: MobileAutomationRun = {
  triggerId: "trigger-completed",
  runId: "run-completed",
  sessionId: "session-actual",
  state: "completed",
  scheduledFor: 1_000,
  triggeredAt: 2_000,
  finishedAt: 3_000,
  durationMs: 1_000,
  resultText: "Build passed",
  zeroCost: true,
  costAttribution: "zero"
};

const interruptedRun: MobileAutomationRun = {
  triggerId: "trigger-interrupted",
  runId: "run-interrupted",
  state: "interrupted",
  scheduledFor: 4_000,
  triggeredAt: 5_000,
  finishedAt: 6_000,
  durationMs: 1_000,
  readAt: 7_000,
  zeroCost: false,
  costAttribution: "unavailable",
  preRun: {
    status: "passed",
    decision: "run",
    durationMs: 200,
    stdout: "Checks passed",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false
  }
};

const projectSchedule: MobileAutomationSchedule = {
  scheduleId: "schedule-project",
  displayName: "Project check",
  state: "enabled",
  source: "project",
  backendId: "backend",
  targetId: "target",
  sessionMode: "fresh",
  recurrence: "cron",
  recurrenceLabel: "cron 0 9 * * *",
  recurrenceExpression: "0 9 * * *",
  timeZone: "Asia/Shanghai",
  inputText: "Check the project",
  editableInputText: "Check the project",
  executionMode: "agent",
  permissionMode: "ask",
  planMode: false,
  useWorktree: false,
  refreshWorktreeRemote: false,
  extraDirectoryIds: [],
  silentWhenIdle: false,
  notifyDesktop: true,
  overlapPolicy: "queue",
  misfirePolicy: "runOnce",
  projectConfigId: "config",
  projectConfigPath: ".joko/automations/check.json",
  unreadRunCount: 1,
  recentRuns: [completedRun],
  revision: { value: 4n, etag: "schedule-r4" },
  generation: 1n
};

const dialogueSchedule: MobileAutomationSchedule = {
  ...projectSchedule,
  scheduleId: "schedule-dialogue",
  displayName: "Personal reminder",
  state: "disabled",
  source: "dialogue",
  recurrence: "manual",
  recurrenceLabel: "Manual",
  recurrenceExpression: "",
  projectConfigId: undefined,
  projectConfigPath: undefined,
  unreadRunCount: 0,
  revision: { value: 2n, etag: "schedule-r2" }
};

function automations(patch: Partial<MobileAutomationsState> = {}): MobileAutomationsState {
  return {
    open: true,
    status: "ready",
    filter: "all",
    schedules: [projectSchedule, dialogueSchedule],
    selectedScheduleId: projectSchedule.scheduleId,
    detail: projectSchedule,
    history: [completedRun, interruptedRun],
    historyStatus: "ready",
    historyNextPageToken: "next-page",
    historyTotalSize: 3,
    runtime: {
      instanceId: "scheduler",
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: 4,
      inFlightBySchedule: { [projectSchedule.scheduleId]: 1 },
      waitingBySchedule: {}
    },
    lastSyncedAt: 9_000,
    ...patch
  };
}

function authoringOwner(): Snapshot {
  return create(SnapshotSchema, {
    snapshotId: "owner",
    scope: create(SnapshotScopeSchema, { kind: { case: "owner", value: create(OwnerSnapshotScopeSchema) } }),
    generation: 1n,
    revision: { value: 1n },
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      displayName: "Backend",
      capabilities: create(CapabilityManifestSchema, {
        schemaVersion: "1",
        revision: { value: 1n },
        capabilities: [
          create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
          create(CapabilitySchema, {
            name: capabilityNames.permissionModes,
            support: CapabilitySupport.SUPPORTED,
            options: { kind: { case: "permission", value: {
              modes: [PermissionMode.ASK, PermissionMode.AUTO], mutableDuringSession: true
            } } }
          }),
          create(CapabilitySchema, { name: capabilityNames.planMode, support: CapabilitySupport.SUPPORTED })
        ]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", workspaceId: "workspace", displayName: "Project",
      state: TargetState.ACTIVE, version: { revision: { value: 2n } }
    })],
    workspaces: [create(WorkspaceDescriptorSchema, {
      workspaceId: "workspace", targetId: "target", displayName: "Project", kind: WorkspaceKind.USER_PROJECT,
      serverPathDisplay: "D:\\project", trusted: true, version: { revision: { value: 2n } }
    })],
    sessions: [create(SessionSchema, {
      sessionId: "session-actual", backendId: "backend", targetId: "target", displayName: "Existing task",
      state: SessionState.IDLE, version: { revision: { value: 3n } }
    })],
    settings: create(SettingsSnapshotSchema, {
      revision: { value: 1n },
      backends: [create(BackendSettingsSchema, {
        backendId: "backend", enabled: true, defaultPermissionMode: PermissionMode.ASK
      })]
    })
  });
}

function mobileState(automationPatch: Partial<MobileAutomationsState> = {}, statePatch: Partial<MobileState> = {}): MobileState {
  return {
    status: "connected",
    busy: false,
    saved: [],
    connectionMode: "nearby",
    discoveryState: "idle",
    nearby: [],
    owner: create(SnapshotSchema, {
      sessions: [create(SessionSchema, { sessionId: "session-actual" })]
    }),
    older: [],
    live: [],
    liveStatus: "streaming",
    historyBusy: false,
    historyEnd: false,
    pending: [],
    homeSearchQuery: "",
    homeSearchFilter: "active",
    homeSearchStatus: "idle",
    homeSearchSessionIds: [],
    files: emptyMobileFilesState(),
    automations: automations(automationPatch),
    ...statePatch
  };
}

function mobileClient(): MobileAutomationsClient {
  return {
    openAutomations: vi.fn(async () => undefined),
    closeAutomations: vi.fn(() => undefined),
    setAutomationFilter: vi.fn(() => undefined),
    selectAutomation: vi.fn(async () => undefined),
    refreshAutomations: vi.fn(async () => undefined),
    loadMoreAutomationHistory: vi.fn(async () => undefined),
    runAutomation: vi.fn(async () => true),
    setAutomationEnabled: vi.fn(async () => true),
    restartAutomationRun: vi.fn(async () => true),
    markAutomationRunRead: vi.fn(async () => true),
    markAutomationRunsRead: vi.fn(async () => true),
    markAllAutomationRunsRead: vi.fn(async () => true),
    deleteAutomationRun: vi.fn(async () => true),
    openAutomationRunTask: vi.fn(async () => undefined),
    loadAutomationWorktree: vi.fn(async (targetId) => ({
      targetId, eligibility: "eligible" as const, canRefreshRemote: true, sources: []
    })),
    saveAutomation: vi.fn(async () => projectSchedule),
    prepareAutomationDeletion: vi.fn(async (scheduleId) => ({
      scheduleId, scheduleRevision: "revision", generatedSessionIds: ["session-generated"], inflightCount: 1
    })),
    deleteAutomation: vi.fn(async (scheduleId, disposition) => ({
      scheduleId, disposition, generatedSessionIds: ["session-generated"], completedSessionIds: ["session-generated"],
      failures: [], inflightCount: 1
    })),
    promoteAutomation: vi.fn(async () => projectSchedule),
    cloneProjectAutomation: vi.fn(async () => dialogueSchedule),
    removeProjectAutomation: vi.fn(async () => true),
    reconcileProjectAutomations: vi.fn(async () => true)
  };
}

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  native.width = 390;
  native.alert.mockReset();
});

function mount(state: MobileState, client = mobileClient(), onOpenTask = vi.fn()) {
  const container = document.createElement("div");
  const onBack = vi.fn();
  const render = (next: MobileState) => createElement(MobileAutomationsScreen, {
    colors,
    state: next,
    client,
    onBack,
    onOpenTask
  });
  root = createRoot(container);
  act(() => root!.render(render(state)));
  return { container, client, onOpenTask, rerender: (next: MobileState) => act(() => root!.render(render(next))) };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = container.querySelector(`button[aria-label="${label}"]`);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return match;
}

function input(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!(match instanceof HTMLInputElement) && !(match instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing input ${label}`);
  }
  return match;
}

function changeInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MobileAutomationsScreen", () => {
  it("renders grouped filters and uses a narrow list-to-detail selection", async () => {
    native.width = 390;
    const client = mobileClient();
    const { container } = mount(mobileState(), client);

    expect(container.textContent).toContain("Project");
    expect(container.textContent).toContain("Dialogue");
    expect(container.textContent).not.toContain("Run history");
    act(() => button(container, "Paused Automations").click());
    expect(client.setAutomationFilter).toHaveBeenCalledWith("paused");
    await act(async () => button(container, "Open Automation Project check").click());

    expect(client.selectAutomation).toHaveBeenCalledWith(projectSchedule.scheduleId);
    expect(container.textContent).toContain("Run history (2/3)");
    expect(container.textContent).toContain("Build passed");
  });

  it("renders wide list/detail, confirms in-flight pause impact, and exposes eligible run controls", async () => {
    native.width = 900;
    const client = mobileClient();
    const onOpenTask = vi.fn();
    const { container } = mount(mobileState(), client, onOpenTask);

    expect(container.textContent).toContain("Project check");
    expect(container.textContent).toContain("Run history (2/3)");
    act(() => button(container, "Pause").click());
    expect(native.alert).toHaveBeenCalledWith(
      "Pause Project check?",
      expect.stringContaining("1 run is currently in flight"),
      expect.any(Array)
    );
    const pauseAction = native.alert.mock.calls[0]?.[2]?.[1] as { onPress?: () => void } | undefined;
    await act(async () => pauseAction?.onPress?.());
    expect(client.setAutomationEnabled).toHaveBeenCalledWith(projectSchedule.scheduleId, false);

    await act(async () => button(container, "Mark read").click());
    expect(client.markAutomationRunRead).toHaveBeenCalledWith(projectSchedule.scheduleId, completedRun.triggerId);
    await act(async () => button(container, "Restart").click());
    expect(client.restartAutomationRun).toHaveBeenCalledWith(projectSchedule.scheduleId, interruptedRun.triggerId);
    await act(async () => button(container, "Open task").click());
    expect(client.openAutomationRunTask).toHaveBeenCalledWith(projectSchedule.scheduleId, completedRun.triggerId);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("shows loading, empty and error states without granting controls", () => {
    const loading = mount(mobileState({ status: "loading", schedules: [], selectedScheduleId: undefined,
      detail: undefined, history: [], historyStatus: "loading", historyTotalSize: 0 })).container;
    expect(loading.textContent).toContain("Loading Automations…");
    act(() => root?.unmount());
    root = undefined;

    const empty = mount(mobileState({ schedules: [], selectedScheduleId: undefined, detail: undefined,
      history: [], historyTotalSize: 0 })).container;
    expect(empty.textContent).toContain("No Automations");
    act(() => root?.unmount());
    root = undefined;

    const failed = mount(mobileState({ status: "error", error: "Schedule catalog failed" })).container;
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain("Schedule catalog failed");
  });

  it("keeps saved offline summaries visible while details, history and mutations stay disabled", async () => {
    native.width = 900;
    const client = mobileClient();
    const state = mobileState({
      status: "offline",
      detail: undefined,
      history: [],
      historyStatus: "idle",
      historyNextPageToken: undefined,
      historyTotalSize: 0,
      runtime: undefined,
      error: "Reconnect to inspect or control Automations."
    }, { status: "offline", offlineSnapshotAt: 1_000 });
    const { container } = mount(state, client);

    expect(container.textContent).toContain("Project check");
    expect(container.textContent).toContain("Run history is not cached");
    expect(button(container, "Run now").disabled).toBe(true);
    expect(button(container, "Pause").disabled).toBe(true);
    expect(container.textContent).toContain("verified saved Schedule summaries");
    await act(async () => button(container, "Run now").click());
    expect(client.runAutomation).not.toHaveBeenCalled();
  });

  it("creates an Automation from the mounted full editor", async () => {
    const client = mobileClient();
    const state = mobileState({
      schedules: [], selectedScheduleId: undefined, detail: undefined, history: [], historyTotalSize: 0
    }, { owner: authoringOwner() });
    const { container } = mount(state, client);

    act(() => button(container, "New").click());
    act(() => {
      changeInput(input(container, "Automation name"), "Mobile release check");
      changeInput(input(container, "Scheduled input"), "Check the release notes");
    });
    await act(async () => button(container, "Create Automation").click());

    expect(client.saveAutomation).toHaveBeenCalledWith(expect.objectContaining({
      name: "Mobile release check",
      targetId: "target",
      inputText: "Check the release notes",
      permissionMode: "ask"
    }), undefined);
  });

  it("clears incompatible Worktree state when the mounted editor leaves fresh-task mode", async () => {
    const client = mobileClient();
    const state = mobileState({
      schedules: [], selectedScheduleId: undefined, detail: undefined, history: [], historyTotalSize: 0
    }, { owner: authoringOwner() });
    const { container } = mount(state, client);

    act(() => button(container, "New").click());
    act(() => {
      changeInput(input(container, "Automation name"), "Persistent check");
      changeInput(input(container, "Scheduled input"), "Run the check");
      button(container, "Isolated Worktree").click();
    });
    await act(async () => undefined);
    expect(client.loadAutomationWorktree).toHaveBeenCalledWith("target");
    act(() => button(container, "persistent").click());
    await act(async () => button(container, "Create Automation").click());

    expect(client.saveAutomation).toHaveBeenCalledWith(expect.objectContaining({
      sessionMode: "persistent",
      useWorktree: false,
      worktreeSourceRef: undefined,
      refreshWorktreeRemote: false
    }), undefined);
  });

  it("retains a dirty edit read-only across offline rerender and confirms close", async () => {
    native.width = 900;
    const client = mobileClient();
    const connected = mobileState({}, { owner: authoringOwner() });
    const mounted = mount(connected, client);

    act(() => button(mounted.container, "Edit").click());
    act(() => changeInput(input(mounted.container, "Automation name"), "Edited project check"));
    act(() => button(mounted.container, "Close editor").click());
    expect(native.alert).toHaveBeenCalledWith(
      "Discard Automation draft?",
      expect.stringContaining("unsaved changes"),
      expect.any(Array)
    );

    mounted.rerender(mobileState({ status: "offline" }, {
      status: "offline", owner: authoringOwner(), offlineSnapshotAt: 1_000
    }));
    expect(input(mounted.container, "Automation name").value).toBe("Edited project check");
    expect(input(mounted.container, "Automation name").disabled).toBe(true);
    mounted.rerender(connected);
    await act(async () => button(mounted.container, "Save Automation").click());
    expect(client.saveAutomation).toHaveBeenCalledWith(expect.objectContaining({
      name: "Edited project check"
    }), projectSchedule.scheduleId);
  });

  it("keeps the mounted editor open while a save is in flight", async () => {
    native.width = 900;
    let resolveSave!: (value: MobileAutomationSchedule | undefined) => void;
    const client = mobileClient();
    vi.mocked(client.saveAutomation).mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const { container } = mount(mobileState({}, { owner: authoringOwner() }), client);

    act(() => button(container, "Edit").click());
    act(() => changeInput(input(container, "Automation name"), "Saving project check"));
    act(() => button(container, "Save Automation").click());

    expect(button(container, "Close editor").disabled).toBe(true);
    act(() => button(container, "Close editor").click());
    expect(native.alert).not.toHaveBeenCalled();

    await act(async () => resolveSave(projectSchedule));
    expect(container.textContent).not.toContain("Edit Automation");
  });

  it("previews generated tasks and submits the selected deletion disposition", async () => {
    native.width = 900;
    const client = mobileClient();
    const state = mobileState({
      selectedScheduleId: dialogueSchedule.scheduleId,
      detail: dialogueSchedule
    }, { owner: authoringOwner() });
    const { container } = mount(state, client);

    act(() => button(container, "Delete Automation").click());
    await act(async () => undefined);
    expect(client.prepareAutomationDeletion).toHaveBeenCalledWith(dialogueSchedule.scheduleId);
    expect(container.textContent).toContain("session-generated");
    act(() => button(container, "Archive tasks").click());
    await act(async () => button(container, "Confirm deletion").click());

    expect(client.deleteAutomation).toHaveBeenCalledWith(
      dialogueSchedule.scheduleId,
      "archive",
      expect.objectContaining({ generatedSessionIds: ["session-generated"], inflightCount: 1 })
    );
  });

  it("exposes dedicated project and personal ownership actions", async () => {
    native.width = 900;
    const projectClient = mobileClient();
    const project = mount(mobileState({}, { owner: authoringOwner() }), projectClient);

    await act(async () => button(project.container, "Clone personal copy").click());
    await act(async () => button(project.container, "Reconcile project").click());
    act(() => button(project.container, "Remove from project").click());
    const keepCopy = native.alert.mock.calls.at(-1)?.[2]?.[2] as { onPress?: () => void } | undefined;
    await act(async () => keepCopy?.onPress?.());
    expect(projectClient.cloneProjectAutomation).toHaveBeenCalledWith(projectSchedule.scheduleId, "Project check (copy)");
    expect(projectClient.reconcileProjectAutomations).toHaveBeenCalledWith(projectSchedule.targetId);
    expect(projectClient.removeProjectAutomation).toHaveBeenCalledWith(projectSchedule.scheduleId, true);

    act(() => root?.unmount());
    root = undefined;
    native.alert.mockReset();
    const personalClient = mobileClient();
    const personal = mount(mobileState({
      selectedScheduleId: dialogueSchedule.scheduleId,
      detail: dialogueSchedule
    }, { owner: authoringOwner() }), personalClient);
    act(() => button(personal.container, "Promote to project").click());
    const promote = native.alert.mock.calls[0]?.[2]?.[1] as { onPress?: () => void } | undefined;
    await act(async () => promote?.onPress?.());
    expect(personalClient.promoteAutomation).toHaveBeenCalledWith(dialogueSchedule.scheduleId);
  });
});
