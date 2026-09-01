import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, type PersistedEvent, type QueueItemRecord } from "@joko/store";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import type { ArtifactStore } from "./artifact-store.js";
import { ArtifactStore as RealArtifactStore } from "./artifact-store.js";
import { buildReviewEvidence } from "./review-evidence.js";
import { DurableReviewEvidenceProvider, ReviewEvidenceCaptureError } from "./review-evidence-provider.js";
import type { WorkspaceChangeSetService } from "./workspace-change-set.js";
import type { WorkspaceService } from "./workspace-service.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

describe("DurableReviewEvidenceProvider", () => {
  it("fingerprints only reviewed paths so unrelated workspace edits do not stale Review", async () => {
    const fixture = setup();
    writeWorkspaceFile(fixture.root, "src/a.ts", "export const a = 1;\n");
    const workspaces = workspaceStub(fixture.root, {
      ...cleanGit(),
      dirty: true,
      changes: [{ path: "src/a.ts", index: " ", worktree: "M" }]
    }, dirtyDiff("src/a.ts", "revision-1"));
    const provider = providerFor(fixture.store, workspaces, []);
    const first = buildReviewEvidence(await provider.capture(request()));
    writeWorkspaceFile(fixture.root, "unrelated.txt", "not reviewed\n");
    const second = buildReviewEvidence(await provider.capture(request()));
    expect(second.freshness.filesSha256).toBe(first.freshness.filesSha256);
    expect(second.freshness.workspaceSha256).toBe(first.freshness.workspaceSha256);
    expect(workspaces.list).not.toHaveBeenCalled();
  });

  it("fingerprints a selected ignored deliverable from the fallback change-set", async () => {
    const fixture = setup();
    writeWorkspaceFile(fixture.root, "dist/result.txt", "one\n");
    const changeSet = {
      id: "change-1", baselineId: "base-1", workspaceId: "workspace", workspaceRoot: fixture.root,
      sessionId: "source", runId: "run-old", complete: true, gaps: [], capturedAt: 1,
      changes: [{ path: "dist/result.txt", kind: "updated" as const }]
    };
    const provider = providerFor(fixture.store, workspaceStub(fixture.root, cleanGit(), cleanDiff()), [changeSet]);
    const first = buildReviewEvidence(await provider.capture(request()));
    writeWorkspaceFile(fixture.root, "dist/result.txt", "two\n");
    const second = buildReviewEvidence(await provider.capture(request()));
    expect(second.freshness.filesSha256).not.toBe(first.freshness.filesSha256);
  });

  it("rejects an active source before reading workspace evidence", async () => {
    const fixture = setup();
    fixture.store.createRun({ id: "active", sessionId: "source", source: "user", state: "running", createdAt: 2 });
    const workspaces = workspaceStub(fixture.root, cleanGit(), cleanDiff());
    await expect(providerFor(fixture.store, workspaces, []).capture(request()))
      .rejects.toMatchObject({ code: "source-busy" } satisfies Partial<ReviewEvidenceCaptureError>);
    expect(workspaces.gitState).not.toHaveBeenCalled();
  });

  it("reobserves a focus-only Review from its durable source identity without retaining focus text", async () => {
    const fixture = setup();
    const provider = providerFor(fixture.store, workspaceStub(fixture.root, cleanGit(), cleanDiff()), []);
    const initial = buildReviewEvidence(await provider.capture({
      sourceSessionId: "source",
      focus: "transient review focus",
      attachments: []
    }));
    const reobserved = buildReviewEvidence(await provider.capture({
      sourceSessionId: "source",
      attachments: []
    }, "reobserve"));
    expect(reobserved.freshness).toEqual(initial.freshness);
  });

  it("captures a visible prompt whose Event and Queue Item are both on continuation pages", { timeout: 20_000 }, async () => {
    const fixture = setup();
    fixture.store.createRun({
      id: "review-tail-run",
      sessionId: "source",
      source: "user",
      state: "completed",
      createdAt: 2
    });
    const tail = fixture.store.appendEvent({
      id: "review-tail-message",
      backendId: "pi",
      targetId: "workspace",
      sessionId: "source",
      runId: "review-tail-run",
      generation: 1,
      emittedAt: 3,
      traceId: "review-tail-message",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "tail review evidence" }]
      }
    });
    const fillerEvent: PersistedEvent = {
      ...tail,
      id: "review-event-filler",
      globalCursor: 100_000n,
      runId: undefined,
      payload: { type: "status", key: "test.review_event_filler", text: "" }
    };
    const fillerQueue = {
      id: "review-queue-filler",
      runId: "review-queue-filler-run",
      disposition: "steer"
    } as unknown as QueueItemRecord;
    const tailQueue = {
      id: "review-tail-queue",
      runId: "review-tail-run",
      disposition: "prompt"
    } as unknown as QueueItemRecord;
    const originalQueue = fixture.store.listQueueItems.bind(fixture.store);
    const events = vi.spyOn(fixture.store, "listEvents").mockImplementation((query = {}) => {
      if (query.afterCursor === undefined) return Array<PersistedEvent>(100_000).fill(fillerEvent);
      if (query.afterCursor === 100_000n) return [{ ...tail, globalCursor: 100_001n }];
      return [];
    });
    const queue = vi.spyOn(fixture.store, "listQueueItems").mockImplementation((options = {}) => {
      if (options.limit !== 100_000) return originalQueue(options);
      if ((options.offset ?? 0) === 0) return Array<QueueItemRecord>(100_000).fill(fillerQueue);
      if (options.offset === 100_000) return [tailQueue];
      return [];
    });
    try {
      const captured = await providerFor(
        fixture.store,
        workspaceStub(fixture.root, cleanGit(), cleanDiff()),
        []
      ).capture(request());
      expect(captured.conversation.messages).toEqual([{
        id: tail.id,
        ordinal: 0,
        role: "user",
        text: "tail review evidence"
      }]);
    } finally {
      events.mockRestore();
      queue.mockRestore();
    }
  });

  it("includes clean branch base and merge-base movement in freshness", async () => {
    const fixture = setup();
    let base = "b".repeat(40);
    const workspaces = workspaceStub(fixture.root, cleanGit(), cleanDiff());
    workspaces.gitReviewDiff.mockImplementation(async () => ({
      index: "", workingTree: "", comparison: "", repositoryRevision: `branch-${base}`,
      baseRevision: base, headRevision: "a".repeat(40), mergeBaseRevision: base,
      source: "branch", sourceRevision: base, resolvedBaseRef: "origin/main"
    }));
    const provider = providerFor(fixture.store, workspaces, []);
    const firstCapture = await provider.capture(request());
    expect(firstCapture.branchEvidence?.baseRefLabel).toBe("origin/main");
    const first = buildReviewEvidence(firstCapture);
    base = "c".repeat(40);
    const second = buildReviewEvidence(await provider.capture(request()));
    expect(second.freshness.workspaceSha256).not.toBe(first.freshness.workspaceSha256);
  });

  it("fails closed instead of routing an unmatched target to the first workspace", async () => {
    const fixture = setup("unmatched-target");
    const workspaces = workspaceStub(fixture.root, cleanGit(), cleanDiff());
    await expect(providerFor(fixture.store, workspaces, []).capture(request()))
      .rejects.toMatchObject({ code: "artifact-unavailable" } satisfies Partial<ReviewEvidenceCaptureError>);
    expect(workspaces.gitState).not.toHaveBeenCalled();
  });

  it.each([
    ["small text", "text/plain", Buffer.from("original text")],
    ["image", "image/png", Buffer.from("\x89PNG\r\nreview-image")],
    ["binary", "application/octet-stream", Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])],
    ["large file", "application/octet-stream", Buffer.alloc(64 * 1024, 0x61)]
  ])("rejects same-length content tampering for %s artifacts", async (_label, mimeType, original) => {
    const fixture = setup();
    const artifacts = new RealArtifactStore({
      rootDirectory: path.join(fixture.directory, "artifacts"),
      repository: new OperationalArtifactRepository(fixture.store),
      ingestRoots: [fixture.directory]
    });
    await artifacts.initialize();
    const stored = await artifacts.ingestBytes(original, { fileName: "evidence.bin", mimeType });
    const provider = providerFor(
      fixture.store,
      workspaceStub(fixture.root, cleanGit(), cleanDiff()),
      [],
      artifacts
    );
    const reviewRequest = request({ kind: mimeType === "image/png" ? "image" : "file", displayName: "evidence.bin", blob: stored });
    await expect(provider.capture(reviewRequest)).resolves.toBeDefined();
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] === 0xff ? 0xfe : tampered[0]! + 1;
    writeFileSync(stored.storagePath, tampered);
    await expect(provider.capture(reviewRequest)).rejects.toMatchObject({ code: "artifact-unavailable" });
  });

  it("rejects per-artifact and aggregate Review byte budgets before artifact I/O", async () => {
    const fixture = setup();
    const provider = providerFor(fixture.store, workspaceStub(fixture.root, cleanGit(), cleanDiff()), []);
    const blob = (id: string, byteLength: number) => ({
      id,
      sha256: id.padEnd(64, "a").slice(0, 64),
      byteLength,
      mimeType: "application/octet-stream",
      fileName: `${id}.bin`
    });
    await expect(provider.capture({
      sourceSessionId: "source",
      focus: "review",
      attachments: [{ kind: "file", displayName: "huge.bin", blob: blob("b", 64 * 1024 * 1024 + 1) }]
    })).rejects.toMatchObject({ code: "artifact-unavailable" });
    await expect(provider.capture({
      sourceSessionId: "source",
      focus: "review",
      attachments: ["c", "d", "e"].map((id) => ({
        kind: "file" as const,
        displayName: `${id}.bin`,
        blob: blob(id, 48 * 1024 * 1024)
      }))
    })).rejects.toMatchObject({ code: "artifact-unavailable" });
  });
});

