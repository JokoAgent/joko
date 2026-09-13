import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";

import {
  appShortcutCombosEqual,
  createAppShortcutComboFromEvent,
  currentAppShortcutPlatform,
  effectiveAppShortcutCombos,
  formatAppShortcutCombo,
  getAppShortcutDefinition,
  visibleAppShortcutDefinitions,
  validateAppShortcutCombo,
  type AppShortcutCombo,
  type AppShortcutId,
  type AppShortcutOverrideValue,
  type AppShortcutOverrides,
  type AppShortcutPlatform,
  type AppShortcutValidationIssue
} from "../app-shortcuts.js";
import type { AppController } from "../controller.js";
import { readVoiceInputPreferences, type VoiceInputShortcutPreference } from "../voice-input-preferences.js";
import type { Translator } from "./types.js";
import { IconButton } from "./ui.js";

interface RecordingError {
  readonly id: AppShortcutId;
  readonly message: string;
}

/**
 * Application shortcut editor. Only executable, visible
 * actions for the current platform are listed; persisted overrides remain
 * local UI preferences.
 */
export function AppShortcutsSettings({ controller, overrides, t, platform = currentAppShortcutPlatform() }: {
  readonly controller: AppController;
  readonly overrides: AppShortcutOverrides;
  readonly t: Translator;
  /** Explicit only for deterministic platform-surface tests. */
  readonly platform?: AppShortcutPlatform;
}): JSX.Element {
  const definitions = visibleAppShortcutDefinitions(platform);
  const [recordingId, setRecordingId] = useState<AppShortcutId | null>(null);
  const [savingId, setSavingId] = useState<AppShortcutId | "all" | null>(null);
  const [error, setError] = useState<RecordingError | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const mutationRequestIdRef = useRef(0);
  const editButtonsRef = useRef(new Map<AppShortcutId, HTMLButtonElement>());

  const beginShortcutAction = useCallback((): number => {
    const requestId = ++mutationRequestIdRef.current;
    setError(null);
    setGlobalError(null);
    setSavingId(null);
    return requestId;
  }, []);

  const focusEditButton = useCallback((id: AppShortcutId): void => {
    window.requestAnimationFrame(() => editButtonsRef.current.get(id)?.focus());
  }, []);

  const stopRecording = useCallback((restoreFocus: boolean): void => {
    const id = recordingId;
    setRecordingId(null);
    if (restoreFocus && id !== null) focusEditButton(id);
  }, [focusEditButton, recordingId]);

  const persistOverride = useCallback((id: AppShortcutId, value: AppShortcutOverrideValue | undefined): void => {
    const requestId = beginShortcutAction();
    setSavingId(id);
    void controller.setAppShortcutOverride(id, value).then(() => {
      if (requestId === mutationRequestIdRef.current) focusEditButton(id);
    }).catch(() => {
      if (requestId === mutationRequestIdRef.current) {
        setError({ id, message: t("settings.shortcuts.errors.saveFailed") });
      }
    }).finally(() => {
      if (requestId === mutationRequestIdRef.current) setSavingId(null);
    });
  }, [beginShortcutAction, controller, focusEditButton, t]);

  useEffect(() => {
    if (recordingId === null) return;
    document.body.dataset.appShortcutRecording = "1";
    let active = true;
    let shortcutBindingSuspended = window.jokoDesktop === undefined;
    const shortcutBindingSuspension = window.jokoDesktop?.applicationMenu.configure({ shortcutRecording: true })
      ?? Promise.resolve();
    const cancelForBlur = (): void => stopRecording(false);
    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!shortcutBindingSuspended) return;
      if (event.key === "Escape") {
        stopRecording(true);
        return;
      }
      const decision = appShortcutRecordingDecision(
        recordingId,
        event,
        overrides,
        platform,
        readVoiceInputPreferences().shortcut
      );
      if (decision.kind === "wait") return;
      if (decision.kind === "unchanged") {
        stopRecording(true);
        return;
      }
      if (decision.kind === "reject") {
        beginShortcutAction();
        setError({ id: recordingId, message: appShortcutValidationMessage(decision.issue, t) });
        stopRecording(true);
        return;
      }
      persistOverride(recordingId, decision.combo);
      stopRecording(true);
    };
    void shortcutBindingSuspension.then(() => {
      if (active) shortcutBindingSuspended = true;
    }).catch(() => {
      if (!active) return;
      setGlobalError(t("settings.shortcuts.errors.saveFailed"));
      stopRecording(true);
    });
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", cancelForBlur);
    return () => {
      active = false;
      delete document.body.dataset.appShortcutRecording;
      void window.jokoDesktop?.applicationMenu.configure({ shortcutRecording: false }).catch(() => undefined);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", cancelForBlur);
    };
  }, [beginShortcutAction, overrides, persistOverride, platform, recordingId, stopRecording, t]);

  const resetAll = (): void => {
    const requestId = beginShortcutAction();
    setRecordingId(null);
    setSavingId("all");
    void controller.resetAppShortcutOverrides().then(() => {
      if (requestId !== mutationRequestIdRef.current) return;
      const firstEditable = definitions.find((definition) => definition.rebindable);
      if (firstEditable !== undefined) focusEditButton(firstEditable.id);
    }).catch(() => {
      if (requestId === mutationRequestIdRef.current) {
        setGlobalError(t("settings.shortcuts.errors.saveFailed"));
      }
    }).finally(() => {
      if (requestId === mutationRequestIdRef.current) setSavingId(null);
    });
  };

  const hasAnyOverride = Object.keys(overrides).length > 0;
  return (
    <div className="shortcut-settings">
      <header className="settings-heading shortcut-settings__heading">
        <div>
          <h2>{t("settings.shortcuts.title")}</h2>
          <p>{t("settings.shortcuts.body")}</p>
        </div>
        {hasAnyOverride && (
          <button type="button" className="shortcut-settings__reset-all" onClick={resetAll}>
            {t("settings.shortcuts.resetAll")}
          </button>
        )}
      </header>
      <div className="shortcut-settings__live sr-only" role="status" aria-live="polite">
        {recordingId !== null
          ? t("settings.shortcuts.recording")
          : savingId !== null
            ? t("settings.shortcuts.saving")
            : globalError ?? error?.message ?? ""}
      </div>
      {globalError !== null && <p className="shortcut-settings__global-error" role="alert">{globalError}</p>}
      <section className="settings-card shortcut-settings__card" aria-label={t("settings.shortcuts.title")} aria-busy={savingId !== null}>
        {definitions.map((definition) => {
          const isRecording = recordingId === definition.id;
          const customized = Object.prototype.hasOwnProperty.call(overrides, definition.id);
          const combos = effectiveAppShortcutCombos(definition.id, overrides, platform);
          const rowError = error?.id === definition.id ? error.message : null;
          return (
            <div className="shortcut-settings__row" key={definition.id} data-shortcut-id={definition.id}>
              <div className="shortcut-settings__copy">
                <strong>{t(definition.labelKey)}</strong>
                <span>{t(definition.descriptionKey)}</span>
                {rowError !== null && !isRecording && <small className="shortcut-settings__error" role="alert">{rowError}</small>}
              </div>
              <kbd className={isRecording ? "is-recording" : combos.length === 0 ? "is-empty" : undefined}>
                {isRecording
                  ? t("settings.shortcuts.recording")
                  : combos.length === 0
                    ? t("settings.shortcuts.none")
                    : combos.map((combo) => formatAppShortcutCombo(combo, platform)).join(" / ")}
              </kbd>
              {isRecording ? (
                <button type="button" className="shortcut-settings__cancel" onClick={() => stopRecording(true)}>
                  {t("settings.shortcuts.cancel")}
                </button>
              ) : (
                <div className="shortcut-settings__actions">
                  <IconButton
                    className="shortcut-settings__icon"
                    disabled={!definition.rebindable}
                    disabledReason={!definition.rebindable ? t("settings.shortcuts.edit") : undefined}
                    buttonRef={(element) => {
                      if (element === null) editButtonsRef.current.delete(definition.id);
                      else editButtonsRef.current.set(definition.id, element);
                    }}
                    label={t("settings.shortcuts.editAria", { name: t(definition.labelKey) })}
                    tip={t("settings.shortcuts.edit")}
                    onClick={() => {
                      beginShortcutAction();
                      setRecordingId(definition.id);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  {combos.length > 0 && (
                    <IconButton
                      className="shortcut-settings__icon"
                      disabled={!definition.rebindable}
                      disabledReason={!definition.rebindable ? t("settings.shortcuts.delete") : undefined}
                      label={t("settings.shortcuts.deleteAria", { name: t(definition.labelKey) })}
                      tip={t("settings.shortcuts.delete")}
                      onClick={() => persistOverride(definition.id, null)}
                    >
                      <Trash2 aria-hidden="true" />
                    </IconButton>
                  )}
                  {customized && (
                    <IconButton
                      className="shortcut-settings__icon"
                      label={t("settings.shortcuts.resetAria", { name: t(definition.labelKey) })}
                      tip={t("settings.shortcuts.reset")}
                      onClick={() => persistOverride(definition.id, undefined)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

export type AppShortcutRecordingIssue = AppShortcutValidationIssue | { readonly kind: "voice-conflict" };

export function appShortcutValidationMessage(issue: AppShortcutRecordingIssue, t: Translator): string {
  if (issue.kind === "not-bindable") return t("settings.shortcuts.errors.notBindable");
  if (issue.kind === "system-reserved") return t("settings.shortcuts.errors.systemReserved");
  if (issue.kind === "menu-inexpressible") return t("settings.shortcuts.errors.menuAccelerator");
  if (issue.kind === "voice-conflict") {
    return t("settings.shortcuts.errors.conflict", { name: t("settings.voiceInput") });
  }
  return t("settings.shortcuts.errors.conflict", {
    name: t(getAppShortcutDefinition(issue.conflictingId).labelKey)
  });
}

/** Testable recording decision for keyboard-only behavior and validation. */
export function appShortcutRecordingDecision(
  id: AppShortcutId,
  event: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  overrides: AppShortcutOverrides,
  platform: AppShortcutPlatform,
  voiceShortcut?: VoiceInputShortcutPreference
):
  | { readonly kind: "wait" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "reject"; readonly issue: AppShortcutRecordingIssue }
  | { readonly kind: "commit"; readonly combo: AppShortcutCombo } {
  const combo = createAppShortcutComboFromEvent(event);
  if (combo === null) return { kind: "wait" };
  if (effectiveAppShortcutCombos(id, overrides, platform).some((candidate) => appShortcutCombosEqual(candidate, combo))) {
    return { kind: "unchanged" };
  }
  if (voiceShortcut !== undefined
    && voiceShortcut !== "disabled"
    && !voiceShortcut.fn
    && appShortcutCombosEqual(voiceShortcut, combo)) {
    return { kind: "reject", issue: { kind: "voice-conflict" } };
  }
  const issue = validateAppShortcutCombo(id, combo, overrides, platform);
  return issue === null ? { kind: "commit", combo } : { kind: "reject", issue };
}
