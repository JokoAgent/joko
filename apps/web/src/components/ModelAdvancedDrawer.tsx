import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Check, CircleHelp, Minus, SlidersHorizontal } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, ModelPriceOverrideView, ModelView, ModelWorkingContextTarget, ModelWorkingContextView, ProviderCompatibilityView, ProviderConfigurationView } from "../model.js";
import { isConversationModel } from "../model-capabilities.js";
import { clearModelEffort, isModelVisible, modelPreferenceKey, preferredModelEffort, readModelConfiguration, readModelPickerOwnerPreferences, setModelConfiguration, setModelVisible, useModelPickerOwnerPreferences } from "../model-picker-preferences.js";
import { providerCompatibilityLabel, supportsProviderField } from "../provider-runtime-draft.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl, Spinner, SwitchControl } from "./ui.js";
import { ManagedModelContextSettings } from "./ManagedModelRuntimeSettings.js";
import "./model-advanced-drawer.css";

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ModelAdvancedDrawer({ controller, snapshot, routes, configuration, ownerId, ownerKey, priceRevision, onClose, onEditPrice, onSetEnabled, t }: {
  readonly controller: AppController; readonly snapshot: AppSnapshot; readonly routes: readonly ModelView[];
  readonly configuration?: ProviderConfigurationView; readonly ownerId?: string; readonly ownerKey: string; readonly priceRevision: number;
  readonly onClose: () => void; readonly onEditPrice: (model: ModelView) => void;
  readonly onSetEnabled: (routes: readonly ModelView[], enabled: boolean) => Promise<void>; readonly t: Translator;
}): JSX.Element | null {
  const preferences = useModelPickerOwnerPreferences(ownerId);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [foreground, setForeground] = useState(() => document.visibilityState !== "hidden");
  const routeKey = JSON.stringify(routes.map(route => [route.backendId, route.providerId, route.modelId]));
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    pendingRef.current = false; setPending(false); setError(false); setDeleteConfirm(false);
    const retire = (): void => { lifetime.current?.abort(); setForeground(false); };
    const visible = (): void => { if (document.visibilityState === "hidden") retire(); else { lifetime.current = new AbortController(); pendingRef.current = false; setPending(false); setForeground(true); } };
    document.addEventListener("visibilitychange", visible); window.addEventListener("pagehide", retire);
    return () => { abort.abort(); lifetime.current?.abort(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", retire); };
  }, [ownerKey, routeKey]);
  const primary = routes.find(route => isConversationModel(route) && route.available) ?? routes[0];
  const chatRoutes = routes.filter(isConversationModel);
  const connected = controller.state.connectionState === "connected" && foreground;
  const enabled = routes.every(route => route.routingEnabled !== false);
  const runtime = snapshot.managedModelRuntimes?.find(item => item.providerRoutes?.some(route => routes.some(model => model.backendId === route.backendId && model.providerId === route.providerId)));
  const installed = runtime?.installedModels.find(model => model.name === primary?.modelId);
  const shownEfforts = [...new Set(chatRoutes.flatMap(route => [...route.efforts, ...(route.metadata?.displayEfforts ?? [])]))]
    .sort((a, b) => effortRank(a) - effortRank(b));
  const selectableEfforts = shownEfforts.filter(effort => chatRoutes.some(route => route.efforts.includes(effort)));
  const commonEfforts = selectableEfforts.filter(effort => chatRoutes.every(route => route.efforts.length === 0 || adaptedEffort(effort, route.efforts) === preferredModelEffort(preferences, route)));
  const preferred = primary === undefined ? undefined : preferredModelEffort(preferences, primary);
  const selectedEffort = commonEfforts.includes(preferred ?? "") ? preferred : commonEfforts[0];
  const effortCustomized = chatRoutes.some(route => readModelConfiguration(preferences, route.backendId, route.providerId, route.modelId)?.effort !== undefined);
  const visibilityCustomized = routes.some(route => Object.hasOwn(preferences.visibility, modelPreferenceKey(route.backendId, route.providerId, route.modelId)));
  const backendIds = [...new Set([...configuration?.runtimes.map(item => item.backendId) ?? [], ...routes.map(route => route.backendId)])];
  const targets = chatRoutes.map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId }));
  const target = useMemo((): ModelWorkingContextTarget | undefined => targets.length === 0 ? undefined : { ...targets[0]!, relatedTargets: targets.slice(1) }, [routeKey]);
  const act = async (operation: (signal: AbortSignal) => Promise<void>, close = false): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (pendingRef.current || !connected || signal === undefined || signal.aborted) return;
    pendingRef.current = true; setPending(true); setError(false);
    try { await operation(signal); if (!signal.aborted && close) onClose(); }
    catch { if (!signal.aborted) setError(true); }
    finally { if (!signal.aborted) { pendingRef.current = false; setPending(false); } }
  };
  if (primary === undefined) return null;
  const metadata = primary.metadata;
  const formatTokens = (value: number): string => new Intl.NumberFormat(controller.state.effectiveLocale === "zh-CN" ? "zh-CN" : "en").format(value);
  return <Modal open title={primary.name} size="large" showClose closeLabel={t("common.close")} onClose={onClose} className="model-advanced-drawer" initialFocus={() => { const title = heading.current?.closest(".modal")?.querySelector<HTMLElement>("h2"); if (title !== undefined && title !== null) title.tabIndex = 0; return title ?? null; }}>
    <div ref={heading} className="model-advanced-drawer__intro">{t("settings.modelAdvanced.factsHint")}</div>
    <div className="model-advanced-drawer__columns">
      <div>
        {chatRoutes.length > 0 && <>
          <Section title={t("settings.modelAdvanced.engines")} hint={t("settings.modelAdvanced.enginesHint")}>
            {!connected && <p role="status">{t("settings.modelAdvanced.connectionRequired")}</p>}
            {metadata?.referenceProtocol !== undefined && <Fact label={t("settings.modelAdvanced.referenceProtocol")}>{protocolLabel(metadata.referenceProtocol)}</Fact>}
            {backendIds.map(backendId => {
              const route = routes.find(item => item.backendId === backendId);
              const backend = snapshot.backends.find(item => item.id === backendId);
              const name = backend?.name ?? backendId;
              const storedRuntime = configuration?.runtimes.find(item => item.backendId === backendId);
              const storedModel = storedRuntime?.models.find(item => item.modelId === route?.modelId);
              const protocolEditable = route !== undefined && route.available && runtime === undefined && storedModel !== undefined && backend !== undefined && supportsProviderField(backend, "modelCompatibility");
              const protocol = route?.metadata?.outboundProtocol;
              return <div className="model-advanced-engine" key={backendId}>
                <div><strong>{name}</strong>{route === undefined ? <p>{t("settings.modelAdvanced.notConfigured")}</p> : <>
                  <p>{protocolEditable ? <SelectControl aria-label={`${name} · ${t("settings.apiOverride")}`} value={storedModel.compatibility ?? ""} disabled={pending || !connected} onChange={event => {
                    const next = event.target.value as ProviderCompatibilityView | "";
                    void act(signal => controller.saveProvider({ ...configuration!, runtimes: configuration!.runtimes.map(item => item.backendId !== backendId ? item : { ...item, models: item.models.map(model => model.modelId !== route.modelId ? model : { ...model, compatibility: next || undefined }) }) }, signal));
                  }}><option value="">{t("settings.inheritProvider")}</option>{backend.providerRuntimeSupport?.protocols.map(value => <option key={value} value={value}>{providerCompatibilityLabel(value)}</option>)}</SelectControl> : protocol === undefined ? t("settings.modelAdvanced.undeclared") : protocolLabel(protocol)}</p>
                  <p>{t(route.metadata?.protocolMode === "matching" ? "settings.modelAdvanced.matching" : route.metadata?.protocolMode === "compatibility" ? "settings.modelAdvanced.compatibility" : "settings.modelAdvanced.protocolUnknown")}</p>
                  {route.contextWindow !== primary.contextWindow && route.contextWindow > 0 && <small>{formatTokens(route.contextWindow)} {t("settings.modelAdvanced.tokens")}</small>}
                  {route.metadata?.fastMode === false && metadata?.fastMode === true && <small>{t("settings.modelAdvanced.noFast")}</small>}
                </>}</div>
                <SwitchControl aria-label={t("settings.modelAdvanced.showRoute", { name })} checked={route !== undefined && connected && route.available && isModelVisible(preferences, route.backendId, route.providerId, route.modelId, route.defaultVisible ?? true)} disabled={route === undefined || !route.available || !connected || ownerId === undefined || pending} onChange={event => { if (route !== undefined) setModelVisible(ownerId, route.backendId, route.providerId, route.modelId, event.target.checked, route.defaultVisible ?? true); }} />
              </div>;
            })}
            {visibilityCustomized && <Button tone="ghost" disabled={!connected || ownerId === undefined || pending} onClick={() => { for (const route of routes) setModelVisible(ownerId, route.backendId, route.providerId, route.modelId, route.defaultVisible ?? true, route.defaultVisible ?? true); }}>{t("settings.modelAdvanced.resetVisibility")}</Button>}
          </Section>
          {shownEfforts.length > 0 && <Section title={t("settings.modelAdvanced.effort")} hint={t("settings.modelAdvanced.effortHint")}>
            <div className="model-advanced-efforts">{shownEfforts.map(effort => <Button key={effort} aria-pressed={selectedEffort === effort} disabled={ownerId === undefined || !selectableEfforts.includes(effort) || pending} onClick={() => {
              for (const route of chatRoutes) if (route.efforts.length > 0) { const current = readModelConfiguration(readModelPickerOwnerPreferences(ownerId), route.backendId, route.providerId, route.modelId); setModelConfiguration(ownerId, route.backendId, route.providerId, route.modelId, { effort: adaptedEffort(effort, route.efforts), fast: current?.fast === true }); }
            }}>{effort}</Button>)}</div>
            {commonEfforts.length === 0 && selectableEfforts.length > 0 && <p role="status">{t("settings.modelAdvanced.effortMixed")}</p>}
            {effortCustomized && <Button tone="ghost" disabled={ownerId === undefined || pending} onClick={() => { for (const route of chatRoutes) clearModelEffort(ownerId, route); }}>{t("settings.modelAdvanced.resetEffort")}</Button>}
          </Section>}
          {target !== undefined && <Section title={t("settings.modelAdvanced.context")} hint={t("settings.modelAdvanced.contextHint")}>
            {runtime?.capabilities.supportsRepositoryModels && installed?.repositoryModel !== undefined ? <ManagedModelContextSettings controller={controller} runtime={runtime} modelId={installed.name} repositoryModel={installed.repositoryModel} disabled={!connected || pending || runtime.capabilities.canConfigure !== true} locale={controller.state.effectiveLocale} /> : <WorkingContextSettings controller={controller} target={target} routes={chatRoutes} ownerKey={ownerKey} disabled={!connected || pending} t={t} />}
          </Section>}
        </>}
          <Section title={t("settings.modelAdvanced.specifications")}>
            <Fact label={t("settings.contextWindow")}>{primary.contextWindow > 0 ? <>{formatTokens(primary.contextWindow)} {t("settings.modelAdvanced.tokens")} <small>{t(metadata?.contextWindowSource === "estimated" ? "settings.modelAdvanced.estimated" : metadata?.contextWindowSource === "declared" ? "settings.modelAdvanced.declared" : "settings.modelAdvanced.sourceUnknown")}</small></> : t("settings.modelAdvanced.undeclared")}</Fact>
            {primary.maximumOutputTokens > 0 && <Fact label={t("settings.maximumOutput")}>{formatTokens(primary.maximumOutputTokens)} {t("settings.modelAdvanced.tokens")} <small>{t(metadata?.maxOutputTokensSource === "estimated" ? "settings.modelAdvanced.estimated" : metadata?.maxOutputTokensSource === "declared" ? "settings.modelAdvanced.declared" : "settings.modelAdvanced.sourceUnknown")}</small></Fact>}
          </Section>
      </div>
      <div>
        <Section title={t("settings.modelAdvanced.capabilities")} hint={t("settings.modelAdvanced.capabilitiesHint")}>
          <Fact label={t("settings.modelAdvanced.imageInput")}><Capability value={metadata?.imageInput} t={t} /></Fact>
          <Fact label={t("settings.inputModalities")}>{metadata?.inputModalities?.length ? metadata.inputModalities.join(" · ") : t("settings.modelAdvanced.undeclared")}</Fact>
          <Fact label={t("settings.modelAdvanced.outputModalities")}>{metadata?.outputModalities?.length ? metadata.outputModalities.join(" · ") : t("settings.modelAdvanced.undeclared")}</Fact>
          <Fact label="Fast"><Capability value={metadata?.fastMode} t={t} /></Fact>
          <Fact label="Ultrafast"><Capability value={metadata?.ultrafastMode} t={t} /></Fact>
        </Section>
        <ModelPricing controller={controller} model={primary} ownerKey={ownerKey} refreshRevision={priceRevision} disabled={!connected || pending} onEdit={() => onEditPrice(primary)} t={t} />
        <Section title={t("settings.modelAdvanced.identity")}>
          {metadata?.description && <p>{metadata.description}</p>}
          <Fact label={t("settings.modelId")}><code>{primary.modelId}</code></Fact>
          {metadata?.brand && <Fact label={t("settings.modelAdvanced.brand")}>{metadata.brand}</Fact>}
          {metadata?.lifecycle && metadata.lifecycle !== "active" && <Fact label={t("settings.modelAdvanced.lifecycle")}>{metadata.lifecycle}</Fact>}
        </Section>
      </div>
    </div>
    <div className="model-advanced-drawer__actions">
      {error && <p className="danger-text" role="alert">{t("settings.modelAdvanced.actionFailed")}</p>}
      <Button disabled={pending || !connected} onClick={() => void act(() => onSetEnabled(routes, !enabled), true)}>{pending ? t("common.working") : t(enabled ? "settings.disableModel" : "settings.enableModel")}</Button>
      {runtime?.capabilities.canDeleteModels && !runtime.capabilities.supportsRepositoryModels && installed !== undefined && (deleteConfirm ? <div><span>{t("settings.modelAdvanced.deleteConfirm", { name: primary.name })}</span><Button disabled={pending || !connected} tone="danger" onClick={() => void act(async () => { await controller.deleteManagedModel(runtime.id, installed.name); }, true)}>{t("common.delete")}</Button><Button disabled={pending} onClick={() => setDeleteConfirm(false)}>{t("common.cancel")}</Button></div> : <Button tone="danger" disabled={pending || !connected} onClick={() => setDeleteConfirm(true)}>{t("settings.modelAdvanced.deleteLocal")}</Button>)}
    </div>
  </Modal>;
}

