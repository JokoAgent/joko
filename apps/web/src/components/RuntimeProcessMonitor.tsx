import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { ArrowDown, ArrowUp, Bot, ExternalLink, ServerOff } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, RuntimeProcessUsageView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, ErrorBanner, Modal, ModalBackButton, Spinner } from "./ui.js";
import { isRuntimeProcessMonitorWindow } from "../runtime-process-monitor-window.js";

export type RuntimeProcessSortKey = "name" | "cpu" | "memory" | "pid";
export type RuntimeProcessSortDirection = "asc" | "desc";
export interface RuntimeProcessSort {
  readonly key: RuntimeProcessSortKey;
  readonly direction: RuntimeProcessSortDirection;
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

export function RuntimeProcessMonitor({ controller, snapshot, runAction, t, standalone = false }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly runAction: RunAction;
  readonly t: Translator;
  readonly standalone?: boolean;
}): JSX.Element {
  const capableBackendIds = useMemo(
    () => snapshot.backends
      .filter((backend) => backend.capabilities.get("runtime.process_usage")?.supported === true)
      .map((backend) => backend.id)
      .sort(),
    [snapshot.backends]
  );
  const capableBackendKey = JSON.stringify(capableBackendIds);
  const capableBackendIdsRef = useRef(capableBackendIds);
  capableBackendIdsRef.current = capableBackendIds;
  const inFlight = useRef(false);
  const [processes, setProcesses] = useState<readonly RuntimeProcessUsageView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<RuntimeProcessSort>(DEFAULT_SORT);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [pendingTermination, setPendingTermination] = useState<RuntimeProcessUsageView>();
  const [terminating, setTerminating] = useState(false);
  const [openingWindow, setOpeningWindow] = useState(false);
  const desktopMonitor = !standalone && !isRuntimeProcessMonitorWindow() &&
    window.jokoDesktop?.capabilities.includes("runtime.processMonitorWindow") === true
    ? window.jokoDesktop.runtimeProcessMonitor
    : undefined;

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (inFlight.current || signal?.aborted) return;
    inFlight.current = true;
    try {
      const ids = capableBackendIdsRef.current;
      if (ids.length === 0) {
        if (!signal?.aborted) {
          setProcesses([]);
          setLoaded(true);
          setError(undefined);
        }
        return;
      }
      const results = await Promise.allSettled(ids.map((backendId) => controller.listRuntimeProcesses(backendId, signal)));
      if (signal?.aborted) return;
      const next = results.flatMap((result) => result.status === "fulfilled" ? result.value.processes : []);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      setProcesses(next);
      setLoaded(true);
      setError(failure === undefined
        ? undefined
        : failure.reason instanceof Error
          ? failure.reason.message
          : t("settings.processUsage.loadFailed"));
    } finally {
      inFlight.current = false;
    }
  }, [capableBackendKey, controller, t]);

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    const timer = window.setInterval(() => { void refresh(abort.signal); }, POLL_INTERVAL_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [capableBackendKey, refresh]);

  const backendById = useMemo(
    () => new Map(snapshot.backends.map((backend) => [backend.id, backend] as const)),
    [snapshot.backends]
  );
  const sessionById = useMemo(
    () => new Map(snapshot.sessions.map((session) => [session.id, session] as const)),
    [snapshot.sessions]
  );
  const processName = useCallback((process: RuntimeProcessUsageView): string => {
    const backend = backendById.get(process.backendId)?.name ?? process.backendId;
    const session = sessionById.get(process.sessionId)?.name ?? process.sessionId;
    return `${backend} ${session}`;
  }, [backendById, sessionById]);
  const sorted = useMemo(
    () => sortRuntimeProcesses(processes, sort, processName),
    [processName, processes, sort]
  );
  const selected = processes.find((process) => processKey(process) === selectedKey);

  useEffect(() => {
    if (selectedKey !== undefined && selected === undefined) setSelectedKey(undefined);
  }, [selected, selectedKey]);

  const canTerminate = selected !== undefined
    && selected.terminable
    && selected.processInstanceId !== undefined
    && backendById.get(selected.backendId)?.capabilities.get("runtime.process_terminate")?.supported === true;
  const actionHint = selected === undefined
    ? t("settings.processUsage.selectHint")
    : canTerminate
      ? `${processName(selected)} · PID ${selected.pid}`
      : t("settings.processUsage.readOnlyHint");
  const confirmName = pendingTermination === undefined ? "" : processName(pendingTermination);

  const confirmTermination = (): void => {
    const target = pendingTermination;
    if (target === undefined || terminating) return;
    setTerminating(true);
    runAction(`terminate-runtime:${processKey(target)}`, async () => {
      try {
        await controller.terminateRuntimeProcess(target);
        await refresh();
      } finally {
        setTerminating(false);
        setPendingTermination(undefined);
      }
    });
  };

  const openStandaloneWindow = (): void => {
    if (desktopMonitor === undefined || openingWindow) return;
    setOpeningWindow(true);
    runAction("open-runtime-process-monitor", async () => {
      try {
        await desktopMonitor.open();
      } finally {
        setOpeningWindow(false);
      }
    });
  };

  if (capableBackendIds.length === 0) {
    return <section className="runtime-process-section" aria-labelledby="runtime-process-heading">
      <div className="settings-toolbar settings-action-toolbar settings-action-toolbar--separated">
        <h3 className="settings-subheading" id="runtime-process-heading">{t("settings.processUsage.title")}</h3>
        {desktopMonitor !== undefined && <Button tone="ghost" disabled={openingWindow} onClick={openStandaloneWindow}>
          <ExternalLink aria-hidden="true" />{t("settings.processUsage.openWindow")}
        </Button>}
      </div>
      <div className="runtime-process-unavailable">
        <ServerOff aria-hidden="true" />
        <div><p>{t("settings.processUsage.unavailable")}</p></div>
      </div>
    </section>;
  }

  return <section className="runtime-process-section" aria-labelledby="runtime-process-heading">
    <div className="settings-toolbar settings-action-toolbar settings-action-toolbar--separated">
      <h3 className="settings-subheading" id="runtime-process-heading">{t("settings.processUsage.title")}</h3>
      {desktopMonitor !== undefined && <Button tone="ghost" disabled={openingWindow} onClick={openStandaloneWindow}>
        <ExternalLink aria-hidden="true" />{t("settings.processUsage.openWindow")}
      </Button>}
    </div>
    {error !== undefined && <ErrorBanner message={error} onRetry={() => { void refresh(); }} />}
    <div className="runtime-process-root settings-card">
      <div className="runtime-process-table" role="table" aria-label={t("settings.processUsage.tableLabel")}>
        <div role="row" className="runtime-process-grid runtime-process-header">
          <SortHeader column="name" label={t("settings.processUsage.process")} sort={sort} onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="cpu" label={t("settings.processUsage.cpu")} sort={sort} className="runtime-process-header-number" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="memory" label={t("settings.processUsage.memory")} sort={sort} className="runtime-process-header-number" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
          <SortHeader column="pid" label={t("settings.processUsage.pid")} sort={sort} className="runtime-process-header-number runtime-process-pid" onSort={(key) => setSort((current) => nextRuntimeProcessSort(current, key))} t={t} />
        </div>
        <div role="rowgroup" className="runtime-process-body">
          {!loaded ? <div className="runtime-process-state"><Spinner label={t("settings.processUsage.loading")} /><span>{t("settings.processUsage.loading")}</span></div> : <>
            <div className="runtime-process-group">{t("settings.processUsage.agents")}</div>
            {sorted.length === 0
              ? <div className="runtime-process-state">{t("settings.processUsage.empty")}</div>
              : sorted.map((process) => {
                  const backendName = backendById.get(process.backendId)?.name ?? process.backendId;
                  const sessionName = sessionById.get(process.sessionId)?.name ?? process.sessionId;
                  const selectedRow = processKey(process) === selectedKey;
                  const details = process.processCount > 1
                    ? `${sessionName} · ${t("settings.processUsage.processCount", { count: process.processCount })}`
                    : sessionName;
                  return <div
                    role="row"
                    tabIndex={0}
                    aria-selected={selectedRow}
                    className="runtime-process-grid runtime-process-row"
                    data-selected={selectedRow ? "true" : "false"}
                    key={processKey(process)}
                    onClick={() => setSelectedKey(processKey(process))}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedKey(processKey(process));
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
                })}
          </>}
        </div>
      </div>
      <div className="runtime-process-footer">
        <div className="runtime-process-hint" title={actionHint}>{actionHint}</div>
        <Button disabled={!canTerminate} onClick={() => { if (canTerminate) setPendingTermination(selected); }}>{t("settings.processUsage.terminate")}</Button>
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

function processKey(process: RuntimeProcessUsageView): string {
  return `${process.backendId}:${process.sessionId}:${process.generation}:${process.pid}:${process.processInstanceId ?? "read-only"}`;
}
