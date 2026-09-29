import { afterEach, describe, expect, it, vi } from "vitest";

import { createDedicatedHardwareSdkManifestIntegrity } from "../dedicated-hardware-sdk.js";
import {
  createDedicatedHardwareHostClient,
  type DedicatedHardwareUtilityConnection,
  type DedicatedHardwareUtilityFactory
} from "./host-client.js";
import type {
  DedicatedHardwareSdkIdentity,
  DedicatedHardwareUtilityMessage,
  DedicatedHardwareUtilityRequest
} from "./protocol.js";
import { createDefaultDedicatedHardwareSettings } from "./settings.js";

const SDK_INTEGRITY = `sha512-${"A".repeat(86)}==`;
const SDK_MANIFEST_WITHOUT_INTEGRITY = {
  version: 1 as const,
  packageName: "@worklouder/device-kit-oai" as const,
  packageVersion: "0.1.11",
  redistributionGrantId: "approved-grant",
  license: { relativePath: "LICENSE.vendor.txt", integrity: SDK_INTEGRITY },
  target: {
    platform: "win32" as const,
    architecture: "x64" as const,
    electronModulesAbi: 148,
    nodeApiVersion: 10
  },
  entry: { relativePath: "adapter.mjs", integrity: SDK_INTEGRITY },
  nativeAddons: [{
    identity: "@vendor/device-native@0.1.11",
    relativePath: "native/device.node",
    integrity: SDK_INTEGRITY,
    abi: "electron-modules" as const
  }],
  files: [
    { relativePath: "LICENSE.vendor.txt", size: 1, integrity: SDK_INTEGRITY },
    { relativePath: "adapter.mjs", size: 1, integrity: SDK_INTEGRITY },
    { relativePath: "native/device.node", size: 1, integrity: SDK_INTEGRITY }
  ],
  directoryIntegrity: SDK_INTEGRITY
};
const STAGED_SDK: DedicatedHardwareSdkIdentity = {
  kind: "staged",
  stagingDirectory: process.platform === "win32" ? "D:\\Joko\\runtime\\device-kit" : "/opt/joko/device-kit",
  manifest: {
    ...SDK_MANIFEST_WITHOUT_INTEGRITY,
    manifestIntegrity: createDedicatedHardwareSdkManifestIntegrity(SDK_MANIFEST_WITHOUT_INTEGRITY)
  }
};

class FakeHost implements DedicatedHardwareUtilityConnection {
  readonly sent: DedicatedHardwareUtilityRequest[] = [];
  terminated = false;
  failSend = false;

  constructor(readonly callbacks: Parameters<DedicatedHardwareUtilityFactory["spawn"]>[0]) {}

