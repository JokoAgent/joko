import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppController } from "../controller.js";
import { composerVoiceShortcutsConflict } from "../composer-voice-shortcut-conflict.js";
import { setDesktopGlobalVoiceShortcut } from "../desktop-global-voice-shortcut.js";
import {
  APP_SHORTCUT_DEFINITION_LIST,
  appShortcutCombosEqual,
  createAppShortcutComboFromEvent,
  currentAppShortcutPlatform,
  effectiveAppShortcutCombos,
  isAppShortcutComboBindable,
  type AppShortcutCombo,
  type AppShortcutId
} from "../app-shortcuts.js";
import { isSystemReservedShortcut } from "../keyboard-reserved.js";
import {
  publishGlobalVoiceShortcutRegistration,
  readGlobalVoiceShortcutRegistration,
  subscribeGlobalVoiceShortcutRegistration
} from "../global-voice-shortcut-store.js";
import type {
  VoiceInputCapabilityView,
  VoiceInputConnectionTestFailureView,
  VoiceInputTranscriptionProtocolView
} from "../model.js";
import { supportsVoiceMediaCapture } from "../voice-input-media.js";
import {
  deleteVoiceInputHistoryEntry,
  readVoiceInputUsage,
  resetVoiceInputUsage,
  subscribeVoiceInputUsage
} from "../voice-input-history.js";
import {
  formatVoiceInputShortcut,
  MAXIMUM_VOICE_DICTIONARY_CSV_BYTES,
  MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS,
  MAXIMUM_VOICE_REFINEMENT_INSTRUCTIONS_CHARACTERS,
  VOICE_INPUT_LOCALES,
  createVoiceInputBareModifierShortcut,
  createVoiceInputShortcutFromMacNativeKeys,
  defaultVoiceInputShortcut,
  parseVoiceDictionaryCsv,
  readVoiceInputPreferences,
  isVoiceInputBareModifierCode,
  isVoiceInputMacNativeModifierCode,
  subscribeVoiceInputPreferences,
  voiceInputShortcutsEqual,
  writeVoiceInputPreferences,
  type VoiceInputShortcutCombo,
} from "../voice-input-preferences.js";
import {
  addManualVoiceDictionaryTerm,
  deleteVoiceDictionaryEntry,
  mergeManualVoiceDictionaryTerms,
  renameVoiceDictionaryEntry,
  voiceDictionaryTermKey,
  type VoiceInputDictionaryState
} from "../voice-input-dictionary.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, Pill, CheckboxControl, SelectControl, SwitchControl } from "./ui.js";

type CapabilityState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: VoiceInputCapabilityView }
  | { readonly kind: "error" };

type MicrophonePermissionState = "granted" | "denied" | "prompt" | "unknown";

const VOICE_INPUT_PROTOCOLS = [
  "openAiCompatibleBatch",
  "openAiCompatibleRealtime",
  "qwenCompatibleRealtime"
] as const satisfies readonly VoiceInputTranscriptionProtocolView[];

