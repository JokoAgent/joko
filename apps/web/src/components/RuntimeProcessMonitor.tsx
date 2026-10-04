import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AppWindow, ArrowDown, ArrowUp, Bot, Cog, Cpu, ExternalLink, PanelsTopLeft, RefreshCcw, ServerOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, RuntimeProcessUsageView } from "../model.js";
import {
  collectRuntimeProcessDiagnostics,
  runtimeProcessBackendGeneration,
  runtimeProcessDiagnosticsErrorMessage,
  runtimeProcessDiagnosticsOwner,
  runtimeProcessDiagnosticsOwnerKey,
  sameRuntimeProcessDiagnosticsOwner,
  terminateRuntimeProcessWithCurrentFence,
  type RuntimeProcessDiagnosticsBackendSnapshot,
  type RuntimeProcessDiagnosticsSessionSnapshot,
  type RuntimeProcessDiagnosticsSnapshot
} from "../runtime-process-diagnostics.js";
import { isRuntimeProcessMonitorWindow } from "../runtime-process-monitor-window.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Modal, ModalBackButton, Spinner } from "./ui.js";

export type RuntimeProcessSortKey = "name" | "cpu" | "memory" | "pid";
export type RuntimeProcessSortDirection = "asc" | "desc";
export interface RuntimeProcessSort {
  readonly key: RuntimeProcessSortKey;
  readonly direction: RuntimeProcessSortDirection;
}

export interface RuntimeProcessBackendDisplay extends Omit<RuntimeProcessDiagnosticsBackendSnapshot, "state"> {
  readonly state: "loading" | "ready" | "empty" | "unsupported" | "error" | "stale";
}

export interface RuntimeProcessDiagnosticsDisplay {
  readonly ownerKey: string;
  readonly loaded: boolean;
  readonly backends: readonly RuntimeProcessBackendDisplay[];
  readonly sessions: readonly RuntimeProcessDiagnosticsSessionSnapshot[];
  readonly desktop?: RuntimeProcessDesktopDisplay;
}

export interface RuntimeProcessDesktopDisplay {
  readonly state: "loading" | "ready" | "empty" | "error" | "stale";
  readonly capturedAt?: number;
  readonly error?: string;
  readonly processes: readonly DesktopRuntimeProcessMetric[];
}

interface PendingRuntimeProcessTermination {
  readonly process: RuntimeProcessUsageView;
  readonly backendGeneration: string;
}

const DEFAULT_SORT: RuntimeProcessSort = { key: "cpu", direction: "desc" };
const POLL_INTERVAL_MS = 2_000;

export function formatRuntimeProcessCpu(cpuPercent: number): string {
  return `${cpuPercent >= 10 ? Math.round(cpuPercent) : cpuPercent.toFixed(1)}%`;
}

export function formatRuntimeProcessMemory(memoryKb: number): string {
  if (memoryKb >= 1024 * 1024) return `${(memoryKb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryKb / 1024)} MB`;
}

export function nextRuntimeProcessSort(
  current: RuntimeProcessSort,
  key: RuntimeProcessSortKey
): RuntimeProcessSort {
  return {
    key,
    direction: current.key === key
      ? current.direction === "asc" ? "desc" : "asc"
      : key === "name" ? "asc" : "desc"
  };
}

export function sortRuntimeProcesses<T extends Pick<RuntimeProcessUsageView, "pid" | "cpuPercent" | "memoryKb">>(
  processes: readonly T[],
  sort: RuntimeProcessSort,
  nameOf: (process: T) => string
): readonly T[] {
  return [...processes].sort((left, right) => {
    let compared = 0;
    if (sort.key === "name") compared = nameOf(left).localeCompare(nameOf(right));
    if (sort.key === "cpu") compared = left.cpuPercent - right.cpuPercent;
    if (sort.key === "memory") compared = left.memoryKb - right.memoryKb;
    if (sort.key === "pid") compared = left.pid - right.pid;
    if (compared === 0) compared = left.pid - right.pid;
    return sort.direction === "asc" ? compared : -compared;
  });
}

