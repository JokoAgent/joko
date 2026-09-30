import { describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryController } from "./mobile-voice-dictionary-controller";
import { EMPTY_MOBILE_VOICE_DICTIONARY } from "./mobile-voice-dictionary";
import type { MobileVoiceDictionarySnapshot, MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";
import { dictionaryWatchFixture, idleDictionaryWatch } from "./test/voice-dictionary-watch";

function fixture(ownerKey = "node-a") {
  let current = true;
  let snapshot: MobileVoiceDictionarySnapshot = { revision: 1n, syncEnabled: false, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] };
  const commit = vi.fn(async () => (snapshot = { ...snapshot, revision: snapshot.revision + 1n }));
  const transport: MobileVoiceDictionaryTransport = {
    ownerKey, isCurrent: () => current,
    watchVoiceInputDictionary: vi.fn(idleDictionaryWatch),
    watchVoiceInputDictionaryPeerStatus: vi.fn(idleDictionaryWatch),
    getVoiceInputDictionaryPeerStatus: vi.fn(async () => { throw new Error("Sharing is not part of this dictionary-content fixture."); }),
    grantVoiceInputDictionaryPeer: vi.fn(async () => { throw new Error("Sharing is not part of this dictionary-content fixture."); }),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => { throw new Error("Sharing is not part of this dictionary-content fixture."); }),
    syncVoiceInputDictionaryNow: vi.fn(async () => { throw new Error("Sharing is not part of this dictionary-content fixture."); }),
    getVoiceInputDictionary: vi.fn(async () => snapshot),
    setVoiceInputDictionarySyncEnabled: commit, addVoiceInputDictionaryTerms: commit,
    editVoiceInputDictionaryEntry: commit, deleteVoiceInputDictionaryEntry: commit, applyVoiceInputDictionaryLearning: commit
  };
  const history = vi.fn(async () => undefined);
  const controller = new MobileVoiceDictionaryController({ recordDictionaryChange: history });
  return { controller, transport, commit, history, retire: () => { current = false; }, setSnapshot: (value: MobileVoiceDictionarySnapshot) => { snapshot = value; } };
}

describe("mobile node dictionary projection owner", () => {
  it("adopts live snapshots without rolling back to late RPCs, and keeps a disconnected projection readonly until explicit reconnect", async () => {
    const f = fixture();
    const updates = dictionaryWatchFixture<MobileVoiceDictionarySnapshot>();
    vi.mocked(f.transport.watchVoiceInputDictionary).mockImplementation(updates.watch);
    f.controller.setTransport(f.transport);
    await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("ready"));
    let finish!: (value: MobileVoiceDictionarySnapshot) => void;
    f.commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.controller.addTerm("Added");
    updates.push({ ...f.controller.snapshot.snapshot!, revision: 5n });
    await vi.waitFor(() => expect(f.controller.snapshot).toMatchObject({ saving: true, snapshot: { revision: 5n } }));
    finish({ ...f.controller.snapshot.snapshot!, revision: 3n });
    await pending;
    expect(f.controller.snapshot).toMatchObject({ status: "ready", saving: false, snapshot: { revision: 5n } });
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(1n, ["Added"], expect.any(AbortSignal));
    updates.end();
    await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("error"));
    await expect(f.controller.addTerm("MustNotDispatch")).rejects.toThrow(/unavailable/u);
    f.setSnapshot({ ...f.controller.snapshot.snapshot!, revision: 4n });
    await f.controller.refresh();
    expect(f.controller.snapshot).toMatchObject({ status: "error", snapshot: { revision: 5n } });
    updates.push({ ...f.controller.snapshot.snapshot!, revision: 7n });
    await vi.waitFor(() => expect(f.controller.snapshot).toMatchObject({ status: "ready", snapshot: { revision: 7n } }));
    const other = fixture("node-b");
    f.controller.setTransport(other.transport);
    await vi.waitFor(() => expect(updates.count).toBe(0));
    expect(vi.mocked(f.transport.watchVoiceInputDictionary).mock.calls[1]![0].aborted).toBe(true);
    updates.push({ ...f.controller.snapshot.snapshot!, revision: 99n });
    await vi.waitFor(() => expect(f.controller.snapshot.ownerKey).toBe("node-b"));
    expect(f.controller.snapshot.snapshot?.revision).toBe(1n);
    f.controller.setTransport(undefined);
  });
  it("waits for a service commit, rejects duplicate dispatch and never replays for failed private history", async () => {
    const f = fixture();
    f.controller.setTransport(f.transport);
    await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("ready"));
    let finish!: (value: MobileVoiceDictionarySnapshot) => void;
    f.commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.history.mockRejectedValueOnce(new Error("local disk unavailable"));
    const pending = f.controller.addTerm(" Word ");
    expect(f.controller.snapshot).toMatchObject({ saving: true, snapshot: { revision: 1n } });
    await expect(f.controller.addTerm("Duplicate")).rejects.toThrow(/busy/u);
    finish({ ...f.controller.snapshot.snapshot!, revision: 2n });
    await expect(pending).resolves.toBeUndefined();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledWith(1n, ["Word"], expect.any(AbortSignal));
    expect(f.controller.snapshot).toMatchObject({ saving: false, snapshot: { revision: 2n } });
    expect(f.history).toHaveBeenCalledWith("manualAdd", ["Word"], expect.any(Function));
  });

  it("refreshes a conflicting revision but never rebases the submitted editor intent", async () => {
    const f = fixture();
    f.controller.setTransport(f.transport);
    await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("ready"));
    const latest = { ...f.controller.snapshot.snapshot!, revision: 3n };
    f.setSnapshot(latest);
    f.commit.mockRejectedValueOnce(new Error("revision conflict"));
    await expect(f.controller.editEntry("entry", "New", "old\nold\nNew", 1n)).rejects.toThrow(/conflict/u);
    expect(f.commit).toHaveBeenCalledWith(1n, "entry", "New", ["old"], expect.any(AbortSignal));
    expect(f.controller.snapshot.snapshot).toBe(latest);
    expect(f.history).not.toHaveBeenCalled();
  });

  it("does not adopt a late mutation across owner replacement and clears unavailable projections", async () => {
    const f = fixture();
    f.controller.setTransport(f.transport);
    await vi.waitFor(() => expect(f.controller.snapshot.status).toBe("ready"));
    let finish!: (value: MobileVoiceDictionarySnapshot) => void;
    f.commit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.controller.addTerm("Old");
    const rejected = expect(pending).rejects.toThrow(/owner/u);
    const other = fixture("node-b");
    f.retire();
    f.controller.setTransport(other.transport);
    await vi.waitFor(() => expect(f.controller.snapshot.ownerKey).toBe("node-b"));
    finish({ revision: 99n, syncEnabled: true, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] });
    await rejected;
    expect(f.controller.snapshot.snapshot?.revision).toBe(1n);
    expect(f.history).not.toHaveBeenCalled();
    f.controller.setTransport(undefined);
    expect(f.controller.snapshot).toEqual({ status: "unavailable", saving: false });
  });
});