export function VoiceInputSettings({ controller, t }: {
  readonly controller: AppController;
  readonly t: Translator;
}): JSX.Element {
  const service = controller.state.snapshot.settings.voiceInput;
  const [preferences, setPreferences] = useState(readVoiceInputPreferences);
  const [capability, setCapability] = useState<CapabilityState>({ kind: "loading" });
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<MicrophonePermissionState>("unknown");
  const [deviceError, setDeviceError] = useState(false);
  const [serviceEnabled, setServiceEnabled] = useState(service.enabled);
  const [serviceProtocol, setServiceProtocol] = useState(service.protocol);
  const [serviceEndpoint, setServiceEndpoint] = useState(service.endpoint);
  const [serviceModel, setServiceModel] = useState(service.model);
  const [serviceKeyless, setServiceKeyless] = useState(service.keyless);
  const [serviceSecret, setServiceSecret] = useState("");
  const [clearServiceCredential, setClearServiceCredential] = useState(false);
  const [fallbackEnabled, setFallbackEnabled] = useState(service.fallbackEnabled);
  const [fallbackProtocol, setFallbackProtocol] = useState(service.fallbackProtocol);
  const [fallbackEndpoint, setFallbackEndpoint] = useState(service.fallbackEndpoint);
  const [fallbackModel, setFallbackModel] = useState(service.fallbackModel);
  const [fallbackKeyless, setFallbackKeyless] = useState(service.fallbackKeyless);
  const [fallbackSecret, setFallbackSecret] = useState("");
  const [clearFallbackCredential, setClearFallbackCredential] = useState(false);
  const [refinementEnabled, setRefinementEnabled] = useState(service.refinementEnabled);
  const [refinerProviderId, setRefinerProviderId] = useState(service.refinerProviderId);
  const [refinerModelId, setRefinerModelId] = useState(service.refinerModelId);
  const [refinerFallbackProviderId, setRefinerFallbackProviderId] = useState(service.refinerFallbackProviderId);
  const [refinerFallbackModelId, setRefinerFallbackModelId] = useState(service.refinerFallbackModelId);
  const [savingService, setSavingService] = useState(false);
  const [serviceSaveError, setServiceSaveError] = useState<string>();
  const [serviceSaved, setServiceSaved] = useState(false);
  const [connectionTest, setConnectionTest] = useState<"idle" | "testing" | "success" | VoiceInputConnectionTestFailureView>("idle");
  const connectionTestRequestRef = useRef(0);
  const [dictionaryDraft, setDictionaryDraft] = useState("");
  const [dictionarySearch, setDictionarySearch] = useState("");
  const [dictionaryFilter, setDictionaryFilter] = useState<"all" | "manual" | "automatic">("all");
  const [editingDictionaryEntryId, setEditingDictionaryEntryId] = useState<string>();
  const [editingDictionaryDraft, setEditingDictionaryDraft] = useState("");
  const [dictionaryMessage, setDictionaryMessage] = useState<{ readonly error: boolean; readonly text: string }>();
  const [usage, setUsage] = useState(readVoiceInputUsage);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string>();
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState<string>();
  const desktopMicrophone = typeof window === "undefined" ? undefined : window.jokoDesktop?.microphone;
  const desktopGlobalVoice = typeof window === "undefined" || window.jokoDesktop?.capabilities.includes("voice.globalDictation") !== true
    ? undefined
    : window.jokoDesktop.globalVoice;
  const globalShortcutRegistration = useSyncExternalStore(
    subscribeGlobalVoiceShortcutRegistration,
    readGlobalVoiceShortcutRegistration,
    readGlobalVoiceShortcutRegistration
  );
  const [globalAccessibility, setGlobalAccessibility] = useState<"granted" | "denied" | "not-required" | "unknown">("unknown");
  const [globalInputMonitoring, setGlobalInputMonitoring] = useState<"granted" | "denied" | "not-required" | "unknown">("unknown");

  useEffect(() => subscribeVoiceInputPreferences(setPreferences), []);
  useEffect(() => subscribeVoiceInputUsage(setUsage), []);
  useEffect(() => () => { connectionTestRequestRef.current += 1; }, []);

  const saveShortcutPreference = useCallback((shortcut: VoiceInputShortcutCombo | "disabled"): void => {
    setShortcutError(undefined);
    if (composerVoiceShortcutsConflict(
      controller.state.preferences.composerSendShortcut,
      shortcut,
      currentAppShortcutPlatform()
    )) {
      setShortcutError(t("settings.composerVoiceShortcutConflict"));
      return;
    }
    const persist = (): void => {
      writeVoiceInputPreferences({ shortcut });
    };
    if (desktopGlobalVoice === undefined) {
      persist();
      return;
    }
    void setDesktopGlobalVoiceShortcut(desktopGlobalVoice, shortcut).then((result) => {
      publishGlobalVoiceShortcutRegistration(result);
      if (result.accepted || result.reason === "permission") persist();
    }).catch(() => {
      publishGlobalVoiceShortcutRegistration({ accepted: false, reason: "unsupported" });
    });
  }, [controller.state.preferences.composerSendShortcut, desktopGlobalVoice, t]);

  useEffect(() => {
    if (desktopGlobalVoice === undefined) return;
    let disposed = false;
    const refresh = (): void => {
      void desktopGlobalVoice.getAccessibility().then((snapshot) => {
        if (!disposed) setGlobalAccessibility(snapshot.status);
      }).catch(() => {
        if (!disposed) setGlobalAccessibility("unknown");
      });
      void desktopGlobalVoice.getInputMonitoring().then((snapshot) => {
        if (!disposed) setGlobalInputMonitoring(snapshot.status);
      }).catch(() => {
        if (!disposed) setGlobalInputMonitoring("unknown");
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [desktopGlobalVoice]);

  useEffect(() => {
    if (!recordingShortcut) return;
    document.body.dataset.appShortcutRecording = "1";
    const platform = currentAppShortcutPlatform();
    let active = true;
    let shortcutBindingSuspended = window.jokoDesktop === undefined;
    const shortcutBindingSuspension = window.jokoDesktop?.applicationMenu.configure({ shortcutRecording: true })
      ?? Promise.resolve();
    let committed = false;
    let bareModifierCandidate: string | undefined;
    let nativeShortcutCandidate: VoiceInputShortcutCombo | undefined;
    let nativeShortcutCandidateSize = 0;
    let nativeShortcutInvalid = false;
    let nativeFnDown = false;
    const nativeCapture = platform === "darwin" ? desktopGlobalVoice : undefined;
    const useNativeCapture = nativeCapture !== undefined;
    const stop = (): void => setRecordingShortcut(false);
    const save = (combo: VoiceInputShortcutCombo, nativeShortcut = false): void => {
      if (committed) return;
      if (!nativeShortcut && (!isAppShortcutComboBindable(combo) || isSystemReservedShortcut(combo, platform))) {
        setShortcutError(t("settings.voiceInputShortcutInvalid"));
        stop();
        return;
      }
      if (!nativeShortcut) {
        const conflict = voiceShortcutConflict(combo, controller.state.preferences.appShortcutOverrides, platform);
        if (conflict !== null) {
          const definition = APP_SHORTCUT_DEFINITION_LIST.find((candidate) => candidate.id === conflict);
          setShortcutError(t("settings.voiceInputShortcutConflict", {
            name: definition === undefined ? conflict : t(definition.labelKey)
          }));
          stop();
          return;
        }
      }
      committed = true;
      saveShortcutPreference(combo);
      stop();
    };
    const keydown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!shortcutBindingSuspended) return;
      if (event.key === "Escape") {
        stop();
        return;
      }
      if (platform === "darwin" && isVoiceInputBareModifierCode(event.code)) {
        bareModifierCandidate = event.code;
        return;
      }
      if (nativeFnDown || bareModifierCandidate === "Fn") return;
      bareModifierCandidate = undefined;
      const combo = createAppShortcutComboFromEvent(event);
      if (combo === null) return;
      save({ ...combo, fn: false });
    };
    const keyup = (event: KeyboardEvent): void => {
      if (!shortcutBindingSuspended) return;
      if (platform !== "darwin" || event.code !== bareModifierCandidate) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.code === "Fn" && useNativeCapture) return;
      const shortcut = createVoiceInputBareModifierShortcut(event.code);
      if (shortcut !== undefined) save(shortcut, true);
    };
    const unsubscribeNativeCapture = nativeCapture !== undefined
      ? nativeCapture.onShortcutCaptureKeys((keys) => {
        if (!shortcutBindingSuspended || committed) return;
        nativeFnDown = keys.includes("Fn");
        if (keys.length === 0) {
          const shortcut = nativeShortcutCandidate;
          nativeShortcutCandidate = undefined;
          nativeShortcutCandidateSize = 0;
          nativeShortcutInvalid = false;
          if (shortcut !== undefined) save(shortcut, true);
          return;
        }
        if (nativeShortcutInvalid || keys.includes("Other")) {
          nativeShortcutCandidate = undefined;
          nativeShortcutCandidateSize = 0;
          nativeShortcutInvalid = true;
          return;
        }
        const shortcut = createVoiceInputShortcutFromMacNativeKeys(keys);
        if (shortcut === undefined) {
          if (keys.every(isVoiceInputMacNativeModifierCode)) return;
          nativeShortcutCandidate = undefined;
          nativeShortcutCandidateSize = 0;
          nativeShortcutInvalid = true;
          return;
        }
        if (keys.length >= nativeShortcutCandidateSize) {
          nativeShortcutCandidate = shortcut;
          nativeShortcutCandidateSize = keys.length;
        }
      })
      : undefined;
    void shortcutBindingSuspension.then(async () => {
      if (!active) return;
      shortcutBindingSuspended = true;
      if (unsubscribeNativeCapture === undefined) return;
      const started = await nativeCapture?.startShortcutCapture();
      if (active && !started) setShortcutError(t("settings.voiceInputShortcutCapturePermission"));
    }).catch(() => {
      if (active) {
        setShortcutError(t("settings.voiceInputShortcutCapturePermission"));
        stop();
      }
    });
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", stop);
    return () => {
      active = false;
      delete document.body.dataset.appShortcutRecording;
      void window.jokoDesktop?.applicationMenu.configure({ shortcutRecording: false }).catch(() => undefined);
      unsubscribeNativeCapture?.();
      if (unsubscribeNativeCapture !== undefined) void nativeCapture?.stopShortcutCapture().catch(() => undefined);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", stop);
    };
  }, [controller, desktopGlobalVoice, recordingShortcut, saveShortcutPreference, t]);

  useEffect(() => {
    const request = new AbortController();
    setCapability({ kind: "loading" });
    void controller.getVoiceInputCapabilities(request.signal).then((value) => {
      if (!request.signal.aborted) setCapability({ kind: "ready", value });
    }).catch(() => {
      if (!request.signal.aborted) setCapability({ kind: "error" });
    });
    return () => request.abort();
  }, [controller, service.revision]);

  useEffect(() => {
    setServiceEnabled(service.enabled);
    setServiceProtocol(service.protocol);
    setServiceEndpoint(service.endpoint);
    setServiceModel(service.model);
    setServiceKeyless(service.keyless);
    setServiceSecret("");
    setClearServiceCredential(false);
    setFallbackEnabled(service.fallbackEnabled);
    setFallbackProtocol(service.fallbackProtocol);
    setFallbackEndpoint(service.fallbackEndpoint);
    setFallbackModel(service.fallbackModel);
    setFallbackKeyless(service.fallbackKeyless);
    setFallbackSecret("");
    setClearFallbackCredential(false);
    setRefinementEnabled(service.refinementEnabled);
    setRefinerProviderId(service.refinerProviderId);
    setRefinerModelId(service.refinerModelId);
    setRefinerFallbackProviderId(service.refinerFallbackProviderId);
    setRefinerFallbackModelId(service.refinerFallbackModelId);
    setServiceSaveError(undefined);
    setConnectionTest("idle");
  }, [service.enabled, service.endpoint, service.fallbackEnabled, service.fallbackEndpoint, service.fallbackKeyless, service.fallbackModel, service.fallbackProtocol, service.keyless, service.model, service.protocol, service.refinementEnabled, service.refinerFallbackModelId, service.refinerFallbackProviderId, service.refinerModelId, service.refinerProviderId, service.revision]);

  useEffect(() => {
    const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (mediaDevices?.enumerateDevices === undefined) return;
    let disposed = false;
    const refresh = (): void => {
      void mediaDevices.enumerateDevices().then((items) => {
        if (disposed) return;
        setDevices(items.filter((item) => item.kind === "audioinput"));
        setDeviceError(false);
      }).catch(() => {
        if (!disposed) setDeviceError(true);
      });
    };
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      disposed = true;
      mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    if (desktopMicrophone !== undefined) {
      void desktopMicrophone.getPermission().then((snapshot) => {
        if (!disposed) setPermission(snapshot.status);
      }).catch(() => {
        if (!disposed) setPermission("unknown");
      });
      return () => { disposed = true; };
    }
    const permissions = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (permissions === undefined) return;
    let permissionStatus: PermissionStatus | undefined;
    const update = (): void => {
      if (permissionStatus !== undefined && !disposed) setPermission(permissionStatus.state);
    };
    void permissions.query({ name: "microphone" as PermissionName }).then((status) => {
      if (disposed) return;
      permissionStatus = status;
      update();
      status.addEventListener("change", update);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      permissionStatus?.removeEventListener("change", update);
    };
  }, [desktopMicrophone]);

  const support = capability.kind === "ready" ? capability.value.support : undefined;
  const clientCaptureSupported = typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
  const supported = support === "supported" && clientCaptureSupported && capability.kind === "ready"
    && supportsVoiceMediaCapture(capability.value, globalThis.MediaRecorder);
  const selectedDeviceExists = preferences.deviceId === undefined || devices.some((device) => device.deviceId === preferences.deviceId);
  const refinementModels = controller.state.snapshot.settings.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.models
      .filter((model) => supportsManagedTextInference(model.compatibility ?? provider.compatibility))
      .map((model) => ({
        key: refinementModelKey(provider.id, model.modelId),
        providerId: provider.id,
        modelId: model.modelId,
        label: `${provider.name} · ${model.name}`
      })));
  const selectedRefinementModel = refinerProviderId === "" || refinerModelId === ""
    ? ""
    : refinementModelKey(refinerProviderId, refinerModelId);
  const selectedRefinementFallbackModel = refinerFallbackProviderId === "" || refinerFallbackModelId === ""
    ? ""
    : refinementModelKey(refinerFallbackProviderId, refinerFallbackModelId);
  const refinementFallbackModels = refinementModels.filter((model) => model.key !== selectedRefinementModel);
  const serviceFormDirty = serviceEnabled !== service.enabled
    || serviceProtocol !== service.protocol
    || serviceEndpoint.trim() !== service.endpoint
    || serviceModel.trim() !== service.model
    || serviceKeyless !== service.keyless
    || serviceSecret.trim() !== ""
    || clearServiceCredential
    || fallbackEnabled !== service.fallbackEnabled
    || fallbackProtocol !== service.fallbackProtocol
    || fallbackEndpoint.trim() !== service.fallbackEndpoint
    || fallbackModel.trim() !== service.fallbackModel
    || fallbackKeyless !== service.fallbackKeyless
    || fallbackSecret.trim() !== ""
    || clearFallbackCredential
    || refinementEnabled !== service.refinementEnabled
    || refinerProviderId !== service.refinerProviderId
    || refinerModelId !== service.refinerModelId
    || refinerFallbackProviderId !== service.refinerFallbackProviderId
    || refinerFallbackModelId !== service.refinerFallbackModelId;
  const dictionaryCounts = preferences.dictionary.entries.reduce((counts, entry) => ({
    all: counts.all + 1,
    manual: counts.manual + (entry.source === "manual" ? 1 : 0),
    automatic: counts.automatic + (entry.source === "automatic" ? 1 : 0)
  }), { all: 0, manual: 0, automatic: 0 });
  const normalizedDictionarySearch = voiceDictionaryTermKey(dictionarySearch);
  const visibleDictionaryEntries = preferences.dictionary.entries.filter((entry) =>
    (dictionaryFilter === "all" || entry.source === dictionaryFilter)
    && (normalizedDictionarySearch === ""
      || voiceDictionaryTermKey(entry.text).includes(normalizedDictionarySearch)
      || entry.aliases.some((alias) => voiceDictionaryTermKey(alias.text).includes(normalizedDictionarySearch))));

  const persistDictionary = (dictionary: VoiceInputDictionaryState, message: string): void => {
    const saved = writeVoiceInputPreferences({ dictionary });
    setPreferences(saved);
    setDictionaryMessage({ error: false, text: message });
  };

  const addDictionaryEntry = (): void => {
    const next = addManualVoiceDictionaryTerm(preferences.dictionary, dictionaryDraft);
    if (next === undefined) {
      setDictionaryMessage({ error: true, text: t(dictionaryDraft.trim().length > MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS
        ? "settings.voiceInputDictionaryInvalid"
        : "settings.voiceInputDictionaryTooLarge") });
      return;
    }
    persistDictionary(next, t("settings.voiceInputDictionaryAdded"));
    setDictionaryDraft("");
  };

  const saveDictionaryRename = (entryId: string): void => {
    const next = renameVoiceDictionaryEntry(preferences.dictionary, entryId, editingDictionaryDraft);
    if (next === undefined) {
      setDictionaryMessage({ error: true, text: t("settings.voiceInputDictionaryInvalidOrDuplicate") });
      return;
    }
    persistDictionary(next, t("settings.voiceInputDictionaryRenamed"));
    setEditingDictionaryEntryId(undefined);
    setEditingDictionaryDraft("");
  };

  const importDictionary = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    if (file.size > MAXIMUM_VOICE_DICTIONARY_CSV_BYTES) {
      setDictionaryMessage({ error: true, text: t("settings.voiceInputDictionaryImportTooLarge") });
      return;
    }
    let text: string;
    try { text = await file.text(); }
    catch {
      setDictionaryMessage({ error: true, text: t("settings.voiceInputDictionaryImportFailed") });
      return;
    }
    const parsed = parseVoiceDictionaryCsv(text);
    if (!parsed.ok) {
      setDictionaryMessage({ error: true, text: t("settings.voiceInputDictionaryImportFailed") });
      return;
    }
    const existingManual = preferences.dictionary.entries
      .filter((entry) => entry.source === "manual")
      .map((entry) => entry.text);
    const imported = mergeManualVoiceDictionaryTerms(preferences.dictionary, [...existingManual, ...parsed.terms]);
    if (imported === undefined) {
      setDictionaryMessage({ error: true, text: t("settings.voiceInputDictionaryTooLarge") });
      return;
    }
    persistDictionary(imported, t("settings.voiceInputDictionaryImported", { count: parsed.terms.length }));
  };

  const saveService = async (): Promise<void> => {
    setServiceSaveError(undefined);
    setServiceSaved(false);
    const replacingCredential = serviceSecret.trim() !== "";
    const replacingFallbackCredential = fallbackSecret.trim() !== "";
    if (serviceEnabled && !serviceKeyless && !replacingCredential && (!service.credentialConfigured || clearServiceCredential)) {
      setServiceSaveError(t("settings.voiceInputCredentialRequired"));
      return;
    }
    if (replacingCredential && clearServiceCredential) {
      setServiceSaveError(t("settings.voiceInputCredentialReplaceOrClear"));
      return;
    }
    if (
      serviceEnabled && fallbackEnabled && !fallbackKeyless
      && !replacingFallbackCredential
      && (!service.fallbackCredentialConfigured || clearFallbackCredential)
    ) {
      setServiceSaveError(t("settings.voiceInputFallbackCredentialRequired"));
      return;
    }
    if (replacingFallbackCredential && clearFallbackCredential) {
      setServiceSaveError(t("settings.voiceInputCredentialReplaceOrClear"));
      return;
    }
    if (refinementEnabled && (refinerProviderId === "" || refinerModelId === "")) {
      setServiceSaveError(t("settings.voiceInputRefinementModelRequired"));
      return;
    }
    setSavingService(true);
    try {
      await controller.updateVoiceInputServiceSettings({
        enabled: serviceEnabled,
        protocol: serviceProtocol,
        endpoint: serviceEndpoint,
        model: serviceModel,
        keyless: serviceKeyless,
        ...(replacingCredential ? { secret: serviceSecret } : {}),
        ...(clearServiceCredential ? { clearCredential: true } : {}),
        refinementEnabled,
        refinerProviderId,
        refinerModelId,
        refinerFallbackProviderId,
        refinerFallbackModelId,
        fallbackEnabled,
        fallbackProtocol,
        fallbackEndpoint,
        fallbackModel,
        fallbackKeyless,
        ...(replacingFallbackCredential ? { fallbackSecret } : {}),
        ...(clearFallbackCredential ? { clearFallbackCredential: true } : {}),
        expectedRevision: service.revision
      });
      setServiceSecret("");
      setClearServiceCredential(false);
      setFallbackSecret("");
      setClearFallbackCredential(false);
      setServiceSaved(true);
    } catch {
      setServiceSaveError(t("settings.voiceInputServiceSaveFailed"));
    } finally {
      setSavingService(false);
    }
  };

  const testServiceConnection = async (): Promise<void> => {
    const requestId = connectionTestRequestRef.current + 1;
    connectionTestRequestRef.current = requestId;
    setConnectionTest("testing");
    try {
      const result = await controller.testVoiceInputConnection();
      if (connectionTestRequestRef.current !== requestId) return;
      setConnectionTest(result.ok ? "success" : result.reason);
    } catch {
      if (connectionTestRequestRef.current === requestId) setConnectionTest("serviceError");
    }
  };

  return <>
    <header className="settings-heading"><h2>{t("settings.voiceInput")}</h2><p>{t("settings.voiceInputBody")}</p></header>
    {capability.kind === "error" && <ErrorBanner message={t("settings.voiceInputCapabilityLoadFailed")} />}
    {deviceError && <ErrorBanner message={t("settings.voiceInputDeviceLoadFailed")} />}
    {serviceSaveError !== undefined && <ErrorBanner message={serviceSaveError} />}
    <section className="settings-card voice-input-settings voice-input-service-settings">
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceEnabled")}</strong><span>{t("settings.voiceInputServiceEnabledHint")}</span></div>
        <SwitchControl checked={serviceEnabled} disabled={savingService} aria-label={t("settings.voiceInputServiceEnabled")} onChange={(event) => setServiceEnabled(event.target.checked)} />
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceProtocol")}</strong><span>{t("settings.voiceInputServiceProtocolHint")}</span></div>
        <SelectControl value={serviceProtocol} disabled={savingService} aria-label={t("settings.voiceInputServiceProtocol")} onChange={(event) => {
          const protocol = event.target.value as VoiceInputTranscriptionProtocolView;
          const route = defaultVoiceInputRoute(protocol);
          setServiceProtocol(protocol);
          setServiceEndpoint(route.endpoint);
          setServiceModel(route.model);
          setConnectionTest("idle");
        }}>
          {VOICE_INPUT_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{t(voiceInputProtocolLabel(protocol))}</option>)}
        </SelectControl>
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceEndpoint")}</strong><span>{t("settings.voiceInputServiceEndpointHint")}</span></div>
        <input type="url" value={serviceEndpoint} disabled={savingService} aria-label={t("settings.voiceInputServiceEndpoint")} spellCheck={false} onChange={(event) => setServiceEndpoint(event.target.value)} />
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceModel")}</strong><span>{t("settings.voiceInputServiceModelHint")}</span></div>
        <input value={serviceModel} disabled={savingService} aria-label={t("settings.voiceInputServiceModel")} spellCheck={false} onChange={(event) => setServiceModel(event.target.value)} />
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceKeyless")}</strong><span>{t("settings.voiceInputServiceKeylessHint")}</span></div>
        <SwitchControl checked={serviceKeyless} disabled={savingService} aria-label={t("settings.voiceInputServiceKeyless")} onChange={(event) => setServiceKeyless(event.target.checked)} />
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputServiceApiKey")}</strong><span>{service.credentialConfigured ? t("settings.voiceInputCredentialStored") : t("settings.voiceInputCredentialNotStored")}</span></div>
        <input
          type="password"
          value={serviceSecret}
          disabled={savingService || serviceKeyless}
          autoComplete="off"
          aria-label={t("settings.voiceInputServiceApiKey")}
          placeholder={service.credentialConfigured ? t("settings.voiceInputCredentialUnchanged") : t("settings.voiceInputCredentialPlaceholder")}
          onChange={(event) => {
            setServiceSecret(event.target.value);
            if (event.target.value !== "") setClearServiceCredential(false);
          }}
        />
      </div>
      {service.credentialConfigured && <div className="setting-row">
        <div><strong>{t("settings.voiceInputClearCredential")}</strong><span>{t("settings.voiceInputClearCredentialHint")}</span></div>
        <SwitchControl checked={clearServiceCredential} disabled={savingService} aria-label={t("settings.voiceInputClearCredential")} onChange={(event) => {
          setClearServiceCredential(event.target.checked);
          if (event.target.checked) setServiceSecret("");
        }} />
      </div>}
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputFallbackEnabled")}</strong><span>{t("settings.voiceInputFallbackEnabledHint")}</span></div>
        <SwitchControl checked={fallbackEnabled} disabled={savingService} aria-label={t("settings.voiceInputFallbackEnabled")} onChange={(event) => setFallbackEnabled(event.target.checked)} />
      </div>
      {fallbackEnabled && <>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputFallbackProtocol")}</strong><span>{t("settings.voiceInputFallbackProtocolHint")}</span></div>
          <SelectControl value={fallbackProtocol} disabled={savingService} aria-label={t("settings.voiceInputFallbackProtocol")} onChange={(event) => {
            const protocol = event.target.value as VoiceInputTranscriptionProtocolView;
            const route = defaultVoiceInputRoute(protocol);
            setFallbackProtocol(protocol);
            setFallbackEndpoint(route.endpoint);
            setFallbackModel(route.model);
          }}>
            {VOICE_INPUT_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{t(voiceInputProtocolLabel(protocol))}</option>)}
          </SelectControl>
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputFallbackEndpoint")}</strong><span>{t("settings.voiceInputFallbackEndpointHint")}</span></div>
          <input type="url" value={fallbackEndpoint} disabled={savingService} aria-label={t("settings.voiceInputFallbackEndpoint")} spellCheck={false} onChange={(event) => setFallbackEndpoint(event.target.value)} />
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputFallbackModel")}</strong><span>{t("settings.voiceInputServiceModelHint")}</span></div>
          <input value={fallbackModel} disabled={savingService} aria-label={t("settings.voiceInputFallbackModel")} spellCheck={false} onChange={(event) => setFallbackModel(event.target.value)} />
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputFallbackKeyless")}</strong><span>{t("settings.voiceInputServiceKeylessHint")}</span></div>
          <SwitchControl checked={fallbackKeyless} disabled={savingService} aria-label={t("settings.voiceInputFallbackKeyless")} onChange={(event) => setFallbackKeyless(event.target.checked)} />
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputFallbackApiKey")}</strong><span>{service.fallbackCredentialConfigured ? t("settings.voiceInputCredentialStored") : t("settings.voiceInputCredentialNotStored")}</span></div>
          <input
            type="password"
            value={fallbackSecret}
            disabled={savingService || fallbackKeyless}
            autoComplete="off"
            aria-label={t("settings.voiceInputFallbackApiKey")}
            placeholder={service.fallbackCredentialConfigured ? t("settings.voiceInputCredentialUnchanged") : t("settings.voiceInputCredentialPlaceholder")}
            onChange={(event) => {
              setFallbackSecret(event.target.value);
              if (event.target.value !== "") setClearFallbackCredential(false);
            }}
          />
        </div>
        {service.fallbackCredentialConfigured && <div className="setting-row">
          <div><strong>{t("settings.voiceInputClearFallbackCredential")}</strong><span>{t("settings.voiceInputClearCredentialHint")}</span></div>
          <SwitchControl checked={clearFallbackCredential} disabled={savingService} aria-label={t("settings.voiceInputClearFallbackCredential")} onChange={(event) => {
            setClearFallbackCredential(event.target.checked);
            if (event.target.checked) setFallbackSecret("");
          }} />
        </div>}
      </>}
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputRefinementEnabled")}</strong><span>{t("settings.voiceInputRefinementEnabledHint")}</span></div>
        <SwitchControl checked={refinementEnabled} disabled={savingService} aria-label={t("settings.voiceInputRefinementEnabled")} onChange={(event) => setRefinementEnabled(event.target.checked)} />
      </div>
      {refinementEnabled && <div className="setting-row">
        <div><strong>{t("settings.voiceInputRefinementModel")}</strong><span>{refinementModels.length === 0 ? t("settings.voiceInputRefinementNoModels") : t("settings.voiceInputRefinementModelHint")}</span></div>
        <SelectControl
          value={selectedRefinementModel}
          disabled={savingService || refinementModels.length === 0}
          aria-label={t("settings.voiceInputRefinementModel")}
          onChange={(event) => {
            const selected = refinementModels.find((model) => model.key === event.target.value);
            setRefinerProviderId(selected?.providerId ?? "");
            setRefinerModelId(selected?.modelId ?? "");
            if (selected?.key === selectedRefinementFallbackModel) {
              setRefinerFallbackProviderId("");
              setRefinerFallbackModelId("");
            }
          }}
        >
          <option value="">{t("settings.voiceInputRefinementSelectModel")}</option>
          {refinementModels.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
        </SelectControl>
      </div>}
      {refinementEnabled && <div className="setting-row">
        <div><strong>{t("settings.voiceInputRefinementFallbackModel")}</strong><span>{t("settings.voiceInputRefinementFallbackModelHint")}</span></div>
        <SelectControl
          value={selectedRefinementFallbackModel}
          disabled={savingService || selectedRefinementModel === "" || refinementFallbackModels.length === 0}
          aria-label={t("settings.voiceInputRefinementFallbackModel")}
          onChange={(event) => {
            const selected = refinementFallbackModels.find((model) => model.key === event.target.value);
            setRefinerFallbackProviderId(selected?.providerId ?? "");
            setRefinerFallbackModelId(selected?.modelId ?? "");
          }}
        >
          <option value="">{t("settings.voiceInputRefinementFallbackNone")}</option>
          {refinementFallbackModels.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
        </SelectControl>
      </div>}
      <div className="voice-input-service-actions">
        <span role={isVoiceConnectionFailure(connectionTest) ? "alert" : "status"}>{connectionTest === "idle"
          ? serviceSaved ? t("settings.voiceInputServiceSaved") : t("settings.voiceInputServiceSecureHint")
          : connectionTest === "testing" ? t("settings.voiceInputConnectionTesting")
            : connectionTest === "success" ? t("settings.voiceInputConnectionSuccess")
              : t(voiceInputConnectionFailureKey(connectionTest))}</span>
        <div>
          <Button tone="ghost" disabled={savingService || connectionTest === "testing" || serviceFormDirty} title={serviceFormDirty ? t("settings.voiceInputConnectionSaveFirst") : t("settings.voiceInputConnectionHint")} onClick={() => void testServiceConnection()}>{t("settings.voiceInputConnectionTest")}</Button>
          <Button tone="primary" disabled={savingService} onClick={() => void saveService()}>{savingService ? t("settings.voiceInputServiceSaving") : t("settings.voiceInputServiceSave")}</Button>
        </div>
      </div>
    </section>
    <section className="settings-card voice-input-settings">
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputAvailability")}</strong><span>{capability.kind === "ready" ? capability.value.reason ?? t("settings.voiceInputServiceManaged") : t("settings.voiceInputServiceManaged")}</span></div>
        <Pill tone={supported ? "success" : capability.kind === "loading" ? "neutral" : "warning"}>
          {capability.kind === "loading" ? t("settings.voiceInputChecking") : supported ? t("settings.voiceInputSupported") : t("settings.voiceInputUnavailable")}
        </Pill>
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputService")}</strong><span>{t("settings.voiceInputServiceHint")}</span></div>
        <span className="setting-row__value">{service.enabled ? `${service.model} · ${t(voiceInputProtocolLabel(service.protocol))}` : t("settings.voiceInputServiceDisabled")}</span>
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputPermission")}</strong><span>{permissionLabel(permission, t)}</span></div>
        {desktopMicrophone !== undefined && permission !== "granted" && <Button tone="ghost" onClick={() => void desktopMicrophone.openSettings()}>{t("settings.voiceInputOpenPermissionSettings")}</Button>}
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputLocale")}</strong><span>{supported && capability.kind === "ready" && !capability.value.supportsLocale ? t("settings.voiceInputServiceManaged") : t("settings.voiceInputBody")}</span></div>
        <SelectControl
          aria-label={t("settings.voiceInputLocale")}
          value={preferences.locale}
          disabled={capability.kind === "ready" && !capability.value.supportsLocale}
          onChange={(event) => setPreferences(writeVoiceInputPreferences({ locale: event.target.value }))}
        >
          <option value="auto">{t("settings.voiceInputLocaleAuto")}</option>
          {VOICE_INPUT_LOCALES.map((locale) => <option key={locale} value={locale}>{voiceInputLocaleLabel(locale)}</option>)}
        </SelectControl>
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputDevice")}</strong><span>{permission === "granted" ? t("settings.voiceInputSupported") : permissionLabel(permission, t)}</span></div>
        <SelectControl
          aria-label={t("settings.voiceInputDevice")}
          value={preferences.deviceId ?? ""}
          onChange={(event) => setPreferences(writeVoiceInputPreferences({ deviceId: event.target.value }))}
        >
          <option value="">{t("settings.voiceInputDeviceDefault")}</option>
          {!selectedDeviceExists && preferences.deviceId !== undefined && <option value={preferences.deviceId}>{t("settings.voiceInputUnavailable")}</option>}
          {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || t("settings.voiceInputDeviceUnknown", { number: index + 1 })}</option>)}
        </SelectControl>
      </div>
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputShortcut")}</strong><span>{shortcutError ?? globalVoiceShortcutHint(desktopGlobalVoice !== undefined, globalShortcutRegistration, t)}</span></div>
        <div className="voice-input-shortcut-control">
          <kbd>{recordingShortcut ? t("settings.voiceInputShortcutRecording") : formatVoiceInputShortcut(preferences.shortcut, typeof navigator === "undefined" ? "" : navigator.platform) || t("settings.voiceInputShortcutOff")}</kbd>
          <Button tone="ghost" onClick={() => {
            setShortcutError(undefined);
            setRecordingShortcut((current) => !current);
          }}>{recordingShortcut ? t("settings.voiceInputShortcutCancel") : t("settings.voiceInputShortcutChange")}</Button>
          {preferences.shortcut !== "disabled" && <Button tone="ghost" onClick={() => saveShortcutPreference("disabled")}>{t("settings.voiceInputShortcutDisable")}</Button>}
          {!voiceInputShortcutsEqual(preferences.shortcut, defaultVoiceInputShortcut()) && <Button tone="ghost" onClick={() => saveShortcutPreference(defaultVoiceInputShortcut())}>{t("settings.voiceInputShortcutReset")}</Button>}
        </div>
      </div>
      {desktopGlobalVoice !== undefined && window.jokoDesktop?.platform === "darwin" && <div className="setting-row">
        <div><strong>{t("settings.voiceInputGlobalAccessibility")}</strong><span>{t(globalAccessibility === "granted" ? "settings.voiceInputGlobalAccessibilityGranted" : "settings.voiceInputGlobalAccessibilityHint")}</span></div>
        {globalAccessibility !== "granted" && <Button tone="ghost" onClick={() => void desktopGlobalVoice.openAccessibility()}>{t("settings.voiceInputOpenAccessibilitySettings")}</Button>}
      </div>}
      {desktopGlobalVoice !== undefined && window.jokoDesktop?.platform === "darwin" && <div className="setting-row">
        <div><strong>{t("settings.voiceInputGlobalInputMonitoring")}</strong><span>{t(globalInputMonitoring === "granted" ? "settings.voiceInputGlobalInputMonitoringGranted" : "settings.voiceInputGlobalInputMonitoringHint")}</span></div>
        {globalInputMonitoring !== "granted" && <Button tone="ghost" onClick={() => void desktopGlobalVoice.openInputMonitoring()}>{t("settings.voiceInputOpenInputMonitoringSettings")}</Button>}
      </div>}
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputInteractionSound")}</strong><span>{t("settings.voiceInputInteractionSoundHint")}</span></div>
        <SwitchControl checked={preferences.playInteractionSound} aria-label={t("settings.voiceInputInteractionSound")} onChange={(event) => setPreferences(writeVoiceInputPreferences({ playInteractionSound: event.target.checked }))} />
      </div>
      {desktopGlobalVoice !== undefined && (window.jokoDesktop?.platform === "darwin" || window.jokoDesktop?.platform === "win32") && <div className="setting-row">
        <div><strong>{t("settings.voiceInputMuteSystemAudio")}</strong><span>{t("settings.voiceInputMuteSystemAudioHint")}</span></div>
        <SwitchControl checked={preferences.muteOtherSounds} aria-label={t("settings.voiceInputMuteSystemAudio")} onChange={(event) => setPreferences(writeVoiceInputPreferences({ muteOtherSounds: event.target.checked }))} />
      </div>}
      <div className="setting-row">
        <div><strong>{t("settings.voiceInputFastActivation")}</strong><span>{t("settings.voiceInputFastActivationHint")}</span></div>
        <SwitchControl checked={preferences.fastActivationEnabled} aria-label={t("settings.voiceInputFastActivation")} onChange={(event) => setPreferences(writeVoiceInputPreferences({ fastActivationEnabled: event.target.checked }))} />
      </div>
      {refinementEnabled && <>
        <div className="voice-input-setting-stack">
          <div><strong>{t("settings.voiceInputRefinementInstructions")}</strong><span>{t("settings.voiceInputRefinementInstructionsHint")}</span></div>
          <textarea
            value={preferences.refinementInstructions}
            maxLength={MAXIMUM_VOICE_REFINEMENT_INSTRUCTIONS_CHARACTERS}
            rows={4}
            aria-label={t("settings.voiceInputRefinementInstructions")}
            placeholder={t("settings.voiceInputRefinementInstructionsPlaceholder")}
            onChange={(event) => setPreferences(writeVoiceInputPreferences({ refinementInstructions: event.target.value }))}
          />
        </div>
        <div className="setting-row">
          <div><strong>{t("settings.voiceInputAutoDictionary")}</strong><span>{t("settings.voiceInputAutoDictionaryHint")}</span></div>
          <SwitchControl checked={preferences.autoDictionaryEnabled} aria-label={t("settings.voiceInputAutoDictionary")} onChange={(event) => setPreferences(writeVoiceInputPreferences({ autoDictionaryEnabled: event.target.checked }))} />
        </div>
        <div className="voice-input-setting-stack">
          <div><strong>{t("settings.voiceInputDictionary")}</strong><span>{t("settings.voiceInputDictionaryHint")}</span></div>
          <div className="voice-input-dictionary-add">
            <input
              value={dictionaryDraft}
              maxLength={MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS}
              aria-label={t("settings.voiceInputDictionaryNewTerm")}
              placeholder={t("settings.voiceInputDictionaryPlaceholder")}
              onChange={(event) => {
                setDictionaryDraft(event.target.value);
                setDictionaryMessage(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                addDictionaryEntry();
              }}
            />
            <Button tone="primary" disabled={dictionaryDraft.trim() === ""} onClick={addDictionaryEntry}>{t("settings.voiceInputDictionaryAdd")}</Button>
          </div>
          <div className="voice-input-dictionary-toolbar">
            <input
              type="search"
              value={dictionarySearch}
              aria-label={t("settings.voiceInputDictionarySearch")}
              placeholder={t("settings.voiceInputDictionarySearch")}
              onChange={(event) => setDictionarySearch(event.target.value)}
            />
            <SelectControl value={dictionaryFilter} aria-label={t("settings.voiceInputDictionaryFilter")} onChange={(event) => setDictionaryFilter(event.target.value as typeof dictionaryFilter)}>
              <option value="all">{t("settings.voiceInputDictionaryFilterAll", { count: dictionaryCounts.all })}</option>
              <option value="manual">{t("settings.voiceInputDictionaryFilterManual", { count: dictionaryCounts.manual })}</option>
              <option value="automatic">{t("settings.voiceInputDictionaryFilterAutomatic", { count: dictionaryCounts.automatic })}</option>
            </SelectControl>
          </div>
          <div className="voice-input-dictionary-actions">
            <span className={dictionaryMessage?.error === true ? "is-error" : undefined} role={dictionaryMessage?.error === true ? "alert" : "status"}>{dictionaryMessage?.text ?? t("settings.voiceInputDictionaryCountRich", { entries: dictionaryCounts.all, candidates: preferences.dictionary.candidates.length })}</span>
            <label className="button button--ghost" htmlFor="voice-input-dictionary-import">{t("settings.voiceInputDictionaryImport")}</label>
            <input
              id="voice-input-dictionary-import"
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void importDictionary(file);
              }}
            />
          </div>
          <div className="voice-input-dictionary-list">
            {visibleDictionaryEntries.length === 0
              ? <p className="voice-input-dictionary-empty">{t(normalizedDictionarySearch === "" && dictionaryFilter === "all"
                  ? "settings.voiceInputDictionaryEmpty"
                  : "settings.voiceInputDictionaryNoMatches")}</p>
              : visibleDictionaryEntries.map((entry) => <article key={entry.id}>
                  <div className="voice-input-dictionary-entry-copy">
                    {editingDictionaryEntryId === entry.id
                      ? <input
                          autoFocus
                          value={editingDictionaryDraft}
                          maxLength={MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS}
                          aria-label={t("settings.voiceInputDictionaryEditTerm")}
                          onChange={(event) => setEditingDictionaryDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditingDictionaryEntryId(undefined);
                              setEditingDictionaryDraft("");
                            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              saveDictionaryRename(entry.id);
                            }
                          }}
                        />
                      : <><strong>{entry.text}</strong>{entry.aliases.length > 0 && <small>{t("settings.voiceInputDictionaryAliases", { aliases: entry.aliases.map((alias) => alias.text).join(", ") })}</small>}</>}
                  </div>
                  <div className="voice-input-dictionary-entry-meta">
                    <Pill tone={entry.source === "manual" ? "neutral" : "success"}>{t(entry.source === "manual" ? "settings.voiceInputDictionaryManual" : "settings.voiceInputDictionaryAutomatic")}</Pill>
                    {entry.frequency > 1 && <small>{t("settings.voiceInputDictionaryFrequency", { count: entry.frequency })}</small>}
                  </div>
                  <div className="voice-input-dictionary-entry-actions">
                    {editingDictionaryEntryId === entry.id
                      ? <>
                          <Button tone="primary" disabled={editingDictionaryDraft.trim() === ""} onClick={() => saveDictionaryRename(entry.id)}>{t("common.save")}</Button>
                          <Button tone="ghost" onClick={() => {
                            setEditingDictionaryEntryId(undefined);
                            setEditingDictionaryDraft("");
                          }}>{t("common.cancel")}</Button>
                        </>
                      : <>
                          <Button tone="ghost" onClick={() => {
                            setEditingDictionaryEntryId(entry.id);
                            setEditingDictionaryDraft(entry.text);
                            setDictionaryMessage(undefined);
                          }}>{t("common.edit")}</Button>
                          <Button tone="ghost" onClick={() => {
                            persistDictionary(deleteVoiceDictionaryEntry(preferences.dictionary, entry.id), t("settings.voiceInputDictionaryDeleted"));
                            if (editingDictionaryEntryId === entry.id) setEditingDictionaryEntryId(undefined);
                          }}>{t("common.delete")}</Button>
                        </>}
                  </div>
                </article>)}
          </div>
        </div>
      </>}
    </section>
    <section className="settings-card voice-input-usage-settings" aria-label={t("settings.voiceInputUsage") }>
      <div className="voice-input-usage-heading">
        <div><strong>{t("settings.voiceInputUsage")}</strong><span>{t("settings.voiceInputUsageHint")}</span></div>
        <Button tone="ghost" disabled={usage.sessionCount === 0 && usage.entries.length === 0} onClick={() => {
          setUsage(resetVoiceInputUsage());
          setHistoryMessage(t("settings.voiceInputUsageResetDone"));
        }}>{t("settings.voiceInputUsageReset")}</Button>
      </div>
      <dl className="voice-input-usage-grid">
        <div><dt>{t("settings.voiceInputUsageDuration")}</dt><dd>{formatVoiceDuration(usage.totalAudioMs)}</dd></div>
        <div><dt>{t("settings.voiceInputUsageSessions")}</dt><dd>{usage.sessionCount}</dd></div>
        <div><dt>{t("settings.voiceInputUsageOutcomes")}</dt><dd>{t("settings.voiceInputUsageOutcomeCounts", { noSpeech: usage.noSpeechSessionCount, failed: usage.failedSessionCount })}</dd></div>
      </dl>
      <button type="button" className="voice-input-history-toggle" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded((current) => !current)}>
        <span>{t("settings.voiceInputHistory")} ({usage.entries.length})</span>
        <span aria-hidden="true">{historyExpanded ? "−" : "+"}</span>
      </button>
      {historyMessage !== undefined && <span className="voice-input-history-status" role="status">{historyMessage}</span>}
      {historyExpanded && <div className="voice-input-history-list">
        {usage.entries.length === 0
          ? <p>{t("settings.voiceInputHistoryEmpty")}</p>
          : usage.entries.map((entry) => <article key={entry.id}>
              <div><p>{entry.text}</p><time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time></div>
              <div className="voice-input-history-actions">
                <button type="button" onClick={() => {
                  void navigator.clipboard.writeText(entry.text).then(() => setHistoryMessage(t("settings.voiceInputHistoryCopied"))).catch(() => setHistoryMessage(t("settings.voiceInputHistoryCopyFailed")));
                }}>{t("settings.voiceInputHistoryCopy")}</button>
                <button type="button" onClick={() => {
                  setUsage(deleteVoiceInputHistoryEntry(entry.id));
                  setHistoryMessage(t("settings.voiceInputHistoryDeleted"));
                }}>{t("settings.voiceInputHistoryDelete")}</button>
              </div>
            </article>)}
      </div>}
    </section>
  </>;
}

