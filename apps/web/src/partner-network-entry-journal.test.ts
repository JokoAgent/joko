import { webcrypto } from "node:crypto";
import { locks } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerNetworkEntryJournal } from "./partner-network-entry-journal.js";
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("window", { navigator: { locks } });
});
afterEach(() => vi.unstubAllGlobals());
it("retains unknown entry identity while storing only a digest and isolates the owner", async () => {
  const disk = new Map<string, string>(), storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); } };
  const body = JSON.stringify(["join", "joko://conversation/join#secret", "Guest"]), first = new PartnerNetworkEntryJournal(storage, "owner");
  const id = await first.prepare(body), restarted = new PartnerNetworkEntryJournal(storage, "owner"); expect(await restarted.prepare(body)).toBe(id);
  expect(JSON.stringify([...disk])).not.toContain("secret"); expect(await new PartnerNetworkEntryJournal(storage, "other").read(body)).toBeUndefined();
  await restarted.confirm(body, id); expect(await restarted.read(body)).toBeUndefined();
});

it("accepts overlapping confirmations and preserves the next explicit group creation", async () => {
  const disk = new Map<string, string>();
  const storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => disk.set(key, value) };
  const first = new PartnerNetworkEntryJournal(storage, "owner");
  const second = new PartnerNetworkEntryJournal(storage, "owner");
  const body = JSON.stringify(["create", "Book club", "Owner", [], ""]);
  const original = await first.prepare(body);
  expect(await second.prepare(body)).toBe(original);
  await second.confirm(body, original);
  await first.confirm(body, original);
  const successor = await second.prepare(body);
  expect(successor).not.toBe(original);
  await first.confirm(body, original);
  expect(await first.read(body)).toBe(successor);
});

it("gives two simultaneous preparations of the same group entry one request identity", async () => {
  const disk = new Map<string, string>();
  const storage = {
    async getItem(key: string) {
      const snapshot = disk.get(key) ?? null;
      await new Promise<void>(resolve => setImmediate(resolve));
      return snapshot;
    },
    setItem: (key: string, value: string) => disk.set(key, value)
  };
  const body = JSON.stringify(["create", "Book club", "Owner", [], ""]);
  const first = new PartnerNetworkEntryJournal(storage, "owner"), second = new PartnerNetworkEntryJournal(storage, "owner");
  const [left, right] = await Promise.all([first.prepare(body), second.prepare(body)]);
  expect(right).toBe(left);
  expect(await second.read(body)).toBe(left);
});
