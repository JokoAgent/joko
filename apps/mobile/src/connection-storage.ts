import type { PairedCredential } from "./network";

export interface MobileConnectionProfile {
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly displayName: string;
}

export interface MobileConnectionIndex {
  readonly profiles: readonly MobileConnectionProfile[];
  readonly automaticProfileId?: string;
}

export interface PendingOperation {
  readonly operationId: string;
  readonly connectionId: string;
  readonly kind: "create" | "send" | "logout" | "revoke" | "rename" | "pin" | "archive" | "delete"
    | "message-delete" | "queue-cancel" | "queue-edit-lock" | "queue-edit"
    | "queue-interaction-lock" | "queue-reorder" | "interaction-resolve" | "interaction-dismiss"
    | "session-model" | "session-permission" | "session-plan" | "session-compact";
  readonly sessionId?: string;
  readonly eventId?: string;
  readonly queueItemId?: string;
  readonly interactionId?: string;
  readonly interactionGeneration?: string;
  readonly interactionRevision?: string;
  readonly interactionDraftKind?: "question" | "plan";
  readonly targetConnectionId?: string;
  readonly targetDeviceId?: string;
  readonly state: "unknown" | "accepted";
}

export interface MobileStorage {
  loadConnectionIndex(): Promise<MobileConnectionIndex>;
  loadCredential(profileId: string): Promise<PairedCredential | undefined>;
  saveConnection(credential: PairedCredential): Promise<void>;
  deleteCredential(profileId: string): Promise<void>;
  deleteConnection(profileId: string): Promise<void>;
  saveAutomaticProfile(profileId?: string): Promise<void>;
  loadPending(): Promise<PendingOperation[]>;
  savePending(items: readonly PendingOperation[]): Promise<void>;
  loadSelection(profileId: string): Promise<string | undefined>;
  saveSelection(profileId: string, sessionId?: string): Promise<void>;
}

export interface MobilePlainStorageDriver {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface MobileSecureStorageDriver extends MobilePlainStorageDriver {
  isAvailable(): Promise<boolean>;
}

export type MobileCredentialStorageFailure = "unavailable" | "unreadable";

export class MobileCredentialStorageError extends Error {
  constructor(readonly failure: MobileCredentialStorageFailure, message: string) {
    super(message);
    this.name = "MobileCredentialStorageError";
  }
}

const profilesKey = "joko.mobile.connection-profiles.v1";
const automaticTargetKey = "joko.mobile.automatic-target.v1";
const connectionMutationIntentKey = "joko.mobile.connection-mutation-intent.v1";
const credentialPrefix = "joko.mobile.connection-credential.v1.";
const pendingKey = "joko.mobile.pending.v1";
const selectionsKey = "joko.mobile.selections.v1";
const maximumProfiles = 256;

type ConnectionMutationIntent =
  | { readonly kind: "upsert"; readonly profile: MobileConnectionProfile }
  | { readonly kind: "delete-credential" | "delete-connection"; readonly profileId: string };

export function createMobileStorage(
  plain: MobilePlainStorageDriver,
  secure: MobileSecureStorageDriver
): MobileStorage {
  let mutationTail = Promise.resolve();
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(action, action);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const readProfiles = async (): Promise<MobileConnectionProfile[]> => {
    const raw = await plain.getItem(profilesKey);
    if (raw === null) return [];
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("The saved Joko connection list is damaged."); }
    if (!Array.isArray(value) || value.length > maximumProfiles) {
      throw new Error("The saved Joko connection list is damaged.");
    }
    const profiles = value.map(readProfile);
    const profileIds = new Set<string>();
    const connectionIds = new Set<string>();
    for (const profile of profiles) {
      if (profileIds.has(profile.profileId) || connectionIds.has(profile.connectionId)) {
        throw new Error("The saved Joko connection list contains duplicate identities.");
      }
      profileIds.add(profile.profileId);
      connectionIds.add(profile.connectionId);
    }
    return profiles;
  };

  const writeProfiles = async (profiles: readonly MobileConnectionProfile[]): Promise<void> => {
    if (profiles.length > maximumProfiles) throw new Error("Too many Joko connections are saved on this device.");
    await plain.setItem(profilesKey, JSON.stringify(profiles));
  };

