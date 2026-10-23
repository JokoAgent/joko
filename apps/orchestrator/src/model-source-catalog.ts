import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { BackendDescriptor } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { HostedAgentSources } from "./hosted-agent-sources.js";
import type { ProviderGroupRuntime } from "./provider-group-runtime.js";

export interface ModelSourceCatalogDependencies {
  readonly store: OperationalStore;
  readonly hostedAgentSources?: Pick<HostedAgentSources, "groupCatalog" | "modelAvailable">;
  readonly providerGroups?: Pick<ProviderGroupRuntime, "store" | "sharedProvider">;
}

/** Public source facts are composed from authenticated source identities and
 * the owning group settings. No native paths or credentials enter the view. */
export function projectModelSource(
  dependencies: ModelSourceCatalogDependencies,
  model: contract.ModelDescriptor
): contract.ModelDescriptor {
  const providerId = model.key?.providerId;
  if (!providerId) return model;
  const backend = dependencies.store.listBackends().find(row => row.descriptor.id === model.backendId)?.descriptor;
  if (!backend) return model;
  const entry = dependencies.hostedAgentSources?.groupCatalog().find(row => row.backendId === model.backendId);
  const provider = entry?.catalog.providers.find(row => row.providerId === providerId);
  const group = dependencies.providerGroups?.store.snapshot({ backendId: model.backendId, providerId }).config;
  const remoteGroup = provider?.group;
  const grouped = dependencies.providerGroups?.store.list().some(row =>
    (row.backendId !== model.backendId || row.providerId !== providerId)
      && row.config?.members.some(member => member.backendId === model.backendId && member.providerId === providerId)) === true;
  const kind = entry?.received ? contract.ModelSourceKind.SHARE : group || remoteGroup ? contract.ModelSourceKind.GROUP
    : entry ? contract.ModelSourceKind.DEVICE : contract.ModelSourceKind.LOCAL;
  const source = create(contract.ModelSourceDescriptorSchema, {
    kind,
    displayName: provider?.displayName ?? backend.providers?.find(row => row.providerId === providerId)?.displayName ?? providerId,
    nodeId: entry?.catalog.nodeId ?? "",
    nodeName: entry?.name ?? "",
    nativeAdapterKind: entry?.catalog.nativeAdapterKind ?? backend.adapterKind,
    groupMemberCount: group ? new Set(group.members.map(member => member.nodeId)).size : remoteGroup?.memberCount ?? 0,
    grouped
  });
  const available = group ? dependencies.providerGroups?.sharedProvider(model.backendId, providerId)?.models.some(row => row.modelId === model.key!.modelId) === true
    : model.available && dependencies.hostedAgentSources?.modelAvailable(model.backendId, providerId, model.key!.modelId) !== false;
  return { ...model, source, available };
}

/** Group catalogs retain the anchor route while including the exact model
 * union already owned by the scheduler. Ordinary routes retain their catalog. */
export function modelSourceCatalogModels(dependencies: ModelSourceCatalogDependencies, backend: BackendDescriptor): BackendDescriptor["models"] {
  const models = new Map(backend.models.map(model => [JSON.stringify([model.providerId, model.modelId]), model]));
  for (const group of dependencies.providerGroups?.store.list().filter(row => row.backendId === backend.id) ?? []) {
    for (const [key, model] of models) if (model.providerId === group.providerId) models.delete(key);
    for (const model of dependencies.providerGroups?.sharedProvider(backend.id, group.providerId)?.models ?? []) {
      models.set(JSON.stringify([model.providerId, model.modelId]), model);
    }
  }
  return [...models.values()];
}

export function modelSourceFavoriteUnavailableReason(
  dependencies: ModelSourceCatalogDependencies,
  backendId: string,
  providerId: string,
  modelId: string
): string | undefined {
  if (dependencies.providerGroups?.store.snapshot({ backendId, providerId }).config) {
    return dependencies.providerGroups.sharedProvider(backendId, providerId)?.models.some(row => row.modelId === modelId)
      ? "" : "The Provider group has no available source for this model.";
  }
  if (dependencies.hostedAgentSources?.modelAvailable(backendId, providerId, modelId) === false) return "Model source is unavailable.";
  if (dependencies.providerGroups?.store.list().some(group => (group.backendId !== backendId || group.providerId !== providerId)
    && group.config?.members.some(member => member.backendId === backendId && member.providerId === providerId))) {
    return "This model source is now selected through its Provider group.";
  }
  return dependencies.hostedAgentSources?.modelAvailable(backendId, providerId, modelId) === true ? "" : undefined;
}
