import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  BlobDisposition,
  ControlSubagentMutationSchema,
  OperationMutationSchema,
  OperationState,
  PermissionMode,
  PortableSessionFidelity,
  StateImpact,
  SubagentControlAction,
  SubagentRunState,
  SubagentService,
  capabilityNames,
  type BlobRef
} from "@joko/contracts";
import type { ImportPortableNativeSessionInput, NativeSessionBinding, PortableNativeSession } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it, vi } from "vitest";
import { createE2eClients, type PairedClient } from "./connect-clients.js";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const verifiedCodex = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];

for (const backendId of ["claude-code", "codex"] as const) {
  it.skipIf(process.platform !== "linux" || backendId === "codex" && !verifiedCodex)(
    `restores an encrypted ${backendId} package in another service node and continues after restart`, { timeout: 120_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "joko-portable-native-product-"));
      let source: RealPiSystemFixture | undefined;
      let receiver: RealPiSystemFixture | undefined;
      let phase = "starting the source node";
      const claude = backendId === "claude-code";
      const modelId = claude ? "claude-sonnet-4-6" : REAL_PI_MODEL_ID;
      const targetId = `workspace-real-pi:${backendId}`;
      const password = "owned portable test password";
      const question = "Remember the test inventory: Cobalt, Copper, Tin.";
      const originalReply = "Retained the test inventory.";
      const newQuestion = "Continue the inventory from the imported native thread.";
      const start = async (name: "source" | "receiver", reply: string) => {
        const rootDirectory = join(root, name);
        await Promise.all([join(rootDirectory, "claude-config"), join(rootDirectory, "codex-home")].map(directory => mkdir(directory, { recursive: true })));
        vi.stubEnv("CLAUDE_CONFIG_DIR", join(rootDirectory, "claude-config"));
        vi.stubEnv("CODEX_HOME", join(rootDirectory, "codex-home"));
        const fixture = await RealPiSystemFixture.start({ rootDirectory,
          ...(claude ? { providerApi: "anthropic-messages" as const } : { codexExecutable: verifiedCodex! }),
          providerResponder: () => ({ kind: "text", text: reply })
        });
        if (name === "source") source = fixture;
        else receiver = fixture;
        const { providers, store, refreshBackendDescriptor } = fixture.application;
        const local = providers!.resolveInferenceRoute("pi", REAL_PI_PROVIDER_ID, REAL_PI_MODEL_ID)!;
        expect(local.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?$/u);
        await providers!.upsert({
          backendId, credentialOrigin: "", provider: { id: REAL_PI_PROVIDER_ID,
            baseUrl: local.baseUrl, api: claude ? "anthropic-messages" : "openai-completions",
            keyless: true, models: [{ id: modelId, name: "Local package fixture model", contextWindow: 64_000, maxTokens: 4_096 }] },
          displayName: "Local package fixture Provider", kind: "local_keyless", credentialBindings: {},
          enabled: true, supportsLogin: false, supportsLogout: false, supportsRefresh: false
        });
        await refreshBackendDescriptor(backendId);
        const target = store.getTarget(targetId);
        store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
        return fixture;
      };
      const send = async (fixture: RealPiSystemFixture, owner: PairedClient, sessionId: string, text: string) => {
        const store = fixture.application.store;
        const generation = BigInt(store.getSession(sessionId).descriptor.binding.generation);
        const operation = await submit(owner.clients.operation, owner.connectionId, sendInputMutation(sessionId, generation, text));
        expect(operation.state, operation.error?.code).toBe(OperationState.SUCCEEDED);
        const runId = queueRunIdFrom(operation);
        const run = await waitFor(async () => store.getRun(runId).descriptor,
          value => ["completed", "failed", "aborted", "dispatch_unknown"].includes(value.state), "the package fixture turn", 30_000);
        expect(run.state, run.error?.code).toBe("completed");
      };
      try {
        const original = await start("source", originalReply);
        const originalOwner = await original.pair("Package source owner");
        const created = await submit(originalOwner.clients.operation, originalOwner.connectionId, createSessionMutation({
          backendId, targetId, providerId: REAL_PI_PROVIDER_ID, modelId, effortId: "", permissionMode: PermissionMode.ASK
        }));
        expect(created.state, created.error?.code).toBe(OperationState.SUCCEEDED);
        const sourceId = sessionIdFrom(created);
        phase = "recording original native history";
        await send(original, originalOwner, sourceId, question);
        const sourceBinding = original.application.store.getSession(sourceId).descriptor.binding;
        expect(sourceBinding.nativeSessionId).toBeTruthy();
        phase = "exporting and downloading the encrypted product package";
        const exported = await originalOwner.clients.portableSession.exportPortableSession({ sessionId: sourceId, password });
        expect(exported).toMatchObject({ fidelity: PortableSessionFidelity.FULL, messageCount: 2n });
        const sourceTicket = (await originalOwner.clients.artifact.getBlobDownloadTicket({ blobId: exported.artifact!.blobId })).ticket!;
        const downloaded = await fetch(`${original.baseUrl}${sourceTicket.relativeEndpoint}`, { headers: { authorization: `Bearer ${originalOwner.authKey}` } });
        expect(downloaded.status).toBe(200);
        const bytes = await downloaded.arrayBuffer();
        expect(Buffer.from(bytes).includes(Buffer.from(question))).toBe(false);
        await original.close({ removeRoot: false });
        await rename(join(root, "source"), join(root, "retired-source"));

        phase = "unlocking the package on a distinct node";
        const destination = await start("receiver", "Imported inventory continued.");
        const owner = await destination.pair("Package receiving owner");
        const upload = (await owner.clients.artifact.beginBlobUpload({
          fileName: "native-task.jshare", mediaType: "application/vnd.joko.session", disposition: BlobDisposition.PORTABLE_IMPORT,
          byteSize: BigInt(bytes.byteLength), sha256Hex: createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
        })).upload!;
        const put = await fetch(`${destination.baseUrl}${upload.ticket!.relativeEndpoint}`, { method: "PUT", body: bytes,
          headers: { authorization: `Bearer ${owner.authKey}`, "content-type": "application/octet-stream" } });
        expect(put.status).toBe(201);
        const blob = (await owner.clients.artifact.completeBlobUpload({ uploadId: upload.uploadId })).blob!;
        const portable = owner.clients.portableSession;
        const draft = (await portable.inspectPortableSessionImport({ package: blob })).draft!;
        expect(draft).toMatchObject({ encrypted: true, passwordRequired: true });
        const { preview } = (await portable.unlockPortableSessionImport({ draftId: draft.draftId, password })).draft!;
        expect(preview).toMatchObject({ fidelity: PortableSessionFidelity.FULL, nativeHistory: true, messageCount: 2n });
        const commit = { operationId: randomUUID(), draftId: draft.draftId, targetId, permissionMode: PermissionMode.ASK,
          model: { model: { providerId: REAL_PI_PROVIDER_ID, modelId } } };
        phase = "committing the exact new workspace and receipt";
        await expect(portable.commitPortableSessionImport({ ...commit, operationId: randomUUID(), targetId: "workspace-real-pi" }))
          .rejects.toMatchObject({ code: Code.FailedPrecondition });
        const { result } = await portable.commitPortableSessionImport(commit);
        expect(result).toMatchObject({ fidelity: PortableSessionFidelity.FULL, messageCount: 2n, replacedSessionIds: [] });
        expect(result?.activationError).toBeUndefined();
        const sessionId = result!.sessionId;
        expect(sessionId).not.toEqual(sourceId);
        const binding = destination.application.store.getSession(sessionId).descriptor.binding;
        expect(binding.nativeSessionId).toBeTruthy();
        expect(binding.nativeSessionId).not.toEqual(sourceBinding.nativeSessionId);
        await expect(portable.commitPortableSessionImport(commit)).resolves.toMatchObject({ replayed: true, result: { sessionId } });
        expect(destination.providerRequests).toHaveLength(0);
        await destination.close({ removeRoot: false });

        phase = "continuing the imported task on the cold receiving node";
        const reopened = await start("receiver", "Imported inventory continued.");
        expect(reopened.application.store.getSession(sessionId).descriptor.binding).toEqual(binding);
        await send(reopened, { ...owner, clients: createE2eClients(reopened.baseUrl, owner.authKey, 60_000) }, sessionId, newQuestion);
        const requests = JSON.stringify(reopened.providerRequests.map(request => request.body));
        expect(requests).toContain(question);
        expect(requests).toContain(originalReply);
        expect(requests).toContain(newQuestion);
      } catch (error) {
        throw new Error(`${backendId} product transfer failed while ${phase}.`, { cause: error });
      } finally {
        await Promise.all([source?.close({ removeRoot: false }), receiver?.close({ removeRoot: false })]);
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  );
}