function permissionLabel(permission: MicrophonePermissionState, t: Translator): string {
  if (permission === "granted") return t("settings.voiceInputPermissionGranted");
  if (permission === "denied") return t("settings.voiceInputPermissionDenied");
  if (permission === "prompt") return t("settings.voiceInputPermissionPrompt");
  return t("settings.voiceInputPermissionUnknown");
}

function globalVoiceShortcutHint(
  available: boolean,
  registration: { readonly accepted: true; readonly activation: "hold" | "toggle" }
    | { readonly accepted: false; readonly reason: "unsupported" | "in-use" | "permission" }
    | undefined,
  t: Translator
): string {
  if (!available) return t("settings.voiceInputShortcutHint");
  if (registration?.accepted === false) {
    if (registration.reason === "in-use") return t("settings.voiceInputGlobalShortcutInUse");
    if (registration.reason === "permission") return t("settings.voiceInputGlobalShortcutPermission");
    return t("settings.voiceInputGlobalShortcutUnsupported");
  }
  return t(registration?.activation === "hold"
    ? "settings.voiceInputGlobalShortcutHoldHint"
    : "settings.voiceInputGlobalShortcutHint");
}

function voiceInputProtocolLabel(protocol: VoiceInputTranscriptionProtocolView): Parameters<Translator>[0] {
  switch (protocol) {
    case "openAiCompatibleBatch": return "settings.voiceInputProtocolBatch";
    case "openAiCompatibleRealtime": return "settings.voiceInputProtocolOpenAiRealtime";
    case "qwenCompatibleRealtime": return "settings.voiceInputProtocolQwenRealtime";
  }
}

