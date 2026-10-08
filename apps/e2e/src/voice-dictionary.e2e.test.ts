import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningActionType,
  projectVoiceDictionaryReadOnly,
  readVoiceDictionaryPeerInvitation,
  type VoiceDictionaryPeerStatusView,
  type VoiceDictionaryReadOnlyView
} from "@joko/contracts";
import { createOrchestratorApplication, createPublicServer, type OrchestratorApplication, type OrchestratorConfig } from "@joko/orchestrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createE2eClients, type E2eClients, type PairedClient } from "./connect-clients.js";
import { OrchestratorE2eFixture } from "./fixture.js";

describe("durable voice dictionary through authenticated generated RPCs", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let peerFixture: OrchestratorE2eFixture | undefined;
  const streamCleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of streamCleanups.splice(0).reverse()) await close();
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
    const begun = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Dictionary phone", deviceKind: DeviceKind.MOBILE, deviceNameSource: { defaultDisplayName: "Fixture phone" }, platform: "android", appVersion: "0.1.0" });
    const challengeId = begun.challenge!.challengeId;
    const paired = (await fixture.anonymous.connection.completePairing({ challengeId, humanCode: fixture.pairingCode(challengeId),
      deviceDisplayName: "Dictionary phone", deviceKind: DeviceKind.MOBILE, deviceNameSource: { defaultDisplayName: "Fixture phone" }, platform: "android", appVersion: "0.1.0" })).result!;
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
      watchVoiceInputDictionary: (signal: AbortSignal) => mobileNetwork.watchVoiceInputDictionary(credential, signal),
      setVoiceInputDictionarySyncEnabled: (revision: bigint, enabled: boolean) => mobileNetwork.setVoiceInputDictionarySyncEnabled(credential, revision, enabled),
      addVoiceInputDictionaryTerms: (revision: bigint, terms: readonly string[]) => mobileNetwork.addVoiceInputDictionaryTerms(credential, revision, terms),
      editVoiceInputDictionaryEntry: (revision: bigint, id: string, text: string, aliases: readonly string[]) => mobileNetwork.editVoiceInputDictionaryEntry(credential, revision, id, text, aliases),
      deleteVoiceInputDictionaryEntry: (revision: bigint, id: string) => mobileNetwork.deleteVoiceInputDictionaryEntry(credential, revision, id),
      applyVoiceInputDictionaryLearning: () => { throw new Error("Learning belongs to the voice owner."); },
      getVoiceInputDictionaryPeerStatus: (signal?: AbortSignal) => mobileNetwork.getVoiceInputDictionaryPeerStatus(credential, signal),
      watchVoiceInputDictionaryPeerStatus: (signal: AbortSignal) => mobileNetwork.watchVoiceInputDictionaryPeerStatus(credential, signal),
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
    controller.setTransport(undefined);
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
    const firstAbort = new AbortController();
    const phoneAbort = new AbortController();
    const firstContent = observedProjection(first.watchVoiceInputDictionary({}, { signal: firstAbort.signal, timeoutMs: 0 }), firstAbort.signal);
    const firstSharing = observedProjection(first.watchVoiceInputDictionaryPeerStatus({}, { signal: firstAbort.signal, timeoutMs: 0 }), firstAbort.signal);
    let phoneContent = observedProjection<{ readonly refinementTerms: readonly string[] }>(mobileNetwork.watchVoiceInputDictionary(credential, phoneAbort.signal), phoneAbort.signal);
    let phoneSharing = observedProjection<Awaited<ReturnType<typeof mobileNetwork.getVoiceInputDictionaryPeerStatus>>>(mobileNetwork.watchVoiceInputDictionaryPeerStatus(credential, phoneAbort.signal), phoneAbort.signal);
    let currentPhoneAbort = phoneAbort;
    streamCleanups.push(async () => {
      firstAbort.abort(); currentPhoneAbort.abort();
      await Promise.all([firstContent.done, firstSharing.done, phoneContent.done, phoneSharing.done]);
    });
    await vi.waitFor(() => {
      expect(firstContent.first?.sequence).toBe(1n); expect(firstSharing.first?.sequence).toBe(1n);
      expect(phoneContent.latest?.refinementTerms).toEqual(["PhoneTerm"]);
      expect(phoneSharing.latest?.nodeId).toBe(credential.serverId);
    });
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
      expect(firstContent.error).toBeUndefined(); expect(phoneContent.error).toBeUndefined();
      expect(firstSharing.error).toBeUndefined(); expect(phoneSharing.error).toBeUndefined();
      const current = (await first.getVoiceInputDictionary(dictionaryRequest)).dictionary!;
      expect(firstContent.latest?.dictionary?.revision).toBe(current.revision);
      expect(firstContent.latest?.dictionary?.refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
      expect(phoneContent.latest?.refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
      expect(firstSharing.latest?.status?.configurationRevision).toBe(grantedA.configurationRevision);
      expect(phoneSharing.latest?.configurationRevision).toBe(grantedB.configurationRevision);
    }, { timeout: 8_000, interval: 100 });
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(credential, b.configurationRevision, undefined)).rejects.toMatchObject({ code: Code.Aborted });
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(credential, grantedB.configurationRevision, undefined)).resolves.toMatchObject({
      fingerprint: b.fingerprint, peers: [{ fingerprint: a.fingerprint }]
    });
    const rootDirectory = peerFixture.rootDirectory;
    currentPhoneAbort.abort(); await Promise.all([phoneContent.done, phoneSharing.done]);
    await peerFixture.close({ removeRoot: false });
    peerFixture = await OrchestratorE2eFixture.start({ rootDirectory, dictionaryPeerNodeId: "e2e-dictionary-second" });
    const restoredCredential = { ...credential, origin: peerFixture.baseUrl };
    currentPhoneAbort = new AbortController();
    phoneContent = observedProjection(mobileNetwork.watchVoiceInputDictionary(restoredCredential, currentPhoneAbort.signal), currentPhoneAbort.signal);
    phoneSharing = observedProjection(mobileNetwork.watchVoiceInputDictionaryPeerStatus(restoredCredential, currentPhoneAbort.signal), currentPhoneAbort.signal);
    const restored = await mobileNetwork.getVoiceInputDictionaryPeerStatus(restoredCredential);
    expect(restored).toMatchObject({ nodeId: b.nodeId, fingerprint: b.fingerprint,
      configurationRevision: grantedB.configurationRevision, enabled: true,
      peers: [{ peerId: a.nodeId, revision: grantedB.peers[0].revision, fingerprint: a.fingerprint }] });
    expect((await mobileNetwork.getVoiceInputDictionary(restoredCredential)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    await vi.waitFor(() => {
      expect(phoneContent.latest?.refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
      expect(phoneSharing.latest?.configurationRevision).toBe(restored.configurationRevision);
    });
    await expect(mobileNetwork.revokeVoiceInputDictionaryPeer(restoredCredential, a.nodeId, restored.peers[0].revision + 1n)).rejects.toMatchObject({ code: Code.Aborted });
    const revoked = await mobileNetwork.revokeVoiceInputDictionaryPeer(restoredCredential, a.nodeId, restored.peers[0].revision);
    expect(revoked.peers).toEqual([]);
    expect(revoked.configurationRevision).toBe(restored.configurationRevision + 1n);
    expect((await mobileNetwork.getVoiceInputDictionary(restoredCredential)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    await expect(mobileNetwork.syncVoiceInputDictionaryNow(restoredCredential, revoked.configurationRevision, a.nodeId)).rejects.toMatchObject({ code: Code.Unavailable });
    await vi.waitFor(() => expect(phoneSharing.latest).toMatchObject({ configurationRevision: revoked.configurationRevision, peers: [] }));
    peerFixture.application.connections.revoke(secondPair.connectionId);
    await Promise.all([phoneContent.done, phoneSharing.done]);
    expect(phoneContent.error).toBeUndefined(); expect(phoneSharing.error).toBeUndefined();
    await expect(mobileNetwork.getVoiceInputDictionary(restoredCredential)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(firstContent.error).toBeUndefined(); expect(firstSharing.error).toBeUndefined();
  }, 40_000);

  it("uses exact paired multi-node readonly projections through disable, actual offline restart, reconnect and client revocation", async () => {
    const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
    const { MobileClient } = await import(new URL("../../mobile/src/mobile-client.ts", import.meta.url).href);
    const { MobileVoiceDictionaryReadOnlyCache } = await import(new URL("../../mobile/src/mobile-voice-dictionary-readonly-cache.ts", import.meta.url).href);
    const { MobileVoiceDictionaryReadOnlyController } = await import(new URL("../../mobile/src/mobile-voice-dictionary-readonly-controller.ts", import.meta.url).href);
    const { MobileOfflineCache } = await import(new URL("../../mobile/src/mobile-offline-cache.ts", import.meta.url).href);
    const { mobileReadOnlyDictionarySources } = await import(new URL("../../mobile/src/mobile-voice-dictionary-readonly.ts", import.meta.url).href);
    const { profileFromCredential } = await import(new URL("../../mobile/src/connection-storage.ts", import.meta.url).href);
    fixture = await OrchestratorE2eFixture.start({ dictionaryPeerNodeId: "readonly-node-a", keepRoot: true });
    peerFixture = await OrchestratorE2eFixture.start({ dictionaryPeerNodeId: "readonly-node-b", keepRoot: true });
    const originalFetch = globalThis.fetch;
    const streamSignals: Array<{ method: string; signal: AbortSignal }> = [];
    const fetchProbe = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal && (url.endsWith("/StreamEvents") || url.endsWith("/WatchVoiceInputDictionaryReadOnly"))) {
        streamSignals.push({ method: new URL(url).pathname.split("/").at(-1)!, signal });
      }
      return originalFetch(input, init);
    });
    streamCleanups.push(async () => { fetchProbe.mockRestore(); });
    await expect(fixture.anonymous.voiceInput.getVoiceInputDictionaryReadOnly({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    const pairPhone = async (source: OrchestratorE2eFixture) => {
      const deviceNameSource = { defaultDisplayName: "Fixture readonly phone" };
      const begun = await mobileNetwork.requestPairing(source.baseUrl, "Readonly phone", "android", deviceNameSource);
      return (await mobileNetwork.completePairing(source.baseUrl, begun.challengeId, source.pairingCode(begun.challengeId), "Readonly phone", "android", deviceNameSource)).credential;
    };
    const a = await pairPhone(fixture); const b = await pairPhone(peerFixture);
    for (const [credential, terms] of [[a, ["OfficeTerm", "DeleteMe"]], [b, ["PhoneTerm"]]] as const) {
      const initial = await mobileNetwork.getVoiceInputDictionary(credential);
      const added = await mobileNetwork.addVoiceInputDictionaryTerms(credential, initial.revision, terms);
      await mobileNetwork.setVoiceInputDictionarySyncEnabled(credential, added.revision, true);
    }
    await vi.waitFor(async () => {
      expect((await mobileNetwork.getVoiceInputDictionaryPeerStatus(a)).candidates.some((candidate: { nodeId: string }) => candidate.nodeId === b.serverId)).toBe(true);
      expect((await mobileNetwork.getVoiceInputDictionaryPeerStatus(b)).candidates.some((candidate: { nodeId: string }) => candidate.nodeId === a.serverId)).toBe(true);
    }, { timeout: 8_000, interval: 100 });
    const authorityA = await mobileNetwork.getVoiceInputDictionaryPeerStatus(a);
    const authorityB = await mobileNetwork.getVoiceInputDictionaryPeerStatus(b);
    await mobileNetwork.grantVoiceInputDictionaryPeer(a, authorityA.configurationRevision, b.serverId, authorityB.fingerprint);
    await mobileNetwork.grantVoiceInputDictionaryPeer(b, authorityB.configurationRevision, a.serverId, authorityA.fingerprint);
    await vi.waitFor(async () => {
      expect((await mobileNetwork.getVoiceInputDictionary(a)).refinementTerms.slice().sort()).toEqual(["DeleteMe", "OfficeTerm", "PhoneTerm"]);
      expect((await mobileNetwork.getVoiceInputDictionary(b)).refinementTerms.slice().sort()).toEqual(["DeleteMe", "OfficeTerm", "PhoneTerm"]);
    }, { timeout: 8_000, interval: 100 });
    const plain = new Map<string, string>();
    const driver = { getItem: async (key: string) => plain.get(key) ?? null,
      setItem: async (key: string, value: string) => { plain.set(key, value); },
      removeItem: async (key: string) => { plain.delete(key); }, getAllKeys: async () => [...plain.keys()],
      multiRemove: async (keys: readonly string[]) => { for (const key of keys) plain.delete(key); } };
    const credentials = new Map([[a.profileId, a], [b.profileId, b]]);
    const profiles = [profileFromCredential(a), profileFromCredential(b)];
    const storage = { loadConnectionIndex: async () => ({ profiles, automaticProfileId: a.profileId }),
      loadCredential: async (id: string) => credentials.get(id),
      saveConnection: async () => undefined, deleteCredential: async (id: string) => { credentials.delete(id); },
      deleteConnection: async () => undefined, saveAutomaticProfile: async () => undefined,
      loadPending: async () => [], savePending: async () => undefined,
      loadSelection: async () => undefined, saveSelection: async () => undefined };
    let sequence = 0;
    const createPhone = () => {
      const cache = new MobileVoiceDictionaryReadOnlyCache(driver);
      const offline = new MobileOfflineCache(driver, Date.now, () => `readonly-cache-${++sequence}`);
      const app = new MobileClient(mobileNetwork, storage, { scan: async () => [] }, () => `readonly-operation-${++sequence}`, "android", Date.now,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, offline, cache);
      const controller = new MobileVoiceDictionaryReadOnlyController(cache, (id: string, signal: AbortSignal) => app.voiceDictionaryReadOnlyTransport(id, signal));
      const unsubscribe = app.subscribe((state: { saved: Parameters<typeof mobileReadOnlyDictionarySources>[0] }) => controller.setSources(mobileReadOnlyDictionarySources(state.saved)));
      streamCleanups.push(async () => { controller.setVisible(false); unsubscribe(); app.dispose(); });
      return { cache, app, controller, stop: () => { controller.setVisible(false); unsubscribe(); app.dispose(); } };
    };
    let phone = createPhone(); await phone.app.start(); phone.controller.setVisible(true);
    await vi.waitFor(() => {
      expect(phone.controller.state.hosts.map((host: { status: string }) => host.status)).toEqual(["ready", "ready"]);
      expect(phone.controller.state.selected?.snapshot.entries.map((entry: { text: string }) => entry.text).sort()).toEqual(["DeleteMe", "OfficeTerm", "PhoneTerm"]);
    });
    expect(phone.app.state.activeProfileId).toBe(a.profileId);
    const grantedB = await mobileNetwork.getVoiceInputDictionaryPeerStatus(b);
    await mobileNetwork.revokeVoiceInputDictionaryPeer(b, a.serverId, grantedB.peers[0]!.revision);
    const basis = await mobileNetwork.getVoiceInputDictionary(a);
    const deleted = await mobileNetwork.deleteVoiceInputDictionaryEntry(a, basis.revision, basis.dictionary.entries.find((entry: { text: string }) => entry.text === "DeleteMe")!.id);
    await vi.waitFor(() => expect(phone.controller.state.selected?.snapshot.entries.map((entry: { text: string }) => entry.text).sort()).toEqual(["OfficeTerm", "PhoneTerm"]));
    expect(phone.cache.read(profiles[1]!)!.snapshot.entries.some((entry: { text: string }) => entry.text === "DeleteMe")).toBe(true);
    const disabled = await mobileNetwork.setVoiceInputDictionarySyncEnabled(a, deleted.revision, false);
    await vi.waitFor(() => expect(phone.controller.state.selected?.snapshot).toMatchObject({ revision: disabled.revision, syncEnabled: false, entries: [] }));
    const disabledSnapshot = phone.cache.read(profiles[0]!)!.snapshot;
    expect((await mobileNetwork.getVoiceInputDictionary(a)).refinementTerms.slice().sort()).toEqual(["OfficeTerm", "PhoneTerm"]);
    expect((await mobileNetwork.getVoiceInputDictionaryPeerStatus(a)).peers).toHaveLength(1);
    await phone.controller.refresh(); expect(phone.controller.state.selected?.snapshot).toEqual(disabledSnapshot);
    for (const credential of [a, b]) expect([...plain.values()].join("")).not.toContain(credential.authKey);
    const rootA = fixture.rootDirectory; const rootB = peerFixture.rootDirectory;
    const portA = Number(new URL(fixture.baseUrl).port); const portB = Number(new URL(peerFixture.baseUrl).port);
    phone.stop();
    expect(streamSignals.length).toBeGreaterThan(2);
    expect(streamSignals.every((request) => request.signal.aborted)).toBe(true);
    await peerFixture.close({ removeRoot: false });
    let closed = false;
    void fixture.close({ removeRoot: false }).then(() => { closed = true; });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
    phone = createPhone(); await phone.app.start(); phone.controller.setVisible(true);
    await vi.waitFor(() => { expect(phone.controller.state.refreshing).toBe(false); expect(phone.controller.state.hosts.map((host: { status: string }) => host.status)).toEqual(["offline", "offline"]); });
    expect(phone.app.state.status).toBe("offline"); expect(phone.controller.state.selected?.snapshot).toEqual(disabledSnapshot);
    expect(credentials.has(a.profileId)).toBe(true); expect(credentials.has(b.profileId)).toBe(true);
    fixture = await OrchestratorE2eFixture.start({ rootDirectory: rootA, dictionaryPeerNodeId: "readonly-node-a", publicPort: portA });
    peerFixture = await OrchestratorE2eFixture.start({ rootDirectory: rootB, dictionaryPeerNodeId: "readonly-node-b", publicPort: portB });
    expect((await mobileNetwork.getVoiceInputDictionaryReadOnly(a))).toEqual(disabledSnapshot);
    phone.controller.setVisible(false); await phone.app.connectSaved(a.profileId); phone.controller.setVisible(true);
    await vi.waitFor(() => expect(phone.controller.state.hosts.map((host: { status: string }) => host.status)).toEqual(["ready", "ready"]));
    const enabled = await mobileNetwork.setVoiceInputDictionarySyncEnabled(a, disabled.revision, true);
    await vi.waitFor(() => expect(phone.controller.state.selected?.snapshot).toMatchObject({ revision: enabled.revision, syncEnabled: true,
      entries: expect.arrayContaining([{ text: "OfficeTerm", frequency: 1, aliases: [] }, { text: "PhoneTerm", frequency: 1, aliases: [] }]) }));
    fixture.application.connections.revoke(a.connectionId);
    await vi.waitFor(() => { expect(phone.cache.read(profiles[0]!)).toBeUndefined(); expect(credentials.has(a.profileId)).toBe(false); });
    expect(phone.cache.read(profiles[1]!)).toBeDefined(); expect(credentials.has(b.profileId)).toBe(true);
    expect(phone.app.state.status).toBe("revoked");
  }, 60_000);

  it.each([{ route: "LAN discovery", direct: false }, { route: "explicit routes without multicast", direct: true }])(
    "converges the production three-node bridge through $route, offline conflicts, disable and renewed bilateral grants", async ({ direct }) => {
    const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
    const root = await mkdtemp(join(tmpdir(), "joko-dictionary-product-chain-"));
    const running = new Set<ProductionDictionaryNode>();
    const observations: ReturnType<typeof observeProductionDictionary>[] = [];
    const phoneAbort = new AbortController();
    const phoneStreams: Promise<void>[] = [];
    let journeyFailed = false;
    let journeyError: unknown;
    const start = async (name: string) => {
      const node = await ProductionDictionaryNode.start(join(root, name), { directOnly: direct });
      running.add(node);
      return node;
    };
    try {
      const a = await start("a");
      let b = await start("b");
      const c = await start("c");
      const pairedA = await a.pair("Dictionary editor A");
      const pairedB = await b.pair("Dictionary bridge B");
      const pairedC = await c.pair("Dictionary phone C");
      const apiA = pairedA.clients.voiceInput;
      let apiB = pairedB.clients.voiceInput;
      const credentialC = { profileId: "product-dictionary-c", origin: c.baseUrl, serverId: c.application.serverId,
        connectionId: pairedC.connectionId, deviceId: pairedC.deviceId, displayName: "Dictionary phone C", authKey: pairedC.authKey };
      const readA = async () => (await apiA.getVoiceInputDictionary({})).dictionary!;
      const readB = async () => (await apiB.getVoiceInputDictionary({})).dictionary!;
      const readC = () => mobileNetwork.getVoiceInputDictionary(credentialC);
      const phoneContent = observedProjection<{ readonly revision: bigint; readonly refinementTerms: readonly string[] }>(
        mobileNetwork.watchVoiceInputDictionary(credentialC, phoneAbort.signal), phoneAbort.signal);
      const phoneReadonly = observedProjection<VoiceDictionaryReadOnlyView>(
        mobileNetwork.watchVoiceInputDictionaryReadOnly(credentialC, phoneAbort.signal), phoneAbort.signal);
      const phonePeers = observedProjection<VoiceDictionaryPeerStatusView>(
        mobileNetwork.watchVoiceInputDictionaryPeerStatus(credentialC, phoneAbort.signal), phoneAbort.signal);
      phoneStreams.push(phoneContent.done, phoneReadonly.done, phonePeers.done);
      let bridgeObservation = observeProductionDictionary(apiB);
      observations.push(bridgeObservation);

      const initialA = (await apiA.addVoiceInputDictionaryTerms({ expectedRevision: (await readA()).revision,
        terms: ["OfficeTerm", "DeleteMe", "Editable"] })).dictionary!;
      await apiA.setVoiceInputDictionarySyncEnabled({ expectedRevision: initialA.revision, enabled: true });
      await apiB.setVoiceInputDictionarySyncEnabled({ expectedRevision: (await readB()).revision, enabled: true });
      const initialC = await mobileNetwork.addVoiceInputDictionaryTerms(credentialC, (await readC()).revision, ["PhoneTerm"]);
      await mobileNetwork.setVoiceInputDictionarySyncEnabled(credentialC, initialC.revision, true);
      const invitations = new Map<string, string>();
      if (direct) {
        for (const api of [apiA, apiB]) {
          const status = (await api.getVoiceInputDictionaryPeerStatus({})).status!;
          expect(status.candidates).toEqual([]); expect(status.peers).toEqual([]);
          const port = await dictionaryListenerPort();
          await api.configureVoiceInputDictionaryListener({ expectedConfigurationRevision: status.configurationRevision,
            listener: { listenPort: port, host: "127.0.0.1", port } });
          const raw = (await api.getVoiceInputDictionaryPeerInvitation({})).invitation;
          const invitation = readVoiceDictionaryPeerInvitation(raw);
          expect(invitation).toMatchObject({ nodeId: status.nodeId, fingerprint: status.fingerprint, host: "127.0.0.1", port });
          invitations.set(invitation.nodeId, raw);
          expect((await api.getVoiceInputDictionaryPeerStatus({})).status!.candidates).toEqual([]);
        }
        const statusC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        expect(statusC.candidates).toEqual([]); expect(statusC.peers).toEqual([]);
        const portC = await dictionaryListenerPort();
        await mobileNetwork.configureVoiceInputDictionaryListener(credentialC, statusC.configurationRevision,
          { listenPort: portC, host: "127.0.0.1", port: portC });
        const rawC = await mobileNetwork.getVoiceInputDictionaryPeerInvitation(credentialC);
        expect(readVoiceDictionaryPeerInvitation(rawC)).toMatchObject({ nodeId: statusC.nodeId, fingerprint: statusC.fingerprint,
          host: "127.0.0.1", port: portC });
        invitations.set(statusC.nodeId, rawC);
      } else await vi.waitFor(async () => {
        const statuses = await Promise.all([apiA.getVoiceInputDictionaryPeerStatus({}), apiB.getVoiceInputDictionaryPeerStatus({})]);
        const peersC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        expect(statuses[0].status!.candidates.some((candidate) => candidate.nodeId === b.application.serverId)).toBe(true);
        expect(statuses[1].status!.candidates.map((candidate) => candidate.nodeId)).toEqual(expect.arrayContaining([a.application.serverId, c.application.serverId]));
        expect(peersC.candidates.some((candidate: { nodeId: string }) => candidate.nodeId === b.application.serverId)).toBe(true);
      }, { timeout: 12_000, interval: 100 });
      const identityA = (await apiA.getVoiceInputDictionaryPeerStatus({})).status!;
      const identityB = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
      const identityC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
      const grant = async (api: E2eClients["voiceInput"], peerId: string, expectedFingerprint: string) => {
        if (direct) return api.grantVoiceInputDictionaryDirectPeer({
          expectedConfigurationRevision: (await api.getVoiceInputDictionaryPeerStatus({})).status!.configurationRevision,
          invitation: invitations.get(peerId)!, expectedFingerprint
        });
        await vi.waitFor(async () => {
          const current = (await api.getVoiceInputDictionaryPeerStatus({})).status!;
          expect(current.candidates.some((candidate) => candidate.nodeId === peerId && candidate.fingerprint === expectedFingerprint)).toBe(true);
        }, { timeout: 12_000, interval: 100 });
        return api.grantVoiceInputDictionaryPeer({ expectedConfigurationRevision: (await api.getVoiceInputDictionaryPeerStatus({})).status!.configurationRevision,
          peerId, expectedFingerprint });
      };
      const grantC = async () => {
        if (direct) {
          const current = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
          return mobileNetwork.grantVoiceInputDictionaryDirectPeer(credentialC, current.configurationRevision,
            invitations.get(identityB.nodeId)!, identityB.fingerprint);
        }
        await vi.waitFor(async () => {
          const current = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
          expect(current.candidates.some((candidate: { nodeId: string; fingerprint: string }) =>
            candidate.nodeId === identityB.nodeId && candidate.fingerprint === identityB.fingerprint)).toBe(true);
        }, { timeout: 12_000, interval: 100 });
        const current = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        return mobileNetwork.grantVoiceInputDictionaryPeer(credentialC, current.configurationRevision, identityB.nodeId, identityB.fingerprint);
      };
      if (direct) {
        await expect(apiA.grantVoiceInputDictionaryDirectPeer({ expectedConfigurationRevision: identityA.configurationRevision,
          invitation: invitations.get(identityB.nodeId)!, expectedFingerprint: "0".repeat(64) })).rejects.toMatchObject({ code: Code.InvalidArgument });
        await expect(apiA.grantVoiceInputDictionaryDirectPeer({ expectedConfigurationRevision: identityA.configurationRevision - 1n,
          invitation: invitations.get(identityB.nodeId)!, expectedFingerprint: identityB.fingerprint })).rejects.toMatchObject({ code: Code.Aborted });
      }
      const grantedA = (await grant(apiA, identityB.nodeId, identityB.fingerprint)).status!;
      if (direct) {
        expect(grantedA.peers).toMatchObject([{ peerId: identityB.nodeId, online: false,
          route: { host: "127.0.0.1", port: readVoiceDictionaryPeerInvitation(invitations.get(identityB.nodeId)!).port } }]);
        await expect(apiA.syncVoiceInputDictionaryNow({ expectedConfigurationRevision: grantedA.configurationRevision,
          peerId: identityB.nodeId })).rejects.toMatchObject({ code: Code.Unavailable });
      }
      await grant(apiB, identityA.nodeId, identityA.fingerprint);
      await grant(apiB, identityC.nodeId, identityC.fingerprint);
      await grantC();

      const converge = async (terms: readonly string[], evidence?: number) => {
        await vi.waitFor(async () => {
          const [dictionaryA, dictionaryB, dictionaryC] = await Promise.all([readA(), readB(), readC()]);
          for (const dictionary of [dictionaryA, dictionaryB, dictionaryC]) expect(dictionary.refinementTerms.slice().sort()).toEqual(terms.slice().sort());
          expect(a.application.voiceDictionary!.stateForSync()).toEqual(b.application.voiceDictionary!.stateForSync());
          expect(c.application.voiceDictionary!.stateForSync()).toEqual(b.application.voiceDictionary!.stateForSync());
          const readonlyA = projectVoiceDictionaryReadOnly((await apiA.getVoiceInputDictionaryReadOnly({})).dictionary);
          const readonlyB = projectVoiceDictionaryReadOnly((await apiB.getVoiceInputDictionaryReadOnly({})).dictionary);
          const readonlyC = await mobileNetwork.getVoiceInputDictionaryReadOnly(credentialC);
          expect(readonlyA.entries).toEqual(readonlyB.entries); expect(readonlyC.entries).toEqual(readonlyB.entries);
          expect(readonlyA.stateVector).toEqual(readonlyB.stateVector); expect(readonlyC.stateVector).toEqual(readonlyB.stateVector);
          expect(phoneContent.latest).toEqual(dictionaryC); expect(phoneReadonly.latest).toEqual(readonlyC);
          expect(bridgeObservation.content.latest?.dictionary).toEqual(dictionaryB);
          expect(bridgeObservation.readonly.latest?.dictionary?.revision).toBe(dictionaryB.revision);
          expect(phoneContent.error).toBeUndefined(); expect(phoneReadonly.error).toBeUndefined(); expect(phonePeers.error).toBeUndefined();
          expect(bridgeObservation.content.error).toBeUndefined(); expect(bridgeObservation.readonly.error).toBeUndefined(); expect(bridgeObservation.peers.error).toBeUndefined();
          if (evidence !== undefined) {
            // The durable owner promotes two independent learning events to an automatic entry.
            for (const dictionary of [dictionaryA, dictionaryB]) {
              expect(dictionary.entries.find((entry) => entry.text === "Concurrent candidate")).toMatchObject({
                source: VoiceInputDictionaryEntrySource.AUTOMATIC, frequency: BigInt(evidence),
                aliases: [{ text: "concurrent spoken", count: BigInt(evidence) }]
              });
              expect(dictionary.candidates.some((candidate) => candidate.text === "Concurrent candidate")).toBe(false);
            }
            expect(dictionaryC.dictionary.entries.find((entry: { text: string }) => entry.text === "Concurrent candidate")).toMatchObject({
              source: "automatic", frequency: evidence, aliases: [{ text: "concurrent spoken", count: evidence }]
            });
            expect(dictionaryC.dictionary.candidates.some((candidate: { text: string }) => candidate.text === "Concurrent candidate")).toBe(false);
            expect(readonlyC.entries.find((entry: { text: string }) => entry.text === "Concurrent candidate")).toMatchObject({
              frequency: evidence, aliases: [{ text: "concurrent spoken", count: evidence }]
            });
          }
          const peersA = (await apiA.getVoiceInputDictionaryPeerStatus({})).status!;
          const peersB = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
          const peersC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
          expect(peersA.peers.map((peer) => peer.peerId)).toEqual([identityB.nodeId]);
          expect(peersB.peers.map((peer) => peer.peerId).sort()).toEqual([identityA.nodeId, identityC.nodeId].sort());
          expect(peersC.peers.map((peer: { peerId: string }) => peer.peerId)).toEqual([identityB.nodeId]);
          if (direct) {
            for (const status of [peersA, peersB, peersC]) for (const peer of status.peers) {
              expect(peer.online).toBe(true);
              const invitation = readVoiceDictionaryPeerInvitation(invitations.get(peer.peerId)!);
              expect(peer.route).toMatchObject({ host: invitation.host, port: invitation.port });
            }
            expect(peersA.candidates.some((candidate) => candidate.nodeId === identityC.nodeId)).toBe(false);
            expect(peersC.candidates.some((candidate: { nodeId: string }) => candidate.nodeId === identityA.nodeId)).toBe(false);
          }
          expect(phonePeers.latest?.configurationRevision).toBe(peersC.configurationRevision);
          expect(bridgeObservation.peers.latest?.status?.configurationRevision).toBe(peersB.configurationRevision);
        }, { timeout: 24_000, interval: 100 });
      };
      await converge(["DeleteMe", "Editable", "OfficeTerm", "PhoneTerm"]);
      const autoForwarded = (await apiA.addVoiceInputDictionaryTerms({ expectedRevision: (await readA()).revision, terms: ["Across bridge"] })).dictionary!;
      // No explicit sync: both A -> B and B -> C use the production eight-second debounce.
      await converge(["Across bridge", "DeleteMe", "Editable", "OfficeTerm", "PhoneTerm"]);
      expect((await readA()).revision).toBe(autoForwarded.revision);

      const bridgeAuthority = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
      await b.close(); running.delete(b);
      await dictionaryDeadline(bridgeObservation.done, 5_000);
      expect(bridgeObservation.content.error).toBeUndefined(); expect(bridgeObservation.readonly.error).toBeUndefined(); expect(bridgeObservation.peers.error).toBeUndefined();
      await expect(apiB.getVoiceInputDictionary({})).rejects.toMatchObject({ code: Code.Unavailable });
      const [offlineA, offlineC] = await Promise.all([readA(), readC()]);
      await Promise.all([
        (async () => {
          const deleted = (await apiA.deleteVoiceInputDictionaryEntry({ expectedRevision: offlineA.revision,
            entryId: offlineA.entries.find((entry) => entry.text === "DeleteMe")!.entryId })).dictionary!;
          await apiA.applyVoiceInputDictionaryLearning({ expectedRevision: deleted.revision,
            actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE, term: "Concurrent candidate", aliases: ["concurrent spoken"] }] });
        })(),
        (async () => {
          const edited = await mobileNetwork.editVoiceInputDictionaryEntry(credentialC, offlineC.revision,
            offlineC.dictionary.entries.find((entry: { text: string }) => entry.text === "Editable")!.id, "Edited offline", ["offline alias"]);
          await mobileNetwork.applyVoiceInputDictionaryLearning(credentialC, edited.revision, [
            { action: "addEntry", term: "DeleteMe", aliases: [], type: "technicalTerm", confidence: "high" },
            { action: "addCandidate", term: "Concurrent candidate", aliases: ["concurrent spoken"], type: "technicalTerm", confidence: "high" }
          ]);
        })()
      ]);
      expect((await readA()).refinementTerms).not.toContain("DeleteMe");
      expect((await readC()).refinementTerms).toContain("DeleteMe");
      b = await start("b"); apiB = b.clients(pairedB.authKey).voiceInput;
      bridgeObservation = observeProductionDictionary(apiB); observations.push(bridgeObservation);
      const restoredAuthority = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
      expect(restoredAuthority).toMatchObject({ nodeId: bridgeAuthority.nodeId, fingerprint: bridgeAuthority.fingerprint,
        configurationRevision: bridgeAuthority.configurationRevision, enabled: true });
      expect(restoredAuthority.peers.map(({ peerId, revision, fingerprint }) => ({ peerId, revision, fingerprint }))).toEqual(
        bridgeAuthority.peers.map(({ peerId, revision, fingerprint }) => ({ peerId, revision, fingerprint })));
      if (direct) {
        expect(restoredAuthority.listener).toEqual(bridgeAuthority.listener);
        expect(restoredAuthority.peers.map(({ peerId, route }) => ({ peerId, route }))).toEqual(
          bridgeAuthority.peers.map(({ peerId, route }) => ({ peerId, route })));
        expect((await apiB.getVoiceInputDictionaryPeerInvitation({})).invitation).toBe(invitations.get(identityB.nodeId));
      }
      expect((await readB()).refinementTerms).toEqual(expect.arrayContaining(["Across bridge", "OfficeTerm", "PhoneTerm"]));
      const mergedTerms = ["Across bridge", "Concurrent candidate", "Edited offline", "OfficeTerm", "PhoneTerm"];
      await converge(mergedTerms, 2);
      expect((await readC()).dictionary.entries.find((entry: { text: string }) => entry.text === "Edited offline").aliases).toMatchObject([{ text: "offline alias" }]);

      const beforeDisable = await readB();
      const disabled = (await apiB.setVoiceInputDictionarySyncEnabled({ expectedRevision: beforeDisable.revision, enabled: false })).dictionary!;
      const disabledAuthority = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
      expect(disabledAuthority.peers.map((peer) => peer.peerId).sort()).toEqual([identityA.nodeId, identityC.nodeId].sort());
      expect(disabled.entries).toEqual(beforeDisable.entries); expect(disabled.candidates).toEqual(beforeDisable.candidates);
      await vi.waitFor(() => {
        expect(bridgeObservation.content.latest?.dictionary).toEqual(disabled);
        expect(bridgeObservation.readonly.latest?.dictionary).toMatchObject({ revision: disabled.revision, syncEnabled: false, entries: [] });
        expect(bridgeObservation.peers.latest?.status).toMatchObject({ enabled: false, peers: expect.any(Array) });
      });
      const retained = (await apiB.addVoiceInputDictionaryTerms({ expectedRevision: disabled.revision, terms: ["Bridge while disabled"] })).dictionary!;
      const endpointsBefore = [a.application.voiceDictionary!.stateForSync(), c.application.voiceDictionary!.stateForSync()];
      await dictionaryIsolationWindow(() => {
        expect(a.application.voiceDictionary!.stateForSync()).toEqual(endpointsBefore[0]);
        expect(c.application.voiceDictionary!.stateForSync()).toEqual(endpointsBefore[1]);
        expect(b.application.voiceDictionary!.snapshot().revision).toBe(Number(retained.revision));
      });
      await expect(apiB.syncVoiceInputDictionaryNow({ expectedConfigurationRevision: disabledAuthority.configurationRevision })).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await apiB.setVoiceInputDictionarySyncEnabled({ expectedRevision: retained.revision, enabled: true });
      const enabledTerms = [...mergedTerms, "Bridge while disabled"];
      await converge(enabledTerms, 2);

      const beforeRevoke = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
      const oldGrant = beforeRevoke.peers.find((peer) => peer.peerId === identityC.nodeId)!;
      const revoked = (await apiB.revokeVoiceInputDictionaryPeer({ peerId: identityC.nodeId, expectedGrantRevision: oldGrant.revision })).status!;
      expect((await readB()).refinementTerms.slice().sort()).toEqual(enabledTerms.slice().sort());
      const isolatedBridgeState = b.application.voiceDictionary!.stateForSync();
      await mobileNetwork.addVoiceInputDictionaryTerms(credentialC, (await readC()).revision, ["Phone after revoke"]);
      await dictionaryIsolationWindow(() => {
        expect(b.application.voiceDictionary!.stateForSync()).toEqual(isolatedBridgeState);
        expect((a.application.voiceDictionary!.snapshot().dictionary.entries).some((entry) => entry.text === "Phone after revoke")).toBe(false);
      });
      const statusC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
      await expect(mobileNetwork.syncVoiceInputDictionaryNow(credentialC, statusC.configurationRevision, identityB.nodeId)).rejects.toMatchObject({ code: Code.Unavailable });
      await mobileNetwork.revokeVoiceInputDictionaryPeer(credentialC, identityB.nodeId, statusC.peers[0].revision);
      if (!direct) await vi.waitFor(async () => {
        const peersB = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
        const peersC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        expect(peersB.candidates.some((candidate) => candidate.nodeId === identityC.nodeId)).toBe(true);
        expect(peersC.candidates.some((candidate: { nodeId: string }) => candidate.nodeId === identityB.nodeId)).toBe(true);
      }, { timeout: 12_000, interval: 100 });
      const renewedB = (await grant(apiB, identityC.nodeId, identityC.fingerprint)).status!;
      await grantC();
      expect(renewedB.peers.find((peer) => peer.peerId === identityC.nodeId)!.revision).toBeGreaterThan(oldGrant.revision);
      await expect(apiB.revokeVoiceInputDictionaryPeer({ peerId: identityC.nodeId, expectedGrantRevision: oldGrant.revision })).rejects.toMatchObject({ code: Code.Aborted });
      await expect(apiB.syncVoiceInputDictionaryNow({ expectedConfigurationRevision: revoked.configurationRevision })).rejects.toMatchObject({ code: Code.Aborted });
      const finalTerms = [...enabledTerms, "Phone after revoke"];
      await converge(finalTerms, 2);
      let finalAuthorityB = renewedB;
      if (direct) {
        const authorityB = (await apiB.getVoiceInputDictionaryPeerStatus({})).status!;
        const authorityC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        const retainedGrant = authorityB.peers.find((peer) => peer.peerId === identityC.nodeId)!;
        const clearedB = (await apiB.clearVoiceInputDictionaryPeerRoute({ expectedConfigurationRevision: authorityB.configurationRevision,
          peerId: identityC.nodeId })).status!;
        const clearedC = await mobileNetwork.clearVoiceInputDictionaryPeerRoute(credentialC, authorityC.configurationRevision, identityB.nodeId);
        expect(clearedB.peers.find((peer) => peer.peerId === identityC.nodeId)).toMatchObject({ revision: retainedGrant.revision, online: false });
        expect(clearedB.peers.find((peer) => peer.peerId === identityC.nodeId)!.route).toBeUndefined();
        expect(clearedC.peers[0].route).toBeUndefined();
        await expect(apiB.clearVoiceInputDictionaryPeerRoute({ expectedConfigurationRevision: authorityB.configurationRevision,
          peerId: identityC.nodeId })).rejects.toMatchObject({ code: Code.Aborted });
        await expect(mobileNetwork.syncVoiceInputDictionaryNow(credentialC, clearedC.configurationRevision,
          identityB.nodeId)).rejects.toMatchObject({ code: Code.Unavailable });
        const isolatedState = b.application.voiceDictionary!.stateForSync();
        await mobileNetwork.addVoiceInputDictionaryTerms(credentialC, (await readC()).revision, ["Phone after route clear"]);
        await dictionaryIsolationWindow(() => {
          expect(b.application.voiceDictionary!.stateForSync()).toEqual(isolatedState);
          expect(a.application.voiceDictionary!.snapshot().dictionary.entries.some((entry) => entry.text === "Phone after route clear")).toBe(false);
        });
        finalAuthorityB = (await grant(apiB, identityC.nodeId, identityC.fingerprint)).status!;
        await grantC();
        expect(finalAuthorityB.peers.find((peer) => peer.peerId === identityC.nodeId)!.revision).toBe(retainedGrant.revision);
        finalTerms.push("Phone after route clear");
        await converge(finalTerms, 2);
      }
      const stable = await Promise.all([readA(), readB(), readC()]);
      for (let replay = 0; replay < 2; replay += 1) {
        await apiB.syncVoiceInputDictionaryNow({ expectedConfigurationRevision: finalAuthorityB.configurationRevision });
        const currentC = await mobileNetwork.getVoiceInputDictionaryPeerStatus(credentialC);
        await mobileNetwork.syncVoiceInputDictionaryNow(credentialC, currentC.configurationRevision);
      }
      await converge(finalTerms, 2);
      expect((await readA()).revision).toBe(stable[0].revision); expect((await readB()).revision).toBe(stable[1].revision);
      expect((await readC()).revision).toBe(stable[2].revision);
    } catch (error) {
      journeyFailed = true; journeyError = error;
      throw error;
    } finally {
      phoneAbort.abort();
      const streams = await Promise.allSettled([dictionaryDeadline(Promise.all(phoneStreams), 5_000), ...observations.map((observation) => observation.close())]);
      const closed = await Promise.allSettled([...running].map((node) => node.close()));
      const removed = await Promise.allSettled([rm(root, { recursive: true, force: true, maxRetries: 3 })]);
      const failures = [...streams, ...closed, ...removed].filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) {
        if (journeyFailed) throw new AggregateError([journeyError, ...failures],
          `Production dictionary journey failed: ${journeyError instanceof Error ? journeyError.message : String(journeyError)}; cleanup also failed.`, { cause: journeyError });
        throw new AggregateError(failures, "Production dictionary cleanup failed.");
      }
    }
  }, 150_000);

  it("drains both idle dictionary projections immediately on public server shutdown", async () => {
    fixture = await OrchestratorE2eFixture.start({ dictionaryPeerNodeId: "e2e-dictionary-shutdown", keepRoot: true });
    const paired = await fixture.pair("Live dictionary observer");
    const abort = new AbortController();
    const content = observedProjection(paired.clients.voiceInput.watchVoiceInputDictionary({}, { signal: abort.signal, timeoutMs: 0 }), abort.signal);
    const peers = observedProjection(paired.clients.voiceInput.watchVoiceInputDictionaryPeerStatus({}, { signal: abort.signal, timeoutMs: 0 }), abort.signal);
    streamCleanups.push(async () => { abort.abort(); await Promise.all([content.done, peers.done]); });
    await vi.waitFor(() => { expect(content.first?.sequence).toBe(1n); expect(peers.first?.sequence).toBe(1n); });
    let closed = false;
    const closing = fixture.close({ removeRoot: false }).then(() => { closed = true; });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
      await Promise.all([content.done, peers.done]);
      expect(content.error).toBeUndefined(); expect(peers.error).toBeUndefined();
    } finally { abort.abort(); await closing; }
  }, 20_000);
});

