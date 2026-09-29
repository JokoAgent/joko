import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { Cpu, RefreshCw, RotateCcw } from "lucide-react";
import {
  DEDICATED_HARDWARE_AUTO_DIM_OPTIONS,
  DEDICATED_HARDWARE_COMMANDS,
  DEDICATED_HARDWARE_DIRECTIONS,
  DEDICATED_HARDWARE_ENCODER_INPUTS,
  DEDICATED_HARDWARE_ENCODER_MODES,
  DEDICATED_HARDWARE_KEYCAP_IDS,
  DEDICATED_HARDWARE_MODELS,
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  DEDICATED_HARDWARE_TASK_SOURCES,
  createUnavailableDedicatedHardwareSnapshot,
  dedicatedHardwareMergeDirection,
  dedicatedHardwareMergeForKey,
  dedicatedHardwareMergeNeighbor,
  parseDedicatedHardwareBinding,
  parseDedicatedHardwareModelState,
  parseDedicatedHardwarePreviewInput,
  parseDedicatedHardwareSettings,
  parseDedicatedHardwareSnapshot,
  replaceDedicatedHardwareModelSettings,
  resetDedicatedHardwareSettingsValue,
  setDedicatedHardwareMerge,
  setDedicatedHardwareModelState,
  toggleDedicatedHardwareTaskKey,
  type DedicatedHardwareBinding,
  type DedicatedHardwareBridge,
  type DedicatedHardwareCommand,
  type DedicatedHardwareLayout,
  type DedicatedHardwareModel,
  type DedicatedHardwareModelState,
  type DedicatedHardwarePhysicalKey,
  type DedicatedHardwarePreviewInput,
  type DedicatedHardwareSettings,
  type DedicatedHardwareSkillOption,
  type DedicatedHardwareSnapshot
} from "../dedicated-hardware.js";
import type { Translator } from "./types.js";
import type { AppController } from "../controller.js";
import { Button, ErrorBanner, Pill, cx } from "./ui.js";
import "./DedicatedHardwareSettings.css";

const MODEL_LABELS: Readonly<Record<DedicatedHardwareModel, string>> = {
  "codex-micro": "Codex Micro",
  "creator-micro-2": "Creator Micro 2"
};

const STATUS_LABELS: Readonly<Record<DedicatedHardwareModelState["status"], string>> = {
  connecting: "Connecting", connected: "Connected", "not-detected": "Not detected", disabled: "Off",
  error: "Needs attention", unavailable: "Unavailable"
};

interface PreviewState {
  readonly pressed: ReadonlySet<DedicatedHardwarePhysicalKey>;
  readonly stickX: number;
  readonly stickY: number;
  readonly stickPressed: boolean;
  readonly encoderAngle: number;
  readonly encoderPressed: boolean;
}

const EMPTY_PREVIEW: PreviewState = {
  pressed: new Set(), stickX: 0, stickY: 0, stickPressed: false, encoderAngle: 0, encoderPressed: false
};

