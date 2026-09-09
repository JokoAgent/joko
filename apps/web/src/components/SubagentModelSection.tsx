import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import type { AppController } from "../controller.js";
import type { AppSnapshot, SubagentModelSettingsView } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import { ModelPicker } from "./ModelPicker.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";
import "./subagent-model-settings.css";

interface Props {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
}
type Selection = SubagentModelSettingsView["model"];
interface Draft { readonly model: Selection; readonly revision: bigint; readonly awaiting?: boolean }

export function SubagentModelSection(props: Props): JSX.Element {
  const headingId = useId();
  const [ownerDocument, setOwnerDocument] = useState<Document>();
  const attach = useCallback((element: HTMLElement | null) => { if (element !== null) setOwnerDocument(element.ownerDocument); }, []);
  const connectionOwner = useMemo(() => randomUuid(), [props.controller.getArtifactUrl]);
  const owner = JSON.stringify([props.controller.state.activeProfile?.serverId, props.controller.state.activeProfile?.id, connectionOwner, props.snapshot.generation.toString()]);
  const connected = props.controller.state.ready && props.controller.state.connectionState === "connected";
  const loaded = connected && props.snapshot.revision > 0n;
  return <section ref={attach} className="personalization-section subagent-model-section" aria-labelledby={headingId}>
    <div className="personalization-section__heading"><h2 id={headingId}>{props.t("settings.subagentModels.title")}</h2><p>{props.t("settings.subagentModels.description")}</p></div>
    <div className="personalization-card subagent-model-card">
      {!loaded && <p role="status">{props.t(connected || !props.controller.state.ready ? "common.loading" : "settings.subagentModels.disconnected")}</p>}
      {loaded && props.snapshot.settings.subagentModels.length === 0 && <p role="status">{props.t("settings.subagentModels.unsupported")}</p>}
      {ownerDocument !== undefined && props.snapshot.settings.subagentModels.map((setting) => <SubagentModelControl key={`${owner}:${setting.backendId}`} {...props} setting={setting} ownerDocument={ownerDocument} loaded={loaded} />)}
    </div>
    <p>{props.t("settings.subagentModels.hint")}</p>
  </section>;
}

