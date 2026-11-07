import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { PartnerGlanceTodos, PartnerTodoSchema, ListPartnerTodosResponseSchema } from "../dist/index.js";

function fixture(count = 60) {
  const items = Array.from({ length: count }, (_, index) => create(PartnerTodoSchema, { id: `todo-${index}`, revision: 1n,
    title: `Affair ${index}`, outcome: "Reviewed", status: "open", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }));
  const reads = [], mutations = [], receipts = new Map(); let fail = false, counter = 0;
  const api = { ownerKey: "original-owner", newOperationId: () => `operation-${++counter}`,
    todos: async (_partnerId, view, offset) => { reads.push([view, offset]); const visible = view === "open" ? items.filter(item => !item.deleted) : [];
      return create(ListPartnerTodosResponseSchema, { partnerId: "partner", partnerRevision: { value: 4n }, items: visible.slice(offset, offset + 25), total: visible.length,
        ...(offset + 25 < visible.length ? { nextOffset: offset + 25 } : {}) }); },
    updateTodo: async (id, _partnerId, _revision, todo, action) => {
      mutations.push([id, todo.revision, action]); let result = receipts.get(id);
      if (!result) { const index = items.findIndex(item => item.id === todo.id), found = items[index];
        result = { ...found, revision: found.revision + 1n, deleted: action === "delete" }; items[index] = result; receipts.set(id, result); }
      if (fail) { fail = false; throw new Error("Lost receipt after commit"); } return result;
    } };
  return { api, reads, mutations, editor: new PartnerGlanceTodos(api, "partner"), loseReceipt: () => { fail = true; } };
}
test("reads every page and recovers the exact delete receipt before an explicit undo", async context => {
  const f = fixture(); context.after(() => f.editor.dispose()); f.editor.activate(); await f.editor.refresh();
  assert.equal(f.editor.snapshot().open.length, 60); assert.ok(f.reads.some(([view, offset]) => view === "open" && offset === 50));
  const original = f.editor.snapshot().open[0]; f.loseReceipt(); await f.editor.mutate(original, "delete");
  assert.equal(f.editor.snapshot().pending, true); assert.equal(f.editor.snapshot().failed, true);
  assert.equal(original.revision, 1n);
  await f.editor.mutate(f.editor.snapshot().open[1], "delete");
  assert.equal(f.mutations.length, 1);
  await f.editor.mutate(); assert.deepEqual(f.mutations[0], f.mutations[1]); assert.equal(f.editor.snapshot().open.length, 59);
  const deleted = f.editor.snapshot().deleted; assert.equal(deleted.revision, 2n);
  await f.editor.mutate(deleted, "restore"); assert.equal(f.editor.snapshot().open.length, 60); assert.equal(f.editor.snapshot().deleted, undefined);
  assert.notEqual(f.mutations[2][0], f.mutations[0][0]); f.editor.dispose();
});
test("suspension retires an in-flight read and never dispatches a retained action automatically", async context => {
  const f = fixture(1); context.after(() => f.editor.dispose()); f.editor.activate(); await f.editor.refresh(); f.loseReceipt(); await f.editor.mutate(f.editor.snapshot().open[0], "delete");
  f.editor.suspend(); f.editor.activate(); await f.editor.refresh(); assert.equal(f.mutations.length, 1);
  assert.equal(f.editor.snapshot().openTotal, 0);
  assert.equal(f.editor.snapshot().pending, true);
  assert.equal(f.editor.snapshot().failed, true); f.editor.dispose();
});

test("selects the newest 200 created completions for Mobile and keeps the original open and Desktop windows", async context => {
  const open = Array.from({ length: 201 }, (_, index) => ({ id: `open-${index + 1}`, status: "open" }));
  const done = Array.from({ length: 201 }, (_, index) => ({ id: `done-${index + 1}`, status: "done" }));
  const doneOffsets = [];
  let changed = false;
  const api = { todos: async (partnerId, view, offset) => {
    const source = view === "open" ? open : done;
    if (view === "done") doneOffsets.push(offset);
    const total = changed && view === "done" && offset > 0 ? source.length - 1 : source.length;
    const items = source.slice(offset, offset + 25);
    return create(ListPartnerTodosResponseSchema, { partnerId, partnerRevision: { value: 1n }, items, total,
      ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}) });
  } };
  const mobile = new PartnerGlanceTodos(api, "partner", "newest"), desktop = new PartnerGlanceTodos(api, "partner");
  context.after(() => { mobile.dispose(); desktop.dispose(); });
  const load = editor => new Promise(resolve => {
    const unsubscribe = editor.subscribe(() => {
      if (!editor.snapshot().loaded) return;
      unsubscribe();
      resolve();
    });
    editor.activate();
  });
  const ids = items => items.map(todo => todo.id);

  await load(desktop);
  assert.deepEqual(ids(desktop.snapshot().done), ids(done.slice(0, 200).reverse()));
  doneOffsets.length = 0;
  await load(mobile);
  assert.equal(mobile.snapshot().openTotal, 201);
  assert.equal(mobile.snapshot().doneTotal, 201);
  assert.deepEqual(ids(mobile.snapshot().open), ids(open.slice(0, 200)));
  assert.deepEqual(ids(mobile.snapshot().done), ids(done.slice(1).reverse()));
  assert.deepEqual(doneOffsets, [0, 1, 26, 51, 76, 101, 126, 151, 176]);

  const retained = mobile.snapshot().done;
  changed = true;
  await mobile.refresh();
  assert.equal(mobile.snapshot().failed, true);
  assert.equal(mobile.snapshot().done, retained);
});
