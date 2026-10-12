import assert from "node:assert/strict";
import test from "node:test";
import { PartnerSkillsEditor } from "../dist/index.js";
const owner = { partnerId: "partner", homeTargetId: "home", canonicalSessionId: "canonical", revision: 2n, readOnly: false };
function fixture() {
  let entry = { owner, summary: { id: "skill", slug: "report", name: "Report", description: "Create reports", enabled: true,
    revision: 3n, contentRevision: `sha256:${"a".repeat(64)}`, updatedAt: "2026-10-12" }, name: "Report", description: "Create reports", body: "Use templates.", bodyBytes: 14n, readOnly: false };
  let writes = 0;
  const api = { ownerKey: "node-task-owner", list: async () => ({ owner, skills: entry ? [entry.summary] : [], total: entry ? 1 : 0 }),
    read: async () => entry, save: async (_base, draft) => { writes++; entry = { ...entry, ...draft, summary: { ...entry.summary, name: draft.name,
      description: draft.description, revision: entry.summary.revision + 1n } }; return entry; }, remove: async () => { writes++; entry = undefined; } };
  return { api, editor: new PartnerSkillsEditor(api, owner), writes: () => writes, current: value => { if (value) entry = value; return entry; } };
}
test("personal skill drafts retain concurrent changes and require a choice before saving", async () => {
  const f = fixture(); await f.editor.open("skill"); f.editor.edit(); f.editor.change({ body: "My instruction." });
  f.current({ ...f.current(), body: "Concurrent instruction.", summary: { ...f.current().summary, revision: 4n } });
  assert.equal(await f.editor.save(), false); assert.equal(f.writes(), 0); assert.equal(f.editor.state.latest.body, "Concurrent instruction.");
  assert.equal(f.editor.state.draft.body, "My instruction."); f.editor.keepMine(); assert.equal(await f.editor.save(), true);
  assert.equal(f.writes(), 1); assert.equal(f.current().body, "My instruction."); assert.equal(f.editor.dirty, false); f.editor.dispose();
});
test("personal skill save/delete acknowledgement loss is read back without another effect", async () => {
  const f = fixture(), save = f.api.save, remove = f.api.remove;
  f.api.save = async (...args) => { await save(...args); throw Error("Lost save acknowledgement"); };
  f.api.remove = async (...args) => { await remove(...args); throw Error("Lost delete acknowledgement"); };
  await f.editor.open("skill"); f.editor.edit(); f.editor.change({ name: "Updated" });
  assert.equal(await f.editor.save(), true); assert.equal(f.writes(), 1);
  assert.equal(await f.editor.remove(), true); assert.equal(f.writes(), 2); assert.equal(f.editor.state.view, "list"); f.editor.dispose();
});
test("personal skill unknown writes and suspended owners preserve drafts until an authoritative read", async () => {
  const f = fixture(), read = f.api.read; let reads = 0;
  await f.editor.open("skill"); f.editor.edit(); f.editor.change({ body: "Keep this draft." });
  f.api.read = async (...args) => { if (++reads > 1) throw Error("Disconnected"); return read(...args); };
  f.api.save = async () => { throw Error("Unknown result"); };
  assert.equal(await f.editor.save(), false); assert.equal(f.editor.state.error, "unknown"); assert.equal(f.editor.editable, false);
  f.editor.suspend(); f.editor.activate(); assert.equal(f.editor.state.draft.body, "Keep this draft.");
  assert.equal(await f.editor.save(), false); f.api.read = read; await f.editor.refresh(); assert.equal(f.editor.editable, true); f.editor.dispose();
});
test("personal skill large previews remain read-only and retired Task results cannot install", async () => {
  const f = fixture(); f.current({ ...f.current(), readOnly: true, body: "Read-only preview.", bodyBytes: 80000n });
  await f.editor.open("skill"); f.editor.edit(); assert.equal(f.editor.state.draft, undefined); assert.equal(await f.editor.remove(), false); assert.equal(f.writes(), 0);
  let finish; const pending = new Promise(resolve => { finish = resolve; }); f.api.read = async () => { await pending; return f.current(); };
  const opening = f.editor.open("skill"); f.editor.dispose(); finish(); await opening;
  assert.equal(f.editor.state.detail.body, "Read-only preview."); assert.equal(f.editor.editable, false);
});

test("a confirmed personal save may become read-only without saving the preview, while invalid content keeps its draft", async () => {
  const f = fixture(); await f.editor.open("skill"); f.editor.edit(); const body = "a".repeat(54_000);
  f.editor.change({ body }); f.api.save = async (_base, draft) => ({ ...f.current(), ...draft,
    body: `${draft.body.slice(0, 12_000)}\n…`, bodyBytes: 54000n, readOnly: true });
  assert.equal(await f.editor.save(), true); assert.equal(f.editor.state.view, "detail"); assert.equal(f.editor.state.draft, undefined);
  assert.equal(f.editor.editable, false); f.editor.dispose();
  const invalid = fixture(); await invalid.editor.open("skill"); invalid.editor.edit(); invalid.editor.change({ body: "Keep this rejected draft." });
  invalid.api.save = async () => { throw Object.assign(Error("Invalid content"), { code: 3 }); };
  assert.equal(await invalid.editor.save(), false); assert.equal(invalid.editor.state.error, "failed"); assert.equal(invalid.editor.editable, true);
  assert.equal(invalid.editor.state.draft.body, "Keep this rejected draft."); invalid.editor.dispose();
});