  const secureAvailable = async (): Promise<void> => {
    let available = false;
    try { available = await secure.isAvailable(); }
    catch { /* normalized below without exposing platform details */ }
    if (!available) {
      throw new MobileCredentialStorageError(
        "unavailable",
        "Protected credential storage is unavailable. The saved connection was kept, but it cannot be used right now."
      );
    }
  };

  const readCredential = async (profileId: string): Promise<PairedCredential | undefined> => {
    assertLocalId(profileId, "connection profile");
    await secureAvailable();
    let raw: string | null;
    try { raw = await secure.getItem(credentialKey(profileId)); }
    catch {
      throw new MobileCredentialStorageError(
        "unavailable",
        "Protected credential storage could not be read. The saved connection was kept."
      );
    }
    if (raw === null) return undefined;
    try {
      const credential = readCredentialValue(JSON.parse(raw));
      if (credential.profileId !== profileId) throw new Error("profile mismatch");
      return credential;
    } catch {
      throw new MobileCredentialStorageError(
        "unreadable",
        "This saved Joko credential is damaged. Forget this connection in Joko and pair it again."
      );
    }
  };

  const recoverConnectionMutation = async (): Promise<void> => {
    const raw = await plain.getItem(connectionMutationIntentKey);
    if (raw === null) return;
    let intent: ConnectionMutationIntent;
    try { intent = readConnectionMutationIntent(JSON.parse(raw)); }
    catch {
      await plain.removeItem(connectionMutationIntentKey);
      return;
    }
    try {
      if (intent.kind === "upsert") {
        const credential = await readCredential(intent.profile.profileId);
        if (credential === undefined || !credentialMatchesProfile(credential, intent.profile)) {
          await secure.removeItem(credentialKey(intent.profile.profileId)).catch(() => undefined);
          await plain.removeItem(connectionMutationIntentKey);
          return;
        }
        const profiles = await readProfiles();
        await writeProfiles(upsertProfile(profiles, intent.profile));
      } else {
        await secureAvailable();
        try { await secure.removeItem(credentialKey(intent.profileId)); }
        catch {
          throw new MobileCredentialStorageError(
            "unavailable",
            "The saved credential could not be removed from protected storage."
          );
        }
        if (intent.kind === "delete-connection") {
          const profiles = await readProfiles();
          await writeProfiles(profiles.filter((profile) => profile.profileId !== intent.profileId));
        }
        const automatic = await plain.getItem(automaticTargetKey);
        if (automatic === intent.profileId) await plain.removeItem(automaticTargetKey);
      }
      await plain.removeItem(connectionMutationIntentKey);
    } catch (error) {
      if (error instanceof MobileCredentialStorageError && error.failure === "unavailable") return;
      throw error;
    }
  };

  const deleteStoredCredential = async (
    profileId: string,
    kind: Extract<ConnectionMutationIntent, { readonly profileId: string }>["kind"]
  ): Promise<void> => {
    assertLocalId(profileId, "connection profile");
    // Do not change the public profile or automatic target until protected
    // storage is available. The durable intent completes any later partial
    // failure in one direction only: toward the requested deletion.
    await secureAvailable();
    await plain.setItem(connectionMutationIntentKey, JSON.stringify({ kind, profileId }));
    await recoverConnectionMutation();
    if (await plain.getItem(connectionMutationIntentKey) !== null) {
      throw new MobileCredentialStorageError(
        "unavailable",
        "The saved credential could not be removed from protected storage."
      );
    }
  };