export function loadingRuntimeProcessDiagnosticsDisplay(
  ownerKey: string,
  snapshot: AppSnapshot,
  ownerAvailable = true,
  desktopSupported = false
): RuntimeProcessDiagnosticsDisplay {
  if (!ownerAvailable) return {
    ownerKey,
    loaded: !desktopSupported,
    backends: [],
    sessions: [],
    ...(desktopSupported ? { desktop: { state: "loading" as const, processes: [] } } : {})
  };
  const backends = [...snapshot.backends]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((backend): RuntimeProcessBackendDisplay => {
      const usageSupported = backend.capabilities.get("runtime.process_usage")?.supported === true;
      return {
        backendId: backend.id,
        backendGeneration: runtimeProcessBackendGeneration(backend.instanceGeneration) ?? "unavailable",
        backendName: backend.name,
        usageSupported,
        terminateSupported: usageSupported && backend.capabilities.get("runtime.process_terminate")?.supported === true,
        state: usageSupported ? "loading" : "unsupported",
        processes: []
      };
    });
  const ids = new Set(backends.filter((backend) => backend.usageSupported).map((backend) => backend.backendId));
  return {
    ownerKey,
    loaded: backends.every((backend) => backend.state === "unsupported"),
    backends,
    sessions: snapshot.sessions
      .filter((session) => ids.has(session.backendId))
      .map((session) => ({
        sessionId: session.id,
        backendId: session.backendId,
        sessionName: session.name,
        generation: session.generation.toString()
      })),
    ...(desktopSupported ? { desktop: { state: "loading" as const, processes: [] } } : {})
  };
}

export function mergeRuntimeProcessDiagnosticsDisplay(
  previous: RuntimeProcessDiagnosticsDisplay,
  ownerKey: string,
  next: RuntimeProcessDiagnosticsSnapshot
): RuntimeProcessDiagnosticsDisplay {
  const previousByBackend = previous.ownerKey === ownerKey
    ? new Map(previous.backends.map((backend) => [`${backend.backendId}\u0000${backend.backendGeneration}`, backend] as const))
    : new Map<string, RuntimeProcessBackendDisplay>();
  return {
    ownerKey,
    loaded: true,
    sessions: next.sessions,
    ...(previous.ownerKey === ownerKey && previous.desktop !== undefined ? { desktop: previous.desktop } : {}),
    backends: next.backends.map((backend): RuntimeProcessBackendDisplay => {
      if (!backend.usageSupported) return { ...backend, state: "unsupported" };
      if (backend.state === "ready") return { ...backend, state: backend.processes.length === 0 ? "empty" : "ready" };
      const prior = previousByBackend.get(`${backend.backendId}\u0000${backend.backendGeneration}`);
      if (
        prior !== undefined
        && (prior.state === "ready" || prior.state === "empty" || prior.state === "stale")
        && prior.capturedAt !== undefined
      ) {
        return {
          ...backend,
          state: "stale",
          capturedAt: prior.capturedAt,
          processes: prior.processes
        };
      }
      return { ...backend, state: "error" };
    })
  };
}

export function mergeDesktopRuntimeProcessDisplay(
  current: RuntimeProcessDiagnosticsDisplay,
  ownerKey: string,
  sample: DesktopRuntimeProcessSample
): RuntimeProcessDiagnosticsDisplay {
  if (current.ownerKey !== ownerKey) return current;
  return {
    ...current,
    loaded: current.loaded || current.backends.length === 0,
    desktop: {
      state: sample.processes.length === 0 ? "empty" : "ready",
      capturedAt: sample.capturedAt,
      processes: sample.processes
    }
  };
}

export function staleDesktopRuntimeProcessDisplay(
  current: RuntimeProcessDiagnosticsDisplay,
  ownerKey: string,
  error: string
): RuntimeProcessDiagnosticsDisplay {
  if (current.ownerKey !== ownerKey) return current;
  const previous = current.desktop;
  return {
    ...current,
    loaded: current.loaded || current.backends.length === 0,
    desktop: previous !== undefined && previous.capturedAt !== undefined &&
      (previous.state === "ready" || previous.state === "empty" || previous.state === "stale")
      ? { ...previous, state: "stale", error }
      : { state: "error", error, processes: [] }
  };
}

