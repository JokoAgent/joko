import { OperationState, type Operation } from "@joko/contracts";
import type { ConnectionProfile, ExtensionCatalogEntryView, ExtensionSettingsApi } from "./model.js";

export const extensionSettingsOperationKinds = ["setExtensionSettingsRoutingData", "clearExtensionSetupCredential", "pickExtensionDirectory",
  "beginExtensionSetup", "submitExtensionSetupInteraction", "commitExtensionSetupCredential", "completeExtensionSetup"] as const;
export type ExtensionSettingsOperationKind = typeof extensionSettingsOperationKinds[number];
export interface PendingExtensionSettingsOperation {
  readonly operationId: string; readonly kind: ExtensionSettingsOperationKind; readonly extensionId: string;
  readonly resourceId: string; readonly resourceRevision: string; readonly discoveredRevision: string; readonly expectedRevision: string;
  readonly profile: { readonly id: string; readonly deviceId: string; readonly serverId: string; readonly origin: string;
    readonly transportKind: string; readonly endpointPublicKey?: string; readonly entryId?: string };
}
export interface ExtensionSettingsOperationReceipt { readonly state: "pending" | "succeeded" | "failed" }
export type ExtensionSettingsOperationObserver = (record: PendingExtensionSettingsOperation, receipt?: ExtensionSettingsOperationReceipt) => Promise<void>;

export function extensionSettingsProfilePin(profile: Pick<ConnectionProfile, "id" | "deviceId" | "serverId" | "origin" | "transportKind" | "endpointPublicKey" | "entryId">): PendingExtensionSettingsOperation["profile"] {
  return { id: profile.id, deviceId: profile.deviceId, serverId: profile.serverId, origin: profile.origin, transportKind: profile.transportKind ?? "https",
    ...(profile.endpointPublicKey === undefined ? {} : { endpointPublicKey: profile.endpointPublicKey }), ...(profile.entryId === undefined ? {} : { entryId: profile.entryId }) };
}
export const extensionSettingsProfileKey = (profile: ConnectionProfile): string => JSON.stringify(extensionSettingsProfilePin(profile));
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): boolean =>
  expected.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => expected.includes(key) || optional.includes(key));
const identity = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const revision = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;

