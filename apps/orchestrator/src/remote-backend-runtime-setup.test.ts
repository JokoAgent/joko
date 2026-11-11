import type { RemoteProcessTransportPort, RemoteSshTransportLease } from "@joko/remote-ssh";
import type { RemoteHostRecord, StoredTarget } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import {
  RemoteBackendRuntimeSetupError,
  RemoteBackendRuntimeSetupManager,
  type RemoteBackendRuntimeInstallEvent,
  type RemoteBackendRuntimeSetupProvider
} from "./remote-backend-runtime-setup.js";
import { RemoteCodexInstallationError } from "./remote-codex-installation.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

describe("RemoteBackendRuntimeSetupManager", () => {
  it("derives the provider from an exact trusted Target and returns a capability-neutral probe", async () => {
    const fixture = setupFixture();
    const runtime = await fixture.manager.probe(scope(fixture));
    expect(runtime).toMatchObject({
      targetId: "target-a",
      hostId: "host-a",
      displayName: "Fixture Runtime",
      expectedVersion: "1.2.3",
      installedVersion: "1.2.3",
      state: "ready",
      canInstall: false,
      canReinstall: true,
      canUninstall: true,
      targetRevision: 3n,
      hostRevision: 5n
    });
    expect(fixture.capture).toHaveBeenCalledWith("target-a", "host-a", undefined);
  });

  it("keeps an install alive after its observer disconnects and replays the same request", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const fixture = setupFixture({
      probe: vi.fn(async () => ({ state: "not_installed" as const })),
      install: vi.fn<RemoteBackendRuntimeSetupProvider["install"]>(async (context, _reinstall, signal, onPhase) => {
        context.beginEffect();
        onPhase("downloading");
        await gate;
        expect(signal.aborted).toBe(false);
        onPhase("validating");
        return { state: "ready" as const, installedVersion: "1.2.3" };
      })
    });
    const input = { ...scope(fixture), requestId: "request-a", reinstall: false };
    const observer = new AbortController();
    const iterator = fixture.manager.install(input, observer.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { phase: "probing", sequence: 1n } });
    observer.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(() => fixture.manager.install({ ...input, requestId: "request-b" })).toThrowError(RemoteBackendRuntimeSetupError);
    finish();
    const replay = await collect(fixture.manager.install(input));
    expect(replay.map((event) => event.phase)).toEqual(["probing", "downloading", "validating", "complete"]);
    expect(replay.at(-1)?.runtime.state).toBe("ready");
    expect(fixture.provider.install).toHaveBeenCalledOnce();
    await fixture.manager.close();
  });

  it("reports unknown rather than success when SSH authority changes after the remote effect", async () => {
    const fixture = setupFixture({
      probe: vi.fn(async () => ({ state: "not_installed" as const })),
      install: vi.fn<RemoteBackendRuntimeSetupProvider["install"]>(async (context, _reinstall, _signal, onPhase) => {
        context.beginEffect();
        onPhase("installing");
        fixture.authorityCurrent = false;
        return { state: "ready" as const, installedVersion: "1.2.3" };
      })
    });
    const events = await collect(fixture.manager.install({ ...scope(fixture), requestId: "request-a", reinstall: false }));
    expect(events.at(-1)).toMatchObject({
      phase: "outcome_unknown",
      runtime: { state: "outcome_unknown", failure: { code: "authority_changed" } }
    });
    expect(events.some((event) => event.phase === "complete")).toBe(false);
    await fixture.manager.close();
  });

  it("reports unknown when an effect may have changed state and its recovery probe also fails", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ state: "not_installed" as const })
      .mockRejectedValueOnce(new Error("probe unavailable"));
    const fixture = setupFixture({
      probe,
      install: vi.fn<RemoteBackendRuntimeSetupProvider["install"]>(async (context) => {
        context.beginEffect();
        throw new RemoteCodexInstallationError("command_failed", "bounded", { stateMayHaveChanged: true });
      })
    });
    const events = await collect(fixture.manager.install({ ...scope(fixture), requestId: "request-unknown", reinstall: false }));
    expect(events.at(-1)).toMatchObject({
      phase: "outcome_unknown",
      runtime: { state: "outcome_unknown", failure: { code: "install_failed" } }
    });
    expect(probe).toHaveBeenCalledTimes(2);
    await fixture.manager.close();
  });

  it("keeps a confirmed old runtime usable when a reinstall fails", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ state: "ready" as const, installedVersion: "1.2.3" })
      .mockResolvedValueOnce({ state: "ready" as const, installedVersion: "1.2.3" });
    const fixture = setupFixture({
      probe,
      install: vi.fn<RemoteBackendRuntimeSetupProvider["install"]>(async (context) => {
        context.beginEffect();
        throw new RemoteCodexInstallationError("command_failed", "bounded", { stateMayHaveChanged: true });
      })
    });
    const events = await collect(fixture.manager.install({ ...scope(fixture), requestId: "request-reinstall", reinstall: true }));
    expect(events.at(-1)).toMatchObject({
      phase: "failed",
      runtime: {
        state: "ready",
        installedVersion: "1.2.3",
        canReinstall: true,
        canUninstall: true,
        failure: { code: "install_failed" }
      }
    });
    await fixture.manager.close();
  });

  it("serializes uninstall with install and keeps mutation results idempotent", async () => {
    const uninstall = vi.fn(async () => ({ state: "not_installed" as const }));
    const fixture = setupFixture({ uninstall });
    const input = { ...scope(fixture), requestId: "uninstall-a" };
    const first = fixture.manager.uninstall(input);
    const second = fixture.manager.uninstall(input);
    await expect(second).resolves.toMatchObject({ state: "not_installed", canInstall: true, canUninstall: false });
    await expect(first).resolves.toEqual(await second);
    expect(uninstall).toHaveBeenCalledOnce();
    await fixture.manager.close();
  });

  it("lets only the same scope observe an in-flight uninstall before a fresh probe", async () => {
    let finish!: () => void;
    const readback = new Promise<void>((resolve) => { finish = resolve; });
    let markerPresent = true;
    const probe = vi.fn<RemoteBackendRuntimeSetupProvider["probe"]>(async () => markerPresent
      ? { state: "ready", installedVersion: "1.2.3" }
      : { state: "not_installed" });
    const uninstall = vi.fn<RemoteBackendRuntimeSetupProvider["uninstall"]>(async () => {
      markerPresent = false;
      await readback;
      return { state: "not_installed" };
    });
    const fixture = setupFixture({ probe, uninstall });
    const current = scope(fixture);
    const operation = fixture.manager.uninstall({ ...current, requestId: "uninstall-in-flight" });
    try {
      await vi.waitFor(() => expect(uninstall).toHaveBeenCalledOnce());
      await expect(fixture.manager.probe(current)).resolves.toMatchObject({
        targetId: current.targetId, hostId: current.hostId, targetRevision: current.expectedTargetRevision,
        hostRevision: current.expectedHostRevision, state: "probing", canInstall: false, canReinstall: false, canUninstall: false
      });
      expect(probe).not.toHaveBeenCalled();
      await expect(fixture.manager.probe({ ...current, hostId: "same-endpoint-alias" })).rejects.toMatchObject({ code: "busy" });
      expect(() => fixture.manager.install({ ...current, requestId: "install-while-uninstalling", reinstall: false }))
        .toThrowError(RemoteBackendRuntimeSetupError);
      finish();
      await expect(operation).resolves.toMatchObject({ state: "not_installed", canInstall: true });
      await expect(fixture.manager.probe(current)).resolves.toMatchObject({ state: "not_installed", canInstall: true });
      expect(probe).toHaveBeenCalledOnce();
      expect(uninstall).toHaveBeenCalledOnce();
    } finally {
      finish();
      await fixture.manager.close();
    }
  });
});

