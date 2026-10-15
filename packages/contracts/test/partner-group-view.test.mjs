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

async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
test("finite observation discovers a later group from an empty directory without opening a change stream", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = api(); let groups = [], sequence = 0n, lists = 0, streams = 0;
  source.list = async () => { lists++; return create(ListPartnerGroupsResponseSchema, { revision: { value: sequence + 1n }, groups, changeSequence: sequence }); };
  source.changes = async function* () { streams++; };
  const view = new PartnerGroupViewController(source); view.setActive(true); await settle();
  assert.equal(view.state.status, "ready"); assert.deepEqual(view.state.catalog.groups, []); assert.equal(lists, 1); assert.equal(streams, 0);
  groups = [group]; sequence = 1n;
  context.mock.timers.tick(999); await settle(); assert.equal(lists, 1);
  context.mock.timers.tick(1); await settle(); assert.equal(lists, 2); assert.equal(view.state.catalog.groups[0].id, group.id);
  view.setActive(false); context.mock.timers.tick(10_000); await settle(); assert.equal(lists, 2); view.dispose();
});
test("one finite refresh observes member, message and interaction changes and coalesces confirmed action reads", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = api(); let sequence = 1n, gets = 0, lists = 0, finishList, confirmed = false;
  source.list = async () => { lists++; const captured = sequence; if (lists === 3) await new Promise(resolve => { finishList = resolve; });
    return create(ListPartnerGroupsResponseSchema, { revision: { value: captured }, groups: [{ ...group, name: `Project ${captured}` }], changeSequence: captured }); };
  source.get = async () => { gets++; return create(GetPartnerGroupResponseSchema, { detail: { group: { ...group, name: `Project ${sequence}` },
    messages: [{ id: `message-${sequence}`, sequence, content: `Reply ${sequence}` }] }, interactions: sequence > 1n ? [{ partnerId: "first", sessionId: "lane-one", generation: sequence }] : [] }); };
  const view = new PartnerGroupViewController(source); view.select(group.id); view.setActive(true); await settle();
  assert.equal(gets, 1);
  context.mock.timers.tick(1_000); await settle(); assert.equal(lists, 2); assert.equal(gets, 1);
  context.mock.timers.tick(1_000); await settle(); assert.equal(lists, 3);
  const catalogs = []; view.subscribe(() => { if (confirmed) catalogs.push(view.state.catalog.changeSequence); });
  const action = view.action(async () => { sequence = 2n; confirmed = true; return "confirmed"; }); await settle();
  assert.equal(lists, 3); finishList(); await action; await settle();
  assert.equal(lists, 4); assert.equal(view.state.detail.detail.group.name, "Project 2");
  assert.equal(view.state.detail.detail.messages.at(-1).content, "Reply 2"); assert.equal(view.state.detail.interactions[0].generation, 2n);
  assert.ok(catalogs.length > 0); assert.ok(catalogs.every(value => value === 2n));
  view.dispose();
});
test("read deadlines abort the exact request and retry only after it settles while rejecting retired answers", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = api(), reads = [];
  source.list = signal => new Promise(resolve => reads.push({ signal, resolve }));
  const view = new PartnerGroupViewController(source); view.setActive(true); await settle(); assert.equal(reads.length, 1);
  context.mock.timers.tick(4_999); await settle(); assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, false);
  context.mock.timers.tick(1); await settle(); assert.equal(reads[0].signal.aborted, true); assert.equal(view.state.status, "error");
  context.mock.timers.tick(999); await settle(); assert.equal(reads.length, 1);
  context.mock.timers.tick(1); await settle(); assert.equal(reads.length, 2);
  reads[0].resolve(create(ListPartnerGroupsResponseSchema, { revision: { value: 99n }, groups: [{ ...group, name: "Expired" }], changeSequence: 99n }));
  await settle(); assert.equal(view.state.catalog, undefined);
  view.setActive(false); assert.equal(reads[1].signal.aborted, true);
  reads[1].resolve(create(ListPartnerGroupsResponseSchema, { revision: { value: 2n }, groups: [group], changeSequence: 2n }));
  await settle(); assert.equal(view.state.status, "offline"); assert.equal(view.state.catalog, undefined);
  context.mock.timers.tick(10_000); await settle(); assert.equal(reads.length, 2); view.dispose();
});

test("selecting another group retires an in-flight detail and reads the current selection without another directory request", async () => {
  const source = api(), next = { ...group, id: "group-two", name: "Second" }; let lists = 0, finishOld;
  source.list = async () => { lists++; return create(ListPartnerGroupsResponseSchema, { revision: { value: 1n }, groups: [group, next], changeSequence: 1n }); };
  source.get = async id => {
    if (id === group.id) await new Promise(resolve => { finishOld = resolve; });
    return create(GetPartnerGroupResponseSchema, { detail: { group: id === group.id ? group : next } });
  };
  const view = new PartnerGroupViewController(source); view.select(group.id); view.setActive(true); await settle();
  view.select(next.id); finishOld(); await settle();
  assert.equal(lists, 1); assert.equal(view.state.selectedId, next.id); assert.equal(view.state.detail.detail.group.id, next.id); view.dispose();
});