export function staleRuntimeProcessDiagnosticsDisplay(
  current: RuntimeProcessDiagnosticsDisplay,
  ownerKey: string,
  error: string
): RuntimeProcessDiagnosticsDisplay {
  if (current.ownerKey !== ownerKey) return current;
  return {
    ...current,
    loaded: true,
    backends: current.backends.map((backend) => {
      if (backend.state === "unsupported") return backend;
      if ((backend.state === "ready" || backend.state === "empty" || backend.state === "stale")
        && backend.capturedAt !== undefined) {
        return { ...backend, state: "stale", error };
      }
      return { ...backend, state: "error", error, processes: [] };
    })
  };
}

export function RuntimeProcessMonitor({ controller, snapshot, runAction, t, standalone = false }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
  readonly standalone?: boolean;
}): JSX.Element {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const localeRef = useRef(controller.state.effectiveLocale);
  localeRef.current = controller.state.effectiveLocale;
  const owner = runtimeProcessDiagnosticsOwner(controller.state);
  const ownerKey = runtimeProcessDiagnosticsOwnerKey(owner);
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const catalogKey = runtimeProcessCatalogKey(snapshot);
  const desktopApi = window.jokoDesktop?.runtimeProcessMonitor;
  const desktopSupported = window.jokoDesktop?.capabilities.includes("runtime.desktopProcessUsage") === true &&
    typeof desktopApi?.sampleDesktop === "function";
  const [samplingActive, setSamplingActive] = useState(() => document.visibilityState !== "hidden");
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [display, setDisplay] = useState<RuntimeProcessDiagnosticsDisplay>(() =>
    loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshot, owner !== undefined, desktopSupported));

  useEffect(() => {
    const update = (): void => setSamplingActive(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let inFlight: Promise<void> | undefined;
    const refresh = (): Promise<void> => {
      if (inFlight !== undefined) return inFlight;
      const currentController = controllerRef.current;
      const currentSnapshot = snapshotRef.current;
      const backendRefresh = owner === undefined
        ? Promise.resolve()
        : collectRuntimeProcessDiagnostics(
            currentController,
            currentSnapshot,
            localeRef.current,
            abort.signal
          ).then((result) => {
            if (abort.signal.aborted || ownerKeyRef.current !== ownerKey) return;
            setDisplay((current) => mergeRuntimeProcessDiagnosticsDisplay(current, ownerKey, result));
          }).catch((error: unknown) => {
            if (abort.signal.aborted || ownerKeyRef.current !== ownerKey) return;
            const message = runtimeProcessDiagnosticsErrorMessage(error);
            setDisplay((current) => staleRuntimeProcessDiagnosticsDisplay(current, ownerKey, message));
          });
      const desktopRefresh = !desktopSupported || desktopApi === undefined
        ? Promise.resolve()
        : desktopApi.sampleDesktop().then((sample) => {
            if (abort.signal.aborted || ownerKeyRef.current !== ownerKey) return;
            setDisplay((current) => mergeDesktopRuntimeProcessDisplay(current, ownerKey, sample));
          }).catch((error: unknown) => {
            if (abort.signal.aborted || ownerKeyRef.current !== ownerKey) return;
            setDisplay((current) => staleDesktopRuntimeProcessDisplay(
              current,
              ownerKey,
              runtimeProcessDiagnosticsErrorMessage(error)
            ));
          });
      inFlight = Promise.all([backendRefresh, desktopRefresh]).then(() => undefined).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    refreshRef.current = refresh;
    setDisplay(loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshotRef.current, owner !== undefined, desktopSupported));
    if (samplingActive && (owner !== undefined || desktopSupported)) void refresh().catch(() => undefined);
    const timer = !samplingActive || (owner === undefined && !desktopSupported)
      ? undefined
      : window.setInterval(() => { void refresh().catch(() => undefined); }, POLL_INTERVAL_MS);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      if (refreshRef.current === refresh) refreshRef.current = async () => undefined;
    };
  }, [catalogKey, desktopApi, desktopSupported, ownerKey, samplingActive]);

  const desktopMonitor = !standalone && !isRuntimeProcessMonitorWindow()
    && owner !== undefined
    && window.jokoDesktop?.capabilities.includes("runtime.processMonitorWindow") === true
    ? window.jokoDesktop.runtimeProcessMonitor
    : undefined;
  const [openingWindow, setOpeningWindow] = useState(false);
  const openStandaloneWindow = desktopMonitor === undefined || owner === undefined
    ? undefined
    : (): void => {
        if (openingWindow) return;
        setOpeningWindow(true);
        runAction("open-runtime-process-monitor", async () => {
          try {
            await desktopMonitor.open(owner);
          } finally {
            setOpeningWindow(false);
          }
        });
      };

  const terminate = useCallback(async (process: RuntimeProcessUsageView, backendGeneration: string): Promise<void> => {
    const expectedOwner = runtimeProcessDiagnosticsOwner(controllerRef.current.state);
    if (expectedOwner === undefined || runtimeProcessDiagnosticsOwnerKey(expectedOwner) !== ownerKeyRef.current) {
      throw new Error("The runtime process monitor owner is no longer current.");
    }
    const abort = new AbortController();
    await terminateRuntimeProcessWithCurrentFence(
      controllerRef.current,
      snapshotRef.current,
      process,
      backendGeneration,
      abort.signal,
      () => sameRuntimeProcessDiagnosticsOwner(
        runtimeProcessDiagnosticsOwner(controllerRef.current.state),
        expectedOwner
      ) && runtimeProcessBackendGeneration(
        snapshotRef.current.backends.find((backend) => backend.id === process.backendId)?.instanceGeneration
      ) === backendGeneration
    );
    await refreshRef.current();
  }, []);

  const activeDisplay = display.ownerKey === ownerKey
    ? display
    : loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshot, owner !== undefined, desktopSupported);
  return <RuntimeProcessMonitorSurface
    display={activeDisplay}
    runAction={runAction}
    t={t}
    openingWindow={openingWindow}
    onOpenWindow={openStandaloneWindow}
    onRefresh={() => refreshRef.current()}
    onTerminate={terminate}
  />;
}