function setupFixture(overrides: Partial<RemoteBackendRuntimeSetupProvider> = {}) {
  const target: StoredTarget = {
    descriptor: {
      id: "target-a", backendId: "runtime-a", displayName: "Target", workspaceRoot: "D:\\placeholder",
      managed: false, trusted: true
    },
    metadata: {}, createdAt: 1, updatedAt: 1, revision: 3n
  };
  const host: RemoteHostRecord = {
    ownerId: "owner-a", targetId: "target-a", id: "host-a", hostname: "host.test", port: 22, user: "user",
    source: "manual", authenticationMode: "system_agent",
    autoConnect: false, autoConnectRevision: 1n,
    trust: { algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", pinnedAt: 1 },
    status: { state: "ready", changedAt: 1 }, createdAt: 1, updatedAt: 1, revision: 5n
  };
  const processes = {} as RemoteProcessTransportPort;
  const lease = { capabilities: { processStreaming: true }, processes } as RemoteSshTransportLease;
  const fixture = { authorityCurrent: true };
  const capture = vi.fn(async () => ({
    host,
    hostRevision: host.revision,
    leaseGeneration: 1,
    lease,
    assertCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH authority changed"); },
    assertForwardingCurrent: () => { if (!fixture.authorityCurrent) throw new Error("SSH authority changed"); }
  }));
  const provider: RemoteBackendRuntimeSetupProvider = {
    backendId: "runtime-a",
    displayName: "Fixture Runtime",
    expectedVersion: "1.2.3",
    probe: vi.fn(async () => ({ state: "ready" as const, installedVersion: "1.2.3" })),
    install: vi.fn<RemoteBackendRuntimeSetupProvider["install"]>(async (context, _reinstall, _signal, onPhase) => {
      context.beginEffect();
      onPhase("validating");
      return { state: "ready" as const, installedVersion: "1.2.3" };
    }),
    uninstall: vi.fn(async () => ({ state: "not_installed" as const })),
    ...overrides
  };
  const manager = new RemoteBackendRuntimeSetupManager({
    store: { getTarget: () => target },
    registry: {
      get: (targetId: string, hostId: string) => ({ ...host, targetId, id: hostId }),
      captureProcessAuthority: capture
    } as unknown as Pick<RemoteHostRegistry, "get" | "captureProcessAuthority">,
    providers: [provider],
    now: () => 123
  });
  return Object.assign(fixture, { target, host, capture, provider, manager });
}

function scope(fixture: ReturnType<typeof setupFixture>) {
  return {
    targetId: fixture.target.descriptor.id,
    hostId: fixture.host.id,
    expectedTargetRevision: fixture.target.revision,
    expectedHostRevision: fixture.host.revision
  };
}

async function collect(values: AsyncIterable<RemoteBackendRuntimeInstallEvent>): Promise<RemoteBackendRuntimeInstallEvent[]> {
  const result: RemoteBackendRuntimeInstallEvent[] = [];
  for await (const value of values) result.push(value);
  return result;
}