  return {
    loadConnectionIndex: () => serialized(async () => {
      await recoverConnectionMutation();
      const [profiles, automaticProfileId] = await Promise.all([
        readProfiles(),
        plain.getItem(automaticTargetKey)
      ]);
      if (automaticProfileId !== null) assertLocalId(automaticProfileId, "automatic connection target");
      return { profiles, ...(automaticProfileId === null ? {} : { automaticProfileId }) };
    }),

    loadCredential: (profileId) => serialized(async () => {
      await recoverConnectionMutation();
      return readCredential(profileId);
    }),

    saveConnection: (credential) => serialized(async () => {
      const profile = profileFromCredential(credential);
      await secureAvailable();
      await plain.setItem(connectionMutationIntentKey, JSON.stringify({ kind: "upsert", profile }));
      try {
        await secure.setItem(credentialKey(profile.profileId), JSON.stringify(credential));
      } catch {
        throw new MobileCredentialStorageError(
          "unavailable",
          "The new Joko credential could not be saved in protected storage."
        );
      }
      const profiles = await readProfiles();
      await writeProfiles(upsertProfile(profiles, profile));
      await plain.removeItem(connectionMutationIntentKey);
    }),

    deleteCredential: (profileId) => serialized(() => deleteStoredCredential(profileId, "delete-credential")),

    deleteConnection: (profileId) => serialized(() => deleteStoredCredential(profileId, "delete-connection")),

    saveAutomaticProfile: (profileId) => serialized(async () => {
      if (profileId === undefined) {
        await plain.removeItem(automaticTargetKey);
        return;
      }
      assertLocalId(profileId, "automatic connection target");
      const profiles = await readProfiles();
      if (!profiles.some((profile) => profile.profileId === profileId)) {
        throw new Error("The automatic Joko connection target is not saved on this device.");
      }
      await plain.setItem(automaticTargetKey, profileId);
    }),

    async loadPending() {
      const raw = await plain.getItem(pendingKey);
      if (raw === null) return [];
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { throw new Error("The local operation receipt index is invalid."); }
      if (!Array.isArray(value)) throw new Error("The local operation receipt index is invalid.");
      return value.filter(isPending).slice(-64);
    },

    savePending: (items) => serialized(async () => {
      await plain.setItem(pendingKey, JSON.stringify(items.slice(-64)));
    }),

    async loadSelection(profileId) {
      assertLocalId(profileId, "connection profile");
      const selections = await readSelections(plain);
      return selections[profileId];
    },

    saveSelection: (profileId, sessionId) => serialized(async () => {
      assertLocalId(profileId, "connection profile");
      const selections = await readSelections(plain);
      if (sessionId === undefined) delete selections[profileId];
      else {
        assertLocalId(sessionId, "selected task");
        selections[profileId] = sessionId;
      }
      await plain.setItem(selectionsKey, JSON.stringify(selections));
    })
  };
}

export function profileFromCredential(credential: PairedCredential): MobileConnectionProfile {
  return readProfile({
    profileId: credential.profileId,
    origin: credential.origin,
    serverId: credential.serverId,
    connectionId: credential.connectionId,
    deviceId: credential.deviceId,
    displayName: credential.displayName
  });
}

function credentialKey(profileId: string): string {
  assertLocalId(profileId, "connection profile");
  return `${credentialPrefix}${profileId}`;
}

function upsertProfile(
  profiles: readonly MobileConnectionProfile[],
  profile: MobileConnectionProfile
): MobileConnectionProfile[] {
  return [
    ...profiles.filter((candidate) => candidate.profileId !== profile.profileId && candidate.connectionId !== profile.connectionId),
    profile
  ];
}

function credentialMatchesProfile(credential: PairedCredential, profile: MobileConnectionProfile): boolean {
  return credential.profileId === profile.profileId && credential.origin === profile.origin
    && credential.serverId === profile.serverId && credential.connectionId === profile.connectionId
    && credential.deviceId === profile.deviceId;
}

function readConnectionMutationIntent(value: unknown): ConnectionMutationIntent {
  if (!value || typeof value !== "object") throw new Error("The saved Joko connection mutation is invalid.");
  const record = value as Record<string, unknown>;
  if (record.kind === "upsert") return { kind: "upsert", profile: readProfile(record.profile) };
  if (record.kind === "delete-credential" || record.kind === "delete-connection") {
    const profileId = text(record.profileId, 128, "connection profile");
    assertLocalId(profileId, "connection profile");
    return { kind: record.kind, profileId };
  }
  throw new Error("The saved Joko connection mutation is invalid.");
}

function readProfile(value: unknown): MobileConnectionProfile {
  if (!value || typeof value !== "object") throw new Error("The saved Joko connection list is damaged.");
  const record = value as Record<string, unknown>;
  const profile = {
    profileId: text(record.profileId, 128, "connection profile"),
    origin: text(record.origin, 512, "origin"),
    serverId: text(record.serverId, 128, "server identity"),
    connectionId: text(record.connectionId, 128, "connection identity"),
    deviceId: text(record.deviceId, 128, "device identity"),
    displayName: text(record.displayName, 256, "connection name")
  };
  assertLocalId(profile.profileId, "connection profile");
  assertLocalId(profile.connectionId, "connection identity");
  assertLocalId(profile.deviceId, "device identity");
  const origin = new URL(profile.origin);
  if (origin.origin !== profile.origin || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("The saved Joko connection origin is invalid.");
  }
  return profile;
}