export function RuntimeProcessMonitorSurface({ display, runAction, t, openingWindow = false, onOpenWindow, onRefresh, onTerminate }: {
  readonly display: RuntimeProcessDiagnosticsDisplay;
  readonly runAction: RunAction;
  readonly t: Translator;
  readonly openingWindow?: boolean;
  readonly onOpenWindow?: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onTerminate: (process: RuntimeProcessUsageView, backendGeneration: string) => Promise<void>;
}): JSX.Element {
  const [sort, setSort] = useState<RuntimeProcessSort>(DEFAULT_SORT);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [pendingTermination, setPendingTermination] = useState<PendingRuntimeProcessTermination>();
  const [terminating, setTerminating] = useState(false);
  const displayRef = useRef(display);
  displayRef.current = display;
  const backendAuthorityKey = display.backends
    .map((backend) => `${backend.backendId}\u0000${backend.backendGeneration}`)
    .join("\u0001");

  useEffect(() => {
    setSelectedKey(undefined);
    setPendingTermination(undefined);
    setTerminating(false);
  }, [backendAuthorityKey, display.ownerKey]);

  const backendById = useMemo(
    () => new Map(display.backends.map((backend) => [backend.backendId, backend] as const)),
    [display.backends]
  );
  const sessionByKey = useMemo(
    () => new Map(display.sessions.map((session) => [`${session.backendId}\u0000${session.sessionId}`, session] as const)),
    [display.sessions]
  );
  const processes = useMemo(() => display.backends.flatMap((backend) => backend.processes), [display.backends]);
  const processName = useCallback((process: RuntimeProcessUsageView): string => {
    const backend = backendById.get(process.backendId)?.backendName ?? process.backendId;
    if (process.role === "control-plane") return `${backend} ${t("settings.processUsage.controlPlane")}`;
    const session = sessionByKey.get(`${process.backendId}\u0000${process.sessionId}`)?.sessionName ?? process.sessionId;
    return `${backend} ${session}`;
  }, [backendById, sessionByKey, t]);
  const selected = processes.find((process) => displayProcessKey(process, backendById) === selectedKey);
  const selectedDesktop = display.desktop?.processes.find((process) => desktopProcessKey(process) === selectedKey);

  useEffect(() => {
    if (selectedKey !== undefined && selected === undefined && selectedDesktop === undefined) setSelectedKey(undefined);
  }, [selected, selectedDesktop, selectedKey]);

  const canTerminate = selected !== undefined && processCanTerminate(selected, backendById, sessionByKey);
  const actionHint = selected === undefined
    ? selectedDesktop === undefined
      ? t("settings.processUsage.selectHint")
      : t("settings.processUsage.readOnlyHint")
    : canTerminate
      ? `${processName(selected)} · PID ${selected.pid}`
      : t("settings.processUsage.readOnlyHint");
  const confirmName = pendingTermination === undefined ? "" : processName(pendingTermination.process);

  const confirmTermination = (): void => {
    const target = pendingTermination;
    const expectedOwnerKey = display.ownerKey;
    if (target === undefined || terminating) return;
    setTerminating(true);
    runAction(`terminate-runtime:${target.backendGeneration}:${processKey(target.process)}`, async () => {
      try {
        if (displayRef.current.ownerKey !== expectedOwnerKey) {
          throw new Error("The runtime process monitor owner changed before termination.");
        }
        const currentGeneration = displayRef.current.backends
          .find((backend) => backend.backendId === target.process.backendId)?.backendGeneration;
        if (currentGeneration !== target.backendGeneration) throw new Error("The runtime process Backend is no longer current.");
        await onTerminate(target.process, target.backendGeneration);
      } finally {
        setTerminating(false);
        setPendingTermination(undefined);
      }
    });
  };

  if (display.loaded && display.backends.length === 0 && display.desktop === undefined) {
    return <section className="runtime-process-section" aria-labelledby="runtime-process-heading">
      <RuntimeProcessToolbar t={t} openingWindow={openingWindow} onOpenWindow={onOpenWindow} />
      <div className="runtime-process-unavailable" role="status">
        <ServerOff aria-hidden="true" />
        <div><p>{t("settings.processUsage.unavailable")}</p></div>
      </div>
    </section>;
  }

  return <section className="runtime-process-section" aria-labelledby="runtime-process-heading">
    <RuntimeProcessToolbar t={t} openingWindow={openingWindow} onOpenWindow={onOpenWindow} />
    <div className="runtime-process-root settings-card">
      <div className="runtime-process-table" role="table" aria-label={t("settings.processUsage.tableLabel")}>
        <div role="row" className="runtime-process-grid runtime-process-header">
          <SortHeader column="name" label={t("settings.processUsage.process")} sort={sort} onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="cpu" label={t("settings.processUsage.cpu")} sort={sort} className="runtime-process-header-number" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="memory" label={t("settings.processUsage.memory")} sort={sort} className="runtime-process-header-number" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="pid" label={t("settings.processUsage.pid")} sort={sort} className="runtime-process-header-number runtime-process-pid" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
        </div>
        <div role="rowgroup" className="runtime-process-body" aria-live="polite">
          {!display.loaded && display.backends.length === 0 && display.desktop === undefined
            ? <div className="runtime-process-state"><Spinner label={t("settings.processUsage.loading")} /><span>{t("settings.processUsage.loading")}</span></div>
            : display.backends.map((backend) => {
                const sorted = sortRuntimeProcesses(backend.processes, sort, processName);
                return <div className="runtime-process-backend" data-state={backend.state} key={`${backend.backendId}:${backend.backendGeneration}`}>
                  <div className="runtime-process-group">
                    <span>{backend.backendName}</span>
                    <BackendFreshness backend={backend} t={t} onRefresh={onRefresh} />
                  </div>
                  {backend.state === "loading"
                    ? <div className="runtime-process-state"><Spinner label={t("settings.processUsage.loading")} /><span>{t("settings.processUsage.loading")}</span></div>
                    : backend.state === "unsupported"
                      ? <div className="runtime-process-state">{t("settings.processUsage.unavailable")}</div>
                    : backend.state === "error"
                      ? <div className="runtime-process-state runtime-process-state--error" role="alert">
                          <span>{backend.error ?? t("settings.processUsage.loadFailed")}</span>
                          <Button tone="ghost" onClick={() => { void onRefresh(); }}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>
                        </div>
                      : <>
                          {backend.state === "stale" && <div className="runtime-process-state runtime-process-state--error" role="status">{backend.error ?? t("settings.processUsage.loadFailed")}</div>}
                          {backend.state === "empty" || sorted.length === 0
                            ? <div className="runtime-process-state">{t("settings.processUsage.empty")}</div>
                            : sorted.map((process) => {
                                const scope = process.role === "control-plane"
                                  ? t("settings.processUsage.controlPlane")
                                  : `${t("settings.processUsage.taskHost")} · ${sessionByKey.get(`${process.backendId}\u0000${process.sessionId}`)?.sessionName ?? process.sessionId}`;
                                const details = process.processCount > 1
                                  ? `${scope} · ${t("settings.processUsage.processCount", { count: process.processCount })}`
                                  : scope;
                                return <RuntimeProcessRow
                                  Icon={process.role === "control-plane" ? Cog : Bot}
                                  metric={process}
                                  name={backend.backendName}
                                  details={details}
                                  selected={displayProcessKey(process, backendById) === selectedKey}
                                  key={displayProcessKey(process, backendById)}
                                  onSelect={() => setSelectedKey(displayProcessKey(process, backendById))}
                                />;
                              })}
                        </>}
                </div>;
              })}
          {display.desktop !== undefined && <DesktopRuntimeProcessGroup
            desktop={display.desktop}
            selectedKey={selectedKey}
            sort={sort}
            t={t}
            onRefresh={onRefresh}
            onSelect={setSelectedKey}
          />}
        </div>
      </div>
      <div className="runtime-process-footer">
        <div className="runtime-process-hint" title={actionHint}>{actionHint}</div>
        <Button disabled={!canTerminate} onClick={() => {
          const backendGeneration = selected === undefined ? undefined : backendById.get(selected.backendId)?.backendGeneration;
          if (canTerminate && selected !== undefined && backendGeneration !== undefined) {
            setPendingTermination({ process: selected, backendGeneration });
          }
        }}>{t("settings.processUsage.terminate")}</Button>
      </div>
    </div>
    <Modal
      open={pendingTermination !== undefined}
      title={t("settings.processUsage.confirmTitle", { name: confirmName })}
      description={t("settings.processUsage.confirmBody")}
      size="small"
      dialogRole="alertdialog"
      dismissOnBackdrop={false}
      onClose={() => { if (!terminating) setPendingTermination(undefined); }}
      headerLeading={<ModalBackButton label={t("common.back")} disabled={terminating} onClick={() => setPendingTermination(undefined)} />}
    >
      <div className="modal__actions">
        <Button tone="danger" disabled={terminating} onClick={confirmTermination}>{terminating ? t("settings.processUsage.terminating") : t("settings.processUsage.terminate")}</Button>
      </div>
    </Modal>
  </section>;
}

