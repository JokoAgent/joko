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
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: () => fakeExecutor(),
      readAuthKey: async () => "B".repeat(43),
      readRouteAuthorization: async () => "R".repeat(43),
      isAuthorityCurrent: (candidate) => authorityCurrent && candidate === FIRST,
      async runRoute() {
        attempts += 1;
        throw new Error("transport detail that must stay private");
      },
      retryBaseDelayMs: 10,
      retryMaximumDelayMs: 25,
      async wait(milliseconds) {
        delays.push(milliseconds);
        if (delays.length === 4) authorityCurrent = false;
      }
    });

    lifecycle.setConnection(FIRST);
    await eventually(() => delays.length === 4);
    await eventually(() => attempts === 4);
    await lifecycle.stop();
    expect(delays).toEqual([10, 20, 25, 25]);
    expect(attempts).toBe(4);
  });

  it("interrupts a failed-route backoff immediately when the exact authority is replaced", async () => {
    const attempts: DesktopManagedOrchestratorConnection[] = [];
    let resolveBackoff!: () => void;
    const backoffStarted = new Promise<void>((resolvePromise) => { resolveBackoff = resolvePromise; });
    const lifecycle = new DesktopDevicePeerAgentLifecycle({
      createExecutor: () => fakeExecutor(),
      readAuthKey: async () => "D".repeat(43),
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
