import type { PairedCredential } from "./network";
import { parseSavedConnectionEntries, type SavedConnectionEntries } from '@joko/connection-transport/entries';
import { parseDeviceAuthorizationDraft, parseDeviceTransportRequestDraft, type DeviceTransportRequestDraft, type DeviceAuthorizationDraft } from '@joko/connection-transport/device-authorization';
import { normalizeEndpointTransport, rememberEndpointTransport, retainIrohRelayRequest, selectEndpointTransport, trustedEndpointTransport, type EndpointTransportKind, type RetainedIrohRelayRequest } from '@joko/connection-transport/trust';

export interface MobileConnectionProfile {
  readonly entryId?: string;
  readonly endpointPublicKey?: string;
  readonly transportKind?: EndpointTransportKind;
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
  readonly taskJoinId?: string;
  readonly kind: "create" | "send" | "logout" | "revoke" | "device-rename" | "rename" | "pin" | "archive" | "delete"
    | "message-delete" | "queue-cancel" | "queue-edit-lock" | "queue-edit"
    | "queue-interaction-lock" | "queue-reorder" | "interaction-resolve" | "interaction-dismiss"
    | "session-model" | "session-permission" | "session-plan" | "session-compact" | "session-branch"
    | "session-shell" | "session-reset" | "session-review" | "session-clone" | "session-fork" | "session-side-chat" | "session-rewind" | "workspace-rewind"
    | "task-tag"
    | "objective-set" | "objective-pause" | "objective-resume" | "objective-clear"
    | "collaboration-enable" | "collaboration-create" | "collaboration-release" | "collaboration-archive" | "collaboration-end"
    | "schedule-run" | "schedule-enable" | "schedule-run-restart" | "schedule-run-read"
    | "schedule-runs-read" | "schedule-all-read" | "schedule-run-delete"
    | "schedule-create" | "schedule-update" | "schedule-delete" | "schedule-promote"
    | "schedule-clone" | "schedule-project-remove" | "schedule-project-reconcile" | "voice-settings" | "model-favorite" | "model-source-target"
    | "extension-enabled" | "extension-sidebar" | "extension-package-adopt" | "extension-package-remove" | "extension-settings-routing" | "extension-settings-credential-clear" | "extension-settings-directory"
    | "extension-setup-begin" | "extension-setup-interaction" | "extension-setup-credential"
    | "extension-setup-complete" | "extension-setup-cancel" | "extension-setup-revoke";
  readonly sessionId?: string;
  readonly eventId?: string;
  readonly backendId?: string;
  readonly sourceGeneration?: string;
  readonly workspaceId?: string;
  readonly changeSetId?: string;
  readonly queueItemId?: string;
  readonly interactionId?: string;
  readonly interactionGeneration?: string;
  readonly interactionRevision?: string;
  readonly interactionDraftKind?: "question" | "plan";
  readonly targetConnectionId?: string;
  readonly targetDeviceId?: string;
  readonly scheduleId?: string;
  readonly triggerId?: string;
  readonly targetId?: string;
  readonly extensionId?: string;
  readonly extensionRevision?: string;
  readonly extensionResourceId?: string;
  readonly state: "unknown" | "accepted";
}

export interface MobileStorage {
  readConnectionEntries?(profile: MobileConnectionProfile): Promise<SavedConnectionEntries | undefined>;
  writeConnectionEntries?(profile: MobileConnectionProfile, entries: SavedConnectionEntries): Promise<void>;
  readDeviceAuthorization?(): Promise<DeviceAuthorizationDraft | undefined>;
  writeDeviceAuthorization?(draft: DeviceAuthorizationDraft | undefined): Promise<void>;
  readDeviceTransportRequest?(): Promise<DeviceTransportRequestDraft | undefined>;
  writeDeviceTransportRequest?(draft: DeviceTransportRequestDraft | undefined): Promise<void>;
  loadConnectionIndex(): Promise<MobileConnectionIndex>;
  loadCredential(profileId: string): Promise<PairedCredential | undefined>;
  /** Reads only the SDK locator, before the anonymous endpoint proof. */
  loadEndpointTransport?(profile: MobileConnectionProfile): Promise<void>;
  saveEndpointTransport?(profile: MobileConnectionProfile): Promise<void>;
  claimIrohRelayRequest?(profile: MobileConnectionProfile, input: RetainedIrohRelayRequest): Promise<RetainedIrohRelayRequest>;
  confirmIrohRelayRequest?(profile: MobileConnectionProfile, input: RetainedIrohRelayRequest, expiresAt: number): Promise<void>;
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
const transportPrefix = "joko.mobile.connection-transport.v1.";
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

