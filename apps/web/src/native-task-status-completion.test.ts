import { describe, expect, it, vi } from "vitest";
import type { SessionView } from "./model.js";
import { executeNativeTaskStatusCompletion } from "./native-task-status-completion.js";

function fixture() {
  let current = true;
  const source = { session: { id: "task" } as SessionView, isCurrent: () => current,
    readArchivePreview: vi.fn(async (_signal: AbortSignal) => ({ hasWorktree: true, dirty: true,
      activeBoundScheduleCount: 1, activeBoundScheduleNames: ["Nightly"], archiveConfirmation: "a".repeat(64) })),
    archive: vi.fn(async () => undefined), markRead: vi.fn(async () => undefined) };
  return { source, retire: () => { current = false; } };
}

describe("native completion actions", () => {
  it("confirms the original bounded bindings before passing the exact receipt to archive", async () => {
    const f = fixture();
    const confirm = vi.fn(async () => true);
    expect(await executeNativeTaskStatusCompletion(f.source, "archive", confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(f.source.session, expect.objectContaining({ activeBoundScheduleNames: ["Nightly"] }));
    expect(f.source.archive).toHaveBeenCalledWith("a".repeat(64));
  });
  it("retires a confirmation after a node, task or completion change", async () => {
    const f = fixture();
    await expect(executeNativeTaskStatusCompletion(f.source, "archive", async () => { f.retire(); return true; }))
      .rejects.toThrow("source changed");
    expect(f.source.archive).not.toHaveBeenCalled();
  });
  it("does not archive after cancellation, a failed projection or a lost effect receipt", async () => {
    const f = fixture();
    expect(await executeNativeTaskStatusCompletion(f.source, "archive", async () => false)).toBe(false);
    expect(f.source.archive).not.toHaveBeenCalled();
    f.source.readArchivePreview.mockRejectedValueOnce(new Error("offline"));
    await expect(executeNativeTaskStatusCompletion(f.source, "archive", async () => true)).rejects.toThrow("could not be verified");
    expect(f.source.archive).not.toHaveBeenCalled();
    f.source.archive.mockRejectedValueOnce(new Error("unknown original operation"));
    await expect(executeNativeTaskStatusCompletion(f.source, "archive", async () => true)).rejects.toThrow("unknown original operation");
    expect(f.source.archive).toHaveBeenCalledOnce();
  });
  it("marks read through the original owner without reading an archive preview", async () => {
    const f = fixture();
    expect(await executeNativeTaskStatusCompletion(f.source, "markRead", async () => true)).toBe(true);
    expect(f.source.markRead).toHaveBeenCalledOnce(); expect(f.source.readArchivePreview).not.toHaveBeenCalled();
  });
});
