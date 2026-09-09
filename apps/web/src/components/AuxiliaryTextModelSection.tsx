import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { RotateCcw, Search } from "lucide-react";

import type { AppController } from "../controller.js";
import type { AppSnapshot, AuxiliaryTextSettingsView, ModelRouteRefView } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, IconButton } from "./ui.js";
import "./AuxiliaryTextModelSection.css";

interface Props {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
}

interface Draft {
  readonly models: readonly ModelRouteRefView[];
  readonly custom: boolean;
  readonly baseRevision: bigint;
  readonly attempted: boolean;
  readonly awaiting?: boolean;
}

export function AuxiliaryTextModelSection(props: Props): JSX.Element {
  const [ownerDocument, setOwnerDocument] = useState<Document>();
  const attach = useCallback((node: HTMLElement | null) => { if (node !== null) setOwnerDocument(node.ownerDocument); }, []);
  const connectionOwner = useMemo(() => randomUuid(), [props.controller.getArtifactUrl]);
  const ownerKey = JSON.stringify([props.controller.state.activeProfile?.serverId, props.controller.state.activeProfile?.id, connectionOwner]);
  return <section ref={attach} className="personalization-section">
    {ownerDocument !== undefined && <AuxiliaryTextModelControls key={ownerKey} {...props} ownerDocument={ownerDocument} />}
  </section>;
}

