import { createHash, randomUUID } from "node:crypto";

import { MINIMAL_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../mobile/node_modules/react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("../../mobile/node_modules/expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => createHash("sha256").update(value).digest("hex")
}));
vi.mock("../../mobile/node_modules/expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => createHash("sha256").update(value).digest("hex")
}));

interface PlainDriver {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface AttachmentPolicy {
  readonly images: boolean;
  readonly files: boolean;
  readonly maximumItems: number;
  readonly maximumBytes: number;
  readonly imageMediaTypes: readonly string[];
  readonly fileMediaTypes: readonly string[];
}

interface AttachmentControls {
  readonly profileId: string;
  readonly surfaceOwnerKey: string;
  readonly policy: AttachmentPolicy;
}

interface Draft {
  readonly text: string;
  readonly atoms: readonly { readonly kind: string; readonly atomId: string; readonly text?: string }[];
  readonly attachments: readonly { readonly attachmentId: string; readonly fileName: string }[];
}

interface MobileHarness {
  readonly state: {
    readonly status: string;
    readonly activeProfileId?: string;
    readonly selectedId?: string;
    readonly owner?: { readonly sessions: readonly { readonly sessionId: string; readonly targetId: string }[] };
    readonly detail?: { readonly sessions: readonly { readonly sessionId: string }[] };
  };
  start(): Promise<void>;
  requestPairing(origin: string, deviceName: string): Promise<string>;
  pair(origin: string, code: string, deviceName: string): Promise<void>;
  select(sessionId: string): Promise<void>;
  taskIncomingShareControls(): AttachmentControls | undefined;
  dispose(): void;
}

interface ShareBatch {
  readonly status: "ready";
  readonly batchId: string;
  readonly boundProfileId?: string;
  readonly claim?: { readonly claimId: string };
  readonly items: readonly { readonly itemId: string; readonly kind: string }[];
}

interface SharePlan {
  readonly accepted: readonly { readonly itemId: string; readonly kind: string }[];
  readonly rejected: readonly { readonly reason: string }[];
}

interface ShareDriver {
  readonly supported: boolean;
  getNextBatch(): Promise<unknown | null>;
  bindBatch(batchId: string, profileId: string): Promise<unknown>;
  claimBatch(batchId: string, profileId: string, destinationKind: string, sessionId: string | null,
    targetId: string, surfaceOwnerKey: string, policyKey: string, acceptedItemIds: readonly string[]): Promise<unknown>;
  acknowledgeBatch(batchId: string, profileId: string, claimId: string): Promise<void>;
  discardBatch(batchId: string): Promise<void>;
}

interface ShareInbox {
  readonly snapshot: { readonly batch?: ShareBatch };
  refresh(): Promise<void>;
  bind(batchId: string, profileId: string): Promise<void>;
  claim(batchId: string, profileId: string,
    destination: { readonly kind: "existing_task"; readonly targetId: string; readonly sessionId: string },
    controls: AttachmentControls, plan: SharePlan): Promise<ShareBatch>;
  acknowledge(batchId: string, profileId: string, claimId: string): Promise<void>;
}

interface ComposerStore {
  readDurable(identity: { readonly profileId: string; readonly sessionId: string }): Promise<Draft | null>;
  readSnapshot(identity: { readonly profileId: string; readonly sessionId: string }): Promise<{
    readonly revision: number; readonly draft?: Draft;
  }>;
}

const { mobileNetwork } = await vi.importActual<{ mobileNetwork: unknown }>("../../mobile/src/network.js");
const { MobileClient } = await vi.importActual<{
  MobileClient: new (...args: unknown[]) => MobileHarness
}>("../../mobile/src/mobile-client.js");
const { createMobileStorage } = await vi.importActual<{
  createMobileStorage: (plain: PlainDriver, secure: PlainDriver & { isAvailable(): Promise<boolean> }) => unknown
}>("../../mobile/src/connection-storage.js");
const { MobileComposerDraftStore } = await vi.importActual<{
  MobileComposerDraftStore: new (driver: PlainDriver) => ComposerStore
}>("../../mobile/src/composer-draft-store.js");
const { MobileNewTaskDraftStore } = await vi.importActual<{
  MobileNewTaskDraftStore: new (driver: PlainDriver) => unknown
}>("../../mobile/src/new-task-draft-store.js");
const {
  MobileIncomingShareInbox, planMobileIncomingShare, commitMobileIncomingShare
} = await vi.importActual<{
  MobileIncomingShareInbox: new (driver: ShareDriver) => ShareInbox;
  planMobileIncomingShare: (batch: ShareBatch, attachments: readonly unknown[], policy: AttachmentPolicy,
    atoms: readonly unknown[]) => SharePlan;
  commitMobileIncomingShare: (request: unknown) => Promise<{
    readonly destinationKind: string; readonly draft: Draft; readonly replayed: boolean;
  }>;
}>("../../mobile/src/mobile-incoming-share.js");

const batchId = "10000000-0000-4000-8000-000000000001";
const urlItemId = "20000000-0000-4000-8000-000000000002";
const fileItemId = "30000000-0000-4000-8000-000000000003";
const textItemId = "40000000-0000-4000-8000-000000000004";
const claimId = "50000000-0000-4000-8000-000000000005";

describe("mobile incoming share through the authenticated task product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let mobile: MobileHarness | undefined;

  afterEach(async () => {
    mobile?.dispose();
    mobile = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("retains the text from a mixed share in a text-only existing task without sending, then ACKs durable replay", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [MINIMAL_PROFILE] });
    const manager = await fixture.pair("Share setup owner");
    const created = await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: MINIMAL_PROFILE.id, targetId: fixture.targetId(), displayName: "Shared task"
    }));
    const sessionId = sessionIdFrom(created);
    const targetId = fixture.targetId();
    const timelineBefore = await manager.clients.session.listSessionTimeline({ sessionId, limit: 120 });

    const localStorage = memoryDriver();
    const secureStorage = { ...memoryDriver(), isAvailable: async () => true };
    const draftStorage = memoryDriver();
    mobile = new MobileClient(mobileNetwork, createMobileStorage(localStorage, secureStorage),
      { scan: async () => [] }, randomUUID, "android");
    await mobile.start();
    const challengeId = await mobile.requestPairing(fixture.baseUrl, "Share phone");
    await mobile.pair(fixture.baseUrl, fixture.pairingCode(challengeId), "Share phone");
    await mobile.select(sessionId);
    expect(mobile.state.status).toBe("connected");
    expect(mobile.state.selectedId).toBe(sessionId);
    expect(mobile.state.detail?.sessions).toEqual([expect.objectContaining({ sessionId })]);
    expect(mobile.state.owner?.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId, targetId })
    ]));
    const profileId = mobile.state.activeProfileId;
    const controls = mobile.taskIncomingShareControls();
    if (!profileId || !controls) throw new Error("The authenticated mobile share owner is unavailable.");
    expect(controls.profileId).toBe(profileId);
    expect(controls.policy).toMatchObject({ images: false, files: false, maximumItems: 0 });

    // Windows has no installed Android/iOS share extension. This driver models only the
    // native inbox/claim/ACK boundary; the service, mobile owner, and draft stores are real.
    const rawItems = [
      textItem(urlItemId, 0, "https://example.test/issue/42", "url"),
      { state: "ready", kind: "file", itemId: fileItemId, ordinal: 1,
        uri: "file:///private/joko-share/report.txt", fileName: "report.txt", mediaType: "text/plain",
        byteSize: 6, sha256Hex: digest("report") },
      textItem(textItemId, 2, "Please review this report.", "text")
    ];
    let nativeBatch: Record<string, unknown> | undefined = {
      status: "ready", batchId, orderKey: `batch-${"0".repeat(20)}-${batchId}`,
      createdAtUnixMs: 1, overflowCount: 0, items: rawItems
    };
    let acknowledgeAttempts = 0;
    const driver: ShareDriver = {
      supported: true,
      getNextBatch: async () => nativeBatch ?? null,
      bindBatch: async (id, ownerProfileId) => {
        if (id !== batchId || !nativeBatch) throw new Error("The native batch changed.");
        nativeBatch = { ...nativeBatch, boundProfileId: ownerProfileId };
        return nativeBatch;
      },
      claimBatch: async (id, ownerProfileId, destinationKind, ownerSessionId, ownerTargetId,
        surfaceOwnerKey, policyKey, acceptedItemIds) => {
        if (id !== batchId || nativeBatch?.boundProfileId !== ownerProfileId) {
          throw new Error("The native batch owner changed.");
        }
        const proofs = acceptedItemIds.map((itemId) => {
          const item = rawItems.find((candidate) => candidate.itemId === itemId);
          if (!item) throw new Error("The native share item disappeared.");
          return { itemId, kind: item.kind, byteSize: item.byteSize, sha256Hex: item.sha256Hex,
            ...(item.kind === "file" ? { fileName: item.fileName, mediaType: item.mediaType } : {}) };
        });
        nativeBatch = { ...nativeBatch, claim: {
          claimId, destinationKind, ...(ownerSessionId === null ? {} : { sessionId: ownerSessionId }),
          targetId: ownerTargetId, surfaceOwnerKey, policyKey, acceptedItemIds, acceptedItemProofs: proofs
        } };
        return nativeBatch;
      },
      acknowledgeBatch: async (id, ownerProfileId, ownerClaimId) => {
        if (id !== batchId || nativeBatch?.boundProfileId !== ownerProfileId
          || (nativeBatch.claim as { claimId?: string } | undefined)?.claimId !== ownerClaimId) {
          throw new Error("The native claim changed.");
        }
        const persisted = await new MobileComposerDraftStore(draftStorage).readDurable({ profileId, sessionId });
        expect(persisted?.atoms.map((atom) => atom.kind === "pasted-text" ? atom.text : "")).toEqual([
          "https://example.test/issue/42", "Please review this report."
        ]);
        expect(persisted?.attachments).toEqual([]);
        expect(fixture!.adapter().sendCalls).toHaveLength(0);
        acknowledgeAttempts += 1;
        if (acknowledgeAttempts === 1) throw new Error("Native ACK result is uncertain.");
        nativeBatch = undefined;
      },
      discardBatch: async () => { throw new Error("The reviewed share must not be discarded."); }
    };
    const inbox = new MobileIncomingShareInbox(driver);
    await inbox.refresh();
    await inbox.bind(batchId, profileId);
    const bound = inbox.snapshot.batch;
    if (!bound) throw new Error("The bound native batch disappeared.");
    const destination = { kind: "existing_task" as const, targetId, sessionId };
    const composerDraftStore = new MobileComposerDraftStore(draftStorage);
    const plan = planMobileIncomingShare(bound, [], controls.policy, []);
    expect(plan.accepted.map((item) => item.kind)).toEqual(["url", "text"]);
    expect(plan.rejected).toMatchObject([{ itemId: fileItemId }]);
    const claimed = await inbox.claim(batchId, profileId, destination, controls, plan);
    const newTaskDraftStore = new MobileNewTaskDraftStore(draftStorage);
    let stageCalls = 0;
    const attachmentFiles = {
      removeOwnedBytes: async () => undefined,
      stageCandidates: async (_profile: string, _current: readonly unknown[], _policy: AttachmentPolicy,
        candidates: readonly { readonly fileName: string; readonly mediaType: string; readonly byteSize: number;
          readonly sha256Hex: string }[], newId: () => string) => {
        stageCalls += 1;
        return candidates.map((candidate) => ({
          state: "local", kind: "file", attachmentId: newId(), fileName: candidate.fileName,
          mediaType: candidate.mediaType, byteSize: candidate.byteSize,
          sha256Hex: candidate.sha256Hex, capturedAtUnixMs: 1
        }));
      }
    };
    const authority = async (): Promise<AttachmentControls> => {
      const latest = mobile!.taskIncomingShareControls();
      if (mobile!.state.status !== "connected" || mobile!.state.activeProfileId !== profileId
        || mobile!.state.selectedId !== sessionId
        || mobile!.state.owner?.sessions.filter((session) => session.sessionId === sessionId
          && session.targetId === targetId).length !== 1
        || !latest || latest.surfaceOwnerKey !== controls.surfaceOwnerKey) {
        throw new Error("The authenticated mobile task authority changed.");
      }
      return latest;
    };
    const commit = (store: ComposerStore, allowFreshClaim: boolean) => commitMobileIncomingShare({
      batch: claimed, profileId, destination, controls, newTaskDraftStore,
      composerDraftStore: store, attachmentFiles, validateAuthority: authority,
      acknowledge: () => inbox.acknowledge(batchId, profileId, claimId), allowFreshClaim
    });
    await expect(commit(composerDraftStore, true)).rejects.toThrow(/ACK result is uncertain/u);
    expect(inbox.snapshot.batch?.claim?.claimId).toBe(claimId);
    expect(stageCalls).toBe(0);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    const recoveredStore = new MobileComposerDraftStore(draftStorage);
    const recovered = await commit(recoveredStore, false);
    expect(recovered).toMatchObject({ destinationKind: "existing_task", replayed: true });
    expect(recovered.draft.atoms).toHaveLength(2);
    expect(stageCalls).toBe(0);
    expect(acknowledgeAttempts).toBe(2);
    expect(inbox.snapshot.batch).toBeUndefined();
    expect((await recoveredStore.readDurable({ profileId, sessionId }))?.attachments).toHaveLength(0);
    const timelineAfter = await manager.clients.session.listSessionTimeline({ sessionId, limit: 120 });
    expect(timelineAfter.events.map((event) => event.eventId)).toEqual(timelineBefore.events.map((event) => event.eventId));
    expect(fixture.adapter().sendCalls).toHaveLength(0);
  }, 60_000);
});

function memoryDriver(): PlainDriver {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); }
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function textItem(itemId: string, ordinal: number, text: string, kind: "text" | "url") {
  return { state: "ready", kind, itemId, ordinal, text, byteSize: new TextEncoder().encode(text).byteLength,
    sha256Hex: digest(text) };
}
