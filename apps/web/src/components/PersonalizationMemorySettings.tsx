import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { RotateCcw, Sparkles } from "lucide-react";

import type { AppController } from "../controller.js";
import type { AppSnapshot } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, ModalBackButton, CheckboxControl, SwitchControl } from "./ui.js";

import "./PersonalizationMemorySettings.css";

type ResetTarget =
  | { readonly kind: "curated" }
  | { readonly kind: "backend"; readonly backendId: string; readonly backendName: string };

function PiMemoryMark(): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.6 6.6h16.8" />
      <path d="M8.4 6.6v11.8" />
      <path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2" />
    </g>
  </svg>;
}

export function PersonalizationMemorySettings({ controller, snapshot, runAction, onSuccess, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly onSuccess: (text: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const settings = snapshot.settings.memory;
  const [makerEnabled, setMakerEnabled] = useState(settings.makerEnabled);
  const [backendEnabled, setBackendEnabled] = useState<Readonly<Record<string, boolean>>>(() =>
    Object.fromEntries(settings.backends.map((backend) => [backend.backendId, backend.enabled])));
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [resetTarget, setResetTarget] = useState<ResetTarget>();

  useEffect(() => setMakerEnabled(settings.makerEnabled), [settings.makerEnabled]);
  useEffect(() => {
    setBackendEnabled(Object.fromEntries(settings.backends.map((backend) => [backend.backendId, backend.enabled])));
  }, [settings.backends]);

  const backendNames = useMemo(() => new Map(snapshot.backends.map((backend) => [backend.id, backend.name])), [snapshot.backends]);
  const markPending = (key: string, value: boolean): void => {
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  };
  const toggleMaker = (next: boolean): void => {
    const previous = makerEnabled;
    setMakerEnabled(next);
    markPending("maker", true);
    runAction("memory-maker-toggle", async () => {
      try {
        await controller.updateMemorySettings({ makerEnabled: next });
        onSuccess(t(next ? "settings.memory.toast.makerEnabled" : "settings.memory.toast.makerDisabled"));
      } catch (error) {
        setMakerEnabled(previous);
        throw error;
      } finally {
        markPending("maker", false);
      }
    });
  };
  const toggleBackend = (backendId: string, backendName: string, next: boolean): void => {
    const previous = backendEnabled[backendId] ?? true;
    setBackendEnabled((current) => ({ ...current, [backendId]: next }));
    markPending(`backend:${backendId}`, true);
    runAction(`memory-backend-toggle:${backendId}`, async () => {
      try {
        await controller.updateMemorySettings({ backendId, backendEnabled: next });
        onSuccess(t(next ? "settings.memory.toast.backendEnabled" : "settings.memory.toast.backendDisabled", { backend: backendName }));
      } catch (error) {
        setBackendEnabled((current) => ({ ...current, [backendId]: previous }));
        throw error;
      } finally {
        markPending(`backend:${backendId}`, false);
      }
    });
  };
  const restoreDefaults = (): void => {
    markPending("defaults", true);
    runAction("memory-restore-defaults", async () => {
      try {
        await controller.restoreMemoryDefaults();
        onSuccess(t("settings.defaults.restored"));
      } finally {
        markPending("defaults", false);
      }
    });
  };
  const confirmReset = (): void => {
    const target = resetTarget;
    if (target === undefined) return;
    setResetTarget(undefined);
    const key = target.kind === "curated" ? "reset:curated" : `reset:${target.backendId}`;
    markPending(key, true);
    runAction(`memory-${key}`, async () => {
      try {
        const result = target.kind === "curated"
          ? await controller.resetMemory("curated")
          : await controller.resetMemory("backend", target.backendId);
        onSuccess(t(
          target.kind === "curated"
            ? result.removedEntries === 1 ? "settings.memory.toast.makerResetOne" : "settings.memory.toast.makerResetOther"
            : result.removedEntries === 1 ? "settings.memory.toast.backendResetOne" : "settings.memory.toast.backendResetOther",
          target.kind === "curated"
            ? { count: result.removedEntries }
            : { backend: target.backendName, count: result.removedEntries }
        ));
      } finally {
        markPending(key, false);
      }
    });
  };
  const resetTitle = resetTarget?.kind === "backend"
    ? t("settings.memory.resetBackendTitle", { backend: resetTarget.backendName })
    : t("settings.memory.resetMakerTitle");
  const resetDescription = resetTarget?.kind === "backend"
    ? t("settings.memory.resetBackendDescription", { backend: resetTarget.backendName })
    : t("settings.memory.resetMakerDescription");

  return (
    <section className="memory-settings" aria-labelledby="memory-settings-title">
      <header className="memory-settings__heading">
        <div>
          <h2 id="memory-settings-title">{t("settings.memory.title")}</h2>
          <p>{t("settings.memory.description")}</p>
        </div>
        {settings.customized && <div className="personalization-default-controls memory-settings__defaults">
          <span>{t("settings.defaults.customized")}</span>
          <IconButton
            label={t("settings.defaults.restore")}
            disabled={pending.has("defaults")}
            onClick={restoreDefaults}
          ><RotateCcw aria-hidden="true" /></IconButton>
        </div>}
      </header>

      <div className="memory-settings__card">
        <div className="memory-settings__row">
          <span className="memory-settings__icon memory-settings__icon--maker" aria-hidden="true"><Sparkles /></span>
          <span className="memory-settings__copy">
            <strong>{t("settings.memory.makerLabel")}</strong>
            <span>{t("settings.memory.makerDescription")}</span>
            {!settings.makerSupported && <small role="status">{settings.makerReason || t("common.unavailable")}</small>}
          </span>
          <span className="memory-settings__actions">
            <SwitchControl
                checked={makerEnabled}
                disabled={!settings.makerSupported || pending.has("maker")}
                aria-label={t("settings.memory.makerToggleAria")}
                onChange={(event) => toggleMaker(event.target.checked)}
              />
            <IconButton
              className="memory-settings__reset"
              label={t("settings.memory.resetMakerTitle")}
              disabled={pending.has("reset:curated")}
              onClick={() => setResetTarget({ kind: "curated" })}
            ><RotateCcw aria-hidden="true" /></IconButton>
          </span>
        </div>

        {settings.backends.map((backend) => {
          const backendName = backendNames.get(backend.backendId) ?? backend.backendId;
          const disabled = !makerEnabled || !settings.makerSupported || !backend.supported;
          return <div className="memory-settings__row memory-settings__row--backend" data-disabled={disabled || undefined} key={backend.backendId}>
            <span className="memory-settings__icon memory-settings__icon--backend" aria-hidden="true"><PiMemoryMark /></span>
            <span className="memory-settings__copy">
              <strong>{t("settings.memory.backendLabel", { backend: backendName })}</strong>
              <span>{t("settings.memory.backendDescription", { backend: backendName })}</span>
              {!backend.supported && <small role="status">{backend.reason || t("common.unavailable")}</small>}
            </span>
            <span className="memory-settings__actions">
              <SwitchControl
                  checked={backendEnabled[backend.backendId] ?? backend.enabled}
                  disabled={disabled || pending.has(`backend:${backend.backendId}`)}
                  aria-label={t("settings.memory.backendToggleAria", { backend: backendName })}
                  onChange={(event) => toggleBackend(backend.backendId, backendName, event.target.checked)}
                />
              <IconButton
                className="memory-settings__reset"
                label={t("settings.memory.resetBackendTitle", { backend: backendName })}
                disabled={disabled || pending.has(`reset:${backend.backendId}`)}
                onClick={() => setResetTarget({ kind: "backend", backendId: backend.backendId, backendName })}
              ><RotateCcw aria-hidden="true" /></IconButton>
            </span>
          </div>;
        })}
      </div>
      {settings.backends.length === 0 && settings.makerSupported && <p className="memory-settings__empty">{t("settings.memory.noBackends")}</p>}
      <Modal
        open={resetTarget !== undefined}
        title={resetTitle}
        description={resetDescription}
        size="small"
        className="memory-settings__confirm"
        dialogRole="alertdialog"
        dismissOnBackdrop={false}
        onClose={() => setResetTarget(undefined)}
        headerLeading={<ModalBackButton label={t("common.back")} onClick={() => setResetTarget(undefined)} />}
      >
        <div className="memory-settings__confirm-actions modal__actions">
          <Button tone="primary" onClick={confirmReset}>{t("settings.memory.resetConfirm")}</Button>
        </div>
      </Modal>
    </section>
  );
}