  const writeEndpointTransport = async (profile: MobileConnectionProfile): Promise<void> => {
    if (profile.transportKind === undefined || profile.transportKind === 'https' || profile.transportKind === 'webrtc') return;
    if (profile.endpointPublicKey === undefined) throw new Error('The selected transport requires a trusted node public key.');
    await secureAvailable();
    const transport = trustedEndpointTransport(profile.origin, profile.endpointPublicKey, profile.transportKind);
    await secure.setItem(`${transportPrefix}${profile.profileId}`, JSON.stringify({ owner: transportOwner(profile), transport }));
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
        try { await secure.removeItem(`${transportPrefix}${intent.profileId}`); await secure.removeItem(`joko.mobile.entries.v1.${intent.profileId}`); }
        catch { throw new MobileCredentialStorageError('unavailable', 'The private transport locator could not be removed from protected storage.'); }
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
    readConnectionEntries: profile => serialized(async () => {
      const owner = entryOwner(profile); await secureAvailable();
      const raw = await secure.getItem(`joko.mobile.entries.v1.${profile.profileId}`);
      return raw === null ? undefined : parseSavedConnectionEntries(JSON.parse(raw), owner);
    }),
    writeConnectionEntries: (profile, entries) => serialized(async () => {
      const owner = entryOwner(profile); await secureAvailable();
      await secure.setItem(`joko.mobile.entries.v1.${profile.profileId}`, JSON.stringify(parseSavedConnectionEntries(entries, owner)));
    }),
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
    saveEndpointTransport: profile => serialized(() => writeEndpointTransport(profile)),

    claimIrohRelayRequest: (profile, input) => serialized(async () => {
      const key = irohRelayRequestKey(profile, input), raw = await plain.getItem(key);
      const retained = retainIrohRelayRequest(raw === null ? undefined : JSON.parse(raw), input);
      await plain.setItem(key, JSON.stringify(retained)); return retained;
    }),
    confirmIrohRelayRequest: (profile, input, expiresAt) => serialized(async () => {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > Date.now() + 86_400_000) throw new Error('The relay invitation receipt has an invalid expiry.');
      const key = irohRelayRequestKey(profile, input), raw = await plain.getItem(key);
      if (raw === null) throw new Error('The original relay invitation request is unavailable.');
      const existing: unknown = JSON.parse(raw);
      if (existing === null || typeof existing !== 'object' || (existing as { requestId?: unknown }).requestId !== input.requestId
        || (existing as { expiresAt?: unknown }).expiresAt !== undefined && (existing as { expiresAt?: unknown }).expiresAt !== expiresAt) throw new Error('The relay invitation receipt conflicts with its retained request.');
      const retained = retainIrohRelayRequest(existing, input);
      if (retained.requestId !== input.requestId) throw new Error('The relay invitation receipt belongs to another request.');
      await plain.setItem(key, JSON.stringify({ ...retained, expiresAt }));
    }),

    loadEndpointTransport: (profile) => serialized(async () => {
      if (profile.transportKind === undefined || profile.transportKind === 'https') {
        if (profile.endpointPublicKey !== undefined) selectEndpointTransport(profile.origin, profile.endpointPublicKey, 'https');
        return;
      }
      if (profile.endpointPublicKey === undefined) throw new Error('The selected transport requires a trusted node public key.');
      if (profile.transportKind === 'webrtc') { selectEndpointTransport(profile.origin, profile.endpointPublicKey, 'webrtc'); return; }
      await secureAvailable();
      const raw = await secure.getItem(`${transportPrefix}${profile.profileId}`);
      if (raw === null) throw new MobileCredentialStorageError('unreadable', 'The private transport locator is unavailable. Import its trusted invitation again.');
      let parsed: { owner?: unknown; transport?: unknown };
      try { parsed = JSON.parse(raw) as typeof parsed; }
      catch { throw new MobileCredentialStorageError('unreadable', 'The protected transport locator is invalid.'); }
      if (parsed.owner !== transportOwner(profile)) throw new MobileCredentialStorageError('unreadable', 'The protected locator does not match this connection.');
      const transport = normalizeEndpointTransport(parsed.transport);
      if (transport.kind !== profile.transportKind) throw new MobileCredentialStorageError('unreadable', 'The protected locator belongs to another transport.');
      rememberEndpointTransport(profile.origin, profile.endpointPublicKey, transport);
    }),

