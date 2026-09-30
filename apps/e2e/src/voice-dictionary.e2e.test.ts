import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  AddVoiceInputDictionaryTermsRequestSchema,
  DeviceKind,
  ApplyVoiceInputDictionaryLearningRequestSchema,
  EditVoiceInputDictionaryEntryRequestSchema,
  GetVoiceInputDictionaryRequestSchema,
  GetVoiceInputDictionaryPeerStatusRequestSchema,
  GrantVoiceInputDictionaryPeerRequestSchema,
  SyncVoiceInputDictionaryNowRequestSchema,
  SetVoiceInputDictionarySyncEnabledRequestSchema,
  VoiceInputDictionaryLearningActionType
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

describe("durable voice dictionary through authenticated generated RPCs", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let peerFixture: OrchestratorE2eFixture | undefined;
  afterEach(async () => {
    await peerFixture?.close({ removeRoot: true }); peerFixture = undefined;
    await fixture?.close({ removeRoot: true }); fixture = undefined;
  });

  it("shares one service revision between clients, rejects late learning and restores the same projection after restart", async () => {
    fixture = await OrchestratorE2eFixture.start({ keepRoot: true });
    const request = create(GetVoiceInputDictionaryRequestSchema);
    await expect(fixture.anonymous.voiceInput.getVoiceInputDictionary(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(fixture.anonymous.voiceInput.addVoiceInputDictionaryTerms(create(AddVoiceInputDictionaryTermsRequestSchema, {
      expectedRevision: 1n, terms: ["UnpairedTerm"]
    }))).rejects.toMatchObject({ code: Code.Unauthenticated });
    const first = await fixture.pair("Dictionary editor");
    const second = await fixture.pair("Dictionary learner");
    const editor = first.clients.voiceInput;
    const learner = second.clients.voiceInput;
    const initial = (await editor.getVoiceInputDictionary(request)).dictionary!;
    expect(initial.entries).toEqual([]);
    const imported = (await editor.addVoiceInputDictionaryTerms(create(AddVoiceInputDictionaryTermsRequestSchema, {
      expectedRevision: initial.revision, terms: ["Joko", "Orchestrator", "joko"]
    }))).dictionary!;
    const learningBasis = (await learner.getVoiceInputDictionary(request)).dictionary!;
    expect(learningBasis).toEqual(imported);
    const entry = imported.entries.find((value) => value.text === "Joko")!;
    const edited = (await editor.editVoiceInputDictionaryEntry(create(EditVoiceInputDictionaryEntryRequestSchema, {
      expectedRevision: imported.revision, entryId: entry.entryId, text: "Joko Core", aliases: ["jo ko"]
    }))).dictionary!;
    await expect(learner.applyVoiceInputDictionaryLearning(create(ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: learningBasis.revision,
      actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_ENTRY, term: "LateTerm", aliases: ["late term"] }]
    }))).rejects.toMatchObject({ code: Code.Aborted });
    expect((await learner.getVoiceInputDictionary(request)).dictionary).toEqual(edited);
    const enabled = (await editor.setVoiceInputDictionarySyncEnabled(create(SetVoiceInputDictionarySyncEnabledRequestSchema, {
      expectedRevision: edited.revision, enabled: true
    }))).dictionary!;
    const committed = (await learner.applyVoiceInputDictionaryLearning(create(ApplyVoiceInputDictionaryLearningRequestSchema, {
      expectedRevision: enabled.revision,
      actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE, term: "VoiceKit", aliases: ["voice kit"] }]
    }))).dictionary!;
    expect(committed.refinementTerms).toEqual(expect.arrayContaining(["Joko Core", "Orchestrator"]));
    expect(committed.candidates).toMatchObject([{ text: "VoiceKit", evidenceCount: 1n }]);
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const restored = fixture.clients(first.authKey).voiceInput;
    expect((await restored.getVoiceInputDictionary(request)).dictionary).toEqual(committed);
    await expect(restored.editVoiceInputDictionaryEntry(create(EditVoiceInputDictionaryEntryRequestSchema, {
      expectedRevision: committed.revision,
      entryId: committed.entries.find((value) => value.text === "Joko Core")!.entryId,
      text: "Joko Core", aliases: []
    }))).resolves.toMatchObject({ dictionary: { revision: committed.revision + 1n, syncEnabled: true } });
  });

  it("uses the production MobileNetwork projection through real HTTP and restores node data without a local dictionary", async () => {
    // Load the portable production gateway at runtime, not a second wire mapper.
    const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
    const { MobileVoiceDictionaryController } = await import(new URL("../../mobile/src/mobile-voice-dictionary-controller.ts", import.meta.url).href);
    const { MobileVoicePreferencesStore } = await import(new URL("../../mobile/src/mobile-voice-preferences-store.ts", import.meta.url).href);
    fixture = await OrchestratorE2eFixture.start({ keepRoot: true });
    const begun = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Dictionary phone", deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0" });
    const challengeId = begun.challenge!.challengeId;
    const paired = (await fixture.anonymous.connection.completePairing({ challengeId, humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Dictionary phone", deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0" })).result!;
    const identity = await mobileNetwork.inspect(fixture.baseUrl);
    const credential = { profileId: "dictionary-phone", origin: fixture.baseUrl, serverId: identity.serverId,
      connectionId: paired.connection!.connectionId, deviceId: paired.device!.deviceId, displayName: "Dictionary phone", authKey: paired.authKey };
    let privateData: string | null = null;
    const preferences = new MobileVoicePreferencesStore({ getItem: async () => privateData,
      setItem: async (_key: string, value: string) => { privateData = value; } }, () => 1_900_000_000_000, () => "history");
    await preferences.hydrate();
    await preferences.setRefinementInstructions("Preserve commands.");
    const controller = new MobileVoiceDictionaryController(preferences);
    controller.setTransport({ ownerKey: "phone-node", isCurrent: () => true,
      getVoiceInputDictionary: () => mobileNetwork.getVoiceInputDictionary(credential),
      setVoiceInputDictionarySyncEnabled: (revision: bigint, enabled: boolean) => mobileNetwork.setVoiceInputDictionarySyncEnabled(credential, revision, enabled),
      addVoiceInputDictionaryTerms: (revision: bigint, terms: readonly string[]) => mobileNetwork.addVoiceInputDictionaryTerms(credential, revision, terms),
      editVoiceInputDictionaryEntry: (revision: bigint, id: string, text: string, aliases: readonly string[]) => mobileNetwork.editVoiceInputDictionaryEntry(credential, revision, id, text, aliases),
      deleteVoiceInputDictionaryEntry: (revision: bigint, id: string) => mobileNetwork.deleteVoiceInputDictionaryEntry(credential, revision, id),
      applyVoiceInputDictionaryLearning: () => { throw new Error("Learning belongs to the voice owner."); },
      getVoiceInputDictionaryPeerStatus: (signal?: AbortSignal) => mobileNetwork.getVoiceInputDictionaryPeerStatus(credential, signal),
      grantVoiceInputDictionaryPeer: (revision: bigint, id: string, fingerprint: string, signal?: AbortSignal) => mobileNetwork.grantVoiceInputDictionaryPeer(credential, revision, id, fingerprint, signal),
      revokeVoiceInputDictionaryPeer: (id: string, revision: bigint, signal?: AbortSignal) => mobileNetwork.revokeVoiceInputDictionaryPeer(credential, id, revision, signal),
      syncVoiceInputDictionaryNow: (revision: bigint, id?: string, signal?: AbortSignal) => mobileNetwork.syncVoiceInputDictionaryNow(credential, revision, id, signal)
    });
    await controller.refresh();
    await controller.addTerm("VoiceKit");
    const before = controller.snapshot.snapshot;
    expect(before.dictionary.entries).toMatchObject([{ text: "VoiceKit", source: "manual" }]);
    await controller.editEntry(before.dictionary.entries[0].id, "VoiceKit Core", "voice kit", before.revision);
    const committed = controller.snapshot.snapshot;
    expect(JSON.parse(privateData!)).not.toHaveProperty("dictionary");
    expect(preferences.snapshot.document.history).toMatchObject([{ kind: "manualAdd" }, { kind: "manualEdit" }]);
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const restored = await mobileNetwork.getVoiceInputDictionary({ ...credential, origin: fixture.baseUrl });
    expect(restored).toEqual(committed);
    await expect(mobileNetwork.deleteVoiceInputDictionaryEntry({ ...credential, origin: fixture.baseUrl }, before.revision,
      committed.dictionary.entries[0].id)).rejects.toMatchObject({ code: Code.Aborted });
    expect(await mobileNetwork.getVoiceInputDictionary({ ...credential, origin: fixture.baseUrl })).toEqual(committed);
    controller.setTransport(undefined);
  });

  it("requires bilateral fingerprint grants through real HTTP and restores sharing authority without changing node identity", async () => {
    const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
    fixture = await OrchestratorE2eFixture.start({ dictionaryPeerNodeId: "e2e-dictionary-first", keepRoot: true });
    peerFixture = await OrchestratorE2eFixture.start({ dictionaryPeerNodeId: "e2e-dictionary-second", keepRoot: true });
    const statusRequest = create(GetVoiceInputDictionaryPeerStatusRequestSchema);
    await expect(fixture.anonymous.voiceInput.getVoiceInputDictionaryPeerStatus(statusRequest)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const firstPair = await fixture.pair("Sharing editor");
    const secondPair = await peerFixture.pair("Sharing phone");
    const first = firstPair.clients.voiceInput;
    const credential = { profileId: "sharing-phone", origin: peerFixture.baseUrl, serverId: peerFixture.application.serverId,
      connectionId: secondPair.connectionId, deviceId: secondPair.deviceId, displayName: "Sharing phone", authKey: secondPair.authKey };
    const dictionaryRequest = create(GetVoiceInputDictionaryRequestSchema);
    for (const [api, term] of [[first, "OfficeTerm"], [secondPair.clients.voiceInput, "PhoneTerm"]] as const) {
      const initial = (await api.getVoiceInputDictionary(dictionaryRequest)).dictionary!;
      const added = (await api.addVoiceInputDictionaryTerms({ expectedRevision: initial.revision, terms: [term] })).dictionary!;
      await api.setVoiceInputDictionarySyncEnabled({ expectedRevision: added.revision, enabled: true });
    }
    await vi.waitFor(async () => {
      const a = (await first.getVoiceInputDictionaryPeerStatus(statusRequest)).status!;
      const b = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credential);
      expect(a.candidates.some((candidate) => candidate.nodeId === credential.serverId)).toBe(true);
      expect(b.candidates.some((candidate: { nodeId: string }) => candidate.nodeId === fixture!.application.serverId)).toBe(true);
    }, { timeout: 8_000, interval: 100 });
    const a = (await first.getVoiceInputDictionaryPeerStatus(statusRequest)).status!;
    const b = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credential);
    await expect(first.grantVoiceInputDictionaryPeer(create(GrantVoiceInputDictionaryPeerRequestSchema, {
      expectedConfigurationRevision: a.configurationRevision, peerId: b.nodeId, expectedFingerprint: "0".repeat(64)
    }))).rejects.toMatchObject({ code: Code.Aborted });
    const grantedA = (await first.grantVoiceInputDictionaryPeer({ expectedConfigurationRevision: a.configurationRevision,
      peerId: b.nodeId, expectedFingerprint: b.fingerprint })).status!;
    await expect(first.syncVoiceInputDictionaryNow(create(SyncVoiceInputDictionaryNowRequestSchema, {
      expectedConfigurationRevision: grantedA.configurationRevision, peerId: b.nodeId
    }))).rejects.toMatchObject({ code: Code.Unavailable });
    expect((await mobileNetwork.getVoiceInputDictionary(credential)).dictionary.entries.map((entry: { text: string }) => entry.text)).toEqual(["PhoneTerm"]);
    const grantedB = await mobileNetwork.grantVoiceInputDictionaryPeer(credential, b.configurationRevision, a.nodeId, a.fingerprint);
    await vi.waitFor(async () => {
      expect((await first.getVoiceInputDictionary(dictionaryRequest)).dictionary!.refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
      expect((await mobileNetwork.getVoiceInputDictionary(credential)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    }, { timeout: 8_000, interval: 100 });
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(credential, b.configurationRevision, undefined)).rejects.toMatchObject({ code: Code.Aborted });
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(credential, grantedB.configurationRevision, undefined)).resolves.toMatchObject({
      fingerprint: b.fingerprint, peers: [{ fingerprint: a.fingerprint }]
    });
    const rootDirectory = peerFixture.rootDirectory;
    await peerFixture.close({ removeRoot: false });
    peerFixture = await OrchestratorE2eFixture.start({ rootDirectory, dictionaryPeerNodeId: "e2e-dictionary-second" });
    const restoredCredential = { ...credential, origin: peerFixture.baseUrl };
    const restored = await mobileNetwork.getVoiceInputDictionaryPeerStatus(restoredCredential);
    expect(restored).toMatchObject({ nodeId: b.nodeId, fingerprint: b.fingerprint,
      configurationRevision: grantedB.configurationRevision, enabled: true,
      peers: [{ peerId: a.nodeId, revision: grantedB.peers[0].revision, fingerprint: a.fingerprint }] });
    expect((await mobileNetwork.getVoiceInputDictionary(restoredCredential)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    await expect(mobileNetwork.revokeVoiceInputDictionaryPeer(restoredCredential, a.nodeId, restored.peers[0].revision + 1n)).rejects.toMatchObject({ code: Code.Aborted });
    const revoked = await mobileNetwork.revokeVoiceInputDictionaryPeer(restoredCredential, a.nodeId, restored.peers[0].revision);
    expect(revoked.peers).toEqual([]);
    expect(revoked.configurationRevision).toBe(restored.configurationRevision + 1n);
    expect((await mobileNetwork.getVoiceInputDictionary(restoredCredential)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(restoredCredential, revoked.configurationRevision, a.nodeId)).rejects.toMatchObject({ code: Code.Unavailable });
  }, 40_000);
});
