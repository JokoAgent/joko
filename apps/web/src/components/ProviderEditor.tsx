import { useEffect, useMemo, useRef, useState, type Dispatch, type JSX, type SetStateAction } from "react";
import { CirclePlus, Trash2 } from "lucide-react";
import { capabilityNames } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { AppSnapshot, BackendView, ProviderCompatibilityView, ProviderConfigurationView, ProviderDraft, ProviderModelConfigurationView, ProviderRuntimeConfigurationView, ModelInputModalityView } from "../model.js";
import { emptyProviderModel, emptyProviderRuntime, providerCompatibilityLabel, providerCredentialBindingsValid, providerEndpointOrigin, providerRequestPathValid, supportsProviderField } from "../provider-runtime-draft.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, ErrorBanner, IconButton, Modal, SelectControl, SwitchControl, cx } from "./ui.js";
import { ProviderFlowBackButton, ProviderFlowFooter } from "./ProviderFlow.js";
import { ProviderRuntimeTransferDialog } from "./ProviderRuntimeTransferDialog.js";
import "./provider-editor.css";

interface ProviderEditorProps {
  readonly open: boolean; readonly provider?: ProviderConfigurationView; readonly backends: readonly BackendView[];
  readonly credentials: AppSnapshot["settings"]["credentials"]; readonly providerIds: readonly string[];
  readonly saveCredential: AppController["saveCredential"]; readonly saveProvider: AppController["saveProvider"];
  readonly t: Translator; readonly onClose: () => void; readonly onBack?: () => void; readonly onSaved: () => void;
}