export function DedicatedHardwareSettings({
  t,
  bridge,
  skills: providedSkills = [],
  skillCatalogAvailable: providedSkillCatalogAvailable = providedSkills.length > 0,
  listSkills,
  serverId,
  connected = false,
  pollIntervalMs = 2_000
}: {
  readonly t: Translator;
  readonly bridge?: DedicatedHardwareBridge;
  readonly skills?: readonly DedicatedHardwareSkillOption[];
  readonly skillCatalogAvailable?: boolean;
  readonly listSkills?: AppController["listSkills"];
  readonly serverId?: string;
  readonly connected?: boolean;
  readonly pollIntervalMs?: number;
}): JSX.Element {
  const headingId = useId();
  const [snapshot, setSnapshot] = useState(createUnavailableDedicatedHardwareSnapshot);
  const [selectedModel, setSelectedModel] = useState<DedicatedHardwareModel>("codex-micro");
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [preview, setPreview] = useState<Record<DedicatedHardwareModel, PreviewState>>({
    "codex-micro": EMPTY_PREVIEW, "creator-micro-2": EMPTY_PREVIEW
  });
  const [previewLeaseActive, setPreviewLeaseActive] = useState(false);
  const [previewLeaseRevision, setPreviewLeaseRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [probing, setProbing] = useState<DedicatedHardwareModel>();
  const [recoveringKeymap, setRecoveringKeymap] = useState(false);
  const [skillReload, setSkillReload] = useState(0);
  const [runtimeSkills, setRuntimeSkills] = useState<{
    readonly serverId?: string;
    readonly state: "loading" | "ready" | "error";
    readonly skills: readonly DedicatedHardwareSkillOption[];
  }>({ state: listSkills === undefined ? "ready" : "loading", skills: providedSkills });
  const snapshotRef = useRef(snapshot);
  const confirmedRef = useRef(snapshot);
  const pendingRef = useRef(new Map<DedicatedHardwareModel, number>());
  const sequenceRef = useRef(0);
  const refreshEpochRef = useRef(0);
  const previewLeaseActiveRef = useRef(false);
  const previewLeaseChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  snapshotRef.current = snapshot;
  const selected = snapshot.models[selectedModel];
  const previewLeaseEligible = bridge !== undefined && visible && selected.settings.enabled
    && selected.status === "connected" && selected.settingsError === null;
  const previewLeaseIdentity = previewLeaseEligible ? JSON.stringify({
    model: selectedModel,
    status: selected.status,
    reason: selected.reason,
    devicePresent: selected.devicePresent,
    transport: selected.transport,
    firmwareVersion: selected.firmwareVersion,
    inputPermission: selected.inputPermission,
    settings: selected.settings,
    revision: previewLeaseRevision
  }) : "unavailable";

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const invalidatePreviewLease = useCallback((): void => {
    if (mountedRef.current) setPreviewLeaseRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    if (listSkills === undefined) return;
    const request = new AbortController();
    setRuntimeSkills({ serverId, state: "loading", skills: [] });
    if (!connected || serverId === undefined) return () => request.abort();
    void listSkills({ signal: request.signal }).then((catalog) => {
      if (request.signal.aborted) return;
      setRuntimeSkills({
        serverId,
        state: "ready",
        skills: catalog.skills.filter((skill) => skill.enabled && ["installed", "loaded", "updateAvailable"].includes(skill.state))
          .map((skill) => ({ serverId, resourceId: skill.id, name: skill.name }))
      });
    }).catch(() => {
      if (!request.signal.aborted) setRuntimeSkills({ serverId, state: "error", skills: [] });
    });
    return () => request.abort();
  }, [connected, listSkills, serverId, skillReload]);
  const skills = listSkills === undefined
    ? providedSkills
    : runtimeSkills.serverId === serverId && runtimeSkills.state === "ready" && connected ? runtimeSkills.skills : [];
  const skillCatalogAvailable = listSkills === undefined
    ? providedSkillCatalogAvailable
    : runtimeSkills.serverId === serverId && runtimeSkills.state === "ready" && connected;
  const usableSkills = useMemo(() => skills.filter((skill) => parseDedicatedHardwareBinding({
    kind: "skill",
    serverId: skill.serverId,
    resourceId: skill.resourceId,
    name: skill.name
  }) !== undefined), [skills]);

  const acceptSnapshot = useCallback((next: DedicatedHardwareSnapshot): void => {
    setSnapshot((current) => {
      let shown = next;
      let confirmed = next;
      for (const model of DEDICATED_HARDWARE_MODELS) {
        if (!pendingRef.current.has(model)) continue;
        shown = setDedicatedHardwareModelState(shown, current.models[model]);
        confirmed = setDedicatedHardwareModelState(confirmed, confirmedRef.current.models[model]);
      }
      confirmedRef.current = confirmed;
      snapshotRef.current = shown;
      return shown;
    });
    setLoaded(true);
    setError(undefined);
  }, []);

  const acceptExternal = useCallback((raw: unknown): boolean => {
    const whole = parseDedicatedHardwareSnapshot(raw);
    if (whole !== undefined) { acceptSnapshot(whole); return true; }
    const modelState = parseDedicatedHardwareModelState(raw);
    if (modelState === undefined) return false;
    if (pendingRef.current.has(modelState.model)) return true;
    const next = setDedicatedHardwareModelState(confirmedRef.current, modelState);
    acceptSnapshot(next);
    return true;
  }, [acceptSnapshot]);

  const refresh = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    const epoch = refreshEpochRef.current;
    try {
      const raw = await bridge.getDedicatedHardwareState();
      if (epoch !== refreshEpochRef.current) return;
      if (!acceptExternal(raw)) setError(message(t, "settings.dedicatedHardware.invalidState", "The hardware service returned an invalid state."));
    } catch {
      if (epoch === refreshEpochRef.current) setError(message(t, "settings.dedicatedHardware.loadFailed", "Hardware status could not be loaded."));
    }
  }, [acceptExternal, bridge, t]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const changed = (): void => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    if (bridge === undefined || !visible) return undefined;
    void refresh();
    const interval = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(interval);
  }, [bridge, pollIntervalMs, refresh, visible]);

  useEffect(() => bridge?.onDedicatedHardwareStateChanged?.((raw) => {
    if (!acceptExternal(raw)) setError(message(t, "settings.dedicatedHardware.invalidState", "The hardware service returned an invalid state."));
  }), [acceptExternal, bridge, t]);

  useEffect(() => {
    previewLeaseActiveRef.current = false;
    setPreviewLeaseActive(false);
    setPreview((current) => ({ ...current, [selectedModel]: EMPTY_PREVIEW }));
    if (bridge === undefined || !previewLeaseEligible) return undefined;
    let current = true;
    const acquire = previewLeaseChainRef.current.catch(() => undefined).then(async () => {
      await bridge.setDedicatedHardwarePreview(selectedModel, true);
    });
    previewLeaseChainRef.current = acquire.catch(() => undefined);
    void acquire.then(() => {
      if (!current) return;
      previewLeaseActiveRef.current = true;
      setPreviewLeaseActive(true);
    }).catch(() => {
      if (current) setError(message(t, "settings.dedicatedHardware.previewFailed", "Live input preview is unavailable."));
    });
    return () => {
      current = false;
      previewLeaseActiveRef.current = false;
      setPreviewLeaseActive(false);
      previewLeaseChainRef.current = previewLeaseChainRef.current.catch(() => undefined).then(async () => {
        await bridge.setDedicatedHardwarePreview(selectedModel, false);
      }).catch(() => undefined);
    };
  }, [bridge, previewLeaseEligible, previewLeaseIdentity, selectedModel, t]);

  useEffect(() => bridge?.onDedicatedHardwarePreviewInput?.((raw) => {
    if (!visible || !previewLeaseActiveRef.current) return;
    const input = parseDedicatedHardwarePreviewInput(raw);
    if (input === undefined || input.model !== selectedModel) return;
    setPreview((current) => ({ ...current, [input.model]: reducePreview(current[input.model], input) }));
  }), [bridge, selectedModel, visible]);

  const saveSettings = useCallback((model: DedicatedHardwareModel, expected: DedicatedHardwareSettings, request: () => Promise<unknown>, success: string): void => {
    if (bridge === undefined) return;
    const parsed = parseDedicatedHardwareSettings(expected);
    if (parsed === undefined) { setError(message(t, "settings.dedicatedHardware.invalidDraft", "This hardware layout is not valid.")); return; }
    const token = ++sequenceRef.current;
    refreshEpochRef.current += 1;
    pendingRef.current.set(model, token);
    setError(undefined); setNotice(undefined);
    setSnapshot((current) => {
      const next = replaceDedicatedHardwareModelSettings(current, model, parsed);
      snapshotRef.current = next;
      return next;
    });
    void request().then((raw) => {
      if (pendingRef.current.get(model) !== token) return;
      let nextState: DedicatedHardwareModelState = { ...confirmedRef.current.models[model], settings: parsed };
      if (raw !== undefined) {
        const returnedSnapshot = parseDedicatedHardwareSnapshot(raw);
        const returnedState = parseDedicatedHardwareModelState(raw, model);
        const returnedSettings = parseDedicatedHardwareSettings(raw);
        if (returnedSnapshot !== undefined) nextState = returnedSnapshot.models[model];
        else if (returnedState !== undefined) nextState = returnedState;
        else if (returnedSettings !== undefined) nextState = { ...nextState, settings: returnedSettings };
        else throw new Error("Invalid hardware save response.");
      }
      pendingRef.current.delete(model);
      const next = setDedicatedHardwareModelState(confirmedRef.current, nextState);
      confirmedRef.current = next; snapshotRef.current = next; setSnapshot(next);
      setNotice(success);
    }).catch(() => {
      if (pendingRef.current.get(model) !== token) return;
      pendingRef.current.delete(model);
      const rollback = setDedicatedHardwareModelState(snapshotRef.current, confirmedRef.current.models[model]);
      snapshotRef.current = rollback; setSnapshot(rollback);
      setError(message(t, "settings.dedicatedHardware.saveFailed", "The change was not saved. Confirmed settings were restored."));
    }).finally(invalidatePreviewLease);
  }, [bridge, invalidatePreviewLease, t]);

  const changeSettings = (model: DedicatedHardwareModel, next: DedicatedHardwareSettings): void => {
    if (bridge === undefined) return;
    saveSettings(model, next, () => bridge.setDedicatedHardwareSettings(model, next),
      message(t, "settings.dedicatedHardware.saved", "Hardware settings saved."));
  };

  const reset = (scope: "layout" | "all"): void => {
    if (bridge === undefined) return;
    const current = snapshot.models[selectedModel].settings;
    const expected = resetDedicatedHardwareSettingsValue(selectedModel, current, scope);
    saveSettings(selectedModel, expected, () => bridge.resetDedicatedHardwareSettings(selectedModel, scope),
      message(t, scope === "layout" ? "settings.dedicatedHardware.layoutReset" : "settings.dedicatedHardware.reset", scope === "layout" ? "Layout restored." : "Hardware settings restored."));
  };

  const probe = (): void => {
    if (bridge === undefined || probing !== undefined) return;
    const model = selectedModel;
    const token = ++sequenceRef.current;
    setProbing(model); setError(undefined);
    void bridge.probeDedicatedHardware(model).then((raw) => {
      if (sequenceRef.current !== token) return;
      if (raw === undefined) void refresh();
      else if (!acceptExternal(raw)) throw new Error("Invalid probe response.");
    }).catch(() => {
      if (sequenceRef.current === token) setError(message(t, "settings.dedicatedHardware.probeFailed", "The device probe failed."));
    }).finally(() => {
      setProbing((current) => current === model ? undefined : current);
      invalidatePreviewLease();
    });
  };

  const recoverKeymap = (): void => {
    if (bridge === undefined || selectedModel !== "creator-micro-2" || recoveringKeymap) return;
    setRecoveringKeymap(true);
    setError(undefined);
    setNotice(undefined);
    void bridge.recoverDedicatedHardwareKeymap("creator-micro-2").then((raw) => {
      if (!acceptExternal(raw)) throw new Error("Invalid keymap recovery response.");
      setNotice(message(t, "settings.dedicatedHardware.keymapRecovered", "Keymap recovery completed. The enabled Joko layout was reapplied when the device remained connected."));
    }).catch(() => {
      setError(message(t, "settings.dedicatedHardware.keymapRecoveryFailed", "The original device keymap could not be confirmed as restored. Recovery remains required."));
      void refresh();
    }).finally(() => setRecoveringKeymap(false));
  };

  const settings = selected.settings;
  const controlsDisabled = bridge === undefined || !loaded || selected.settingsError !== null;
  const webOnly = bridge === undefined;
  const updateLayout = (layout: DedicatedHardwareLayout): void => changeSettings(selectedModel, { ...settings, layout });

  return <section className="settings-card dedicated-hardware-settings" aria-labelledby={headingId} data-web-unavailable={webOnly ? "true" : undefined}
    data-dedicated-hardware-preview={previewLeaseActive ? "true" : undefined}>
    <header className="dedicated-hardware-settings__header">
      <div><h2 id={headingId}><Cpu aria-hidden="true" />{message(t, "settings.dedicatedHardware.title", "Dedicated hardware")}</h2>
        <p className="muted">{message(t, "settings.dedicatedHardware.body", "Configure task keys, commands, lighting, and live input for supported control boards.")}</p></div>
      <Button tone="ghost" disabled={bridge === undefined} onClick={() => { setSkillReload((current) => current + 1); void refresh(); }}><RefreshCw aria-hidden="true" />{message(t, "common.refresh", "Refresh")}</Button>
    </header>
    {webOnly && <div className="dedicated-hardware-settings__unavailable" role="status">{message(t, "settings.dedicatedHardware.desktopOnly", "Dedicated hardware is available in Joko Desktop.")}</div>}
    {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
    <div className="dedicated-hardware-settings__notice" role="status" aria-live="polite">{notice ?? ""}</div>

    <div className="dedicated-hardware-settings__models" role="list" aria-label={message(t, "settings.dedicatedHardware.models", "Supported devices")}>
      {DEDICATED_HARDWARE_MODELS.map((model) => {
        const state = snapshot.models[model];
        return <article key={model} role="listitem" className={cx("dedicated-hardware-model", selectedModel === model && "is-selected")}>
          <button type="button" className="dedicated-hardware-model__select" aria-pressed={selectedModel === model} onClick={() => setSelectedModel(model)}>
            <span><strong>{MODEL_LABELS[model]}</strong><small>{statusDetail(state, t)}</small></span>
            <Pill tone={state.status === "connected" ? "success" : state.status === "error" ? "danger" : state.status === "connecting" ? "warning" : "neutral"}>{statusLabel(state, t)}</Pill>
          </button>
          <label className="dedicated-hardware-toggle"><span>{message(t, "settings.dedicatedHardware.enable", "Enable")}</span>
            <input type="checkbox" disabled={bridge === undefined || !loaded || state.settingsError !== null} checked={state.settings.enabled} aria-label={`${message(t, "settings.dedicatedHardware.enable", "Enable")} ${MODEL_LABELS[model]}`}
              onChange={(event) => changeSettings(model, { ...state.settings, enabled: event.target.checked })} /></label>
        </article>;
      })}
    </div>

    <div className="dedicated-hardware-settings__detail" aria-label={MODEL_LABELS[selectedModel]}>
      <div className="dedicated-hardware-settings__detail-heading"><div><h3>{MODEL_LABELS[selectedModel]}</h3><p>{statusDetail(selected, t)}</p></div>
        <div><Button disabled={bridge === undefined || probing !== undefined} onClick={probe}>{probing === selectedModel ? message(t, "settings.dedicatedHardware.probing", "Probing…") : message(t, "settings.dedicatedHardware.probe", "Probe / retry")}</Button>
          {(selected.reason === "permission-required" || selected.inputPermission === "denied") && bridge?.openDedicatedHardwareInputSettings !== undefined
            && <Button tone="ghost" onClick={() => void bridge.openDedicatedHardwareInputSettings?.()
              .then((opened) => { if (!opened) setError(message(t, "settings.dedicatedHardware.permissionFailed", "Input permission settings could not be opened.")); })
              .catch(() => setError(message(t, "settings.dedicatedHardware.permissionFailed", "Input permission settings could not be opened.")))}>{message(t, "settings.dedicatedHardware.openPermission", "Open input permissions")}</Button>}</div>
      </div>
      <dl className="dedicated-hardware-metadata">
        <Metadata label={message(t, "settings.dedicatedHardware.transport", "Connection")} value={selected.transport ?? "—"} />
        <Metadata label={message(t, "settings.dedicatedHardware.firmware", "Firmware")} value={selected.firmwareVersion ?? "—"} />
        <Metadata label={message(t, "settings.dedicatedHardware.battery", "Battery")} value={selected.batteryPercent === null ? "—" : `${selected.batteryPercent}%${selected.charging ? ` · ${message(t, "settings.dedicatedHardware.charging", "charging")}` : ""}`} />
        <Metadata label={message(t, "settings.dedicatedHardware.inputPermission", "Input permission")} value={message(t, `settings.dedicatedHardware.permission.${selected.inputPermission}`, selected.inputPermission)} />
      </dl>
      {selected.settingsError !== null && <ErrorBanner message={message(t, `settings.dedicatedHardware.settingsStorage.${selected.settingsError}`,
        selected.settingsError === "invalid" ? "Saved hardware settings are invalid. Restore settings to rebuild them." : "Hardware settings storage is unavailable. Changes remain disabled until storage recovers.")} />}
      {selectedModel === "creator-micro-2" && selected.keymap?.phase === "error" && selected.keymap.backupAvailable &&
        <div className="dedicated-hardware-settings__recovery" role="alert">
          <div><strong>{message(t, "settings.dedicatedHardware.keymapRecoveryRequired", "Device keymap recovery required")}</strong>
            <p>{message(t, "settings.dedicatedHardware.keymapRecoveryHelp", "Joko retained the original keymap after a restore could not be confirmed. New temporary writes stay blocked until you explicitly recover it.")}</p></div>
          <Button disabled={bridge === undefined || recoveringKeymap} onClick={recoverKeymap}>
            {recoveringKeymap ? message(t, "settings.dedicatedHardware.keymapRecovering", "Recovering…") : message(t, "settings.dedicatedHardware.recoverKeymap", "Recover original keymap")}
          </Button>
        </div>}
      {bridge !== undefined && !skillCatalogAvailable && <div className="dedicated-hardware-settings__catalog-note" role="status">{message(t, "settings.dedicatedHardware.skillsUnavailable", "The skill catalog is not available in this settings view. Existing skill bindings remain visible, but new ones cannot be selected.")}</div>}

      <fieldset disabled={controlsDisabled} className="dedicated-hardware-fieldset">
        <legend>{message(t, "settings.dedicatedHardware.behavior", "Behavior and lighting")}</legend>
        <div className="dedicated-hardware-form-grid">
          <label><span>{message(t, "settings.dedicatedHardware.brightness", "Brightness")}</span><span className="dedicated-hardware-range"><input type="range" min="0" max="100" step="1" value={settings.lighting.brightnessPercent}
            aria-label={message(t, "settings.dedicatedHardware.brightness", "Brightness")} onChange={(event) => changeSettings(selectedModel, { ...settings, lighting: { ...settings.lighting, brightnessPercent: Number(event.target.value) } })} /><output>{settings.lighting.brightnessPercent}%</output></span></label>
          <LabeledSelect label={message(t, "settings.dedicatedHardware.autoDim", "Auto dim")} value={settings.lighting.autoDim}
            onChange={(value) => changeSettings(selectedModel, { ...settings, lighting: { ...settings.lighting, autoDim: value as DedicatedHardwareSettings["lighting"]["autoDim"] } })}
            options={DEDICATED_HARDWARE_AUTO_DIM_OPTIONS.map((value) => ({ value, label: message(t, `settings.dedicatedHardware.autoDim.${value}`, humanize(value)) }))} />
          <LabeledSelect label={message(t, "settings.dedicatedHardware.taskSource", "Task key source")} value={settings.taskSource}
            onChange={(value) => changeSettings(selectedModel, { ...settings, taskSource: value as DedicatedHardwareSettings["taskSource"] })}
            options={DEDICATED_HARDWARE_TASK_SOURCES.map((value) => ({ value, label: message(t, `settings.dedicatedHardware.taskSource.${value}`, humanize(value)) }))} />
          <label className="dedicated-hardware-check"><input type="checkbox" checked={settings.singleTapTaskKeys}
            onChange={(event) => changeSettings(selectedModel, { ...settings, singleTapTaskKeys: event.target.checked })} />
            <span className="dedicated-hardware-check__copy"><span>{message(t, "settings.dedicatedHardware.singleTap", "Focus Joko with one press")}</span>
              <small>{message(t, "settings.dedicatedHardware.singleTapHelp", "When off, the first press switches tasks in the background; press the same task again within 350 ms to focus Joko.")}</small></span></label>
        </div>
      </fieldset>

      {settings.taskSource === "custom" && <section className="dedicated-hardware-section" aria-labelledby={`${headingId}-slots`}><h4 id={`${headingId}-slots`}>{message(t, "settings.dedicatedHardware.taskSlots", "Custom task slots")}</h4>
        <div className="dedicated-hardware-bindings">{settings.customTaskSlots.map((binding, index) => <BindingEditor key={index} t={t} label={`${message(t, "settings.dedicatedHardware.taskSlot", "Task slot")} ${index + 1}`}
          binding={binding} skills={usableSkills} voiceAllowed onChange={(next) => { const slots: DedicatedHardwareBinding[] = [...settings.customTaskSlots]; slots[index] = next; changeSettings(selectedModel, { ...settings, customTaskSlots: slots as unknown as DedicatedHardwareSettings["customTaskSlots"] }); }} />)}</div>
      </section>}

      <section className="dedicated-hardware-section" aria-labelledby={`${headingId}-layout`}>
        <div className="dedicated-hardware-section__heading"><div><h4 id={`${headingId}-layout`}>{message(t, "settings.dedicatedHardware.layout", "Keyboard layout")}</h4><p>{message(t, "settings.dedicatedHardware.previewHelp", "Presses and motion are previewed here; preview input never runs an action.")}</p></div>
          <Button tone="ghost" disabled={bridge === undefined || !loaded} onClick={() => reset("layout")}><RotateCcw aria-hidden="true" />{message(t, "settings.dedicatedHardware.restoreLayout", "Restore layout")}</Button></div>
        <LayoutPreview layout={settings.layout} preview={preview[selectedModel]} t={t} skills={usableSkills} disabled={controlsDisabled} onChange={updateLayout} />
      </section>

      <section className="dedicated-hardware-section dedicated-hardware-inputs" aria-label={message(t, "settings.dedicatedHardware.analog", "Stick and encoder")}>
        <div><h4>{message(t, "settings.dedicatedHardware.stick", "Analog stick")}</h4><div className={cx("dedicated-hardware-stick", preview[selectedModel].stickPressed && "is-pressed")} aria-hidden="true"><span style={{ transform: `translate(${preview[selectedModel].stickX * 22}px, ${preview[selectedModel].stickY * 22}px)` }} /></div>
          {DEDICATED_HARDWARE_DIRECTIONS.map((direction) => <BindingEditor key={direction} t={t} label={`${message(t, "settings.dedicatedHardware.stick", "Analog stick")} · ${humanize(direction)}`} binding={settings.layout.stick[direction]} skills={usableSkills} disabled={controlsDisabled}
            onChange={(binding) => updateLayout({ ...settings.layout, stick: { ...settings.layout.stick, [direction]: binding } })} />)}</div>
        <div><h4>{message(t, "settings.dedicatedHardware.encoder", "Encoder")}</h4><div className={cx("dedicated-hardware-encoder", preview[selectedModel].encoderPressed && "is-pressed")} aria-hidden="true"><span style={{ transform: `rotate(${preview[selectedModel].encoderAngle}deg)` }} /></div>
          <LabeledSelect label={message(t, "settings.dedicatedHardware.encoderMode", "Encoder mode")} disabled={controlsDisabled} value={settings.layout.encoderMode}
            onChange={(value) => updateLayout({ ...settings.layout, encoderMode: value as DedicatedHardwareLayout["encoderMode"] })}
            options={DEDICATED_HARDWARE_ENCODER_MODES.map((value) => ({ value, label: message(t, `settings.dedicatedHardware.encoderMode.${value}`, humanize(value)) }))} />
          {settings.layout.encoderMode === "custom" && DEDICATED_HARDWARE_ENCODER_INPUTS.map((input) => <BindingEditor key={input} t={t} label={`${message(t, "settings.dedicatedHardware.encoder", "Encoder")} · ${humanize(input)}`} binding={settings.layout.encoder[input]} skills={usableSkills} disabled={controlsDisabled}
            onChange={(binding) => updateLayout({ ...settings.layout, encoder: { ...settings.layout.encoder, [input]: binding } })} />)}</div>
      </section>

      <div className="dedicated-hardware-settings__reset"><Button tone="danger" disabled={bridge === undefined || !loaded} onClick={() => reset("all")}>{message(t, "settings.dedicatedHardware.restoreAll", "Restore all hardware settings")}</Button>
        <small>{message(t, "settings.dedicatedHardware.resetKeepsEnabled", "Restore keeps the current enable setting.")}</small></div>
    </div>
  </section>;
}

