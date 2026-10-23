import { expect, it } from "vitest";
import { MobileNewTaskModelMemory } from "./mobile-new-task-model-memory";

const identity = { profileId: "saved", serverId: "node", nativeAdapterKind: "native" };
const selection = { backendId: "opaque-source", providerId: "account", modelId: "model", effortId: "high", fastMode: true };
it("restores one exact node/runtime source and partitions same-name models on other nodes", async () => {
  const values = new Map<string, string>(); const driver = { getItem: async (id: string) => values.get(id) ?? null,
    setItem: async (id: string, value: string) => { values.set(id, value); }, removeItem: async (id: string) => { values.delete(id); } };
  await new MobileNewTaskModelMemory(driver).save(identity, selection);
  const restarted = new MobileNewTaskModelMemory(driver);
  expect(await restarted.read(identity)).toEqual(selection);
  expect(await restarted.read({ ...identity, serverId: "other" })).toBeUndefined();
  expect(await restarted.read({ ...identity, nativeAdapterKind: "other" })).toBeUndefined();
});
it("keeps the first manual choice when an older defaults read finishes afterwards, and never claims a failed write", async () => {
  let finish!: (value: string) => void;
  const memory = new MobileNewTaskModelMemory({ getItem: () => new Promise<string>(resolve => { finish = resolve; }),
    setItem: async () => undefined, removeItem: async () => undefined });
  const reading = memory.read(identity); await memory.save(identity, selection);
  finish(JSON.stringify({ ...selection, modelId: "stale-default" })); expect(await reading).toEqual(selection);
  const failing = new MobileNewTaskModelMemory({ getItem: async () => null, setItem: async () => { throw new Error("offline storage"); }, removeItem: async () => undefined });
  await expect(failing.save(identity, selection)).rejects.toThrow("offline storage"); expect(failing.current(identity)).toBeUndefined();
});
