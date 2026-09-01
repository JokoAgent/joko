import { createHash } from "node:crypto";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkspaceChangeSetService,
  type RewindPreviewRecord,
  type WorkspaceBaseline,
  type WorkspaceChangeSetRecord,
  type WorkspaceSnapshotRepository
} from "./workspace-change-set.js";

class MemoryRepository implements WorkspaceSnapshotRepository {
  readonly baselines = new Map<string, WorkspaceBaseline>();
  readonly changes = new Map<string, WorkspaceChangeSetRecord>();
  readonly previews = new Map<string, RewindPreviewRecord>();
  readonly consumed = new Set<string>();
  onConsume: (() => Promise<void>) | undefined;
  async putBaseline(value: WorkspaceBaseline): Promise<void> { this.baselines.set(value.id, value); }
  async getBaseline(id: string): Promise<WorkspaceBaseline | undefined> { return this.baselines.get(id); }
  async putChangeSet(value: WorkspaceChangeSetRecord): Promise<void> { this.changes.set(value.id, value); }
  async getChangeSet(id: string): Promise<WorkspaceChangeSetRecord | undefined> { return this.changes.get(id); }
  async listChangeSets(): Promise<readonly WorkspaceChangeSetRecord[]> { return [...this.changes.values()]; }
  async putRewindPreview(value: RewindPreviewRecord): Promise<void> { this.previews.set(value.id, value); }
  async getRewindPreview(id: string): Promise<RewindPreviewRecord | undefined> { return this.previews.get(id); }
  async consumeRewindPreview(id: string, now: number): Promise<boolean> {
    const value = this.previews.get(id);
    if (value === undefined || value.expiresAt <= now || this.consumed.has(id)) return false;
    this.consumed.add(id);
    await this.onConsume?.();
    return true;
  }
}

function rewindJournalPath(snapshotDirectory: string, previewId: string): string {
  const name = createHash("sha256").update(previewId).digest("hex");
  return join(snapshotDirectory, "rewind-journals", `${name}.json`);
}