  send(request: DedicatedHardwareUtilityRequest): void {
    if (this.failSend) throw new Error("closed");
    this.sent.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  message(message: DedicatedHardwareUtilityMessage | unknown): void {
    this.callbacks.onMessage(message);
  }

  exit(): void {
    this.callbacks.onExit();
  }

  handshake(): Extract<DedicatedHardwareUtilityRequest, { kind: "handshake" }> {
    const request = this.sent.find((candidate) => candidate.kind === "handshake");
    if (request?.kind !== "handshake") throw new Error("No handshake was sent.");
    return request;
  }

  ready(): void {
    const request = this.handshake();
    this.message({
      version: 1,
      generation: request.generation,
      requestId: request.requestId,
      kind: "ready"
    });
  }

  stopped(): void {
    const request = [...this.sent].reverse().find((candidate) => candidate.kind === "shutdown");
    if (request?.kind !== "shutdown") throw new Error("No shutdown was sent.");
    this.message({
      version: 1,
      generation: request.generation,
      requestId: request.requestId,
      kind: "stopped"
    });
  }
}

function fixture(sdk: DedicatedHardwareSdkIdentity = STAGED_SDK) {
  const hosts: FakeHost[] = [];
  const factory: DedicatedHardwareUtilityFactory = {
    spawn: vi.fn(async (callbacks) => {
      const host = new FakeHost(callbacks);
      hosts.push(host);
      return host;
    })
  };
  const client = createDedicatedHardwareHostClient({
    factory,
    keymapBackupDirectory: process.platform === "win32" ? "D:\\Joko\\keymap" : "/tmp/joko-keymap",
    resolveSdkIdentity: vi.fn(async () => sdk)
  });
  return { client, factory, hosts };
}

function desired(enabled = true, preview = false, model: "codex-micro" | "creator-micro-2" = "codex-micro") {
  return { settings: { ...createDefaultDedicatedHardwareSettings(model), enabled }, preview };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function stateMessage(host: FakeHost, overrides: Record<string, unknown> = {}): DedicatedHardwareUtilityMessage {
  const handshake = host.handshake();
  const model = overrides.model === "creator-micro-2" ? "creator-micro-2" : "codex-micro";
  return {
    version: 1,
    generation: handshake.generation,
    kind: "state",
    model,
    status: "connected",
    reason: null,
    devicePresent: true,
    transport: "usb",
    firmwareVersion: "1.2.3",
    batteryPercent: 80,
    charging: false,
    inputPermission: "not-required",
    keymap: model === "creator-micro-2"
      ? { phase: "idle", backupAvailable: false, failure: null }
      : null,
    ...overrides
  } as DedicatedHardwareUtilityMessage;
}

describe("dedicated hardware utility host client", () => {
  afterEach(() => vi.useRealTimers());

  it("starts lazily and projects an explicit unavailable SDK without loading a private bundle", async () => {
    vi.useFakeTimers();
    const { client, factory, hosts } = fixture({ kind: "unavailable" });
    expect(factory.spawn).not.toHaveBeenCalled();
    expect(client.getConnectionState("codex-micro").status).toBe("disabled");

    client.setDesiredState("codex-micro", desired());
    expect(client.getConnectionState("codex-micro").status).toBe("connecting");
    await settle();
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect(hosts[0]!.handshake().sdk).toEqual({ kind: "unavailable" });
    hosts[0]!.ready();

    expect(client.getConnectionState("codex-micro")).toMatchObject({
      status: "unavailable", reason: "sdk-unavailable", devicePresent: null
    });
    expect(hosts[0]!.sent.filter((request) => request.kind === "set-desired-state")).toHaveLength(1);
    hosts[0]!.message(stateMessage(hosts[0]!, { status: "connected" }));
    expect(client.getConnectionState("codex-micro").reason).toBe("sdk-unavailable");
  });

  it("fences stale generations and restarts after a five-second handshake watchdog", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("codex-micro", desired());
    await settle();
    const first = hosts[0]!;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.terminated).toBe(true);
    expect(client.getConnectionState("codex-micro")).toMatchObject({ status: "error", reason: "connection-timeout" });
    first.ready();
    expect(client.getConnectionState("codex-micro").status).toBe("error");

    await vi.advanceTimersByTimeAsync(499);
    expect(hosts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(hosts).toHaveLength(2);
    expect(hosts[1]!.handshake().generation).toBeGreaterThan(first.handshake().generation);
  });

  it("opens the crash breaker after more than five unstable failures", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => { throw new Error("crashed"); });
    const client = createDedicatedHardwareHostClient({
      factory: { spawn },
      keymapBackupDirectory: process.platform === "win32" ? "D:\\Joko\\keymap" : "/tmp/joko-keymap",
      resolveSdkIdentity: async () => STAGED_SDK
    });
    client.setDesiredState("codex-micro", desired());
    await settle();
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }
    expect(spawn).toHaveBeenCalledTimes(6);
    expect(client.getConnectionState("codex-micro")).toMatchObject({ status: "unavailable", reason: "host-crash" });
    client.setDesiredState("codex-micro", desired(true, true));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spawn).toHaveBeenCalledTimes(6);
    client.retry();
    await settle();
    expect(spawn).toHaveBeenCalledTimes(7);
  });

  it("resets crash backoff only after ten stable seconds", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("codex-micro", desired());
    await settle();
    hosts[0]!.ready();
    hosts[0]!.exit();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    hosts[1]!.ready();
    await vi.advanceTimersByTimeAsync(10_000);
    hosts[1]!.exit();
    await vi.advanceTimersByTimeAsync(499);
    expect(hosts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(hosts).toHaveLength(3);
  });

  it("pauses after a permission failure until explicit retry", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    const input = vi.fn();
    client.subscribeInput(input);
    client.setDesiredState("codex-micro", desired());
    await settle();
    const first = hosts[0]!;
    first.ready();
    first.message(stateMessage(first, {
      status: "error", reason: "permission-required", inputPermission: "denied"
    }));
    expect(client.getConnectionState("codex-micro")).toMatchObject({
      status: "error", reason: "permission-required", inputPermission: "denied"
    });
    expect(first.sent.at(-1)?.kind).toBe("shutdown");
    first.message({
      version: 1,
      generation: first.handshake().generation,
      kind: "input",
      model: "codex-micro",
      sequence: 0,
      input: { kind: "key", key: "ACT12", pressed: true }
    });
    expect(input).not.toHaveBeenCalled();
    first.stopped();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hosts).toHaveLength(1);

    client.retry();
    await settle();
    expect(hosts).toHaveLength(2);
  });

  it("fails every enabled model closed when the shared host loses permission and ignores desired-state churn", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("codex-micro", desired());
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    await settle();
    const first = hosts[0]!;
    first.ready();
    first.message(stateMessage(first));
    first.message(stateMessage(first, { model: "creator-micro-2", transport: "bluetooth" }));
    expect(client.getConnectionState("creator-micro-2").status).toBe("connected");

    first.message(stateMessage(first, {
      status: "error", reason: "permission-required", inputPermission: "denied"
    }));
    expect(client.getConnectionState("codex-micro")).toMatchObject({
      status: "error", reason: "permission-required", inputPermission: "denied"
    });
    expect(client.getConnectionState("creator-micro-2")).toMatchObject({
      status: "error", reason: "permission-required", inputPermission: "unknown"
    });
    first.stopped();

    client.setDesiredState("creator-micro-2", desired(true, true, "creator-micro-2"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hosts).toHaveLength(1);
    client.retry();
    await settle();
    expect(hosts).toHaveLength(2);
  });

  it("replays only idempotent desired state, never an ephemeral probe", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("codex-micro", desired(true, true));
    await settle();
    hosts[0]!.ready();
    expect(client.probe("codex-micro")).toBe(true);
    expect(hosts[0]!.sent.filter((request) => request.kind === "probe")).toHaveLength(1);
    hosts[0]!.exit();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    hosts[1]!.ready();

    expect(hosts[1]!.sent.filter((request) => request.kind === "set-desired-state")).toHaveLength(1);
    expect(hosts[1]!.sent.filter((request) => request.kind === "probe")).toHaveLength(0);
    expect((hosts[1]!.sent.find((request) => request.kind === "set-desired-state") as { preview: boolean }).preview).toBe(true);
  });

  it("drops duplicate input sequence values and fails closed on malformed current-generation messages", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    const input = vi.fn();
    client.subscribeInput(input);
    client.setDesiredState("codex-micro", desired());
    await settle();
    const host = hosts[0]!;
    host.ready();
    const generation = host.handshake().generation;
    const message = {
      version: 1, generation, kind: "input", model: "codex-micro", sequence: 4,
      input: { kind: "key", key: "ACT12", pressed: true }
    } as const;
    host.message(message);
    host.message(message);
    host.message({ ...message, sequence: 3 });
    expect(input).toHaveBeenCalledOnce();

    host.message({ ...message, sequence: 5, extra: true });
    expect(host.terminated).toBe(true);
    expect(client.getConnectionState("codex-micro")).toMatchObject({ status: "error", reason: "host-crash" });
  });

  it("sends disabled desired state before graceful shutdown and enforces the timeout fence", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("codex-micro", desired());
    await settle();
    const host = hosts[0]!;
    host.ready();
    client.setDesiredState("codex-micro", desired(false));

    const tail = host.sent.slice(-2).map((request) => request.kind);
    expect(tail).toEqual(["set-desired-state", "shutdown"]);
    expect(client.getConnectionState("codex-micro").status).toBe("disabled");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(host.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hosts).toHaveLength(1);
  });

  it("runs one bounded all-disabled keymap inspection and stops after the exact state is acknowledged", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    const inspection = client.inspectCreatorKeymapRecovery();
    await settle();
    const host = hosts[0]!;
    host.ready();
    const request = host.sent.find((candidate) => candidate.kind === "inspect-keymap");
    expect(request?.kind).toBe("inspect-keymap");
    host.message(stateMessage(host, {
      model: "creator-micro-2",
      status: "disabled",
      devicePresent: null,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    }));
    host.message({
      version: 1,
      generation: host.handshake().generation,
      requestId: request!.requestId,
      kind: "ack"
    });

    await expect(inspection).resolves.toMatchObject({
      model: "creator-micro-2",
      status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    });
    expect(host.sent.at(-1)?.kind).toBe("shutdown");
    host.stopped();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hosts).toHaveLength(1);
  });

  it("bounds a dispatched recovery inspection even when the utility never acknowledges it", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    const inspection = client.inspectCreatorKeymapRecovery();
    await settle();
    hosts[0]!.ready();
    expect(hosts[0]!.sent.some((candidate) => candidate.kind === "inspect-keymap")).toBe(true);

    const rejected = expect(inspection).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(hosts[0]!.sent.at(-1)?.kind).toBe("shutdown");
  });

  it("does not cancel a pending inspection when the last desired model becomes disabled", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    const inspection = client.inspectCreatorKeymapRecovery();
    client.setDesiredState("creator-micro-2", desired(false, false, "creator-micro-2"));
    await settle();
    const host = hosts[0]!;
    host.ready();
    const request = host.sent.find((candidate) => candidate.kind === "inspect-keymap");
    expect(request?.kind).toBe("inspect-keymap");
    expect(host.sent.filter((candidate) => candidate.kind === "shutdown")).toHaveLength(0);
    host.message(stateMessage(host, {
      model: "creator-micro-2",
      status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    }));
    host.message({
      version: 1,
      generation: host.handshake().generation,
      requestId: request!.requestId,
      kind: "ack"
    });
    await expect(inspection).resolves.toMatchObject({
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    });
    expect(host.sent.at(-1)?.kind).toBe("shutdown");
  });

  it("lets explicit all-disabled recovery leave a historical permission pause without hanging", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    await settle();
    const first = hosts[0]!;
    first.ready();
    first.message(stateMessage(first, {
      model: "creator-micro-2",
      status: "error",
      reason: "permission-required",
      inputPermission: "denied",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    client.setDesiredState("creator-micro-2", desired(false, false, "creator-micro-2"));
    first.stopped();
    expect(hosts).toHaveLength(1);

    const recovery = client.recoverCreatorKeymap();
    await settle();
    expect(hosts).toHaveLength(2);
    const second = hosts[1]!;
    second.ready();
    const request = second.sent.find((candidate) => candidate.kind === "recover-keymap");
    expect(request?.kind).toBe("recover-keymap");
    second.message(stateMessage(second, {
      model: "creator-micro-2",
      status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    }));
    second.message({
      version: 1,
      generation: second.handshake().generation,
      requestId: request!.requestId,
      kind: "ack"
    });
    await expect(recovery).resolves.toMatchObject({
      status: "disabled",
      keymap: { phase: "idle", backupAvailable: false, failure: null }
    });
  });

  it("preserves a known recovery requirement when a restarted SDK becomes unavailable", async () => {
    vi.useFakeTimers();
    const hosts: FakeHost[] = [];
    const factory: DedicatedHardwareUtilityFactory = {
      spawn: vi.fn(async (callbacks) => {
        const host = new FakeHost(callbacks);
        hosts.push(host);
        return host;
      })
    };
    let resolution = 0;
    const client = createDedicatedHardwareHostClient({
      factory,
      keymapBackupDirectory: process.platform === "win32" ? "D:\\Joko\\keymap" : "/tmp/joko-keymap",
      resolveSdkIdentity: vi.fn(async () => resolution++ === 0 ? STAGED_SDK : { kind: "unavailable" as const })
    });
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    await settle();
    hosts[0]!.ready();
    hosts[0]!.message(stateMessage(hosts[0]!, {
      model: "creator-micro-2",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    hosts[0]!.exit();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    hosts[1]!.ready();
    hosts[1]!.message(stateMessage(hosts[1]!, {
      model: "creator-micro-2",
      status: "unavailable",
      reason: "sdk-unavailable",
      devicePresent: null,
      transport: null,
      firmwareVersion: null,
      batteryPercent: null,
      charging: null,
      inputPermission: "unknown",
      keymap: { phase: "unavailable", backupAvailable: null, failure: null }
    }));

    expect(client.getConnectionState("creator-micro-2")).toMatchObject({
      status: "unavailable",
      reason: "sdk-unavailable",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    });
  });

  it("resolves enabled recovery only after an exact occupied state and rejects invalid ack ordering", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    await settle();
    const first = hosts[0]!;
    first.ready();
    first.message(stateMessage(first, {
      model: "creator-micro-2",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    const recovery = client.recoverCreatorKeymap();
    const request = first.sent.find((candidate) => candidate.kind === "recover-keymap");
    expect(request?.kind).toBe("recover-keymap");
    first.message(stateMessage(first, {
      model: "creator-micro-2",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    }));
    first.message({
      version: 1,
      generation: first.handshake().generation,
      requestId: request!.requestId,
      kind: "ack"
    });
    await expect(recovery).resolves.toMatchObject({
      status: "connected",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    });
    expect(first.sent.some((candidate) => candidate.kind === "shutdown")).toBe(false);

    first.message(stateMessage(first, {
      model: "creator-micro-2",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    const invalid = client.recoverCreatorKeymap();
    const requests = first.sent.filter((candidate) => candidate.kind === "recover-keymap");
    const invalidRequest = requests.at(-1)!;
    first.message({
      version: 1,
      generation: first.handshake().generation,
      requestId: invalidRequest.requestId,
      kind: "ack"
    });
    await expect(invalid).rejects.toThrow("remains required");
  });

  it("redispatches a pending recovery with the same deadline after a planned host restart", async () => {
    vi.useFakeTimers();
    const { client, hosts } = fixture();
    client.setDesiredState("creator-micro-2", desired(true, false, "creator-micro-2"));
    await settle();
    const first = hosts[0]!;
    first.ready();
    first.message(stateMessage(first, {
      model: "creator-micro-2",
      keymap: { phase: "error", backupAvailable: true, failure: "recovery-required" }
    }));
    const recovery = client.recoverCreatorKeymap();
    const firstRequest = first.sent.find((candidate) => candidate.kind === "recover-keymap");
    expect(firstRequest?.kind).toBe("recover-keymap");

    client.retry();
    expect(first.sent.at(-1)?.kind).toBe("shutdown");
    first.stopped();
    await settle();
    const second = hosts[1]!;
    second.ready();
    const secondRequest = second.sent.find((candidate) => candidate.kind === "recover-keymap");
    expect(secondRequest?.kind).toBe("recover-keymap");
    expect(secondRequest?.generation).not.toBe(firstRequest?.generation);
    second.message(stateMessage(second, {
      model: "creator-micro-2",
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    }));
    second.message({
      version: 1,
      generation: second.handshake().generation,
      requestId: secondRequest!.requestId,
      kind: "ack"
    });
    await expect(recovery).resolves.toMatchObject({
      keymap: { phase: "occupied", backupAvailable: true, failure: null }
    });
  });
});
