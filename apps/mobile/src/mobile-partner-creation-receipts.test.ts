import { describe, expect, it, vi } from "vitest";
import { MobilePartnerCreationReceipts, type MobilePartnerCreationScope } from "./mobile-partner-creation-receipts";

const scope: MobilePartnerCreationScope = { profileId: "profile", serverId: "server", deviceId: "phone", origin: "https://node.example" };
const first = "creation-request-receipt-first"; const second = "creation-request-receipt-second";
const signal = () => new AbortController().signal;
function storage() {
  const data = new Map<string, string>();
  const driver = { getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { data.delete(key); }) };
  return { data, driver, receipts: new MobilePartnerCreationReceipts(driver) };
}

describe("Partner creation receipts", () => {
  it("persists only opaque identity, reloads it and isolates node, profile, device and origin", async () => {
    const { data, driver, receipts } = storage(); await receipts.claim(scope, first, signal());
    expect([...data.values()]).toEqual([first]); const reloaded = new MobilePartnerCreationReceipts(driver);
    expect(await reloaded.load(scope, signal())).toBe(first);
    for (const changed of [{ ...scope, profileId: "different" }, { ...scope, serverId: "different" },
      { ...scope, deviceId: "different" }, { ...scope, origin: "https://different.example" }]) {
      expect(await reloaded.load(changed, signal())).toBeUndefined();
    }
    await expect(reloaded.resolve(scope, second, signal())).rejects.toThrow(/changed/u);
    expect(await reloaded.load(scope, signal())).toBe(first);
    await reloaded.resolve(scope, first, signal()); await reloaded.resolve(scope, first, signal());
    expect(data.size).toBe(0);
  });

  it("serializes claims, rejects damaged data and never overwrites a retained intent", async () => {
    const { data, receipts } = storage();
    const results = await Promise.allSettled([receipts.claim(scope, first, signal()), receipts.claim(scope, second, signal())]);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    data.set([...data.keys()][0]!, JSON.stringify({ requestId: first, draft: "not an accepted shape" }));
    await expect(receipts.load(scope, signal())).rejects.toThrow(/recovery/u);
    await expect(receipts.claim(scope, second, signal())).rejects.toThrow(/retained/u);
  });

  it("fails before a claim is confirmed when persistence fails or the caller retires, retaining committed identity", async () => {
    const { driver, receipts } = storage(); driver.setItem.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(receipts.claim(scope, first, signal())).rejects.toThrow(/unavailable/u);
    const abort = new AbortController(); const set = driver.setItem.getMockImplementation()!;
    driver.setItem.mockImplementationOnce(async (key, value) => { await set(key, value); abort.abort(); });
    await expect(receipts.claim(scope, first, abort.signal)).rejects.toThrow();
    expect(await new MobilePartnerCreationReceipts(driver).load(scope, signal())).toBe(first);
  });
});
