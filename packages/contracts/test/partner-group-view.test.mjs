import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { PartnerGroupViewController, GetPartnerGroupResponseSchema, ListPartnerGroupsResponseSchema } from "../dist/index.js";

const group = { id: "group-one", revision: { value: 1n }, name: "Project", members: [{ partnerId: "first", name: "First" }, { partnerId: "second", name: "Second" }] };
function api() {
  const reads = []; let before = [];
  return { reads, setBefore: value => { before = value; }, ownerKey: "node-one",
    list: async () => create(ListPartnerGroupsResponseSchema, { revision: { value: 1n }, groups: [group], changeSequence: 1n }),
    get: async (_id, cursor) => create(GetPartnerGroupResponseSchema, { detail: { group, hasMoreBefore: cursor === undefined,
      messages: (cursor === undefined ? [4n, 5n] : before).map(sequence => ({ id: `message-${sequence}`, sequence, content: `Reply ${sequence}` })) } }),
    changes: async function* (_after, signal) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); },
    markRead: async (id, sequence) => { reads.push([id, sequence]); } };
}
async function ready(view) { for (let i = 0; i < 50; i++) { if (view.state.status === "ready" && view.state.detail) return; await new Promise(resolve => setImmediate(resolve)); } throw Error("view did not become ready"); }
test("loading and pagination never acknowledge unseen messages and preserve the latest timeline", async () => {
  const source = api(), view = new PartnerGroupViewController(source); source.setBefore([2n, 3n]); view.select(group.id); view.setActive(true); await ready(view);
  assert.deepEqual(source.reads, []); await view.older(); assert.deepEqual(view.state.detail.detail.messages.map(item => item.sequence), [2n, 3n, 4n, 5n]);
  await view.refresh(); assert.deepEqual(view.state.detail.detail.messages.map(item => item.sequence), [2n, 3n, 4n, 5n]); assert.deepEqual(source.reads, []);
  view.markVisible(4n); view.markVisible(3n); view.markVisible(5n); assert.deepEqual(source.reads, [[group.id, 4n], [group.id, 5n]]); view.dispose();
});
test("background retirement rejects late effects and the same current view can reactivate", async () => {
  const view = new PartnerGroupViewController(api()); view.select(group.id); view.setActive(true); await ready(view); let finish;
  const action = view.action(() => new Promise(resolve => { finish = resolve; }), false, true); assert.equal(view.state.busy, true); view.setActive(false); finish(true);
  await assert.rejects(action, /owner changed/); assert.equal(view.state.busy, false); view.setActive(true); await ready(view); assert.equal(await view.action(async () => true), true); view.dispose();
});
