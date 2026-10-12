import assert from "node:assert/strict";
import { test } from "node:test";
import { PartnerResumeEditor } from "../dist/index.js";
const profile = { partnerId: "partner", revision: 1n, profileVersion: 1n, displayName: "Reviewer", homeTargetId: "home",
  canonicalSessionId: "canonical", backendId: "backend", lifecycle: "paused", initializationState: "ready", pauseCleanupPending: false };
function fixture() {
  let current = { ...profile }; let mutations = 0;
  const api = { ownerKey: "node-owner", read: async () => ({ ...current }), resume: async selected => {
    mutations++; current = { ...selected, revision: selected.revision + 1n, lifecycle: "active", pauseCleanupPending: undefined }; return current;
  } };
  const editor = new PartnerResumeEditor(api, profile);
  return { api, editor, current: value => { if (value) current = value; return current; }, mutations: () => mutations };
}
test("requires a current confirmation and readback before reporting a successful resume", async () => {
  const f = fixture(); await f.editor.resume(); assert.equal(f.mutations(), 0);
  await f.editor.refresh(); await f.editor.resume(); assert.equal(f.mutations(), 1);
  assert.equal(f.editor.state.phase, "completed"); assert.equal(f.editor.state.profile.lifecycle, "active"); f.editor.dispose();
});
test("refreshes a changed revision without dispatching until the user confirms the current profile again", async () => {
  const f = fixture(); await f.editor.refresh(); f.current({ ...profile, revision: 2n, displayName: "Updated reviewer" });
  await f.editor.resume(); assert.equal(f.mutations(), 0); assert.equal(f.editor.state.error, "changed");
  assert.equal(f.editor.state.profile.displayName, "Updated reviewer"); await f.editor.resume(); assert.equal(f.mutations(), 1); f.editor.dispose();
});
test("resolves a lost acknowledgement only by reading and never repeats the mutation", async () => {
  const f = fixture(); const resume = f.api.resume;
  f.api.resume = async selected => { await resume(selected); throw new Error("Response lost"); };
  await f.editor.refresh(); await f.editor.resume(); assert.equal(f.editor.state.phase, "unknown");
  await f.editor.resume(); assert.equal(f.mutations(), 1); await f.editor.refresh(); assert.equal(f.editor.state.phase, "completed");
  assert.equal(f.mutations(), 1); f.editor.dispose();
});
test("retires background results and checks the current owner again before another effect", async () => {
  const f = fixture(); let release; const gate = new Promise(resolve => { release = resolve; }); const original = f.api.resume;
  f.api.resume = async selected => { await gate; return original(selected); };
  await f.editor.refresh(); const pending = f.editor.resume(); await Promise.resolve(); f.editor.suspend(); release(); await pending;
  assert.equal(f.editor.state.phase, "suspended"); assert.equal(f.editor.state.profile, undefined);
  f.editor.activate(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.editor.state.phase, "completed"); assert.equal(f.mutations(), 1); f.editor.dispose();
});
test("rejects a replacement canonical task and remains read only after an invalid response", async () => {
  const f = fixture(); f.current({ ...profile, canonicalSessionId: "replacement" }); await f.editor.refresh();
  assert.equal(f.editor.state.phase, "error"); await f.editor.resume(); assert.equal(f.mutations(), 0); f.editor.dispose();
});
