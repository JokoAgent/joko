import { useEffect, useId, useState, type JSX } from "react";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { MessageKey } from "../i18n.js";
import type { BackendView } from "../model.js";
import type { TaskModelGroupsApi } from "../provider-group-settings.js";
import { randomUuid } from "../web-crypto.js";
import { Button } from "./ui.js";

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const strategies = [
  [contract.TaskModelGroupStrategy.EXPIRING_QUOTA, "modelGroups.expiring"],
  [contract.TaskModelGroupStrategy.ORDERED, "settings.providerGroups.ordered"],
  [contract.TaskModelGroupStrategy.ROUND_ROBIN, "settings.providerGroups.roundRobin"],
  [contract.TaskModelGroupStrategy.LOWEST_COST, "modelGroups.cheapest"]
] as const;

export function TaskModelGroupSettings({ controller, t }: { readonly controller: AppController; readonly t: Translate }): JSX.Element | null {
  const profile = controller.state.activeProfile;
  const api = controller.providerGroups?.taskModels;
  if (!profile || !api) return null;
  return <TaskModelGroupEditor key={JSON.stringify([profile.id, profile.serverId, controller.state.connectionGeneration])}
    api={api} backends={controller.state.snapshot.backends} t={t} />;
}

function TaskModelGroupEditor({ api, backends, t }: { readonly api: TaskModelGroupsApi; readonly backends: readonly BackendView[]; readonly t: Translate }): JSX.Element {
  const heading = useId();
  const [version, reload] = useState(0);
  const [catalog, setCatalog] = useState<contract.ListTaskModelGroupsResponse>();
  const [draft, setDraft] = useState<readonly contract.TaskModelGroup[]>([]);
  const [groupId, setGroupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [scope, setScope] = useState<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    setScope(controller);
    setBusy(true);
    setFailed(false);
    setSaved(false);
    void api.list(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setCatalog(value);
      setDraft(value.config?.groups ?? []);
      setGroupId(previous => value.config?.groups.some(group => group.groupId === previous)
        ? previous : value.config?.groups[0]?.groupId ?? "");
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [api, version]);

  const group = draft.find(group => group.groupId === groupId);
  const sources = catalog?.sources ?? [];
  const otherGroups = draft.filter(other => other.groupId !== groupId);
  const labelSource = (source: contract.TaskModelGroupSource): string => {
    const backend = backends.find(backend => backend.id === source.source?.backendId);
    return [source.modelName, source.providerName, backend?.name ?? source.source?.backendId, source.computerName].filter(Boolean).join(" · ");
  };
  const change = (patch: Partial<contract.TaskModelGroup>) => {
    setSaved(false);
    setDraft(current => current.map(item => item.groupId === groupId ? { ...item, ...patch } : item));
  };
  const add = () => {
    const id = randomUuid();
    setDraft(current => [...current, create(contract.TaskModelGroupSchema, {
      groupId: id, strategy: contract.TaskModelGroupStrategy.EXPIRING_QUOTA, preferVisionWithImages: true
    })]);
    setGroupId(id);
    setSaved(false);
  };
  const remove = () => {
    setDraft(otherGroups.map(item => ({ ...item, schedules: item.schedules.filter(schedule => schedule.useGroupId !== groupId) })));
    setGroupId(otherGroups[0]?.groupId ?? "");
    setSaved(false);
  };
  const save = async () => {
    if (busy || scope === undefined || scope.signal.aborted || !catalog?.config) return;
    setBusy(true);
    setFailed(false);
    try {
      const config = await api.save(catalog.config.revision, draft, scope.signal);
      if (scope.signal.aborted) return;
      setCatalog({ ...catalog, config });
      setDraft(config.groups);
      setSaved(true);
    } catch {
      if (!scope.signal.aborted) setFailed(true);
    } finally {
      if (!scope.signal.aborted) setBusy(false);
    }
  };
  const moveCandidate = (from: number, to: number) => {
    if (!group || to < 0 || to >= group.candidates.length) return;
    const candidates = [...group.candidates];
    [candidates[from], candidates[to]] = [candidates[to]!, candidates[from]!];
    change({ candidates });
  };

  return <section className="provider-group-settings" aria-labelledby={heading}>
    <div className="settings-section-heading"><div className="settings-section-heading__copy"><h3 id={heading}>{t("modelGroups.title")}</h3></div>
      {catalog && <Button disabled={busy || draft.length >= 32} onClick={add}>{t("modelGroups.add")}</Button>}
    </div>
    {draft.length > 0 && <label className="setting-row"><strong>{t("modelGroups.title")}</strong><select value={groupId} disabled={busy} onChange={event => setGroupId(event.target.value)}>
      {draft.map(item => <option key={item.groupId} value={item.groupId}>{item.name || t("modelGroups.name")}</option>)}
    </select></label>}
    {group && <div className="settings-card">
      <label className="setting-row"><strong>{t("modelGroups.name")}</strong><input value={group.name} disabled={busy} maxLength={80}
        onChange={event => change({ name: event.target.value })} /></label>
      <label className="setting-row"><strong>{t("settings.providerGroups.strategy")}</strong><select value={group.strategy} disabled={busy}
        onChange={event => change({ strategy: Number(event.target.value) })}>
        {strategies.map(([strategy, label]) => <option key={strategy} value={strategy}>{t(label)}</option>)}
      </select></label>
      <label className="setting-row"><strong>{t("modelGroups.effort")}</strong><select value={group.effortId} disabled={busy}
        onChange={event => change({ effortId: event.target.value })}>
        <option value="">{t("settings.backendNativeDefault")}</option>
        {["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(effort => <option key={effort}>{effort}</option>)}
      </select></label>
      <label className="setting-row"><strong>{t("modelGroups.vision")}</strong><input type="checkbox" checked={group.preferVisionWithImages}
        disabled={busy} onChange={event => change({ preferVisionWithImages: event.target.checked })} /></label>
      <label className="setting-row"><strong>{t("modelGroups.source")}</strong><select value="" disabled={busy || group.candidates.length >= 16}
        onChange={event => {
          const source = sources.find(source => sourceKey(source.source) === event.target.value)?.source;
          if (source) change({ candidates: [...group.candidates, create(contract.TaskModelGroupCandidateSchema, { source })] });
        }}>
        <option value="">{t("modelGroups.source")}</option>
        {sources.filter(source => source.source && !group.candidates.some(candidate => sourceKey(source.source) === sourceKey(candidate.source)))
          .map(source => <option key={sourceKey(source.source)} value={sourceKey(source.source)} disabled={!source.available}>
            {labelSource(source)}
          </option>)}
      </select></label>
      {group.candidates.map((candidate, index) => {
        const key = sourceKey(candidate.source);
        const source = sources.find(source => sourceKey(source.source) === key);
        const label = source ? labelSource(source) : candidate.source?.modelId;
        return <div className="provider-group-settings__member" key={key}>
          <label className="provider-group-settings__choice"><input type="checkbox" checked={!candidate.disabled} disabled={busy}
            onChange={event => change({ candidates: group.candidates.map((item, position) => position !== index ? item : { ...item, disabled: !event.target.checked }) })} />
            <strong>{label}</strong>{!source?.available && <span className="muted">{t("settings.providerGroups.unavailable")}</span>}
          </label>
          <div className="provider-group-settings__reorder">
            <Button disabled={busy || index === 0} onClick={() => moveCandidate(index, index - 1)} aria-label={`${t("settings.providerGroups.moveUp")} ${label}`}>↑</Button>
            <Button disabled={busy || index === group.candidates.length - 1} onClick={() => moveCandidate(index, index + 1)} aria-label={`${t("settings.providerGroups.moveDown")} ${label}`}>↓</Button>
            <Button disabled={busy} onClick={() => change({ candidates: group.candidates.filter(item => item !== candidate) })}>{t("common.remove")}</Button>
          </div>
        </div>;
      })}
      {group.schedules.map((schedule, index) => {
        const patch = (values: Partial<contract.TaskModelGroupSchedule>) => change({
          schedules: group.schedules.map((other, position) => position === index ? { ...other, ...values } : other)
        });
        return <div className="provider-group-settings__fields" key={index}>
          <label>{t("modelGroups.startHour")}<input type="number" min="0" max="23" value={schedule.startHour} disabled={busy} onChange={event => patch({ startHour: Number(event.target.value) })} /></label>
          <label>{t("modelGroups.endHour")}<input type="number" min="0" max="23" value={schedule.endHour} disabled={busy} onChange={event => patch({ endHour: Number(event.target.value) })} /></label>
          <label>{t("modelGroups.window")}<select value={schedule.useGroupId} disabled={busy} onChange={event => patch({ useGroupId: event.target.value })}>
            {otherGroups.map(other => <option key={other.groupId} value={other.groupId}>{other.name}</option>)}
          </select></label>
          <Button disabled={busy} onClick={() => change({ schedules: group.schedules.filter(item => item !== schedule) })}>{t("common.remove")}</Button>
        </div>;
      })}
      <div className="provider-group-settings__actions">
        <Button disabled={busy || group.schedules.length >= 8 || !otherGroups.length} onClick={() => change({ schedules: [...group.schedules,
          create(contract.TaskModelGroupScheduleSchema, { startHour: 9, endHour: 17, useGroupId: otherGroups[0]!.groupId })
        ] })}>{t("modelGroups.window")}</Button>
        <Button disabled={busy} onClick={remove}>{t("settings.providerGroups.delete")}</Button>
      </div>
    </div>}
    {busy && <p role="status">{t("common.working")}</p>}
    {failed && <p role="alert">{t("modelGroups.error")}</p>}
    {saved && <p role="status">{t("settings.providerGroups.saved")}</p>}
    <div className="provider-group-settings__actions">
      <Button disabled={busy} onClick={() => reload(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button>
      <Button disabled={busy || catalog?.config === undefined || draft.some(item => !item.name.trim())}
        onClick={() => void save()}>{t("settings.providerGroups.save")}</Button>
    </div>
  </section>;
}

function sourceKey(source: contract.TaskModelGroupSourceRef | undefined): string {
  return source ? JSON.stringify([source.sourceKey, source.backendId, source.providerId, source.modelId]) : "";
}