function defaultVoiceInputRoute(protocol: VoiceInputTranscriptionProtocolView): {
  readonly endpoint: string;
  readonly model: string;
} {
  switch (protocol) {
    case "openAiCompatibleBatch":
      return { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1" };
    case "openAiCompatibleRealtime":
      return { endpoint: "wss://api.openai.com/v1/realtime?intent=transcription", model: "gpt-realtime-whisper" };
    case "qwenCompatibleRealtime":
      return { endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen3-asr-flash-realtime" };
  }
}

function isVoiceConnectionFailure(
  value: "idle" | "testing" | "success" | VoiceInputConnectionTestFailureView
): value is VoiceInputConnectionTestFailureView {
  return value !== "idle" && value !== "testing" && value !== "success";
}

function voiceInputConnectionFailureKey(value: VoiceInputConnectionTestFailureView): Parameters<Translator>[0] {
  switch (value) {
    case "credentialsMissing": return "settings.voiceInputConnectionCredentialsMissing";
    case "authenticationFailed": return "settings.voiceInputConnectionAuthenticationFailed";
    case "routeUnavailable": return "settings.voiceInputConnectionRouteUnavailable";
    case "timeout": return "settings.voiceInputConnectionTimeout";
    case "network": return "settings.voiceInputConnectionNetwork";
    case "serviceError": return "settings.voiceInputConnectionServiceError";
  }
}

function voiceInputLocaleLabel(locale: typeof VOICE_INPUT_LOCALES[number]): string {
  switch (locale) {
    case "zh-CN": return "简体中文";
    case "zh-TW": return "繁體中文";
    case "en": return "English";
    case "ja": return "日本語";
    case "ko": return "한국어";
  }
}

function supportsManagedTextInference(compatibility: string): boolean {
  return compatibility === "anthropic" || compatibility === "openaiResponses"
    || compatibility === "openaiChat" || compatibility === "openaiCompletions";
}

function refinementModelKey(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`;
}

function voiceShortcutConflict(
  combo: AppShortcutCombo,
  overrides: AppController["state"]["preferences"]["appShortcutOverrides"],
  platform: ReturnType<typeof currentAppShortcutPlatform>
): AppShortcutId | null {
  for (const definition of APP_SHORTCUT_DEFINITION_LIST) {
    if (effectiveAppShortcutCombos(definition.id, overrides, platform).some((candidate) => appShortcutCombosEqual(candidate, combo))) {
      return definition.id;
    }
  }
  return null;
}

function formatVoiceDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
