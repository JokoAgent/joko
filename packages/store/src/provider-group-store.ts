import { createHash, randomUUID } from "node:crypto";
import { RevisionConflictError, StoreError } from "./errors.js";
import type { OperationalStore } from "./operational-store.js";

export type ProviderGroupStrategy = "least_busy" | "round_robin" | "ordered" | "weighted";
export interface ProviderGroupKey { readonly backendId: string; readonly providerId: string; }
export interface ProviderGroupReceivedIdentity {
  readonly joinId: string; readonly shareId: string; readonly memberId: string; readonly generation: number;
  readonly hostServerId: string; readonly nativeBackendId: string; readonly providerId: string;
}
export interface ProviderGroupMember extends ProviderGroupKey {
  readonly key: string; readonly kind: "local" | "device" | "share"; readonly nodeId: string; readonly displayName: string;
  readonly nativeBackendId: string;
  readonly capacity: number; readonly weight: number; readonly paused: boolean;
  readonly received?: ProviderGroupReceivedIdentity;
}
export interface ProviderGroupConfig {
  readonly strategy: ProviderGroupStrategy; readonly autoSwitch: boolean; readonly members: readonly ProviderGroupMember[];
}
export interface ProviderGroupCleanupIntent {
  readonly id: string; readonly removedMembers: readonly ProviderGroupMember[]; readonly deleted: boolean;
}
export interface ProviderGroupSnapshot extends ProviderGroupKey {
  readonly revision: bigint; readonly config?: ProviderGroupConfig; readonly cleanup: readonly ProviderGroupCleanupIntent[];
  /** Server-captured owner of a cached remote group, absent for local settings. */
  readonly ownerNodeId?: string;
}
export interface ProviderGroupBinding {
  readonly group: ProviderGroupKey; readonly groupRevision: string; readonly memberKey: string;
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly ownerNodeId?: string;
}
export interface ProviderGroupBindingRecord {
  readonly format: 1; readonly sessionId: string; readonly binding?: ProviderGroupBinding;
  /** An explicit removal must survive rediscovery and must not adopt the task again. */
  readonly released: boolean;
}
export interface ProviderGroupCooling {
  readonly memberKey: string; readonly modelId?: string; readonly cause: "usage-limit" | "auth" | "overload";
  readonly until: number;
}
interface StoredGroup extends ProviderGroupKey {
  readonly format: 1; readonly revision: string; readonly config?: ProviderGroupConfig;
  readonly cleanup: readonly ProviderGroupCleanupIntent[]; readonly cooling: readonly ProviderGroupCooling[];
  readonly ownerNodeId?: string;
}
export interface ProviderGroupHostedBinding {
  readonly format: 1; readonly id: string; readonly group: ProviderGroupKey; readonly groupRevision: string;
  readonly member: ProviderGroupMember; readonly modelId: string; readonly outerModelId: string;
  readonly phase: "opening" | "ready" | "closed" | "unknown";
}
const SCOPE = "provider-groups.v1";
const STRATEGIES = ["least_busy", "round_robin", "ordered", "weighted"];

/** Current-v1 groups and release intents share the same SQLite transaction.
 * The owner key comes from the service composition, never from a request. */
