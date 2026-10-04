import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Activity, ServerOff } from "lucide-react";
import { translate } from "../i18n.js";
import type { Locale, RuntimeProcessUsageView } from "../model.js";
import { readHostSystemLocale } from "../system-locale.js";
import {
  runtimeProcessDiagnosticsOwnerKey,
  sameRuntimeProcessDiagnosticsOwner,
  type RuntimeProcessDiagnosticsOwner,
  type RuntimeProcessDiagnosticsSnapshot
} from "../runtime-process-diagnostics.js";
import { randomUuid } from "../web-crypto.js";
import { DesktopWindowControls } from "./DesktopWindowControls.js";
import {
  mergeRuntimeProcessDiagnosticsDisplay,
  mergeDesktopRuntimeProcessDisplay,
  RuntimeProcessMonitorSurface,
  staleDesktopRuntimeProcessDisplay,
  staleRuntimeProcessDiagnosticsDisplay,
  type RuntimeProcessDiagnosticsDisplay
} from "./RuntimeProcessMonitor.js";
import type { RunAction } from "./types.js";
import { ErrorBanner, Spinner } from "./ui.js";

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  readonly owner: DesktopRuntimeProcessMonitorOwner;
  readonly resolve: (result: DesktopRuntimeProcessMonitorResponse["result"]) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: number;
}

