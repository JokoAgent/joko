import type { BlobRef } from "@joko/core";
import * as contract from "@joko/contracts";
import type { BrowserAction, BrowserLease, BrowserLeaseFence, BrowserPageState, BrowserTakeover, BrowserTakeoverFence } from "@joko/tool-browser";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactRecord } from "./artifact-store.js";
import {
  BrowserTransferCoordinator,
  type BrowserTransferArtifactStore,
  type BrowserTransferProvider,
  type BrowserTransferRepository,
  type PersistedBrowserTransfer
} from "./browser-transfers.js";

const sourceBlob: BlobRef = {
  id: "blob-source",
  sha256: "a".repeat(64),
  byteLength: 7,
  mimeType: "text/plain",
  fileName: "upload.txt"
};

class FakeArtifacts implements BrowserTransferArtifactStore {
  readonly calls: string[] = [];
  resolveFailure = false;
  ingestFailure = false;

  async resolveBlobPath(blob: BlobRef): Promise<string> {
    this.calls.push(`resolve:${blob.id}`);
    if (this.resolveFailure) throw new Error("D:\\private\\source is not approved");
    return "D:\\artifacts\\verified-upload.txt";
  }

  async ingestPath(sourcePath: string, options?: { fileName?: string }): Promise<ArtifactRecord> {
    this.calls.push(`ingest:${sourcePath}:${options?.fileName ?? ""}`);
    if (this.ingestFailure) throw new Error(`Rejected private path ${sourcePath}`);
    return {
      id: "download-artifact",
      sha256: "b".repeat(64),
      byteLength: 11,
      mimeType: "application/pdf",
      fileName: options?.fileName ?? "download.pdf",
      storagePath: "D:\\artifacts\\blobs\\download",
      createdAt: 2_000
    };
  }
}

class FakeProvider implements BrowserTransferProvider {
  generation = 7;
  readonly calls: string[] = [];
  readonly actions: BrowserAction[] = [];
  readonly humanUploads: Array<{ selector: string; files: string[] }> = [];
  failAction = false;
  rejectAgentLease = false;
  takeover: BrowserTakeover | undefined;
  actionGate: Promise<void> | undefined;
  activeActions = 0;
  maximumActiveActions = 0;
  #nextLease = 1;

  acquireAgentLease(owner: string, _ttlMs?: number): BrowserLease {
    this.calls.push(`acquire:${owner}:${this.generation}`);
    if (this.rejectAgentLease) throw new Error("Human control owns the Browser Provider");
    const now = Date.now();
    return {
      id: `lease-${this.#nextLease++}`,
      providerId: "browser",
      owner,
      generation: this.generation,
      mode: "agent",
      acquiredAt: now,
      expiresAt: now + 60_000
    };
  }

  async releaseAgentLease(lease: BrowserLeaseFence): Promise<void> {
    this.calls.push(`release:${lease.id}:${lease.generation}`);
  }

  async act(pageId: string, lease: BrowserLeaseFence, action: BrowserAction): Promise<BrowserPageState> {
    this.calls.push(`act:${pageId}:${lease.id}:${lease.generation}`);
    this.actions.push(action);
    this.activeActions += 1;
    this.maximumActiveActions = Math.max(this.maximumActiveActions, this.activeActions);
    try {
      await this.actionGate;
      if (this.failAction) throw new Error("Playwright failed near D:\\private\\profile");
      return { id: pageId, url: "https://example.test/", title: "Upload", state: "ready" };
    } finally {
      this.activeActions -= 1;
    }
  }

  currentHumanTakeover(): BrowserTakeover | undefined {
    return this.takeover;
  }

  async runHumanTakeoverOperation<T>(
    takeover: BrowserTakeoverFence,
    operation: (page: { setInputFiles(selector: string, files: string[]): Promise<void> }) => Promise<T>
  ): Promise<T> {
    const current = this.takeover;
    if (
      current === undefined
      || current.providerId !== takeover.providerId
      || current.pageId !== takeover.pageId
      || current.generation !== takeover.generation
      || current.owner !== takeover.owner
      || current.takeoverId !== takeover.takeoverId
    ) throw new Error("Takeover fence is stale");
    this.calls.push(`human:${takeover.pageId}:${takeover.takeoverId}:${takeover.generation}`);
    return operation({
      setInputFiles: async (selector, files) => {
        this.humanUploads.push({ selector, files: [...files] });
      }
    });
  }

  async recover(): Promise<void> {
    this.calls.push(`recover:${this.generation}`);
    this.generation += 1;
  }
}

class MemoryTransferRepository implements BrowserTransferRepository {
  readonly values = new Map<string, PersistedBrowserTransfer>();
  list(browserProviderId: string): readonly PersistedBrowserTransfer[] {
    return [...this.values.values()].filter((item) => item.browserProviderId === browserProviderId);
  }
  put(record: PersistedBrowserTransfer): void {
    this.values.set(record.id, structuredClone(record));
  }
  delete(_browserProviderId: string, browserTransferId: string): void {
    this.values.delete(browserTransferId);
  }
}

