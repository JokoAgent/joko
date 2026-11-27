import assert from "node:assert/strict";
import { test } from "node:test";
import { locks } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import {
  PartnerRoutineEditor, RoutineCreationReceipts, PartnerRoutineSchema, ListPartnerRoutinesResponseSchema,
  ListPartnerRoutineRunsResponseSchema, PartnerRoutineRunSchema, RoutineRunStatus,
  GetPartnerRoutineCreationResponseSchema, RetirePartnerRoutineCreationResponseSchema, newRoutineDefinition
} from "../dist/index.js";

function fixture() {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  const newReceipts = () => new RoutineCreationReceipts(storage, "server-profile-device", (key, update) => locks.request(key, update));
  const receipts = newReceipts();
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
  return { data, storage, receipts, newReceipts, api, editor, draft, mutations, catalog: value => { if (value) catalog = value; return catalog; } };
}

test("existing async storage and two local clients retain the original receipt until its owner resolves it", async () => {
  const data = new Map();
  const storage = { getItem: async key => data.get(key) ?? null, setItem: async (key, value) => { data.set(key, value); },
    removeItem: async key => { data.delete(key); } };
  const first = new RoutineCreationReceipts(storage, "node");
  const second = new RoutineCreationReceipts(storage, "node");
  const claims = await Promise.allSettled([first.claim("partner", "routine-request-first"), second.claim("partner", "routine-request-second")]);
  assert.deepEqual(claims.map(result => result.status), ["fulfilled", "rejected"]);
  await second.resolve("partner", "routine-request-second");
  assert.equal(await second.read("partner"), "routine-request-first");
  await first.resolve("partner", "routine-request-first");
  assert.equal(await second.read("partner"), undefined);
});

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

for (const action of ["creation", "run"]) {
  test(`two editors serialize ${action} claims and a late success preserves the successor's lost receipt`, { timeout: 5000 }, async () => {
    const f = fixture(), otherReceipts = f.newReceipts();
    const receipts = [f.receipts, otherReceipts];
    const ids = ["routine-request-first", "routine-request-second"];
    const claim = (owner, id) => action === "creation" ? owner.claim("partner", id) : owner.claimRun("partner", "routine", id);
    const resolve = (owner, id) => action === "creation" ? owner.resolve("partner", id) : owner.resolveRun("partner", "routine", id);
    const results = await Promise.allSettled(receipts.map((owner, index) => claim(owner, ids[index])));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    assert.deepEqual([...f.data.values()], [ids[winner]]);
    await resolve(receipts[winner], ids[winner]);

    const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition: newRoutineDefinition() });
    f.catalog({ ...f.catalog(), routines: [routine] });
    const accepted = new Map(), entered = Promise.withResolvers(), reply = Promise.withResolvers();
    let firstId, secondId;
    const dispatch = async id => {
      accepted.set(id, routine);
      if (!firstId) { firstId = id; entered.resolve(); await reply.promise; }
      else if (id !== firstId && !secondId) { secondId = id; throw new Error("Response lost"); }
      return routine;
    };
    f.api.save = async (_revision, _draft, intent) => dispatch(intent.requestId);
    f.api.run = async (_revision, _selected, id) => { await dispatch(id); };
    f.api.lookup = async id => create(GetPartnerRoutineCreationResponseSchema, { routine: accepted.get(id) });
    const submit = async editor => {
      if (action === "run") { editor.select(routine); await editor.run(); }
      else { editor.select(); editor.edit({ name: "New", prompt: "Review" }); await editor.save(); }
    };
    await f.editor.refresh();
    const first = submit(f.editor);
    await entered.promise;
    const other = new PartnerRoutineEditor(f.api, otherReceipts, "partner");
    await other.refresh();
    if (action === "run") await submit(other); // Explicit replay of the original ID.
    await submit(other);
    assert.equal(other.state.error, "failed");
    assert.deepEqual([...f.data.values()], [secondId]);
    reply.resolve(); await first;
    assert.equal(f.editor.state.error, undefined);
    assert.deepEqual([...f.data.values()], [secondId]);
    f.editor.dispose(); other.dispose();
    const reopened = new PartnerRoutineEditor(f.api, f.newReceipts(), "partner");
    await reopened.refresh();
    if (action === "run") await submit(reopened);
    assert.equal(reopened.state.error, undefined);
    assert.equal(f.data.size, 0);
    assert.deepEqual([...accepted.keys()], [firstId, secondId]);
    reopened.dispose();
  });
}

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

