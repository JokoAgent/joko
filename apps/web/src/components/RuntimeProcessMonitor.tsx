import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { ArrowDown, ArrowUp, Bot, ExternalLink, RefreshCcw, ServerOff } from "lucide-react";
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

export function sortRuntimeProcesses(
  processes: readonly RuntimeProcessUsageView[],
  sort: RuntimeProcessSort,
  nameOf: (process: RuntimeProcessUsageView) => string
): readonly RuntimeProcessUsageView[] {
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
  ownerAvailable = true
): RuntimeProcessDiagnosticsDisplay {
  if (!ownerAvailable) return { ownerKey, loaded: true, backends: [], sessions: [] };
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
      }))
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
  const localeRef = useRef(controller.state.preferences.locale);
  localeRef.current = controller.state.preferences.locale;
  const owner = runtimeProcessDiagnosticsOwner(controller.state);
  const ownerKey = runtimeProcessDiagnosticsOwnerKey(owner);
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const catalogKey = runtimeProcessCatalogKey(snapshot);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [display, setDisplay] = useState<RuntimeProcessDiagnosticsDisplay>(() =>
    loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshot, owner !== undefined));

  useEffect(() => {
    const abort = new AbortController();
    let inFlight: Promise<void> | undefined;
    const refresh = (): Promise<void> => {
      if (inFlight !== undefined) return inFlight;
      const currentController = controllerRef.current;
      const currentSnapshot = snapshotRef.current;
      inFlight = collectRuntimeProcessDiagnostics(
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
      }).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    refreshRef.current = refresh;
    setDisplay(loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshotRef.current, owner !== undefined));
    if (owner !== undefined) void refresh().catch(() => undefined);
    const timer = owner === undefined ? undefined : window.setInterval(() => { void refresh().catch(() => undefined); }, POLL_INTERVAL_MS);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      if (refreshRef.current === refresh) refreshRef.current = async () => undefined;
    };
  }, [catalogKey, ownerKey]);

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
    : loadingRuntimeProcessDiagnosticsDisplay(ownerKey, snapshot, owner !== undefined);
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
    const session = sessionByKey.get(`${process.backendId}\u0000${process.sessionId}`)?.sessionName ?? process.sessionId;
    return `${backend} ${session}`;
  }, [backendById, sessionByKey]);
  const selected = processes.find((process) => displayProcessKey(process, backendById) === selectedKey);

  useEffect(() => {
    if (selectedKey !== undefined && selected === undefined) setSelectedKey(undefined);
  }, [selected, selectedKey]);

  const canTerminate = selected !== undefined && processCanTerminate(selected, backendById, sessionByKey);
  const actionHint = selected === undefined
    ? t("settings.processUsage.selectHint")
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

  if (display.loaded && display.backends.length === 0) {
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
          {!display.loaded && display.backends.length === 0
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
                            : sorted.map((process) => <RuntimeProcessRow
                                backendName={backend.backendName}
                                process={process}
                                selected={displayProcessKey(process, backendById) === selectedKey}
                                sessionName={sessionByKey.get(`${process.backendId}\u0000${process.sessionId}`)?.sessionName ?? process.sessionId}
                                t={t}
                                key={displayProcessKey(process, backendById)}
                                onSelect={() => setSelectedKey(displayProcessKey(process, backendById))}
                              />)}
                        </>}
                </div>;
              })}
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

function RuntimeProcessRow({ backendName, process, selected, sessionName, t, onSelect }: {
  readonly backendName: string;
  readonly process: RuntimeProcessUsageView;
  readonly selected: boolean;
  readonly sessionName: string;
  readonly t: Translator;
  readonly onSelect: () => void;
}): JSX.Element {
  const details = process.processCount > 1
    ? `${sessionName} · ${t("settings.processUsage.processCount", { count: process.processCount })}`
    : sessionName;
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
      <Bot className="runtime-process-icon" aria-hidden="true" />
      <div className="runtime-process-name-copy">
        <div className="runtime-process-name" title={backendName}>{backendName}</div>
        <div className="runtime-process-details"><span>{details}</span><span className="runtime-process-pid-inline"> · PID {process.pid}</span></div>
      </div>
    </div>
    <div role="cell" className="runtime-process-number">{formatRuntimeProcessCpu(process.cpuPercent)}</div>
    <div role="cell" className="runtime-process-number">{formatRuntimeProcessMemory(process.memoryKb)}</div>
    <div role="cell" className="runtime-process-number runtime-process-pid">{process.pid}</div>
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
  return `${process.backendId}:${process.sessionId}:${process.generation}:${process.pid}:${process.processInstanceId ?? "read-only"}`;
}

function displayProcessKey(
  process: RuntimeProcessUsageView,
  backendById: ReadonlyMap<string, RuntimeProcessBackendDisplay>
): string {
  return `${backendById.get(process.backendId)?.backendGeneration ?? "unavailable"}:${processKey(process)}`;
}
