import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobDisposition, PermissionMode, type BlobRef } from "@joko/contracts";
import type { ImportPortableNativeSessionInput, NativeSessionBinding, PortableNativeSession } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it, vi } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

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