function LayoutPreview({ layout, preview, t, skills, disabled, onChange }: {
  readonly layout: DedicatedHardwareLayout;
  readonly preview: PreviewState;
  readonly t: Translator;
  readonly skills: readonly DedicatedHardwareSkillOption[];
  readonly disabled: boolean;
  readonly onChange: (layout: DedicatedHardwareLayout) => void;
}): JSX.Element {
  return <div className="dedicated-hardware-layout" role="group" aria-label={message(t, "settings.dedicatedHardware.layout", "Keyboard layout")}>
    {DEDICATED_HARDWARE_PHYSICAL_KEYS.map((key) => {
      const merge = dedicatedHardwareMergeForKey(layout.merges, key);
      const isCover = merge?.cover === key;
      const mergeDirection = merge?.origin === key ? dedicatedHardwareMergeDirection(merge) ?? "none" : "none";
      const right = dedicatedHardwareMergeNeighbor(key, "right");
      const down = dedicatedHardwareMergeNeighbor(key, "down");
      const canRight = right !== undefined && (dedicatedHardwareMergeForKey(layout.merges, right) === undefined || right === merge?.cover);
      const canDown = down !== undefined && (dedicatedHardwareMergeForKey(layout.merges, down) === undefined || down === merge?.cover);
      return <article key={key} data-key={key} className={cx("dedicated-hardware-key", preview.pressed.has(key) && "is-pressed", isCover && "is-covered")} aria-label={key}>
        <div className="dedicated-hardware-key__cap"><strong>{layout.keys[key].keycapId}</strong><small>{key}</small></div>
        {isCover ? <p>{message(t, "settings.dedicatedHardware.mergedCover", "Covered by merged key")} {merge?.origin}</p> : <>
          <LabeledSelect label={`${key} ${message(t, "settings.dedicatedHardware.keycap", "keycap")}`} disabled={disabled} value={layout.keys[key].keycapId}
            onChange={(value) => onChange({ ...layout, keys: { ...layout.keys, [key]: { ...layout.keys[key], keycapId: value as DedicatedHardwareLayout["keys"][DedicatedHardwarePhysicalKey]["keycapId"] } } })}
            options={DEDICATED_HARDWARE_KEYCAP_IDS.map((value) => ({ value, label: value }))} compact />
          <BindingEditor t={t} label={`${key} ${message(t, "settings.dedicatedHardware.binding", "action")}`} binding={layout.keys[key].binding} skills={skills} voiceAllowed disabled={disabled}
            onChange={(binding) => onChange({ ...layout, keys: { ...layout.keys, [key]: { ...layout.keys[key], binding } } })} compact />
          <label className="dedicated-hardware-check"><input type="checkbox" disabled={disabled || merge !== undefined} checked={layout.taskKeys.includes(key)}
            onChange={(event) => onChange(toggleDedicatedHardwareTaskKey(layout, key, event.target.checked))} /><span>{message(t, "settings.dedicatedHardware.taskKey", "Task key")}</span></label>
          {(mergeDirection !== "none" || canRight || canDown) && <LabeledSelect label={`${key} ${message(t, "settings.dedicatedHardware.merge", "key size")}`} disabled={disabled} value={mergeDirection}
            onChange={(value) => onChange(setDedicatedHardwareMerge(layout, key, value as "none" | "right" | "down"))}
            options={[{ value: "none", label: message(t, "settings.dedicatedHardware.merge.none", "1U / separate") }, ...(canRight ? [{ value: "right", label: message(t, "settings.dedicatedHardware.merge.right", "Merge right") }] : []), ...(canDown ? [{ value: "down", label: message(t, "settings.dedicatedHardware.merge.down", "Merge down") }] : [])]} compact />}
        </>}
      </article>;
    })}
  </div>;
}

