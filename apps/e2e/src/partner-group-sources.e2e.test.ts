import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  MessageRole, PartnerCapabilitiesSchema, PartnerDraftSchema, PartnerInitializationState,
  PartnerModelRouteSchema, PermissionMode, RunState, type Event, type Session
} from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, renameMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const fixtures: RealPiSystemFixture[] = [];
const disposeClients: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposeClients.splice(0).reverse()) dispose();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close({ removeRoot: true });
  vi.unstubAllGlobals();
});

it("lists paired groups without switching nodes, then opens and creates on the original node while isolating a revoked source", async () => {
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  const { mobileNetwork } = await import(new URL("../../mobile/src/network.ts", import.meta.url).href);
  const { MobileClient } = await import(new URL("../../mobile/src/mobile-client.ts", import.meta.url).href);
  const { profileFromCredential } = await import(new URL("../../mobile/src/connection-storage.ts", import.meta.url).href);
  const first = await RealPiSystemFixture.start(); fixtures.push(first);
  const second = await RealPiSystemFixture.start(); fixtures.push(second);
  expect(first.application.store).not.toBe(second.application.store);
  expect(first.application.partnerGroups).toBeDefined();
  expect(second.application.partnerGroups).toBeDefined();
  expect(first.baseUrl).not.toBe(second.baseUrl);
  expect(first.rootDirectory).not.toBe(second.rootDirectory);
  const firstManager = await first.pair("First group manager");
  const secondManager = await second.pair("Second group manager");
  const createMembers = async (manager: typeof firstManager, source: string) => {
    const members: string[] = [];
    for (const name of ["Aster", "Beryl"]) {
      const directory = (await manager.clients.partner.getPartnerDirectory({})).directory!;
      const partner = (await manager.clients.partner.createPartner({ requestId: `${source}-member-${name}`,
        expectedDirectoryRevision: directory.revision, draft: create(PartnerDraftSchema, {
          displayName: name, description: "Original-node group member", templateId: "general",
          avatar: { value: { case: "presetId", value: "orbit" } }, identitySource: `You are ${name}.`,
          usesDirectoryDefaults: false, capabilities: create(PartnerCapabilitiesSchema, {
            modelChain: [create(PartnerModelRouteSchema, { backendId: "pi", providerId: REAL_PI_PROVIDER_ID,
              modelId: REAL_PI_MODEL_ID, fastMode: false })], permissionMode: PermissionMode.AUTO, planMode: false
          })
        }) })).partner!;
      expect(partner.initializationState).toBe(PartnerInitializationState.READY);
      members.push(partner.partnerId);
    }
    return members;
  };
  const firstMembers = await createMembers(firstManager, "first");
  const secondMembers = await createMembers(secondManager, "second");
  const createGroup = async (manager: typeof firstManager, memberIds: string[], requestId: string) => {
    const directory = await manager.clients.partnerGroup.listPartnerGroups({});
    return (await manager.clients.partnerGroup.createPartnerGroup({ requestId, name: "Shared group name",
      memberIds, expectedDirectoryRevision: directory.revision })).group!;
  };
  const firstGroup = await createGroup(firstManager, firstMembers, "first-source-group");
  const secondGroup = await createGroup(secondManager, secondMembers, "second-source-group");
  const pairPhone = async (fixture: RealPiSystemFixture) => {
    const names = { defaultDisplayName: "Group source phone" };
    const begun = await mobileNetwork.requestPairing(fixture.baseUrl, "Group source phone", "android", names);
    return (await mobileNetwork.completePairing(fixture.baseUrl, begun.challengeId,
      fixture.pairingCode(begun.challengeId), "Group source phone", "android", names)).credential;
  };
  const a = await pairPhone(first), b = await pairPhone(second);
  const profiles = [profileFromCredential(a), profileFromCredential(b)];
  const credentials = new Map([[a.profileId, a], [b.profileId, b]]);
  const selections = new Map<string, string>();
  const storage = {
    loadConnectionIndex: async () => ({ profiles, automaticProfileId: a.profileId }),
    loadCredential: async (id: string) => credentials.get(id), saveConnection: async () => undefined,
    deleteCredential: async (id: string) => { credentials.delete(id); }, deleteConnection: async () => undefined,
    saveAutomaticProfile: async () => undefined, loadPending: async () => [], savePending: async () => undefined,
    loadSelection: async (id: string) => selections.get(id), saveSelection: async (id: string, selected?: string) => {
      if (selected) selections.set(id, selected); else selections.delete(id);
    }
  };
  let sequence = 0;
  const client = new MobileClient(mobileNetwork, storage, { scan: async () => [] },
    () => `group-source-operation-${++sequence}`, "android");
  disposeClients.push(() => client.dispose());
  await client.start();
  expect(client.state.activeProfileId).toBe(a.profileId);

  // A genuine hidden group turn allocates Store positions that the paired
  // Mobile Owner never receives, even as its ordinary task stays on an anchor.
  const ordinaryId = sessionIdFrom(await submit(firstManager.clients.operation, firstManager.connectionId, createSessionMutation({
    backendId: "pi", targetId: "workspace-real-pi", displayName: "Ordinary anchored task",
    providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
  })));
  const generation = BigInt(first.application.store.getSession(ordinaryId).descriptor.binding.generation);
  const runId = queueRunIdFrom(await submit(firstManager.clients.operation, firstManager.connectionId,
    sendInputMutation(ordinaryId, generation, "An ordinary task with retained history")));
  await waitFor(() => firstManager.clients.run.getRun({ runId }), result => result.run?.state === RunState.SUCCEEDED,
    "ordinary task with a durable answer", 30_000);
  await waitFor(async () => client.state.owner?.sessions.some((session: Session) => session.sessionId === ordinaryId), Boolean,
    "ordinary task adopted by Mobile", 15_000);
  await client.select(ordinaryId);
  await waitFor(async () => client.state.liveStatus, status => status === "streaming", "confirmed Mobile Owner stream", 15_000);
  const anchor = (client.state.detail?.timeline as readonly Event[] | undefined)?.find(event =>
    event.payload?.kind.case === "messageCompleted" && event.payload.kind.value.role === MessageRole.ASSISTANT);
  expect(anchor?.eventId).toBeDefined();
  await client.around(anchor!.eventId);
  const originalWindow = client.state.window, originalBefore = client.state.before;
  expect(originalWindow?.map((event: Event) => event.eventId)).toContain(anchor!.eventId);
  expect(originalBefore?.opaqueToken).toBeTruthy();
  const resume = client.state.owner!.resumeCursor!;
  const sent = await firstManager.clients.partnerGroup.sendPartnerGroupMessage({ groupId: firstGroup.id,
    expectedRevision: firstGroup.revision, clientId: "source-group-hidden-owner-event", text: "Please answer from the private group task.",
    mentions: { partnerIds: [firstMembers[0]!] } });
  expect(sent.message).toBeDefined();
  const store = first.application.store;
  const hidden = await waitFor(async () => store.listEvents({ afterCursor: resume.sequence, limit: 500 }).find(event =>
    event.payload.type === "message_complete" && event.payload.role === "assistant" && event.sessionId !== undefined
    && first.application.partnerGroupRuntime?.isGroupSession(event.sessionId)), Boolean, "hidden Partner group assistant completion", 30_000);
  if (!hidden) throw new Error("The native Partner group did not persist its expected hidden event.");
  const renamed = "Ordinary task after the group turn";
  await submit(firstManager.clients.operation, firstManager.connectionId, renameMutation(ordinaryId, renamed));
  const changed = store.listEvents({ sessionId: ordinaryId, afterCursor: hidden.globalCursor, limit: 100 })
    .find(event => event.payload.type === "session_changed");
  expect(changed?.globalCursor).toBeGreaterThan(hidden.globalCursor);
  const projected: Event[] = [];
  const replay = new AbortController();
  try {
    for await (const event of mobileNetwork.streamOwner(a, resume, AbortSignal.any([replay.signal, AbortSignal.timeout(15_000)]))) {
      projected.push(event);
      if (event.eventId === changed!.id) break;
    }
  } finally { replay.abort(); }
  expect(projected.at(-1)?.eventId).toBe(changed!.id);
  expect(projected.some(event => event.identity?.sessionId === hidden.sessionId || event.cursor?.sequence === hidden.globalCursor)).toBe(false);
  await waitFor(async () => client.state.owner?.sessions.find((session: Session) => session.sessionId === ordinaryId)?.displayName,
    title => title === renamed, "later visible Owner event adopted by the original Mobile task", 15_000);
  expect(client.state.window).toBe(originalWindow);
  expect(client.state.before).toEqual(originalBefore);
  expect(client.state.selectedId).toBe(ordinaryId);

  const signal = new AbortController().signal;
  const sourceA = await client.partnerGroupRosterSourceTransport(a.profileId, signal);
  const sourceB = await client.partnerGroupRosterSourceTransport(b.profileId, signal);
  const catalogA = await sourceA.list(signal), catalogB = await sourceB.list(signal);
  expect(sourceA.sourceKey).not.toBe(sourceB.sourceKey);
  expect(sourceA.receiptScope).not.toBe(sourceB.receiptScope);
  expect(catalogA.groups).toEqual([expect.objectContaining({ id: firstGroup.id, name: "Shared group name",
    members: firstMembers.map(partnerId => expect.objectContaining({ partnerId })) })]);
  expect(catalogB.groups).toEqual([expect.objectContaining({ id: secondGroup.id, name: "Shared group name",
    members: secondMembers.map(partnerId => expect.objectContaining({ partnerId })) })]);
  expect(client.state.activeProfileId).toBe(a.profileId);

  const opened = await client.openPartnerGroupRosterSource(b.profileId, secondGroup.id, signal);
  expect(opened).toMatchObject({ sourceKey: sourceB.sourceKey, receiptScope: sourceB.receiptScope,
    profileId: b.profileId, groupId: secondGroup.id });
  expect(client.state.activeProfileId).toBe(b.profileId);
  expect(client.partnerGroupSourceClaimCurrent(opened)).toBe(true);
  const openedApi = client.partnerGroupApi();
  expect(openedApi?.ownerKey).toBe(opened.ownerKey);
  expect((await openedApi.get(secondGroup.id, undefined, signal)).detail?.group).toMatchObject({
    id: secondGroup.id, members: secondMembers.map(partnerId => expect.objectContaining({ partnerId }))
  });

  const creation = await client.openPartnerGroupRosterSource(b.profileId, undefined, signal);
  expect(creation).toMatchObject({ sourceKey: sourceB.sourceKey, receiptScope: sourceB.receiptScope, profileId: b.profileId });
  expect(creation.groupId).toBeUndefined();
  expect(client.partnerGroupSourceClaimCurrent(creation)).toBe(true);
  expect(client.partnerGroupReceiptScope()).toBe(sourceB.receiptScope);
  const creationApi = client.partnerGroupApi();
  expect(creationApi?.ownerKey).toBe(creation.ownerKey);
  const freshDirectory = await creationApi.list(signal);
  expect(freshDirectory.groups.map((group: { id: string }) => group.id)).toEqual([secondGroup.id]);
  const requestId = "mobile-original-source-group-create";
  const created = await creationApi.create(freshDirectory.revision!.value, "Created on second source",
    secondMembers, requestId, signal);
  expect((await creationApi.lookup(requestId, signal)).group?.id).toBe(created.id);
  expect((await secondManager.clients.partnerGroup.getPartnerGroup({ groupId: created.id })).detail?.group)
    .toMatchObject({ id: created.id, name: "Created on second source",
      members: secondMembers.map(partnerId => expect.objectContaining({ partnerId })) });
  expect((await firstManager.clients.partnerGroup.getPartnerGroupCreation({ requestId })).group).toBeUndefined();
  await expect(firstManager.clients.partnerGroup.getPartnerGroup({ groupId: created.id }))
    .rejects.toMatchObject({ code: Code.NotFound });
  expect((await firstManager.clients.partnerGroup.listPartnerGroups({})).groups.map(group => group.id)).toEqual([firstGroup.id]);
  expect((await (await client.partnerGroupRosterSourceTransport(b.profileId, signal)).list(signal)).groups.map((group: { id: string }) => group.id))
    .toEqual(expect.arrayContaining([secondGroup.id, created.id]));

  const returned = await client.openPartnerGroupRosterSource(a.profileId, firstGroup.id, signal);
  expect(returned).toMatchObject({ sourceKey: sourceA.sourceKey, receiptScope: sourceA.receiptScope,
    profileId: a.profileId, groupId: firstGroup.id });
  expect(client.state.activeProfileId).toBe(a.profileId);
  expect(client.partnerGroupSourceClaimCurrent(returned)).toBe(true);
  expect(client.partnerGroupSourceClaimCurrent(creation)).toBe(false);
  second.application.connections.revoke(b.connectionId);
  await expect(client.partnerGroupRosterSourceTransport(b.profileId, signal)).rejects.toBeDefined();
  expect(credentials.has(b.profileId)).toBe(false);
  expect(credentials.has(a.profileId)).toBe(true);
  expect(client.state.activeProfileId).toBe(a.profileId);
  const surviving = await client.partnerGroupRosterSourceTransport(a.profileId, signal);
  expect((await surviving.list(signal)).groups.map((group: { id: string }) => group.id)).toEqual([firstGroup.id]);
  expect((await client.partnerGroupApi().get(firstGroup.id, undefined, signal)).detail?.group?.id).toBe(firstGroup.id);
  await expect(second.anonymous.partnerGroup.listPartnerGroups({})).rejects.toMatchObject({ code: Code.Unauthenticated });
}, 120_000);