describe("WorkspaceChangeSetService", () => {
  it("previews and explicitly rewinds a stable turn change", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    await mkdir(join(root, "src"));
    const file = join(root, "src", "value.txt");
    await writeFile(file, "before\n");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(file, "after\n");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);
    expect(preview.safe).toBe(true);
    await service.applyRewind(preview.id);
    expect(await readFile(file, "utf8")).toBe("before\n");
  });

  it("restores deleted files through securely recreated parents and removes created regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const removedDirectory = join(root, "removed");
    await mkdir(removedDirectory);
    const deletedFile = join(removedDirectory, "old.txt");
    const secondDeletedFile = join(removedDirectory, "second.txt");
    await writeFile(deletedFile, "old-content");
    await writeFile(secondDeletedFile, "second-old-content");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await rename(removedDirectory, join(root, "removed-during-run"));
    const createdDirectory = join(root, "created");
    await mkdir(createdDirectory);
    const createdFile = join(createdDirectory, "new.txt");
    await writeFile(createdFile, "new-content");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);

    await service.applyRewind(preview.id);
    await expect(readFile(createdFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(deletedFile, "utf8")).toBe("old-content");
    expect(await readFile(secondDeletedFile, "utf8")).toBe("second-old-content");
  }, 15_000);

  it("fails closed when a file changes after preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const file = join(root, "value.txt");
    await writeFile(file, "one");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(file, "two");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);
    await writeFile(file, "external");
    await expect(service.applyRewind(preview.id)).rejects.toThrow(/changed after preview/);
  });

  it("carries the pre-run native leaf into a one-shot dialogue-only rewind claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-dialogue-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-dialogue-rewind-snapshots-"));
    await writeFile(join(root, "value.txt"), "before");
    const repository = new MemoryRepository();
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root, "native-leaf-before-run");
    await writeFile(join(root, "value.txt"), "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    expect(changeSet.dialogueEntryId).toBe("native-leaf-before-run");
    const preview = await service.previewRewind(changeSet.id);

    await expect(service.consumeDialogueOnlyRewind(preview.id)).resolves.toMatchObject({
      id: changeSet.id,
      dialogueEntryId: "native-leaf-before-run"
    });
    await expect(service.consumeDialogueOnlyRewind(preview.id)).rejects.toThrow(/already consumed/);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
  });

  it("rejects an ancestor directory exchange even when replacement content has the expected hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(join(source, "value.txt"), "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);

    await rename(source, join(root, "original-src"));
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "after");

    await expect(service.applyRewind(preview.id)).rejects.toThrow(/identity changed after preview/);
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, "original-src", "value.txt"), "utf8")).toBe("after");
  });

  it("revalidates the sealed ancestor boundary after preview consumption and before the first mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const repository = new MemoryRepository();
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(join(source, "value.txt"), "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);
    repository.onConsume = async () => {
      await rename(source, join(root, "source-exchanged-during-claim"));
      await mkdir(source);
      await writeFile(join(source, "value.txt"), "after");
    };

    await expect(service.applyRewind(preview.id)).rejects.toThrow(/identity changed after preview/);
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("after");
    const journal = JSON.parse(await readFile(rewindJournalPath(snapshots, preview.id), "utf8")) as { status: string };
    expect(journal.status).toBe("outcome_unknown");
  });

  it.skipIf(process.platform === "win32")("fails closed on a symlinked workspace ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const outside = await mkdtemp(join(tmpdir(), "joko-rewind-outside-"));
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(join(source, "value.txt"), "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);

    await rename(source, join(root, "original-src"));
    await writeFile(join(outside, "value.txt"), "after");
    await symlink(outside, source, "dir");

    await expect(service.applyRewind(preview.id)).rejects.toThrow(/changed after preview/);
    expect(await readFile(join(outside, "value.txt"), "utf8")).toBe("after");
  });

  it.skipIf(process.platform !== "win32")("fails closed on a Windows junction/reparse ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const outside = await mkdtemp(join(tmpdir(), "joko-rewind-outside-"));
    const source = join(root, "src");
    await mkdir(source);
    await writeFile(join(source, "value.txt"), "before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository: new MemoryRepository() });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(join(source, "value.txt"), "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);

    await rename(source, join(root, "original-src"));
    await writeFile(join(outside, "value.txt"), "after");
    await symlink(outside, source, "junction");

    await expect(service.applyRewind(preview.id)).rejects.toThrow(/changed after preview/);
    expect(await readFile(join(outside, "value.txt"), "utf8")).toBe("after");
  });

  it("durably records a partial apply and resumes only the remaining file after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const repository = new MemoryRepository();
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "a-before");
    await writeFile(b, "b-before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(a, "a-after");
    await writeFile(b, "b-after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);
    const secondBlob = changeSet.changes.find((change) => change.path === "b.txt")?.before?.blobPath;
    if (secondBlob === undefined) throw new Error("Test baseline blob is missing.");
    const heldBlob = `${secondBlob}.held`;
    await rename(secondBlob, heldBlob);

    await expect(service.applyRewind(preview.id)).rejects.toThrow();
    expect(await readFile(a, "utf8")).toBe("a-before");
    expect(await readFile(b, "utf8")).toBe("b-after");
    const partial = JSON.parse(await readFile(rewindJournalPath(snapshots, preview.id), "utf8")) as {
      status: string;
      entries: Array<{ path: string; state: string }>;
    };
    expect(partial.status).toBe("partial");
    expect(partial.entries.find((entry) => entry.path === "a.txt")?.state).toBe("applied");
    expect(partial.entries.find((entry) => entry.path === "b.txt")?.state).toBe("applying");

    await rename(heldBlob, secondBlob);
    const restarted = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await restarted.initialize();
    await restarted.applyRewind(preview.id);
    expect(await readFile(a, "utf8")).toBe("a-before");
    expect(await readFile(b, "utf8")).toBe("b-before");
    await expect(restarted.applyRewind(preview.id)).resolves.toBeUndefined();
    const completed = JSON.parse(await readFile(rewindJournalPath(snapshots, preview.id), "utf8")) as { status: string };
    expect(completed.status).toBe("succeeded");
  }, 15_000);

  it("marks an indeterminate interrupted file outcome unknown at startup and never blindly replays it", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-rewind-workspace-"));
    const snapshots = await mkdtemp(join(tmpdir(), "joko-rewind-snapshots-"));
    const repository = new MemoryRepository();
    const file = join(root, "value.txt");
    await writeFile(file, "before");
    const service = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await service.initialize();
    const baseline = await service.captureBaseline("workspace", root);
    await writeFile(file, "after");
    const changeSet = await service.captureChangeSet(baseline.id, "session", "run");
    const preview = await service.previewRewind(changeSet.id);
    const blob = changeSet.changes[0]?.before?.blobPath;
    if (blob === undefined) throw new Error("Test baseline blob is missing.");
    const heldBlob = `${blob}.held`;
    await rename(blob, heldBlob);
    await expect(service.applyRewind(preview.id)).rejects.toThrow();

    await writeFile(file, "indeterminate-external-content");
    await rename(heldBlob, blob);
    const restarted = new WorkspaceChangeSetService({ snapshotDirectory: snapshots, repository });
    await restarted.initialize();
    const recovered = JSON.parse(await readFile(rewindJournalPath(snapshots, preview.id), "utf8")) as { status: string };
    expect(recovered.status).toBe("outcome_unknown");
    await expect(restarted.applyRewind(preview.id)).rejects.toThrow(/unknown prior outcome/);
    expect(await readFile(file, "utf8")).toBe("indeterminate-external-content");
  });
});
