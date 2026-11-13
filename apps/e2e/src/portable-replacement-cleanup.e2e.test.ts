import { createHash, randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  PermissionMode, PORTABLE_SESSION_LIMIT_BYTES_HEADER, PORTABLE_SESSION_MEDIA_BYTES_HEADER,
  PortableReplacementInspection, PortableReplacementNativeState, PortableSessionFidelity, PortableSessionService
} from "@joko/contracts";
import type { AdapterContext, ImportPortableNativeSessionInput, NativeSessionBinding, PortableNativeSession } from "@joko/core";
import { JOKO_DESKTOP_APP_ORIGIN } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it, vi } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

it("returns export size metadata through Connect and allows the same task to be exported without media", async () => {
  class PortableAdapter extends InstrumentedFakeAdapter {
    async exportPortableNativeSession(): Promise<PortableNativeSession> {
      const bytes = Buffer.from('{"type":"session","id":"portable-media-source"}\n');
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId: "portable-media-source" };
    }
  }
  const fixture = await OrchestratorE2eFixture.start({
    profiles: [{ ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "session.portable_transfer", supported: true }] }],
    createAdapter: (profile) => new PortableAdapter(profile)
  });
  try {
    const paired = await fixture.pair();
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    const { artifacts, store } = fixture.application;
    const generation = store.getSession(sessionId).descriptor.binding.generation;
    const limit = 64 * 1_024;
    const exportLimit = vi.spyOn(artifacts, "maximumBlobBytes", "get").mockReturnValue(limit);
    const media = await artifacts.ingestBytes(Buffer.alloc(54 * 1_024, 7), { fileName: "notes.bin", mimeType: "application/octet-stream" });
    store.appendEvent({ backendId, targetId, sessionId, generation, traceId: "portable-media",
      payload: { type: "message_complete", role: "assistant", blocks: [{
        kind: "artifact", blob: store.getArtifact(media.id).blob, label: "Notes"
      }] } });

    const rejected = await paired.clients.portableSession.exportPortableSession({ sessionId }).catch(error => error as unknown);
    expect(rejected).toBeInstanceOf(ConnectError);
    if (!(rejected instanceof ConnectError)) throw new Error("Expected the oversized export to fail.");
    expect(rejected.code).toBe(Code.ResourceExhausted);
    expect(rejected.metadata.get(PORTABLE_SESSION_MEDIA_BYTES_HEADER)).toBe(String(media.byteLength));
    expect(rejected.metadata.get(PORTABLE_SESSION_LIMIT_BYTES_HEADER)).toBe(String(limit));

    const response = await fetch(`${fixture.baseUrl}/${PortableSessionService.typeName}/ExportPortableSession`, {
      method: "POST",
      headers: { origin: JOKO_DESKTOP_APP_ORIGIN, authorization: `Bearer ${paired.authKey}`,
        "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({ sessionId })
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("access-control-allow-origin")).toBe(JOKO_DESKTOP_APP_ORIGIN);
    const exposed = response.headers.get("access-control-expose-headers")?.toLowerCase().split(/,\s*/u);
    expect(exposed).toEqual(expect.arrayContaining([PORTABLE_SESSION_MEDIA_BYTES_HEADER, PORTABLE_SESSION_LIMIT_BYTES_HEADER]));
    expect(response.headers.get(PORTABLE_SESSION_MEDIA_BYTES_HEADER)).toBe(String(media.byteLength));
    await response.arrayBuffer();

    await expect(paired.clients.portableSession.exportPortableSession({ sessionId, excludeMedia: true })).resolves.toMatchObject({
      artifact: { mediaType: "application/vnd.joko.session" }, fidelity: PortableSessionFidelity.PARTIAL, mediaCount: 0n, missingMediaCount: 1n
    });

    const textSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    store.appendEvent({ backendId, targetId, sessionId: textSessionId, generation: store.getSession(textSessionId).descriptor.binding.generation,
      traceId: "portable-text-only", payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "x".repeat(limit + 1) }] } });
    const textError = await paired.clients.portableSession.exportPortableSession({ sessionId: textSessionId }).catch(error => error as unknown);
    if (!(textError instanceof ConnectError)) throw new Error("Expected the oversized text export to fail.");
    expect(textError.code).toBe(Code.ResourceExhausted);
    expect(textError.metadata.get(PORTABLE_SESSION_MEDIA_BYTES_HEADER)).toBe("0");
    exportLimit.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await fixture.close({ removeRoot: true });
  }
});

