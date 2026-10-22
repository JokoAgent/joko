import { useEffect, useState, type JSX } from "react";
import type { GetHostedAgentCatalogResponse } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { ProviderGroupSettings } from "./ProviderGroupSettings.js";

export function ProviderGroupOwnerSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element | null {
  const api = controller.providerGroups, read = controller.readProviderSharingCatalog, profile = controller.state.activeProfile;
  const [catalog, setCatalog] = useState<GetHostedAgentCatalogResponse>();
  useEffect(() => {
    setCatalog(undefined); if (!api || !read) return;
    const lifetime = new AbortController();
    void read(lifetime.signal).then(value => { if (!lifetime.signal.aborted) setCatalog(value); }).catch(() => {});
    return () => lifetime.abort();
  }, [api, read]);
  if (!api || !profile || controller.state.connectionState !== "connected" || !catalog) return null;
  const providers = catalog.backends.flatMap(backend => backend.providers.filter(provider => provider.connected).map(provider => ({ backendId: backend.backendId,
    providerId: provider.providerId, displayName: `${backend.displayName} · ${provider.displayName}` })));
  return <ProviderGroupSettings key={`${profile.id}:${profile.serverId}:${controller.state.connectionGeneration}`} api={api} nodeName={profile.name} providers={providers} t={t} />;
}