function WorkingContextSettings({ controller, target, routes, ownerKey, disabled, t }: { readonly controller: AppController; readonly target: ModelWorkingContextTarget; readonly routes: readonly ModelView[]; readonly ownerKey: string; readonly disabled: boolean; readonly t: Translator }): JSX.Element {
  const targetKey = JSON.stringify(target);
  const [context, setContext] = useState<ModelWorkingContextView>();
  const [draft, setDraft] = useState("");
  const dirty = useRef(false);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const observedTarget = useRef(`${ownerKey}:${targetKey}`);
  const display = (value: ModelWorkingContextView, preserveDraft = false): void => { setContext(value); if (preserveDraft && dirty.current) return; setDraft(value.limitTokens === undefined ? value.defaultContextWindowTokens === undefined ? "" : String(Math.max(1, Math.floor(value.defaultContextWindowTokens / 1_000))) : String(Math.max(1, Math.floor(value.limitTokens / 1_000)))); dirty.current = false; };
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    flight.current = false; setWriting(false); setLoading(true); setError(false);
    const nextTarget = `${ownerKey}:${targetKey}`;
    if (observedTarget.current !== nextTarget) { observedTarget.current = nextTarget; setContext(undefined); dirty.current = false; setDraft(""); }
    if (disabled) { setLoading(false); return () => abort.abort(); }
    void controller.getModelWorkingContext(target, abort.signal).then(value => { if (!abort.signal.aborted) { display(value, true); setLoading(false); } }, () => { if (!abort.signal.aborted) { setLoading(false); setError(true); } });
    const retire = (): void => abort.abort();
    document.addEventListener("visibilitychange", retire); window.addEventListener("pagehide", retire);
    return () => { abort.abort(); document.removeEventListener("visibilitychange", retire); window.removeEventListener("pagehide", retire); };
  }, [controller, ownerKey, targetKey, revision, disabled]);
  const windows = routes.map(route => route.contextWindow).filter(value => value > 0);
  const min = windows.length === 0 ? 1 : Math.max(1, Math.floor(Math.min(100_000, ...windows) / 1_000));
  const k = Number(draft); const tokens = k * 1_000;
  const valid = draft.trim() === "" || Number.isSafeInteger(k) && k >= min && Number.isSafeInteger(tokens) && tokens <= 100_000_000;
  const write = async (reset = false): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (flight.current || loading || context === undefined || !context.canConfigure || disabled || signal === undefined || signal.aborted || !reset && (!dirty.current || !valid)) return;
    flight.current = true; setWriting(true); setError(false);
    try { const next = reset ? await controller.resetModelWorkingContext(target, context, signal) : await controller.setModelWorkingContext(target, context, draft.trim() === "" ? undefined : tokens, signal); if (!signal.aborted) display(next); }
    catch {
      if (!signal.aborted) {
        setError(true);
        try { const committed = await controller.getModelWorkingContext(target, signal); if (!signal.aborted) display(committed); } catch { /* Keep the last observed committed value and the visible failure. */ }
      }
    } finally { if (!signal.aborted) { flight.current = false; setWriting(false); } }
  };
  const capacity = routes[0]?.contextWindow ?? 0;
  const shown = dirty.current ? tokens : context?.limitTokens ?? context?.effectiveContextWindowTokens;
  const exact = (value: number): string => new Intl.NumberFormat(controller.state.effectiveLocale === "zh-CN" ? "zh-CN" : "en").format(value);
  return <div className="model-working-context" aria-busy={loading || writing}>
    {loading && <Spinner label={t("settings.modelAdvanced.contextLoading")} />}
    {context !== undefined && <>
      <Fact label={t("settings.modelAdvanced.defaultContext")}>{context.defaultContextWindowTokens === undefined ? t("settings.modelAdvanced.undeclared") : exact(context.defaultContextWindowTokens)}</Fact>
      <Fact label={t("settings.modelAdvanced.effectiveContext")}>{context.effectiveContextWindowTokens === undefined ? t("settings.modelAdvanced.undeclared") : exact(context.effectiveContextWindowTokens)}</Fact>
      {context.mixed && <p role="status">{t("settings.modelAdvanced.contextMixed")}</p>}
      {!context.canConfigure && <p role="status">{t("settings.modelAdvanced.contextReadOnly")}</p>}
      <label className="field"><span>{t("settings.modelAdvanced.contextK")}</span><input inputMode="numeric" value={draft} min={min} max={100_000} aria-invalid={dirty.current && !valid} disabled={disabled || !context.canConfigure || loading || writing} onChange={event => { dirty.current = true; setDraft(event.target.value); }} onBlur={() => void write()} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void write(); } }} /></label>
      <div className="model-advanced-context-actions"><Button disabled={disabled || !context.canConfigure || loading || writing || !dirty.current || !valid} onClick={() => void write()}>{t("common.save")}</Button>{(context.customized || context.mixed) && <Button disabled={disabled || !context.canConfigure || loading || writing} onMouseDown={event => event.preventDefault()} onClick={() => void write(true)}>{t("settings.modelAdvanced.resetContext")}</Button>}</div>
      {dirty.current && !valid && <p className="danger-text" role="alert">{t("settings.modelAdvanced.contextInvalid", { min })}</p>}
      {shown !== undefined && capacity > 0 && shown > capacity && <p>{t("settings.modelAdvanced.overCapacity")}</p>}
      {context.nativeContext?.contextWindowTokens !== undefined && <Fact label={t("settings.modelAdvanced.nativeContext")}>{exact(context.nativeContext.contextWindowTokens)}</Fact>}
      {context.nativeContext?.autoCompactLimitTokens !== undefined && <Fact label={t("settings.modelAdvanced.compactContext")}>{exact(context.nativeContext.autoCompactLimitTokens)}</Fact>}
      {context.nativeContext?.pendingApply && <p role="status">{t("settings.modelAdvanced.pendingApply")}</p>}
    </>}
    {error && <p className="danger-text" role="alert">{t("settings.modelAdvanced.contextFailed")} <Button disabled={loading || writing || disabled} onClick={() => setRevision(value => value + 1)}>{t("common.retry")}</Button></p>}
  </div>;
}