it("restores portable worker results and activity on a separate node without granting native controls", async () => {
  let nativeControls = 0;
  class PortableAdapter extends InstrumentedFakeAdapter {
    async exportPortableNativeSession(): Promise<PortableNativeSession> {
      const bytes = Buffer.from('{"type":"session","id":"portable-worker-session"}\n');
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId: "portable-worker-session" };
    }

    async importPortableNativeSession(input: ImportPortableNativeSessionInput, signal: AbortSignal): Promise<NativeSessionBinding> {
      signal.throwIfAborted();
      return { opaqueRef: `fake://${this.id}/portable/${randomUUID()}`, nativeSessionId: randomUUID(), generation: input.generation };
    }

    async controlSubagent(): Promise<void> {
      nativeControls += 1;
    }
  }
  const options = (id: string) => ({
    profiles: [{ ...PI_LIKE_PROFILE, id, capabilities: [...PI_LIKE_PROFILE.capabilities,
      ...["session.portable_transfer", capabilityNames.subagentsList, capabilityNames.subagentsDetail,
        capabilityNames.subagentsTranscript, capabilityNames.subagentsStop].map(key => ({ key, supported: true }))
    ] }],
    createAdapter: (profile: typeof PI_LIKE_PROFILE) => new PortableAdapter(profile)
  });
  const source = await OrchestratorE2eFixture.start(options("portable-worker-source"));
  const workerId = "original-worker";
  let bytes: ArrayBuffer;
  let sourceId: string;
  try {
    const paired = await source.pair();
    const backendId = source.adapter().id;
    const targetId = source.targetId();
    sourceId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const { store } = source.application;
    const generation = store.getSession(sourceId).descriptor.binding.generation;
    store.appendEvent({
      backendId, targetId, sessionId: sourceId, generation, traceId: "observed-original-worker",
      payload: { type: "subagent_run", run: {
        id: workerId, sessionId: sourceId, logicalAgentId: "source-identity", parentTaskId: "source-task",
        identityAliases: ["source-alias"], providerRunIds: ["source-native-worker"], title: "Check documentation",
        state: "completed", readOnly: false, startedAt: 1000, updatedAt: 4000, endedAt: 4000,
        capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true, stop: true,
          steer: true, followUp: true, resume: true, parentContext: "live" },
        returnedResult: "Reviewed all three sections.", returnedResultTruncated: true,
        activity: [
          { sequence: 1, kind: "started", state: "running", summary: "Began review.", occurredAt: 1000 },
          { sequence: 3, kind: "completed", state: "completed", summary: "Review complete.", occurredAt: 4000 }
        ],
        children: [
          { id: "source-child", identityAliases: ["source-native-child"], role: "reviewer", state: "completed", result: "Reviewed the appendix." },
          { id: "source-child-nested", parentChildId: "source-child", identityAliases: [], role: "reviewer",
            state: "running", awaitingApproval: true, readOnly: false }
        ]
      } }
    });
    const exported = await paired.clients.portableSession.exportPortableSession({ sessionId: sourceId });
    expect(exported).toMatchObject({ workerCount: 1n, fidelity: PortableSessionFidelity.PARTIAL });
    const download = (await paired.clients.artifact.getBlobDownloadTicket({ blobId: exported.artifact!.blobId })).ticket!;
    const response = await fetch(`${source.baseUrl}${download.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(response.status).toBe(200);
    bytes = await response.arrayBuffer();
  } finally {
    await source.close({ removeRoot: true });
  }

  const receiver = await OrchestratorE2eFixture.start(options("portable-worker-receiver"));
  try {
    const paired = await receiver.pair();
    const targetId = receiver.targetId();
    const pending = (await paired.clients.artifact.beginBlobUpload({
      fileName: "workers.jshare", mediaType: "application/vnd.joko.session", disposition: BlobDisposition.PORTABLE_IMPORT,
      byteSize: BigInt(bytes.byteLength), sha256Hex: createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
    })).upload!;
    const response = await fetch(`${receiver.baseUrl}${pending.ticket!.relativeEndpoint}`, { method: "PUT", body: bytes,
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" } });
    expect(response.status).toBe(201);
    const blob = (await paired.clients.artifact.completeBlobUpload({ uploadId: pending.uploadId })).blob!;
    const draft = (await paired.clients.portableSession.inspectPortableSessionImport({ package: blob })).draft!;
    const commit = { operationId: randomUUID(), draftId: draft.draftId, targetId, permissionMode: PermissionMode.ASK };
    const imported = (await paired.clients.portableSession.commitPortableSessionImport(commit)).result!;
    expect(imported).toMatchObject({ workerCount: 1n, fidelity: PortableSessionFidelity.PARTIAL });
    const sessionId = imported.sessionId;
    expect(sessionId).not.toBe(sourceId);
    const client = createClient(SubagentService,
      createConnectTransport({ baseUrl: receiver.baseUrl, httpVersion: "1.1", useBinaryFormat: true, defaultTimeoutMs: 10_000 }));
    const auth = { headers: { authorization: `Bearer ${paired.authKey}` } };
    const list = await client.listSubagentRuns({ sessionId }, auth);
    expect(list.runs).toHaveLength(1);
    const subagentRunId = list.runs[0]!.subagentRunId;
    expect(subagentRunId).not.toBe(workerId);
    const detail = (await client.getSubagentRun({ sessionId, subagentRunId }, auth)).run!;
    expect(detail).toMatchObject({
      run: { sessionId, state: SubagentRunState.COMPLETED, title: "Check documentation", readOnly: true, providerRunIds: [],
        parentTaskId: "", logicalAgentId: subagentRunId, capabilities: {
          viewActivity: true, viewReturnedResult: true, viewFullTranscript: false, stop: false, steer: false, followUp: false, resume: false
        } },
      returnedResult: "Reviewed all three sections.", returnedResultTruncated: true,
      activity: [{ sequence: 1n, summary: "Began review." }, { sequence: 3n, summary: "Review complete." }],
      children: [
        { result: "Reviewed the appendix.", readOnly: true, identityAliases: [] },
        { state: SubagentRunState.STOPPED, readOnly: true, identityAliases: [] }
      ]
    });
    const [parent, child] = detail.children;
    expect(parent?.childId).not.toBe("source-child");
    expect(child?.childId).not.toBe("source-child-nested");
    expect(child?.parentChildId).toBe(parent?.childId);
    expect(child?.awaitingApproval).toBeUndefined();
    const store = receiver.application.store;
    expect(store.getSessionSubagentRun(sessionId, subagentRunId)?.event).toMatchObject({
      backendId: receiver.adapter().id, targetId, sessionId, operationId: commit.operationId
    });
    await expect(client.listSubagentTranscript({ sessionId, subagentRunId }, auth)).rejects.toMatchObject({ code: Code.Unimplemented });
    const control = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "controlSubagent",
        value: create(ControlSubagentMutationSchema, { sessionId, subagentRunId, action: SubagentControlAction.STOP }) }
    }));
    expect(control, control.error?.message).toMatchObject({ state: OperationState.FAILED,
      error: { code: "SUBAGENT_ACTION_UNAVAILABLE", phase: "subagent_control", retryable: false,
        queueImpact: StateImpact.UNCHANGED, workspaceImpact: StateImpact.UNCHANGED, nativeSessionImpact: StateImpact.UNCHANGED } });
    expect(nativeControls).toBe(0);
    await expect(paired.clients.portableSession.commitPortableSessionImport(commit))
      .resolves.toMatchObject({ replayed: true, result: { sessionId, workerCount: 1n } });
    expect((await client.listSubagentRuns({ sessionId }, auth)).runs).toHaveLength(1);
  } finally {
    await receiver.close({ removeRoot: true });
  }
});

it("expires unused portable input uploads across restart while preserving previews, imported receipts and permanent copies", async () => {
  const realNow = Date.now;
  let clockOffset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  const retention = 10 * 60 * 1_000;
  let nativeImports = 0;
  class PortableAdapter extends InstrumentedFakeAdapter {
    async exportPortableNativeSession(): Promise<PortableNativeSession> {
      const bytes = Buffer.from('{"type":"session","id":"retained-portable-source"}\n');
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId: "retained-portable-source" };
    }

    async importPortableNativeSession(input: ImportPortableNativeSessionInput, signal: AbortSignal): Promise<NativeSessionBinding> {
      signal.throwIfAborted();
      nativeImports += 1;
      return { opaqueRef: `fake://${this.id}/portable/${randomUUID()}`, nativeSessionId: randomUUID(), generation: input.generation };
    }
  }
  const options = {
    profiles: [{ ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "session.portable_transfer", supported: true }] }],
    createAdapter: (profile: typeof PI_LIKE_PROFILE) => new PortableAdapter(profile)
  };
  let fixture = await OrchestratorE2eFixture.start(options).catch(error => { clock.mockRestore(); throw error; });
  try {
    const paired = await fixture.pair();
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sourceId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const source = fixture.application.store.getSession(sourceId).descriptor;
    fixture.application.store.appendEvent({ backendId, targetId, sessionId: sourceId, generation: source.binding.generation,
      traceId: "retained-portable-text", payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Imported history survives input cleanup." }] } });
    const password = "portable input retention phrase";
    const exported = (await paired.clients.portableSession.exportPortableSession({ sessionId: sourceId, password })).artifact!;
    const download = async (blob: BlobRef) => {
      const ticket = (await fixture.clients(paired.authKey).artifact.getBlobDownloadTicket({ blobId: blob.blobId })).ticket!;
      const response = await fetch(`${fixture.baseUrl}${ticket.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
      expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    };
    const bytes = await download(exported);
    const originalPath = join(fixture.rootDirectory, "original.jshare");
    await writeFile(originalPath, bytes);
    const upload = async (content: Uint8Array, disposition: BlobDisposition, authKey = paired.authKey) => {
      const startedAt = Date.now();
      const client = fixture.clients(authKey).artifact;
      const pending = (await client.beginBlobUpload({ fileName: "original.jshare", mediaType: "application/vnd.joko.session",
        byteSize: BigInt(content.byteLength), sha256Hex: createHash("sha256").update(content).digest("hex"), disposition })).upload!;
      const response = await fetch(`${fixture.baseUrl}${pending.ticket!.relativeEndpoint}`, { method: "PUT",
        headers: { authorization: `Bearer ${authKey}`, "content-type": "application/octet-stream" }, body: Uint8Array.from(content).buffer });
      expect(response.status).toBe(201);
      const blob = (await client.completeBlobUpload({ uploadId: pending.uploadId })).blob!;
      if (disposition === BlobDisposition.PORTABLE_IMPORT) {
        expect(blob.expiresAt).toBeDefined();
        const expiresAt = Number(blob.expiresAt!.seconds) * 1_000 + blob.expiresAt!.nanos / 1_000_000;
        expect(expiresAt).toBeGreaterThanOrEqual(startedAt + retention);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + retention);
      } else expect(blob.expiresAt).toBeUndefined();
      return blob;
    };
    const retired = await fixture.pair("Retired import uploader");
    const abandoned = await upload(Buffer.from("uploaded without inspecting"), BlobDisposition.PORTABLE_IMPORT, retired.authKey);
    fixture.application.connections.revoke(retired.connectionId);
    const invalid = await upload(Buffer.from("invalid portable package"), BlobDisposition.PORTABLE_IMPORT);
    await expect(paired.clients.portableSession.inspectPortableSessionImport({ package: invalid })).rejects.toThrow();
    const cancelled = await upload(bytes, BlobDisposition.PORTABLE_IMPORT);
    const cancelledDraft = (await paired.clients.portableSession.inspectPortableSessionImport({ package: cancelled })).draft!;
    expect(cancelledDraft.passwordRequired).toBe(true);
    await paired.clients.portableSession.cancelPortableSessionImport({ draftId: cancelledDraft.draftId });
    await expect(paired.clients.portableSession.unlockPortableSessionImport({ draftId: cancelledDraft.draftId, password })).rejects.toThrow();
    const permanent = await upload(bytes, BlobDisposition.ATTACHMENT);
    const active = await upload(bytes, BlobDisposition.PORTABLE_IMPORT);
    expect(new Set([cancelled.blobId, permanent.blobId, active.blobId]).size).toBe(3);
    const expired = [abandoned, invalid, cancelled, active];
    const expiredPaths = expired.map(blob => fixture.application.store.getArtifact(blob.blobId).storageKey);
    expect(expiredPaths[2]).toBe(fixture.application.store.getArtifact(permanent.blobId).storageKey);

    clockOffset += retention / 2;
    const draft = (await paired.clients.portableSession.inspectPortableSessionImport({ package: active })).draft!;
    expect(draft.passwordRequired).toBe(true);
    clockOffset += retention / 2 + 1_000;
    await fixture.application.artifacts.garbageCollect();
    for (const blob of expired) expect(fixture.application.store.findArtifact(blob.blobId)).toBeUndefined();
    for (const path of expiredPaths.slice(0, 2)) await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(paired.clients.artifact.getBlobDownloadTicket({ blobId: active.blobId })).rejects.toThrow();
    expect(await download(permanent)).toEqual(bytes);
    await expect(paired.clients.portableSession.unlockPortableSessionImport({ draftId: draft.draftId, password: "wrong password" })).rejects.toThrow();
    const unlocked = (await paired.clients.portableSession.unlockPortableSessionImport({ draftId: draft.draftId, password })).draft!;
    expect(unlocked).toMatchObject({ passwordRequired: false, preview: { messageCount: 1n } });
    const commit = { operationId: randomUUID(), draftId: draft.draftId, targetId, permissionMode: PermissionMode.ASK };
    const imported = (await paired.clients.portableSession.commitPortableSessionImport(commit)).result!;
    expect(imported.messageCount).toBe(1n);
    expect(nativeImports).toBe(1);
    const afterRestart = await upload(Buffer.from("uninspected input across restart"), BlobDisposition.PORTABLE_IMPORT);
    const restartPath = fixture.application.store.getArtifact(afterRestart.blobId).storageKey;
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    clockOffset += retention + 1;
    fixture = await OrchestratorE2eFixture.start({ ...options, rootDirectory });
    await fixture.application.artifacts.garbageCollect();
    expect(fixture.application.store.findArtifact(afterRestart.blobId)).toBeUndefined();
    await expect(lstat(restartPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.clients(paired.authKey).portableSession.commitPortableSessionImport(commit)).resolves.toMatchObject({ replayed: true,
      result: { sessionId: imported.sessionId, messageCount: 1n } });
    expect(nativeImports).toBe(1);
    expect(fixture.application.store.listEvents({ sessionId: imported.sessionId }).some(event => event.payload.type === "message_complete"
      && event.payload.blocks.some(block => block.kind === "text" && block.text === "Imported history survives input cleanup."))).toBe(true);
    expect(await download(permanent)).toEqual(bytes);
    expect(new Uint8Array(await readFile(originalPath))).toEqual(bytes);
  } finally {
    try { await fixture.close({ removeRoot: true }); } finally { clock.mockRestore(); }
  }
});
