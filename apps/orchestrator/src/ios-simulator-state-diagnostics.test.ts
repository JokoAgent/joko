import { OperationalStore } from "@joko/store";
import type { WdaDriverHealth } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorStateDiagnosticsCoordinator } from "./ios-simulator-state-diagnostics.js";
import type { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";

const SCOPE = { sessionId: "state-task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "iPhone", state: "Booted",
  isAvailable: true, runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

function fixture(frames?: Pick<SimulatorViewerFrameCoordinator, "snapshot">) {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "State task", binding: { opaqueRef: "state-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindExternalDevice(SCOPE, DEVICE);
  const instance = ownership.attachViewer(SCOPE, route(bound));
  let now = Date.parse("2026-09-25T00:00:00.000Z");
  let ready = true;
  let health: () => Promise<WdaDriverHealth> = async () => ({ ready: true, message: "token=supersecret123 /private/var/host-key",
    osName: "iOS", osVersion: "19.0", sdkVersion: "19.0", deviceIp: "127.0.0.1" });
  let screen = async () => ({ viewport: { width: 393, height: 852, orientation: "PORTRAIT" as const },
    screenMap: { snapshotId: "snapshot-1", instanceId: instance.instanceId, generation: instance.generation,
      interactionEpoch: 1, capturedAt: new Date(now).toISOString(), truncated: false,
      elements: [{ elementId: "button-1", role: "button", label: "user-secret-screen-text",
        value: null, enabled: true, visible: true, frame: null }] } });
  const coordinator = new SimulatorStateDiagnosticsCoordinator(ownership, {
    isReady: () => ready, observeHealth: () => health()
  }, { screenMap: () => screen() }, () => now, frames);
  return { store, instance, coordinator, setReady: (value: boolean) => { ready = value; },
    setNow: (value: number) => { now = value; }, setHealth: (value: typeof health) => { health = value; },
    setScreen: (value: typeof screen) => { screen = value; } };
}

it("reports only current production MJPEG metadata, never the frame body", async () => {
  const snapshot = () => ({ adapter: "wda-mjpeg" as const, encoding: "jpeg" as const,
    state: "streaming" as const, sequence: 12, lastFrameAt: "2026-09-25T00:00:00.000Z" });
  const h = fixture({ snapshot });
  try {
    const captured = await h.coordinator.capture(SCOPE, route(h.instance));
    expect(captured.stream).toEqual(snapshot());
    const entry = h.coordinator.get(SCOPE, captured.diagnosticsId);
    expect(entry.data.stream).toEqual(snapshot());
    expect(JSON.stringify(entry)).not.toMatch(/user-secret-screen-text|"bytes"|"jpeg":\[/u);
  } finally { h.store.close(); }
});

it("captures live driver state without retaining screen text, credentials or host paths", async () => {
  const h = fixture();
  try {
    const captured = await h.coordinator.capture(SCOPE, route(h.instance));
    expect(captured).toMatchObject({ instance: { instanceId: h.instance.instanceId },
      health: { ready: true, osName: "iOS" }, orientation: "PORTRAIT",
      screenMap: { elements: [{ label: "user-secret-screen-text" }] },
      stream: null, driverDiagnostics: { running: true, logTail: "",
        capabilityReport: null, nativeSidecar: null }, diagnosticsId: expect.any(String) });
    expect(JSON.stringify(captured.health)).not.toMatch(/supersecret123|\/private\/var\/host-key/u);
    const entry = h.coordinator.get(SCOPE, captured.diagnosticsId);
    expect(entry).toMatchObject({ kind: "capture_state", sessionId: SCOPE.sessionId,
      data: { screenMap: { elementCount: 1, truncated: false }, stream: null } });
    expect(JSON.stringify(entry)).not.toMatch(/user-secret-screen-text|supersecret123|\/private\//u);
    expect(() => h.coordinator.get({ ...SCOPE, sessionId: "other-task" }, captured.diagnosticsId))
      .toThrowError(/does not exist/iu);
    expect(() => h.coordinator.get({ ...SCOPE, generation: 2 }, captured.diagnosticsId))
      .toThrowError(/does not exist/iu);
    h.setReady(false);
    expect(() => h.coordinator.get(SCOPE, captured.diagnosticsId)).toThrowError(/not ready/iu);
    h.setReady(true);
    h.setNow(Date.parse(entry.expiresAt));
    expect(() => h.coordinator.get(SCOPE, captured.diagnosticsId)).toThrowError(/expired/iu);
  } finally { h.store.close(); }
});

it("does not publish a stale or cancelled asynchronous state capture", async () => {
  const h = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.setHealth(async () => { entered(); await gate; return { ready: true, message: null,
    osName: "iOS", osVersion: "19.0", sdkVersion: null, deviceIp: null }; });
  try {
    const pending = h.coordinator.capture(SCOPE, route(h.instance));
    await started;
    h.setReady(false);
    release();
    await expect(pending).rejects.toMatchObject({ code: "DRIVER_RUNTIME_LOST" });
    h.setReady(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(h.coordinator.capture(SCOPE, route(h.instance), aborted.signal))
      .rejects.toMatchObject({ code: "OBSERVATION_CANCELLED" });
  } finally { release(); h.store.close(); }
});

it("bounds diagnostic retention and invalidates entries on route cleanup", async () => {
  const h = fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      ids.push((await h.coordinator.capture(SCOPE, route(h.instance))).diagnosticsId);
    }
    expect(() => h.coordinator.get(SCOPE, ids[0]!)).toThrowError(/does not exist/iu);
    expect(h.coordinator.get(SCOPE, ids[64]!).diagnosticsId).toBe(ids[64]);
    h.coordinator.clear(h.instance.instanceId);
    expect(() => h.coordinator.get(SCOPE, ids[64]!)).toThrowError(/does not exist/iu);
  } finally { h.store.close(); }
});