function ModelPricing({ controller, model, ownerKey, refreshRevision, disabled, onEdit, t }: { readonly controller: AppController; readonly model: ModelView; readonly ownerKey: string; readonly refreshRevision: number; readonly disabled: boolean; readonly onEdit: () => void; readonly t: Translator }): JSX.Element {
  const [price, setPrice] = useState<ModelPriceOverrideView>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setPrice(undefined); setFailed(false);
    if (model.pricingKnown === true && model.pricingSource !== undefined && !disabled) void controller.getModelPriceOverride(model.backendId, model.providerId, model.modelId, abort.signal).then(value => { if (!abort.signal.aborted) setPrice(value); }, () => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [controller, ownerKey, model.backendId, model.providerId, model.modelId, disabled, revision, refreshRevision]);
  const quote = price?.effective;
  const fields = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const;
  const labels = ["settings.modelPrice.input", "settings.modelPrice.output", "settings.modelPrice.cacheRead", "settings.modelPrice.cacheWrite"] as const;
  const priced = quote !== undefined && (price?.referenceAvailable || price?.override !== undefined);
  return <Section title={t("settings.modelAdvanced.pricing")}>
    {model.providerAccessKind === "subscription" && !priced ? <p>{t("modelPicker.subscription")}</p> : priced ? fields.map((field, i) => quote[field] === undefined ? null : <Fact key={field} label={t(labels[i]!)}>{quote[field]} {quote.currency} / 1M {price?.override !== undefined && price.reference[field] !== quote[field] && <del>{price.reference[field]} {price.reference.currency}</del>}</Fact>) : model.pricingKnown === true && model.pricingSource !== undefined && model.inputCostMicrosPerMillion === 0 && model.outputCostMicrosPerMillion === 0 ? <p>{t("modelPicker.free")}</p> : <p>{t("settings.modelAdvanced.noPricing")}</p>}
    {failed && <p role="alert">{t("settings.modelPrice.loadFailed")} <Button disabled={disabled} onClick={() => setRevision(value => value + 1)}>{t("common.retry")}</Button></p>}
    <Button tone="ghost" disabled={disabled} onClick={onEdit}>{t("settings.modelPrice.menu")}</Button>
  </Section>;
}