export function RuntimeProcessMonitorWindow(): JSX.Element {
  const api = window.jokoRuntimeProcessDiagnostics;
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const t = useCallback(
    (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(locale, key, values),
    [locale]
  );
  const [owner, setOwner] = useState<RuntimeProcessDiagnosticsOwner>();
  const ownerRef = useRef<RuntimeProcessDiagnosticsOwner | undefined>(undefined);
  ownerRef.current = owner;
  const ownerKey = runtimeProcessDiagnosticsOwnerKey(owner);
  const [display, setDisplay] = useState<RuntimeProcessDiagnosticsDisplay>(() => emptyDisplay("unavailable", false, api !== undefined));
  const [bridgeError, setBridgeError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [samplingActive, setSamplingActive] = useState(() => document.visibilityState !== "hidden");
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const rejectPending = useCallback((message: string, matchingOwner?: DesktopRuntimeProcessMonitorOwner): void => {
    for (const [requestId, pending] of pendingRef.current) {
      if (matchingOwner !== undefined && !sameRuntimeProcessDiagnosticsOwner(pending.owner, matchingOwner)) continue;
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      pendingRef.current.delete(requestId);
    }
  }, []);

  useEffect(() => {
    const update = (): void => setSamplingActive(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (api === undefined) {
      setBridgeError(translate(localeRef.current, "settings.processUsage.connectInMainWindow"));
      setDisplay(emptyDisplay("unavailable", true, false));
      return;
    }
    let disposed = false;
    const unsubscribeResponse = api.onResponse((response) => {
      const pending = pendingRef.current.get(response.requestId);
      if (pending === undefined || !sameRuntimeProcessDiagnosticsOwner(pending.owner, response.owner)) return;
      window.clearTimeout(pending.timeout);
      pendingRef.current.delete(response.requestId);
      pending.resolve(response.result);
    });
    const unsubscribeRetired = api.onRetired(() => {
      rejectPending("The runtime process monitor owner was retired.");
      ownerRef.current = undefined;
      setOwner(undefined);
      setDisplay(emptyDisplay("unavailable", true, true));
      setBridgeError(translate(localeRef.current, "settings.processUsage.connectInMainWindow"));
    });
    void api.getOwner().then((initialOwner) => {
      if (disposed) return;
      ownerRef.current = initialOwner;
      setOwner(initialOwner);
      setDisplay(emptyDisplay(runtimeProcessDiagnosticsOwnerKey(initialOwner), false, true));
      setBridgeError(undefined);
    }).catch((error: unknown) => {
      if (disposed) return;
      setDisplay(emptyDisplay("unavailable", true, true));
      setBridgeError(errorMessage(error, translate(localeRef.current, "settings.processUsage.connectInMainWindow")));
    });
    return () => {
      disposed = true;
      ownerRef.current = undefined;
      unsubscribeResponse();
      unsubscribeRetired();
      rejectPending("The runtime process monitor window was closed.");
    };
  }, [api, rejectPending]);

  const request = useCallback(async (
    expectedOwner: RuntimeProcessDiagnosticsOwner,
    action: DesktopRuntimeProcessMonitorRequest["action"]
  ): Promise<DesktopRuntimeProcessMonitorResponse["result"]> => {
    if (api === undefined || !sameRuntimeProcessDiagnosticsOwner(ownerRef.current, expectedOwner)) {
      throw new Error("The runtime process monitor owner is no longer current.");
    }
    const requestId = randomUuid().toLowerCase();
    const result = new Promise<DesktopRuntimeProcessMonitorResponse["result"]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(new Error("The runtime process monitor request timed out."));
      }, REQUEST_TIMEOUT_MS);
      pendingRef.current.set(requestId, { owner: expectedOwner, resolve, reject, timeout });
    });
    try {
      await api.request({ version: 1, requestId, owner: expectedOwner, action });
    } catch (error: unknown) {
      const pending = pendingRef.current.get(requestId);
      if (pending !== undefined) {
        window.clearTimeout(pending.timeout);
        pendingRef.current.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error("The runtime process monitor request failed."));
      }
    }
    return result;
  }, [api]);

  useEffect(() => {
    if (owner === undefined || api === undefined || !samplingActive) return;
    let disposed = false;
    let inFlight: Promise<void> | undefined;
    const refresh = (): Promise<void> => {
      if (inFlight !== undefined) return inFlight;
      const backendRefresh = request(owner, { kind: "refresh" }).then((result) => {
        if (disposed || !sameRuntimeProcessDiagnosticsOwner(ownerRef.current, owner)) return;
        if (result.kind === "error") throw new Error(result.message);
        if (result.kind !== "snapshot") throw new Error("The runtime process monitor returned an invalid refresh response.");
        const snapshot = fromWireSnapshot(result);
        setLocale(snapshot.locale);
        setDisplay((current) => mergeRuntimeProcessDiagnosticsDisplay(current, ownerKey, snapshot));
        setBridgeError(undefined);
      }).catch((error: unknown) => {
        if (!disposed && sameRuntimeProcessDiagnosticsOwner(ownerRef.current, owner)) {
          const message = errorMessage(error, translate(localeRef.current, "settings.processUsage.loadFailed"));
          setDisplay((current) => staleRuntimeProcessDiagnosticsDisplay(current, ownerKey, message));
          setBridgeError(message);
        }
      });
      const desktopRefresh = api.sampleDesktop().then((sample) => {
        if (disposed || !sameRuntimeProcessDiagnosticsOwner(ownerRef.current, owner)) return;
        setDisplay((current) => mergeDesktopRuntimeProcessDisplay(current, ownerKey, sample));
      }).catch((error: unknown) => {
        if (!disposed && sameRuntimeProcessDiagnosticsOwner(ownerRef.current, owner)) {
          setDisplay((current) => staleDesktopRuntimeProcessDisplay(
            current,
            ownerKey,
            errorMessage(error, translate(localeRef.current, "settings.processUsage.loadFailed"))
          ));
        }
      });
      inFlight = Promise.all([backendRefresh, desktopRefresh]).then(() => undefined).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    refreshRef.current = refresh;
    setDisplay(emptyDisplay(ownerKey, false, true));
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (refreshRef.current === refresh) refreshRef.current = async () => undefined;
    };
  }, [ownerKey, request, samplingActive]);

  const terminate = useCallback(async (process: RuntimeProcessUsageView, backendGeneration: string): Promise<void> => {
    const expectedOwner = ownerRef.current;
    if (expectedOwner === undefined) throw new Error("The runtime process monitor owner is no longer current.");
    const result = await request(expectedOwner, { kind: "terminate", backendGeneration, process });
    if (result.kind === "error") throw new Error(result.message);
    if (result.kind !== "terminated") throw new Error("The runtime process monitor returned an invalid termination response.");
    await refreshRef.current();
  }, [request]);

  const runAction: RunAction = useCallback((_key, action) => {
    setActionError(undefined);
    void action().catch((error: unknown) => {
      setActionError(errorMessage(error, t("error.unexpected")));
    });
  }, [t]);
  const activeDisplay = useMemo(
    () => display.ownerKey === ownerKey ? display : emptyDisplay(ownerKey, owner === undefined, api !== undefined),
    [display, owner, ownerKey]
  );

  return <>
    <main className="runtime-process-window">
      <header className="runtime-process-window__titlebar">
        <Activity aria-hidden="true" />
        <h1>{t("settings.processUsage.title")}</h1>
      </header>
      <div className="runtime-process-window__content">
        {actionError !== undefined && <ErrorBanner message={actionError} onClose={() => setActionError(undefined)} />}
        {bridgeError !== undefined && owner === undefined
          ? <div className="runtime-process-window__state" role="alert">
              <ServerOff aria-hidden="true" />
              <div><strong>{t("settings.processUsage.unavailableTitle")}</strong><p>{bridgeError}</p></div>
            </div>
          : owner === undefined
            ? <div className="runtime-process-window__state" role="status">
                <Spinner label={t("settings.processUsage.loading")} />
                <span>{t("app.openingState")}</span>
              </div>
            : <>
                {bridgeError !== undefined && <ErrorBanner message={bridgeError} onRetry={() => { void refreshRef.current(); }} />}
                <RuntimeProcessMonitorSurface
                  display={activeDisplay}
                  runAction={runAction}
                  t={t}
                  onRefresh={() => refreshRef.current()}
                  onTerminate={terminate}
                />
              </>}
      </div>
    </main>
    <DesktopWindowControls t={t} />
  </>;
}

function fromWireSnapshot(snapshot: DesktopRuntimeProcessMonitorSnapshot): RuntimeProcessDiagnosticsSnapshot {
  return {
    locale: snapshot.locale,
    backends: snapshot.backends.map((backend) => backend.state === "ready"
      ? { ...backend, processes: [...backend.processes] }
      : { ...backend, processes: [] }),
    sessions: [...snapshot.sessions]
  };
}

function emptyDisplay(ownerKey: string, loaded: boolean, desktopSupported: boolean): RuntimeProcessDiagnosticsDisplay {
  return {
    ownerKey,
    loaded,
    backends: [],
    sessions: [],
    ...(desktopSupported ? { desktop: { state: "loading", processes: [] } } : {})
  };
}

function initialLocale(): Locale {
  return readHostSystemLocale(typeof window === "undefined" ? undefined : window);
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const normalized = error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized === "" ? fallback : normalized.slice(0, 512);
}