function AuxiliaryTextModelControls({ controller, snapshot, t, ownerDocument }: Props & { readonly ownerDocument: Document }): JSX.Element {
  const headingId = useId();
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  const incoming = snapshot.settings.auxiliaryText;
  const settingsRef = useRef<AuxiliaryTextSettingsView | undefined>(undefined);
  const settingsGenerationRef = useRef<bigint | undefined>(undefined);
  const loaded = connected && snapshot.revision > 0n;
  if (loaded && (settingsRef.current === undefined
    || snapshot.generation !== settingsGenerationRef.current
    || incoming.revision >= settingsRef.current.revision)) {
    settingsRef.current = incoming;
    settingsGenerationRef.current = snapshot.generation;
  }
  const settings = settingsRef.current ?? incoming;
  const generation = settingsGenerationRef.current;
  const scope = useMemo(() => ({ active: false }), [ownerDocument, generation]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const runtime = useMemo(() => ({}), [settings.runtimeRevision, connected]);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [draft, setDraft] = useState<Draft>();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef<object | undefined>(undefined);
  const modeRef = useRef<HTMLSelectElement>(null);
  const resetFocusRef = useRef<{ readonly scope: object; readonly baseRevision?: bigint; readonly origin: Element | null } | undefined>(undefined);
  const [error, setError] = useState<"load" | "save">();
  useLayoutEffect(() => {
    scope.active = true;
    setDraft(undefined);
    setQuery("");
    setPending(false);
    setError(undefined);
    return () => { scope.active = false; pendingRef.current = undefined; resetFocusRef.current = undefined; };
  }, [scope]);
  useEffect(() => {
    if (draft?.attempted && settings.revision > draft.baseRevision && sameRoutes(settings.models, draft.models)) {
      setDraft(undefined);
      setError(undefined);
    }
  }, [draft, settings.models, settings.revision]);
  useLayoutEffect(() => {
    if (pendingRef.current === undefined) return;
    pendingRef.current = undefined;
    const focusIntent = resetFocusRef.current;
    if (focusIntent?.baseRevision !== undefined && !(settings.revision > focusIntent.baseRevision && settings.models.length === 0)) resetFocusRef.current = undefined;
    setPending(false);
    if (draft?.attempted && !sameRoutes(settings.models, draft.models)) setError("save");
  }, [runtime]);

  const current = (): boolean => scope.active && scopeRef.current === scope;
  const loading = !controller.state.ready || controller.state.connectionState === "connecting" || controller.state.connectionState === "reconnecting"
    || (connected && !loaded && controller.state.error === undefined);
  const serviceAvailable = settings.runtimeRevision !== "";
  const custom = draft?.custom ?? settings.models.length > 0;
  const models = draft?.models ?? settings.models;
  const conflict = draft !== undefined && settings.revision > draft.baseRevision && !sameRoutes(settings.models, draft.models);
  const awaiting = draft?.awaiting === true && settings.revision <= draft.baseRevision;
  const blocked = pending || !loaded || !serviceAvailable || awaiting;
  useLayoutEffect(() => {
    const intent = resetFocusRef.current;
    if (intent === undefined || intent.scope !== scope || custom || blocked || settings.models.length !== 0
      || (intent.baseRevision !== undefined && settings.revision <= intent.baseRevision)) return;
    resetFocusRef.current = undefined;
    if (ownerDocument.activeElement === ownerDocument.body || ownerDocument.activeElement === intent.origin || ownerDocument.activeElement === modeRef.current) {
      modeRef.current?.focus({ preventScroll: true });
    }
  }, [blocked, custom, ownerDocument, scope, settings.models.length, settings.revision]);
  const options = [...settings.options];
  for (const route of [...models, ...settings.automaticModels]) {
    if (!options.some((option) => routeKey(option.route) === routeKey(route))) options.push({ route, available: false, unavailableReason: t("settings.auxiliaryText.routeUnavailable") });
  }
  const routeName = (route: ModelRouteRefView): string => {
    const model = snapshot.models.find((candidate) => routeKey(candidate) === routeKey(route));
    const name = model?.name;
    return `${name === undefined || name === route.modelId ? route.modelId : `${name} (${route.modelId})`} · ${route.providerId} · ${route.backendId}`;
  };
  const queryText = query.trim().toLocaleLowerCase();
  const matches = options.filter((option) => routeName(option.route).toLocaleLowerCase().includes(queryText));

  const persist = async (nextModels: readonly ModelRouteRefView[], nextCustom: boolean): Promise<void> => {
    if (!current() || pendingRef.current !== undefined || !loaded || !serviceAvailable || awaiting) return;
    const next: Draft = { models: [...nextModels], custom: nextCustom, baseRevision: settings.revision, attempted: true };
    resetFocusRef.current = nextCustom ? undefined : { scope, baseRevision: next.baseRevision, origin: ownerDocument.activeElement };
    const request = {};
    pendingRef.current = request;
    setDraft(next);
    setPending(true);
    setError(undefined);
    const active = (): boolean => current() && runtimeRef.current === runtime && pendingRef.current === request;
    try {
      await controller.updateAuxiliaryTextSettings(next.models, next.baseRevision);
      if (active()) setDraft((value) => value === next ? { ...next, awaiting: true } : value);
    } catch {
      if (active() && !(settingsRef.current !== undefined && settingsRef.current.revision > next.baseRevision && sameRoutes(settingsRef.current.models, next.models))) {
        resetFocusRef.current = undefined;
        setError("save");
      }
    } finally {
      if (active()) { pendingRef.current = undefined; setPending(false); }
    }
  };
  const reset = (): void => {
    if (blocked) return;
    if (settings.models.length === 0) { resetFocusRef.current = { scope, origin: ownerDocument.activeElement }; setDraft(undefined); setError(undefined); }
    else void persist([], false);
  };
  const select = (index: number, key: string): void => {
    if (blocked || index > models.length) return;
    if (index === 0 && key === "") { reset(); return; }
    const route = options.find((option) => routeKey(option.route) === key && option.available)?.route;
    if (key !== "" && (route === undefined || models.some((candidate, slot) => slot !== index && routeKey(candidate) === key))) return;
    const next = [...models];
    if (route === undefined) next.splice(index, 1);
    else next.splice(index, 1, route);
    if (conflict) setDraft({ ...draft!, models: next, custom: true, awaiting: false });
    else void persist(next, true);
  };
  const refresh = async (): Promise<void> => {
    if (!current() || pendingRef.current !== undefined) return;
    const request = {};
    pendingRef.current = request;
    setPending(true);
    setError(undefined);
    try { await controller.refresh(); }
    catch { if (current() && runtimeRef.current === runtime && pendingRef.current === request) setError("load"); }
    finally { if (current() && runtimeRef.current === runtime && pendingRef.current === request) { pendingRef.current = undefined; setPending(false); } }
  };

  return <>
    <div className="personalization-section__heading"><h2 id={headingId}>{t("settings.auxiliaryText.title")}</h2><p>{t("settings.auxiliaryText.description")}</p></div>
    <div className="personalization-card auxiliary-text-model-card" role="group" aria-labelledby={headingId} aria-busy={pending || loading}>
      <div className="setting-row">
        <div><strong>{t("settings.auxiliaryText.mode")}</strong><span>{t(settings.models.length === 0 ? "settings.auxiliaryText.automatic" : "settings.auxiliaryText.custom")}</span></div>
        <div className="personalization-card__title-actions">
          <select ref={modeRef} className="select-control" aria-label={t("settings.auxiliaryText.mode")} value={custom ? "custom" : "automatic"} disabled={blocked} onChange={(event) => {
            if (event.target.value === "automatic") reset();
            else if (!custom) {
              resetFocusRef.current = undefined;
              setDraft({ custom: true, models: settings.automaticModels.filter((route) => settings.options.some((option) => option.available && routeKey(option.route) === routeKey(route))), baseRevision: settings.revision, attempted: false });
            }
          }}>
            <option value="automatic">{t("settings.auxiliaryText.automatic")}</option>
            <option value="custom">{t("settings.auxiliaryText.custom")}</option>
          </select>
          {custom && <IconButton label={t("settings.defaults.restore")} disabled={blocked} onClick={reset}><RotateCcw aria-hidden="true" /></IconButton>}
        </div>
      </div>
      {loading ? <p role="status">{t("common.loading")}</p> : !loaded ? <div role="alert"><p>{t("settings.auxiliaryText.loadFailed")}</p><Button disabled={pending} onClick={() => { void refresh(); }}>{t("common.retry")}</Button></div> : <>
        {!custom && <div className="setting-row"><div><strong>{t("settings.auxiliaryText.automaticChain")}</strong><span>{settings.automaticModels.length === 0 ? t("settings.auxiliaryText.noModels") : settings.automaticModels.map(routeName).join(" → ")}</span></div></div>}
        {custom && <label className="provider-model-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.searchModels")} aria-label={t("settings.searchModels")} /></label>}
        {custom && matches.length === 0 && <p role="status">{t("settings.auxiliaryText.noMatches")}</p>}
        {custom && (["primary", "fallbackOne", "fallbackTwo"] as const).map((slot, index) => {
          const selected = models[index];
          const option = selected === undefined ? undefined : options.find((candidate) => routeKey(candidate.route) === routeKey(selected));
          return <div className="setting-row" key={slot}>
            <div><strong>{t(`settings.auxiliaryText.${slot}`)}</strong>{option?.available === false && <span role="status">{option.unavailableReason || t("settings.auxiliaryText.routeUnavailable")}</span>}</div>
            <select className="select-control" aria-label={t(`settings.auxiliaryText.${slot}`)} disabled={blocked || index > models.length} value={selected === undefined ? "" : routeKey(selected)} onChange={(event) => select(index, event.target.value)}>
              <option value="">{t(index === 0 ? "settings.auxiliaryText.choosePrimary" : "common.none")}</option>
              {options.filter((candidate) => matches.includes(candidate) || (selected !== undefined && routeKey(candidate.route) === routeKey(selected))).map((candidate) => <option key={routeKey(candidate.route)} value={routeKey(candidate.route)} disabled={!candidate.available || models.some((route, existingIndex) => existingIndex !== index && routeKey(route) === routeKey(candidate.route))}>{routeName(candidate.route)}{candidate.available ? "" : ` — ${t("settings.auxiliaryText.routeUnavailable")}`}</option>)}
            </select>
          </div>;
        })}
        {!settings.available && <p role="status">{settings.unavailableReason || t("settings.auxiliaryText.noModels")}</p>}
        {draft !== undefined && !pending && !awaiting && !conflict && <div className="setting-row"><span>{t("settings.auxiliaryText.unsaved")}</span><Button disabled={blocked || (custom && models.length === 0)} onClick={() => { void persist(models, custom); }}>{t(error === "save" ? "common.retry" : "common.save")}</Button></div>}
        {conflict && <div role="alert"><p>{t("settings.auxiliaryText.conflict")}</p><div className="personalization-card__title-actions"><Button disabled={pending} onClick={() => { setDraft(undefined); setError(undefined); }}>{t("settings.auxiliaryText.reload")}</Button><Button disabled={blocked || (custom && models.length === 0)} onClick={() => { void persist(models, custom); }}>{t("settings.auxiliaryText.retryLatest")}</Button></div></div>}
        {awaiting && <div role="status"><p>{t("settings.auxiliaryText.confirming")}</p><Button disabled={pending} onClick={() => { void refresh(); }}>{t("common.refresh")}</Button></div>}
      </>}
      {pending && <p role="status">{t("common.working")}</p>}
      {error !== undefined && <p role="alert">{t(error === "load" ? "settings.auxiliaryText.loadFailed" : "settings.auxiliaryText.saveFailed")}</p>}
    </div>
  </>;
}

function routeKey(route: ModelRouteRefView): string { return JSON.stringify([route.backendId, route.providerId, route.modelId]); }
function sameRoutes(left: readonly ModelRouteRefView[], right: readonly ModelRouteRefView[]): boolean { return left.length === right.length && left.every((route, index) => routeKey(route) === routeKey(right[index]!)); }
