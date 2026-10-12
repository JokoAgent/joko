import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { PartnerConnectionsEditor, createPartnerConnectionsApi, GetPartnerConnectionsResponseSchema, PartnerConnectionKind, PartnerConnectionMode } from "../dist/index.js";
const owner = { partnerId: "partner", homeTargetId: "home", canonicalSessionId: "canonical", revision: 2n, readOnly: false };
function fixture() {
  let current = { owner, catalogRevision: "a".repeat(64), entries: [
    { kind: "mcp", id: "server", name: "Server", available: true, inherited: true },
    { kind: "toolsets", id: "optional", name: "Optional", available: true, inherited: false }
  ], mcp: { mode: "inherit", ids: [] }, toolsets: { mode: "inherit", ids: [] }, skills: { mode: "allowlist", ids: [] } };
  let writes = 0;
  const api = { ownerKey: "node", read: async () => current, save: async (_base, draft) => { writes++; current = { ...current, ...draft, revision: (current.revision ?? 0n) + 1n }; return current; } };
  const editor = new PartnerConnectionsEditor(api, owner);
  return { editor, api, writes: () => writes, current: value => value ? current = value : current };
}
test("skill references use opaque selections independently from personal rows and never inherit", async () => {
  const f = fixture(); f.current({ ...f.current(), entries: [...f.current().entries,
    { kind: "skills", id: "shared-a", name: "Report", description: "Useful reports", available: true, inherited: false },
    { kind: "skills", id: "shared-b", name: "Report", description: "Other reports", available: false, inherited: false },
    { kind: "skills", id: "personal", name: "Learned", personal: true, available: true, inherited: false }], skills: { mode: "allowlist", ids: ["shared-b"] } });
  await f.editor.refresh(); assert.equal(f.editor.selected(f.editor.rows("skills")[2]), true);
  f.editor.toggle(f.editor.rows("skills")[2], false); assert.equal(f.editor.dirty, false);
  f.editor.inherit("skills"); assert.equal(f.editor.state.draft.skills.mode, "allowlist");
  f.editor.toggle(f.editor.rows("skills")[0], true); f.editor.toggle(f.editor.rows("skills")[1], false);
  assert.equal(await f.editor.save(), true); assert.deepEqual(f.editor.state.detail.skills.ids, ["shared-a"]);
  assert.equal(f.editor.state.detail.mcp.mode, "inherit"); f.editor.query("useful"); assert.deepEqual(f.editor.rows("skills").map(item => item.id), ["shared-a"]);
});
test("connection references preserve inherited selections and missing joined entries across independent groups", async () => {
  const f = fixture(); await f.editor.refresh(); f.editor.toggle(f.editor.rows("mcp")[0], false);
  assert.deepEqual(f.editor.state.draft.mcp, { mode: "allowlist", ids: [] }); assert.equal(f.editor.state.draft.toolsets.mode, "inherit");
  f.editor.toggle(f.editor.rows("toolsets")[0], true); assert.equal(await f.editor.save(), true); assert.equal(f.writes(), 1);
  f.current({ ...f.current(), entries: [] }); await f.editor.refresh(); assert.equal(f.editor.rows("toolsets")[0].available, false);
  f.editor.toggle(f.editor.rows("toolsets")[0], false); assert.equal(await f.editor.save(), true);
  f.editor.inherit("mcp"); assert.equal(await f.editor.save(), true); assert.equal(f.editor.state.detail.mcp.mode, "inherit");
});
test("connection catalog drift preserves the draft and requires an explicit conflict choice", async () => {
  const f = fixture(); await f.editor.refresh(); f.editor.toggle(f.editor.rows("mcp")[0], false);
  f.current({ ...f.current(), catalogRevision: "b".repeat(64) }); assert.equal(await f.editor.save(), false); assert.equal(f.writes(), 0); assert.equal(f.editor.dirty, true);
  f.editor.keepMine(); assert.equal(await f.editor.save(), true); assert.equal(f.writes(), 1);
});
test("connection lost acknowledgements reconcile a committed selection without a second write", async () => {
  const f = fixture(); const save = f.api.save;
  f.api.save = async (...args) => { await save(...args); throw new Error("lost acknowledgement"); };
  await f.editor.refresh(); f.editor.toggle(f.editor.rows("mcp")[0], false); assert.equal(await f.editor.save(), true);
  assert.equal(f.writes(), 1); assert.equal(f.editor.dirty, false); assert.equal(f.editor.state.saved, true);
});
test("connection unknown writes lock editing until refresh and reject late or foreign owners", async () => {
  const f = fixture(); const read = f.api.read, save = f.api.save; let unavailable = false;
  f.api.read = async () => { if (unavailable) throw new Error("offline"); return read(); };
  f.api.save = async (...args) => { await save(...args); unavailable = true; throw new Error("offline"); };
  await f.editor.refresh(); f.editor.toggle(f.editor.rows("mcp")[0], false); assert.equal(await f.editor.save(), false);
  assert.equal(f.editor.state.error, "unknown"); assert.equal(f.editor.editable, false); assert.equal(f.writes(), 1);
  unavailable = false; await f.editor.refresh(); assert.equal(f.editor.dirty, false); assert.equal(f.writes(), 1);
  let release; f.api.read = () => new Promise(resolve => { release = resolve; }); const pending = f.editor.refresh(); f.editor.suspend(); release(f.current()); await pending;
  assert.equal(f.editor.state.error, "suspended"); f.editor.activate(); f.api.read = async () => ({ ...f.current(), owner: { ...owner, homeTargetId: "foreign" } }); await f.editor.refresh();
  assert.equal(f.editor.editable, false); assert.equal(f.editor.state.error, "failed");
});
test("generated connection API validates catalog enums and sends exact profile, preference and catalog revisions", async () => {
  const response = create(GetPartnerConnectionsResponseSchema, { connections: { owner: { ...owner, revision: { value: owner.revision } }, catalogRevision: "a".repeat(64),
    entries: [{ kind: PartnerConnectionKind.MCP, id: "server", name: "Server", available: true, inherited: true }],
    mcp: { mode: PartnerConnectionMode.INHERIT }, toolsets: { mode: PartnerConnectionMode.INHERIT }, skills: { mode: PartnerConnectionMode.ALLOWLIST } } });
  let sent;
  const rpc = { getPartnerConnections: async () => response, updatePartnerConnections: async request => { sent = request; return { connections: { ...response.connections, revision: { value: 3n }, mcp: request.mcp, toolsets: request.toolsets, skills: request.skills } }; } };
  const api = createPartnerConnectionsApi({ rpc, partnerId: owner.partnerId, ownerKey: "node", assertCurrent: signal => signal.throwIfAborted() });
  const signal = new AbortController().signal, base = await api.read(signal);
  await api.save(base, { mcp: { mode: "allowlist", ids: [] }, toolsets: base.toolsets, skills: base.skills }, signal);
  assert.equal(sent.expectedPartnerRevision.value, 2n); assert.equal(sent.expectedRevision, undefined); assert.equal(sent.expectedCatalogRevision, "a".repeat(64));
  response.connections.entries[0].kind = 999; await assert.rejects(api.read(signal), /catalog/u);
});
