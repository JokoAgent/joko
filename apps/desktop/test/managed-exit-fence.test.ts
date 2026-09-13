import { describe, expect, it, vi } from "vitest";

import { createManagedExitFence } from "../src/managed-exit-fence.js";

describe("managed Orchestrator complete-exit fence", () => {
  it("raises the fence before awaiting initialization and stops the runtime committed afterward", async () => {
    const initialized = deferred<void>();
    const runtime = { stop: vi.fn(async () => undefined) };
    let initialization: Promise<void> | undefined = initialized.promise;
    let currentRuntime: typeof runtime | undefined;
    let starts = 1;
    void initialized.promise.then(() => {
      currentRuntime = runtime;
      if (initialization === initialized.promise) initialization = undefined;
    });
    const fence = createManagedExitFence({
      getInitialization: () => initialization,
      clearInitialization: (candidate) => {
        if (initialization === candidate) initialization = undefined;
      },
      getRuntime: () => currentRuntime,
      stopRuntime: (candidate) => candidate.stop(),
      clearRuntime: (candidate) => {
        if (currentRuntime === candidate) currentRuntime = undefined;
      }
    });
    const begin = (): Promise<void> => {
      if (initialization !== undefined) return initialization;
      fence.assertInitializationAllowed();
      starts += 1;
      return Promise.resolve();
    };

    const stopping = fence.stop();
    expect(fence.shutdownStarted).toBe(true);
    expect(begin()).toBe(initialized.promise);
    expect(starts).toBe(1);
    initialized.resolve();
    await initialized.promise;
    await Promise.resolve();
    expect(() => begin()).toThrow("Managed Orchestrator cannot start during complete exit.");
    await stopping;

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(currentRuntime).toBeUndefined();
    expect(fence.shutdownStarted).toBe(true);
  });

  it("releases the fence after a stop failure and when apply recovery is requested", async () => {
    const runtime = { stop: vi.fn(async () => { throw new Error("still running"); }) };
    const fence = createManagedExitFence({
      getInitialization: () => undefined,
      clearInitialization: () => undefined,
      getRuntime: () => runtime,
      stopRuntime: (candidate) => candidate.stop(),
      clearRuntime: () => undefined
    });

    await expect(fence.stop()).rejects.toThrow("still running");
    expect(fence.shutdownStarted).toBe(false);
    expect(() => fence.assertInitializationAllowed()).not.toThrow();

    const successfulFence = createManagedExitFence({
      getInitialization: () => undefined,
      clearInitialization: () => undefined,
      getRuntime: () => undefined,
      stopRuntime: async () => undefined,
      clearRuntime: () => undefined
    });
    await successfulFence.stop();
    expect(() => successfulFence.assertInitializationAllowed()).toThrow();
    successfulFence.releaseForRecovery();
    expect(() => successfulFence.assertInitializationAllowed()).not.toThrow();
  });
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
