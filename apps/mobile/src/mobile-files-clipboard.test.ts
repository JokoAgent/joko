import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileFilesClipboard, type MobileFilesClipboardLease } from "./mobile-files-clipboard";

afterEach(() => vi.useRealTimers());
function lease() {
  let current = true;
  const value: MobileFilesClipboardLease = { text: "src/picture.png", kind: "path", assertCurrent: (signal) => {
    signal?.throwIfAborted(); if (!current) throw new Error("Copy source retired.");
  } };
  return { value, retire: () => { current = false; } };
}
describe("native Files clipboard effect ownership", () => {
  it("refuses stale dispatch, prevents duplicate writes and retains a cancelled native slot without adopting a late result", async () => {
    let finish!: (saved: boolean) => void; const write = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const copy = new MobileFilesClipboard(write); const stale = lease(); stale.retire(); expect(await copy.copy(stale.value)).toBe("retired"); expect(write).not.toHaveBeenCalled();
    const source = lease(); const pending = copy.copy(source.value); expect(await copy.copy(source.value)).toBe("busy"); expect(write).toHaveBeenCalledOnce();
    copy.cancel(); expect(await pending).toBe("retired"); expect(await copy.copy(lease().value)).toBe("busy");
    finish(true); await Promise.resolve(); await Promise.resolve(); write.mockResolvedValueOnce(true);
    expect(await copy.copy(lease().value)).toBe("copied"); expect(write).toHaveBeenCalledTimes(2);
  });
  it("reports only confirmed writes, hides stale completion and bounds a native unknown result without redispatch", async () => {
    const write = vi.fn(async () => false); const copy = new MobileFilesClipboard(write); expect(await copy.copy(lease().value)).toBe("failed");
    write.mockRejectedValueOnce(new Error("Native rejected")); expect(await copy.copy(lease().value)).toBe("failed");
    let finish!: () => void; const source = lease(); write.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    const pending = copy.copy(source.value); source.retire(); finish(); expect(await pending).toBe("retired");
    vi.useFakeTimers(); write.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    const unknown = copy.copy(lease().value); await vi.advanceTimersByTimeAsync(10_000); expect(await unknown).toBe("unknown");
    expect(await copy.copy(lease().value)).toBe("busy"); finish(); await Promise.resolve(); await Promise.resolve(); expect(write).toHaveBeenCalledTimes(4);
  });
});