function SubagentModelControl({ controller, snapshot, setting: incoming, ownerDocument, loaded, t }: Props & {
  readonly setting: SubagentModelSettingsView;
  readonly ownerDocument: Document;
  readonly loaded: boolean;
}): JSX.Element {
  const settingsRef = useRef(incoming);
  if (loaded && incoming.revision >= settingsRef.current.revision) settingsRef.current = incoming;
  const setting = settingsRef.current;
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<object | undefined>(undefined);
  const resetFocusRef = useRef<{ readonly scope: object; readonly revision: bigint; readonly origin: Element | null } | undefined>(undefined);
  const scope = useMemo(() => ({ active: false }), [ownerDocument, loaded]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useLayoutEffect(() => {
    scope.active = true;
    flightRef.current = undefined;
    setPending(false);
    return () => { scope.active = false; flightRef.current = undefined; resetFocusRef.current = undefined; };
  }, [scope]);
  useLayoutEffect(() => {
    if (draft !== undefined && setting.revision > draft.revision && sameModel(setting.model, draft.model)) {
      setDraft(undefined);
      setError(false);
    }
  }, [draft, setting]);
  const selected = draft === undefined ? setting.model : draft.model;
  const conflict = draft !== undefined && setting.revision > draft.revision && !sameModel(setting.model, draft.model);
  const awaiting = draft?.awaiting === true && setting.revision <= draft.revision;
  const backend = snapshot.backends.find((value) => value.id === setting.backendId);
  const supports = backend?.capabilities.get("subagents.default_model")?.supported === true;
  const blocked = !loaded || pending || awaiting;
  useLayoutEffect(() => {
    const intent = resetFocusRef.current;
    if (intent === undefined || intent.scope !== scope || blocked || selected !== undefined || setting.model !== undefined
      || setting.revision <= intent.revision) return;
    resetFocusRef.current = undefined;
    if (ownerDocument.activeElement === ownerDocument.body || ownerDocument.activeElement === intent.origin) {
      rowRef.current?.querySelector<HTMLButtonElement>(".model-picker-trigger")?.focus({ preventScroll: true });
    }
  }, [blocked, ownerDocument, scope, selected, setting.model, setting.revision]);
  const persist = async (model: Selection): Promise<void> => {
    if (blocked || flightRef.current !== undefined || !scope.active || scopeRef.current !== scope) return;
    const request = {};
    flightRef.current = request;
    const next: Draft = { model, revision: setting.revision };
    resetFocusRef.current = model === undefined ? { scope, revision: next.revision, origin: ownerDocument.activeElement } : undefined;
    setDraft(next);
    setPending(true);
    setError(false);
    const current = (): boolean => scope.active && scopeRef.current === scope && flightRef.current === request;
    try {
      await controller.updateSubagentModelSettings(setting.backendId, model, next.revision);
      if (current()) setDraft((value) => value === next ? { ...next, awaiting: true } : value);
    } catch {
      if (current() && !(settingsRef.current.revision > next.revision && sameModel(settingsRef.current.model, model))) {
        resetFocusRef.current = undefined;
        setError(true);
      }
    } finally {
      if (current()) { flightRef.current = undefined; setPending(false); }
    }
  };
  const refresh = async (): Promise<void> => {
    if (pending || flightRef.current !== undefined || !scope.active) return;
    const request = {};
    flightRef.current = request;
    setPending(true);
    try { await controller.refresh(); }
    catch { if (scope.active && scopeRef.current === scope && flightRef.current === request) setError(true); }
    finally { if (scope.active && scopeRef.current === scope && flightRef.current === request) { flightRef.current = undefined; setPending(false); } }
  };
  return <div ref={rowRef} className="personalization-section" aria-busy={pending}>
    <div className="setting-row">
      <div><strong>{backend?.name ?? setting.backendId}</strong><span>{t("settings.subagentModels.default")}</span></div>
      <div className="subagent-model-actions">
        <ModelPicker models={snapshot.models.filter((model) => model.backendId === setting.backendId)}
        ownerId={controller.state.activeProfile?.id} value={selected === undefined ? undefined : { backendId: setting.backendId, ...selected, fastMode: false }}
        t={t} allowDefault defaultLabel={t("settings.subagentModels.unspecified")} ariaLabel={`${backend?.name ?? setting.backendId} ${t("settings.subagentModels.default")}`}
        disabled={blocked || !supports} effortEnabled={false} fastEnabled={false}
        onSelect={(value) => {
          const model = value === undefined ? undefined : { providerId: value.providerId, modelId: value.modelId };
          if (!sameModel(model, selected)) void persist(model);
        }} />
        {(selected !== undefined || setting.model !== undefined || (!setting.available && setting.revision > 0n)) && <Button disabled={blocked} onClick={() => { void persist(undefined); }}>{t("settings.defaults.restore")}</Button>}
      </div>
    </div>
    {!setting.available && <p role="status">{setting.unavailableReason || t("settings.subagentModels.unavailable")}</p>}
    {setting.model !== undefined && !setting.available && <p>{setting.model.modelId} · {setting.model.providerId}</p>}
    {pending && <p role="status">{t("common.working")}</p>}
    {error && <p role="alert">{t("settings.subagentModels.saveFailed")}</p>}
    {conflict && <div role="alert"><p>{t("settings.subagentModels.conflict")}</p><Button disabled={pending} onClick={() => { setDraft(undefined); setError(false); }}>{t("settings.subagentModels.reload")}</Button><Button disabled={blocked} onClick={() => { void persist(selected); }}>{t("settings.subagentModels.retryLatest")}</Button></div>}
    {draft !== undefined && !conflict && !awaiting && !pending && <Button disabled={blocked} onClick={() => { void persist(selected); }}>{t("common.retry")}</Button>}
    {awaiting && <div role="status"><p>{t("settings.subagentModels.confirming")}</p><Button disabled={pending || !loaded} onClick={() => { void refresh(); }}>{t("common.refresh")}</Button></div>}
  </div>;
}

function sameModel(left: Selection, right: Selection): boolean { return left?.providerId === right?.providerId && left?.modelId === right?.modelId; }
