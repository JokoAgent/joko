import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DevicePeerCapabilityKind,
  type DevicePeerCommand,
  DevicePeerCommandSchema,
  DevicePeerCreateRemoteDesktopOfferActionSchema,
  DevicePeerEffectKind,
  DevicePeerExchangeRemoteDesktopIceActionSchema,
  DevicePeerFailureCode,
  DevicePeerGetRemoteDesktopCapabilitiesActionSchema,
  DevicePeerGetRemoteDesktopLockStateActionSchema,
  DevicePeerCloseRemoteDesktopCredentialsActionSchema,
  DevicePeerGetRemoteDesktopFrameActionSchema,
  DevicePeerGetRemoteDesktopPermissionsActionSchema,
  DevicePeerHeartbeatRemoteDesktopActionSchema,
  DevicePeerListRecentDirectoriesActionSchema,
  DevicePeerListRemoteDesktopDisplayModesActionSchema,
  DevicePeerOpenTerminalActionSchema,
  DevicePeerRealpathActionSchema,
  DevicePeerResponsePhase,
  DevicePeerSendRemoteDesktopInputActionSchema,
  DevicePeerSetRemoteDesktopControlActionSchema,
  DevicePeerSetRemoteDesktopPresentationActionSchema,
  DevicePeerSetRemoteDesktopDisplayModeActionSchema,
  DevicePeerSetRemoteDesktopViewerDisplayActionSchema,
  DevicePeerRestoreRemoteDesktopViewerDisplayActionSchema,
  DevicePeerProbeRemoteDesktopPresentationActionSchema,
  DevicePeerShowRemoteDesktopPermissionGuideActionSchema,
  DevicePeerStartRemoteDesktopActionSchema,
  DevicePeerStartProcessActionSchema,
  DevicePeerStopRemoteDesktopActionSchema,
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopLockState,
  RemoteDesktopLockStateResultSchema,
  RemoteDesktopCredentialResultSchema,
  RemoteDesktopCredentialRequestSchema,
  RemoteDesktopClipboardContentBeginActionSchema,
  RemoteDesktopClipboardContentCancelActionSchema,
  RemoteDesktopClipboardContentCommitActionSchema,
  RemoteDesktopClipboardContentCopyActionSchema,
  RemoteDesktopClipboardContentSchema,
  RemoteDesktopClipboardContentReadActionSchema,
  type RemoteDesktopClipboardContentRequest,
  RemoteDesktopClipboardContentRequestSchema,
  RemoteDesktopClipboardContentWriteActionSchema,
  RemoteDesktopClipboardContentPasteActionSchema,
  RemoteDesktopClipboardSyncRequestSchema,
  RemoteDesktopClipboardSyncResultSchema,
  RemoteDesktopClipboardVersionRequestSchema,
  RemoteDesktopClipboardVersionResultSchema,
  RemoteDesktopClipboardTextCopyActionSchema,
  RemoteDesktopClipboardTextPasteActionSchema,
  type RemoteDesktopClipboardTextRequest,
  RemoteDesktopClipboardTextRequestSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopCursorSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopDisplayModeSchema,
  RemoteDesktopDisplayModeResultSchema,
  RemoteDesktopViewerDisplayResultSchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopHostMuteRequestSchema,
  RemoteDesktopHostMuteResultSchema,
  RemoteDesktopSystemActionKind,
  RemoteDesktopSystemActionRequestSchema,
  RemoteDesktopSystemActionResultSchema,
  RemoteDesktopPrivacyScreenRequestSchema,
  RemoteDesktopPrivacyScreenResultSchema,
  RemoteDesktopIceCandidateSchema,
  RemoteDesktopIceExchangeResultSchema,
  RemoteDesktopIceServerSchema,
  RemoteDesktopInputEventSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopOfferResultSchema,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopPresentationProofSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPointerMoveInputSchema,
  RemoteDesktopTextInputSchema,
  RemoteDesktopStartMode,
  RemoteDesktopVideoQuality,
  RemoteDesktopVideoSettingsSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeDevicePeerAgentExecutor,
  type NodeDevicePeerAgentEmission
} from "./node-agent-executor.js";
import { DevicePeerRemoteDesktopHostError } from "./ports.js";
import type {
  DevicePeerProcessHandle,
  DevicePeerProcessTransportPort,
  DevicePeerRemoteDesktopHostPort,
  DevicePeerTerminalExit,
  DevicePeerTerminalHandle,
  DevicePeerTerminalTransportPort
} from "./ports.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Node Device peer recent project ownership", () => {
  it("credentials admit authenticated controller and preserve the signal without a media lease", async () => {
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "credentials.json"), remoteDesktop: fixture.port });
    const signal = new AbortController().signal;
    const request = create(RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } });
    const command = remoteDesktopCommand({ case: "requestRemoteDesktopCredentials", value: request }, DevicePeerEffectKind.SIDE_EFFECT);
    const results: NodeDevicePeerAgentEmission[] = [];
    await executor.execute(command, signal, async result => { results.push(result); });
    expect(results.at(-1)?.payload).toMatchObject({ case: "remoteDesktopCredentials", value: { result: { case: "prepared" } } });
    expect(fixture.state.calls[0]).toMatchObject({ method: "requestCredentials", request: { controllerDeviceId: "controller-device", request, signal } });
    const status = remoteDesktopCommand({ case: "getRemoteDesktopLockState", value: create(DevicePeerGetRemoteDesktopLockStateActionSchema) }, DevicePeerEffectKind.READ_ONLY);
    expect((await execute(executor, status)).at(-1)?.payload).toMatchObject({ case: "remoteDesktopLockState", value: { state: RemoteDesktopLockState.LOCKED } });
    await executor.retire();
  });

  it("credentials reject invalid identity, effect, missing operation and bounded opaque inputs before dispatch", async () => {
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "credential-bounds.json"), remoteDesktop: fixture.port });
    const request = create(RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } });
    const command = remoteDesktopCommand({ case: "requestRemoteDesktopCredentials", value: request }, DevicePeerEffectKind.SIDE_EFFECT);
    await expect(execute(executor, { ...command, controllerDeviceId: "" })).rejects.toBeDefined();
    await expect(execute(executor, { ...command, effect: DevicePeerEffectKind.READ_ONLY })).rejects.toBeDefined();
    for (const bad of [
      create(RemoteDesktopCredentialRequestSchema),
      create(RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "x".repeat(4_097) } } }),
      create(RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "signed.offer", descriptor: "界".repeat(1_366) } } }),
      create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: "old-handle", ciphertext: "opaque" } } }),
      create(RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ciphertext: "非ASCII" } } })
    ]) await expect(execute(executor, remoteDesktopCommand({ case: "requestRemoteDesktopCredentials", value: bad }, DevicePeerEffectKind.SIDE_EFFECT))).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]); await executor.retire();
  });

  it("credentials preserve typed native failure and reject a reply for the wrong operation", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ requestCredentials: vi.fn(async () => { throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY, false); }) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "credential-result.json"), remoteDesktop: fixture.port });
    const command = remoteDesktopCommand({ case: "requestRemoteDesktopCredentials", value: create(RemoteDesktopCredentialRequestSchema, {
      request: { case: "prepare", value: {} }
    }) }, DevicePeerEffectKind.SIDE_EFFECT);
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CREDENTIAL_INVALID_IDENTITY } } });
    vi.mocked(fixture.port.requestCredentials).mockResolvedValueOnce(create(RemoteDesktopCredentialResultSchema, { result: { case: "closed", value: {} } }));
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({ case: "failure", value: { code: DevicePeerFailureCode.INTERNAL } });
    await executor.retire();
  });

  it("credentials cleanup dispatches only exact authenticated handle and reports native outcome unknown without retry", async () => {
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "credential-cleanup.json"), remoteDesktop: fixture.port });
    const cleanup = (handle: string) => remoteDesktopCommand({ case: "closeRemoteDesktopCredentials",
      value: create(DevicePeerCloseRemoteDesktopCredentialsActionSchema, { handle }) }, DevicePeerEffectKind.SIDE_EFFECT);
    await expect(execute(executor, cleanup("unbound"))).rejects.toBeDefined();
    expect(fixture.state.calls).toHaveLength(0);
    expect((await execute(executor, cleanup("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"))).at(-1)?.payload.case).toBe("acknowledgement");
    expect(fixture.state.calls[0]).toMatchObject({ method: "closeCredentials", request: { controllerDeviceId: "controller-device", handle: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });
    fixture.port.requestCredentials = async () => { throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN, false); };
    const command = remoteDesktopCommand({ case: "requestRemoteDesktopCredentials", value: create(RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } }) }, DevicePeerEffectKind.SIDE_EFFECT);
    expect((await execute(executor, command)).at(-1)).toMatchObject({ phase: DevicePeerResponsePhase.OUTCOME_UNKNOWN,
      payload: { case: "failure", value: { code: DevicePeerFailureCode.UNAVAILABLE, retryable: false, remoteDesktop: { reason: RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN } } } });
    await executor.retire();
  });
  it("records the canonical cwd of a successfully owned process", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    await mkdir(cwd);
    const process = new TestProcessHandle();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json"),
      processes: { open: async () => process }
    });

    await execute(executor, startProcess(cwd), (result) => {
      if (result.payload.case === "processStarted") setTimeout(() => process.finish(), 0);
    });
    const recent = await execute(executor, listRecentDirectories());

    expect(recent.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: {
        case: "recentDirectories",
        value: { directories: [expect.objectContaining({ path: cwd, name: "project" })] }
      }
    });
    await executor.retire();
  });

  it("does not record a process or Terminal whose runtime open fails", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    await mkdir(cwd);
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json"),
      processes: { open: async () => { throw new Error("process open failed"); } },
      terminals: { open: async () => { throw new Error("Terminal open failed"); } }
    });

    await execute(executor, startProcess(cwd));
    await execute(executor, openTerminal(cwd));
    const recent = await execute(executor, listRecentDirectories());

    expect(recent.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: { case: "recentDirectories", value: { directories: [] } }
    });
    await executor.retire();
  });

  it("does not let private recent-history failure cancel an owned process or Terminal", async () => {
    const root = await testRoot();
    const cwd = join(root, "project");
    const unsafeParent = join(root, "not-a-directory");
    await mkdir(cwd);
    await writeFile(unsafeParent, "regular file", "utf8");
    const process = new TestProcessHandle();
    const terminal = new TestTerminalHandle();
    const processes: DevicePeerProcessTransportPort = { open: async () => process };
    const terminals: DevicePeerTerminalTransportPort = { open: async () => terminal };
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(unsafeParent, "recent.json"),
      processes,
      terminals
    });

    const processResults = await execute(executor, startProcess(cwd), (result) => {
      if (result.payload.case === "processStarted") setTimeout(() => process.finish(), 0);
    });
    const terminalResults = await execute(executor, openTerminal(cwd), (result) => {
      if (result.payload.case === "terminalOpened") setTimeout(() => terminal.finish(), 0);
    });

    expect(processResults.map(result => result.payload.case)).toEqual([
      "acknowledgement",
      "processStarted",
      "processExited"
    ]);
    expect(terminalResults.map(result => result.payload.case)).toEqual([
      "acknowledgement",
      "terminalOpened",
      "terminalExited"
    ]);
    await executor.retire();
  });
});

