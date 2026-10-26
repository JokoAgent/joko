import { DevicePeerCapabilityKind } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import { DesktopDevicePeerAgentLifecycle } from "./device-peer-agent-lifecycle.js";

const FIRST: DesktopManagedOrchestratorConnection = Object.freeze({
  profileId: "profile-1",
  deviceId: "device-1",
  serverId: "server-1",
  name: "First",
  origin: "http://127.0.0.1:47123"
});
const SECOND: DesktopManagedOrchestratorConnection = Object.freeze({
  profileId: "profile-2",
  deviceId: "device-2",
  serverId: "server-2",
  name: "Second",
  origin: "http://127.0.0.1:48123"
});

describe("Desktop Device peer agent lifecycle", () => {
  it("retires the original managed route when its fixed endpoint key changes", async () => {
    const attempts: Array<{ connection: DesktopManagedOrchestratorConnection; signal: AbortSignal }> = [];
    const lifecycle = new DesktopDevicePeerAgentLifecycle({ createExecutor: () => fakeExecutor(), readAuthKey: async () => "A".repeat(43),
      readDefaultDeviceName: () => "Desktop", readRouteAuthorization: async () => "R".repeat(43), isAuthorityCurrent: () => true,
      async runRoute(options) { attempts.push({ connection: options.connection, signal: options.signal }); await aborted(options.signal); }, wait: immediateWait });
    try {
      lifecycle.setConnection({ ...FIRST, endpointPublicKey: `ed25519:${"1".repeat(64)}` });
      await eventually(() => attempts.length === 1);
      lifecycle.setConnection({ ...FIRST, endpointPublicKey: `ed25519:${"2".repeat(64)}` });
      expect(attempts[0]!.signal.aborted).toBe(true);
      await eventually(() => attempts.length === 2);
      expect(attempts[1]!.connection.endpointPublicKey).toBe(`ed25519:${"2".repeat(64)}`);
    } finally { await lifecycle.dispose(); }
  });
  it("owns one exact ready route and immediately aborts and retires it on replacement and stop", async () => {
    const attempts: Array<{
      readonly connection: DesktopManagedOrchestratorConnection;
      readonly signal: AbortSignal;
    }> = [];
    const executors: Array<ReturnType<typeof fakeExecutor>> = [];
    let activeRoutes = 0;
    let maximumActiveRoutes = 0;
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor() {
        const executor = fakeExecutor();
        executors.push(executor);
        return executor;
      },
      readAuthKey: async () => "A".repeat(43),
      readDefaultDeviceName: () => "Native Desktop",
      readRouteAuthorization: async () => "R".repeat(43),
      isAuthorityCurrent: () => true,
      async runRoute(options) {
        attempts.push({ connection: options.connection, signal: options.signal });
        activeRoutes += 1;
        maximumActiveRoutes = Math.max(maximumActiveRoutes, activeRoutes);
        try {
          await aborted(options.signal);
        } finally {
          activeRoutes -= 1;
        }
      },
      wait: immediateWait
    });

    lifecycle.setConnection(FIRST);
    await eventually(() => attempts.length === 1);
    lifecycle.setConnection(SECOND);
    expect(attempts[0]?.signal.aborted).toBe(true);
    await eventually(() => executors[0]?.retire.mock.calls.length === 1);
    await eventually(() => attempts.length === 2);
    expect(attempts[1]?.connection).toEqual(SECOND);
    expect(maximumActiveRoutes).toBe(1);

    const stopped = lifecycle.stop();
    expect(attempts[1]?.signal.aborted).toBe(true);
    await stopped;
    expect(executors[1]?.retire).toHaveBeenCalledOnce();
    expect(activeRoutes).toBe(0);
  });

  it("uses capped exponential reconnect only while the exact authority remains current", async () => {
    const delays: number[] = [];
    let authorityCurrent = true;
    let attempts = 0;
    let nativeName = "First OS host";
    const sources: string[] = [];
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: () => fakeExecutor(),
      readAuthKey: async () => "B".repeat(43),
      readDefaultDeviceName: () => nativeName,
      readRouteAuthorization: async () => "R".repeat(43),
      isAuthorityCurrent: (candidate) => authorityCurrent && candidate === FIRST,
      async runRoute(options) {
        attempts += 1;
        sources.push(options.readDefaultDeviceName());
        throw new Error("transport detail that must stay private");
      },
      retryBaseDelayMs: 10,
      retryMaximumDelayMs: 25,
      async wait(milliseconds) {
        delays.push(milliseconds);
        nativeName = "Updated OS host";
        if (delays.length === 4) authorityCurrent = false;
      }
    });

    lifecycle.setConnection(FIRST);
    await eventually(() => delays.length === 4);
    await eventually(() => attempts === 4);
    await lifecycle.stop();
    expect(delays).toEqual([10, 20, 25, 25]);
    expect(attempts).toBe(4);
    expect(sources).toEqual(["First OS host", "Updated OS host", "Updated OS host", "Updated OS host"]);
  });

  it("interrupts a failed-route backoff immediately when the exact authority is replaced", async () => {
    const attempts: DesktopManagedOrchestratorConnection[] = [];
    let resolveBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolvePromise) => { resolveBackoff = resolvePromise; });
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: () => fakeExecutor(),
      readAuthKey: async () => "D".repeat(43),
      readDefaultDeviceName: () => "Native Desktop",
      readRouteAuthorization: async () => "R".repeat(43),
      isAuthorityCurrent: () => true,
      async runRoute(options) {
        attempts.push(options.connection);
        if (options.connection === FIRST) throw new Error("route unavailable");
        await aborted(options.signal);
      },
      wait(_milliseconds, signal) {
        resolveBackoff();
        return new Promise<void>((_resolveDelay, rejectDelay) => {
          if (signal.aborted) rejectDelay(new Error("cancelled"));
          else signal.addEventListener("abort", () => rejectDelay(new Error("cancelled")), { once: true });
        });
      }
    });

    lifecycle.setConnection(FIRST);
    await backoffStarted;
    lifecycle.setConnection(SECOND);
    await eventually(() => attempts.length === 2);
    expect(attempts).toEqual([FIRST, SECOND]);
    await lifecycle.stop();
  });

  it("passes the protected credential reader only to the route and never starts for stale authority", async () => {
    const readAuthKey = vi.fn(async () => "C".repeat(43));
    const readRouteAuthorization = vi.fn(async () => "R".repeat(43));
    const runRoute = vi.fn(async () => undefined);
    const createExecutor = vi.fn(() => fakeExecutor());
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor,
      readAuthKey,
      readDefaultDeviceName: () => "Native Desktop",
      readRouteAuthorization,
      isAuthorityCurrent: () => false,
      runRoute,
      wait: immediateWait
    });

    lifecycle.setConnection(FIRST);
    await Promise.resolve();
    await lifecycle.stop();
    expect(createExecutor).not.toHaveBeenCalled();
    expect(runRoute).not.toHaveBeenCalled();
    expect(readAuthKey).not.toHaveBeenCalled();
    expect(readRouteAuthorization).not.toHaveBeenCalled();
  });

  it("keeps the file route alive during native failures, caps recovery backoff and republishes capabilities through exact route retirement", async () => {
    let nativeReady = false, probes = 0;
    const delays: number[] = [], releases: Array<() => void> = [];
    const executors: Array<Omit<ReturnType<typeof fakeExecutor>, "capabilities"> & { readonly capabilities: readonly DevicePeerCapabilityKind[] }> = [];
    const routed: Array<{ readonly capabilities: readonly DevicePeerCapabilityKind[]; readonly signal: AbortSignal }> = [];
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor() {
        const executor = { ...fakeExecutor(), capabilities: nativeReady ? [DevicePeerCapabilityKind.FILES, DevicePeerCapabilityKind.NATIVE_AGENTS] : [DevicePeerCapabilityKind.FILES] };
        executors.push(executor); return executor;
      },
      readAuthKey: async () => "A".repeat(43), readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop", isAuthorityCurrent: () => true,
      runRoute: async options => { routed.push({ capabilities: options.executor.capabilities, signal: options.signal }); await aborted(options.signal); },
      recoverNativeAgents: async () => { if (++probes < 4) throw new Error("Private native endpoint is unavailable."); nativeReady = true; return true; },
      retryBaseDelayMs: 10, retryMaximumDelayMs: 25,
      wait: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
        delays.push(milliseconds); releases.push(resolve);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })
    });
    try {
      lifecycle.setConnection(FIRST); await eventually(() => routed.length === 1 && releases.length === 1);
      for (let attempt = 0; attempt < 3; attempt++) {
        releases[attempt]!(); await eventually(() => releases.length === attempt + 2);
        expect(routed).toHaveLength(1); expect(routed[0]?.signal.aborted).toBe(false);
        expect(routed[0]?.capabilities).toEqual([DevicePeerCapabilityKind.FILES]);
      }
      releases[3]!(); await eventually(() => routed.length === 2);
      expect(delays).toEqual([10, 20, 25, 25]); expect(probes).toBe(4);
      expect(executors[0]?.retire).toHaveBeenCalledOnce(); expect(routed[0]?.signal.aborted).toBe(true);
      expect(routed[1]?.capabilities).toEqual([DevicePeerCapabilityKind.FILES, DevicePeerCapabilityKind.NATIVE_AGENTS]);
    } finally { await lifecycle.dispose(); }
    expect(executors[1]?.retire).toHaveBeenCalledOnce();
  });

  it("cancels an old native probe on replacement and never lets its late result rebuild the new authority", async () => {
    let finishProbe!: () => void;
    let probeSignal: AbortSignal | undefined;
    const routed: DesktopManagedOrchestratorConnection[] = [];
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: connection => ({ ...fakeExecutor(), capabilities: connection === FIRST
        ? [DevicePeerCapabilityKind.FILES] : [DevicePeerCapabilityKind.FILES, DevicePeerCapabilityKind.NATIVE_AGENTS] }),
      readAuthKey: async () => "A".repeat(43), readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop", isAuthorityCurrent: () => true,
      runRoute: async options => { routed.push(options.connection); await aborted(options.signal); }, wait: immediateWait,
      recoverNativeAgents: async (_connection, signal) => { probeSignal = signal; await new Promise<void>(resolve => { finishProbe = resolve; }); return true; }
    });
    try {
      lifecycle.setConnection(FIRST); await eventually(() => probeSignal !== undefined && routed.length === 1);
      lifecycle.setConnection(SECOND); expect(probeSignal?.aborted).toBe(true);
      await eventually(() => routed.length === 2);
      finishProbe(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(routed).toEqual([FIRST, SECOND]);
    } finally { finishProbe?.(); await lifecycle.dispose(); }
  });

  it("reports the native recovery wait without allowing diagnostic failures to finish or block retirement", async () => {
    let finishProbe!: () => void;
    let probeStarted = false, routeStarted = false;
    const stages: string[] = [];
    const executor = fakeExecutor();
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: () => executor,
      readAuthKey: async () => "A".repeat(43), readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop", isAuthorityCurrent: () => true,
      runRoute: async options => { routeStarted = true; await aborted(options.signal); },
      wait: immediateWait,
      recoverNativeAgents: async () => {
        probeStarted = true;
        await new Promise<void>(resolve => { finishProbe = resolve; });
        return false;
      },
      observeRetirement: stage => {
        stages.push(stage);
        throw new Error("A diagnostic observer cannot own retirement.");
      }
    });
    try {
      lifecycle.setConnection(FIRST);
      await eventually(() => probeStarted && routeStarted);
      const retired = lifecycle.dispose();
      await eventually(() => stages.includes("native_recovery_wait_started"));
      expect(stages).toEqual(["worker_wait_started", "worker_executor_retirement_started",
        "worker_executor_retirement_completed", "worker_retry_started", "worker_retry_completed",
        "worker_wait_completed", "native_recovery_wait_started"]);
      expect(executor.retire).toHaveBeenCalledOnce();
      finishProbe();
      await retired;
      expect(stages.at(-1)).toBe("native_recovery_wait_completed");
    } finally { finishProbe?.(); await lifecycle.dispose(); }
  });
});

function fakeExecutor() {
  let retired = false;
  const retire = vi.fn(async () => { retired = true; });
  return {
    capabilities: [DevicePeerCapabilityKind.FILES] as const,
    execute: vi.fn(async () => {
      if (retired) throw new Error("retired");
    }),
    retire
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
}

function immediateWait(_milliseconds: number, signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.reject(new Error("cancelled")) : Promise.resolve();
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
  }
  throw new Error("Condition did not settle.");
}
