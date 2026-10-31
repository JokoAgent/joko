import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import * as contract from "@joko/contracts";

export interface ProviderGroupSettingsApi {
  getProviderGroup(key: { readonly backendId: string; readonly providerId: string }, signal?: AbortSignal): Promise<contract.ProviderGroupSnapshot>;
  listProviderGroupCandidates(key: { readonly backendId: string; readonly providerId: string }, signal?: AbortSignal): Promise<readonly contract.ProviderGroupCandidate[]>;
  updateProviderGroup(key: { readonly backendId: string; readonly providerId: string }, expectedRevision: bigint, config: contract.ProviderGroupConfig | undefined, signal?: AbortSignal): Promise<contract.ProviderGroupSnapshot>;
  getProviderGroupUsage(query: Omit<contract.GetProviderGroupUsageRequest, "$typeName">, signal?: AbortSignal): Promise<readonly contract.ProviderGroupUsageRow[]>;
  getProviderGroupMemberAccountUsage(query: Omit<contract.GetProviderGroupMemberAccountUsageRequest, "$typeName">, signal?: AbortSignal): Promise<contract.GetProviderGroupMemberAccountUsageResponse>;
}
/** The parent gateway owns the authenticated current-node client. Mutations
 * are never replayed after a transport failure or a configuration conflict. */
export function createProviderGroupSettingsApi(client: Client<typeof contract.ProviderGroupService>): ProviderGroupSettingsApi {
  return {
    getProviderGroup: async (key, signal) => {
      const result = await client.getProviderGroup({ key }, { signal }); return assertSnapshot(result.group, key);
    },
    listProviderGroupCandidates: async (key, signal) => {
      const result = await client.listProviderGroupCandidates({ key }, { signal });
      const seen = new Set<string>(); for (const candidate of result.candidates) {
        if (!candidate.member || seen.has(candidate.member.key)) throw new Error("Invalid Provider group candidates.");
        assertMember(candidate.member); seen.add(candidate.member.key);
      }
      return result.candidates;
    },
    updateProviderGroup: async (key, expectedRevision, config, signal) => {
      if (expectedRevision < 0n) throw new Error("Invalid Provider group revision.");
      if (config) assertConfig(config);
      const result = await client.updateProviderGroup({ key, expectedRevision,
        update: config ? { case: "config", value: config } : { case: "delete", value: create(contract.DeleteProviderGroupSchema) } }, { signal });
      return assertSnapshot(result.group, key);
    },
    getProviderGroupUsage: async (query, signal) => (await client.getProviderGroupUsage(query, { signal })).rows,
    getProviderGroupMemberAccountUsage: async (query, signal) => {
      const result = await client.getProviderGroupMemberAccountUsage(query, { signal });
      if (result.memberKey !== query.memberKey || result.revision !== query.expectedRevision
        || !['ready', 'unsupported', 'offline', 'shared'].includes(result.state)
        || (result.state === 'ready') !== (result.accountUsage !== undefined)) throw new Error('The original Provider account quota changed.');
      return result;
    }
  };
}
export function providerGroupDraft(config: contract.ProviderGroupConfig | undefined, candidates: readonly contract.ProviderGroupCandidate[], key: { readonly backendId: string; readonly providerId: string }): contract.ProviderGroupConfig {
  return config ? create(contract.ProviderGroupConfigSchema, config) : create(contract.ProviderGroupConfigSchema, { strategy: contract.ProviderGroupStrategy.LEAST_BUSY, autoSwitch: true,
    members: candidates.flatMap(candidate => candidate.member?.kind === contract.ProviderGroupMemberKind.LOCAL && candidate.member.backendId === key.backendId && candidate.member.providerId === key.providerId ? [candidate.member] : []) });
}
export function providerGroupUsageDateRange(period: "all" | "30d" | "7d" | "today" | "day", selected: string, now = Date.now()): { readonly fromDay?: string; readonly throughDay?: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  if (period === "all") return {};
  if (period === "day") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(selected) || !Number.isFinite(Date.parse(selected + "T00:00:00Z"))) throw new Error("Select a valid usage date.");
    return { fromDay: selected, throughDay: selected };
  }
  return { fromDay: period === "today" ? today : new Date(now - (period === "7d" ? 6 : 29) * 86_400_000).toISOString().slice(0, 10), throughDay: today };
}
function assertSnapshot(value: contract.ProviderGroupSnapshot | undefined, key: { readonly backendId: string; readonly providerId: string }): contract.ProviderGroupSnapshot {
  if (!value || value.key?.backendId !== key.backendId || value.key.providerId !== key.providerId || value.revision < 0n) throw new Error("The Provider group source changed.");
  if (value.config) assertConfig(value.config); return value;
}
function assertConfig(value: contract.ProviderGroupConfig): void {
  if (![contract.ProviderGroupStrategy.LEAST_BUSY, contract.ProviderGroupStrategy.ROUND_ROBIN, contract.ProviderGroupStrategy.ORDERED, contract.ProviderGroupStrategy.WEIGHTED].includes(value.strategy)
    || value.members.length > 512 || new Set(value.members.map(member => member.key)).size !== value.members.length) throw new Error("Invalid Provider group config.");
  value.members.forEach(assertMember);
}
function assertMember(value: contract.ProviderGroupMember): void {
  if (![value.key, value.backendId, value.nativeBackendId, value.providerId, value.nodeId, value.displayName].every(identity)
    || ![contract.ProviderGroupMemberKind.LOCAL, contract.ProviderGroupMemberKind.DEVICE, contract.ProviderGroupMemberKind.SHARE].includes(value.kind)
    || !Number.isSafeInteger(value.capacity) || value.capacity < 1 || value.capacity > 16 || !Number.isSafeInteger(value.weight) || value.weight < 1 || value.weight > 100
    || value.kind === contract.ProviderGroupMemberKind.SHARE && !value.received) throw new Error("Invalid Provider group member.");
}
function identity(value: string): boolean { return value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value); }
