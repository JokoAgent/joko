import { useEffect, useRef, useState } from "react";
import { GitPullRequest } from "lucide-react";
import type { SessionCodeHostReferenceSet } from "@joko/contracts";
import type { OperationApi } from "../model.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal } from "./ui.js";

export function SessionPullRequestAssociations({ sessionId, generation, read, write, t }: {
  readonly sessionId: string;
  readonly generation: bigint;
  readonly read: NonNullable<OperationApi["getSessionCodeHostReferences"]>;
  readonly write: NonNullable<OperationApi["setSessionCodeHostReferences"]>;
  readonly t: Translator;
}) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState<bigint>();
  const [active, setActive] = useState<readonly string[]>([]);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const [url, setUrl] = useState("");
  const [failure, setFailure] = useState(false);
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  const adopt = (value: SessionCodeHostReferenceSet): void => {
    if (value.revision === undefined) throw new Error("The association revision is unavailable.");
    setRevision(value.revision.value);
    setActive(value.active.map(reference => reference.webUrl));
    setRemoved(value.removed.map(reference => reference.webUrl));
    const pinnedKeys = new Set(value.pinnedReferenceKeys);
    setPinned(value.active.filter(reference => pinnedKeys.has(reference.referenceKey)).map(reference => reference.webUrl));
  };
  const load = (): void => {
    request.current?.abort();
    const controller = request.current = new AbortController();
    setOpen(true); setFailure(false); setRevision(undefined); setUrl("");
    void read(sessionId, controller.signal).then(value => {
      if (!controller.signal.aborted) adopt(value);
    }).catch(() => { if (!controller.signal.aborted) setFailure(true); });
  };
  const close = (): void => {
    if (saving) return;
    request.current?.abort();
    setOpen(false);
  };
  const save = (): void => {
    if (revision === undefined || saving || request.current?.signal.aborted !== false) return;
    const signal = request.current.signal;
    setSaving(true); setFailure(false);
    void write({ sessionId, expectedGeneration: BigInt(generation), expectedRevision: { value: revision },
      orderedUrls: [...pinned, ...active.filter(row => !pinned.includes(row))], removedUrls: [...removed], pinnedUrls: { urls: [...pinned] } }, signal).then(value => {
      if (signal.aborted) return;
      adopt(value); setOpen(false);
    }).catch(() => { if (!signal.aborted) setFailure(true); })
      .finally(() => { if (!signal.aborted) setSaving(false); });
  };
  const move = (rows: readonly string[], index: number, offset: -1 | 1, pinnedGroup: boolean) => {
    const moved = [...rows];
    [moved[index], moved[index + offset]] = [moved[index + offset]!, moved[index]!];
    if (pinnedGroup) setPinned(moved);
    else setActive([...pinned, ...moved]);
  };
  const add = (): void => {
    const value = url.trim();
    if (!value || active.includes(value) || active.length >= 16) return;
    setRemoved(rows => rows.filter(row => row !== value));
    setActive(rows => [...rows, value]); setUrl("");
  };
  const list = (rows: readonly string[], pinnedGroup: boolean) => <ol>{rows.map((row, index) => <li key={row}>
    <span className="code-host-association-url">{row}</span>
    <div className="modal__actions">
      <Button disabled={saving || index === 0} aria-label={t("codeHost.moveUp", { url: row })} onClick={() => move(rows, index, -1, pinnedGroup)}>↑</Button>
      <Button disabled={saving || index === rows.length - 1} aria-label={t("codeHost.moveDown", { url: row })} onClick={() => move(rows, index, 1, pinnedGroup)}>↓</Button>
      <Button disabled={saving || !pinnedGroup && pinned.length >= 3}
        title={!pinnedGroup && pinned.length >= 3 ? t("codeHost.pinLimit") : undefined}
        onClick={() => setPinned(current => pinnedGroup ? current.filter(value => value !== row) : [...current, row])}>
        {t(pinnedGroup ? "codeHost.unpin" : "codeHost.pin")}
      </Button>
      <Button disabled={saving || removed.length >= 16} onClick={() => {
        setActive(current => current.filter(value => value !== row));
        setPinned(current => current.filter(value => value !== row));
        setRemoved(current => [...current, row]);
      }}>{t("common.remove")}</Button>
    </div>
  </li>)}</ol>;
  return <>
    <IconButton label={t("codeHost.manage")} onClick={load}><GitPullRequest aria-hidden="true" /></IconButton>
    <Modal open={open} onClose={close} title={t("codeHost.manage")}>
      {failure && <p role="alert">{t("codeHost.associationsFailed")}</p>}
      {revision === undefined ? failure
        ? <Button onClick={load}>{t("common.retry")}</Button>
        : <p role="status">{t("common.loading")}</p>
        : <>
          <form onSubmit={event => { event.preventDefault(); add(); }}>
            <label className="field"><span>{t("codeHost.pullRequestUrl")}</span>
              <input type="url" value={url} maxLength={2048} disabled={saving} onChange={event => setUrl(event.target.value)} />
            </label>
            <Button type="submit" disabled={!url.trim() || active.length >= 16 || saving}>{t("common.add")}</Button>
          </form>
          {pinned.length > 0 && <><h3>{t("codeHost.pinnedAssociations")}</h3>{list(pinned, true)}</>}
          {list(active.filter(row => !pinned.includes(row)), false)}
          {removed.length > 0 && <><h3>{t("codeHost.removedAssociations")}</h3>
            <ul>{removed.map(row => <li key={row}><span className="code-host-association-url">{row}</span>
              <Button disabled={saving || active.length >= 16} onClick={() => {
                setRemoved(rows => rows.filter(value => value !== row)); setActive(rows => [...rows, row]);
              }}>{t("codeHost.restoreAssociation")}</Button>
            </li>)}</ul></>}
        </>}
      <div className="modal__actions">
        <Button disabled={saving} onClick={close}>{t("common.cancel")}</Button>
        {failure && revision !== undefined && <Button disabled={saving} onClick={load}>{t("common.refresh")}</Button>}
        <Button tone="primary" disabled={saving || revision === undefined} onClick={save}>{t("common.save")}</Button>
      </div>
    </Modal>
  </>;
}
