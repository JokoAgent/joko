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
});