it("keeps an unknown portable replacement visible across HTTP/SQLite restart and retries only after exact confirmation", async () => {
  const native = new Set<string>();
  const deletes: string[] = [];
  let deleteOutcome: "fail_preserve" | "fail_remove" | "success" = "success";
  class PortableAdapter extends InstrumentedFakeAdapter {
    async exportPortableNativeSession(): Promise<PortableNativeSession> {
      const bytes = Buffer.from('{"type":"session","id":"portable-source"}\n');
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nativeSessionId: "portable-source" };
    }

    async importPortableNativeSession(input: ImportPortableNativeSessionInput, signal: AbortSignal): Promise<NativeSessionBinding> {
      signal.throwIfAborted();
      const opaqueRef = `fake://${this.id}/portable/${randomUUID()}`;
      native.add(opaqueRef);
      return { opaqueRef, nativeSessionId: randomUUID(), generation: input.generation };
    }

    async inspectNativeSessionDeletion(binding: NativeSessionBinding, context: AdapterContext): Promise<"present" | "absent" | "unknown"> {
      if (context.binding?.opaqueRef !== binding.opaqueRef || context.binding.generation !== binding.generation
        || context.target.backendId !== this.id) return "unknown";
      return native.has(binding.opaqueRef) ? "present" : "absent";
    }

    override async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
      deletes.push(binding.opaqueRef);
      if (deleteOutcome !== "fail_preserve") native.delete(binding.opaqueRef);
      if (deleteOutcome !== "success") throw new Error("The native deletion reply was lost.");
      await super.deleteSession(binding, context);
    }
  }

  const options = {
    profiles: [{ ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "session.portable_transfer", supported: true }] }],
    createAdapter: (profile: typeof PI_LIKE_PROFILE) => new PortableAdapter(profile)
  };
  let fixture = await OrchestratorE2eFixture.start(options);
  try {
    const paired = await fixture.pair();
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sourceId = sessionIdFrom(await submit(
      paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })
    ));
    const exported = await paired.clients.portableSession.exportPortableSession({ sessionId: sourceId });
    const importNext = async (operationId: string, overwrite: boolean) => {
      const draft = (await paired.clients.portableSession.inspectPortableSessionImport({ package: exported.artifact })).draft!;
      return (await paired.clients.portableSession.commitPortableSessionImport({
        operationId, draftId: draft.draftId, targetId, permissionMode: PermissionMode.ASK, overwrite
      })).result!.sessionId;
    };
    const firstId = await importNext(randomUUID(), false);
    deleteOutcome = "fail_preserve";
    const secondOperationId = randomUUID();
    const secondId = await importNext(secondOperationId, true);
    expect(fixture.application.store.getOperation(secondOperationId).status).toBe("completed");
    expect(fixture.application.store.getSession(secondId).descriptor.deletedAt).toBeUndefined();
    expect((await paired.clients.portableSession.getPortableReplacementCleanup({ importedSessionId: secondId })).cleanup?.nativeState)
      .toBe(PortableReplacementNativeState.UNKNOWN);
    await expect(fixture.anonymous.portableSession.getPortableReplacementCleanup({ importedSessionId: secondId }))
      .rejects.toThrow();
    expect(deletes).toHaveLength(1);

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ ...options, rootDirectory: root });
    let client = fixture.clients(paired.authKey).portableSession;
    const status = (await client.getPortableReplacementCleanup({ importedSessionId: secondId })).cleanup!;
    expect(status.nativeState).toBe(PortableReplacementNativeState.UNKNOWN);
    expect(JSON.stringify(status, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("fake://");
    expect((await client.reconcilePortableReplacementCleanup({ importedSessionId: secondId })).inspection)
      .toBe(PortableReplacementInspection.PRESENT);
    expect(deletes).toHaveLength(1);
    await expect(client.retryPortableReplacementCleanup({
      importedSessionId: secondId, expectedRevision: status.revision, confirmNativeDelete: false
    })).rejects.toThrow();
    deleteOutcome = "success";
    expect((await client.retryPortableReplacementCleanup({
      importedSessionId: secondId, expectedRevision: status.revision, confirmNativeDelete: true
    })).cleanup?.nativeState).toBe(PortableReplacementNativeState.COMPLETED);
    expect(deletes).toHaveLength(2);
    await expect(client.retryPortableReplacementCleanup({
      importedSessionId: secondId, expectedRevision: status.revision, confirmNativeDelete: true
    })).rejects.toThrow();
    expect(deletes).toHaveLength(2);

    const nextDraft = (await client.inspectPortableSessionImport({ package: exported.artifact })).draft!;
    deleteOutcome = "fail_remove";
    const thirdOperationId = randomUUID();
    const thirdId = (await client.commitPortableSessionImport({
      operationId: thirdOperationId, draftId: nextDraft.draftId, targetId,
      permissionMode: PermissionMode.ASK, overwrite: true
    })).result!.sessionId;
    expect((await client.getPortableReplacementCleanup({ importedSessionId: thirdId })).cleanup?.nativeState)
      .toBe(PortableReplacementNativeState.UNKNOWN);
    expect(deletes).toHaveLength(3);
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ ...options, rootDirectory: root });
    client = fixture.clients(paired.authKey).portableSession;
    expect((await client.reconcilePortableReplacementCleanup({ importedSessionId: thirdId }))).toMatchObject({
      inspection: PortableReplacementInspection.ABSENT,
      cleanup: { nativeState: PortableReplacementNativeState.COMPLETED }
    });
    expect(deletes).toHaveLength(3);
    expect(fixture.application.store.getOperation(thirdOperationId).status).toBe("completed");
  } finally {
    await fixture.close({ removeRoot: true });
  }
});
