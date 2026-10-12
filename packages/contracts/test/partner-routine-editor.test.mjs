import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  PartnerRoutineEditor, RoutineCreationReceipts, PartnerRoutineSchema, ListPartnerRoutinesResponseSchema,
  ListPartnerRoutineRunsResponseSchema, PartnerRoutineRunSchema, RoutineRunStatus,
  GetPartnerRoutineCreationResponseSchema, RetirePartnerRoutineCreationResponseSchema, newRoutineDefinition
} from "../dist/index.js";

function fixture() {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  const receipts = new RoutineCreationReceipts(storage, "server-profile-device");
  let catalog = create(ListPartnerRoutinesResponseSchema, { partnerId: "partner", partnerRevision: { value: 1n }, writable: true });
  let counter = 0; const mutations = [];
  const api = { ownerKey: "owner", newRequestId: () => `routine-request-${++counter}`,
    list: async () => catalog,
    save: async (_revision, definition, intent) => {
      mutations.push(intent); const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition });
      catalog = { ...catalog, routines: [routine] }; return routine;
    },
    run: async (_revision, _routine, id) => { mutations.push(id); }, remove: async () => {},
    history: async () => create(ListPartnerRoutineRunsResponseSchema),
    lookup: async () => create(GetPartnerRoutineCreationResponseSchema),
    retire: async () => create(RetirePartnerRoutineCreationResponseSchema, { retired: true }) };
  const editor = new PartnerRoutineEditor(api, receipts, "partner");
  const draft = () => editor.edit({ name: "Review", prompt: "Private instructions" });
  return { data, storage, receipts, api, editor, draft, mutations, catalog: value => { if (value) catalog = value; return catalog; } };
}

test("persists only an opaque creation identity before dispatch and recovers an unknown acknowledgement without another write", async () => {
  const f = fixture(); await f.editor.refresh(); f.draft();
  let created;
  f.api.save = async (_revision, definition, intent) => {
    assert.equal(await f.receipts.read("partner"), intent.requestId);
    assert.ok([...f.data.values()].every(value => !value.includes(definition.prompt)));
    created = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition });
    f.mutations.push(intent); throw new Error("Lost response");
  };
  await f.editor.save(); assert.equal(f.editor.state.error, "failed"); assert.equal(f.editor.dirty, true);
  await f.editor.save(); assert.equal(f.mutations.length, 1);
  f.editor.dispose(); const reopened = new PartnerRoutineEditor(f.api, f.receipts, "partner");
  await reopened.refresh(); assert.equal(reopened.state.error, "pending"); assert.equal(f.mutations.length, 1);
  f.api.lookup = async () => create(GetPartnerRoutineCreationResponseSchema, { routine: created });
  await reopened.recover(); assert.equal(reopened.state.selected.id, "routine"); assert.equal(f.data.size, 0);
  assert.equal(reopened.dirty, false); assert.equal(f.mutations.length, 1); reopened.dispose();
});

test("explicit retirement resolves an absent creation while a failed receipt write prevents any dispatch", async () => {
  const f = fixture(); await f.receipts.claim("partner", "routine-request-retire"); await f.editor.refresh();
  assert.equal(f.editor.state.pendingId, "routine-request-retire"); await f.editor.recover(true);
  assert.equal(f.editor.state.pendingId, undefined); assert.equal(f.data.size, 0);
  f.draft(); f.storage.setItem = () => { throw new Error("Storage unavailable"); };
  await f.editor.save(); assert.equal(f.mutations.length, 0); assert.equal(f.editor.state.requiresRefresh, true); f.editor.dispose();
});

test("reuses a pending manual run receipt after reopening and never dispatches on refresh", async () => {
  const f = fixture(); const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition: newRoutineDefinition() });
  f.catalog({ ...f.catalog(), routines: [routine] }); await f.editor.refresh(); f.editor.select(routine);
  f.api.run = async (_revision, _routine, id) => { f.mutations.push(id); throw new Error("Lost acknowledgement"); };
  await f.editor.run(); const pending = await f.receipts.readRun("partner", "routine"); assert.ok(pending);
  f.editor.dispose(); const reopened = new PartnerRoutineEditor(f.api, f.receipts, "partner");
  await reopened.refresh(); reopened.select(routine); assert.equal(f.mutations.length, 1);
  f.api.run = async (_revision, _routine, id) => { f.mutations.push(id); };
  await reopened.run(); assert.deepEqual(f.mutations, [pending, pending]); assert.equal(f.data.size, 0); reopened.dispose();
});

test("observes status changes and preserves a dirty draft when another editor changes its revision", async () => {
  const f = fixture(); const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition: { ...newRoutineDefinition(), name: "Original" } });
  f.catalog({ ...f.catalog(), routines: [routine] }); await f.editor.refresh(); f.editor.select(routine);
  let status = RoutineRunStatus.RUNNING;
  f.api.history = async () => create(ListPartnerRoutineRunsResponseSchema, { runs: [create(PartnerRoutineRunSchema, { id: "run", routineId: routine.id, definitionRevision: { value: 1n }, status })] });
  await f.editor.observe(); assert.equal(f.editor.state.runs[0].status, status);
  status = RoutineRunStatus.SUCCESS; await f.editor.observe(); assert.equal(f.editor.state.runs[0].status, status);
  f.editor.edit({ name: "My draft" }); f.catalog({ ...f.catalog(), routines: [{ ...routine, revision: { ...routine.revision, value: 2n } }] });
  await f.editor.observe(); assert.equal(f.editor.state.draft.name, "My draft"); assert.equal(f.editor.writable, false);
  f.editor.discard(); await f.editor.refresh(); assert.equal(f.editor.writable, true); assert.equal(f.editor.state.selected.revision.value, 2n); f.editor.dispose();
});

test("backgrounding retires a late catalog response and requires an explicit refresh", async () => {
  const f = fixture(); await f.editor.refresh(); let finish;
  f.api.list = async () => new Promise(resolve => { finish = resolve; });
  const observation = f.editor.observe(); f.editor.suspend(); finish({ ...f.catalog(), writable: false }); await observation;
  assert.equal(f.editor.state.catalog.writable, true); assert.equal(f.editor.state.requiresRefresh, true); assert.equal(f.mutations.length, 0);
  f.api.list = async () => f.catalog(); await f.editor.refresh(); assert.equal(f.editor.writable, true); f.editor.dispose();
});