function Section({ title, hint, children }: { readonly title: string; readonly hint?: string; readonly children: ReactNode }): JSX.Element { return <section className="model-advanced-section"><h3>{title}</h3>{hint && <p className="model-advanced-section__hint">{hint}</p>}{children}</section>; }
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element { return <div className="model-advanced-fact"><span>{label}</span><div>{children}</div></div>; }
function Capability({ value, t }: { readonly value?: boolean; readonly t: Translator }): JSX.Element { const Icon = value === true ? Check : value === false ? Minus : CircleHelp; return <span className="model-advanced-capability"><Icon aria-hidden="true" />{t(value === true ? "settings.modelAdvanced.supported" : value === false ? "settings.modelAdvanced.unsupported" : "settings.modelAdvanced.undeclared")}</span>; }
function effortRank(value: string): number { const rank = EFFORT_ORDER.indexOf(value); return rank < 0 ? EFFORT_ORDER.length : rank; }
function adaptedEffort(value: string, supported: readonly string[]): string | undefined { if (supported.includes(value)) return value; return [...supported].sort((a, b) => effortRank(b) - effortRank(a)).find(item => effortRank(item) <= effortRank(value)) ?? [...supported].sort((a, b) => effortRank(a) - effortRank(b))[0]; }
function protocolLabel(value: string): string { if (value === "anthropic-messages") return providerCompatibilityLabel("anthropic"); if (value === "openai-responses") return providerCompatibilityLabel("openaiResponses"); if (value === "openai-completions" || value === "openai-chat") return providerCompatibilityLabel("openaiChat"); if (value === "google-generative-ai") return providerCompatibilityLabel("google"); return value; }

export function ModelAdvancedButton({ name, onClick, t }: { readonly name: string; readonly onClick: () => void; readonly t: Translator }): JSX.Element { return <Button className="provider-model-advanced-button" tone="ghost" aria-label={t("settings.modelAdvanced.open", { name })} onClick={onClick}><SlidersHorizontal aria-hidden="true" /></Button>; }