describe("BrowserTransferCoordinator", () => {
  it("resolves a blob before leasing and completes one Connect-friendly upload call", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    const onActivityTransition = vi.fn();
    const transfers = new BrowserTransferCoordinator({
      artifacts,
      provider,
      now: () => 1_000,
      onActivityTransition
    });

    const transfer = await transfers.upload(sourceBlob, "page-1", "input[type=file]", { id: "connection-1" });

    expect(transfer.state).toBe(contract.BrowserTransferState.COMPLETED);
    expect(transfer.direction).toBe(contract.TransferDirection.UPLOAD);
    expect(transfer.browserProviderId).toBe("browser");
    expect(transfer.blob?.blobId).toBe(sourceBlob.id);
    expect(artifacts.calls).toEqual(["resolve:blob-source"]);
    expect(provider.calls).toEqual([
      "acquire:connection-1:7",
      "act:page-1:lease-1:7",
      "release:lease-1:7"
    ]);
    expect(provider.actions).toEqual([{
      type: "upload",
      selector: "input[type=file]",
      paths: ["D:\\artifacts\\verified-upload.txt"]
    }]);
    expect(transfers.get(transfer.browserTransferId)).toEqual(transfer);
    expect(onActivityTransition.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("releases the lease and retains a redacted failed transfer", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    provider.failAction = true;
    const transfers = new BrowserTransferCoordinator({ artifacts, provider });

    const transfer = await transfers.upload(sourceBlob, "page-1", "#private-file", { id: "connection-1" });

    expect(transfer.state).toBe(contract.BrowserTransferState.FAILED);
    expect(transfer.error?.code).toBe("BROWSER_UPLOAD_FAILED");
    expect(transfer.error?.message).not.toContain("D:\\private");
    expect(provider.calls.at(-1)).toBe("release:lease-1:7");
    expect(transfers.list({ state: contract.BrowserTransferState.FAILED })).toHaveLength(1);
    expect(transfers.list({ state: contract.BrowserTransferState.COMPLETED })).toEqual([]);
    expect(transfers.list({ browserProviderId: "different" })).toEqual([]);
  });

  it("uses only the authenticated takeover for an upload to its exact page", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    provider.rejectAgentLease = true;
    provider.takeover = {
      providerId: "browser",
      pageId: "page-1",
      generation: 7,
      owner: "connection-1",
      takeoverId: "takeover-1",
      startedAt: 1_000,
      expiresAt: 61_000
    };
    const transfers = new BrowserTransferCoordinator({ artifacts, provider });

    const transfer = await transfers.upload(sourceBlob, "page-1", "#human-file", {
      id: "connection-1",
      humanTakeover: provider.takeover!
    });

    expect(transfer.state).toBe(contract.BrowserTransferState.COMPLETED);
    expect(provider.calls).toEqual(["human:page-1:takeover-1:7"]);
    expect(provider.humanUploads).toEqual([{
      selector: "#human-file",
      files: ["D:\\artifacts\\verified-upload.txt"]
    }]);
    expect(provider.actions).toEqual([]);
  });

  it("does not reuse a takeover owned by another connection or page", async () => {
    const provider = new FakeProvider();
    provider.rejectAgentLease = true;
    provider.takeover = {
      providerId: "browser",
      pageId: "page-2",
      generation: 7,
      owner: "connection-2",
      takeoverId: "takeover-2",
      startedAt: 1_000,
      expiresAt: 61_000
    };
    const transfers = new BrowserTransferCoordinator({ artifacts: new FakeArtifacts(), provider });

    const transfer = await transfers.upload(sourceBlob, "page-1", "#human-file", {
      id: "connection-1",
      humanTakeover: provider.takeover!
    });

    expect(transfer.state).toBe(contract.BrowserTransferState.FAILED);
    expect(transfer.error?.code).toBe("BROWSER_LEASE_UNAVAILABLE");
    expect(provider.calls).toEqual(["acquire:connection-1:7"]);
    expect(provider.humanUploads).toEqual([]);
  });

  it("serializes concurrent uploads around the exclusive agent lease", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    let releaseFirst!: () => void;
    provider.actionGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const transfers = new BrowserTransferCoordinator({ artifacts, provider });

    const first = transfers.upload(sourceBlob, "page-1", "#one", { id: "connection-1" });
    const second = transfers.upload(sourceBlob, "page-2", "#two", { id: "connection-2" });
    await vi.waitFor(() => expect(provider.actions).toHaveLength(1));
    expect(transfers.list({ state: contract.BrowserTransferState.PENDING })).toHaveLength(1);
    releaseFirst();
    provider.actionGate = undefined;

    const results = await Promise.all([first, second]);
    expect(results.map((item) => item.state)).toEqual([
      contract.BrowserTransferState.COMPLETED,
      contract.BrowserTransferState.COMPLETED
    ]);
    expect(provider.maximumActiveActions).toBe(1);
    expect(provider.calls.filter((item) => item.startsWith("release:"))).toHaveLength(2);
  });

  it("fences running and queued transfers across recovery", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    let finishAction!: () => void;
    provider.actionGate = new Promise<void>((resolve) => { finishAction = resolve; });
    const transfers = new BrowserTransferCoordinator({ artifacts, provider });

    const running = transfers.upload(sourceBlob, "page-1", "#one", { id: "connection-1" });
    const queued = transfers.upload(sourceBlob, "page-2", "#two", { id: "connection-2" });
    await vi.waitFor(() => expect(provider.actions).toHaveLength(1));
    await transfers.recover();
    finishAction();

    const results = await Promise.all([running, queued]);
    expect(provider.generation).toBe(8);
    expect(results.every((item) => item.state === contract.BrowserTransferState.FAILED)).toBe(true);
    expect(results.every((item) => item.error?.code === "BROWSER_GENERATION_FENCED")).toBe(true);
    expect(provider.actions).toHaveLength(1);
    expect(provider.calls).toContain("release:lease-1:7");
  });

  it("ingests downloads into a durable blob and artifact descriptor", async () => {
    const artifacts = new FakeArtifacts();
    const provider = new FakeProvider();
    const transfers = new BrowserTransferCoordinator({ artifacts, provider, now: () => 2_000 });

    const transfer = await transfers.ingestDownload("page-download", "D:\\browser-private\\random.pdf", "report.pdf");

    expect(transfer.state).toBe(contract.BrowserTransferState.COMPLETED);
    expect(transfer.direction).toBe(contract.TransferDirection.DOWNLOAD);
    expect(transfer.blob?.blobId).toBe("download-artifact");
    expect(transfer.artifact?.artifactId).toBe("download-artifact");
    expect(transfer.artifact?.title).toBe("report.pdf");
    expect(artifacts.calls).toEqual(["ingest:D:\\browser-private\\random.pdf:report.pdf"]);
  });

  it("fails closed on an unsafe download name or ArtifactStore path rejection", async () => {
    const artifacts = new FakeArtifacts();
    artifacts.ingestFailure = true;
    const provider = new FakeProvider();
    const transfers = new BrowserTransferCoordinator({ artifacts, provider });

    const rejectedPath = await transfers.ingestDownload("page-download", "D:\\private\\secret.pdf", "report.pdf");
    const rejectedName = await transfers.ingestDownload("page-download", "D:\\private\\secret.pdf", "../secret.pdf");

    expect(rejectedPath.state).toBe(contract.BrowserTransferState.FAILED);
    expect(rejectedPath.error?.message).not.toContain("D:\\private");
    expect(rejectedName.state).toBe(contract.BrowserTransferState.FAILED);
    expect(artifacts.calls).toHaveLength(1);
  });

  it("makes the BrowserProvider hook reject after recording an ingest failure", async () => {
    const artifacts = new FakeArtifacts();
    artifacts.ingestFailure = true;
    const transfers = new BrowserTransferCoordinator({ artifacts, provider: new FakeProvider() });

    await expect(transfers.onDownload("page-download", "D:\\private\\secret.pdf", "report.pdf"))
      .rejects.toThrow("artifact ingest failed");
    expect(transfers.list({ state: contract.BrowserTransferState.FAILED })).toHaveLength(1);
  });

  it("restores terminal transfers and marks crash-window work outcome-unknown", () => {
    const repository = new MemoryTransferRepository();
    repository.put({
      id: "completed-transfer",
      browserProviderId: "browser",
      pageId: "page-1",
      toolCallId: "",
      direction: contract.TransferDirection.UPLOAD,
      initiatedAt: 100,
      generation: 7,
      state: contract.BrowserTransferState.COMPLETED,
      completedAt: 110,
      blob: sourceBlob
    });
    repository.put({
      id: "running-transfer",
      browserProviderId: "browser",
      pageId: "page-2",
      toolCallId: "",
      direction: contract.TransferDirection.UPLOAD,
      initiatedAt: 120,
      generation: 7,
      state: contract.BrowserTransferState.RUNNING,
      startedAt: 121,
      blob: sourceBlob
    });

    const restored = new BrowserTransferCoordinator({
      artifacts: new FakeArtifacts(),
      provider: new FakeProvider(),
      repository,
      now: () => 200
    });

    expect(restored.get("completed-transfer")?.state).toBe(contract.BrowserTransferState.COMPLETED);
    expect(restored.get("running-transfer")).toMatchObject({
      state: contract.BrowserTransferState.FAILED,
      error: { code: "BROWSER_TRANSFER_OUTCOME_UNKNOWN" }
    });
    expect(repository.values.get("running-transfer")?.state).toBe(contract.BrowserTransferState.FAILED);
  });
});
