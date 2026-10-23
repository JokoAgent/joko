import type { ProviderModel } from "@joko/core";
import { groupKey, type ProviderGroupKey, type ProviderGroupMember } from "@joko/store";
import type { ProviderSharingDirectoryPort, ProviderSharingRecipient } from "./provider-sharing-ports.js";
import type { ProviderGroupQuota, ProviderGroupQuotaReader } from "./provider-group-quota.js";

export interface ProviderGroupDirectorySource extends ProviderGroupKey {
  readonly key: string; readonly kind: ProviderGroupMember["kind"]; readonly nodeId: string; readonly displayName: string;
  readonly nativeBackendId: string;
  readonly nativeBackendInstanceGeneration?: number;
  readonly providerName: string; readonly agentKind: string; readonly available: boolean; readonly remotelyEnabled: boolean;
  readonly models: readonly ProviderModel[]; readonly brand?: string;
  readonly received?: ProviderGroupMember["received"];
  /** Exact live registry/route/grant generation, checked again at admission. */
  readonly assertCurrent: () => void;
}
export interface ProviderGroupMemberStatus {
  readonly member: ProviderGroupMember; readonly available: boolean; readonly reachable: boolean;
  readonly model?: ProviderModel; readonly quota: ProviderGroupQuota; readonly running: number;
  readonly reason?: "offline" | "paused" | "model" | "authorization" | "quota" | "cooling";
  readonly assertCurrent: () => void;
}
export interface ProviderGroupDirectoryOptions {
  readonly sources: () => readonly ProviderGroupDirectorySource[];
  readonly refresh?: (signal: AbortSignal) => Promise<void>;
  readonly quotas: ProviderGroupQuotaReader;
  readonly running: (source: ProviderGroupDirectorySource) => number;
  readonly sharing?: ProviderSharingDirectoryPort;
  /** Captures the owning account incarnation; late directory reads are discarded. */
  readonly ownerGeneration: () => string;
}
export interface ProviderGroupDirectoryRequest {
  readonly agentKind: string; readonly modelId: string; readonly logicalModelId?: string;
  readonly ownTask: boolean; readonly recipient?: ProviderSharingRecipient; readonly fresh?: boolean;
}
export class ProviderGroupDirectory {
  constructor(readonly options: ProviderGroupDirectoryOptions) {}
  sources(): readonly ProviderGroupDirectorySource[] { return this.options.sources(); }
  candidates(group: ProviderGroupKey): readonly ProviderGroupDirectorySource[] {
    const sources = this.sources(), anchor = sources.find(source => groupKey(source) === groupKey(group));
    if (!anchor || anchor.kind !== "local") return [];
    return sources.filter(source => source.agentKind === anchor.agentKind && sameProvider(anchor, source));
  }
  async refresh(signal: AbortSignal): Promise<void> {
    const generation = this.options.ownerGeneration(); await this.options.refresh?.(signal);
    signal.throwIfAborted(); if (generation !== this.options.ownerGeneration()) throw new Error("Provider group owner changed.");
  }
  async read(member: ProviderGroupMember, request: ProviderGroupDirectoryRequest, signal: AbortSignal): Promise<ProviderGroupMemberStatus> {
    signal.throwIfAborted(); const generation = this.options.ownerGeneration();
    const source = this.sources().find(source => source.key === member.key && source.backendId === member.backendId && source.providerId === member.providerId && source.nodeId === member.nodeId);
    const unavailable = (reason: ProviderGroupMemberStatus["reason"], reachable = source?.available ?? false): ProviderGroupMemberStatus => ({
      member, available: false, reachable, quota: { limited: false }, running: 0, ...(reason ? { reason } : {}), assertCurrent: () => { throw new Error("Provider group member is unavailable."); } });
    if (!source || !source.available) return unavailable("offline", false);
    if (source.agentKind !== request.agentKind || source.kind !== "local" && !source.remotelyEnabled) return unavailable("model");
    if (member.paused && !(member.kind === "local" && request.ownTask)) return unavailable("paused");
    const model = source.models.find(model => model.modelId === request.modelId)
      ?? (request.logicalModelId === undefined ? undefined : source.models.find(model => (model.logicalId ?? model.modelId) === request.logicalModelId));
    if (!model) return unavailable("model");
    const assertCurrent = () => {
      signal.throwIfAborted(); if (generation !== this.options.ownerGeneration()) throw new Error("Provider group owner changed.");
      source.assertCurrent();
      if (source.kind === "share") {
        if (!member.received || !this.options.sharing) throw new Error("Provider share authority is unavailable.");
        this.options.sharing.assertReceived(member.received);
        if (request.recipient) {
          const permission = this.options.sharing.canRelayToRecipient(member.received, request.recipient);
          if (!permission.approved) throw new Error("Provider reshare was not approved."); permission.assertCurrent();
        }
      }
    };
    try { assertCurrent(); } catch { return unavailable("authorization"); }
    const quota = await this.options.quotas.read(member, model.modelId, signal, request.fresh);
    assertCurrent();
    return { member, available: !quota.limited, reachable: true, model, quota, running: this.options.running(source),
      ...(quota.limited ? { reason: "quota" as const } : {}), assertCurrent };
  }
  async members(members: readonly ProviderGroupMember[], request: ProviderGroupDirectoryRequest, signal: AbortSignal): Promise<readonly ProviderGroupMemberStatus[]> {
    const complete = new Map<string, ProviderGroupMemberStatus>();
    const all = Promise.all(members.map(async member => {
      const value = await this.read(member, request, signal); complete.set(member.key, value); return value;
    }));
    // Return early only when at least one member can actually accept the turn.
    // If all completed reads say unavailable, slow nodes still get their chance.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([all, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); timer.unref(); })]);
      if (complete.size !== members.length && [...complete.values()].some(member => member.available)) {
        void all.catch(() => {}); return members.flatMap(member => { const value = complete.get(member.key); return value ? [value] : []; });
      }
      return await all;
    } finally { if (timer) clearTimeout(timer); }
  }
}
/** Identity metadata proves official brands; custom connections match ID or
 * normalized names. Native Backend IDs never decide account equivalence. */
export function sameProvider(a: Pick<ProviderGroupDirectorySource, "providerId" | "providerName" | "brand">, b: Pick<ProviderGroupDirectorySource, "providerId" | "providerName" | "brand">): boolean {
  const brandA = a.brand ?? officialBrand(a.providerId), brandB = b.brand ?? officialBrand(b.providerId);
  if (brandA || brandB) return brandA !== undefined && brandA === brandB;
  return a.providerId === b.providerId || normalize(a.providerName) !== "" && normalize(a.providerName) === normalize(b.providerName);
}
function normalize(value: string): string { return value.trim().replace(/\s+/gu, " ").toLowerCase(); }
function officialBrand(id: string): string | undefined {
  const fixed = ["anthropic", "openai", "xai", "gemini", "xd"], account = /^([a-z0-9_]+(?:-[a-z0-9_]+)*?)-[0-9a-f]{8}$/u.exec(id)?.[1];
  return fixed.includes(id) ? id : account && fixed.includes(account) ? account : undefined;
}
