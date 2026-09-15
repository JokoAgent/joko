import { describe, expect, it, vi } from "vitest";

import { DeferredBackendRestartCoordinator } from "./deferred-backend-restart.js";

describe("DeferredBackendRestartCoordinator", () => {
  it("installs the dispatch hold synchronously before applying on a later turn", async () => {
    let idle = false;
    const restart = vi.fn(async () => undefined);
    const owner = new DeferredBackendRestartCoordinator({
      restart,
      canRestart: () => idle,
      wakeQueues: vi.fn(),
      retryDelayMs: 60_000
    });

    owner.request("codex");
    expect(owner.blocksDispatch("codex")).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    idle = true;
    await owner.apply("codex");
    expect(owner.blocksDispatch("codex")).toBe(false);
    expect(restart).toHaveBeenCalledExactlyOnceWith("codex");
    owner.dispose();
  });

  it("blocks dispatch through one immediate replacement and wakes queues only after publication", async () => {
    const replacement = deferred();
    const restart = vi.fn(async () => await replacement.value);
    const wakeQueues = vi.fn();
    const owner = new DeferredBackendRestartCoordinator({
      restart,
      canRestart: () => true,
      wakeQueues
    });

    const scheduled = owner.schedule("codex");
    await vi.waitFor(() => expect(restart).toHaveBeenCalledExactlyOnceWith("codex"));
    expect(owner.blocksDispatch("codex")).toBe(true);
    expect(owner.state("codex")).toMatchObject({ pending: true, applying: true, lastError: "" });
    expect(wakeQueues).not.toHaveBeenCalled();

    replacement.resolve();
    await scheduled;
    expect(owner.state("codex")).toEqual({ pending: false, applying: false, lastError: "" });
    expect(wakeQueues).toHaveBeenCalledExactlyOnceWith("codex");
    owner.dispose();
  });

  it("coalesces busy changes and applies only the latest desired generation after an idle signal", async () => {
    let idle = false;
    const restart = vi.fn(async () => undefined);
    const wakeQueues = vi.fn();
    const owner = new DeferredBackendRestartCoordinator({
      restart,
      canRestart: () => idle,
      wakeQueues,
      retryDelayMs: 60_000
    });

    await owner.schedule("codex");
    await owner.schedule("codex");
    expect(owner.state("codex").pending).toBe(true);
    expect(restart).not.toHaveBeenCalled();

    idle = true;
    owner.onBackendMayBeIdle("codex");
    await vi.waitFor(() => expect(owner.state("codex").pending).toBe(false));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(wakeQueues).toHaveBeenCalledTimes(1);
    owner.dispose();
  });

  it("runs a second replacement when desired state changes during an in-flight replacement", async () => {
    const first = deferred();
    const second = deferred();
    const restart = vi.fn()
      .mockImplementationOnce(async () => await first.value)
      .mockImplementationOnce(async () => await second.value);
    const wakeQueues = vi.fn();
    const owner = new DeferredBackendRestartCoordinator({ restart, canRestart: () => true, wakeQueues });

    const initial = owner.schedule("codex");
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    await owner.schedule("codex");
    first.resolve();
    await initial;
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2));
    expect(owner.blocksDispatch("codex")).toBe(true);
    second.resolve();
    await vi.waitFor(() => expect(owner.blocksDispatch("codex")).toBe(false));
    expect(wakeQueues).toHaveBeenCalledTimes(1);
    owner.dispose();
  });

  it("retains a failed desired change and retries it on the next idle signal", async () => {
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error("candidate rejected"))
      .mockResolvedValueOnce(undefined);
    const wakeQueues = vi.fn();
    const owner = new DeferredBackendRestartCoordinator({
      restart,
      canRestart: () => true,
      wakeQueues,
      retryDelayMs: 60_000
    });

    await owner.schedule("codex");
    expect(owner.state("codex")).toMatchObject({ pending: true, applying: false, lastError: "candidate rejected" });
    expect(owner.blocksDispatch("codex")).toBe(true);
    owner.onBackendMayBeIdle("codex");
    await vi.waitFor(() => expect(owner.state("codex").pending).toBe(false));
    expect(restart).toHaveBeenCalledTimes(2);
    expect(wakeQueues).toHaveBeenCalledTimes(1);
    owner.dispose();
  });

  it("keeps a pending generation change fenced while its owning Host shuts down", () => {
    const restart = vi.fn(async () => undefined);
    const owner = new DeferredBackendRestartCoordinator({
      restart,
      canRestart: () => false,
      wakeQueues: vi.fn(),
      retryDelayMs: 60_000
    });

    owner.request("codex");
    owner.dispose();
    owner.onBackendMayBeIdle("codex");
    expect(owner.state("codex")).toEqual({ pending: false, applying: false, lastError: "" });
    expect(owner.blocksDispatch("codex")).toBe(true);
    expect(restart).not.toHaveBeenCalled();
  });
});

function deferred(): { readonly value: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const value = new Promise<void>((done) => { resolve = done; });
  return { value, resolve };
}
