import { createHash, randomUUID } from "node:crypto";
import { PermissionMode, PortableReplacementInspection, PortableReplacementNativeState } from "@joko/contracts";
import type { AdapterContext, ImportPortableNativeSessionInput, NativeSessionBinding, PortableNativeSession } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

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
