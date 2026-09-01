import { describe, expect, it, vi } from "vitest";

import { createProviderModelRefreshLifecycle } from "./provider-model-refresh-lifecycle.js";

describe("Provider model refresh renderer lifecycle", () => {
  it("runs startup after the owner connects and only once across a same-owner reconnect", async () => {
    const refresh = vi.fn(async () => undefined);
    const lifecycle = createProviderModelRefreshLifecycle({ refresh });

    lifecycle.syncConnection({ connected: false, ownerKey: "owner-a" });
    expect(refresh).not.toHaveBeenCalled();
    lifecycle.syncConnection({ connected: true, ownerKey: "owner-a" });
    await lifecycle.settled();
    expect(refresh).toHaveBeenCalledOnce();

    lifecycle.syncConnection({ connected: false, ownerKey: "owner-a" });
    lifecycle.syncConnection({ connected: true, ownerKey: "owner-a" });
    await lifecycle.settled();
    expect(refresh).toHaveBeenCalledOnce();

    lifecycle.syncConnection({ connected: true, ownerKey: "owner-b" });
    await lifecycle.settled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("routes every host lifecycle hint through a silent refresh", async () => {
    const refresh = vi.fn(async () => undefined);
    const lifecycle = createProviderModelRefreshLifecycle({ refresh });
    lifecycle.syncConnection({ connected: true, ownerKey: "owner" });
    await lifecycle.settled();
    refresh.mockClear();

    for (const hint of ["system-resume", "screen-unlock", "meaningful-foreground"] as const) {
      lifecycle.request(hint);
      await lifecycle.settled();
    }

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("coalesces startup and wake hints while disconnected or already in flight", async () => {
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = createProviderModelRefreshLifecycle({ refresh });

    lifecycle.request("system-resume");
    lifecycle.request("screen-unlock");
    lifecycle.syncConnection({ connected: true, ownerKey: "owner" });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    lifecycle.request("system-resume");
    lifecycle.request("screen-unlock");
    lifecycle.request("meaningful-foreground");
    release();
    await lifecycle.settled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps automatic lifecycle failures silent", async () => {
    const lifecycle = createProviderModelRefreshLifecycle({
      refresh: vi.fn(async () => { throw new Error("offline"); })
    });
    lifecycle.syncConnection({ connected: true, ownerKey: "owner" });
    await expect(lifecycle.settled()).resolves.toBeUndefined();
  });
});