export function ProviderEditor({ open, provider, backends, credentials, providerIds, saveCredential, saveProvider, t, onClose, onBack, onSaved }: ProviderEditorProps): JSX.Element {
  const available = backends.filter((backend) => backend.capabilities.get(capabilityNames.providerManagedCatalog)?.supported === true && (backend.providerRuntimeSupport?.protocols.length ?? 0) > 0);
  const initial = (): ProviderDraft => provider === undefined
    ? { id: "", name: "", kind: "customEndpoint", enabled: true, revision: 0n, runtimes: available[0] === undefined ? [] : [emptyProviderRuntime(available[0])] }
    : { ...provider };
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const [activeId, setActiveId] = useState(() => draft.runtimes[0]?.backendId ?? available[0]?.id ?? "");
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({});
  const [idEdited, setIdEdited] = useState(provider !== undefined);
  const [saving, setSaving] = useState(false);
  const [retired, setRetired] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [transfer, setTransfer] = useState<{ readonly draft: ProviderDraft; readonly backendId: string;
    readonly descriptorKey: string; readonly secrets: Readonly<Record<string, string>>; readonly savedRevision: bigint | undefined }>();
  const descriptorKey = JSON.stringify(available.map((item) => [item.id, item.instanceGeneration, item.version, item.providerRuntimeSupport]));
  const transferCurrent = transfer !== undefined && transfer.draft === draft && transfer.backendId === activeId
    && transfer.descriptorKey === descriptorKey && transfer.secrets === secrets && transfer.savedRevision === provider?.revision;
  useEffect(() => { if (transfer !== undefined && !transferCurrent) setTransfer(undefined); }, [transfer, transferCurrent]);
  const scope = useRef<{ readonly abort: AbortController; pending: boolean } | undefined>(undefined);
  const api = useMemo(() => ({ saveCredential, saveProvider }), [saveCredential, saveProvider]);
  const previousApi = useRef(api);
  useEffect(() => {
    const owner = { abort: new AbortController(), pending: false };
    scope.current = owner; setSaving(false);
    if (previousApi.current !== api && open) { setRetired(true); setSecrets({}); setTransfer(undefined); setSaveError(t("settings.customProvider.connectionChanged")); }
    previousApi.current = api;
    return () => { owner.abort.abort(); if (scope.current === owner) scope.current = undefined; };
  }, [api, open, provider?.id]);
  useEffect(() => {
    const next = initial(); setDraft(next); setActiveId(next.runtimes[0]?.backendId ?? available[0]?.id ?? "");
    setSecrets({}); setIdEdited(provider !== undefined); setRetired(false); setSaveError(undefined); setTransfer(undefined);
  }, [open, provider?.id]);
  const backend = available.find((item) => item.id === activeId);
  const runtime = draft.runtimes.find((item) => item.backendId === activeId);
  const updateRuntime: Dispatch<SetStateAction<ProviderRuntimeConfigurationView>> = (update) => setDraft((current) => ({ ...current,
    runtimes: current.runtimes.map((value) => value.backendId === activeId ? typeof update === "function" ? update(value) : update : value) }));
  const setSecret = (value: string): void => setSecrets((current) => ({ ...current, [activeId]: value }));
  const credentialsValid = (value: ProviderRuntimeConfigurationView): boolean => providerCredentialBindingsValid({ ...value,
    environmentName: value.environmentName.trim() || providerCredentialEnvironment(draft.id || "provider") }, !!secrets[value.backendId]?.trim());
  const runtimeValid = (value: ProviderRuntimeConfigurationView): boolean => {
    const owner = available.find((item) => item.id === value.backendId);
    const origin = providerEndpointOrigin(value.endpoint);
    return owner !== undefined && owner.providerRuntimeSupport!.protocols.includes(value.compatibility)
      && origin !== undefined && providerRequestPathValid(value.requestPath) && (!value.modelsEndpoint || providerEndpointOrigin(value.modelsEndpoint) === origin)
      && value.models.length > 0 && new Set(value.models.map((model) => model.modelId.trim())).size === value.models.length
      && value.models.every((model) => model.modelId.trim() && model.name.trim() && model.inputModalities.length > 0
        && model.inputModalities.every((modality) => modality === "text" || modality === "image")
        && (!supportsProviderField(owner, "modelLimits") || model.contextWindowTokens > 0 && model.maximumOutputTokens > 0))
      && (value.keyless || !!value.credentialId || !!secrets[value.backendId]?.trim() || value.headers.length > 0)
      && (!value.credentialId || value.environmentName.trim() !== "")
      && value.headers.every((header) => header.headerName.trim() && header.credentialId && header.environmentName.trim())
      && credentialsValid(value)
      && (!(value.credentialId || value.headers.length) || value.credentialOrigin === origin || !!secrets[value.backendId]?.trim() && value.headers.length === 0);
  };
  const valid = draft.id.trim() !== "" && draft.name.trim() !== "" && draft.runtimes.length > 0 && draft.runtimes.every(runtimeValid);
  const submit = async (): Promise<void> => {
    const owner = scope.current;
    if (!valid || retired || owner === undefined || owner.pending || owner.abort.signal.aborted) return;
    owner.pending = true; setSaving(true); setSaveError(undefined); setTransfer(undefined);
    const current = (): boolean => scope.current === owner && !owner.abort.signal.aborted;
    let prepared: ProviderDraft = { ...draft, id: draft.id.trim(), name: draft.name.trim() };
    let credentialSaved = false;
    try {
      for (const value of prepared.runtimes) {
        const secret = secrets[value.backendId]?.trim();
        if (value.keyless || !secret) continue;
        const credentialId = providerCredentialId(prepared.id);
        const environmentName = value.environmentName.trim() || providerCredentialEnvironment(prepared.id);
        await api.saveCredential({ id: credentialId, name: prepared.name + " API key", kind: "apiKey", providerId: "", secret }, owner.abort.signal);
        if (!current()) return;
        credentialSaved = true;
        prepared = { ...prepared, runtimes: prepared.runtimes.map((item) => item.backendId === value.backendId
          ? { ...item, credentialId, environmentName, credentialOrigin: providerEndpointOrigin(item.endpoint)! } : item) };
        setDraft(prepared); setSecrets((values) => ({ ...values, [value.backendId]: "" }));
      }
      if (!current()) return;
      await api.saveProvider(prepared, owner.abort.signal);
      if (current()) { setSecrets({}); onSaved(); }
    } catch { if (current()) setSaveError(t(credentialSaved ? "settings.customProvider.credentialSaved" : "settings.customProvider.saveFailed")); }
    finally { if (current()) { owner.pending = false; setSaving(false); } }
  };
  const unavailable = draft.runtimes.filter((value) => !available.some((item) => item.id === value.backendId));
  const credentialMismatch = runtime !== undefined && !!(runtime.credentialId || runtime.headers.length) && runtime.credentialOrigin !== providerEndpointOrigin(runtime.endpoint);
  return <>
    <Modal open={open} title={provider === undefined ? t("settings.customProvider.addTitle") : t("settings.editProvider", { name: provider.name })} size="large" className="provider-editor-modal" onClose={onClose}
      headerLeading={<ProviderFlowBackButton onBack={onBack ?? onClose} t={t} />}>
      <form className="settings-form provider-editor provider-editor--guided" aria-busy={saving} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {saveError && <ErrorBanner message={saveError} />}
        <fieldset className="provider-editor__fields" disabled={saving || retired}>
          <p>{t("settings.customProvider.description")}</p>
          <label className="field"><span>{t("settings.displayName")}</span><input required value={draft.name} onChange={(event) => { const name = event.target.value;
            setDraft((value) => ({ ...value, name, ...(provider === undefined && !idEdited ? { id: uniqueProviderId(name, providerIds) } : {}) })); }} placeholder={t("settings.customProvider.namePlaceholder")} /></label>
          <div className="provider-editor__segments" role="tablist" aria-label={t("settings.customProvider.runtime")} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || available.length === 0) return;
            event.preventDefault(); const position = Math.max(0, available.findIndex((item) => item.id === activeId));
            const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (position + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + available.length) % available.length;
            setActiveId(available[next]!.id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}>
            {available.map((item) => <button key={item.id} type="button" role="tab" tabIndex={activeId === item.id ? 0 : -1} aria-selected={activeId === item.id} className={cx(activeId === item.id && "is-active")} onClick={() => setActiveId(item.id)}>{item.name}</button>)}
          </div>
          {available.length === 0 && <p>{t("settings.customProvider.runtimeUnavailable")}</p>}
          {unavailable.map((value) => <div className="setting-row" key={value.backendId}><p>{t("settings.runtimeEditor.unavailable", { runtime: backends.find((item) => item.id === value.backendId)?.name ?? value.backendId })}</p>
            <Button onClick={() => setDraft((current) => ({ ...current, runtimes: current.runtimes.filter((item) => item.backendId !== value.backendId) }))}>{t("common.remove")}</Button></div>)}
          {backend !== undefined && runtime === undefined && <Button onClick={() => setDraft((current) => ({ ...current, runtimes: [...current.runtimes, emptyProviderRuntime(backend)] }))}>{t("settings.runtimeEditor.configure", { runtime: backend.name })}</Button>}
          {backend !== undefined && runtime !== undefined && <section role="tabpanel" aria-label={backend.name}>
            <div className="provider-editor__models-heading"><p>{t("settings.runtimeEditor.independent")}</p><Button disabled={available.length < 2} onClick={() => setTransfer({ draft, backendId: activeId, descriptorKey, secrets, savedRevision: provider?.revision })}>{t("settings.runtimeTransfer.open")}</Button>
              <Button onClick={() => { setDraft((current) => ({ ...current, runtimes: current.runtimes.filter((item) => item.backendId !== activeId) })); setSecret(""); }}>{t("settings.runtimeEditor.remove")}</Button></div>
            <label className="field"><span>{t("settings.customProvider.protocol")}</span><SelectControl value={runtime.compatibility} onChange={(event) => updateRuntime((value) => ({ ...value, compatibility: event.target.value as ProviderCompatibilityView,
              authHeader: supportsProviderField(backend, "authHeader") && event.target.value !== "anthropic" }))}>{providerCompatibilityOptions(backend)}</SelectControl></label>
            <label className="field"><span>{t("settings.customProvider.baseUrl")}</span><input required type="url" value={runtime.endpoint} onChange={(event) => updateRuntime((value) => ({ ...value, endpoint: event.target.value }))} placeholder="https://api.example.com/v1" /><small>{t("settings.endpointSafety")}</small></label>
            {supportsProviderField(backend, "requestPath") && <label className="field"><span>{t("settings.runtimeEditor.requestPath")}</span><input value={runtime.requestPath ?? ""} placeholder="/responses" onChange={(event) => updateRuntime((value) => ({ ...value, requestPath: event.target.value || undefined }))} /></label>}
            {supportsProviderField(backend, "modelsEndpoint") && <label className="field"><span>{t("settings.runtimeEditor.modelsEndpoint")}</span><input type="url" value={runtime.modelsEndpoint ?? ""} onChange={(event) => updateRuntime((value) => ({ ...value, modelsEndpoint: event.target.value || undefined }))} /><small>{t("settings.runtimeEditor.sameOrigin")}</small></label>}
            <div className="provider-editor__segments" role="group" aria-label={t("settings.customProvider.authentication")}>
              <button type="button" aria-pressed={!runtime.keyless} className={cx(!runtime.keyless && "is-active")} onClick={() => updateRuntime((value) => ({ ...value, keyless: false, authHeader: supportsProviderField(backend, "authHeader") && value.compatibility !== "anthropic" }))}>{t("settings.apiKey")}</button>
              {supportsProviderField(backend, "keyless") && <button type="button" aria-pressed={runtime.keyless} className={cx(runtime.keyless && "is-active")} onClick={() => { updateRuntime((value) => ({ ...value, keyless: true, authHeader: false, credentialId: "", environmentName: "", credentialOrigin: "", headers: [] })); setSecret(""); }}>{t("settings.customProvider.noAuthentication")}</button>}
            </div>
            {!runtime.keyless && <><label className="field"><span>{t("settings.customProvider.apiKeyValue")}</span><input type="password" autoComplete="new-password" value={secrets[activeId] ?? ""} onChange={(event) => setSecret(event.target.value)} placeholder={runtime.credentialId ? t("settings.customProvider.apiKeyKeep") : t("settings.customProvider.apiKeyPlaceholder")} /><small>{t("settings.customProvider.secretBody")}</small></label>
              <label className="field"><span>{t("settings.customProvider.savedCredential")}</span><SelectControl value={runtime.credentialId} onChange={(event) => { setSecret(""); updateRuntime((value) => ({ ...value, credentialId: event.target.value,
                environmentName: value.environmentName.trim() || (event.target.value ? providerCredentialEnvironment(draft.id || "provider") : ""),
                credentialOrigin: value.headers.length ? value.credentialOrigin : event.target.value ? providerEndpointOrigin(value.endpoint) ?? "" : "" })); }}>
                <option value="">{t("settings.customProvider.newCredential")}</option>{credentials.filter((item) => item.kind === "apiKey" || item.id === runtime.credentialId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                {runtime.credentialId && !credentials.some((item) => item.id === runtime.credentialId) && <option value={runtime.credentialId}>{t("settings.runtimeTransfer.credentialSet")}</option>}
              </SelectControl></label>
              <label className="field"><span>{t("settings.environmentName")}</span><input value={runtime.environmentName} onChange={(event) => updateRuntime((value) => ({ ...value, environmentName: event.target.value }))} placeholder={providerCredentialEnvironment(draft.id || "provider")} /></label>
              {supportsProviderField(backend, "authHeader") && <label className="setting-row"><span>{t("settings.authorizationHeader")}</span><SwitchControl checked={runtime.authHeader} onChange={(event) => updateRuntime((value) => ({ ...value, authHeader: event.target.checked }))} /></label>}
            </>}
            {credentialMismatch && <div className="provider-editor__credential-authority"><p role="alert">{t("settings.runtimeEditor.originChanged")}</p><Button disabled={providerEndpointOrigin(runtime.endpoint) === undefined} onClick={() => updateRuntime((value) => ({ ...value, credentialOrigin: providerEndpointOrigin(value.endpoint)! }))}>{t("settings.runtimeEditor.authorizeOrigin")}</Button>
              <Button onClick={() => updateRuntime((value) => ({ ...value, credentialId: "", environmentName: "", credentialOrigin: "", headers: [] }))}>{t("settings.runtimeEditor.clearCredentials")}</Button></div>}
            {!credentialsValid(runtime) && <p role="alert">{t("settings.runtimeEditor.credentialConflict")}</p>}
            {supportsProviderField(backend, "headers") && <ProviderHeaderFields runtime={runtime} credentials={credentials} setRuntime={updateRuntime} t={t} />}
            <ProviderRuntimeModels draft={runtime} setDraft={updateRuntime} backend={backend} t={t} />
          </section>}
          <details className="provider-editor__advanced"><summary>{t("settings.customProvider.advancedProvider")}</summary>
            <label className="field"><span>{t("settings.providerId")}</span><input required disabled={provider !== undefined} value={draft.id} onChange={(event) => { setIdEdited(true); setDraft((current) => ({ ...current, id: event.target.value })); }} /></label>
            <label className="setting-row"><span>{t("common.enabled")}</span><SwitchControl checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /></label>
          </details>
        </fieldset>
        <ProviderFlowFooter className="provider-editor__actions"><Button type="submit" tone="primary" disabled={!valid || retired} aria-disabled={saving || undefined}>{saving ? t("settings.customProvider.saving") : t("common.save")}</Button></ProviderFlowFooter>
      </form>
    </Modal>
    {open && transferCurrent && backend !== undefined && runtime !== undefined && !retired && <ProviderRuntimeTransferDialog source={runtime} sourceBackend={backend} sourceHasSecret={!!secrets[activeId]?.trim()}
      targets={available.filter((item) => item.id !== activeId).map((item) => ({ backend: item, draft: draft.runtimes.find((value) => value.backendId === item.id) ?? emptyProviderRuntime(item), hasSecret: !!secrets[item.id]?.trim() }))}
      t={t} onClose={() => setTransfer(undefined)} onApply={(changes) => {
        setDraft((current) => ({ ...current, runtimes: [...current.runtimes.filter((value) => !changes.some((change) => change.runtime.backendId === value.backendId)), ...changes.map((change) => change.runtime)] }));
        setSecrets((current) => { const next = { ...current }; for (const change of changes) {
          next[change.runtime.backendId] = change.authenticationSelected ? current[activeId] ?? "" : providerEndpointOrigin(change.runtime.endpoint) === providerEndpointOrigin(draft.runtimes.find((value) => value.backendId === change.runtime.backendId)?.endpoint ?? "") ? current[change.runtime.backendId] ?? "" : "";
        } return next; });
        setTransfer(undefined);
      }} />}
  </>;
}

function ProviderHeaderFields({ runtime, setRuntime, credentials, t }: { readonly runtime: ProviderRuntimeConfigurationView;
  readonly setRuntime: Dispatch<SetStateAction<ProviderRuntimeConfigurationView>>; readonly credentials: AppSnapshot["settings"]["credentials"]; readonly t: Translator }): JSX.Element {
  return <fieldset className="provider-editor__section"><legend>{t("settings.headerBindings")}</legend>
    {runtime.headers.map((header, index) => <div className="provider-binding-row" key={index}>
      <label className="field"><span>{t("settings.headerName")}</span><input value={header.headerName} onChange={(event) => setRuntime((value) => ({ ...value, headers: value.headers.map((item, position) => position === index ? { ...item, headerName: event.target.value } : item) }))} /></label>
      <label className="field"><span>{t("settings.credentialReference")}</span><SelectControl value={header.credentialId} onChange={(event) => setRuntime((value) => ({ ...value, credentialOrigin: value.credentialId || value.headers.some((item, position) => position !== index && (item.credentialId || item.environmentName)) ? value.credentialOrigin : providerEndpointOrigin(value.endpoint) ?? "", headers: value.headers.map((item, position) => position === index ? { ...item, credentialId: event.target.value } : item) }))}>
        <option value="">{t("common.none")}</option>{credentials.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</SelectControl></label>
      <label className="field"><span>{t("settings.environmentName")}</span><input value={header.environmentName} onChange={(event) => setRuntime((value) => ({ ...value, headers: value.headers.map((item, position) => position === index ? { ...item, environmentName: event.target.value } : item) }))} /></label>
      <IconButton label={t("common.remove")} onClick={() => setRuntime((value) => ({ ...value, headers: value.headers.filter((_, position) => position !== index) }))}><Trash2 aria-hidden="true" /></IconButton>
    </div>)}
    <Button onClick={() => setRuntime((value) => ({ ...value, keyless: false, headers: [...value.headers, { headerName: "", credentialId: "", environmentName: "" }] }))}><CirclePlus aria-hidden="true" />{t("settings.addHeader")}</Button>
  </fieldset>;
}

function ProviderRuntimeModels({ draft, setDraft, backend, t }: { readonly draft: ProviderRuntimeConfigurationView;
  readonly setDraft: Dispatch<SetStateAction<ProviderRuntimeConfigurationView>>; readonly backend: BackendView; readonly t: Translator }): JSX.Element {
  const updateModel = (index: number, patch: Partial<ProviderModelConfigurationView>): void => setDraft((current) => ({ ...current, models: current.models.map((model, position) => position === index ? { ...model, ...patch } : model) }));
  return <>      <section className="provider-editor__models"><div className="provider-editor__models-heading"><span><strong>{t("settings.modelsRequired")}</strong><small>{t("settings.customProvider.modelsBody")}</small></span><Button onClick={() => setDraft((current) => ({ ...current, models: [...current.models, emptyProviderModel(backend)] }))}><CirclePlus aria-hidden="true" />{t("settings.addModel")}</Button></div><div className="provider-editor__model-list">{draft.models.map((model, index) => <article className="provider-model-card" key={`model:${index}`}><div className="provider-model-card__heading"><span className="provider-catalog-icon" aria-hidden="true">{modelMonogram(model.name || model.modelId || "M")}</span><span><strong>{model.name || model.modelId || t("settings.newModel")}</strong><small>{model.modelId || t("settings.customProvider.modelRequired")}</small></span>{draft.models.length > 1 && <IconButton className="danger-text" label={t("settings.removeModel")} onClick={() => setDraft((current) => ({ ...current, models: current.models.filter((_, position) => position !== index) }))}><Trash2 aria-hidden="true" /></IconButton>}</div><div className="settings-form__grid"><label className="field"><span>{t("settings.modelId")}</span><input required value={model.modelId} onChange={(event) => updateModel(index, { modelId: event.target.value })} placeholder="model-id" /></label><label className="field"><span>{t("settings.displayName")}</span><input required value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} /></label>{supportsProviderField(backend, "modelLimits") && <label className="field"><span>{t("settings.contextWindow")}</span><input required min={1} type="number" value={model.contextWindowTokens} onChange={(event) => updateModel(index, { contextWindowTokens: numericInput(event.target.value) })} /></label>}{supportsProviderField(backend, "modelLimits") && <label className="field"><span>{t("settings.maximumOutput")}</span><input required min={1} type="number" value={model.maximumOutputTokens} onChange={(event) => updateModel(index, { maximumOutputTokens: numericInput(event.target.value) })} /></label>}</div><details className="provider-model-card__advanced"><summary>{t("settings.customProvider.advancedModelOptions")}</summary>{supportsProviderField(backend, "modelCompatibility") && <label className="field"><span>{t("settings.apiOverride")}</span><SelectControl value={model.compatibility ?? ""} onChange={(event) => updateModel(index, { compatibility: event.target.value === "" ? undefined : event.target.value as ProviderCompatibilityView })}><option value="">{t("settings.inheritProvider")}</option>{providerCompatibilityOptions(backend)}</SelectControl></label>}{supportsProviderField(backend, "modelInputModalities") && <fieldset className="provider-modalities"><legend>{t("settings.inputModalities")}</legend>{(["text", "image"] as const).map((modality) => <label key={modality}><CheckboxControl checked={model.inputModalities.includes(modality)} onChange={(event) => updateModel(index, { inputModalities: toggleModality(model.inputModalities, modality, event.target.checked) })} />{modality}</label>)}</fieldset>}<div className="settings-form__toggles">{supportsProviderField(backend, "modelThinkingLevels") && <label><CheckboxControl checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />{t("settings.reasoning")}</label>}{supportsProviderField(backend, "modelFastMode") && <label><CheckboxControl checked={model.supportsFastMode} onChange={(event) => updateModel(index, { supportsFastMode: event.target.checked })} />{t("settings.fastSupported")}</label>}</div>{supportsProviderField(backend, "modelThinkingLevels") && <label className="field"><span>{t("settings.effortMappings")}</span><input value={model.thinkingLevels.map((level) => level.nativeLevel === undefined ? level.effortId : `${level.effortId}:${level.nativeLevel}`).join(", ")} onChange={(event) => updateModel(index, { thinkingLevels: thinkingLevels(event.target.value) })} placeholder="low:low, medium:medium, high:high" /><small>{t("settings.runtimeEditor.effortMappingHelp")}</small></label>}{supportsProviderField(backend, "modelCosts") && <div className="provider-cost-grid">{(["inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "cacheReadCostMicrosPerMillion", "cacheWriteCostMicrosPerMillion"] as const).map((field) => <label className="field" key={field}><span>{t(`settings.${field}`)}</span><input type="number" min={0} value={model[field]} onChange={(event) => updateModel(index, { [field]: numericInput(event.target.value) })} /></label>)}</div>}</details></article>)}</div></section>
    {(supportsProviderField(backend, "modelSampling") || supportsProviderField(backend, "modelCompatibility")) && <AdvancedProviderModels models={draft.models} backend={backend} t={t} onChange={updateModel} />}
  </>;
}
function modelMonogram(name: string): string { return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "·"; }
const PROVIDER_COMPATIBILITY_BOOLEAN_FIELDS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresReasoningContentOnAssistantMessages",
  "supportsStore",
  "supportsStrictMode",
  "supportsOpenaiGrammarTools",
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "supportsCacheControlOnTools",
  "supportsStrictTools"
] as const;

function AdvancedProviderModels({ models, backend, t, onChange }: { readonly models: readonly ProviderModelConfigurationView[]; readonly backend: BackendView; readonly t: Translator; readonly onChange: (index: number, patch: Partial<ProviderModelConfigurationView>) => void }): JSX.Element {
  return <fieldset className="provider-editor__section"><legend>{t("settings.advancedModel")}</legend>{models.map((model, index) => <details className="provider-model-advanced" key={`advanced:${model.modelId}:${index}`}><summary>{model.name || model.modelId || t("settings.newModel")}</summary>{supportsProviderField(backend, "modelSampling") && <fieldset><legend>{t("settings.sampling")}</legend><div className="provider-cost-grid">{(["temperature", "topP", "topK", "minP", "repetitionPenalty", "frequencyPenalty", "presencePenalty", "seed"] as const).map((field) => <label className="field" key={field}><span>{t(`settings.sampling.${field}`)}</span><input type="number" step={field === "topK" || field === "seed" ? 1 : "any"} value={model.sampling?.[field] ?? ""} onChange={(event) => onChange(index, { sampling: { ...(model.sampling ?? {}), [field]: optionalNumber(event.target.value) } })} /></label>)}</div></fieldset>}{supportsProviderField(backend, "modelCompatibility") && <fieldset><legend>{t("settings.compatibilityFlags")}</legend><div className="provider-compatibility-grid">{PROVIDER_COMPATIBILITY_BOOLEAN_FIELDS.map((field) => <label className="field" key={field}><span>{t(`settings.compatibility.${field}`)}</span><SelectControl value={optionalBooleanValue(model.compatibilityOptions?.[field])} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), [field]: parseOptionalBoolean(event.target.value) } })}><option value="">{t("settings.unspecified")}</option><option value="true">{t("common.on")}</option><option value="false">{t("common.off")}</option></SelectControl></label>)}</div><div className="settings-form__grid"><label className="field"><span>{t("settings.thinkingFormat")}</span><input value={model.compatibilityOptions?.thinkingFormat ?? ""} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), thinkingFormat: event.target.value || undefined } })} /></label><label className="field"><span>{t("settings.cacheControlFormat")}</span><input value={model.compatibilityOptions?.cacheControlFormat ?? ""} onChange={(event) => onChange(index, { compatibilityOptions: { ...(model.compatibilityOptions ?? {}), cacheControlFormat: event.target.value || undefined } })} /></label></div></fieldset>}</details>)}</fieldset>;
}