function BindingEditor({ t, label, binding, skills, onChange, voiceAllowed = false, disabled = false, compact = false }: {
  readonly t: Translator;
  readonly label: string;
  readonly binding: DedicatedHardwareBinding;
  readonly skills: readonly DedicatedHardwareSkillOption[];
  readonly onChange: (binding: DedicatedHardwareBinding) => void;
  readonly voiceAllowed?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}): JSX.Element {
  const selectedSkill = binding.kind === "skill" ? skills.findIndex((skill) => skill.serverId === binding.serverId && skill.resourceId === binding.resourceId) : -1;
  const value = binding.kind === "command" ? `command:${binding.command}` : binding.kind === "skill" ? selectedSkill >= 0 ? `skill:${selectedSkill}` : "stale-skill"
    : binding.kind === "fixed-link" ? `fixed-link:${binding.linkId}` : binding.kind;
  const options = [
    { value: "none", label: message(t, "settings.dedicatedHardware.action.none", "No action") },
    ...DEDICATED_HARDWARE_COMMANDS.map((action) => ({ value: `command:${action}`, label: message(t, `settings.dedicatedHardware.command.${action}`, humanize(action)) })),
    ...(voiceAllowed ? [{ value: "voice", label: message(t, "settings.dedicatedHardware.action.voice", "Voice") }] : []),
    ...skills.map((skill, index) => ({ value: `skill:${index}`, label: `${message(t, "settings.dedicatedHardware.action.skill", "Skill")} · ${skill.name}` })),
    { value: "fixed-link:product-feedback", label: message(t, "settings.dedicatedHardware.action.feedback", "Product feedback") },
    { value: "fixed-link:documentation", label: message(t, "settings.dedicatedHardware.action.documentation", "Documentation") },
    { value: "composer-text", label: message(t, "settings.dedicatedHardware.action.text", "Insert text") }
  ];
  if (binding.kind === "skill" && selectedSkill < 0) options.push({ value: "stale-skill", label: `${binding.name} · ${message(t, "settings.dedicatedHardware.action.unavailable", "unavailable")}` });
  return <div className={cx("dedicated-hardware-binding", compact && "is-compact")}>
    <LabeledSelect label={label} disabled={disabled} value={value} options={options} compact={compact} onChange={(next) => {
      if (next === "none") onChange({ kind: "none" });
      else if (next === "voice") onChange({ kind: "voice" });
      else if (next === "composer-text") onChange({ kind: "composer-text", text: ":joko:" });
      else if (next.startsWith("command:")) onChange({ kind: "command", command: next.slice(8) as DedicatedHardwareCommand });
      else if (next.startsWith("fixed-link:")) onChange({ kind: "fixed-link", linkId: next.slice(11) as "product-feedback" | "documentation" });
      else if (next.startsWith("skill:")) { const skill = skills[Number(next.slice(6))]; if (skill !== undefined) onChange({ kind: "skill", ...skill }); }
    }} />
    {binding.kind === "composer-text" && <ComposerTextBindingInput label={`${label} · ${message(t, "settings.dedicatedHardware.action.text", "Insert text")}`} disabled={disabled} value={binding.text}
      onCommit={(text) => onChange({ kind: "composer-text", text })} />}
  </div>;
}

