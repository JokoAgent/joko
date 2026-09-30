import type { VoiceDictionaryPeerStatusView } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryPeerController } from "./mobile-voice-dictionary-peer-controller";
import type { MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";

const fingerprint = "b".repeat(64);
function status(configurationRevision = 3n): VoiceDictionaryPeerStatusView {
  return { available: true, configurationRevision, nodeId: "node-a", fingerprint: "a".repeat(64), enabled: true,
    phase: "waiting", peers: [], candidates: [{ nodeId: "node-b", displayName: "Office", fingerprint,
      seenAt: 1_000, granted: false, keyChanged: false }] };
}
function transport(ownerKey: string): MobileVoiceDictionaryTransport {
  const unrelated = async () => { throw new Error("Dictionary content is not owned by this fixture."); };
  return { ownerKey, isCurrent: () => true,
    getVoiceInputDictionary: unrelated, setVoiceInputDictionarySyncEnabled: unrelated, addVoiceInputDictionaryTerms: unrelated,
    editVoiceInputDictionaryEntry: unrelated, deleteVoiceInputDictionaryEntry: unrelated, applyVoiceInputDictionaryLearning: unrelated,
    getVoiceInputDictionaryPeerStatus: vi.fn(async () => status()),
    grantVoiceInputDictionaryPeer: vi.fn(async () => status(4n)),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => status(5n)),
    syncVoiceInputDictionaryNow: vi.fn(async () => status()) };
}

describe("native dictionary sharing authority", () => {
  it("keeps a single frozen mutation and does not replay it after refreshing a conflict", async () => {
    const controller = new MobileVoiceDictionaryPeerController();
    const api = transport("owner-a");
    controller.setTransport(api);
    await vi.waitFor(() => expect(controller.snapshot.status).toBe("ready"));
    let fail!: (error: Error) => void;
    vi.mocked(api.grantVoiceInputDictionaryPeer).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.mocked(api.getVoiceInputDictionaryPeerStatus).mockResolvedValue(status(4n));
    const pending = controller.grant("owner-a", 3n, "node-b", fingerprint);
    await expect(controller.grant("owner-a", 3n, "node-b", fingerprint)).rejects.toThrow(/unavailable/u);
    expect(api.grantVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith(3n, "node-b", fingerprint, expect.any(AbortSignal));
    fail(new Error("revision conflict"));
    await expect(pending).rejects.toThrow("revision conflict");
    expect(controller.snapshot).toMatchObject({ status: "ready", busy: false, value: { configurationRevision: 4n } });
    expect(api.getVoiceInputDictionaryPeerStatus).toHaveBeenCalledTimes(2);
    expect(api.grantVoiceInputDictionaryPeer).toHaveBeenCalledOnce();
    controller.setTransport(undefined);
  });

  it("retires a pending grant and rejects an old confirmation without borrowing the new owner", async () => {
    const controller = new MobileVoiceDictionaryPeerController();
    const old = transport("owner-a");
    controller.setTransport(old);
    await vi.waitFor(() => expect(controller.snapshot.status).toBe("ready"));
    let finish!: (value: VoiceDictionaryPeerStatusView) => void;
    vi.mocked(old.grantVoiceInputDictionaryPeer).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = controller.grant("owner-a", 3n, "node-b", fingerprint);
    const next = transport("owner-b");
    controller.setTransport(next);
    await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ status: "ready", ownerKey: "owner-b" }));
    expect(vi.mocked(old.grantVoiceInputDictionaryPeer).mock.calls[0]![3]!.aborted).toBe(true);
    finish(status(10n));
    await expect(pending).rejects.toThrow(/authority changed/u);
    await expect(controller.revoke("owner-a", "node-b", 3n)).rejects.toThrow(/owner changed/u);
    expect(next.revokeVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    expect(controller.snapshot.value?.configurationRevision).toBe(3n);
    controller.setTransport(undefined);
  });

  it("discards a late read on background retirement and preserves only the current node projection", async () => {
    const controller = new MobileVoiceDictionaryPeerController();
    const api = transport("owner-a");
    let finish!: (value: VoiceDictionaryPeerStatusView) => void;
    vi.mocked(api.getVoiceInputDictionaryPeerStatus).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    controller.setTransport(api);
    controller.setTransport(undefined);
    finish(status());
    await Promise.resolve();
    expect(controller.snapshot).toEqual({ status: "unavailable", busy: false });
    controller.setTransport(api);
    await vi.waitFor(() => expect(controller.snapshot.status).toBe("ready"));
    await controller.syncNow("owner-a", 3n);
    expect(api.syncVoiceInputDictionaryNow).toHaveBeenCalledExactlyOnceWith(3n, undefined, expect.any(AbortSignal));
    controller.setTransport(undefined);
  });
});
