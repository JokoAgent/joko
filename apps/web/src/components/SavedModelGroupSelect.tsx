import { useEffect, useState } from "react";
import type { TaskModelGroup } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { SelectControl } from "./ui.js";

export function SavedModelGroupSelect({ controller, value, onChange, disabled, t }: {
  controller: AppController; value?: string; onChange: (value: string | undefined) => void; disabled?: boolean; t: Translator;
}) {
  const api = controller.providerGroups?.taskModels;
  const profile = controller.state.activeProfile;
  const scope = JSON.stringify([profile?.id, profile?.serverId, controller.state.connectionGeneration]);
  const [loaded, setLoaded] = useState<{ scope: string; groups: readonly TaskModelGroup[] }>();
  useEffect(() => {
    if (!profile || !api) return;
    const request = new AbortController();
    void api.list(request.signal).then(result => {
      if (!request.signal.aborted) setLoaded({ scope, groups: result.config?.groups ?? [] });
    }).catch(() => undefined);
    return () => request.abort();
  }, [scope, api, profile?.id]);
  const groups = loaded?.scope === scope ? loaded.groups : [];
  if (!value && !groups.length) return null;
  return <label className="field"><span>{t("modelGroups.title")}</span>
    <SelectControl value={value ?? ""} disabled={disabled || !api} onChange={event => onChange(event.target.value || undefined)}>
      <option value="">{t("modelGroups.exact")}</option>
      {value && !groups.some(group => group.groupId === value) && <option value={value}>{value}</option>}
      {groups.map(group => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
    </SelectControl></label>;
}
