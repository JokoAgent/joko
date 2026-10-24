import { useEffect, useState, type JSX } from "react";
import type { GetHostedAgentCatalogResponse } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { ProviderGroupSettings } from "./ProviderGroupSettings.js";
import { ErrorBanner, Spinner } from "./ui.js";

export function ProviderGroupOwnerSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element | null {
  const api = controller.providerGroups, read = controller.readProviderSharingCatalog, profile = controller.state.activeProfile;
  const [result, setResult] = useState<{ readonly api: AppController["providerGroups"]; readonly read: AppController["readProviderSharingCatalog"]; readonly ownerKey: string;
    readonly readVersion: number; readonly catalog?: GetHostedAgentCatalogResponse; readonly failed: boolean }>();
  const [readVersion, setReadVersion] = useState(0);
  const ownerKey = JSON.stringify([profile?.id, profile?.serverId, profile?.origin, controller.state.connectionGeneration]);
  const current = result?.api === api && result?.read === read && result?.ownerKey === ownerKey && result?.readVersion === readVersion ? result : undefined;
  const catalog = current?.catalog;
  useEffect(() => {
    if (!api || !read) return;
    const lifetime = new AbortController();
    void read(lifetime.signal).then(catalog => { if (!lifetime.signal.aborted) setResult({ api, read, ownerKey, readVersion, catalog, failed: false }); })
      .catch(() => { if (!lifetime.signal.aborted) setResult({ api, read, ownerKey, readVersion, failed: true }); });
    return () => lifetime.abort();
  }, [api, read, ownerKey, readVersion]);
  if (!api || !read || !profile || controller.state.connectionState !== "connected") return null;
  if (!catalog) return <section className="provider-group-settings" aria-label={t("settings.providerGroups.title")}>
    <h3>{t("settings.providerGroups.title")}</h3>
    {current?.failed ? <ErrorBanner message={t("settings.providerGroups.loadFailed")} retryLabel={t("common.retry")} onRetry={() => setReadVersion(value => value + 1)} /> : <Spinner label={t("settings.providerGroups.loading")} />}
  </section>;
  const providers = catalog.backends.flatMap(backend => backend.providers.filter(provider => provider.connected).map(provider => ({ backendId: backend.backendId,
    providerId: provider.providerId, displayName: `${backend.displayName} · ${provider.displayName}` })));
  return <ProviderGroupSettings key={`${profile.id}:${profile.serverId}:${controller.state.connectionGeneration}`} api={api} nodeName={profile.name} providers={providers} t={t} />;
}
