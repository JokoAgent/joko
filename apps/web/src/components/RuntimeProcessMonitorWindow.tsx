import { useState } from "react";
import type { JSX } from "react";
import { Activity, ServerOff } from "lucide-react";
import type { AppController } from "../controller.js";
import { RuntimeProcessMonitor } from "./RuntimeProcessMonitor.js";
import type { RunAction, Translator } from "./types.js";
import { ErrorBanner, Spinner } from "./ui.js";

export function RuntimeProcessMonitorWindow({ controller, t }: {
  readonly controller: AppController;
  readonly t: Translator;
}): JSX.Element {
  const { state } = controller;
  const [actionError, setActionError] = useState<string>();
  const runAction: RunAction = (_key, action) => {
    setActionError(undefined);
    void action().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : t("error.unexpected"));
    });
  };
  const snapshotAvailable = state.activeProfile !== undefined && state.snapshot.revision > 0n;
  const connectionUnavailable = state.ready &&
    (state.activeProfile === undefined || state.connectionState === "disconnected");

  return <main className="runtime-process-window">
    <header className="runtime-process-window__titlebar">
      <Activity aria-hidden="true" />
      <h1>{t("settings.processUsage.title")}</h1>
    </header>
    <div className="runtime-process-window__content">
      {actionError !== undefined && <ErrorBanner message={actionError} onClose={() => setActionError(undefined)} />}
      {!snapshotAvailable && (state.error !== undefined || connectionUnavailable)
        ? <div className="runtime-process-window__state" role="alert">
            <ServerOff aria-hidden="true" />
            <div><strong>{t("settings.processUsage.unavailableTitle")}</strong><p>{state.error ?? t("settings.processUsage.connectInMainWindow")}</p></div>
          </div>
        : !snapshotAvailable
          ? <div className="runtime-process-window__state" role="status">
              <Spinner label={t("settings.processUsage.loading")} />
              <span>{state.ready ? t("connection.connecting") : t("app.openingState")}</span>
            </div>
          : <RuntimeProcessMonitor controller={controller} snapshot={state.snapshot} runAction={runAction} t={t} standalone />}
    </div>
  </main>;
}
