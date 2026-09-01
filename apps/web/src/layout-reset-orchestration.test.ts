import { describe, expect, it, vi } from "vitest";
import { resetWindowLayout } from "./layout-reset-orchestration.js";

describe("window layout reset orchestration", () => {
  it("runs the client and native boundaries once", async () => {
    const resetClient = vi.fn(async () => undefined);
    const resetNative = vi.fn(async () => undefined);

    await expect(resetWindowLayout({ resetClient, resetNative })).resolves.toBeUndefined();

    expect(resetClient).toHaveBeenCalledOnce();
    expect(resetNative).toHaveBeenCalledOnce();
  });

  it("still resets the client when native geometry fails", async () => {
    const resetClient = vi.fn(async () => undefined);
    const resetNative = vi.fn(async () => { throw new Error("native reset failed"); });

    await expect(resetWindowLayout({ resetClient, resetNative })).resolves.toBe("native");
    expect(resetClient).toHaveBeenCalledOnce();
    expect(resetNative).toHaveBeenCalledOnce();
  });

  it("still resets native geometry when client persistence fails", async () => {
    const resetClient = vi.fn(async () => { throw new Error("client reset failed"); });
    const resetNative = vi.fn(async () => undefined);

    await expect(resetWindowLayout({ resetClient, resetNative })).resolves.toBe("client");
    expect(resetClient).toHaveBeenCalledOnce();
    expect(resetNative).toHaveBeenCalledOnce();
  });

  it("reports both failures and supports browser-only reset", async () => {
    const resetClient = vi.fn()
      .mockRejectedValueOnce(new Error("client reset failed"))
      .mockResolvedValueOnce(undefined);
    const resetNative = vi.fn(async () => { throw new Error("native reset failed"); });

    await expect(resetWindowLayout({ resetClient, resetNative })).resolves.toBe("client-and-native");
    await expect(resetWindowLayout({ resetClient })).resolves.toBeUndefined();
    expect(resetClient).toHaveBeenCalledTimes(2);
    expect(resetNative).toHaveBeenCalledOnce();
  });
});
