import { describe, expect, it, vi } from "vitest";

import {
  loadDesktopWindowWithRecovery,
  recoverDesktopWindowAfterFailure
} from "../src/window-load-recovery.js";

describe("desktop native window load recovery", () => {
  it("completes without presenting recovery when the initial load succeeds", async () => {
    const presentFailure = vi.fn();
    const close = vi.fn();

    await expect(loadDesktopWindowWithRecovery({
      unavailable: () => false,
      load: vi.fn(async () => undefined),
      presentFailure,
      close
    })).resolves.toBe("loaded");

    expect(presentFailure).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("retries the same secured window until a later load succeeds", async () => {
    const failures = [new Error("first"), new Error("second")];
    const load = vi.fn(async (attempt: number) => {
      const failure = failures[attempt - 1];
      if (failure !== undefined) throw failure;
    });
    const presentFailure = vi.fn(async () => "retry" as const);
    const close = vi.fn();

    await expect(loadDesktopWindowWithRecovery({
      unavailable: () => false,
      load,
      presentFailure,
      close
    })).resolves.toBe("loaded");

    expect(load.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(presentFailure.mock.calls).toEqual([[failures[0], 1], [failures[1], 2]]);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes exactly once when recovery is declined", async () => {
    const close = vi.fn(async () => undefined);
    await expect(loadDesktopWindowWithRecovery({
      unavailable: () => false,
      load: vi.fn(async () => { throw new Error("load failed"); }),
      presentFailure: vi.fn(async () => "close" as const),
      close
    })).resolves.toBe("closed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not present or close an owner that disappeared during loading", async () => {
    let unavailable = false;
    const presentFailure = vi.fn();
    const close = vi.fn();
    await expect(loadDesktopWindowWithRecovery({
      unavailable: () => unavailable,
      load: vi.fn(async () => {
        unavailable = true;
        throw new Error("window closed");
      }),
      presentFailure,
      close
    })).resolves.toBe("closed");
    expect(presentFailure).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("fails closed when the native recovery surface cannot be shown", async () => {
    const close = vi.fn(async () => undefined);
    const presentationError = new Error("dialog unavailable");
    await expect(loadDesktopWindowWithRecovery({
      unavailable: () => false,
      load: vi.fn(async () => { throw new Error("load failed"); }),
      presentFailure: vi.fn(async () => { throw presentationError; }),
      close
    })).rejects.toBe(presentationError);
    expect(close).toHaveBeenCalledOnce();
  });

  it("prompts before reloading a renderer that was lost after startup", async () => {
    const rendererFailure = new Error("renderer crashed");
    const load = vi.fn(async () => undefined);
    const presentFailure = vi.fn(async () => "retry" as const);

    await expect(recoverDesktopWindowAfterFailure({
      unavailable: () => false,
      load,
      presentFailure,
      close: vi.fn()
    }, rendererFailure)).resolves.toBe("loaded");

    expect(presentFailure).toHaveBeenCalledOnce();
    expect(presentFailure).toHaveBeenCalledWith(rendererFailure, 1);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(2);
  });
});