describe("Node Device peer account-home ownership", () => {
  it("resolves only dot as the target account home while rejecting other relative paths", async () => {
    const root = await testRoot();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "private", "recent.json")
    });

    const results = await execute(executor, realpathCommand("."));
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.COMPLETED,
      payload: {
        case: "realpath",
        value: { path: resolve(await realpath(homedir())) }
      }
    });
    await expect(execute(executor, realpathCommand("project"))).rejects.toBeDefined();
    await executor.retire();
  });
});

describe("Node Device peer Remote Desktop host ownership", () => {
  it.each(["set", "restore"])("dispatches %s viewer display as an exact control-scoped effect", async operation => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-display.json"), remoteDesktop: fixture.port });
    const command = operation === "set" ? remoteDesktopCommand({ case: "setRemoteDesktopViewerDisplay",
      value: create(DevicePeerSetRemoteDesktopViewerDisplayActionSchema, { leaseId: "lease-1", controlGeneration: 1n, width: 1280, height: 720 }) }, DevicePeerEffectKind.SIDE_EFFECT)
      : remoteDesktopCommand({ case: "restoreRemoteDesktopViewerDisplay",
        value: create(DevicePeerRestoreRemoteDesktopViewerDisplayActionSchema, { leaseId: "lease-1", controlGeneration: 1n }) }, DevicePeerEffectKind.SIDE_EFFECT);
    const results = await execute(executor, command);
    expect(fixture.state.calls).toContainEqual(expect.objectContaining({ method: operation === "set" ? "setViewerDisplay" : "restoreViewerDisplay",
      request: expect.objectContaining({ controllerDeviceId: "controller-device", leaseId: "lease-1", controlGeneration: 1n }) }));
    expect(results.at(-1)?.payload).toMatchObject({ case: "remoteDesktopViewerDisplay", value: { lease: {
      leaseId: "lease-1", controlling: false, controlGeneration: 2n, display: { displayId: operation === "set" ? "mirror-1" : "display-1" } } } });
    await executor.retire();
  });
  it("rejects invalid viewer dimensions before effect dispatch and treats an invalid geometry receipt as unknown", async () => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost("darwin", { setViewerDisplay: vi.fn(async () => create(RemoteDesktopViewerDisplayResultSchema, {
      lease: { leaseId: "lease-1", controlling: false, controlGeneration: 2n, display: { displayId: "mirror-1", name: "Display", width: 1280, height: 800 } }
    })) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-boundary.json"), remoteDesktop: fixture.port });
    const command = (width: number) => remoteDesktopCommand({ case: "setRemoteDesktopViewerDisplay",
      value: create(DevicePeerSetRemoteDesktopViewerDisplayActionSchema, { leaseId: "lease-1", controlGeneration: 1n, width, height: 720 }) }, DevicePeerEffectKind.SIDE_EFFECT);
    for (const width of [319, 2561]) await expect(execute(executor, command(width))).rejects.toBeDefined();
    expect(fixture.port.setViewerDisplay).not.toHaveBeenCalled();
    const results = await execute(executor, command(1280));
    expect(results.at(-1)?.phase).toBe(DevicePeerResponsePhase.OUTCOME_UNKNOWN);
    await executor.retire();
  });
  it.each([
    { platform: "darwin" as const, width: 640, height: 360, accepted: true },
    { platform: "darwin" as const, width: 1280, height: 721, accepted: true },
    { platform: "darwin" as const, width: 4096, height: 2304, accepted: true },
    { platform: "darwin" as const, width: 1280, height: 722, accepted: false },
    { platform: "darwin" as const, width: 4097, height: 2304, accepted: false },
    { platform: "linux" as const, width: 1280, height: 720, accepted: true },
    { platform: "linux" as const, width: 640, height: 360, accepted: false }
  ])("validates viewer receipt $width x $height using trusted $platform capabilities", async ({ platform, width, height, accepted }) => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost(platform, {
      setViewerDisplay: vi.fn(async () => create(RemoteDesktopViewerDisplayResultSchema, {
        lease: { leaseId: "lease-1", controlling: false, controlGeneration: 2n,
          display: { displayId: "mirror-1", name: "Viewer", width, height } }
      }))
    });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-geometry.json"), remoteDesktop: fixture.port });
    const result = await execute(executor, viewerFitCommand());
    expect(fixture.state.calls[0]?.method).toBe("getCapabilities");
    expect(fixture.port.setViewerDisplay).toHaveBeenCalledOnce();
    expect(result.at(-1)?.phase).toBe(accepted ? DevicePeerResponsePhase.COMPLETED : DevicePeerResponsePhase.OUTCOME_UNKNOWN);
    if (accepted) expect(result.at(-1)?.payload).toMatchObject({ case: "remoteDesktopViewerDisplay",
      value: { lease: { display: { width, height } } } });
    await executor.retire();
  });

  it.each(["win32", "invalid", "failed"])("does not dispatch Fit without trusted supported platform evidence: %s", async condition => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost(); const read = fixture.port.getCapabilities;
    fixture.port.setViewerDisplay = vi.fn(fixture.port.setViewerDisplay);
    fixture.port.getCapabilities = async request => {
      if (condition === "failed") throw new Error("No platform receipt");
      const value = await read(request); value.platform = condition === "win32" ? "win32" : "unsupported";
      if (condition === "win32") {
        value.viewerDisplay = false; value.viewerDisplayRestore = false; value.displayModes = false;
        value.resolutionRestore = false; value.nativeCredentials = false; value.lockOnExit = false;
      }
      return value;
    };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-platform.json"), remoteDesktop: fixture.port });
    const result = await execute(executor, viewerFitCommand());
    expect(fixture.port.setViewerDisplay).not.toHaveBeenCalled(); expect(result.at(-1)?.phase).toBe(DevicePeerResponsePhase.FAILED);
    await executor.retire();
  });

  it.each(["control", "retired", "cancelled"])("rechecks %s authority after platform read before Fit dispatch", async condition => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost(); const read = fixture.port.getCapabilities;
    let finish!: () => void;
    fixture.port.getCapabilities = async request => { await new Promise<void>(resolve => { finish = resolve; }); return read(request); };
    fixture.port.setViewerDisplay = vi.fn(fixture.port.setViewerDisplay);
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-fence.json"), remoteDesktop: fixture.port });
    const abort = new AbortController(); const results: NodeDevicePeerAgentEmission[] = [];
    const pending = executor.execute(viewerFitCommand(), abort.signal, result => { results.push(result); });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (condition === "control") fixture.port.isControlCurrent = () => false;
    if (condition === "retired") await executor.retire();
    if (condition === "cancelled") abort.abort();
    finish(); await pending;
    expect(fixture.port.setViewerDisplay).not.toHaveBeenCalled();
    expect(results.at(-1)?.phase).toBe(condition === "cancelled" ? DevicePeerResponsePhase.ABORTED : DevicePeerResponsePhase.FAILED);
    await executor.retire();
  });

  it("retains unknown Fit outcome when a returned display belongs to the physical directory", async () => {
    const root = await testRoot(); const fixture = viewerRemoteDesktopHost("darwin", { setViewerDisplay: async () => create(RemoteDesktopViewerDisplayResultSchema, {
      lease: { leaseId: "lease-1", controlGeneration: 2n, display: { displayId: "display-1", name: "Source", width: 640, height: 360 } }
    }) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "viewer-source.json"), remoteDesktop: fixture.port });
    expect((await execute(executor, viewerFitCommand())).at(-1)?.phase).toBe(DevicePeerResponsePhase.OUTCOME_UNKNOWN);
    await executor.retire();
  });
  it.each([RemoteDesktopSystemActionKind.WORKSPACE_LEFT, RemoteDesktopSystemActionKind.WORKSPACE_RIGHT,
    RemoteDesktopSystemActionKind.SYSTEM_MENU])("dispatches typed system action %s with exact controller and control", async action => {
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "system-action.json"), remoteDesktop: fixture.port });
    const results = await execute(executor, remoteDesktopCommand({ case: "performRemoteDesktopSystemAction",
      value: create(RemoteDesktopSystemActionRequestSchema, { leaseId: "lease-1", controlGeneration: 1n, action }) }, DevicePeerEffectKind.SIDE_EFFECT));
    expect(fixture.state.calls).toContainEqual(expect.objectContaining({ method: "performSystemAction", request: expect.objectContaining({
      controllerDeviceId: "controller-device", leaseId: "lease-1", controlGeneration: 1n, action }) }));
    expect(results.at(-1)?.payload).toMatchObject({ case: "remoteDesktopSystemAction", value: { action } });
    await executor.retire();
  });

  it("rejects malformed or retired system actions before dispatch and never replays a wrong receipt", async () => {
    const root = await testRoot(); const fixture = remoteDesktopHost({ performSystemAction: vi.fn(async () =>
      create(RemoteDesktopSystemActionResultSchema, { action: RemoteDesktopSystemActionKind.WORKSPACE_RIGHT })) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "system-action-invalid.json"), remoteDesktop: fixture.port });
    const command = (action: RemoteDesktopSystemActionKind, generation = 1n) => remoteDesktopCommand({ case: "performRemoteDesktopSystemAction",
      value: create(RemoteDesktopSystemActionRequestSchema, { leaseId: "lease-1", controlGeneration: generation, action }) }, DevicePeerEffectKind.SIDE_EFFECT);
    await expect(execute(executor, command(RemoteDesktopSystemActionKind.UNSPECIFIED))).rejects.toBeDefined();
    await expect(execute(executor, command(RemoteDesktopSystemActionKind.WORKSPACE_LEFT, 0n))).rejects.toBeDefined();
    expect(fixture.port.performSystemAction).not.toHaveBeenCalled();
    const current = fixture.port.isControlCurrent;
    fixture.port.isControlCurrent = () => false;
    expect((await execute(executor, command(RemoteDesktopSystemActionKind.WORKSPACE_LEFT))).at(-1)?.payload)
      .toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED } } });
    expect(fixture.port.performSystemAction).not.toHaveBeenCalled();
    fixture.port.isControlCurrent = current;
    expect((await execute(executor, command(RemoteDesktopSystemActionKind.WORKSPACE_LEFT))).at(-1)?.phase).toBe(DevicePeerResponsePhase.OUTCOME_UNKNOWN);
    expect(fixture.port.performSystemAction).toHaveBeenCalledOnce();
    await executor.retire();
  });

  it.each(["linux", "win32"])("admits implemented %s capabilities without granting unsupported system actions", async platform => {
    const root = await testRoot(); const fixture = remoteDesktopHost(); const base = fixture.port.getCapabilities;
    fixture.port.getCapabilities = async request => {
      const value = await base(request); value.platform = platform;
      value.displayModes = platform === "linux"; value.resolutionRestore = platform === "linux"; value.lockOnExit = platform === "linux";
      value.nativeCredentials = platform === "linux"; value.workspaceNavigation = platform === "linux"; value.systemMenu = platform === "linux";
      return value;
    };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "current-capabilities.json"), remoteDesktop: fixture.port });
    const result = await execute(executor, remoteDesktopCommands().find(item => item.method === "getCapabilities")!.command);
    expect(result.at(-1)?.payload).toMatchObject({ case: "remoteDesktopCapabilities", value: {
      platform, cursorOverlay: true, hostMute: true, privacyScreen: true, nativeCredentials: platform === "linux",
      workspaceNavigation: platform === "linux", systemMenu: platform === "linux" } });
    await executor.retire();
  });

  it.each(["linux", "darwin"])("admits %s physical modes and viewer capabilities through the generated producer boundary", async platform => {
    const root = await testRoot(); const fixture = remoteDesktopHost(); const base = fixture.port.getCapabilities;
    fixture.port.getCapabilities = async request => { const value = await base(request); value.platform = platform;
      value.hostMute = false; value.lockOnExit = false; value.privacyScreen = false; value.nativeCredentials = false;
      value.viewerDisplay = true; value.viewerDisplayRestore = true; return value; };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "linux-modes.json"), remoteDesktop: fixture.port });
    const result = await execute(executor, remoteDesktopCommands().find(item => item.method === "getCapabilities")!.command);
    expect(result.at(-1)?.payload).toMatchObject({ case: "remoteDesktopCapabilities", value: { platform,
      displayModes: true, resolutionRestore: true, viewerDisplay: true, viewerDisplayRestore: true } });
    await executor.retire();
  });
  it.each(["linux", "win32"])("keeps independent terminal lock capability within its %s producer boundary", async platform => {
    const root = await testRoot(); const fixture = remoteDesktopHost(); const base = fixture.port.getCapabilities;
    fixture.port.getCapabilities = async request => { const value = await base(request); value.platform = platform;
      value.canControl = false; value.displayModes = false; value.resolutionRestore = false; value.cursorOverlay = false;
      value.hostMute = false; value.privacyScreen = false; value.nativeCredentials = false; value.lockOnExit = true;
      return value; };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "lock-capability.json"), remoteDesktop: fixture.port });
    const result = await execute(executor, remoteDesktopCommands().find(item => item.method === "getCapabilities")!.command);
    expect(result.at(-1)?.payload).toMatchObject(platform === "linux"
      ? { case: "remoteDesktopCapabilities", value: { platform, lockOnExit: true, canControl: false, nativeCredentials: false } }
      : { case: "failure" });
    await executor.retire();
  });
  it("temporary display mode dispatch adopts only a same-lease view-only monotonic receipt", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ setDisplayMode: vi.fn(async () => create(RemoteDesktopDisplayModeResultSchema, {
      lease: { leaseId: "lease-1", controlling: false, controlGeneration: 2n,
        display: { displayId: "display-1", name: "Display", width: 1_024, height: 640 } }
    })) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "temporary-mode.json"), remoteDesktop: fixture.port });
    const results = await execute(executor, remoteDesktopCommand({ case: "setRemoteDesktopDisplayMode",
      value: create(DevicePeerSetRemoteDesktopDisplayModeActionSchema, {
        leaseId: "lease-1", controlGeneration: 1n, modeId: "102", temporary: true
      }) }, DevicePeerEffectKind.SIDE_EFFECT));
    expect(fixture.port.setDisplayMode).toHaveBeenCalledWith(expect.objectContaining({
      controllerDeviceId: "controller-device", leaseId: "lease-1", controlGeneration: 1n, modeId: "102", temporary: true
    }));
    expect(results.at(-1)?.payload).toMatchObject({ case: "remoteDesktopDisplayMode", value: { lease: { leaseId: "lease-1", controlling: false } } });
    await executor.retire();
  });
  it.each(["wrong-lease", "controlling", "old-generation", "missing"])("temporary display mode rejects an invalid %s host receipt", async (kind) => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ setDisplayMode: vi.fn(async () => create(RemoteDesktopDisplayModeResultSchema, kind === "missing" ? {} : {
      lease: { leaseId: kind === "wrong-lease" ? "other-lease" : "lease-1", controlling: kind === "controlling",
        controlGeneration: kind === "old-generation" ? 1n : 2n,
        display: { displayId: "display-1", name: "Display", width: 1_024, height: 640 } }
    })) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "invalid-temporary.json"), remoteDesktop: fixture.port });
    const results = await execute(executor, remoteDesktopCommand({ case: "setRemoteDesktopDisplayMode",
      value: create(DevicePeerSetRemoteDesktopDisplayModeActionSchema, {
        leaseId: "lease-1", controlGeneration: 1n, modeId: "102", temporary: true
      }) }, DevicePeerEffectKind.SIDE_EFFECT));
    expect(results.at(-1)?.phase).toBe(DevicePeerResponsePhase.OUTCOME_UNKNOWN);
    expect(results.at(-1)?.payload.case).toBe("failure");
    await executor.retire();
  });
  it("temporary restore failure preserves its finite typed reason through Node dispatch", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ start: vi.fn(async () => { throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, false); }) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "restore-rejected.json"), remoteDesktop: fixture.port });
    const results = await execute(executor, remoteDesktopCommands().find((item) => item.method === "start")!.command);
    expect(results.at(-1)?.payload).toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, retryable: false } } });
    await executor.retire();
  });
  it("advertises only an installed host port and maps every typed action and result", async () => {
    const root = await testRoot();
    const withoutHost = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "without-host.json")
    });
    expect(withoutHost.capabilities).not.toContain(DevicePeerCapabilityKind.REMOTE_DESKTOP);
    await expect(execute(withoutHost, remoteDesktopCommands()[0]!.command)).rejects.toBeDefined();
    await withoutHost.retire();

    const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "with-host.json"),
      remoteDesktop: fixture.port
    });
    expect(executor.capabilities).toContain(DevicePeerCapabilityKind.REMOTE_DESKTOP);

    const commands = remoteDesktopCommands();
    for (const item of commands) {
      const results = await execute(executor, item.command);
      expect(results.map((result) => result.payload.case)).toEqual(["acknowledgement", item.payload]);
      expect(results.at(-1)?.phase).toBe(DevicePeerResponsePhase.COMPLETED);
    }
    expect(fixture.state.calls.map((call) => call.method)).toEqual(commands.map((item) => item.method));
    expect(fixture.state.calls.every((call) => call.request.controllerDeviceId === "controller-device")).toBe(true);

    await executor.retire();
    await executor.retire();
    expect(fixture.state.retireCalls).toBe(1);
  });

  it("passes fresh private ICE credentials only to the host and rejects expired or malformed configuration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "ice-host.json"), remoteDesktop: fixture.port });
    const expiresAt = { seconds: BigInt((Date.now() + 300_000) / 1_000), nanos: 0 };
    const turn = create(RemoteDesktopIceServerSchema, { urls: ["turn:relay.example.test:3478?transport=udp",
      "turn:relay.example.test:3478?transport=tcp", "turns:relay.example.test:5349?transport=tcp"],
      username: "ephemeral-user", credential: "ephemeral-secret", expiresAt });
    const offer = (iceServers: typeof turn[]) => remoteDesktopCommand({ case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, { leaseId: "lease-1", attemptId: "attempt-ice",
        offerSdp: "v=0\r\n", iceServers }) }, DevicePeerEffectKind.SIDE_EFFECT);
    const valid = [create(RemoteDesktopIceServerSchema, { urls: ["stun:stun.example.test:3478"], expiresAt }), turn];
    const result = await execute(executor, offer(valid));
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.state.calls[0]?.request).toMatchObject({ iceServers: valid });
    expect(JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value))
      .not.toContain("ephemeral-secret");
    for (const invalid of [
      { ...turn, expiresAt: undefined },
      { ...turn, expiresAt: { ...turn.expiresAt!, seconds: expiresAt.seconds - 180n } },
      { ...turn, urls: ["https://relay.example.test/secret"] },
      { ...turn, urls: ["stun:stun.example.test:3478"] },
      { ...turn, credential: undefined }
    ]) await expect(execute(executor, offer([create(RemoteDesktopIceServerSchema, invalid)]))).rejects.toBeDefined();
    expect(fixture.state.calls).toHaveLength(1);
    await executor.retire();
  });

  it("rejects over-bound commands before host dispatch and fails closed on over-bound host results", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      getFrame: async () => create(RemoteDesktopFrameResultSchema, {
        frame: create(RemoteDesktopFrameSchema, { jpeg: new Uint8Array(180_001) })
      })
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "bounded-host.json"),
      remoteDesktop: fixture.port
    });
    const oversizedOffer = remoteDesktopCommand({
      case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
        leaseId: "lease-1",
        attemptId: "attempt-1",
        offerSdp: "界".repeat(22_000)
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const zeroSequence = remoteDesktopCommand({
      case: "sendRemoteDesktopInput",
      value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
        leaseId: "lease-1",
        sequence: 0n
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const invalidVideoSettings = remoteDesktopCommand({
      case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
        leaseId: "lease-1",
        attemptId: "attempt-1",
        offerSdp: "v=0\r\n",
        settings: create(RemoteDesktopVideoSettingsSchema, {
          fps: 24,
          quality: RemoteDesktopVideoQuality.HD,
          audio: true
        })
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const invalidVideoQuality = remoteDesktopCommand({
      case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
        leaseId: "lease-1",
        attemptId: "attempt-1",
        offerSdp: "v=0\r\n",
        settings: create(RemoteDesktopVideoSettingsSchema, {
          fps: 30,
          quality: RemoteDesktopVideoQuality.UNSPECIFIED,
          audio: false
        })
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    const oversizedInput = remoteDesktopCommand({
      case: "sendRemoteDesktopInput",
      value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
        leaseId: "lease-1",
        sequence: 1n,
        events: Array.from({ length: 2 }, () => create(RemoteDesktopInputEventSchema, {
          event: {
            case: "text",
            value: create(RemoteDesktopTextInputSchema, { text: "界".repeat(3_000) })
          }
        }))
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);

    await expect(execute(executor, oversizedOffer)).rejects.toBeDefined();
    await expect(execute(executor, zeroSequence)).rejects.toBeDefined();
    await expect(execute(executor, invalidVideoSettings)).rejects.toBeDefined();
    await expect(execute(executor, invalidVideoQuality)).rejects.toBeDefined();
    await expect(execute(executor, oversizedInput)).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]);

    const frame = remoteDesktopCommands().find((item) => item.method === "getFrame")!;
    const results = await execute(executor, frame.command);
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: {
        case: "failure",
        value: { code: DevicePeerFailureCode.INTERNAL, retryable: false }
      }
    });
    await executor.retire();
  });

  it("rejects a cursor PNG whose first IHDR declares an over-bound raster", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      getFrame: async () => create(RemoteDesktopFrameResultSchema, {
        frame: create(RemoteDesktopFrameSchema, {
          jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          cursor: create(RemoteDesktopCursorSchema, {
            visible: true,
            x: 0.5,
            y: 0.25,
            width: 32,
            height: 32,
            hotX: 4,
            hotY: 5,
            png: cursorPngBytes(513, 32)
          })
        })
      })
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "cursor-raster-host.json"),
      remoteDesktop: fixture.port
    });

    const frame = remoteDesktopCommands().find((item) => item.method === "getFrame")!;
    const results = await execute(executor, frame.command);
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: {
        case: "failure",
        value: { code: DevicePeerFailureCode.INTERNAL, retryable: false }
      }
    });
    await executor.retire();
  });

  it("Linux system audio capability and finite failure cross Node without losing the view host", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ createOffer: vi.fn(async request => {
      if (request.settings?.audio) throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, false);
      return create(RemoteDesktopOfferResultSchema, { attemptId: request.attemptId, answerSdp: "v=0\r\n" });
    }) });
    const capabilities = fixture.port.getCapabilities;
    fixture.port.getCapabilities = async request => {
      const value = await capabilities(request);
      value.platform = "linux"; value.displayModes = false; value.resolutionRestore = false;
      value.hostMute = false; value.lockOnExit = false; value.privacyScreen = false; value.nativeCredentials = false;
      return value;
    };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "linux-audio.json"), remoteDesktop: fixture.port });
    const commands = remoteDesktopCommands();
    const capabilityResults = await execute(executor, commands.find(item => item.method === "getCapabilities")!.command);
    expect(capabilityResults.at(-1)?.payload).toMatchObject({ case: "remoteDesktopCapabilities", value: { platform: "linux", systemAudio: true } });
    const offer = (audio: boolean, attemptId: string) => remoteDesktopCommand({ case: "createRemoteDesktopOffer",
      value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, { leaseId: "lease-1", attemptId, offerSdp: "v=0\r\n",
        settings: { fps: 30, quality: RemoteDesktopVideoQuality.AUTO, audio }, cursorOverlay: false }) }, DevicePeerEffectKind.SIDE_EFFECT);
    const failure = await execute(executor, offer(true, "audio-attempt"));
    expect(failure.at(-1)).toMatchObject({ phase: DevicePeerResponsePhase.FAILED, payload: { case: "failure", value: {
      code: DevicePeerFailureCode.UNAVAILABLE, remoteDesktop: { reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, retryable: false } } } });
    const muted = await execute(executor, offer(false, "muted-attempt"));
    expect(muted.at(-1)).toMatchObject({ phase: DevicePeerResponsePhase.COMPLETED, payload: { case: "remoteDesktopOffer",
      value: { attemptId: "muted-attempt" } } });
    await execute(executor, commands.find(item => item.method === "heartbeat")!.command);
    expect(fixture.state.calls.some(call => call.method === "stop")).toBe(false);
    await executor.retire();
  });

  it("preserves capture pending as a retryable timeout without an unknown video effect", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ createOffer: vi.fn(async () => {
      throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CAPTURE_PENDING, true);
    }) });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "pending.json"), remoteDesktop: fixture.port });
    const command = remoteDesktopCommand({ case: "createRemoteDesktopOffer", value: create(DevicePeerCreateRemoteDesktopOfferActionSchema,
      { leaseId: "lease", attemptId: "portal-attempt", offerSdp: "offer", cursorOverlay: false }) }, DevicePeerEffectKind.SIDE_EFFECT);
    const results = await execute(executor, command);
    expect(results.at(-1)).toMatchObject({ payload: { case: "failure", value: { code: DevicePeerFailureCode.TIMEOUT,
      remoteDesktop: { reason: RemoteDesktopFailureReason.CAPTURE_PENDING, retryable: true } } } });
    await executor.retire();
  });

  it("preserves a bounded typed Remote Desktop domain failure", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      start: async () => {
        throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.BUSY, true);
      }
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "failure-host.json"),
      remoteDesktop: fixture.port
    });
    const start = remoteDesktopCommands().find((item) => item.method === "start")!;

    const results = await execute(executor, start.command);
    expect(results.at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: {
        case: "failure",
        value: {
          code: DevicePeerFailureCode.CONFLICT,
          retryable: true,
          remoteDesktop: { reason: RemoteDesktopFailureReason.BUSY, retryable: true }
        }
      }
    });
    await executor.retire();
  });

  it.each([
    [RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE, true, DevicePeerFailureCode.CAPABILITY_UNAVAILABLE],
    [RemoteDesktopFailureReason.HOST_MUTE_EXPIRED, false, DevicePeerFailureCode.NOT_FOUND]
  ] as const)("preserves typed host-mute failure %s", async (reason, retryable, code) => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      setHostMute: async () => { throw new DevicePeerRemoteDesktopHostError(reason, retryable); }
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "mute-failure-host.json"), remoteDesktop: fixture.port
    });
    const command = remoteDesktopCommands().find((item) => item.method === "setHostMute")!.command;
    expect((await execute(executor, command)).at(-1)).toMatchObject({
      phase: DevicePeerResponsePhase.FAILED,
      payload: { case: "failure", value: { code, retryable, remoteDesktop: { reason, retryable } } }
    });
    await executor.retire();
  });

  it("validates host-mute authority, side effect and exact generation before native dispatch", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "mute-admission-host.json"), remoteDesktop: fixture.port
    });
    for (const generation of [0n]) {
      const command = remoteDesktopCommand({
        case: "setRemoteDesktopHostMute",
        value: create(RemoteDesktopHostMuteRequestSchema, {
          leaseId: "lease-1", controlGeneration: generation, enabled: true
        })
      }, DevicePeerEffectKind.SIDE_EFFECT);
      await expect(execute(executor, command)).rejects.toBeDefined();
    }
    const command = remoteDesktopCommands().find((item) => item.method === "setHostMute")!.command;
    await expect(execute(executor, { ...command, controllerDeviceId: "" })).rejects.toBeDefined();
    await expect(execute(executor, { ...command, effect: DevicePeerEffectKind.READ_ONLY })).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]);
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({
      case: "remoteDesktopHostMute", value: { enabled: true }
    });
    expect(fixture.state.calls[0]).toMatchObject({
      method: "setHostMute", request: { controllerDeviceId: "controller-device", leaseId: "lease-1", controlGeneration: 1n }
    });
    await executor.retire();
  });

  it("rejects a malformed native host-mute result", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({
      setHostMute: async () => ({ enabled: "yes" } as never)
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "mute-result-host.json"), remoteDesktop: fixture.port
    });
    const command = remoteDesktopCommands().find((item) => item.method === "setHostMute")!.command;
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({
      case: "failure", value: { code: DevicePeerFailureCode.INTERNAL }
    });
    await executor.retire();
  });

  it("privacy dispatch validates exact authority and preserves the command cancellation signal", async () => {
    const root = await testRoot(); const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "privacy-host.json"), remoteDesktop: fixture.port });
    const command = (generation: bigint) => remoteDesktopCommand({ case: "setRemoteDesktopPrivacyScreen", value: create(RemoteDesktopPrivacyScreenRequestSchema, {
      leaseId: "lease-1", controlGeneration: generation, enabled: true, lockOnExit: true
    }) }, DevicePeerEffectKind.SIDE_EFFECT);
    await expect(execute(executor, command(0n))).rejects.toBeDefined();
    await expect(execute(executor, { ...command(1n), effect: DevicePeerEffectKind.READ_ONLY })).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]);
    expect((await execute(executor, command(7n))).at(-1)?.payload).toMatchObject({ case: "remoteDesktopPrivacyScreen", value: { enabled: true } });
    expect(fixture.state.calls[0]).toMatchObject({ method: "setPrivacyScreen", request: {
      controllerDeviceId: "controller-device", leaseId: "lease-1", controlGeneration: 7n, enabled: true, lockOnExit: true, signal: expect.any(AbortSignal)
    } });
    await executor.retire();
  });

  it.each([
    [RemoteDesktopFailureReason.PRIVACY_UNAVAILABLE, DevicePeerFailureCode.CAPABILITY_UNAVAILABLE],
    [RemoteDesktopFailureReason.PRIVACY_FAILED, DevicePeerFailureCode.UNAVAILABLE],
    [RemoteDesktopFailureReason.PRIVACY_EXPIRED, DevicePeerFailureCode.NOT_FOUND]
  ] as const)("privacy maps native typed failure %s without dropping its reason", async (reason, code) => {
    const root = await testRoot(); const fixture = remoteDesktopHost({ setPrivacyScreen: async () => { throw new DevicePeerRemoteDesktopHostError(reason, false); } });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "privacy-failure.json"), remoteDesktop: fixture.port });
    const command = remoteDesktopCommand({ case: "setRemoteDesktopPrivacyScreen", value: create(RemoteDesktopPrivacyScreenRequestSchema, {
      leaseId: "lease-1", controlGeneration: 1n, enabled: true
    }) }, DevicePeerEffectKind.SIDE_EFFECT);
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({ case: "failure", value: { code, retryable: false, remoteDesktop: { reason, retryable: false } } });
    await executor.retire();
  });

  it("dispatches lock exit with exact generation and ordinary stop without lock intent", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost();
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "lock-exit-host.json"), remoteDesktop: fixture.port
    });
    const action = (lockScreen: boolean, controlGeneration: bigint) => remoteDesktopCommand({
      case: "stopRemoteDesktop", value: create(DevicePeerStopRemoteDesktopActionSchema, {
        leaseId: "lease-1", lockScreen, controlGeneration
      })
    }, DevicePeerEffectKind.SIDE_EFFECT);
    await expect(execute(executor, action(true, 0n))).rejects.toBeDefined();
    expect(fixture.state.calls).toEqual([]);
    await execute(executor, action(true, 7n));
    expect(fixture.state.calls[0]).toMatchObject({ method: "stop", request: {
      controllerDeviceId: "controller-device", leaseId: "lease-1", lockScreen: true, controlGeneration: 7n
    } });
    await execute(executor, action(false, 0n));
    expect(fixture.state.calls[1]).toMatchObject({ method: "stop", request: { lockScreen: false, controlGeneration: 0n } });
    await executor.retire();
  });

  it.each([
    [RemoteDesktopFailureReason.LOCK_UNAVAILABLE, DevicePeerFailureCode.CAPABILITY_UNAVAILABLE],
    [RemoteDesktopFailureReason.LOCK_FAILED, DevicePeerFailureCode.UNAVAILABLE],
    [RemoteDesktopFailureReason.LOCK_EXPIRED, DevicePeerFailureCode.NOT_FOUND]
  ] as const)("preserves typed terminal lock failure %s", async (reason, code) => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ stop: async () => { throw new DevicePeerRemoteDesktopHostError(reason, false); } });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "lock-failure-host.json"), remoteDesktop: fixture.port
    });
    const command = remoteDesktopCommand({ case: "stopRemoteDesktop", value: create(DevicePeerStopRemoteDesktopActionSchema, {
      leaseId: "lease-1", lockScreen: true, controlGeneration: 1n
    }) }, DevicePeerEffectKind.SIDE_EFFECT);
    expect((await execute(executor, command)).at(-1)?.payload).toMatchObject({
      case: "failure", value: { code, retryable: false, remoteDesktop: { reason, retryable: false } }
    });
    await executor.retire();
  });

  it("uses the sync token and expected version for inline and staged writes without replaying an unsettled effect", async () => {
    const root = await testRoot();
    let enabled = false;
    let generation = 3n;
    let finish!: () => void;
    const pasted = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return "2"; });
    const fixture = remoteDesktopHost({
      setClipboardSync: async (request) => {
        if (enabled !== request.enabled) generation += 1n;
        enabled = request.enabled;
        return create(RemoteDesktopClipboardSyncResultSchema, { enabled, syncGeneration: generation });
      },
      isClipboardSyncCurrent: (request) => enabled && request.syncGeneration === generation,
      pasteClipboardContent: pasted
    });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "sync-host.json"), remoteDesktop: fixture.port });
    const set = (value: boolean) => execute(executor, remoteDesktopCommand({ case: "setRemoteDesktopClipboardSync",
      value: create(RemoteDesktopClipboardSyncRequestSchema, { leaseId: "lease-1", controlGeneration: 1n, enabled: value }) }, DevicePeerEffectKind.SIDE_EFFECT));
    await set(true);
    const token = generation;
    const call = (action: RemoteDesktopClipboardContentRequest["action"], options: MessageInitShape<typeof RemoteDesktopClipboardContentRequestSchema> = {}) =>
      execute(executor, remoteDesktopCommand({ case: "transferRemoteDesktopClipboardContent", value: create(RemoteDesktopClipboardContentRequestSchema, {
        leaseId: "lease-1", controlGeneration: 1n, sync: true, syncGeneration: token, action,
        ...(["copy", "begin", "paste"].includes(action.case ?? "") ? { version: "1" } : {}), ...options
      }) }, DevicePeerEffectKind.SIDE_EFFECT));
    expect((await call({ case: "copy", value: create(RemoteDesktopClipboardContentCopyActionSchema) }, { inline: true })).at(-1)?.payload)
      .toMatchObject({ case: "remoteDesktopClipboardContent", value: { data: '{"text":"rich text"}', length: 20 } });
    const json = '{"text":"new"}';
    const began = (await call({ case: "begin", value: create(RemoteDesktopClipboardContentBeginActionSchema, { length: json.length }) })).at(-1)?.payload;
    if (began?.case !== "remoteDesktopClipboardContent" || began.value.transferId === undefined) throw new Error("Missing sync staging.");
    const transferId = began.value.transferId;
    expect((await call({ case: "paste", value: create(RemoteDesktopClipboardContentPasteActionSchema, { data: json }) })).at(-1)?.payload)
      .toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_BUSY } } });
    await call({ case: "write", value: create(RemoteDesktopClipboardContentWriteActionSchema, { transferId, offset: 0, data: json }) });
    const pending = call({ case: "commit", value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId }) });
    await vi.waitFor(() => expect(pasted).toHaveBeenCalledOnce());
    expect((await call({ case: "commit", value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId }) })).at(-1)?.payload)
      .toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_BUSY } } });
    await set(false); await set(true);
    finish();
    expect((await pending).at(-1)?.payload).toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } } });
    expect(pasted).toHaveBeenCalledOnce();
    expect((await call({ case: "commit", value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId }) }, { syncGeneration: generation })).at(-1)?.payload)
      .toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } } });
    expect(pasted).toHaveBeenCalledOnce();
    await executor.retire();
  });

  it("validates sync-only inline requests and preserves typed counter conflicts", async () => {
    const root = await testRoot();
    const fixture = remoteDesktopHost({ pasteClipboardContent: async () => { throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CLIPBOARD_CHANGED, false); } });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "sync-validation.json"), remoteDesktop: fixture.port });
    const request = { leaseId: "lease-1", controlGeneration: 1n, sync: true, syncGeneration: 3n, version: "1",
      action: { case: "paste" as const, value: create(RemoteDesktopClipboardContentPasteActionSchema, { data: '{"text":"new"}' }) } };
    const call = (change: MessageInitShape<typeof RemoteDesktopClipboardContentRequestSchema> = {}) => execute(executor, remoteDesktopCommand({
      case: "transferRemoteDesktopClipboardContent", value: create(RemoteDesktopClipboardContentRequestSchema, { ...request, ...change }) }, DevicePeerEffectKind.SIDE_EFFECT));
    for (const change of [{ sync: false }, { syncGeneration: 0n }, { version: undefined }, { version: "nonnumeric" }, { inline: true }]) {
      await expect(call(change)).rejects.toMatchObject({ code: DevicePeerFailureCode.INVALID_REQUEST });
    }
    expect((await call()).at(-1)?.payload).toMatchObject({ case: "failure", value: { code: DevicePeerFailureCode.CONFLICT,
      retryable: false, remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_CHANGED } } });
    await executor.retire();
  });

  it("Linux clipboard carries opaque versions and capability opt-ins through the generated Node boundary", async () => {
    const root = await testRoot(); const fingerprint = "abcdef01".repeat(8);
    const fixture = remoteDesktopHost({
      getClipboardVersion: async () => create(RemoteDesktopClipboardVersionResultSchema, { version: fingerprint }),
      pasteClipboardContent: async request => { expect(request.version).toBe(fingerprint); return fingerprint; }
    });
    const readCapabilities = fixture.port.getCapabilities;
    fixture.port.getCapabilities = async request => {
      const value = await readCapabilities(request); value.platform = "linux";
      value.hostMute = false; value.lockOnExit = false; value.privacyScreen = false; value.nativeCredentials = false;
      value.displayModes = false; value.resolutionRestore = false; value.systemAudio = false; value.cursorOverlay = false; return value;
    };
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "linux-version.json"), remoteDesktop: fixture.port });
    expect((await execute(executor, remoteDesktopCommand({ case: "getRemoteDesktopCapabilities",
      value: create(DevicePeerGetRemoteDesktopCapabilitiesActionSchema) }, DevicePeerEffectKind.READ_ONLY))).at(-1)?.payload)
      .toMatchObject({ case: "remoteDesktopCapabilities", value: { platform: "linux", clipboardSync: true, clipboardInline: true } });
    expect((await execute(executor, remoteDesktopCommand({ case: "getRemoteDesktopClipboardVersion",
      value: create(RemoteDesktopClipboardVersionRequestSchema, { leaseId: "lease-1", controlGeneration: 1n, syncGeneration: 3n }) }, DevicePeerEffectKind.READ_ONLY))).at(-1)?.payload)
      .toMatchObject({ case: "remoteDesktopClipboardVersion", value: { version: fingerprint } });
    const call = (version: string) => execute(executor, remoteDesktopCommand({ case: "transferRemoteDesktopClipboardContent",
      value: create(RemoteDesktopClipboardContentRequestSchema, { leaseId: "lease-1", controlGeneration: 1n,
        sync: true, syncGeneration: 3n, version,
        action: { case: "paste", value: create(RemoteDesktopClipboardContentPasteActionSchema, { data: '{"text":"new"}' }) } }) }, DevicePeerEffectKind.SIDE_EFFECT));
    expect((await call(fingerprint)).at(-1)?.payload).toMatchObject({ case: "remoteDesktopClipboardContent", value: { version: fingerprint } });
    await expect(call(fingerprint.toUpperCase())).rejects.toMatchObject({ code: DevicePeerFailureCode.INVALID_REQUEST });
    await executor.retire();
  });

  it("Linux unknown clipboard writes keep the shared effect occupied until settlement and consume their stage once", async () => {
    const root = await testRoot(); let settle!: () => void;
    const pasted = vi.fn(async () => { await new Promise<void>(resolve => { settle = resolve; });
      throw new DevicePeerRemoteDesktopHostError(RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, false, true); });
    const fixture = remoteDesktopHost({ pasteClipboardContent: pasted });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "linux-unknown.json"), remoteDesktop: fixture.port });
    const call = (action: RemoteDesktopClipboardContentRequest["action"]) => execute(executor, remoteDesktopCommand({
      case: "transferRemoteDesktopClipboardContent", value: create(RemoteDesktopClipboardContentRequestSchema, {
        leaseId: "lease-1", controlGeneration: 1n, sync: true, syncGeneration: 3n,
        ...(action.case === "begin" ? { version: "a".repeat(64) } : {}), action }) }, DevicePeerEffectKind.SIDE_EFFECT));
    const data = '{"text":"once"}';
    const began = (await call({ case: "begin", value: create(RemoteDesktopClipboardContentBeginActionSchema, { length: data.length }) })).at(-1)?.payload;
    if (began?.case !== "remoteDesktopClipboardContent" || began.value.transferId === undefined) throw new Error("Missing clipboard stage.");
    const transferId = began.value.transferId;
    await call({ case: "write", value: create(RemoteDesktopClipboardContentWriteActionSchema, { transferId, offset: 0, data }) });
    const commit = { case: "commit" as const, value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId }) };
    const pending = call(commit); await vi.waitFor(() => expect(pasted).toHaveBeenCalledOnce());
    expect((await call(commit)).at(-1)?.payload).toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_BUSY } } });
    settle(); expect((await pending).at(-1)).toMatchObject({ phase: DevicePeerResponsePhase.OUTCOME_UNKNOWN,
      payload: { case: "failure", value: { retryable: false, remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, retryable: false } } } });
    expect((await call(commit)).at(-1)?.payload).toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } } });
    expect(pasted).toHaveBeenCalledOnce(); await executor.retire();
  });

  it("clears only retired sync staging on local host authority changes and unsubscribes on retirement", async () => {
    const root = await testRoot();
    let syncCurrent = true;
    let changed!: () => void;
    const unsubscribe = vi.fn();
    const fixture = remoteDesktopHost({
      onClipboardAuthorityChanged: (listener) => { changed = listener; return unsubscribe; },
      isClipboardSyncCurrent: () => syncCurrent
    });
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "sync-retirement.json"), remoteDesktop: fixture.port });
    const call = (action: RemoteDesktopClipboardContentRequest["action"], sync = true) => execute(executor, remoteDesktopCommand({
      case: "transferRemoteDesktopClipboardContent", value: create(RemoteDesktopClipboardContentRequestSchema, {
        leaseId: "lease-1", controlGeneration: 1n, sync, syncGeneration: sync ? 3n : 0n,
        ...(sync && action.case === "copy" ? { version: "1" } : {}), action
      }) }, DevicePeerEffectKind.SIDE_EFFECT));
    const copied = (await call({ case: "copy", value: create(RemoteDesktopClipboardContentCopyActionSchema) })).at(-1)?.payload;
    if (copied?.case !== "remoteDesktopClipboardContent" || copied.value.transferId === undefined) throw new Error("Missing sync staging.");
    const oldId = copied.value.transferId;
    syncCurrent = false;
    changed();
    syncCurrent = true;
    expect((await call({ case: "read", value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId: oldId, offset: 0 }) })).at(-1)?.payload)
      .toMatchObject({ case: "failure", value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } } });
    const explicit = (await call({ case: "copy", value: create(RemoteDesktopClipboardContentCopyActionSchema) }, false)).at(-1)?.payload;
    if (explicit?.case !== "remoteDesktopClipboardContent" || explicit.value.transferId === undefined) throw new Error("Missing explicit staging.");
    syncCurrent = false;
    changed();
    expect((await call({ case: "read", value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId: explicit.value.transferId, offset: 0 }) }, false)).at(-1)?.payload)
      .toMatchObject({ case: "remoteDesktopClipboardContent", value: { data: '{"text":"rich text"}' } });
    await executor.retire();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps explicit text and rich clipboard transfers bounded and consumes paste before effect", async () => {
    const root = await testRoot();
    const pasted: unknown[] = [];
    const fixture = remoteDesktopHost({
      pasteClipboardContent: async (request) => { pasted.push(request.content); }
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "clipboard-host.json"),
      remoteDesktop: fixture.port
    });

    const copiedText = await execute(executor, remoteDesktopClipboardTextCommand({
      case: "copy",
      value: create(RemoteDesktopClipboardTextCopyActionSchema)
    }));
    expect(copiedText.at(-1)?.payload).toMatchObject({
      case: "remoteDesktopClipboardText",
      value: { text: "text" }
    });
    await execute(executor, remoteDesktopClipboardTextCommand({
      case: "paste",
      value: create(RemoteDesktopClipboardTextPasteActionSchema, { text: "phone text" })
    }));

    const copiedContent = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "copy",
      value: create(RemoteDesktopClipboardContentCopyActionSchema)
    }));
    const copyPayload = copiedContent.at(-1)?.payload;
    if (copyPayload?.case !== "remoteDesktopClipboardContent" || copyPayload.value.transferId === undefined) {
      throw new Error("Expected a rich clipboard transfer.");
    }
    const transferId = copyPayload.value.transferId;
    const read = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "read",
      value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId, offset: 0 })
    }));
    expect(read.at(-1)?.payload).toMatchObject({
      case: "remoteDesktopClipboardContent",
      value: { data: JSON.stringify({ text: "rich text" }) }
    });
    const staleRead = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "read",
      value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId, offset: 0 })
    }, 2n));
    expect(staleRead.at(-1)?.payload).toMatchObject({
      case: "failure",
      value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
    });
    await execute(executor, remoteDesktopCommands().find((item) => item.method === "setPresentation")!.command);
    const invalidatedByPresentation = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "read",
      value: create(RemoteDesktopClipboardContentReadActionSchema, { transferId, offset: 0 })
    }));
    expect(invalidatedByPresentation.at(-1)?.payload).toMatchObject({
      case: "failure",
      value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
    });

    const json = JSON.stringify({ html: "<b>portable</b>", url: "https://example.test/item" });
    const begun = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "begin",
      value: create(RemoteDesktopClipboardContentBeginActionSchema, { length: json.length })
    }));
    const beginPayload = begun.at(-1)?.payload;
    if (beginPayload?.case !== "remoteDesktopClipboardContent" || beginPayload.value.transferId === undefined) {
      throw new Error("Expected a rich clipboard paste transfer.");
    }
    const pasteId = beginPayload.value.transferId;
    await execute(executor, remoteDesktopClipboardContentCommand({
      case: "write",
      value: create(RemoteDesktopClipboardContentWriteActionSchema, {
        transferId: pasteId,
        offset: 0,
        data: json
      })
    }));
    await execute(executor, remoteDesktopClipboardContentCommand({
      case: "commit",
      value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId: pasteId })
    }));
    expect(pasted).toMatchObject([{ html: "<b>portable</b>", url: "https://example.test/item" }]);

    const repeated = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "commit",
      value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId: pasteId })
    }));
    expect(repeated.at(-1)?.payload).toMatchObject({
      case: "failure",
      value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
    });
    expect(pasted).toHaveLength(1);
    await executor.retire();
  });

  it("fences rich transfer state against a target-local control generation change", async () => {
    vi.useFakeTimers();
    const root = await testRoot();
    let current = true;
    const pasted: unknown[] = [];
    const fixture = remoteDesktopHost({
      isControlCurrent: () => current,
      pasteClipboardContent: async (request) => { pasted.push(request.content); }
    });
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "clipboard-current-host.json"),
      remoteDesktop: fixture.port
    });

    const copied = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "copy",
      value: create(RemoteDesktopClipboardContentCopyActionSchema)
    }));
    const copiedPayload = copied.at(-1)?.payload;
    if (copiedPayload?.case !== "remoteDesktopClipboardContent"
      || copiedPayload.value.transferId === undefined) {
      throw new Error("Expected a rich clipboard copy transfer.");
    }
    vi.advanceTimersByTime(59_000);
    current = false;
    const staleRead = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "read",
      value: create(RemoteDesktopClipboardContentReadActionSchema, {
        transferId: copiedPayload.value.transferId,
        offset: 0
      })
    }));
    expect(staleRead.at(-1)?.payload).toMatchObject({
      case: "failure",
      value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
    });
    vi.advanceTimersByTime(1_001);
    current = true;
    const expiredRead = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "read",
      value: create(RemoteDesktopClipboardContentReadActionSchema, {
        transferId: copiedPayload.value.transferId,
        offset: 0
      })
    }));
    expect(expiredRead.at(-1)?.payload).toMatchObject({
      case: "failure",
      value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
    });

    const json = JSON.stringify({ text: "kept" });
    const split = 5;
    const begun = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "begin",
      value: create(RemoteDesktopClipboardContentBeginActionSchema, { length: json.length })
    }));
    const begunPayload = begun.at(-1)?.payload;
    if (begunPayload?.case !== "remoteDesktopClipboardContent"
      || begunPayload.value.transferId === undefined) {
      throw new Error("Expected a rich clipboard paste transfer.");
    }
    const transferId = begunPayload.value.transferId;
    await execute(executor, remoteDesktopClipboardContentCommand({
      case: "write",
      value: create(RemoteDesktopClipboardContentWriteActionSchema, {
        transferId,
        offset: 0,
        data: json.slice(0, split)
      })
    }));

    current = false;
    const staleWrite = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "write",
      value: create(RemoteDesktopClipboardContentWriteActionSchema, {
        transferId,
        offset: split,
        data: "BAD"
      })
    }));
    const staleCancel = await execute(executor, remoteDesktopClipboardContentCommand({
      case: "cancel",
      value: create(RemoteDesktopClipboardContentCancelActionSchema, { transferId })
    }));
    for (const result of [staleWrite, staleCancel]) {
      expect(result.at(-1)?.payload).toMatchObject({
        case: "failure",
        value: { remoteDesktop: { reason: RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } }
      });
    }

    current = true;
    await execute(executor, remoteDesktopClipboardContentCommand({
      case: "write",
      value: create(RemoteDesktopClipboardContentWriteActionSchema, {
        transferId,
        offset: split,
        data: json.slice(split)
      })
    }));
    await execute(executor, remoteDesktopClipboardContentCommand({
      case: "commit",
      value: create(RemoteDesktopClipboardContentCommitActionSchema, { transferId })
    }));
    expect(pasted).toMatchObject([{ text: "kept" }]);
    await executor.retire();
  });
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-device-peer-recents-"));
  roots.push(root);
  return root;
}