    readDeviceTransportRequest: () => serialized(async () => {
      await secureAvailable(); const raw = await secure.getItem('joko.device-transport-request-v1');
      return raw === null ? undefined : parseDeviceTransportRequestDraft(JSON.parse(raw));
    }),
    writeDeviceTransportRequest: draft => serialized(async () => {
      await secureAvailable();
      if (draft) await secure.setItem('joko.device-transport-request-v1', JSON.stringify(parseDeviceTransportRequestDraft(draft)));
      else await secure.removeItem('joko.device-transport-request-v1');
    }),
    readDeviceAuthorization: () => serialized(async () => {
      await secureAvailable();
      const raw = await secure.getItem('joko.device-authorization-request-v1');
      return raw === null ? undefined : parseDeviceAuthorizationDraft(JSON.parse(raw));
    }),
    writeDeviceAuthorization: draft => serialized(async () => {
      await secureAvailable();
      if (draft) await secure.setItem('joko.device-authorization-request-v1', JSON.stringify(parseDeviceAuthorizationDraft(draft)));
      else await secure.removeItem('joko.device-authorization-request-v1');
    }),
    saveConnection: (credential) => serialized(async () => {
      const profile = profileFromCredential(credential);
      await secureAvailable();
      await writeEndpointTransport(profile);
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

function irohRelayRequestKey(profile: MobileConnectionProfile, input: RetainedIrohRelayRequest): string {
  return `joko.mobile.iroh-relay-request.v1.${encodeURIComponent(JSON.stringify([profile.profileId, profile.origin, profile.serverId, profile.connectionId, profile.deviceId, profile.endpointPublicKey, profile.transportKind ?? 'https', input.nodeEndpointId, input.recipientEndpointId]))}`;
}

export function profileFromCredential(credential: PairedCredential): MobileConnectionProfile {
  if (credential.endpointPublicKey !== undefined && !/^ed25519:[a-f0-9]{64}$/u.test(credential.endpointPublicKey)) throw new Error("The endpoint public key is invalid.");
  return readProfile({
    profileId: credential.profileId,
    origin: credential.origin,
    ...(credential.entryId === undefined ? {} : { entryId: credential.entryId }),
    ...(credential.endpointPublicKey === undefined ? {} : { endpointPublicKey: credential.endpointPublicKey }),
    ...(credential.transportKind === undefined ? {} : { transportKind: credential.transportKind }),
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
    && credential.deviceId === profile.deviceId && credential.endpointPublicKey === profile.endpointPublicKey
    && (credential.transportKind ?? 'https') === (profile.transportKind ?? 'https');
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
    ...(record.entryId === undefined ? {} : { entryId: text(record.entryId, 128, 'entry identity') }),
    serverId: text(record.serverId, 128, "server identity"),
    connectionId: text(record.connectionId, 128, "connection identity"),
    deviceId: text(record.deviceId, 128, "device identity"),
    displayName: text(record.displayName, 256, "connection name"),
    ...(record.endpointPublicKey === undefined ? {} : { endpointPublicKey: text(record.endpointPublicKey, 80, "endpoint public key") }),
    ...(record.transportKind === undefined ? {} : { transportKind: text(record.transportKind, 16, 'transport kind') as EndpointTransportKind })
  };
  if (profile.endpointPublicKey !== undefined && !/^ed25519:[a-f0-9]{64}$/u.test(profile.endpointPublicKey)) throw new Error("The saved endpoint public key is invalid.");
  if (profile.transportKind !== undefined && !['https', 'iroh', 'tailcat', 'webrtc', 'http-connect'].includes(profile.transportKind)) throw new Error('The saved connection transport is invalid.');
  if (profile.transportKind !== undefined && profile.transportKind !== 'https' && profile.endpointPublicKey === undefined) throw new Error('The selected transport requires a trusted node public key.');
  assertLocalId(profile.profileId, "connection profile");
  assertLocalId(profile.connectionId, "connection identity");
  assertLocalId(profile.deviceId, "device identity");
  const origin = new URL(profile.origin);
  if (origin.origin !== profile.origin || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("The saved Joko connection origin is invalid.");
  }
  return profile;
}

function transportOwner(profile: MobileConnectionProfile): string {
  return JSON.stringify([profile.profileId, profile.origin, profile.serverId, profile.endpointPublicKey, profile.transportKind]);
}
function entryOwner(profile: MobileConnectionProfile) {
  if (!profile.endpointPublicKey) throw new Error('Multiple entrances require the full saved node key.');
  return { profileId: profile.profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey };
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
    || !["create", "send", "logout", "revoke", "device-rename", "rename", "pin", "archive", "delete", "message-delete",
      "queue-cancel", "queue-edit-lock", "queue-edit", "queue-interaction-lock", "queue-reorder",
      "interaction-resolve", "interaction-dismiss", "session-model", "session-permission", "session-plan", "session-compact",
      "objective-set", "objective-pause", "objective-resume", "objective-clear",
      "collaboration-enable", "collaboration-create", "collaboration-release", "collaboration-archive", "collaboration-end",
      "session-branch", "session-shell", "session-reset", "session-review", "session-clone", "session-fork", "session-side-chat", "session-rewind", "workspace-rewind", "schedule-run", "schedule-enable",
      "schedule-run-restart", "schedule-run-read", "schedule-runs-read", "schedule-all-read",
      "schedule-run-delete", "schedule-create", "schedule-update", "schedule-delete", "schedule-promote",
      "schedule-clone", "schedule-project-remove", "schedule-project-reconcile", "voice-settings", "model-favorite", "model-source-target",
      "extension-enabled", "extension-sidebar", "extension-package-adopt", "extension-package-remove", "extension-settings-routing", "extension-settings-credential-clear", "extension-settings-directory", "extension-setup-begin", "extension-setup-interaction",
      "extension-setup-credential", "extension-setup-complete", "extension-setup-cancel",
      "extension-setup-revoke"].includes(String(record.kind))
    || (record.state !== "unknown" && record.state !== "accepted")) return false;
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") return false;
  if (record.taskJoinId !== undefined && !validReceiptIdentity(record.taskJoinId)) return false;
  if (record.eventId !== undefined && typeof record.eventId !== "string") return false;
  if (record.backendId !== undefined && !validReceiptIdentity(record.backendId)) return false;
  if (record.sourceGeneration !== undefined && (typeof record.sourceGeneration !== "string" || record.sourceGeneration.length > 20
    || !/^[1-9][0-9]*$/u.test(record.sourceGeneration) || BigInt(record.sourceGeneration) > 18_446_744_073_709_551_615n)) return false;
  if (record.workspaceId !== undefined && !validReceiptIdentity(record.workspaceId)) return false;
  if (record.changeSetId !== undefined && !validReceiptIdentity(record.changeSetId)) return false;
  if (record.queueItemId !== undefined && typeof record.queueItemId !== "string") return false;
  if (record.interactionId !== undefined && typeof record.interactionId !== "string") return false;
  if (record.interactionGeneration !== undefined && (typeof record.interactionGeneration !== "string" || !/^[1-9][0-9]*$/u.test(record.interactionGeneration))) return false;
  if (record.interactionRevision !== undefined && (typeof record.interactionRevision !== "string" || !/^[1-9][0-9]*$/u.test(record.interactionRevision))) return false;
  if (record.interactionDraftKind !== undefined && record.interactionDraftKind !== "question" && record.interactionDraftKind !== "plan") return false;
  if (record.targetConnectionId !== undefined && typeof record.targetConnectionId !== "string") return false;
  if (record.targetDeviceId !== undefined && typeof record.targetDeviceId !== "string") return false;
  if (record.scheduleId !== undefined && !validReceiptIdentity(record.scheduleId)) return false;
  if (record.triggerId !== undefined && !validReceiptIdentity(record.triggerId)) return false;
  if (record.targetId !== undefined && !validReceiptIdentity(record.targetId)) return false;
  if (record.extensionId !== undefined && (typeof record.extensionId !== "string"
    || !/^extension_[a-f0-9]{32}$/u.test(record.extensionId))) return false;
  if (record.extensionRevision !== undefined && (typeof record.extensionRevision !== "string"
    || record.extensionRevision.length > 20 || !/^[1-9][0-9]*$/u.test(record.extensionRevision)
    || BigInt(record.extensionRevision) > 18_446_744_073_709_551_615n)) return false;
  const extensionPackage = record.kind === "extension-package-adopt" || record.kind === "extension-package-remove";
  if (extensionPackage ? !validReceiptIdentity(record.extensionResourceId) : record.extensionResourceId !== undefined) return false;
  if (record.kind === "logout" && typeof record.targetConnectionId !== "string") return false;
  if (["revoke", "device-rename"].includes(String(record.kind)) && typeof record.targetDeviceId !== "string") return false;
  if (record.kind === "device-rename" && (record.sessionId !== undefined || record.eventId !== undefined
    || record.queueItemId !== undefined || record.interactionId !== undefined
    || record.interactionGeneration !== undefined || record.interactionRevision !== undefined
    || record.interactionDraftKind !== undefined || record.targetConnectionId !== undefined
    || record.scheduleId !== undefined || record.triggerId !== undefined || record.targetId !== undefined)) return false;
  if (record.kind === "send" && typeof record.sessionId !== "string") return false;
  if (["rename", "pin", "archive", "delete"].includes(String(record.kind)) && typeof record.sessionId !== "string") return false;
  if (record.kind === "message-delete" && (typeof record.sessionId !== "string" || typeof record.eventId !== "string")) return false;
  if (["queue-cancel", "queue-edit-lock", "queue-edit", "queue-reorder"].includes(String(record.kind))
    && (typeof record.sessionId !== "string" || typeof record.queueItemId !== "string")) return false;
  if (record.kind === "queue-interaction-lock" && typeof record.sessionId !== "string") return false;
  if (["interaction-resolve", "interaction-dismiss"].includes(String(record.kind))
    && (typeof record.sessionId !== "string" || typeof record.interactionId !== "string"
      || typeof record.interactionGeneration !== "string" || typeof record.interactionRevision !== "string")) return false;
  if (["session-model", "session-permission", "session-plan", "session-compact", "session-branch",
    "session-shell", "session-reset", "session-review", "session-clone", "session-fork", "session-side-chat",
    "objective-set", "objective-pause", "objective-resume", "objective-clear"].includes(String(record.kind))
    && typeof record.sessionId !== "string") return false;
  if (record.kind === "session-fork" && !validReceiptIdentity(record.eventId)) return false;
  if (record.kind === "session-side-chat" && (!validReceiptIdentity(record.backendId) || !validReceiptIdentity(record.targetId)
    || record.sourceGeneration === undefined || record.taskJoinId !== undefined)) return false;
  if (String(record.kind).startsWith("objective-") && (!validReceiptIdentity(record.sessionId) || record.sourceGeneration === undefined)) return false;
  if (String(record.kind).startsWith("collaboration-") && (!validReceiptIdentity(record.sessionId) || record.sourceGeneration === undefined
    || record.backendId !== undefined || record.workspaceId !== undefined || record.changeSetId !== undefined)) return false;
  if (["session-rewind", "workspace-rewind"].includes(String(record.kind)) && (!validReceiptIdentity(record.sessionId)
    || !validReceiptIdentity(record.eventId) || !validReceiptIdentity(record.targetId) || !validReceiptIdentity(record.backendId)
    || record.sourceGeneration === undefined)) return false;
  if (record.kind === "workspace-rewind" && (!validReceiptIdentity(record.workspaceId) || !validReceiptIdentity(record.changeSetId))) return false;
  if (["schedule-run", "schedule-enable", "schedule-runs-read"].includes(String(record.kind))
    && !validReceiptIdentity(record.scheduleId)) return false;
  if (["schedule-run-restart", "schedule-run-read", "schedule-run-delete"].includes(String(record.kind))
    && (!validReceiptIdentity(record.scheduleId) || !validReceiptIdentity(record.triggerId))) return false;
  if (record.kind === "schedule-all-read" && (record.scheduleId !== undefined || record.triggerId !== undefined)) return false;
  if (record.kind === "schedule-create" && (!validReceiptIdentity(record.targetId) || record.scheduleId !== undefined)) return false;
  if (record.kind === "schedule-update" && (!validReceiptIdentity(record.targetId) || !validReceiptIdentity(record.scheduleId))) return false;
  if (["schedule-delete", "schedule-promote", "schedule-clone", "schedule-project-remove"].includes(String(record.kind))
    && !validReceiptIdentity(record.scheduleId)) return false;
  if (record.kind === "schedule-project-reconcile"
    && (!validReceiptIdentity(record.targetId) || record.scheduleId !== undefined)) return false;
  if (isExtensionReceiptKind(record.kind)
    && (!/^extension_[a-f0-9]{32}$/u.test(String(record.extensionId)) || record.extensionRevision === undefined)) return false;
  if (isExtensionReceiptKind(record.kind)
    && (record.sessionId !== undefined || record.eventId !== undefined || record.backendId !== undefined
      || record.sourceGeneration !== undefined || record.workspaceId !== undefined || record.changeSetId !== undefined
      || record.queueItemId !== undefined || record.interactionId !== undefined
      || record.interactionGeneration !== undefined || record.interactionRevision !== undefined
      || record.interactionDraftKind !== undefined || record.targetConnectionId !== undefined
      || record.targetDeviceId !== undefined || record.scheduleId !== undefined || record.triggerId !== undefined
      || record.targetId !== undefined)) return false;
  if (isExtensionReceiptKind(record.kind)
    && Object.keys(record).some((key) => ![
      "operationId", "connectionId", "kind", "extensionId", "extensionRevision", "extensionResourceId", "state"
    ].includes(key))) return false;
  if (!["schedule-run", "schedule-enable", "schedule-run-restart", "schedule-run-read", "schedule-runs-read",
    "schedule-run-delete", "schedule-update", "schedule-delete", "schedule-promote", "schedule-clone",
    "schedule-project-remove"].includes(String(record.kind))
    && (record.scheduleId !== undefined || record.triggerId !== undefined)) return false;
  if (!["schedule-run-restart", "schedule-run-read", "schedule-run-delete"].includes(String(record.kind))
    && record.triggerId !== undefined) return false;
  if (!["schedule-create", "schedule-update", "schedule-project-reconcile", "session-rewind", "workspace-rewind", "session-side-chat"].includes(String(record.kind))
    && record.targetId !== undefined) return false;
  if (!["session-rewind", "workspace-rewind", "session-side-chat", "objective-set", "objective-pause", "objective-resume", "objective-clear",
    "collaboration-enable", "collaboration-create", "collaboration-release", "collaboration-archive", "collaboration-end"].includes(String(record.kind))
    && (record.backendId !== undefined || record.sourceGeneration !== undefined || record.workspaceId !== undefined || record.changeSetId !== undefined)) return false;
  if (String(record.kind).startsWith("objective-") && (record.backendId !== undefined || record.workspaceId !== undefined || record.changeSetId !== undefined)) return false;
  if (record.kind === "session-rewind" && (record.workspaceId !== undefined || record.changeSetId !== undefined)) return false;
  if (record.kind === "session-side-chat" && (record.workspaceId !== undefined || record.changeSetId !== undefined)) return false;
  if (!["interaction-resolve", "interaction-dismiss"].includes(String(record.kind))
    && (record.interactionId !== undefined || record.interactionGeneration !== undefined
      || record.interactionRevision !== undefined || record.interactionDraftKind !== undefined)) return false;
  if (!isExtensionReceiptKind(record.kind)
    && (record.extensionId !== undefined || record.extensionRevision !== undefined)) return false;
  return true;
}

function isExtensionReceiptKind(value: unknown): boolean {
  return [
    "extension-enabled",
    "extension-sidebar",
    "extension-package-adopt",
    "extension-package-remove",
    "extension-settings-routing",
    "extension-settings-credential-clear",
    "extension-settings-directory",
    "extension-setup-begin",
    "extension-setup-interaction",
    "extension-setup-credential",
    "extension-setup-complete",
    "extension-setup-cancel",
    "extension-setup-revoke"
  ].includes(String(value));
}

function validReceiptIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
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
