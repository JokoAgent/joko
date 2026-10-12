import assert from "node:assert/strict";
import { test } from "node:test";
import { PartnerMemoryEditor, validMemoryDraft } from "../dist/index.js";
const owner = { partnerId: "partner", homeTargetId: "home", canonicalSessionId: "canonical", revision: 2n, readOnly: false, memoryEnabled: true };
function fixture() {
  let entry = { owner, id: "memory", kind: "user", title: "Preferences", preview: "Use plain words.", body: "Use plain words.", updatedAt: 1000, revision: 3n };
  let writes = 0; let preferenceWrites = 0; let preferences = { owner, enabled: true, userContext: "", revision: 2n };
  const api = { ownerKey: "node-owner", list: async () => ({ owner, groups: [{ kind: "user", count: entry ? 1 : 0, entries: entry ? [entry] : [] }], truncated: false }),
    read: async () => ({ owner, ...(entry ? { entry } : {}) }),
    save: async (_base, draft) => { writes++; entry = { ...entry, ...draft, revision: entry.revision + 1n }; return entry; },
    remove: async () => { writes++; entry = undefined; }, preferences: async () => preferences,
    savePreferences: async (_base, patch) => { preferenceWrites++; preferences = { ...preferences, ...patch, owner: { ...owner, memoryEnabled: patch.enabled ?? preferences.enabled }, revision: preferences.revision + 1n }; return preferences; } };
  const editor = new PartnerMemoryEditor(api, owner);
  return { api, editor, writes: () => writes, preferenceWrites: () => preferenceWrites, preferences: next => { if (next) preferences = next; return preferences; }, current: next => { if (next) entry = next; return entry; } };
}
test("shows a concurrent edit, keeps the draft and saves only after the user chooses their changes", async () => {
  const f = fixture(); await f.editor.open("memory"); f.editor.edit(); f.editor.change({ body: "My changes." });
  f.current({ ...f.current(), body: "Partner changes.", revision: 4n });
  assert.equal(await f.editor.save(), false); assert.equal(f.writes(), 0); assert.equal(f.editor.state.latest.body, "Partner changes.");
  assert.equal(f.editor.state.draft.body, "My changes."); await f.editor.keepMine(); assert.equal(f.writes(), 1); assert.equal(f.current().body, "My changes.");
  assert.equal(f.editor.dirty, false); f.editor.dispose();
});
test("reads after lost save and delete acknowledgements and never replays a write", async () => {
  const f = fixture(); const save = f.api.save; const remove = f.api.remove;
  f.api.save = async (...args) => { await save(...args); throw new Error("Response lost"); };
  f.api.remove = async (...args) => { await remove(...args); throw new Error("Response lost"); };
  await f.editor.open("memory"); f.editor.edit(); f.editor.change({ title: "Revised" });
  assert.equal(await f.editor.save(), true); assert.equal(f.writes(), 1); assert.equal(f.editor.state.receipt, "saved");
  await f.editor.back(); await f.editor.remove(); assert.equal(f.writes(), 2); assert.equal(f.editor.state.view, "list"); assert.equal(f.editor.state.receipt, "deleted"); f.editor.dispose();
});
test("unknown results and suspended owners require an authoritative read before another effect", async () => {
  const f = fixture(); await f.editor.open("memory"); f.editor.edit(); f.editor.change({ body: "Kept draft." });
  const read = f.api.read; let reads = 0; f.api.read = async (...args) => { if (++reads > 1) throw new Error("Disconnected"); return read(...args); };
  f.api.save = async () => { throw new Error("Response unknown"); };
  assert.equal(await f.editor.save(), false); assert.equal(f.editor.state.pending, "save"); assert.equal(f.editor.writable, false);
  f.editor.suspend(); f.editor.activate(); assert.equal(f.editor.state.draft.body, "Kept draft."); assert.equal(f.editor.writable, false);
  f.api.read = read; await f.editor.check(); assert.equal(f.editor.state.pending, undefined); assert.equal(f.editor.writable, true);
  f.editor.dispose();
});
test("rejects stale owner completions and compares delete revisions before dispatch", async () => {
  const f = fixture(); await f.editor.open("memory"); f.current({ ...f.current(), revision: 4n });
  await f.editor.remove(); assert.equal(f.writes(), 0); assert.equal(f.editor.state.error, "changed");
  let finish; f.api.read = () => new Promise(resolve => { finish = resolve; });
  const pending = f.editor.check(); f.editor.dispose(); finish({ owner, entry: f.current() }); await pending;
  assert.equal(f.editor.state.error, "suspended"); assert.equal(f.writes(), 0);
});
test("checks UTF-8 content without depending on browser text encoders", () => {
  assert.equal(validMemoryDraft({ title: "题".repeat(100), body: "😀".repeat(2048) }), true);
  assert.equal(validMemoryDraft({ title: "x", body: "😀".repeat(2049) }), false);
  assert.equal(validMemoryDraft({ title: " ", body: "x" }), false);
});