function ComposerTextBindingInput({ label, value, disabled, onCommit }: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const parsed = parseDedicatedHardwareBinding({ kind: "composer-text", text: draft });
    if (parsed?.kind === "composer-text") onCommit(parsed.text);
    else setDraft(value);
  };
  return <label><span className="sr-only">{label}</span><input type="text" aria-label={label} disabled={disabled} maxLength={2_000} value={draft}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }} /></label>;
}

function LabeledSelect({ label, value, options, onChange, disabled = false, compact = false }: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}): JSX.Element {
  return <label className={cx("dedicated-hardware-select", compact && "is-compact")}><span>{label}</span><select aria-label={label} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

function Metadata({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function statusLabel(state: DedicatedHardwareModelState, t: Translator): string {
  return message(t, `settings.dedicatedHardware.status.${state.status}`, STATUS_LABELS[state.status]);
}

function statusDetail(state: DedicatedHardwareModelState, t: Translator): string {
  if (state.reason !== null) return message(t, `settings.dedicatedHardware.reason.${state.reason}`, humanize(state.reason));
  if (state.status === "connected" && state.transport !== null) return `${statusLabel(state, t)} · ${state.transport.toUpperCase()}`;
  return statusLabel(state, t);
}

function reducePreview(current: PreviewState, input: DedicatedHardwarePreviewInput): PreviewState {
  if (input.kind === "key") {
    const pressed = new Set(current.pressed);
    if (input.pressed) pressed.add(input.key); else pressed.delete(input.key);
    return { ...current, pressed };
  }
  if (input.kind === "stick") return { ...current, stickX: input.x, stickY: input.y, stickPressed: input.pressed };
  return { ...current, encoderAngle: current.encoderAngle + input.delta * 18, encoderPressed: input.pressed };
}

function humanize(value: string): string {
  return value.replaceAll(".", " ").replaceAll("-", " ").replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (character) => character.toUpperCase());
}

function message(t: Translator, key: string, fallback: string, values?: Readonly<Record<string, string | number>>): string {
  try {
    const translated = t(key as Parameters<Translator>[0], values);
    if (typeof translated === "string" && translated.length > 0 && translated !== key) return translated;
  } catch { /* Translation entries are added by the composition owner. */ }
  return Object.entries(values ?? {}).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), fallback);
}
