import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileClient } from "./mobile-client";

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert } }));
import { archiveMobileSession } from "./mobile-session-archive";

beforeEach(() => alert.mockReset());
function fixture(count = 1) {
  const archive = vi.fn(async () => true);
  const prepareSessionArchive = vi.fn(async () => ({ preview: { hasWorktree: false, dirty: false,
    activeBoundScheduleCount: count, activeBoundScheduleNames: count ? ["Nightly"] : [], archiveConfirmation: "a".repeat(64) }, archive }));
  return { client: { prepareSessionArchive } as unknown as MobileClient, archive, prepareSessionArchive };
}

describe("Mobile archive confirmation", () => {
  it("shows active bound names and waits for the explicit archive action", async () => {
    const f = fixture();
    const pending = archiveMobileSession(f.client, "task", "en");
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    expect(alert.mock.calls[0]![1]).toContain("Nightly");
    expect(f.archive).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { onPress: () => void }[];
    buttons[1]!.onPress();
    await expect(pending).resolves.toBe(true);
    expect(f.archive).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled or retired confirmation from archiving", async () => {
    const f = fixture(); let current = true;
    const pending = archiveMobileSession(f.client, "task", "zh-CN", () => current);
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
    current = false;
    (alert.mock.calls[0]![2] as { onPress: () => void }[])[1]!.onPress();
    await expect(pending).resolves.toBe(false);
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("does not turn a failed preview into an unbound task", async () => {
    const f = fixture(0);
    f.prepareSessionArchive.mockRejectedValueOnce(new Error("offline"));
    await expect(archiveMobileSession(f.client, "task", "en")).rejects.toThrow("offline");
    expect(alert).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });
});
