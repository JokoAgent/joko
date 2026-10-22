import { useEffect, useState, type JSX } from "react";
import type { GetHostedAgentCatalogResponse } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { readProviderSharingInvitation, clearProviderSharingInvitation } from "../provider-sharing-invitation.js";
import { ProviderSharingSettings } from "./ProviderSharingSettings.js";

export function ProviderSharingOwnerSettings({ controller }: { readonly controller: AppController }): JSX.Element | null {
  const profile = controller.state.activeProfile, api = controller.providerSharing, read = controller.readProviderSharingCatalog;
  const [initialLink] = useState(readProviderSharingInvitation);
  const [catalog, setCatalog] = useState<GetHostedAgentCatalogResponse>();
  useEffect(() => {
    if (initialLink && api && profile && controller.state.connectionState === "connected") clearProviderSharingInvitation(initialLink);
  }, [initialLink, api, profile, controller.state.connectionState]);
  useEffect(() => {
    setCatalog(undefined); if (!api || !read) return;
    const lifetime = new AbortController(); let reading = false;
    const refresh = async () => {
      if (reading || lifetime.signal.aborted) return; reading = true;
      try { const value = await read(lifetime.signal); if (!lifetime.signal.aborted) setCatalog(value); }
      catch { if (!lifetime.signal.aborted) setCatalog(undefined); }
      finally { reading = false; }
    };
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => { lifetime.abort(); window.clearInterval(timer); };
  }, [api, read]);
  if (!api || !profile || controller.state.connectionState !== "connected") return null;
  return <ProviderSharingSettings api={api} nodeKey={`${profile.id}:${profile.serverId}:${controller.state.connectionGeneration}`}
    nodeName={profile.name} catalog={catalog} language={controller.state.effectiveLocale} {...(initialLink ? { initialLink } : {})} />;
}
