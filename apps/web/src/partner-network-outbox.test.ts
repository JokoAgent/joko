import { create } from "@bufbuild/protobuf";
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
