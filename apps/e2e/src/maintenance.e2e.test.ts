import { stat } from "node:fs/promises";

import { ArtifactStorageCleanupStatus, TaskHistoryMaintenanceStatus, TaskHistoryRetention } from "@joko/contracts";
import type { AdapterContext, NativeSessionBinding } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

it("confirms Artifact cleanup through authenticated HTTP, resumes the same receipt, and retains the result after service restart", async () => {
  let fixture = await OrchestratorE2eFixture.start();
  try {
    const paired = await fixture.pair();
    const artifact = await fixture.application.artifacts.ingestBytes(Buffer.from("expired maintenance blob"), {
      expiresAt: Date.now() - 60_000
    });
    const stats = await paired.clients.artifact.getArtifactStorageStats({});
    expect(stats.stats?.referenceCount).toBe(0n);

    const scan = (await paired.clients.artifact.scanArtifactStorage({})).scan!;
    expect(scan.expiredReferenceCount).toBe(1n);
    expect(scan.orphanBlobCount).toBe(1n);
    const begun = (await paired.clients.artifact.beginArtifactStorageCleanup({ scanToken: scan.token })).progress!;
    expect(begun.maintenanceId).toBe(scan.token);
    const terminal = await waitFor(
      async () => (await paired.clients.artifact.getArtifactStorageCleanup({ maintenanceId: scan.token })).progress!,
      (progress) => progress.status !== ArtifactStorageCleanupStatus.RUNNING,
      "Artifact storage cleanup"
    );
    expect(terminal.status).toBe(ArtifactStorageCleanupStatus.COMPLETED);
    expect(terminal.result).toMatchObject({ expiredReferencesDeleted: 1n, blobsRemoved: 1n });
    expect(fixture.application.store.findArtifact(artifact.id)).toBeUndefined();
    await expect(stat(artifact.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await paired.clients.artifact.beginArtifactStorageCleanup({ scanToken: scan.token })).progress)
      .toMatchObject({ maintenanceId: scan.token, status: ArtifactStorageCleanupStatus.COMPLETED });

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory: root });
    const client = fixture.clients(paired.authKey).artifact;
    expect((await client.getArtifactStorageCleanup({ maintenanceId: scan.token })).progress)
      .toMatchObject({ status: ArtifactStorageCleanupStatus.COMPLETED, result: { blobsRemoved: 1n } });
    expect((await client.reconcileArtifactStorage({})).result)
      .toMatchObject({ healthy: true, unsafeEntryCount: 0n });
  } finally {
    await fixture.close({ removeRoot: true });
  }
});

it("prunes archived and explicitly included active task history through authenticated HTTP while retaining task entries", async () => {
  class RecoverableAdapter extends InstrumentedFakeAdapter {
    readonly receipts = new Map<string, NativeSessionBinding>();

    override async resetContext(context: AdapterContext): Promise<NativeSessionBinding> {
      if (context.operationId === undefined) throw new Error("Missing maintenance operation ID.");
      const existing = this.receipts.get(context.operationId);
      if (existing !== undefined) return existing;
      const binding = await super.resetContext(context);
      this.receipts.set(context.operationId, binding);
      return binding;
    }

    async recoverResetContext(context: AdapterContext): Promise<NativeSessionBinding | undefined> {
      return context.operationId === undefined ? undefined : this.receipts.get(context.operationId);
    }

    async discardResetContext(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
      if (context.operationId !== undefined) this.receipts.delete(context.operationId);
    }

    async finalizeResetContext(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
      if (context.operationId !== undefined) this.receipts.delete(context.operationId);
    }
  }
  const start = (rootDirectory?: string) => OrchestratorE2eFixture.start({
    createAdapter: (profile) => new RecoverableAdapter(profile),
    ...(rootDirectory === undefined ? {} : { rootDirectory })
  });
  let fixture = await start();
  try {
    const paired = await fixture.pair();
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId() })));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, generation, "old task history"));
    await waitFor(async () => fixture.application.store.listEvents({ sessionId }),
      (events) => events.some((event) => event.payload.type === "message_complete"), "task message");
    const source = fixture.application.store.getSession(sessionId);
    fixture.application.store.updateSession(sessionId, { archived: true }, source.revision, Date.now() - 8 * 24 * 60 * 60_000);
    const activeSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: PI_LIKE_PROFILE.id, targetId: fixture.targetId() })));
    const activeGeneration = BigInt(fixture.application.store.getSession(activeSessionId).descriptor.binding.generation);
    await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(activeSessionId, activeGeneration, "old active context"));
    await waitFor(async () => fixture.application.store.listQueueItems({ sessionId: activeSessionId }),
      (items) => items.some((item) => item.state === "completed"), "active task completion");
    const activeSource = fixture.application.store.getSession(activeSessionId);
    fixture.application.store.updateSession(activeSessionId, {}, activeSource.revision,
      Date.now() - 8 * 24 * 60 * 60_000);
    const sourceBinding = fixture.application.store.getSession(activeSessionId).descriptor.binding;

    const scan = (await paired.clients.historyMaintenance.scanTaskHistory({
      retention: TaskHistoryRetention.SEVEN_DAYS, includeActiveTasks: true
    })).scan!;
    expect(scan.archivedTaskCount).toBe(1n);
    expect(scan.activeTaskCount).toBe(1n);
    expect(scan.messageCount).toBeGreaterThan(1n);
    const begun = (await paired.clients.historyMaintenance.beginTaskHistoryCleanup({
      scanId: scan.scanId, backupEnabled: true
    })).progress!;
    expect(begun.maintenanceId).toBe(scan.scanId);
    const terminal = await waitFor(async () => (await paired.clients.historyMaintenance.getTaskHistoryCleanup({
      maintenanceId: scan.scanId
    })).progress!, (progress) => progress.status !== TaskHistoryMaintenanceStatus.RUNNING, "task history cleanup");
    expect(terminal.status).toBe(TaskHistoryMaintenanceStatus.COMPLETED);
    expect(terminal.result).toMatchObject({ archivedTaskCount: 1n, activeTaskCount: 1n, backupCreated: true });
    expect(fixture.application.store.getSession(sessionId).descriptor.archived).toBe(true);
    expect(fixture.application.store.getSession(activeSessionId).descriptor.binding).not.toEqual(sourceBinding);
    expect(fixture.application.store.listEvents({ sessionId }).filter((event) => event.payload.type === "history_pruned"))
      .toHaveLength(1);
    expect(fixture.application.store.listEvents({ sessionId: activeSessionId }).filter((event) =>
      event.payload.type === "history_pruned" && event.payload.activeContextReset)).toHaveLength(1);

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await start(root);
    const client = fixture.clients(paired.authKey).historyMaintenance;
    expect((await client.getTaskHistoryCleanup({ maintenanceId: scan.scanId })).progress)
      .toMatchObject({ status: TaskHistoryMaintenanceStatus.COMPLETED });
    expect(fixture.application.store.getSession(sessionId).descriptor.archived).toBe(true);
    expect(fixture.application.store.getSession(activeSessionId).descriptor.binding).not.toEqual(sourceBinding);
    expect(fixture.application.store.listEvents({ sessionId }).filter((event) => event.payload.type === "history_pruned"))
      .toHaveLength(1);
    expect(fixture.application.store.listEvents({ sessionId: activeSessionId }).filter((event) =>
      event.payload.type === "history_pruned" && event.payload.activeContextReset)).toHaveLength(1);
  } finally {
    await fixture.close({ removeRoot: true });
  }
});