test("keeps a private context draft on conflict and reconciles a lost settings acknowledgement without replay", async () => {
  const f = fixture(); await f.editor.openPreferences(); f.editor.changePreferences({ enabled: false, userContext: "My complete context." });
  f.preferences({ ...f.preferences(), revision: 3n, userContext: "Changed elsewhere." });
  assert.equal(await f.editor.save(), false); assert.equal(f.preferenceWrites(), 0); assert.equal(f.editor.state.latestPreferences.userContext, "Changed elsewhere.");
  assert.equal(f.editor.state.preferencesDraft.userContext, "My complete context.");
  const save = f.api.savePreferences; f.api.savePreferences = async (...args) => { await save(...args); throw new Error("Response lost"); };
  await f.editor.keepPreferences(); assert.equal(f.preferenceWrites(), 1); assert.equal(f.editor.dirty, false); assert.equal(f.preferences().enabled, false);
  f.editor.changePreferences({ userContext: "Still only a process draft." }); f.editor.suspend(); f.editor.activate();
  assert.equal(await f.editor.save(), false); assert.equal(f.preferenceWrites(), 1); assert.equal(f.editor.state.preferencesDraft.userContext, "Still only a process draft.");
  await f.editor.refresh(); assert.equal(await f.editor.save(), true); assert.equal(f.preferenceWrites(), 2); f.editor.dispose();
});

test("retains an oversized inherited context while changing only its memory switch", async () => {
  const f = fixture(); f.preferences({ ...f.preferences(), userContext: "x".repeat(12_001) });
  const save = f.api.savePreferences; let patch;
  f.api.savePreferences = async (base, next, signal) => { patch = next; return save(base, next, signal); };
  await f.editor.openPreferences(); f.editor.changePreferences({ enabled: false });
  assert.equal(await f.editor.save(), true); assert.deepEqual(patch, { enabled: false }); assert.equal(f.preferences().userContext.length, 12_001);
  f.editor.dispose();
});

test("preserves edits made while saving and reads a lost acknowledgement before another save", async () => {
  for (const lost of [false, true]) {
    const f = fixture(); const save = f.api.save; let finish;
    f.api.save = async (...args) => { if (!finish) { await new Promise(resolve => { finish = resolve; });
      const result = await save(...args); if (lost) throw new Error("Response lost"); return result; }
      return save(...args); };
    await f.editor.open("memory"); f.editor.edit(); f.editor.change({ body: "First draft." });
    const pending = f.editor.save(); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.editor.state.busy, true); f.editor.change({ body: "Latest draft." }); finish();
    assert.equal(await pending, !lost); assert.equal(f.editor.state.draft.body, "Latest draft.");
    if (lost) { assert.equal(f.writes(), 1); assert.equal(f.current().body, "First draft."); assert.equal(f.editor.state.pending, undefined); await f.editor.save(); }
    assert.equal(f.writes(), 2); assert.equal(f.current().body, "Latest draft."); assert.equal(f.editor.dirty, false); f.editor.dispose();
  }
});