/** This journal contains receipt identity only. Values, upload tickets and directory deposits never enter it. */
export function parsePendingExtensionSettingsOperation(value: unknown): PendingExtensionSettingsOperation {
  const error = () => new Error("The original plugin settings operation record is invalid.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error();
  const row = value as Record<string, unknown>, owner = row["profile"];
  if (!exactKeys(row, ["operationId", "kind", "extensionId", "resourceId", "resourceRevision", "discoveredRevision", "expectedRevision", "profile"])
    || typeof row["operationId"] !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(row["operationId"])
    || !extensionSettingsOperationKinds.includes(row["kind"] as ExtensionSettingsOperationKind)
    || !identity(row["extensionId"], 128) || !identity(row["resourceId"], 128) || !revision(row["resourceRevision"]) || !revision(row["expectedRevision"])
    || typeof row["discoveredRevision"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row["discoveredRevision"])
    || !owner || typeof owner !== "object" || Array.isArray(owner)) throw error();
  const pin = owner as Record<string, unknown>;
  if (!exactKeys(pin, ["id", "deviceId", "serverId", "origin", "transportKind"], ["endpointPublicKey", "entryId"])
    || !identity(pin["id"], 128) || !identity(pin["deviceId"], 128) || !identity(pin["serverId"], 128) || !identity(pin["origin"], 4096)
    || !["https", "iroh", "tailcat", "webrtc", "http-connect"].includes(pin["transportKind"] as string)
    || pin["endpointPublicKey"] !== undefined && (typeof pin["endpointPublicKey"] !== "string" || !/^ed25519:[a-f0-9]{64}$/u.test(pin["endpointPublicKey"]))
    || pin["entryId"] !== undefined && !identity(pin["entryId"], 128)) throw error();
  let origin: URL;
  try { origin = new URL(pin["origin"] as string); } catch { throw error(); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw error();
  return { operationId: row["operationId"], kind: row["kind"] as ExtensionSettingsOperationKind, extensionId: row["extensionId"],
    resourceId: row["resourceId"], resourceRevision: row["resourceRevision"], discoveredRevision: row["discoveredRevision"], expectedRevision: row["expectedRevision"],
    profile: { id: pin["id"], deviceId: pin["deviceId"], serverId: pin["serverId"], origin: pin["origin"], transportKind: pin["transportKind"] as string,
      ...(pin["endpointPublicKey"] === undefined ? {} : { endpointPublicKey: pin["endpointPublicKey"] as string }), ...(pin["entryId"] === undefined ? {} : { entryId: pin["entryId"] as string }) } };
}
export const sameExtensionSettingsOperation = (left: PendingExtensionSettingsOperation, right: PendingExtensionSettingsOperation): boolean =>
  JSON.stringify(parsePendingExtensionSettingsOperation(left)) === JSON.stringify(parsePendingExtensionSettingsOperation(right));

export function pendingExtensionSettingsOperation(profile: ConnectionProfile, extension: ExtensionCatalogEntryView,
  kind: ExtensionSettingsOperationKind, operationId: string): PendingExtensionSettingsOperation {
  if (extension.owner.kind !== "resource") throw new Error("Plugin settings require the original Resource installation.");
  return parsePendingExtensionSettingsOperation({ operationId, kind, extensionId: extension.id, resourceId: extension.owner.resourceId,
    resourceRevision: extension.owner.resourceRevision.toString(), discoveredRevision: extension.owner.discoveredRevision,
    expectedRevision: extension.revision.toString(), profile: extensionSettingsProfilePin(profile) });
}

export function extensionSettingsOperationReceipt(record: PendingExtensionSettingsOperation, operation: Operation, profile: ConnectionProfile): ExtensionSettingsOperationReceipt {
  const original = parsePendingExtensionSettingsOperation(record), payload = operation.mutation?.payload;
  const actual = payload?.value as { readonly extensionId?: string; readonly expectedRevision?: { readonly value: bigint } } | undefined;
  if (JSON.stringify(original.profile) !== extensionSettingsProfileKey(profile) || operation.operationId !== original.operationId || operation.connectionId !== profile.id
    || !payload || payload.case !== original.kind || actual?.extensionId !== original.extensionId || actual?.expectedRevision?.value !== BigInt(original.expectedRevision)) {
    throw new Error("The plugin settings receipt does not match its original connection, installation and operation.");
  }
  if (operation.state === OperationState.SUCCEEDED) {
    const result = operation.result?.payload;
    if (original.kind === "pickExtensionDirectory") {
      if (result?.case !== "pickedDirectory" || !result.value.token || result.value.fileCount < 1 || result.value.fileCount > 500
        || result.value.fileCount !== result.value.relativePaths.length || result.value.totalBytes < 0n || result.value.totalBytes > 524_288_000n
        || !result.value.expiresAt || result.value.expiresAt.seconds <= 0n || result.value.expiresAt.nanos < 0 || result.value.expiresAt.nanos >= 1_000_000_000
        || result.value.relativePaths.some(value => !value || value.length > 4096 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
          || value.split("/").some(part => part === ".."))) throw new Error("The original directory selection has no valid deposit receipt.");
    } else if (result?.case !== "acknowledgement" || result.value.accepted !== true) throw new Error("The original plugin settings operation has no accepted receipt.");
  }
  return { state: operation.state === OperationState.SUCCEEDED ? "succeeded"
    : [OperationState.FAILED, OperationState.CONFLICT, OperationState.CANCELLED].includes(operation.state) ? "failed" : "pending" };
}

export const extensionSettingsReadOnly = (kind: string): boolean => ["context.get", "routing.get", "setup.get", "oauth.get", "connections.get", "secret.check", "library.open"].includes(kind);

interface OperationJournal {
  readExtensionSettingsOperation(profile: ConnectionProfile, extensionId: string): Promise<PendingExtensionSettingsOperation | undefined>;
  claimExtensionSettingsOperation(profile: ConnectionProfile, record: PendingExtensionSettingsOperation): Promise<void>;
  finishExtensionSettingsOperation(profile: ConnectionProfile, record: PendingExtensionSettingsOperation): Promise<void>;
}

/** The controller captures one original gateway. A cold journal is queried; it never supplies a new mutation. */
export function bindExtensionSettingsOperationJournal(api: ExtensionSettingsApi, local: OperationJournal, profile: ConnectionProfile,
  current: () => void): ExtensionSettingsApi {
  return { ...api,
    pending: async (extensionId, signal) => { current(); signal.throwIfAborted(); const result = await local.readExtensionSettingsOperation(profile, extensionId); current(); signal.throwIfAborted(); return result; },
    call: async (surface, call, host, signal) => {
      current(); signal.throwIfAborted();
      if (!extensionSettingsReadOnly(call.kind) && await local.readExtensionSettingsOperation(profile, surface.extensionId)) throw new Error("Check the original plugin settings operation before starting another change.");
      current(); signal.throwIfAborted();
      return api.call(surface, call, host, signal, async (record, receipt) => {
        current(); signal.throwIfAborted();
        if (receipt === undefined) await local.claimExtensionSettingsOperation(profile, record);
        else if (receipt.state !== "pending") await local.finishExtensionSettingsOperation(profile, record);
        current(); signal.throwIfAborted();
      });
    },
    checkOriginal: async (record, signal) => {
      current(); signal.throwIfAborted();
      const retained = await local.readExtensionSettingsOperation(profile, record.extensionId);
      if (!retained || !sameExtensionSettingsOperation(retained, record) || !api.readOperation) throw new Error("The original plugin settings operation is unavailable.");
      const result = await api.readOperation(retained, signal); current(); signal.throwIfAborted();
      if (result.state !== "pending") await local.finishExtensionSettingsOperation(profile, retained);
      current(); signal.throwIfAborted(); return result;
    }
  };
}
