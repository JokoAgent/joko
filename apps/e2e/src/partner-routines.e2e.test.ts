import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { PartnerDraftSchema, PermissionMode, RoutineRunStatus, SnapshotScopeSchema } from "@joko/contracts";
import { afterEach, expect, it } from "vitest";
import { RealPiSystemFixture, REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID } from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";

let fixture: RealPiSystemFixture | undefined;
afterEach(async () => { await fixture?.close({ removeRoot: true }); fixture = undefined; });
it("runs a durable Partner timer without a UI, hides its backing automation and reopens the same definitions and history through authenticated HTTP", async () => {
  fixture = await RealPiSystemFixture.start({ keepRoot: true });
  const root = fixture.rootDirectory; const port = Number(new URL(fixture.baseUrl).port);
  const paired = await fixture.pair("Routine manager"); const clients = paired.clients;
  const directory = await clients.partner.getPartnerDirectory({});
  const created = await clients.partner.createPartner({ requestId: "routine-product-partner", expectedDirectoryRevision: directory.directory!.revision,
    draft: create(PartnerDraftSchema, { displayName: "Routine reviewer", avatar: { value: { case: "presetId", value: "orbit" } },
      identitySource: "You review changes in this home.", templateId: "general", usesDirectoryDefaults: false,
      capabilities: { modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }], permissionMode: PermissionMode.AUTO, planMode: false } }) });
  const partner = created.partner!;
  const save = { partnerId: partner.partnerId, expectedPartnerRevision: partner.revision, intent: { case: "creationRequestId" as const, value: "routine-product-creation" },
    definition: { name: "Scheduled review", prompt: "ROUTINE_PRODUCT_CHAIN: report the current home status.", enabled: true, silentWhenIdle: true,
      triggers: [{ id: "once", kind: { case: "once" as const, value: { at: timestampFromDate(new Date(Date.now() + 4000)) } } }] } };
  const routine = (await clients.partnerRoutine.savePartnerRoutine(save)).routine!;
  const result = await waitFor(() => clients.partnerRoutine.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: routine.id }),
    value => value.runs[0]?.status === RoutineRunStatus.SUCCESS || value.runs[0]?.status === RoutineRunStatus.FAILED, "the service-owned timer", 45000);
  expect(result.runs[0]?.status).toBe(RoutineRunStatus.SUCCESS);
  const backingId = `partner-routine-${routine.id}`;
  const sessionId = result.runs[0]!.sessionId!;
  expect(sessionId).toBeTruthy(); expect(sessionId).not.toBe(partner.canonicalSessionId);
  expect(fixture.application.store.getSchedule(backingId).sessionId).toBe(sessionId);
  expect(fixture.application.store.listQueueItems({ sessionId }).some(item => item.body.text.includes(save.definition.prompt))).toBe(true);
  expect(fixture.application.store.listQueueItems({ sessionId: partner.canonicalSessionId })).toEqual([]);
  expect((await clients.scheduler.listSchedules({})).schedules.some(schedule => schedule.scheduleId === backingId)).toBe(false);
  await expect(clients.scheduler.getSchedule({ scheduleId: backingId })).rejects.toMatchObject({ code: Code.NotFound });
  const snapshot = await clients.event.getSnapshot({ scope: create(SnapshotScopeSchema, { kind: { case: "owner", value: {} } }) });
  expect(snapshot.snapshot?.schedules.some(schedule => schedule.scheduleId === backingId)).toBe(false);
  await expect(fixture.anonymous.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId })).rejects.toMatchObject({ code: Code.Unauthenticated });
  expect(await readFile(join(root, "data", "partner-routines", "routines.json"), "utf8")).not.toContain(paired.authKey);
  const disabled = (await clients.partnerRoutine.savePartnerRoutine({ ...save, intent: { case: "routineId", value: routine.id }, expectedRevision: routine.revision, definition: { ...save.definition, enabled: false } })).routine!;
  const requestId = "routine-product-retired";
  expect((await clients.partnerRoutine.retirePartnerRoutineCreation({ partnerId: partner.partnerId, requestId })).retired).toBe(true);
  await expect(clients.partnerRoutine.savePartnerRoutine({ ...save, intent: { case: "creationRequestId", value: requestId } })).rejects.toMatchObject({ code: Code.FailedPrecondition });
  const beforeRestart = await clients.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  expect(beforeRestart.routines.filter(value => !value.builtin)).toEqual([disabled]);
  const builtin = beforeRestart.routines.filter(value => value.builtin === "follow-up"); expect(builtin).toHaveLength(1); expect(builtin[0]!.builtinVersion).toBe(1);
  await fixture.close(); fixture = await RealPiSystemFixture.start({ rootDirectory: root, keepRoot: true, port });
  const reopened = fixture.clients(paired.authKey).partnerRoutine;
  const catalog = await reopened.listPartnerRoutines({ partnerId: partner.partnerId }); const persisted = catalog.routines.find(value => value.id === routine.id)!;
  expect(catalog.routines).toEqual(beforeRestart.routines); expect(persisted).toEqual(disabled); expect(persisted.definition?.enabled).toBe(false);
  expect((await reopened.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: routine.id })).runs[0]?.id).toBe(result.runs[0]?.id);
  await reopened.deletePartnerRoutine({ partnerId: partner.partnerId, expectedPartnerRevision: catalog.partnerRevision, routineId: persisted.id, expectedRevision: persisted.revision });
  expect(fixture.application.store.findSchedule(backingId)).toBeUndefined();
  expect((await reopened.listPartnerRoutines({ partnerId: partner.partnerId })).routines).toEqual(builtin);
  expect((await reopened.getPartnerRoutineCreation({ partnerId: partner.partnerId, requestId: save.intent.value })).retired).toBe(true);
}, 120000);
