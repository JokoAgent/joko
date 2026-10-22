import { useEffect, useRef, useState, type JSX } from "react";
import { Monitor } from "lucide-react";
import type { AppController } from "../controller.js";
import { requestCatalogNavigationLeave } from "../catalog-navigation-leave.js";
import type { Translator } from "./types.js";
import { Button, SelectControl } from "./ui.js";

type Selection = { readonly profileId: string; readonly loading: boolean; readonly error?: string };
export function useCatalogNodeSelection(controller: AppController, requestedProfileId?: string) {
  const [selection, setSelection] = useState<Selection>();
  const request = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const active = controller.state.activeProfile;
  const profiles = controller.state.profiles ?? [];
  const selectedId = selection?.profileId ?? requestedProfileId ?? active?.id;
  const profile = profiles.find(candidate => candidate.id === selectedId);
  const ready = active !== undefined && !selection && (requestedProfileId === undefined || requestedProfileId === active.id && profile !== undefined)
    && controller.state.connectionState === "connected"
    && (!profile || active?.serverId === profile.serverId && active?.deviceId === profile.deviceId && active?.origin === profile.origin);
  const select = async (profileId: string, tab: "extensions" | "skills"): Promise<void> => {
    if (profileId === active?.id && ready) return;
    const revision = ++request.current;
    try {
      const leave = requestCatalogNavigationLeave(new AbortController().signal);
      if ((leave && !await leave) || !mounted.current || request.current !== revision) return;
      setSelection({ profileId, loading: true });
      await controller.openMachineCatalog(profileId, tab);
      if (mounted.current && request.current === revision) setSelection(undefined);
    } catch (error) {
      if (mounted.current && request.current === revision) setSelection({ profileId, loading: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  };
  return { profiles, selectedId, profile, selection, ready, select,
    owner: JSON.stringify([active?.id, active?.serverId, active?.deviceId, active?.origin, controller.state.connectionGeneration]),
    presence: controller.state.machinePresenceByProfile ?? {} };
}
export type CatalogNodeSelection = ReturnType<typeof useCatalogNodeSelection>;

/** Plugins and Skills share one selected authority and their existing complete views. */
export function CatalogNodePicker({ scope, tab, t }: {
  readonly scope: CatalogNodeSelection; readonly tab: "extensions" | "skills"; readonly t: Translator;
}): JSX.Element | null {
  if (!scope.profiles.length) return null;
  return <div className="catalog-node-picker"><Monitor aria-hidden="true" />
    <SelectControl aria-label={t("catalog.node")} value={scope.selectedId ?? ""}
      onChange={event => { void scope.select(event.target.value, tab); }}>
      {scope.selectedId && !scope.profile && <option value={scope.selectedId} disabled>{t("catalog.missingNode")}</option>}
      {scope.profiles.map(profile => <option key={profile.id} value={profile.id}>
        {profile.name}{scope.presence[profile.id] === "offline" ? ` · ${t("catalog.offline")}` : ""}
      </option>)}
    </SelectControl>
  </div>;
}

export function CatalogNodeUnavailable({ scope, tab, t }: {
  readonly scope: CatalogNodeSelection; readonly tab: "extensions" | "skills"; readonly t: Translator;
}): JSX.Element {
  return <section className="settings-card" aria-busy={scope.selection?.loading === true}>
    <p role={scope.selection?.error ? "alert" : "status"}>{scope.selection?.loading
      ? t("catalog.connecting", { name: scope.profile?.name ?? t("catalog.node") })
      : scope.selection?.error ?? t("catalog.unavailable")}</p>
    {scope.selectedId && !scope.selection?.loading && <Button onClick={() => { void scope.select(scope.selectedId!, tab); }}>{t("common.retry")}</Button>}
  </section>;
}