test("restores the original dirty draft after a transient read and fences revoked authority and partner revision conflicts", async () => {
  const f = fixture();
  await f.editor.refresh(); f.draft();
  const original = f.editor.state.draft;
  f.api.list = async () => { throw new Error("Offline"); };
  await f.editor.observe();
  assert.equal(f.editor.writable, false);
  f.api.list = async () => f.catalog();
  await f.editor.observe();
  assert.equal(f.editor.state.draft, original);
  assert.equal(f.editor.writable, true);
  assert.equal(f.editor.state.error, undefined);
  f.editor.suspend(); await f.editor.refresh();
  assert.equal(f.editor.state.draft, original);
  assert.equal(f.editor.writable, true);
  f.catalog({ ...f.catalog(), writable: false });
  await f.editor.refresh(); await f.editor.save();
  assert.equal(f.editor.writable, false);
  assert.equal(f.editor.state.draft, original);
  f.catalog({ ...f.catalog(), writable: true, partnerRevision: { value: 2n } });
  await f.editor.observe(); await f.editor.refresh(); await f.editor.save();
  assert.equal(f.editor.writable, false);
  assert.equal(f.editor.state.draftConflict, true);
  assert.equal(f.editor.state.draft, original);
  assert.equal(f.mutations.length, 0);
  f.editor.dispose();
});

test("keeps run IDs unique and reaches the oldest run across insertions before and during pagination", async () => {
  const f = fixture();
  const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition: newRoutineDefinition() });
  const run = n => create(PartnerRoutineRunSchema, { id: String(n), routineId: routine.id, definitionRevision: { value: 1n }, status: RoutineRunStatus.RUNNING });
  const rows = Array.from({ length: 65 }, (_, i) => run(65 - i));
  const offsets = [];
  f.api.history = async (_id, offset) => {
    offsets.push(offset);
    return create(ListPartnerRoutineRunsResponseSchema, { runs: rows.slice(offset, offset + 20),
      nextOffset: offset + 20 < rows.length ? offset + 20 : undefined });
  };
  f.catalog({ ...f.catalog(), routines: [routine] });
  await f.editor.refresh(); f.editor.select(routine);
  await f.editor.history(); await f.editor.history(true);
  rows[0] = { ...rows[0], status: RoutineRunStatus.SUCCESS };
  rows.unshift(run(66)); await f.editor.observe();
  assert.equal(f.editor.state.runs.length, 41);
  assert.equal(f.editor.state.runs[1].status, RoutineRunStatus.SUCCESS);
  assert.equal(f.editor.state.nextOffset, 41);
  rows.unshift(run(67)); await f.editor.history(true);
  assert.equal(f.editor.state.runs.length, 60);
  await f.editor.observe(); await f.editor.history(true);
  assert.deepEqual(offsets, [0, 20, 0, 41, 0, 61]);
  assert.deepEqual(f.editor.state.runs.map(row => row.id), rows.map(row => row.id));
  assert.equal(f.editor.state.nextOffset, undefined);
  rows.unshift(...Array.from({ length: 22 }, (_, i) => run(89 - i)));
  await f.editor.observe();
  assert.deepEqual(f.editor.state.runs.map(row => row.id), rows.map(row => row.id));
  assert.equal(f.editor.state.nextOffset, undefined);
  f.editor.dispose();
});
