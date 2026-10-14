import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, type PersistedEvent, type QueueItemRecord } from "@joko/store";
import { extractPdfText, PdfTextExtractionError, PDF_TEXT_MAX_BYTES, PDF_TEXT_TIMEOUT_MS, type PdfTextWorkerResult } from "@joko/tool-document";

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

  it("adopts bounded PDF text only after worker retirement and preserves exact Blob and Task authority", { timeout: 30_000 }, async () => {
    const pdf = buildTextPdf(Array.from({ length: 41 }, (_, index) => `Evidence page ${index + 1}`));
    const extracted = await extractPdfText(pdf, 48_000);
    expect(extracted).toMatchObject({ numPages: 41, pagesInspected: 40, clipped: false });
    expect(extracted.sections.join("\n\n")).toContain("Evidence page 40");
    expect(extracted.sections.join("\n\n")).not.toContain("Evidence page 41");
    const clipped = await extractPdfText(pdf, 60);
    expect(clipped.clipped).toBe(true);
    expect(clipped.sections.join("\n\n").length).toBeLessThanOrEqual(60);
    expect(await extractPdfText(buildTextPdf([null]), 100)).toMatchObject({ sections: [], numPages: 1, pagesInspected: 1 });
    await expect(extractPdfText(Buffer.from("not a PDF"), 100)).rejects.toMatchObject({ code: "FAILED" });

    class UnknownWorker extends EventEmitter {
      terminate(): Promise<number> { return Promise.reject(new Error("private worker detail")); }
    }
    const unknownWorker = new UnknownWorker();
    const unknownResult = extractPdfText(pdf, 100, { workerFactory: () => unknownWorker });
    unknownWorker.emit("message", { ok: true, result: { sections: ["unconfirmed text"], numPages: 1, pagesInspected: 1, clipped: false } });
    await expect(unknownResult).rejects.toMatchObject({ code: "RETIREMENT_UNKNOWN" });
    class HungWorker extends EventEmitter {
      terminate(): Promise<number> { return new Promise(() => undefined); }
    }
    vi.useFakeTimers();
    try {
      const timedOut = extractPdfText(pdf, 100, { workerFactory: () => new HungWorker() });
      const rejected = expect(timedOut).rejects.toMatchObject({ code: "RETIREMENT_UNKNOWN" });
      await vi.advanceTimersByTimeAsync(PDF_TEXT_TIMEOUT_MS);
      await rejected;
    } finally { vi.useRealTimers(); }

    const fixture = setup();
    const bytes = new Map<string, Uint8Array>();
    const attachment = (id: string, data = pdf) => {
      bytes.set(id, data);
      return { kind: "file" as const, displayName: `${id}.pdf`, blob: {
        id, sha256: createHash("sha256").update(data).digest("hex"), byteLength: data.byteLength,
        mimeType: "application/pdf", fileName: `${id}.pdf`
      } };
    };
    const files = Array.from({ length: 5 }, (_, index) => attachment(`report-${index}`));
    const artifacts = {
      get: async (id: string) => {
        const data = bytes.get(id)!;
        return { id, sha256: createHash("sha256").update(data).digest("hex"), byteLength: data.byteLength, mimeType: "application/pdf" };
      },
      readBlob: async (blob: import("@joko/core").BlobRef) => ({ data: bytes.get(blob.id)!, mimeType: "application/pdf" })
    } as unknown as ArtifactStore;
    const workspaces = workspaceStub(fixture.root, cleanGit(), cleanDiff());
    const capture = await providerFor(fixture.store, workspaces, [], artifacts).capture(request(files[0]));
    const built = buildReviewEvidence(capture);
    expect(built.promptInput.artifactExcerpts?.[0]).toMatchObject({ format: "pdf-text", coverage: "Bounded text from 40 of 41 pages; later or clipped text is not covered." });
    expect(built.promptInput.artifactExcerpts?.[0]?.content).toContain("Evidence page 40");
    expect(built.promptInput.artifactWarnings?.[0]?.message).toContain("does not prove page layout");
    expect(JSON.stringify(built.freshness)).not.toContain("Evidence page");

    const parser = vi.fn(async () => extracted);
    const bounded = providerFor(fixture.store, workspaces, [], artifacts, parser);
    const counted = await bounded.capture({ ...request(), attachments: files });
    expect(parser).toHaveBeenCalledTimes(4);
    expect(counted.artifacts[4]).toMatchObject({ blob: files[4]!.blob, warning: expect.stringContaining("contents were not read") });
    expect(counted.artifacts[4]?.excerpt).toBeUndefined();
    const large = attachment("large", Buffer.alloc(PDF_TEXT_MAX_BYTES + 1));
    const oversized = await bounded.capture(request(large));
    expect(parser).toHaveBeenCalledTimes(4);
    expect(oversized.artifacts[0]).toMatchObject({ blob: large.blob, warning: expect.stringContaining("20 MiB") });
    expect(oversized.artifacts[0]?.excerpt).toBeUndefined();

    const unavailable = await providerFor(fixture.store, workspaces, [], artifacts, async () => {
      throw new PdfTextExtractionError("RETIREMENT_UNKNOWN");
    }).capture(request(files[0]));
    expect(unavailable.artifacts[0]).toMatchObject({ blob: files[0]!.blob, warning: expect.stringContaining("no text was adopted") });
    expect(unavailable.artifacts[0]?.excerpt).toBeUndefined();
    bytes.set(files[0]!.blob.id, Buffer.from(pdf).fill(0, 0, 1));
    await expect(bounded.capture(request(files[0]))).rejects.toMatchObject({ code: "artifact-unavailable" });
    bytes.set(files[0]!.blob.id, pdf);
    const changedPdf = buildTextPdf(["Changed evidence"]);
    const changedAttachment = attachment("changed", changedPdf);
    const changed = buildReviewEvidence(await bounded.capture(request(changedAttachment)));
    expect(changed.freshness.artifactsSha256).not.toBe(built.freshness.artifactsSha256);
    await expect(providerFor(fixture.store, workspaces, [], artifacts, async () => {
      const session = fixture.store.getSession("source");
      fixture.store.updateSession("source", { binding: { ...session.descriptor.binding, generation: 2 } }, session.revision, 3);
      return extracted;
    }).capture(request(files[0]))).rejects.toMatchObject({ code: "source-changed" });
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
  artifacts: ArtifactStore = {} as ArtifactStore,
  pdfText?: (data: Uint8Array, maxChars: number) => Promise<PdfTextWorkerResult>
) {
  return new DurableReviewEvidenceProvider({
    store,
    workspaces: workspaces as unknown as WorkspaceService,
    workspaceChanges: { listChangeSets: async () => changeSets } as unknown as WorkspaceChangeSetService,
    artifacts,
    ...(pdfText === undefined ? {} : { pdfText })
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

function buildTextPdf(pages: readonly (string | null)[]): Buffer {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const add = (value: string): number => { objects.push(value); return objects.length; };
  const pageIds = pages.map(text => {
    if (text === null) return add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>");
    const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}