async function execute(
  executor: NodeDevicePeerAgentExecutor,
  command: DevicePeerCommand,
  observe?: (result: NodeDevicePeerAgentEmission) => void
): Promise<NodeDevicePeerAgentEmission[]> {
  const results: NodeDevicePeerAgentEmission[] = [];
  await executor.execute(command, new AbortController().signal, (result) => {
    results.push(result);
    observe?.(result);
  });
  return results;
}

function startProcess(cwd: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.PROCESS,
    effect: DevicePeerEffectKind.SIDE_EFFECT,
    action: {
      case: "startProcess",
      value: create(DevicePeerStartProcessActionSchema, {
        executable: process.execPath,
        workingDirectory: cwd
      })
    }
  });
}

function openTerminal(cwd: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.TERMINAL,
    effect: DevicePeerEffectKind.SIDE_EFFECT,
    action: {
      case: "openTerminal",
      value: create(DevicePeerOpenTerminalActionSchema, {
        executable: process.execPath,
        workingDirectory: cwd,
        columns: 80,
        rows: 24
      })
    }
  });
}

function listRecentDirectories(): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.FILES,
    effect: DevicePeerEffectKind.READ_ONLY,
    action: {
      case: "listRecentDirectories",
      value: create(DevicePeerListRecentDirectoriesActionSchema, { maximumEntries: 100 })
    }
  });
}