function observedProjection<T>(stream: AsyncIterable<T>, signal: AbortSignal) {
  let first: T | undefined;
  let latest: T | undefined;
  let error: unknown;
  const done = (async () => {
    try { for await (const value of stream) { first ??= value; latest = value; } }
    catch (cause) { if (!signal.aborted) error = cause; }
  })();
  return { done, get first() { return first; }, get latest() { return latest; }, get error() { return error; } };
}

function observeProductionDictionary(api: E2eClients["voiceInput"]) {
  const abort = new AbortController();
  const content = observedProjection(api.watchVoiceInputDictionary({}, { signal: abort.signal, timeoutMs: 0 }), abort.signal);
  const readOnly = observedProjection(api.watchVoiceInputDictionaryReadOnly({}, { signal: abort.signal, timeoutMs: 0 }), abort.signal);
  const peers = observedProjection(api.watchVoiceInputDictionaryPeerStatus({}, { signal: abort.signal, timeoutMs: 0 }), abort.signal);
  const done = Promise.all([content.done, readOnly.done, peers.done]);
  return { content, readonly: readOnly, peers, done,
    close: async () => { abort.abort(); await dictionaryDeadline(done, 5_000); } };
}

async function dictionaryIsolationWindow(assertUnchanged: () => void): Promise<void> {
  const begun = Date.now();
  await vi.waitFor(() => {
    assertUnchanged();
    expect(Date.now() - begun).toBeGreaterThanOrEqual(8_500);
  }, { timeout: 10_000, interval: 100 });
}

