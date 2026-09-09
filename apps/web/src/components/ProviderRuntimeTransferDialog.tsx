import { useState, type JSX } from "react";
import type { BackendView, ProviderRuntimeConfigurationView } from "../model.js";
import { providerCompatibilityLabel, providerEndpointOrigin, providerRequestPathValid, providerTransferDifferences, transferProviderRuntime, type ProviderTransferField } from "../provider-runtime-draft.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, ErrorBanner, Modal, ModalBackButton } from "./ui.js";

export interface ProviderTransferTarget { readonly backend: BackendView; readonly draft: ProviderRuntimeConfigurationView; readonly hasSecret: boolean }

export function ProviderRuntimeTransferDialog({ source, sourceBackend, sourceHasSecret, targets, t, onClose, onApply }: {
  readonly source: ProviderRuntimeConfigurationView; readonly sourceBackend: BackendView; readonly sourceHasSecret: boolean;
  readonly targets: readonly ProviderTransferTarget[]; readonly t: Translator; readonly onClose: () => void;
  readonly onApply: (targets: readonly { readonly runtime: ProviderRuntimeConfigurationView; readonly authenticationSelected: boolean }[]) => void;
}): JSX.Element {
  const plans = targets.map((target) => ({ ...target, differences: providerTransferDifferences(source, target.draft, sourceBackend, target.backend, sourceHasSecret, target.hasSecret) }));
  const [selected, setSelected] = useState<ReadonlyMap<string, readonly ProviderTransferField[]>>(() => new Map(plans.map((target) => [target.backend.id,
    providerEndpointOrigin(target.draft.endpoint) !== undefined || target.differences.some((diff) => diff.field === "endpoint" && diff.state === "empty")
      ? target.differences.filter((diff) => diff.state === "empty" && !["authentication", "headers"].includes(diff.field)).map((diff) => diff.field) : []])));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState(false);
  const hasSelection = [...selected.values()].some((fields) => fields.length > 0);
  const hasOverwrite = plans.some((target) => target.differences.some((diff) => diff.state === "conflict" && selected.get(target.backend.id)?.includes(diff.field)));
  const apply = (): void => {
    try {
      const changes = plans.flatMap((target) => {
        const fields = selected.get(target.backend.id) ?? [];
        return fields.length === 0 ? [] : [{ runtime: transferProviderRuntime(source, target.draft, sourceBackend, target.backend, fields, sourceHasSecret),
          authenticationSelected: fields.includes("authentication") }];
      });
      if (hasOverwrite && !confirm) { setError(false); setConfirm(true); return; }
      onApply(changes);
    } catch { setError(true); }
  };
  const summary = (field: ProviderTransferField, draft: ProviderRuntimeConfigurationView, hasSecret = false): string => {
    switch (field) {
      case "endpoint": return providerEndpointOrigin(draft.endpoint) === undefined ? t("settings.runtimeTransfer.unset") : `${providerCompatibilityLabel(draft.compatibility)} · ${draft.endpoint} ${providerRequestPathValid(draft.requestPath) ? draft.requestPath ?? "" : ""}`.trim();
      case "models": return t("settings.runtimeTransfer.modelCount", { count: draft.models.filter((model) => model.modelId.trim()).length });
      case "authentication": return t(draft.keyless ? "settings.customProvider.noAuthentication" : draft.credentialId || hasSecret ? "settings.runtimeTransfer.credentialSet" : "settings.runtimeTransfer.unset");
      case "headers": return t("settings.runtimeTransfer.headerCount", { count: draft.headers.length });
      case "modelsEndpoint": return draft.modelsEndpoint && providerEndpointOrigin(draft.modelsEndpoint) !== undefined ? draft.modelsEndpoint : t("settings.runtimeTransfer.unset");
    }
  };
  return <Modal open title={t(confirm ? "settings.runtimeTransfer.confirmTitle" : "settings.runtimeTransfer.title")}
    description={t("settings.runtimeTransfer.description", { source: sourceBackend.name })} onClose={onClose} size="large" className="provider-transfer-modal"
    headerLeading={<ModalBackButton label={t("common.back")} onClick={() => confirm ? setConfirm(false) : onClose()} />}>
    {error && <ErrorBanner message={t("settings.runtimeTransfer.invalidSelection")} />}
    <p>{t("settings.runtimeTransfer.credentialsSeparate")}</p>
    {plans.filter((target) => !confirm || (selected.get(target.backend.id)?.length ?? 0) > 0).map((target) => <section className="provider-transfer-target" key={target.backend.id} aria-label={target.backend.name}>
      <h3>{target.backend.name}</h3>
      {target.differences.length === 0 ? <p>{t("settings.runtimeTransfer.noFields")}</p> : target.differences.map((diff) => {
        const checked = selected.get(target.backend.id)?.includes(diff.field) === true;
        if (confirm && !checked) return null;
        return <label className="provider-transfer-row" key={diff.field}>
          <CheckboxControl checked={checked} disabled={confirm || diff.state === "same" || diff.state === "incompatible"}
            aria-label={`${target.backend.name} · ${t(`settings.runtimeTransfer.field.${diff.field}`)}`}
            onChange={(event) => { setError(false); setSelected((current) => {
              const fields = current.get(target.backend.id) ?? [];
              return new Map(current).set(target.backend.id, event.target.checked ? [...fields, diff.field] : fields.filter((field) => field !== diff.field));
            }); }} />
          <span><strong>{t(`settings.runtimeTransfer.field.${diff.field}`)}</strong><small>{t(`settings.runtimeTransfer.state.${diff.state}`)}</small>
            {diff.field === "authentication" && source.keyless && target.draft.headers.length > 0 && <small>{t("settings.runtimeTransfer.clearHeaders", { count: target.draft.headers.length })}</small>}
            <span className="provider-transfer-values"><span>{t("settings.runtimeTransfer.from")}: {summary(diff.field, source, sourceHasSecret)}</span><span>{t("settings.runtimeTransfer.to")}: {summary(diff.field, target.draft, target.hasSecret)}</span></span>
          </span>
        </label>;
      })}
    </section>)}
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" disabled={!hasSelection} onClick={apply}>
      {t(confirm ? "settings.runtimeTransfer.confirmApply" : hasOverwrite ? "settings.runtimeTransfer.reviewOverwrite" : "settings.runtimeTransfer.apply")}
    </Button></div>
  </Modal>;
}
