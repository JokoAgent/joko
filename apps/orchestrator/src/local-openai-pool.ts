import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { groupKey, type ProviderGroupKey, type ProviderGroupStore } from "@joko/store";
import { providerGroupDefaultMember, type ProviderGroupDirectory, type ProviderGroupDirectorySource } from "./provider-group-directory.js";
import type { ProviderDescriptor } from "./credential-manager.js";

export type LocalOpenAiAccountIdentity = { kind: "subscription" | "key"; generation: string };
// Reserved internal routing identity. The owner-facing API only accepts actual connections.
const poolBackend = "__joko_local_openai_accounts__";
export const isLocalOpenAiPool = (key: ProviderGroupKey) => key.backendId === poolBackend;
export function localOpenAiPoolKey(target: ProviderGroupKey): ProviderGroupKey {
  return { backendId: poolBackend, providerId: createHash("sha256").update(groupKey(target)).digest("hex") };
}

export function officialOpenAiEndpoint(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? "");
    return url.origin === "https://api.openai.com" && /^\/v1\/?$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function isOfficialOpenAiKeyModel(entry: ProviderDescriptor, modelId: string): boolean {
  const model = entry.provider.models.find(item => item.id === modelId);
  return !!model && entry.enabled && entry.authenticationState === "authenticated"
    && (entry.kind === "api_key" || entry.kind === "custom_endpoint") && !!entry.provider.apiKeyEnv
    && !entry.provider.keyless && !entry.nativeCredentialReferenceId && Object.keys(entry.provider.headers ?? {}).length === 0
    && entry.credentialOrigin === "https://api.openai.com" && officialOpenAiEndpoint(entry.provider.baseUrl)
    && (model.api ?? entry.provider.api) === "openai-responses" && model.supportsTools !== false
    && (!model.baseUrl || officialOpenAiEndpoint(model.baseUrl)) && (!entry.requestPath || entry.requestPath === "/responses");
}

export class LocalOpenAiPools {
  constructor(private readonly store: ProviderGroupStore, private readonly directory: ProviderGroupDirectory) {}

  #sources(target: ProviderGroupKey) {
    const sources = this.directory.sources().filter(source => source.kind === "local" && source.available && source.openAiAccount);
    const anchor = sources.find(source => groupKey(source) === groupKey(target));
    const kind = (source: ProviderGroupDirectorySource) => source.models.map(model => source.openAiAccount?.(model.modelId)).find(Boolean)?.kind;
    return { anchor, rows: anchor ? sources.filter(source => source.agentKind === anchor.agentKind)
      .flatMap(source => { const type = kind(source); return type ? [{ source, type }] : []; }) : [] };
  }

  get(target: ProviderGroupKey): contract.GetLocalOpenAiPoolResponse {
    const group = this.store.snapshot(localOpenAiPoolKey(target));
    const { anchor, rows } = this.#sources(target);
    const members = group.config?.members ?? [];
    const anchorKind = rows.find(row => row.source === anchor)?.type;
    const listed = anchor && anchorKind ? rows.filter(({ source, type }) => source === anchor || members.some(row => row.key === source.key)
      || (type !== anchorKind || members.length > 1) && anchor.models.some(model => anchor.openAiAccount?.(model.modelId) && source.openAiAccount?.(model.modelId))) : [];
    return create(contract.GetLocalOpenAiPoolResponseSchema, { revision: group.revision,
      accounts: [...listed.map(({ source, type }) => ({ key: { backendId: source.backendId, providerId: source.providerId },
        displayName: source.providerName, subscription: type === "subscription", included: source === anchor || members.some(row => row.key === source.key) })),
      ...members.filter(member => !listed.some(row => row.source.key === member.key)).map(member => ({
        key: { backendId: member.backendId, providerId: member.providerId }, displayName: member.providerId, included: true }))] });
  }

  set(target: ProviderGroupKey, source: ProviderGroupKey, included: boolean, revision: bigint) {
    return this.store.store.transaction(() => this.#set(target, source, included, revision));
  }

  #set(target: ProviderGroupKey, source: ProviderGroupKey, included: boolean, revision: bigint) {
    const key = localOpenAiPoolKey(target), group = this.store.snapshot(key), members = group.config?.members ?? [];
    if (groupKey(target) === groupKey(source)) throw new Error("Select a different local OpenAI account.");
    let next = members.filter(row => groupKey(row) !== groupKey(source));
    if (included) {
      const { rows } = this.#sources(target);
      const to = rows.find(row => groupKey(row.source) === groupKey(target)), from = rows.find(row => groupKey(row.source) === groupKey(source));
      if (!to || !from || !to.source.models.some(model => to.source.openAiAccount?.(model.modelId) && from.source.openAiAccount?.(model.modelId))) {
        throw new Error("The local OpenAI connections do not serve a common supported model.");
      }
      if (from.type === to.type && !members.some(member => rows.some(row => row.type !== to.type && row.source.key === member.key))) {
        throw new Error("Select a subscription and an official API Key.");
      }
      if (this.store.snapshot(localOpenAiPoolKey(source)).config || this.store.list().some(other => isLocalOpenAiPool(other)
        && groupKey(other) !== groupKey(key) && other.config?.members.some(row => groupKey(row) === groupKey(source) || groupKey(row) === groupKey(target)))) {
        throw new Error("A selected connection already belongs to another account pool.");
      }
      to.source.assertCurrent(); from.source.assertCurrent();
      if (!next.length) next = [providerGroupDefaultMember(to.source)];
      next = [...next, providerGroupDefaultMember(from.source)];
    }
    const updated = this.store.update(key, next.length > 1 ? { strategy: "ordered", autoSwitch: true, members: next } : undefined, revision);
    // Every member is local. Binding releases were persisted by update in this transaction.
    for (const cleanup of updated.cleanup) this.store.acknowledgeCleanup(key, cleanup.id);
    return this.get(target);
  }
}
