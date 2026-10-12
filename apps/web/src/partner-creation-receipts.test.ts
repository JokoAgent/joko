// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfile } from "./model.js";
import { PartnerCreationReceipts } from "./partner-creation-receipts.js";

const profile: ConnectionProfile = { id: "profile-one", serverId: "node-one", deviceId: "device-one", origin: "https://node.example", name: "Work node" };
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("Partner creation receipts", () => {
  it("retains only opaque request IDs across reopen and isolates the exact node, profile, device and origin", () => {
    const first = new PartnerCreationReceipts(localStorage, profile);
    first.claim("creation-request-first");
    first.claim("creation-request-second");
    expect(new PartnerCreationReceipts(localStorage, profile).list()).toEqual(["creation-request-first", "creation-request-second"]);
    for (const other of [{ serverId: "node-two" }, { id: "profile-two" }, { deviceId: "device-two" }, { origin: "https://other.example" }]) {
      expect(new PartnerCreationReceipts(localStorage, { ...profile, ...other }).list()).toEqual([]);
    }
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!)))
      .toEqual(["creation-request-first", "creation-request-second"]);
    first.resolve("creation-request-first");
    expect(first.list()).toEqual(["creation-request-second"]);
  });

  it("fails closed on unavailable writes, malformed receipts and credential-bearing owners", () => {
    const store = new PartnerCreationReceipts(localStorage, profile);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
    expect(() => store.claim("creation-request-first")).toThrow(/not saved/u);
    vi.restoreAllMocks();
    store.claim("creation-request-first");
    localStorage.setItem(localStorage.key(0)!, "unexpected-shape");
    expect(() => store.list()).toThrow(/recovery/u);
    expect(() => new PartnerCreationReceipts(localStorage, { ...profile, origin: "https://secret:secret@node.example" })).toThrow(/invalid/u);
    expect(() => new PartnerCreationReceipts(localStorage, { ...profile, origin: "https://node.example?credential=secret" })).toThrow(/invalid/u);
  });
});
