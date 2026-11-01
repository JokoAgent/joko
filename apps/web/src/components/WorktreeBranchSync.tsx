import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useRef, useState } from "react";
import type { OperationApi, WorktreeBranchStatusView, WorktreeBranchSyncOperationView } from "../model.js";
import type { Translator } from "./types.js";
import { randomUuid } from "../web-crypto.js";
import { Button, Spinner } from "./ui.js";

type Api = Pick<OperationApi, "getTargetWorktreeBranchStatus" | "syncTargetWorktreeBranch" | "getWorktreeBranchSyncOperation">;
interface Journal { readonly format: 1; readonly operationId: string; readonly expectedRevision: string }
const rejectedBeforeStart = new Set([Code.InvalidArgument, Code.FailedPrecondition, Code.Aborted, Code.ResourceExhausted, Code.PermissionDenied, Code.Unauthenticated, Code.NotFound, Code.Unimplemented]);

/** A separate action lane: opening a task and sending input never wait for it. */
export function WorktreeBranchSync({ api, ownerKey, targetId, sourceRef, disabled, t, onUpdated }: {
  readonly api: Api; readonly ownerKey: string; readonly targetId: string; readonly sourceRef: string;
  readonly disabled: boolean; readonly t: Translator; readonly onUpdated: (signal: AbortSignal) => Promise<void>;
}) {
  const apiRef = useRef(api), updatedRef = useRef(onUpdated); apiRef.current = api; updatedRef.current = onUpdated;
  const [status, setStatus] = useState<WorktreeBranchStatusView>(), [loading, setLoading] = useState(true);
  const [journal, setJournal] = useState<Journal>(), [receipt, setReceipt] = useState<WorktreeBranchSyncOperationView>();
  const [error, setError] = useState(false), [storageError, setStorageError] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined), flight = useRef(false);
  const readEpoch = useRef(0);
  const storageKey = "joko.worktree.branch-sync.v1:" + JSON.stringify([ownerKey, targetId, sourceRef]);
  const read = async (signal: AbortSignal) => {
    const epoch = ++readEpoch.current;
    setLoading(true);
    try { const value = await apiRef.current.getTargetWorktreeBranchStatus(targetId, sourceRef, signal);
      if (!signal.aborted && epoch === readEpoch.current) { setStatus(value); setError(false); }
    } catch { if (!signal.aborted && epoch === readEpoch.current) setError(true); }
    finally { if (!signal.aborted && epoch === readEpoch.current) setLoading(false); }
  };
  const clear = (value: Journal) => {
    // Do not remove a newer receipt written by another window.
    const stored = window.localStorage.getItem(storageKey);
    if (stored && (JSON.parse(stored) as Journal).operationId === value.operationId) window.localStorage.removeItem(storageKey);
    setJournal(undefined);
  };
  const adopt = async (value: WorktreeBranchSyncOperationView, original: Journal, signal: AbortSignal) => {
    if (signal.aborted) return;
    if (value.operationId !== original.operationId) throw new Error("Mismatched branch receipt");
    setReceipt(value);
    if (value.status) { readEpoch.current++; setLoading(false); setStatus(value.status); }
    if (!value.pending && !value.unknown) {
      try { clear(original); } catch { setStorageError(true); }
      if (value.updated) {
        try { await updatedRef.current(signal); } catch { if (!signal.aborted) setError(true); }
      }
      if (!signal.aborted) await read(signal);
    }
  };
  const observe = async (original: Journal, signal: AbortSignal) => {
    while (!signal.aborted) {
      const value = await apiRef.current.getWorktreeBranchSyncOperation(original.operationId, signal);
      await adopt(value, original, signal);
      if (!value.pending || signal.aborted) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 2_000); signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  };
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    setStatus(undefined); setReceipt(undefined); setJournal(undefined); setStorageError(false); setError(false); flight.current = false;
    void read(abort.signal);
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const value = JSON.parse(saved) as Journal;
        if (value.format !== 1 || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.operationId) || !/^[a-f0-9]{64}$/u.test(value.expectedRevision)) throw new Error("Invalid receipt");
        setJournal(value);
        void observe(value, abort.signal).catch(() => { if (!abort.signal.aborted) {
          setReceipt({ operationId: value.operationId, pending: false, unknown: true, updated: 0 }); setError(true);
        } });
      }
    } catch { setStorageError(true); }
    return () => abort.abort();
  }, [ownerKey, targetId, sourceRef]);
  const sync = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !status || status.blocked || journal || flight.current || disabled) return;
    const original: Journal = { format: 1, operationId: randomUuid(), expectedRevision: status.revision };
    try { window.localStorage.setItem(storageKey, JSON.stringify(original));
      if (window.localStorage.getItem(storageKey) !== JSON.stringify(original)) throw new Error("Receipt was not retained");
    } catch { setStorageError(true); return; }
    flight.current = true; setJournal(original); setReceipt(undefined); setError(false);
    let acknowledged = false;
    try {
      const value = await apiRef.current.syncTargetWorktreeBranch({ targetId, sourceRef, operationId: original.operationId, expectedRevision: original.expectedRevision }, signal);
      acknowledged = true;
      await adopt(value, original, signal);
      if (value.pending && !signal.aborted) await observe(original, signal);
    } catch (cause) {
      if (signal.aborted) return;
      if (!acknowledged && rejectedBeforeStart.has(ConnectError.from(cause).code)) {
        try { clear(original); } catch { setStorageError(true); }
        await read(signal);
      } else setReceipt({ operationId: original.operationId, pending: false, unknown: true, updated: 0 });
      setError(true);
    } finally { if (!signal.aborted) flight.current = false; }
  };
  const pending = journal !== undefined && receipt?.unknown !== true;
  return <div className="worktree-branch-sync" aria-busy={loading || pending}>
    <div className="worktree-branch-sync__actions">
      <Button disabled={disabled || loading || !status || !!status.blocked || !!journal || storageError} onClick={() => void sync()}>
        {pending && <Spinner />}{t(pending ? "worktree.branch.syncing" : "worktree.branch.sync")}
      </Button>
      <Button disabled={disabled || loading || pending} onClick={() => {
        const signal = lifetime.current?.signal; if (!signal || signal.aborted) return;
        void read(signal);
        if (journal) {
          setReceipt({ operationId: journal.operationId, pending: true, unknown: false, updated: 0 });
          void observe(journal, signal).catch(() => { if (!signal.aborted) {
          setReceipt({ operationId: journal.operationId, pending: false, unknown: true, updated: 0 }); setError(true);
          } });
        }
      }}>{t("worktree.branch.refresh")}</Button>
    </div>
    {status && <p className="muted" role="status">{t("worktree.branch.counts", { ahead: status.ahead, behind: status.behind, dirty: status.dirtyFiles })}</p>}
    {status?.blocked && <p className="inline-error" role="alert">{t(`worktree.branch.${status.blocked}`)}</p>}
    {receipt && !receipt.pending && !receipt.unknown && !receipt.status?.blocked && <p role="status">{t("worktree.branch.updated", { count: receipt.updated })}</p>}
    {(receipt?.unknown || journal && error) && <p role="alert">{t("worktree.branch.unknown")}</p>}
    {error && !journal && <p className="inline-error" role="alert">{t("worktree.branch.unavailable")}</p>}
    {storageError && <p className="inline-error" role="alert">{t("worktree.branch.receiptUnavailable")}</p>}
  </div>;
}