function realpathCommand(path: string): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.FILES,
    effect: DevicePeerEffectKind.READ_ONLY,
    action: {
      case: "realpath",
      value: create(DevicePeerRealpathActionSchema, { path })
    }
  });
}

function viewerFitCommand() {
  return remoteDesktopCommand({ case: "setRemoteDesktopViewerDisplay",
    value: create(DevicePeerSetRemoteDesktopViewerDisplayActionSchema, { leaseId: "lease-1", controlGeneration: 1n, width: 1280, height: 720 }) }, DevicePeerEffectKind.SIDE_EFFECT);
}

function viewerRemoteDesktopHost(platform: "darwin" | "linux" = "darwin", overrides: Partial<DevicePeerRemoteDesktopHostPort> = {}) {
  const fixture = remoteDesktopHost(overrides); const read = fixture.port.getCapabilities;
  fixture.port.getCapabilities = async request => {
    const value = await read(request); value.platform = platform; value.viewerDisplay = true; value.viewerDisplayRestore = true; return value;
  };
  return fixture;
}

function remoteDesktopHost(overrides: Partial<DevicePeerRemoteDesktopHostPort> = {}): {
  readonly port: DevicePeerRemoteDesktopHostPort;
  readonly state: {
    readonly calls: { readonly method: string; readonly request: { readonly controllerDeviceId: string } }[];
    retireCalls: number;
  };
} {
  const state = {
    calls: [] as { readonly method: string; readonly request: { readonly controllerDeviceId: string } }[],
    retireCalls: 0
  };
  const display = create(RemoteDesktopDisplaySchema, {
    displayId: "display-1",
    name: "Primary display",
    width: 1920,
    height: 1080
  });
  const permissions = create(RemoteDesktopPermissionsSchema, {
    screenRecording: RemoteDesktopPermissionStatus.GRANTED,
    accessibility: RemoteDesktopPermissionStatus.GRANTED
  });
  const record = (method: string, request: { readonly controllerDeviceId: string }): void => {
    state.calls.push({ method, request });
  };
  const port: DevicePeerRemoteDesktopHostPort = {
    async getLockState(request) {
      record("getLockState", request);
      return create(RemoteDesktopLockStateResultSchema, { state: RemoteDesktopLockState.LOCKED });
    },
    async requestCredentials(request) {
      record("requestCredentials", request);
      return create(RemoteDesktopCredentialResultSchema, { result: { case: "prepared", value: { descriptor: "identity" } } });
    },
    async closeCredentials(request) { record("closeCredentials", request); },
    async getCapabilities(request) {
      record("getCapabilities", request);
      return create(RemoteDesktopCapabilitiesSchema, {
        protocolVersion: 1,
        enabled: true,
        canControl: true,
        platform: "darwin",
        displays: [display],
        permissions,
        automaticReconnect: true,
        connectionTakeover: true,
        webrtcVideo: true,
        trickleIce: true,
        jpegFallback: true,
        clipboardText: true,
        clipboardContent: true,
        videoSettings: true,
        systemAudio: true,
        backgroundViewing: true,
        displayModes: true,
        cursorOverlay: true,
        hostMute: true,
        lockOnExit: true,
        clipboardSync: true, clipboardInline: true, privacyScreen: true, nativeCredentials: true, resolutionRestore: true
      });
    },
    async getPermissions(request) {
      record("getPermissions", request);
      return permissions;
    },
    async showPermissionGuide(request) { record("showPermissionGuide", request); },
    async start(request) {
      record("start", request);
      return create(RemoteDesktopLeaseSchema, {
        leaseId: "lease-1",
        display,
        controlling: true,
        controlGeneration: 1n
      });
    },
    async heartbeat(request) {
      record("heartbeat", request);
      return create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n });
    },
    async stop(request) { record("stop", request); },
    async setControl(request) {
      record("setControl", request);
      return create(RemoteDesktopControlStateSchema, {
        controlling: request.enabled,
        controlGeneration: 2n
      });
    },
    async setHostMute(request) {
      record("setHostMute", request);
      return create(RemoteDesktopHostMuteResultSchema, { enabled: request.enabled });
    },
    async performSystemAction(request) {
      record("performSystemAction", request);
      return create(RemoteDesktopSystemActionResultSchema, { action: request.action });
    },
    async setPrivacyScreen(request) {
      record("setPrivacyScreen", request);
      return create(RemoteDesktopPrivacyScreenResultSchema, { enabled: request.enabled });
    },
    async setPresentation(request) {
      record("setPresentation", request);
      return create(RemoteDesktopControlStateSchema, {
        controlling: false,
        controlGeneration: 2n
      });
    },
    async probePresentation(request) {
      record("probePresentation", request);
      return create(RemoteDesktopPresentationProofSchema, {
        leaseId: request.leaseId,
        proofSequence: 1n
      });
    },
    async sendInput(request) { record("sendInput", request); },
    async createOffer(request) {
      record("createOffer", request);
      return create(RemoteDesktopOfferResultSchema, {
        attemptId: request.attemptId,
        answerSdp: "v=0\r\n"
      });
    },
    async exchangeIce(request) {
      record("exchangeIce", request);
      return create(RemoteDesktopIceExchangeResultSchema, {
        attemptId: request.attemptId,
        candidates: [remoteDesktopIceCandidate()],
        next: request.after + 1,
        complete: false
      });
    },
    async getFrame(request) {
      record("getFrame", request);
      return create(RemoteDesktopFrameResultSchema, {
        frame: create(RemoteDesktopFrameSchema, {
          jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          cursor: create(RemoteDesktopCursorSchema, {
            visible: true,
            x: 0.5,
            y: 0.25,
            width: 32,
            height: 32,
            hotX: 4,
            hotY: 5,
            png: cursorPngBytes()
          })
        })
      });
    },
    async listDisplayModes(request) {
      record("listDisplayModes", request);
      return [create(RemoteDesktopDisplayModeSchema, {
        modeId: "101",
        width: 1920,
        height: 1080,
        current: true,
        native: true
      })];
    },
    async setDisplayMode(request) { record("setDisplayMode", request); return create(RemoteDesktopDisplayModeResultSchema); },
    async setViewerDisplay(request) { record("setViewerDisplay", request); return create(RemoteDesktopViewerDisplayResultSchema, {
      lease: { leaseId: request.leaseId, controlling: false, controlGeneration: request.controlGeneration + 1n,
        display: { displayId: "mirror-1", name: "Display", width: request.width, height: request.height } }
    }); },
    async restoreViewerDisplay(request) { record("restoreViewerDisplay", request); return create(RemoteDesktopViewerDisplayResultSchema, {
      lease: { leaseId: request.leaseId, controlling: false, controlGeneration: request.controlGeneration + 1n, display }
    }); },
    isControlCurrent() { return true; },
    isClipboardSyncCurrent() { return true; },
    async setClipboardSync(request) {
      record("setClipboardSync", request);
      return create(RemoteDesktopClipboardSyncResultSchema, { enabled: request.enabled, syncGeneration: 3n });
    },
    async getClipboardVersion(request) {
      record("getClipboardVersion", request);
      return create(RemoteDesktopClipboardVersionResultSchema, { version: "1" });
    },
    async copyClipboardText(request) { record("copyClipboardText", request); return "text"; },
    async pasteClipboardText(request) { record("pasteClipboardText", request); },
    async copyClipboardContent(request) {
      record("copyClipboardContent", request);
      return create(RemoteDesktopClipboardContentSchema, { text: "rich text" });
    },
    async pasteClipboardContent(request) { record("pasteClipboardContent", request); },
    async retire() { state.retireCalls += 1; },
    ...overrides
  };
  return { port, state };
}

