import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { PartnerDraftSchema, PartnerLifecycle, PermissionMode, RoutineRunStatus } from "@joko/contracts";
import { afterEach, expect, it } from "vitest";
import { RealPiSystemFixture, REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID } from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";

let fixture: RealPiSystemFixture | undefined;
afterEach(async () => { await fixture?.close({ removeRoot: true }); fixture = undefined; });
it("reopens a paused Partner through authenticated HTTP, retains its files and manual preferences and resumes the existing native history", async () => {
  fixture = await RealPiSystemFixture.start({ keepRoot: true });
  const root = fixture.rootDirectory; const port = Number(new URL(fixture.baseUrl).port);
  const paired = await fixture.pair("Lifecycle manager"); const clients = paired.clients;
  const directory = await clients.partner.getPartnerDirectory({});
  const partner = (await clients.partner.createPartner({ requestId: "lifecycle-product-partner", expectedDirectoryRevision: directory.directory!.revision,
    draft: create(PartnerDraftSchema, { displayName: "Paused reviewer", avatar: { value: { case: "presetId", value: "orbit" } },
      identitySource: "You review work in this home.", templateId: "general", usesDirectoryDefaults: false,
      capabilities: { modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }], permissionMode: PermissionMode.AUTO, planMode: false } }) })).partner!;
  const home = fixture.application.store.getTarget(partner.homeTargetId).descriptor.workspaceRoot;
  await writeFile(join(home, "retained.txt"), "Retained work.");
  const save = { partnerId: partner.partnerId, expectedPartnerRevision: partner.revision,
    definition: { name: "Review later", prompt: "LIFECYCLE_PRODUCT_CHAIN: review this home.", enabled: true, silentWhenIdle: true,
      triggers: [{ id: "hourly", kind: { case: "interval" as const, value: { intervalMs: 3600000n } } }] } };
  const enabled = (await clients.partnerRoutine.savePartnerRoutine({ ...save, intent: { case: "creationRequestId", value: "lifecycle-enabled-creation" } })).routine!;
  const disabled = (await clients.partnerRoutine.savePartnerRoutine({ ...save, intent: { case: "creationRequestId", value: "lifecycle-disabled-creation" },
    definition: { ...save.definition, enabled: false } })).routine!;
  await clients.partnerRoutine.runPartnerRoutine({ partnerId: partner.partnerId, expectedPartnerRevision: partner.revision, routineId: enabled.id,
    expectedRevision: enabled.revision, requestId: "lifecycle-before-pause-run" });
  const history = await waitFor(() => clients.partnerRoutine.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: enabled.id }),
    value => value.runs[0]?.status === RoutineRunStatus.SUCCESS || value.runs[0]?.status === RoutineRunStatus.FAILED, "the initial review", 45000);
  expect(history.runs[0]?.status).toBe(RoutineRunStatus.SUCCESS);
  const sessionId = partner.canonicalSessionId!; const originalBinding = fixture.application.store.getSession(sessionId).descriptor.binding;
  const historyLength = fixture.application.store.listEvents({ sessionId, limit: 1000 }).length;
  fixture.application.store.setQueuePaused({ sessionId, paused: true, traceId: "lifecycle-user-manual-pause" });
  const paused = (await clients.partner.setPartnerLifecycle({ partnerId: partner.partnerId, expectedRevision: partner.revision, lifecycle: PartnerLifecycle.PAUSED })).partner!;
  expect(paused).toMatchObject({ lifecycle: PartnerLifecycle.PAUSED, pauseCleanupPending: false, canonicalSessionId: sessionId });
  await expect(clients.partnerRoutine.runPartnerRoutine({ partnerId: partner.partnerId, expectedPartnerRevision: paused.revision, routineId: enabled.id,
    expectedRevision: enabled.revision, requestId: "lifecycle-denied-run" })).rejects.toMatchObject({ code: Code.FailedPrecondition });
  await expect(fixture.anonymous.partner.setPartnerLifecycle({ partnerId: partner.partnerId, expectedRevision: paused.revision, lifecycle: PartnerLifecycle.ACTIVE })).rejects.toMatchObject({ code: Code.Unauthenticated });
  await fixture.close(); fixture = await RealPiSystemFixture.start({ rootDirectory: root, keepRoot: true, port });
  const reopened = fixture.clients(paired.authKey);
  const restored = (await reopened.partner.getPartner({ partnerId: partner.partnerId })).partner!;
  expect(restored).toMatchObject({ lifecycle: PartnerLifecycle.PAUSED, pauseCleanupPending: false, canonicalSessionId: sessionId });
  const resumed = (await reopened.partner.setPartnerLifecycle({ partnerId: partner.partnerId, expectedRevision: restored.revision, lifecycle: PartnerLifecycle.ACTIVE })).partner!;
  expect(resumed.lifecycle).toBe(PartnerLifecycle.ACTIVE); expect(resumed.pauseCleanupPending).toBeUndefined();
  expect(fixture.application.store.getQueueControl(sessionId)).toMatchObject({ paused: true, resumeOnUserInput: false });
  const routines = await reopened.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  expect(routines.routines.find(value => value.id === enabled.id)?.definition?.enabled).toBe(true);
  expect(routines.routines.find(value => value.id === disabled.id)?.definition?.enabled).toBe(false);
  expect((await reopened.partnerRoutine.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: enabled.id })).runs[0]?.id).toBe(history.runs[0]?.id);
  expect(fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId).toBe(originalBinding.nativeSessionId);
  expect(fixture.application.store.listEvents({ sessionId, limit: 1000 }).length).toBeGreaterThanOrEqual(historyLength);
  expect(await readFile(join(home, "retained.txt"), "utf8")).toBe("Retained work.");
  expect(await readFile(join(root, "data", "partner-routines", "routines.json"), "utf8")).not.toContain(paired.authKey);
  expect(fixture.providerRequests).toHaveLength(0);
}, 120000);
