import { useEffect, useMemo, useState, type JSX } from "react";

import type { AppController } from "../controller.js";
import type { AppSnapshot, ToolPolicyEffectiveSourceView, ToolPolicySettingsView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Pill, CheckboxControl, SelectControl, SwitchControl } from "./ui.js";

export function ToolPolicySettings({ controller, snapshot, activeTargetId, runAction, showHeading = true, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly activeTargetId?: string;
  readonly runAction: RunAction;
  readonly showHeading?: boolean;
  readonly t: Translator;
}): JSX.Element {
  const targets = useMemo(() => snapshot.targets.filter((target) => !target.archived), [snapshot.targets]);
  const [targetId, setTargetId] = useState(() =>
    targets.some((target) => target.id === activeTargetId) ? activeTargetId ?? "" : "");
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (targetId !== "" && !targets.some((target) => target.id === targetId)) setTargetId("");
  }, [targetId, targets]);
  const update = (
    policy: ToolPolicySettingsView,
    patch: { readonly enabled: boolean } | { readonly reset: true }
  ): void => {
    const action = `${policy.toolProviderId}:${targetId || "user"}`;
    setPending(action);
    runAction(`tool-policy:${action}`, async () => {
      try {
        await controller.updateToolPolicySettings(policy.toolProviderId, targetId || undefined, patch);
      } finally {
        setPending((current) => current === action ? undefined : current);
      }
    });
  };

  return <>
    {showHeading && <div className="settings-heading">
      <h2>{t("settings.toolPolicies.title")}</h2>
      <p>{t("settings.toolPolicies.body")}</p>
    </div>}
    <section className="settings-card tool-policy-controls">
      <label className="setting-row tool-policy-scope">
        <div><strong>{t("settings.toolPolicies.scope")}</strong><span>{t("settings.toolPolicies.newTasksOnly")}</span></div>
        <SelectControl aria-label={t("settings.toolPolicies.scope")} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">{t("settings.toolPolicies.userDefault")}</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
        </SelectControl>
      </label>
    </section>
    <section className="settings-card tool-policy-list">
      {snapshot.settings.toolPolicies.map((policy) => {
        const target = targetId === ""
          ? undefined
          : policy.targetSettings.find((candidate) => candidate.targetId === targetId);
        const enabled = target?.effectiveEnabled ?? policy.userEffectiveEnabled;
        const source = target?.effectiveSource ?? policy.userEffectiveSource;
        const override = targetId === "" ? policy.userOverride : target?.projectOverride;
        const action = `${policy.toolProviderId}:${targetId || "user"}`;
        return <article className="setting-row" key={policy.toolProviderId}>
          <div>
            <strong>{policy.displayName}</strong>
            <span>{policy.description}</span>
          </div>
          <div className="tool-policy-actions">
            <Pill tone="neutral">{sourceLabel(source, t)}</Pill>
            {override !== undefined && <Button
              disabled={pending === action}
              onClick={() => update(policy, { reset: true })}
            >{t("settings.toolPolicies.reset")}</Button>}
            <SwitchControl
              aria-label={t("settings.toolPolicies.toggleAria", { name: policy.displayName })}
              checked={enabled}
              disabled={pending === action}
              onChange={(event) => update(policy, { enabled: event.target.checked })}
            />
          </div>
        </article>;
      })}
      {snapshot.settings.toolPolicies.length === 0 && <p className="muted tool-policy-empty">
        {t("settings.toolPolicies.empty")}
      </p>}
    </section>
  </>;
}

function sourceLabel(source: ToolPolicyEffectiveSourceView, t: Translator): string {
  if (source === "projectOverride") return t("settings.toolPolicies.source.project");
  if (source === "userDefault") return t("settings.toolPolicies.source.user");
  return t("settings.toolPolicies.source.product");
}