function optionalNumber(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBooleanValue(value: boolean | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseOptionalBoolean(value: string): boolean | undefined {
  return value === "" ? undefined : value === "true";
}


function uniqueProviderId(name: string, providerIds: readonly string[]): string {
  const normalized = name.normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[-._]+$/gu, "")
    .slice(0, 96);
  const base = normalized || "custom-provider";
  const occupied = new Set(providerIds);
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 120 - String(suffix).length)}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${base.slice(0, 111)}-${Date.now().toString(36)}`;
}

function providerCredentialId(providerId: string): string {
  return `credential-${providerId.slice(0, 80)}-${randomUuid()}`;
}

function providerCredentialEnvironment(providerId: string): string {
  const suffix = providerId.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "PROVIDER";
  return `JOKO_PROVIDER_${suffix.slice(0, 96)}_API_KEY`;
}

function providerCompatibilityOptions(backend: BackendView): readonly JSX.Element[] {
 return backend.providerRuntimeSupport?.protocols.map((protocol) => <option key={protocol} value={protocol}>{providerCompatibilityLabel(protocol)}</option>) ?? [];
}

function numericInput(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function toggleModality(current: readonly ModelInputModalityView[], modality: ModelInputModalityView, checked: boolean): readonly ModelInputModalityView[] {
  return checked ? [...new Set([...current, modality])] : current.filter((candidate) => candidate !== modality);
}

function thinkingLevels(value: string): ProviderModelConfigurationView["thinkingLevels"] {
  return value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [effortId = "", nativeLevel] = part.split(":", 2).map((value) => value.trim());
    return { effortId, ...(nativeLevel ? { nativeLevel } : {}) };
  });
}