export class ProviderGroupStore {
  readonly #prefix: string;
  constructor(readonly store: OperationalStore, readonly ownerKey: string) {
    identity(ownerKey); this.#prefix = digest(ownerKey) + ":";
  }
  snapshot(key: ProviderGroupKey): ProviderGroupSnapshot {
    const row = this.#read(key);
    return { ...key, revision: BigInt(row.revision), ...(row.config ? { config: structuredClone(row.config) } : {}), cleanup: structuredClone(row.cleanup),
      ...(row.ownerNodeId ? { ownerNodeId: row.ownerNodeId } : {}) };
  }
  list(): readonly ProviderGroupSnapshot[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "group:").map(row => {
      const value = parseGroup(row.value); return this.snapshot(value);
    }).filter(row => row.config !== undefined && row.ownerNodeId === undefined);
  }
  pendingCleanup(): readonly ProviderGroupSnapshot[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "group:").map(row => parseGroup(row.value))
      .filter(row => row.cleanup.length > 0).map(row => this.snapshot(row));
  }
  remoteSnapshots(): readonly ProviderGroupSnapshot[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "group:").map(row => parseGroup(row.value)).filter(row => row.ownerNodeId !== undefined).map(row => this.snapshot(row));
  }
  update(key: ProviderGroupKey, config: ProviderGroupConfig | undefined, expectedRevision: bigint): ProviderGroupSnapshot {
    validKey(key); if (config !== undefined) assertProviderGroupConfig(config);
    if (expectedRevision < 0n) throw invalid();
    return this.store.transaction(() => {
      const current = this.#read(key), actual = BigInt(current.revision);
      if (current.ownerNodeId) throw new StoreError("A remote Provider group can only be managed by its owner.");
      if (actual !== expectedRevision) throw new RevisionConflictError("provider group", groupKey(key), expectedRevision, actual);
      const nextConfig = config?.members.length ? config : undefined;
      const removedMembers = current.config?.members.filter(member => !nextConfig?.members.some(next => next.key === member.key)) ?? [];
      const removed = removedMembers.map(member => member.key);
      const deleted = current.config !== undefined && nextConfig === undefined;
      const cleanup = [...current.cleanup, ...(removed.length || deleted ? [{ id: randomUUID(), removedMembers, deleted }] : [])];
      // Invalidate bindings synchronously with the configuration. Deferred external
      // cleanup may fail; readers already see the durable release marker.
      if (removed.length || deleted) for (const row of this.#bindingRows()) {
        if (row.binding && sameKey(row.binding.group, key) && (deleted || removed.includes(row.binding.memberKey))) {
          this.#writeBinding({ format: 1, sessionId: row.sessionId, released: true });
        }
      }
      const next: StoredGroup = { format: 1, ...key, revision: (actual + 1n).toString(), ...(nextConfig ? { config: structuredClone(nextConfig) } : {}),
        cleanup, cooling: current.cooling.filter(row => nextConfig?.members.some(member => member.key === row.memberKey)) };
      this.#save(next); return this.snapshot(key);
    });
  }
  acknowledgeCleanup(key: ProviderGroupKey, id: string): void {
    identity(id); this.store.transaction(() => {
      const current = this.#read(key); this.#save({ ...current, cleanup: current.cleanup.filter(intent => intent.id !== id) });
    });
  }
  /** Only an authoritative owner response updates this cache. A network error
   * never calls this method and therefore cannot release a remote binding. */
  observeRemote(key: ProviderGroupKey, ownerNodeId: string, revision: bigint, config: ProviderGroupConfig | undefined): ProviderGroupSnapshot {
    validKey(key); identity(ownerNodeId); if (revision < 0n) throw invalid(); if (config) assertProviderGroupConfig(config);
    return this.store.transaction(() => {
      const current = this.#read(key);
      if (current.ownerNodeId !== undefined && current.ownerNodeId !== ownerNodeId || current.ownerNodeId === undefined && current.revision !== "0") throw invalid();
      if (revision < BigInt(current.revision)) throw new StoreError("The remote Provider group response is stale.");
      const nextConfig = config?.members.length ? config : undefined;
      // The owner revision identifies its configuration. Local Source aliases
      // may change when an already-authorized route is freshly discovered.
      for (const row of this.#bindingRows()) if (row.binding && sameKey(row.binding.group, key)
        && !nextConfig?.members.some(member => member.key === row.binding!.memberKey)) this.#writeBinding({ format: 1, sessionId: row.sessionId, released: true });
      this.#save({ format: 1, ...key, ownerNodeId, revision: revision.toString(), ...(nextConfig ? { config: structuredClone(nextConfig) } : {}), cleanup: [], cooling: [] });
      return this.snapshot(key);
    });
  }
  clearRelease(sessionId: string): void { identity(sessionId); this.store.deleteSetting("service", SCOPE, this.#bindingKey(sessionId)); }
  hostedBinding(id: string): ProviderGroupHostedBinding | undefined {
    identity(id); const value = this.store.findSetting("service", SCOPE, this.#prefix + "hosted:" + digest(id))?.value;
    return value === undefined ? undefined : structuredClone(parseHostedBinding(value));
  }
  stageHostedBinding(input: Omit<ProviderGroupHostedBinding, "format" | "phase">): void {
    const previous = this.hostedBinding(input.id); if (previous && !["ready", "closed"].includes(previous.phase)) throw new StoreError("The original Provider group native effect is unknown.");
    this.#saveHosted({ format: 1, ...input, phase: "opening" });
  }
  settleHostedBinding(id: string, phase: ProviderGroupHostedBinding["phase"]): void {
    const previous = this.hostedBinding(id); if (!previous) throw invalid(); this.#saveHosted({ ...previous, phase });
  }
  #saveHosted(value: ProviderGroupHostedBinding): void { parseHostedBinding(value); this.store.setSetting("service", SCOPE, this.#prefix + "hosted:" + digest(value.id), value); }
  binding(sessionId: string): ProviderGroupBinding | undefined {
    const row = this.bindingRecord(sessionId); if (!row?.binding || row.released) return undefined;
    const group = this.#read(row.binding.group);
    if (!group.config?.members.some(member => member.key === row.binding!.memberKey)) return undefined;
    return structuredClone(row.binding);
  }
  bindingRecord(sessionId: string): ProviderGroupBindingRecord | undefined {
    identity(sessionId); const value = this.store.findSetting("service", SCOPE, this.#bindingKey(sessionId))?.value;
    return value === undefined ? undefined : structuredClone(parseBinding(value));
  }
  commitBinding(sessionId: string, binding: ProviderGroupBinding, expectedGroupRevision: bigint): void {
    identity(sessionId); assertBinding(binding);
    this.store.transaction(() => {
      const current = this.#read(binding.group), revision = BigInt(current.revision);
      if (revision !== expectedGroupRevision) throw new RevisionConflictError("provider group", groupKey(binding.group), expectedGroupRevision, revision);
      if (!current.config?.members.some(member => member.key === binding.memberKey && member.backendId === binding.backendId && member.providerId === binding.providerId)) throw invalid();
      this.#writeBinding({ format: 1, sessionId, binding: { ...binding, groupRevision: revision.toString() }, released: false });
    });
  }
  release(sessionId: string): void { identity(sessionId); this.#writeBinding({ format: 1, sessionId, released: true }); }
  bindings(key?: ProviderGroupKey): readonly ProviderGroupBindingRecord[] {
    return this.#bindingRows().filter(row => !key || row.binding && sameKey(row.binding.group, key));
  }
  cooling(key: ProviderGroupKey, now: number): readonly ProviderGroupCooling[] {
    return this.#read(key).cooling.filter(row => row.until > now);
  }
  cool(key: ProviderGroupKey, value: ProviderGroupCooling, now: number): void {
    assertCooling(value); this.store.transaction(() => {
      const current = this.#read(key); if (!current.config?.members.some(member => member.key === value.memberKey)) return;
      const previous = current.cooling.filter(row => row.until > now && !(row.memberKey === value.memberKey && row.modelId === value.modelId));
      this.#save({ ...current, cooling: [...previous, value] });
    });
  }
  #read(key: ProviderGroupKey): StoredGroup {
    validKey(key); const value = this.store.findSetting("service", SCOPE, this.#prefix + "group:" + digest(groupKey(key)))?.value;
    if (value === undefined) return { format: 1, ...key, revision: "0", cleanup: [], cooling: [] };
    const row = parseGroup(value); if (!sameKey(row, key)) throw invalid(); return row;
  }
  #save(value: StoredGroup): void {
    parseGroup(value);
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new StoreError("The Provider group settings exceed their storage capacity.");
    this.store.setSetting("service", SCOPE, this.#prefix + "group:" + digest(groupKey(value)), value);
  }
  #bindingKey(sessionId: string): string { return this.#prefix + "binding:" + digest(sessionId); }
  #writeBinding(value: ProviderGroupBindingRecord): void {
    parseBinding(value); this.store.setSetting("service", SCOPE, this.#bindingKey(value.sessionId), value);
  }
  #bindingRows(): ProviderGroupBindingRecord[] {
    return this.store.listSettingsByKeyPrefix("service", SCOPE, this.#prefix + "binding:").map(row => parseBinding(row.value));
  }
}
export function groupKey(key: ProviderGroupKey): string { validKey(key); return JSON.stringify([key.backendId, key.providerId]); }
export function sameProviderGroupKey(a: ProviderGroupKey, b: ProviderGroupKey): boolean { return sameKey(a, b); }
export function assertProviderGroupConfig(value: unknown): asserts value is ProviderGroupConfig {
  if (!object(value) || !keys(value, ["strategy", "autoSwitch", "members"]) || !STRATEGIES.includes(String(value["strategy"]))
    || typeof value["autoSwitch"] !== "boolean" || !Array.isArray(value["members"]) || value["members"].length > 512) throw invalid();
  const seen = new Set<string>();
  for (const member of value["members"]) {
    if (!object(member) || !keys(member, ["key", "kind", "backendId", "nativeBackendId", "providerId", "nodeId", "displayName", "capacity", "weight", "paused", "received"])
      || !["local", "device", "share"].includes(String(member["kind"])) || !bounded(member["key"]) || seen.has(member["key"])
      || !bounded(member["backendId"]) || !bounded(member["nativeBackendId"]) || !bounded(member["providerId"]) || !bounded(member["nodeId"]) || !bounded(member["displayName"])
      || !integer(member["capacity"], 1, 16) || !integer(member["weight"], 1, 100) || typeof member["paused"] !== "boolean") throw invalid();
    seen.add(member["key"]);
    if (member["kind"] === "share") assertReceived(member["received"]); else if (member["received"] !== undefined) throw invalid();
  }
}
function parseGroup(value: unknown): StoredGroup {
  if (!object(value) || !keys(value, ["format", "backendId", "providerId", "revision", "config", "cleanup", "cooling", "ownerNodeId"])
    || value["format"] !== 1 || !bounded(value["backendId"]) || !bounded(value["providerId"]) || !decimal(value["revision"])
    || !Array.isArray(value["cleanup"]) || !Array.isArray(value["cooling"])) throw invalid();
  if (value["ownerNodeId"] !== undefined && !bounded(value["ownerNodeId"])) throw invalid();
  if (value["config"] !== undefined) { assertProviderGroupConfig(value["config"]); if (!value["config"].members.length) throw invalid(); }
  for (const intent of value["cleanup"]) {
    if (!object(intent) || !keys(intent, ["id", "removedMembers", "deleted"]) || !bounded(intent["id"])
      || !Array.isArray(intent["removedMembers"]) || typeof intent["deleted"] !== "boolean") throw invalid();
    assertProviderGroupConfig({ strategy: "ordered", autoSwitch: true, members: intent["removedMembers"] });
  }
  value["cooling"].forEach(assertCooling); return value as unknown as StoredGroup;
}
function parseBinding(value: unknown): ProviderGroupBindingRecord {
  if (!object(value) || !keys(value, ["format", "sessionId", "binding", "released"]) || value["format"] !== 1
    || !bounded(value["sessionId"]) || typeof value["released"] !== "boolean" || value["binding"] === undefined && value["released"] !== true) throw invalid();
  if (value["binding"] !== undefined) assertBinding(value["binding"]); return value as unknown as ProviderGroupBindingRecord;
}
function assertBinding(value: unknown): asserts value is ProviderGroupBinding {
  if (!object(value) || !keys(value, ["group", "groupRevision", "memberKey", "backendId", "providerId", "modelId", "ownerNodeId"])
    || !object(value["group"]) || !keys(value["group"], ["backendId", "providerId"]) || !bounded(value["group"]["backendId"])
    || !bounded(value["group"]["providerId"]) || !decimal(value["groupRevision"]) || !bounded(value["memberKey"])
    || !bounded(value["backendId"]) || !bounded(value["providerId"]) || !bounded(value["modelId"])
    || value["ownerNodeId"] !== undefined && !bounded(value["ownerNodeId"])) throw invalid();
}
function parseHostedBinding(value: unknown): ProviderGroupHostedBinding {
  if (!object(value) || !keys(value, ["format", "id", "group", "groupRevision", "member", "modelId", "outerModelId", "phase"]) || value["format"] !== 1
    || !["id", "modelId", "outerModelId"].every(key => bounded(value[key])) || !decimal(value["groupRevision"])
    || !["opening", "ready", "closed", "unknown"].includes(String(value["phase"])) || !object(value["group"])
    || !keys(value["group"], ["backendId", "providerId"]) || !bounded(value["group"]["backendId"]) || !bounded(value["group"]["providerId"])) throw invalid();
  assertProviderGroupConfig({ strategy: "ordered", autoSwitch: true, members: [value["member"]] }); return value as unknown as ProviderGroupHostedBinding;
}
function assertReceived(value: unknown): void {
  if (!object(value) || !keys(value, ["joinId", "shareId", "memberId", "generation", "hostServerId", "nativeBackendId", "providerId"])
    || !["joinId", "shareId", "memberId", "hostServerId", "nativeBackendId", "providerId"].every(key => bounded(value[key]))
    || !integer(value["generation"], 1, Number.MAX_SAFE_INTEGER)) throw invalid();
}
function assertCooling(value: unknown): asserts value is ProviderGroupCooling {
  if (!object(value) || !keys(value, ["memberKey", "modelId", "cause", "until"]) || !bounded(value["memberKey"])
    || value["modelId"] !== undefined && !bounded(value["modelId"]) || !["usage-limit", "auth", "overload"].includes(String(value["cause"]))
    || typeof value["until"] !== "number" || !Number.isFinite(value["until"]) || value["until"] <= 0) throw invalid();
}
function invalid(): StoreError { return new StoreError("Provider group data is not a valid current-v1 record."); }
function validKey(key: ProviderGroupKey): void { identity(key.backendId); identity(key.providerId); }
function identity(value: string): void { if (!bounded(value)) throw invalid(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameKey(a: ProviderGroupKey, b: ProviderGroupKey): boolean { return a.backendId === b.backendId && a.providerId === b.providerId; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, names: readonly string[]): boolean { return Object.keys(value).every(key => names.includes(key)); }
function bounded(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function decimal(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9]\d{0,39})$/u.test(value); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