function remoteDesktopCommands(): readonly {
  readonly method: string;
  readonly payload: NodeDevicePeerAgentEmission["payload"]["case"];
  readonly command: DevicePeerCommand;
}[] {
  return [
    {
      method: "getCapabilities",
      payload: "remoteDesktopCapabilities",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopCapabilities",
        value: create(DevicePeerGetRemoteDesktopCapabilitiesActionSchema)
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "getPermissions",
      payload: "remoteDesktopPermissions",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopPermissions",
        value: create(DevicePeerGetRemoteDesktopPermissionsActionSchema)
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "showPermissionGuide",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "showRemoteDesktopPermissionGuide",
        value: create(DevicePeerShowRemoteDesktopPermissionGuideActionSchema)
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "start",
      payload: "remoteDesktopLease",
      command: remoteDesktopCommand({
        case: "startRemoteDesktop",
        value: create(DevicePeerStartRemoteDesktopActionSchema, {
          displayId: "display-1",
          mode: RemoteDesktopStartMode.NEW
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "heartbeat",
      payload: "remoteDesktopControlState",
      command: remoteDesktopCommand({
        case: "heartbeatRemoteDesktop",
        value: create(DevicePeerHeartbeatRemoteDesktopActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "stop",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "stopRemoteDesktop",
        value: create(DevicePeerStopRemoteDesktopActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "setControl",
      payload: "remoteDesktopControlState",
      command: remoteDesktopCommand({
        case: "setRemoteDesktopControl",
        value: create(DevicePeerSetRemoteDesktopControlActionSchema, { leaseId: "lease-1", enabled: false })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "setHostMute",
      payload: "remoteDesktopHostMute",
      command: remoteDesktopCommand({
        case: "setRemoteDesktopHostMute",
        value: create(RemoteDesktopHostMuteRequestSchema, {
          leaseId: "lease-1", controlGeneration: 1n, enabled: true
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "setPrivacyScreen", payload: "remoteDesktopPrivacyScreen",
      command: remoteDesktopCommand({ case: "setRemoteDesktopPrivacyScreen", value: create(RemoteDesktopPrivacyScreenRequestSchema, {
        leaseId: "lease-1", controlGeneration: 1n, enabled: true, lockOnExit: false
      }) }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "setPresentation",
      payload: "remoteDesktopControlState",
      command: remoteDesktopCommand({
        case: "setRemoteDesktopPresentation",
        value: create(DevicePeerSetRemoteDesktopPresentationActionSchema, {
          leaseId: "lease-1",
          enabled: true
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "probePresentation",
      payload: "remoteDesktopPresentationProof",
      command: remoteDesktopCommand({
        case: "probeRemoteDesktopPresentation",
        value: create(DevicePeerProbeRemoteDesktopPresentationActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "sendInput",
      payload: "acknowledgement",
      command: remoteDesktopCommand({
        case: "sendRemoteDesktopInput",
        value: create(DevicePeerSendRemoteDesktopInputActionSchema, {
          leaseId: "lease-1",
          sequence: 1n,
          events: [create(RemoteDesktopInputEventSchema, {
            event: {
              case: "move",
              value: create(RemoteDesktopPointerMoveInputSchema, { x: 0.25, y: 0.75 })
            }
          })]
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "createOffer",
      payload: "remoteDesktopOffer",
      command: remoteDesktopCommand({
        case: "createRemoteDesktopOffer",
        value: create(DevicePeerCreateRemoteDesktopOfferActionSchema, {
          leaseId: "lease-1",
          attemptId: "attempt-1",
          offerSdp: "v=0\r\n",
          cursorOverlay: false,
          settings: create(RemoteDesktopVideoSettingsSchema, {
            fps: 60,
            quality: RemoteDesktopVideoQuality.HD,
            audio: true
          })
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "exchangeIce",
      payload: "remoteDesktopIce",
      command: remoteDesktopCommand({
        case: "exchangeRemoteDesktopIce",
        value: create(DevicePeerExchangeRemoteDesktopIceActionSchema, {
          leaseId: "lease-1",
          attemptId: "attempt-1",
          candidates: [remoteDesktopIceCandidate()],
          after: 0
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    },
    {
      method: "getFrame",
      payload: "remoteDesktopFrame",
      command: remoteDesktopCommand({
        case: "getRemoteDesktopFrame",
        value: create(DevicePeerGetRemoteDesktopFrameActionSchema, {
          leaseId: "lease-1",
          cursorOverlay: false
        })
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "listDisplayModes",
      payload: "remoteDesktopDisplayModes",
      command: remoteDesktopCommand({
        case: "listRemoteDesktopDisplayModes",
        value: create(DevicePeerListRemoteDesktopDisplayModesActionSchema, { leaseId: "lease-1" })
      }, DevicePeerEffectKind.READ_ONLY)
    },
    {
      method: "setDisplayMode",
      payload: "remoteDesktopDisplayMode",
      command: remoteDesktopCommand({
        case: "setRemoteDesktopDisplayMode",
        value: create(DevicePeerSetRemoteDesktopDisplayModeActionSchema, {
          leaseId: "lease-1",
          controlGeneration: 1n,
          modeId: "101"
        })
      }, DevicePeerEffectKind.SIDE_EFFECT)
    }
  ];
}

function remoteDesktopCommand(
  action: DevicePeerCommand["action"],
  effect: DevicePeerEffectKind
): DevicePeerCommand {
  return create(DevicePeerCommandSchema, {
    capability: DevicePeerCapabilityKind.REMOTE_DESKTOP,
    effect,
    controllerDeviceId: "controller-device",
    action
  });
}

function remoteDesktopClipboardTextCommand(
  action: RemoteDesktopClipboardTextRequest["action"],
  controlGeneration = 1n
): DevicePeerCommand {
  return remoteDesktopCommand({
    case: "transferRemoteDesktopClipboardText",
    value: create(RemoteDesktopClipboardTextRequestSchema, {
      leaseId: "lease-1",
      controlGeneration,
      action
    })
  }, DevicePeerEffectKind.SIDE_EFFECT);
}

function remoteDesktopClipboardContentCommand(
  action: RemoteDesktopClipboardContentRequest["action"],
  controlGeneration = 1n
): DevicePeerCommand {
  return remoteDesktopCommand({
    case: "transferRemoteDesktopClipboardContent",
    value: create(RemoteDesktopClipboardContentRequestSchema, {
      leaseId: "lease-1",
      controlGeneration,
      action
    })
  }, DevicePeerEffectKind.SIDE_EFFECT);
}

function remoteDesktopIceCandidate() {
  return create(RemoteDesktopIceCandidateSchema, {
    candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "fragment"
  });
}

function cursorPngBytes(width = 32, height = 32): Uint8Array {
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class TestProcessHandle extends EventEmitter implements DevicePeerProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    this.finish();
    return true;
  }

  finish(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
  }
}

class TestTerminalHandle implements DevicePeerTerminalHandle {
  readonly pid = 2;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: DevicePeerTerminalExit) => void>();
  #finished = false;

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.add(listener);
    return { dispose: () => { this.#data.delete(listener); } };
  }

  onExit(listener: (event: DevicePeerTerminalExit) => void): { dispose(): void } {
    this.#exit.add(listener);
    return { dispose: () => { this.#exit.delete(listener); } };
  }

  write(): Promise<void> { return Promise.resolve(); }
  resize(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
  resume(): void {}
  kill(): Promise<void> { this.finish(); return Promise.resolve(); }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const listener of this.#exit) listener({ exitCode: 0, processExitConfirmed: true });
  }
}
