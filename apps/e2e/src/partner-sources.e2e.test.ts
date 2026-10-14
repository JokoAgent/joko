import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import type { Transport } from "@connectrpc/connect";
import { PartnerCapabilitiesSchema, PartnerDraftSchema, PartnerModelRouteSchema, PermissionMode } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const fixtures: RealPiSystemFixture[] = [];
const disposeClients: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposeClients.splice(0).reverse()) dispose();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close({ removeRoot: true });
  vi.unstubAllGlobals();
});

it("opens and edits a paired Partner on its original HTTP node while keeping the other node independent", async () => {
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
  const { MobileClient } = await import(new URL("../../mobile/src/mobile-client.ts", import.meta.url).href);
  const { profileFromCredential } = await import(new URL("../../mobile/src/connection-storage.ts", import.meta.url).href);
  const first = await RealPiSystemFixture.start(); fixtures.push(first);
  const second = await RealPiSystemFixture.start(); fixtures.push(second);
  const firstManager = await first.pair("First Partner manager");
  const secondManager = await second.pair("Second Partner manager");
  const createPartner = async (manager: typeof firstManager, requestId: string) => {
    const directory = (await manager.clients.partner.getPartnerDirectory({})).directory!;
    return (await manager.clients.partner.createPartner({ requestId, expectedDirectoryRevision: directory.revision,
      draft: create(PartnerDraftSchema, { displayName: "Shared display name", description: "Original node profile",
        avatar: { value: { case: "presetId", value: "orbit" } }, identitySource: "Work in your original home.",
        templateId: "general", usesDirectoryDefaults: false, capabilities: create(PartnerCapabilitiesSchema, {
          modelChain: [create(PartnerModelRouteSchema, { backendId: "pi", providerId: REAL_PI_PROVIDER_ID,
            modelId: REAL_PI_MODEL_ID, fastMode: false })], permissionMode: PermissionMode.AUTO, planMode: false }) }) })).partner!;
  };
  const firstPartner = await createPartner(firstManager, "first-source-partner");
  const secondPartner = await createPartner(secondManager, "second-source-partner");
  const pairPhone = async (fixture: RealPiSystemFixture) => {
    const names = { defaultDisplayName: "Partner source phone" };
    const begun = await mobileNetwork.requestPairing(fixture.baseUrl, "Partner source phone", "android", names);
    return (await mobileNetwork.completePairing(fixture.baseUrl, begun.challengeId, fixture.pairingCode(begun.challengeId),
      "Partner source phone", "android", names)).credential;
  };
  const a = await pairPhone(first), b = await pairPhone(second);
  const { PartnerSourceDirectory, partnerSourceKey } = await import(new URL("../../web/src/partner-sources.ts", import.meta.url).href);
  const { createOrchestratorGateway, probeOrchestratorOrigin } = await import(new URL("../../web/src/gateway.ts", import.meta.url).href);
  const { createConnectTransport } = await import("@connectrpc/connect-node");
  const transportFor = (origin: string, secret?: string): Transport => createConnectTransport({ baseUrl: origin,
    httpVersion: "1.1", useBinaryFormat: true, interceptors: secret ? [next => request => {
      request.header.set("authorization", `Bearer ${secret}`); return next(request);
    }] : [] });
  const webProfiles = [a, b].map(credential => ({ id: credential.connectionId, deviceId: credential.deviceId,
    serverId: credential.serverId, origin: credential.origin, name: "Shared node name" }));
  const webAuth = new Map([[a.connectionId, a.authKey], [b.connectionId, b.authKey]]);
  const webDirectory = new PartnerSourceDirectory({
    probe: (origin: string, signal: AbortSignal) => probeOrchestratorOrigin(origin, signal, transportFor),
    readAuthKey: async (profile: { readonly id: string }) => webAuth.get(profile.id),
    createGateway: (profile: unknown, secret: string, callbacks: unknown) => createOrchestratorGateway(profile, secret, callbacks, transportFor),
    publish: () => undefined
  });
  disposeClients.push(() => webDirectory.dispose());
  webDirectory.sync(webProfiles); await webDirectory.refreshAll();
  expect(webDirectory.getSources()).toEqual([
    expect.objectContaining({ status: "online", rows: [expect.objectContaining({ id: firstPartner.partnerId })] }),
    expect.objectContaining({ status: "online", rows: [expect.objectContaining({ id: secondPartner.partnerId })] })
  ]);
  const remoteWeb = await webDirectory.resolve(partnerSourceKey(webProfiles[1]), secondPartner.partnerId, new AbortController().signal);
  expect(remoteWeb).toMatchObject({ partner: { id: secondPartner.partnerId },
    session: { id: secondPartner.canonicalSessionId, targetId: secondPartner.homeTargetId } });
  const profiles = [profileFromCredential(a), profileFromCredential(b)];
  const credentials = new Map([[a.profileId, a], [b.profileId, b]]);
  const selections = new Map<string, string>();
  const storage = { loadConnectionIndex: async () => ({ profiles, automaticProfileId: a.profileId }),
    loadCredential: async (id: string) => credentials.get(id), saveConnection: async () => undefined,
    deleteCredential: async (id: string) => { credentials.delete(id); }, deleteConnection: async () => undefined,
    saveAutomaticProfile: async () => undefined, loadPending: async () => [], savePending: async () => undefined,
    loadSelection: async (id: string) => selections.get(id), saveSelection: async (id: string, selected?: string) => {
      if (selected) selections.set(id, selected); else selections.delete(id);
    } };
  let sequence = 0;
  let observeSave: (() => unknown) | undefined;
  const receivedBindings: unknown[] = [];
  const observedNetwork = { ...mobileNetwork, updatePartnerProfile: async (...args: unknown[]) => {
    const updated = await mobileNetwork.updatePartnerProfile(...args);
    receivedBindings.push(observeSave?.()); return updated;
  } };
  const client = new MobileClient(observedNetwork, storage, { scan: async () => [] }, () => `source-operation-${++sequence}`, "android");
  disposeClients.push(() => client.dispose());
  await client.start();
  expect(client.state.activeProfileId).toBe(a.profileId);
  const signal = new AbortController().signal;
  const sourceA = await client.partnerRosterSourceTransport(a.profileId, signal);
  const sourceB = await client.partnerRosterSourceTransport(b.profileId, signal);
  const catalogA = await sourceA.list(signal), catalogB = await sourceB.list(signal);
  expect(catalogA.partners).toEqual([expect.objectContaining({ partnerId: firstPartner.partnerId })]);
  expect(catalogB.partners).toEqual([expect.objectContaining({ partnerId: secondPartner.partnerId })]);
  expect(client.state.activeProfileId).toBe(a.profileId);
  await client.openPartnerRosterSource(b.profileId, catalogB.partners[0], signal);
  expect(client.state).toMatchObject({ activeProfileId: b.profileId, selectedId: secondPartner.canonicalSessionId });
  const editor = client.partnerProfileTransport();
  expect(editor).toBeDefined();
  const snapshot = await editor.load(catalogB.partners[0], signal);
  const partner = snapshot.partner;
  const bindingObservation = () => ({ selected: client.state.selectedId === secondPartner.canonicalSessionId,
    status: client.state.status, owner: client.state.owner?.sessions
      .filter((session: { sessionId: string }) => session.sessionId === secondPartner.canonicalSessionId)
      .map((session: { targetId: string; backendId: string; nativeBinding?: { runtimeGeneration?: bigint } }) => ({
        home: session.targetId === secondPartner.homeTargetId, backend: session.backendId === secondPartner.capabilities?.modelChain[0]?.backendId,
        generation: session.nativeBinding?.runtimeGeneration?.toString() })),
    detail: client.state.detail?.sessions
      .filter((session: { sessionId: string }) => session.sessionId === secondPartner.canonicalSessionId)
      .map((session: { targetId: string; backendId: string; nativeBinding?: { runtimeGeneration?: bigint } }) => ({
        home: session.targetId === secondPartner.homeTargetId, backend: session.backendId === secondPartner.capabilities?.modelChain[0]?.backendId,
        generation: session.nativeBinding?.runtimeGeneration?.toString() })) });
  observeSave = bindingObservation;
  const beforeSave = bindingObservation();
  const updated = await editor.save(snapshot, { displayName: partner.displayName, description: "Edited on second node",
    avatar: partner.avatar, identitySource: partner.identitySource, usesDirectoryDefaults: partner.usesDirectoryDefaults,
    capabilities: partner.capabilities, taskModelOverride: partner.taskModelOverride }, signal).catch((error: unknown) => {
      throw new Error(`Original-node profile save failed: ${JSON.stringify({ before: beforeSave, receipt: receivedBindings,
        after: bindingObservation() })}`, { cause: error });
    });
  expect(updated.description).toBe("Edited on second node");
  expect((await secondManager.clients.partner.getPartner({ partnerId: secondPartner.partnerId })).partner?.description)
    .toBe("Edited on second node");
  expect((await firstManager.clients.partner.getPartner({ partnerId: firstPartner.partnerId })).partner?.description)
    .toBe("Original node profile");
  await expect(editor.save(snapshot, { displayName: partner.displayName, description: "Stale edit", avatar: partner.avatar,
    identitySource: partner.identitySource, usesDirectoryDefaults: partner.usesDirectoryDefaults,
    capabilities: partner.capabilities }, signal)).rejects.toBeDefined();
  await client.openPartnerRosterSource(a.profileId, catalogA.partners[0], signal);
  expect(client.state).toMatchObject({ activeProfileId: a.profileId, selectedId: firstPartner.canonicalSessionId });
  second.application.connections.revoke(b.connectionId);
  await expect(client.partnerRosterSourceTransport(b.profileId, signal)).rejects.toBeDefined();
  await webDirectory.refresh(partnerSourceKey(webProfiles[1]));
  expect(webDirectory.getSources()).toEqual([
    expect.objectContaining({ status: "online", rows: [expect.objectContaining({ id: firstPartner.partnerId })] }),
    expect.objectContaining({ status: "accessDenied", rows: [] })
  ]);
  expect(client.state.activeProfileId).toBe(a.profileId);
  await expect(second.anonymous.partner.listPartners({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  expect((await firstManager.clients.partner.getPartner({ partnerId: firstPartner.partnerId })).partner?.description)
    .toBe("Original node profile");
}, 120_000);
