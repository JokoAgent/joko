import { useEffect, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { PortableSessionImportStatus, type PortableTaskCopyReceipt } from "@joko/contracts";
import type { SessionView } from "../model.js";
import { TaskCopyOutcomeUnknownError, type TaskCopyApi, type TaskCopyDestination, type TaskCopySelection } from "../task-copy-ui.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl } from "./ui.js";
import "./PortableSessionDialogs.css";

type Status = "ready" | "preparing" | "transferring" | "unknown" | "checking" | "retry" | "complete";

export function TaskCopyDialog({ api, session, t, onClose, openTask }: {
  readonly api: TaskCopyApi;
  readonly session: SessionView;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly openTask: (profileId: string, sessionId: string) => Promise<void>;
}): JSX.Element {
  const [profileId, setProfileId] = useState(api.machines[0]?.id ?? "");
  const [destination, setDestination] = useState<TaskCopyDestination>();
  const [backendId, setBackendId] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<Status>("ready");
  const [receipt, setReceipt] = useState<PortableTaskCopyReceipt>();
  const [opening, setOpening] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const attempt = useRef<{ readonly operationId: string; readonly selection: TaskCopySelection } | undefined>(undefined);
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!profileId) return;
    const pending = new AbortController();
    setError(undefined);
    setDestination(undefined);
    setParentId("");
    void apiRef.current.loadDestination(profileId, session, pending.signal).then((loaded) => {
      if (pending.signal.aborted) return;
      setDestination(loaded);
      setBackendId(loaded.backends.find(backend => backend.id === session.backendId)?.id ?? loaded.backends[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (!pending.signal.aborted) setError(copyError(cause, t));
    });
    return () => pending.abort();
  }, [profileId, session, t]);

  const busy = status === "preparing" || status === "transferring" || status === "checking";
  const uncertain = status === "unknown" || status === "retry";
  const close = () => { if (!busy && !opening) onClose(); };
  const run = async (checkOnly: boolean) => {
    if (request.current !== undefined) return;
    let original = attempt.current;
    if (original === undefined) {
      if (checkOnly || destination === undefined || !backendId) return;
      const parent = destination.parentProjects.find(project => project.id === parentId);
      original = { operationId: randomUuid(), selection: { profile: destination.profile, backendId, parent } };
      attempt.current = original;
    }
    const pending = new AbortController();
    request.current = pending;
    const current = () => request.current === pending && !pending.signal.aborted;
    const { operationId, selection } = original;
    setError(undefined);
    setStatus(checkOnly ? "checking" : "preparing");
    try {
      const result = checkOnly ? await api.receipt(selection, operationId, pending.signal)
        : await api.copy(selection, session, operationId, pending.signal, phase => { if (current()) setStatus(phase); });
      if (!current()) return;
      if (result === undefined) { setStatus("retry"); return; }
      setReceipt(result);
      setStatus("complete");
    } catch (cause) {
      if (!current()) return;
      if (checkOnly || cause instanceof TaskCopyOutcomeUnknownError) {
        setStatus("unknown");
      } else {
        attempt.current = undefined;
        setStatus("ready");
      }
      if (!(cause instanceof TaskCopyOutcomeUnknownError)) setError(copyError(cause, t));
    } finally {
      if (request.current === pending) request.current = undefined;
    }
  };
  const stop = () => {
    request.current?.abort();
    request.current = undefined;
    setStatus(status === "preparing" ? "ready" : "unknown");
    if (status === "preparing") attempt.current = undefined;
  };
  const open = async () => {
    const task = receipt?.task;
    const profile = attempt.current?.selection.profile;
    if (opening || task === undefined || profile === undefined) return;
    setOpening(true);
    setError(undefined);
    try { await openTask(profile.id, task.sessionId); onClose(); }
    catch (cause) { setError(copyError(cause, t)); }
    finally { setOpening(false); }
  };

  return <Modal open title={t("taskCopy.title")} description={t("taskCopy.description")} closeLabel={t("common.close")}
    size="small" className="portable-session-dialog portable-session-dialog--import" dismissOnBackdrop={!busy} onClose={close}>
    <div className="portable-session-form">
      <div className="portable-session-preview"><strong>{session.name}</strong></div>
      {status !== "complete" && <>
        <label className="portable-session-select">
          {t("taskCopy.machine")}
          <SelectControl aria-label={t("taskCopy.machine")} value={profileId} disabled={busy || uncertain}
            onChange={(event) => { attempt.current = undefined; setProfileId(event.target.value); }}>
            {api.machines.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </SelectControl>
        </label>
        {destination && destination.backends.length > 0 && <>
          <label className="portable-session-select">
            {t("taskCopy.backend")}
            <SelectControl aria-label={t("taskCopy.backend")} value={backendId} disabled={busy || uncertain}
              onChange={(event) => { attempt.current = undefined; setBackendId(event.target.value); }}>
              {destination.backends.map(backend => <option key={backend.id} value={backend.id}>{backend.name}</option>)}
            </SelectControl>
          </label>
          <label className="portable-session-select">
            {t("taskCopy.project")}
            <SelectControl aria-label={t("taskCopy.project")} value={parentId} disabled={busy || uncertain}
              onChange={(event) => { attempt.current = undefined; setParentId(event.target.value); }}>
              <option value="">{t("taskCopy.newDirectory")}</option>
              {destination.parentProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </SelectControl>
          </label>
        </>}
        {destination?.backends.length === 0 && <p role="status" className="portable-session-form__hint">{t("taskCopy.noBackend")}</p>}
        {!error && !destination && <p role="status" className="portable-session-form__hint">{t("taskCopy.readMachine")}</p>}
        {status !== "ready" && <p role="status" className="portable-session-form__hint">{t(`taskCopy.${status}`)}</p>}
      </>}
      {status === "complete" && receipt?.task && <>
        <div role="status" className="portable-session-done">
          <strong>{t("taskCopy.complete")}</strong>
          {receipt.task.status === PortableSessionImportStatus.IMPORTED_ACTIVATION_FAILED && <p>{t("portable.activationFailedBody", {
            reason: receipt.task.activationError?.message ?? t("portable.activationFailedTitle")
          })}</p>}
        </div>
        {receipt.skippedFileCount > 0n && <details className="portable-session-form__hint">
          <summary>{t("taskCopy.skipped", { count: receipt.skippedFileCount.toString() })}</summary>
          <ul>{receipt.skippedFiles.map(file => <li key={file.relativePath} className="task-copy-skipped-path">{file.relativePath} · {file.reason}</li>)}</ul>
        </details>}
      </>}
      {error && <p className="portable-session-form__error" role="alert">{error}</p>}
      <div className="modal__actions">
        {busy ? <Button onClick={stop}>{t("taskCopy.stop")}</Button>
          : <Button disabled={opening} onClick={close}>{t(status === "ready" ? "common.cancel" : "common.close")}</Button>}
        {uncertain && <Button tone={status === "unknown" ? "primary" : undefined} onClick={() => void run(true)}>{t("taskCopy.checkReceipt")}</Button>}
        {(status === "ready" || status === "retry") && <Button tone="primary" disabled={!destination || !backendId}
          onClick={() => void run(false)}>{t(status === "retry" ? "taskCopy.retryCopy" : "taskCopy.start")}</Button>}
        {status === "complete" && <Button tone="primary" disabled={opening} onClick={() => void open()}>{t("portable.openTask")}</Button>}
      </div>
    </div>
  </Modal>;
}

function copyError(cause: unknown, t: Translator): string {
  if (cause instanceof ConnectError) {
    if (cause.code === Code.Unimplemented) return t("taskCopy.unsupported");
    return cause.rawMessage;
  }
  return cause instanceof Error ? cause.message : t("error.unexpected");
}
