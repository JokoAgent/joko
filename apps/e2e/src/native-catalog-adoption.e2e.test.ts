import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import {
  AttachNativeSessionSchema,
  CreateSessionMutationSchema,
  NativeCatalogAdoptionInspection,
  NativeCatalogAdoptionState,
  NativeCatalogImportPresentationSchema,
  NativeSessionPlacement,
  NativeSessionStartSchema,
  OperationMutationSchema,
  PermissionMode
} from "@joko/contracts";
import type { NativeSessionBinding, NativeSessionCatalogEntry, NativeSessionCatalogResult } from "@joko/core";
import { CODEX_LIKE_PROFILE } from "@joko/testkit";
import { expect, it, vi } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";

it("adopts the original request and leaves a later-generation restart pending without repeating native writes", async () => {
  const native = {
    state: "absent" as "present" | "absent" | "unknown",
    writes: 0, binds: 0, workspaceDirectory: "", taskId: "catalog-task",
    materializeOnBind: true, loseReplyOnBind: true
  };
  const profile = {
    ...CODEX_LIKE_PROFILE,
    capabilities: [...CODEX_LIKE_PROFILE.capabilities, { key: "session.catalog", supported: true }]
  };
  class CatalogAdapter extends InstrumentedFakeAdapter {
    async scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> {
      return {
        entries: [{
          nativeReference: `fake://source/${native.taskId}`,
          nativeSessionId: native.taskId, title: "Catalog task",
          workingDirectory: native.workspaceDirectory,
          createdAt: 23_000, modifiedAt: 123_000,
          archived: false, placement: "dialogue", existingMatch: "binding_and_placement"
        }],
        rejectedCount: 0
      };
    }

    async bindCatalogSession(
      entry: NativeSessionCatalogEntry,
      generation: number,
      claimMaterialization: (claim: {
        readonly binding: NativeSessionBinding;
        readonly recoveryReference: string;
      }) => Promise<void>
    ): Promise<NativeSessionBinding> {
      native.binds += 1;
      const binding = {
        opaqueRef: `fake://active/${entry.nativeSessionId}`,
        nativeSessionId: entry.nativeSessionId,
        generation
      };
      await claimMaterialization({
        binding,
        recoveryReference: JSON.stringify({ source: entry.nativeReference, active: binding.opaqueRef })
      });
      if (native.materializeOnBind) {
        native.writes += 1;
        native.state = "present";
      }
      if (!native.loseReplyOnBind) return binding;
      throw new Error("Native placement was committed, but the response was lost.");
    }

    async inspectCatalogSessionMaterialization(binding: NativeSessionBinding): Promise<"present" | "absent" | "unknown"> {
      return binding.opaqueRef === `fake://active/${binding.nativeSessionId}` ? native.state : "unknown";
    }
  }

  const options = { profiles: [profile], createAdapter: () => new CatalogAdapter(profile) };
  let fixture = await OrchestratorE2eFixture.start(options);
  try {
    const paired = await fixture.pair();
    const [backendId] = [...fixture.targets][0]!;
    const targetId = "target-catalog-external";
    native.workspaceDirectory = join(fixture.rootDirectory, "catalog-workspace");
    await mkdir(native.workspaceDirectory);
    await fixture.application.sessionHost.registerTarget({
      id: targetId, backendId, displayName: "Catalog workspace",
      workspaceRoot: native.workspaceDirectory, managed: false, trusted: true
    });
    const importCatalog = async (operationId: string) => {
      const catalog = await fixture.clients(paired.authKey).session.scanNativeSessionCatalog({ backendId, force: true });
      const entry = catalog.entries[0]!;
      expect(entry).toBeDefined();
      const mutation = create(OperationMutationSchema, { payload: {
        case: "createSession",
        value: create(CreateSessionMutationSchema, {
          backendId, targetId, displayName: "Catalog task", permissionMode: PermissionMode.ASK,
          initialPlacement: NativeSessionPlacement.DIALOGUE,
          nativeStart: create(NativeSessionStartSchema, { kind: {
            case: "attach", value: create(AttachNativeSessionSchema, { opaqueNativeReference: entry.nativeReference })
          } }),
          catalogImport: create(NativeCatalogImportPresentationSchema, {
            archived: false, snapshotToken: catalog.snapshotToken,
            createdAt: create(TimestampSchema, { seconds: 23n }),
            modifiedAt: create(TimestampSchema, { seconds: 123n })
          })
        })
      } });
      return fixture.clients(paired.authKey).operation.submitOperation({
        operationId, connectionId: paired.connectionId, mutation
      });
    };
    const originalOperationId = randomUUID();
    await importCatalog(originalOperationId);
    await vi.waitFor(() => expect(native.writes).toBe(1));
    expect(fixture.application.store.getOperation(originalOperationId).status).toBe("started");
    const receipt = fixture.application.store.findNativeCatalogAdoptionForRequest(originalOperationId)!;
    expect(fixture.application.store.listSessions({ includeDeleted: true })
      .some((session) => session.descriptor.id === receipt.sessionId)).toBe(false);
    await expect(fixture.anonymous.session.listNativeCatalogAdoptions({})).rejects.toThrow();
    const firstClient = fixture.clients(paired.authKey);
    const adopted = await firstClient.session.reconcileNativeCatalogAdoption({ operationId: originalOperationId });
    expect(adopted).toMatchObject({
      inspection: NativeCatalogAdoptionInspection.PRESENT,
      adoption: { operationId: originalOperationId, state: NativeCatalogAdoptionState.ADOPTED,
        sessionId: receipt.sessionId }
    });
    expect(fixture.application.store.getOperation(originalOperationId).status).toBe("completed");
    expect(fixture.application.store.getSession(receipt.sessionId).descriptor.binding).toEqual(receipt.binding);
    expect((await firstClient.session.listNativeCatalogAdoptions({})).adoptions).toEqual([]);

    native.taskId = "catalog-task-not-written";
    native.state = "absent";
    native.materializeOnBind = false;
    const absentOperationId = randomUUID();
    await importCatalog(absentOperationId);
    await vi.waitFor(() => expect(native.binds).toBe(2));
    const absent = await firstClient.session.reconcileNativeCatalogAdoption({ operationId: absentOperationId });
    expect(absent).toMatchObject({
      inspection: NativeCatalogAdoptionInspection.ABSENT,
      adoption: { operationId: absentOperationId, state: NativeCatalogAdoptionState.ABSENT }
    });
    expect(fixture.application.store.getOperation(absentOperationId).status).toBe("failed");
    expect((await firstClient.session.listNativeCatalogAdoptions({})).adoptions).toEqual([]);

    native.taskId = "catalog-task-complete";
    native.materializeOnBind = true;
    native.loseReplyOnBind = false;
    const completeOperationId = randomUUID();
    await importCatalog(completeOperationId);
    await vi.waitFor(() => expect(fixture.application.store.getOperation(completeOperationId).status)
      .toBe("completed"));
    expect(fixture.application.store.findNativeCatalogAdoptionForRequest(completeOperationId)?.state)
      .toBe("adopted");
    expect((await firstClient.session.listNativeCatalogAdoptions({})).adoptions).toEqual([]);

    native.taskId = "catalog-task-after-restart";
    native.state = "absent";
    native.materializeOnBind = true;
    native.loseReplyOnBind = true;
    const pendingOperationId = randomUUID();
    await importCatalog(pendingOperationId);
    await vi.waitFor(() => expect(native.writes).toBe(3));
    const pendingReceipt = fixture.application.store.findNativeCatalogAdoptionForRequest(pendingOperationId)!;
    expect(fixture.application.store.getOperation(pendingOperationId).status).toBe("started");

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ ...options, rootDirectory: root });
    const client = fixture.clients(paired.authKey);
    const pending = await client.session.listNativeCatalogAdoptions({});
    expect(pending.adoptions).toMatchObject([{
      operationId: pendingOperationId, state: NativeCatalogAdoptionState.PENDING
    }]);
    expect(JSON.stringify(pending, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("fake://");
    await importCatalog(randomUUID());
    await vi.waitFor(() => expect(native.binds).toBe(5));
    expect(native.writes).toBe(3);
    const recovered = await client.session.reconcileNativeCatalogAdoption({ operationId: pendingOperationId });
    expect(recovered).toMatchObject({
      inspection: NativeCatalogAdoptionInspection.UNKNOWN,
      adoption: { operationId: pendingOperationId, state: NativeCatalogAdoptionState.PENDING }
    });
    expect(fixture.application.store.getOperation(originalOperationId).status).toBe("completed");
    expect(fixture.application.store.getOperation(pendingOperationId).status).toBe("started");
    expect(fixture.application.store.getOperation(pendingReceipt.operationId).status).toBe("started");
    expect(fixture.application.store.listSessions({ includeDeleted: true })
      .some((session) => session.descriptor.id === pendingReceipt.sessionId)).toBe(false);
    expect((await client.session.listNativeCatalogAdoptions({})).adoptions).toHaveLength(1);
    expect(native.writes).toBe(3);
  } finally {
    await fixture.close({ removeRoot: true });
  }
});