function RuntimeProcessToolbar({ t, openingWindow, onOpenWindow }: {
  readonly t: Translator;
  readonly openingWindow: boolean;
  readonly onOpenWindow?: () => void;
}): JSX.Element {
  return <div className="settings-toolbar settings-action-toolbar settings-action-toolbar--separated">
    <h3 className="settings-subheading" id="runtime-process-heading">{t("settings.processUsage.title")}</h3>
    {onOpenWindow !== undefined && <Button tone="ghost" data-runtime-process-monitor-open disabled={openingWindow} onClick={onOpenWindow}>
      <ExternalLink aria-hidden="true" />{t("settings.processUsage.openWindow")}
    </Button>}
  </div>;
}

function BackendFreshness({ backend, t, onRefresh }: {
  readonly backend: RuntimeProcessBackendDisplay;
  readonly t: Translator;
  readonly onRefresh: () => Promise<void>;
}): JSX.Element | null {
  if (backend.state === "loading") return <span>{t("settings.processUsage.loading")}</span>;
  if (backend.state === "error" || backend.state === "unsupported") return null;
  if (backend.capturedAt === undefined) return null;
  const time = new Date(backend.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <span className="runtime-process-freshness" data-stale={backend.state === "stale" ? "true" : "false"}>
    {backend.state === "stale"
      ? t("settings.processUsage.staleAt", { time })
      : t("settings.processUsage.updatedAt", { time })}
    {backend.state === "stale" && <button type="button" onClick={() => { void onRefresh(); }} aria-label={t("common.retry")}><RefreshCcw aria-hidden="true" /></button>}
  </span>;
}

function DesktopRuntimeProcessGroup({ desktop, selectedKey, sort, t, onRefresh, onSelect }: {
  readonly desktop: RuntimeProcessDesktopDisplay;
  readonly selectedKey?: string;
  readonly sort: RuntimeProcessSort;
  readonly t: Translator;
  readonly onRefresh: () => Promise<void>;
  readonly onSelect: (key: string) => void;
}): JSX.Element {
  const sorted = sortRuntimeProcesses(desktop.processes, sort, (process) => desktopProcessName(process, t));
  return <div className="runtime-process-backend" data-state={desktop.state} data-process-source="desktop">
    <div className="runtime-process-group">
      <span>{t("settings.processUsage.application")}</span>
      <ProcessFreshness source={desktop} t={t} onRefresh={onRefresh} />
    </div>
    {desktop.state === "loading"
      ? <div className="runtime-process-state"><Spinner label={t("settings.processUsage.loading")} /><span>{t("settings.processUsage.loading")}</span></div>
      : desktop.state === "error"
        ? <div className="runtime-process-state runtime-process-state--error" role="alert">
            <span>{desktop.error ?? t("settings.processUsage.loadFailed")}</span>
            <Button tone="ghost" onClick={() => { void onRefresh(); }}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>
          </div>
        : <>
            {desktop.state === "stale" && <div className="runtime-process-state runtime-process-state--error" role="status">
              {desktop.error ?? t("settings.processUsage.loadFailed")}
            </div>}
            {desktop.state === "empty" || sorted.length === 0
              ? <div className="runtime-process-state">{t("settings.processUsage.applicationEmpty")}</div>
              : sorted.map((process) => <RuntimeProcessRow
                  Icon={desktopProcessIcon(process.role)}
                  metric={process}
                  name={desktopProcessName(process, t)}
                  details={desktopProcessDetails(process, t)}
                  selected={desktopProcessKey(process) === selectedKey}
                  key={desktopProcessKey(process)}
                  onSelect={() => onSelect(desktopProcessKey(process))}
                />)}
          </>}
  </div>;
}

function ProcessFreshness({ source, t, onRefresh }: {
  readonly source: Pick<RuntimeProcessDesktopDisplay, "state" | "capturedAt">;
  readonly t: Translator;
  readonly onRefresh: () => Promise<void>;
}): JSX.Element | null {
  if (source.state === "loading") return <span>{t("settings.processUsage.loading")}</span>;
  if (source.state === "error" || source.capturedAt === undefined) return null;
  const time = new Date(source.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <span className="runtime-process-freshness" data-stale={source.state === "stale" ? "true" : "false"}>
    {source.state === "stale"
      ? t("settings.processUsage.staleAt", { time })
      : t("settings.processUsage.updatedAt", { time })}
    {source.state === "stale" && <button type="button" onClick={() => { void onRefresh(); }} aria-label={t("common.retry")}><RefreshCcw aria-hidden="true" /></button>}
  </span>;
}

function RuntimeProcessRow({ Icon = Bot, metric, name, details, selected, onSelect }: {
  readonly Icon?: LucideIcon;
  readonly metric: Pick<RuntimeProcessUsageView, "pid" | "cpuPercent" | "memoryKb">;
  readonly name: string;
  readonly details: string | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return <div
    role="row"
    tabIndex={0}
    aria-selected={selected}
    className="runtime-process-grid runtime-process-row"
    data-selected={selected ? "true" : "false"}
    onClick={onSelect}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect();
    }}
  >
    <div role="cell" className="runtime-process-name-cell">
      <Icon className="runtime-process-icon" aria-hidden="true" />
      <div className="runtime-process-name-copy">
        <div className="runtime-process-name" title={name}>{name}</div>
        <div className="runtime-process-details">
          {details === null ? <span>PID {metric.pid}</span> : <><span>{details}</span><span className="runtime-process-pid-inline"> · PID {metric.pid}</span></>}
        </div>
      </div>
    </div>
    <div role="cell" className="runtime-process-number">{formatRuntimeProcessCpu(metric.cpuPercent)}</div>
    <div role="cell" className="runtime-process-number">{formatRuntimeProcessMemory(metric.memoryKb)}</div>
    <div role="cell" className="runtime-process-number runtime-process-pid">{metric.pid}</div>
  </div>;
}

function SortHeader({ column, label, sort, className, onSort, t }: {
  readonly column: RuntimeProcessSortKey;
  readonly label: string;
  readonly sort: RuntimeProcessSort;
  readonly className?: string;
  readonly onSort: (key: RuntimeProcessSortKey) => void;
  readonly t: Translator;
}): JSX.Element {
  const active = sort.key === column;
  const SortIcon = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return <div role="columnheader" aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className={className}>
    <button type="button" className="runtime-process-sort" aria-label={t("settings.processUsage.sortBy", { column: label })} onClick={() => onSort(column)}>
      <span>{label}</span>{active && <SortIcon aria-hidden="true" />}
    </button>
  </div>;
}

function processCanTerminate(
  process: RuntimeProcessUsageView,
  backendById: ReadonlyMap<string, RuntimeProcessBackendDisplay>,
  sessionByKey: ReadonlyMap<string, RuntimeProcessDiagnosticsSessionSnapshot>
): boolean {
  if (process.role !== "task-host") return false;
  const session = sessionByKey.get(`${process.backendId}\u0000${process.sessionId}`);
  return process.terminable
    && process.processInstanceId !== undefined
    && backendById.get(process.backendId)?.terminateSupported === true
    && session?.generation === String(process.generation);
}

function runtimeProcessCatalogKey(snapshot: AppSnapshot): string {
  return JSON.stringify(snapshot.backends.map((backend) => [
    backend.id,
    backend.instanceGeneration,
    backend.name,
    backend.capabilities.get("runtime.process_usage")?.supported === true,
    backend.capabilities.get("runtime.process_terminate")?.supported === true
  ]));
}

function processKey(process: RuntimeProcessUsageView): string {
  return process.role === "control-plane"
    ? `${process.backendId}:control-plane:${process.pid}:read-only`
    : `${process.backendId}:task-host:${process.sessionId}:${process.generation}:${process.pid}:${process.processInstanceId ?? "read-only"}`;
}

function displayProcessKey(
  process: RuntimeProcessUsageView,
  backendById: ReadonlyMap<string, RuntimeProcessBackendDisplay>
): string {
  return `backend:${backendById.get(process.backendId)?.backendGeneration ?? "unavailable"}:${processKey(process)}`;
}

function desktopProcessKey(process: DesktopRuntimeProcessMetric): string {
  return `desktop:${process.role}:${process.pid}`;
}

function desktopProcessIcon(role: DesktopRuntimeProcessRole): LucideIcon {
  if (role === "main") return AppWindow;
  if (role === "renderer") return PanelsTopLeft;
  if (role === "gpu") return Cpu;
  return Cog;
}

function desktopProcessName(process: DesktopRuntimeProcessMetric, t: Translator): string {
  if (process.role === "renderer" && process.label !== null) return process.label;
  if (process.role === "utility" && process.label !== null) {
    if (process.label === "audio.mojom.AudioService") return t("settings.processUsage.services.audio");
    if (process.label === "network.mojom.NetworkService") return t("settings.processUsage.services.network");
    if (process.label === "storage.mojom.StorageService") return t("settings.processUsage.services.storage");
    if (process.label === "video_capture.mojom.VideoCaptureService") return t("settings.processUsage.services.videoCapture");
    return process.label;
  }
  if (process.role === "main") return t("settings.processUsage.roles.main");
  if (process.role === "renderer") return t("settings.processUsage.roles.renderer");
  if (process.role === "gpu") return t("settings.processUsage.roles.gpu");
  return t("settings.processUsage.roles.utility");
}

function desktopProcessDetails(process: DesktopRuntimeProcessMetric, t: Translator): string | null {
  if (process.label === null) return null;
  if (process.role === "renderer") return t("settings.processUsage.roles.renderer");
  if (process.role === "utility") return t("settings.processUsage.roles.utility");
  return null;
}
