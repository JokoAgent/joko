import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { PartnerNetworkEntryJournal } from "./partner-network-entry-journal.js";
afterEach(() => vi.unstubAllGlobals());
it("retains unknown entry identity while storing only a digest and isolates the owner", async () => {
  vi.stubGlobal("crypto", webcrypto); const disk = new Map<string, string>(), storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); } };
  const body = JSON.stringify(["join", "joko://conversation/join#secret", "Guest"]), first = new PartnerNetworkEntryJournal(storage, "owner");
  const id = await first.prepare(body), restarted = new PartnerNetworkEntryJournal(storage, "owner"); expect(await restarted.prepare(body)).toBe(id);
  expect(JSON.stringify([...disk])).not.toContain("secret"); expect(await new PartnerNetworkEntryJournal(storage, "other").read(body)).toBeUndefined();
  await restarted.confirm(body, id); expect(await restarted.read(body)).toBeUndefined();
});