function setup(targetId = "workspace") {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-review-evidence-provider-"));
  const root = path.join(directory, "workspace");
  mkdirSync(root);
  const store = new OperationalStore(path.join(directory, "store.sqlite"));
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.upsertBackend({
    id: "pi", adapterKind: "fixture", instanceGeneration: 0,
    displayName: "Pi", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({ id: targetId, backendId: "pi", displayName: "Target", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({
    id: "source", backendId: "pi", targetId, title: "Source",
    binding: { opaqueRef: "native/source.jsonl", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false,
    fastMode: false, createdAt: 1, updatedAt: 1
  });
  return { store, root, directory };
}

function providerFor(
  store: OperationalStore,
  workspaces: ReturnType<typeof workspaceStub>,
  changeSets: readonly unknown[],
  artifacts: ArtifactStore = {} as ArtifactStore
) {
  return new DurableReviewEvidenceProvider({
    store,
    workspaces: workspaces as unknown as WorkspaceService,
    workspaceChanges: { listChangeSets: async () => changeSets } as unknown as WorkspaceChangeSetService,
    artifacts
  });
}

function workspaceStub(root: string, state: ReturnType<typeof cleanGit>, diff: ReturnType<typeof cleanDiff>) {
  return {
    listRegistrations: vi.fn(() => [{ id: "workspace", root, displayName: "Workspace", trusted: true }]),
    list: vi.fn(() => { throw new Error("recursive workspace listing is forbidden"); }),
    gitState: vi.fn(async () => state),
    gitDiff: vi.fn(async () => diff),
    gitReviewDiff: vi.fn(async () => ({
      index: "", workingTree: "", comparison: "", repositoryRevision: "branch-clean",
      baseRevision: "b".repeat(40), headRevision: "a".repeat(40), mergeBaseRevision: "b".repeat(40),
      source: "branch" as const, sourceRevision: "b".repeat(40)
    }))
  };
}

function cleanGit() {
  return { repository: true as const, branch: "feature", head: "a".repeat(40), dirty: false, changes: [] as Array<{ path: string; index: string; worktree: string }> };
}

function cleanDiff() {
  return { index: "", workingTree: "", comparison: "", repositoryRevision: "working-clean", headRevision: "a".repeat(40) };
}

function dirtyDiff(file: string, revision: string) {
  return {
    index: "", comparison: "", repositoryRevision: revision, headRevision: "a".repeat(40),
    workingTree: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`
  };
}

function writeWorkspaceFile(root: string, relativePath: string, content: string): void {
  const destination = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function request(attachment?: { readonly kind: "file" | "image"; readonly displayName: string; readonly blob: import("@joko/core").BlobRef }) {
  return {
    sourceSessionId: "source",
    focus: "review the deliverable",
    attachments: attachment === undefined ? [] : [attachment]
  };
}