function readCredentialValue(value: unknown): PairedCredential {
  const profile = readProfile(value);
  const record = value as Record<string, unknown>;
  return { ...profile, authKey: text(record.authKey, 512, "credential") };
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`The saved Joko ${label} is invalid.`);
  }
  return value;
}

function assertLocalId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error(`The saved Joko ${label} is invalid.`);
}

function isPending(value: unknown): value is PendingOperation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.operationId !== "string" || typeof record.connectionId !== "string"
    || !["create", "send", "logout", "revoke", "rename", "pin", "archive", "delete", "message-delete",
      "queue-cancel", "queue-edit-lock", "queue-edit", "queue-interaction-lock", "queue-reorder",
      "interaction-resolve", "interaction-dismiss", "session-model", "session-permission", "session-plan", "session-compact"].includes(String(record.kind))
    || (record.state !== "unknown" && record.state !== "accepted")) return false;
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") return false;
  if (record.eventId !== undefined && typeof record.eventId !== "string") return false;
  if (record.queueItemId !== undefined && typeof record.queueItemId !== "string") return false;
  if (record.interactionId !== undefined && typeof record.interactionId !== "string") return false;
  if (record.interactionGeneration !== undefined && (typeof record.interactionGeneration !== "string" || !/^[1-9][0-9]*$/u.test(record.interactionGeneration))) return false;
  if (record.interactionRevision !== undefined && (typeof record.interactionRevision !== "string" || !/^[1-9][0-9]*$/u.test(record.interactionRevision))) return false;
  if (record.interactionDraftKind !== undefined && record.interactionDraftKind !== "question" && record.interactionDraftKind !== "plan") return false;
  if (record.targetConnectionId !== undefined && typeof record.targetConnectionId !== "string") return false;
  if (record.targetDeviceId !== undefined && typeof record.targetDeviceId !== "string") return false;
  if (record.kind === "logout" && typeof record.targetConnectionId !== "string") return false;
  if (record.kind === "revoke" && typeof record.targetDeviceId !== "string") return false;
  if (["rename", "pin", "archive", "delete"].includes(String(record.kind)) && typeof record.sessionId !== "string") return false;
  if (record.kind === "message-delete" && (typeof record.sessionId !== "string" || typeof record.eventId !== "string")) return false;
  if (["queue-cancel", "queue-edit-lock", "queue-edit", "queue-reorder"].includes(String(record.kind))
    && (typeof record.sessionId !== "string" || typeof record.queueItemId !== "string")) return false;
  if (record.kind === "queue-interaction-lock" && typeof record.sessionId !== "string") return false;
  if (["interaction-resolve", "interaction-dismiss"].includes(String(record.kind))
    && (typeof record.sessionId !== "string" || typeof record.interactionId !== "string"
      || typeof record.interactionGeneration !== "string" || typeof record.interactionRevision !== "string")) return false;
  if (["session-model", "session-permission", "session-plan", "session-compact"].includes(String(record.kind))
    && typeof record.sessionId !== "string") return false;
  if (!["interaction-resolve", "interaction-dismiss"].includes(String(record.kind))
    && (record.interactionId !== undefined || record.interactionGeneration !== undefined
      || record.interactionRevision !== undefined || record.interactionDraftKind !== undefined)) return false;
  return true;
}

async function readSelections(plain: MobilePlainStorageDriver): Promise<Record<string, string>> {
  const raw = await plain.getItem(selectionsKey);
  if (raw === null) return {};
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("The saved task selection index is invalid."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved task selection index is invalid.");
  const selections: Record<string, string> = {};
  for (const [profileId, sessionId] of Object.entries(value)) {
    assertLocalId(profileId, "connection profile");
    if (typeof sessionId !== "string") throw new Error("The saved task selection index is invalid.");
    assertLocalId(sessionId, "selected task");
    selections[profileId] = sessionId;
  }
  return selections;
}