async function dictionaryDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Production dictionary cleanup exceeded its deadline.")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Starts the actual application composition; dictionary timing, codec and transport are never substituted. */
class ProductionDictionaryNode {
  readonly application: OrchestratorApplication;
  readonly baseUrl: string;
  readonly #server: Awaited<ReturnType<typeof createPublicServer>>;
  readonly #pairingCodes: ReadonlyMap<string, string>;
  readonly #removePairingListener: () => void;
  #closing?: Promise<void>;

  private constructor(input: { application: OrchestratorApplication; baseUrl: string;
    server: Awaited<ReturnType<typeof createPublicServer>>; pairingCodes: ReadonlyMap<string, string>; removePairingListener: () => void }) {
    this.application = input.application; this.baseUrl = input.baseUrl; this.#server = input.server;
    this.#pairingCodes = input.pairingCodes; this.#removePairingListener = input.removePairingListener;
  }

  static async start(root: string, options: { readonly directOnly?: boolean } = {}): Promise<ProductionDictionaryNode> {
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1", port: 0, internalPort: 4317,
      publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
      dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false,
      ...(options.directOnly ? { voiceDictionaryLanDiscoveryEnabled: false } : {}),
      piExecutable: join(root, "missing-pi"), codexExecutable: join(root, "missing-codex"), claudeCodeExecutable: join(root, "missing-claude"),
      piAgentHome: join(dataDirectory, "pi-agent-home"),
      workspace: { id: "workspace-dictionary-product", root: workspace, displayName: "Dictionary product", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "unused-web"), corsOrigins: []
    };
    let application: OrchestratorApplication | undefined;
    let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    let removePairingListener: (() => void) | undefined;
    try {
      application = await createOrchestratorApplication(config);
      const pairingCodes = new Map<string, string>();
      removePairingListener = application.connections.onPairingIssued((challenge) => pairingCodes.set(challenge.id, challenge.code));
      application.connections.openPairingWindow();
      server = await createPublicServer(application);
      server.log.level = "silent";
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      return new ProductionDictionaryNode({ application, baseUrl, server, pairingCodes, removePairingListener });
    } catch (error) {
      removePairingListener?.();
      await server?.close().catch(() => undefined);
      await application?.close().catch(() => undefined);
      throw error;
    }
  }

  clients(authKey: string): E2eClients { return createE2eClients(this.baseUrl, authKey, 15_000); }

  async pair(displayName: string): Promise<PairedClient> {
    const anonymous = createE2eClients(this.baseUrl);
    const begun = await anonymous.connection.beginPairing({ deviceDisplayName: displayName, deviceKind: DeviceKind.MOBILE, deviceNameSource: { defaultDisplayName: "Fixture phone" },
      platform: "android", appVersion: "dictionary-product-e2e" });
    const challengeId = begun.challenge?.challengeId;
    const humanCode = challengeId === undefined ? undefined : this.#pairingCodes.get(challengeId);
    if (challengeId === undefined || humanCode === undefined) throw new Error("Production dictionary pairing did not issue its trusted challenge.");
    const completed = await anonymous.connection.completePairing({ challengeId, humanCode, deviceDisplayName: displayName,
      deviceKind: DeviceKind.MOBILE, deviceNameSource: { defaultDisplayName: "Fixture phone" }, platform: "android", appVersion: "dictionary-product-e2e" });
    const authKey = completed.result?.authKey;
    const connectionId = completed.result?.connection?.connectionId;
    const deviceId = completed.result?.device?.deviceId;
    if (!authKey || !connectionId || !deviceId) throw new Error("Production dictionary pairing returned no Connection authority.");
    return { authKey, connectionId, deviceId, clients: this.clients(authKey) };
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#removePairingListener();
    this.#closing = (async () => {
      try { await dictionaryDeadline(this.#server.close(), 8_000); }
      finally { await dictionaryDeadline(this.application.close(), 8_000); }
    })();
    return this.#closing;
  }
}

async function dictionaryListenerPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}
