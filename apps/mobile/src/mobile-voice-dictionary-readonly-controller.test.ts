import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictionaryReadOnlyView } from "@joko/contracts";
import { MobileVoiceDictionaryReadOnlyController } from "./mobile-voice-dictionary-readonly-controller";
import { dictionaryWatchFixture } from "./test/voice-dictionary-watch";
import { dictionaryStamp, memoryReadOnlyCache, readOnlyProfile, readOnlyValue } from "./test/voice-dictionary-readonly";

const controllers: MobileVoiceDictionaryReadOnlyController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.setVisible(false); });

describe("readonly multi-node native composition", () => {
  it("keeps a newer disabled push ahead of a late GET, surfaces stream failure and reconnects only explicitly", async () => {
    const { cache } = memoryReadOnlyCache(); const profile = readOnlyProfile(); const updates = dictionaryWatchFixture<VoiceDictionaryReadOnlyView>();
    let finish!: (value: VoiceDictionaryReadOnlyView) => void;
    const get = vi.fn(async () => await new Promise<VoiceDictionaryReadOnlyView>((resolve) => { finish = resolve; }));
    const connect = vi.fn(async (_id: string, signal: AbortSignal) => ({ profile, ownerKey: "original", isCurrent: () => !signal.aborted,
      getVoiceInputDictionaryReadOnly: get, watchVoiceInputDictionaryReadOnly: updates.watch }));
    const controller = new MobileVoiceDictionaryReadOnlyController(cache, connect); controllers.push(controller);
    controller.setSources([profile]); controller.setVisible(true);
    await vi.waitFor(() => expect(updates.count).toBe(1));
    const off = readOnlyValue(3n, { syncEnabled: false, entries: [] }); updates.push(off);
    await vi.waitFor(() => expect(controller.state.selected?.snapshot).toEqual(off));
    finish(readOnlyValue()); await vi.waitFor(() => expect(controller.state.refreshing).toBe(false));
    expect(controller.state.selected?.snapshot).toEqual(off);
    updates.end(); await vi.waitFor(() => expect(controller.state.hosts[0]?.status).toBe("error"));
    expect(controller.state.selected?.snapshot).toEqual(off); expect(connect).toHaveBeenCalledOnce();
    get.mockImplementation(async () => readOnlyValue(4n)); await controller.refresh();
    expect(connect).toHaveBeenCalledTimes(2); expect(controller.state.selected?.snapshot.revision).toBe(4n);
    expect(updates.count).toBe(1);
    controller.setVisible(false); expect(updates.count).toBe(0); expect(controller.state.selected).toBeUndefined();
  });

  it("hydrates multiple offline sources after process recreation and selects the vector containing a deletion", async () => {
    const { cache, storage } = memoryReadOnlyCache(); const a = readOnlyProfile(); const b = readOnlyProfile("b");
    await cache.apply(a, readOnlyValue(), cache.lease(a));
    await cache.apply(b, readOnlyValue(1n, { entries: [], stateVector: { "node-a": dictionaryStamp(2) } }), cache.lease(b));
    const { MobileVoiceDictionaryReadOnlyCache } = await import("./mobile-voice-dictionary-readonly-cache");
    const controller = new MobileVoiceDictionaryReadOnlyController(new MobileVoiceDictionaryReadOnlyCache(storage), async () => { throw new Error("Offline"); });
    controllers.push(controller); controller.setSources([]); controller.setVisible(true); controller.setSources([a, b]);
    await vi.waitFor(() => expect(controller.state.refreshing).toBe(false));
    expect(controller.state.hosts.map((host) => host.status)).toEqual(["offline", "offline"]);
    expect(controller.state.selected?.profile.profileId).toBe(b.profileId); expect(controller.state.selected?.snapshot.entries).toEqual([]);
    controller.setSources([a]); expect(controller.state.selected?.profile.profileId).toBe(a.profileId);
  });

  it("retires old page/source requests and cache leases without adopting a late owner after a switch", async () => {
    const { cache } = memoryReadOnlyCache(); const a = readOnlyProfile(); const b = readOnlyProfile("b");
    let finish!: (value: VoiceDictionaryReadOnlyView) => void;
    const updates = dictionaryWatchFixture<VoiceDictionaryReadOnlyView>();
    const signals: AbortSignal[] = [];
    const controller = new MobileVoiceDictionaryReadOnlyController(cache, async (id, signal) => {
      signals.push(signal); const profile = id === a.profileId ? a : b;
      return { profile, ownerKey: id, isCurrent: () => !signal.aborted,
        getVoiceInputDictionaryReadOnly: async () => id === a.profileId
          ? await new Promise<VoiceDictionaryReadOnlyView>((resolve) => { finish = resolve; }) : readOnlyValue(8n),
        watchVoiceInputDictionaryReadOnly: updates.watch };
    });
    controllers.push(controller); controller.setSources([a]); controller.setVisible(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.setSources([b]); expect(signals[0]!.aborted).toBe(true);
    finish(readOnlyValue(99n)); await vi.waitFor(() => expect(controller.state.selected?.snapshot.revision).toBe(8n));
    expect(cache.read(a)).toBeUndefined();
    controller.setVisible(false); expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(updates.count).toBe(0); expect(controller.state.selected).toBeUndefined();
  });
});
