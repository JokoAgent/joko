import { create, toJsonString } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { PartnerNetworkSendJournal, SendPartnerNetworkRequestSchema } from "@joko/contracts";

it("restores the original send identity after an unknown transport result and never changes accepted input", async () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const journal = new PartnerNetworkSendJournal(storage, "node:profile:room"); await journal.initialize();
  const request = create(SendPartnerNetworkRequestSchema, { operationId: "original-send", roomId: "room", text: "retained draft", mentions: ["actor"] }); await journal.prepare(request, 123);
  const resumed = new PartnerNetworkSendJournal(storage, "node:profile:room"), entries = await resumed.initialize(); expect(entries[0]?.request).toEqual(request);
  await expect(resumed.prepare(create(SendPartnerNetworkRequestSchema, { ...request, text: "different" }))).rejects.toThrow();
  await resumed.prepare(entries[0]!.request); await resumed.acknowledge(request.operationId, "message"); await resumed.displayed(new Set(["message"])); expect(resumed.list()).toEqual([]);
  expect(await new PartnerNetworkSendJournal(storage, "node:another-profile:room").initialize()).toEqual([]);
});
it("does not permit dispatch before the exact request is durably saved", async () => {
  const send = vi.fn(), journal = new PartnerNetworkSendJournal({ getItem: () => null, setItem: () => { throw new Error("storage unavailable"); } }, "owner"); await journal.initialize();
  const dispatch = async () => { await journal.prepare(create(SendPartnerNetworkRequestSchema, { operationId: "input", roomId: "room", text: "hello" })); send(); };
  await expect(dispatch()).rejects.toThrow("storage unavailable"); expect(send).not.toHaveBeenCalled();
  expect(journal.list()).toEqual([]);
});

it("preserves overlapping main and thread sends when either view settles or reopens", async () => {
  let disk: string | null = null;
  const storage = { getItem: () => disk, setItem: (_key: string, value: string) => { disk = value; } };
  const open = () => new PartnerNetworkSendJournal(storage, "room-owner");
  const main = open(), thread = open();
  await Promise.all([main.initialize(), thread.initialize()]);
  const first = create(SendPartnerNetworkRequestSchema, { operationId: "main-send", roomId: "room", text: "Main text" });
  const second = create(SendPartnerNetworkRequestSchema, { operationId: "reply-send", roomId: "room", threadRootId: "topic", text: "Reply" });
  await Promise.all([main.prepare(first, 10), thread.prepare(second, 20)]);
  expect((await open().initialize()).map(entry => entry.request)).toEqual([first, second]);
  await main.acknowledge(first.operationId, "main-message");
  await main.displayed(new Set(["main-message"]));
  await thread.prepare(second);
  expect(await open().initialize()).toEqual([{ request: second, createdAt: 20 }]);
});

it("refreshes a peer's settlement without reinserting its receipt or discarding an unrelated pending message", async () => {
  let disk: string | null = null;
  const storage = { getItem: () => disk, setItem: vi.fn((_key: string, value: string) => { disk = value; }) };
  const first = new PartnerNetworkSendJournal(storage, "room"), peer = new PartnerNetworkSendJournal(storage, "room");
  const sent = create(SendPartnerNetworkRequestSchema, { operationId: "sent", roomId: "room", text: "Accepted" });
  const other = create(SendPartnerNetworkRequestSchema, { operationId: "other", roomId: "room", text: "Unconfirmed" });
  await first.initialize(); await first.prepare(sent); await first.prepare(other);
  await peer.initialize();
  await first.acknowledge(sent.operationId, "message");
  await expect(first.acknowledge(sent.operationId, "different")).rejects.toThrow("identity");
  await first.displayed(new Set(["message"]));
  storage.setItem.mockClear();
  await peer.displayed(new Set(["message"]));
  expect(peer.list().map(entry => entry.request)).toEqual([other]);
  await peer.acknowledge(sent.operationId, "message");
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(peer.list().map(entry => entry.request)).toEqual([other]);
});

it("settles a displayed message only for the matching room and membership", async () => {
  let disk: string | null = null;
  const journal = new PartnerNetworkSendJournal({ getItem: () => disk, setItem: (_key, value) => { disk = value; } }, "phone");
  await journal.initialize();
  for (const [roomId, joinId] of [["one", "a"], ["two", "b"], ["one", "c"]] as const) {
    await journal.prepare(create(SendPartnerNetworkRequestSchema, { operationId: joinId, roomId, joinId }));
    await journal.acknowledge(joinId, "message");
  }
  await journal.displayed(new Set(["message"]), { roomId: "one", joinId: "a" });
  expect(journal.list().map(entry => entry.request.joinId)).toEqual(["b", "c"]);
});

it("can resolve old v1 entries above the limit before admitting another send", async () => {
  const request = (index: number) => create(SendPartnerNetworkRequestSchema, { operationId: `send-${index}`, roomId: "room", text: "Pending" });
  const entries = Array.from({ length: 1001 }, (_, index) => ({
    request: toJsonString(SendPartnerNetworkRequestSchema, request(index)), createdAt: index
  }));
  let disk = JSON.stringify({ format: 1, scope: "owner", entries });
  const journal = new PartnerNetworkSendJournal({ getItem: () => disk, setItem: (_key, value) => { disk = value; } }, "owner");
  expect(await journal.initialize()).toHaveLength(1001);
  await expect(journal.prepare(request(1001))).rejects.toThrow(/full/);
  await journal.prepare(request(0));
  await journal.acknowledge("send-0", "first");
  await journal.acknowledge("send-1", "second");
  await journal.displayed(new Set(["first", "second"]));
  await journal.prepare(request(1001));
  expect(journal.list()).toHaveLength(1000);
});
