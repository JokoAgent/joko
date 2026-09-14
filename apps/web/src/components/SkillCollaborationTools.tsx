import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { AlertTriangle, Building2, Pencil, Plus, RefreshCcw, Trash2, Users } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  CollaborationDirectoryView,
  CollaborationScopeKindView,
  CollaborationScopeView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, EmptyState, IconButton, Modal, Pill, SelectControl } from "./ui.js";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: CollaborationDirectoryView };

export function SkillCollaborationTools({ controller, t }: {
  readonly controller: AppController;
  readonly t: Translator;
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [kind, setKind] = useState<CollaborationScopeKindView>("team");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<CollaborationScopeView>();
  const [editName, setEditName] = useState("");
  const [removing, setRemoving] = useState<CollaborationScopeView>();
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string>();
  const request = useRef(0);
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    const current = ++request.current;
    const abort = new AbortController();
    setState({ kind: "loading" });
    void controller.getCollaborationDirectory(abort.signal).then((value) => {
      if (!abort.signal.aborted && current === request.current) setState({ kind: "ready", value });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && current === request.current) setState({ kind: "error", message: errorMessage(cause, t) });
    });
    return () => abort.abort();
  }, [controller, reload, t]);

  const directory = state.kind === "ready" ? state.value : undefined;
  const validName = (value: string): boolean => value === value.trim() && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
  const mutate = (action: (signal: AbortSignal) => Promise<void>, success: () => void): void => {
    if (busy) return;
    const active = ++generation.current;
    const abort = new AbortController();
    setBusy(true);
    setMutationError(undefined);
    void action(abort.signal).then(() => {
      if (active !== generation.current) return;
      success();
      setReload((value) => value + 1);
    }).catch((cause: unknown) => {
      if (active === generation.current) setMutationError(errorMessage(cause, t));
    }).finally(() => {
      if (active === generation.current) setBusy(false);
    });
  };
  const createScope = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (directory === undefined || !directory.available || !validName(name)) return;
    mutate(
      (signal) => controller.createCollaborationScope(kind, name, directory.revision, signal),
      () => setName("")
    );
  };
  const saveEdit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (editing === undefined || !validName(editName)) return;
    mutate(
      (signal) => controller.updateCollaborationScope(editing, editName, signal),
      () => { setEditing(undefined); setEditName(""); }
    );
  };

  return <section className="skill-collaboration" aria-label={t("skills.collaboration.title")} aria-busy={busy}>
    <header className="skill-market-page-header">
      <div><p className="eyebrow">{t("skills.collaboration.eyebrow")}</p><h2>{t("skills.collaboration.title")}</h2><p>{t("skills.collaboration.body")}</p></div>
      <IconButton label={t("common.refresh")} disabled={busy} onClick={() => setReload((value) => value + 1)}><RefreshCcw aria-hidden="true" /></IconButton>
    </header>
    {state.kind === "loading" && <p className="skill-collaboration__notice" role="status">{t("skills.collaboration.loading")}</p>}
    {state.kind === "error" && <p className="skill-collaboration__notice is-error" role="alert"><AlertTriangle aria-hidden="true" />{state.message}</p>}
    {directory !== undefined && !directory.available && <p className="skill-collaboration__notice is-error" role="alert"><AlertTriangle aria-hidden="true" />{directory.unavailableReason ?? t("skills.collaboration.unavailable")}</p>}
    {directory?.recoveredFromCorruption && <p className="skill-collaboration__notice is-error" role="alert"><AlertTriangle aria-hidden="true" />{t("skills.collaboration.corrupt")}</p>}
    {directory?.available && <>
      <section className="skill-collaboration__identity"><Users aria-hidden="true" /><div><span>{t("skills.collaboration.identity")}</span><strong>{directory.actor!.displayName}</strong><small>{t("skills.collaboration.identityBody")}</small></div><Pill tone="success">{t("skills.collaboration.available")}</Pill></section>
      <form className="skill-collaboration__create" onSubmit={createScope}>
        <label><span>{t("skills.collaboration.kind")}</span><SelectControl value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as CollaborationScopeKindView)}><option value="team">{t("skills.collaboration.kind.team")}</option><option value="department">{t("skills.collaboration.kind.department")}</option></SelectControl></label>
        <label><span>{t("skills.collaboration.name")}</span><input value={name} maxLength={128} disabled={busy} placeholder={t(`skills.collaboration.placeholder.${kind}`)} onChange={(event) => setName(event.target.value)} /></label>
        <Button type="submit" tone="primary" disabled={busy || !validName(name)}><Plus aria-hidden="true" />{t("skills.collaboration.create")}</Button>
      </form>
      {mutationError !== undefined && <p className="skill-collaboration__notice is-error" role="alert"><AlertTriangle aria-hidden="true" />{mutationError}</p>}
      {directory.scopes.length === 0 ? <EmptyState icon={<Users />} title={t("skills.collaboration.empty")} body={t("skills.collaboration.emptyBody")} /> : <div className="skill-collaboration__list">{directory.scopes.map((scope) => <article key={scope.id}>
        <span className="skill-collaboration__icon">{scope.kind === "team" ? <Users aria-hidden="true" /> : <Building2 aria-hidden="true" />}</span>
        <div><span><strong>{scope.name}</strong><Pill>{t(`skills.collaboration.kind.${scope.kind}`)}</Pill></span><small>{t("skills.collaboration.members", { count: scope.members.length })}</small><small>{t("skills.collaboration.localRole", { role: t(`skills.collaboration.role.${scope.members.find((member) => member.actorId === directory.actor!.id)?.role ?? "viewer"}`) })}</small></div>
        <div><IconButton label={t("skills.collaboration.rename", { name: scope.name })} disabled={busy} onClick={() => { setEditing(scope); setEditName(scope.name); }}><Pencil aria-hidden="true" /></IconButton><IconButton label={t("skills.collaboration.remove", { name: scope.name })} disabled={busy} onClick={() => setRemoving(scope)}><Trash2 aria-hidden="true" /></IconButton></div>
      </article>)}</div>}
    </>}
    <Modal open={editing !== undefined} title={t("skills.collaboration.renameTitle")} size="small" dismissOnBackdrop={!busy} onClose={() => { if (!busy) setEditing(undefined); }}><form className="skill-collaboration__rename" onSubmit={saveEdit}><label><span>{t("skills.collaboration.name")}</span><input autoFocus value={editName} maxLength={128} disabled={busy} onChange={(event) => setEditName(event.target.value)} /></label><div className="modal__actions"><Button type="button" disabled={busy} onClick={() => setEditing(undefined)}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={busy || !validName(editName)}>{t("common.save")}</Button></div></form></Modal>
    <Modal open={removing !== undefined} title={t("skills.collaboration.removeTitle")} description={removing === undefined ? undefined : t("skills.collaboration.removeBody", { name: removing.name })} dialogRole="alertdialog" size="small" dismissOnBackdrop={!busy} onClose={() => { if (!busy) setRemoving(undefined); }}><div className="modal__actions"><Button disabled={busy} onClick={() => setRemoving(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={busy || removing === undefined} onClick={() => { const value = removing; if (value !== undefined) mutate((signal) => controller.deleteCollaborationScope(value, signal), () => setRemoving(undefined)); }}>{t("common.remove")}</Button></div></Modal>
  </section>;
}

function errorMessage(cause: unknown, t: Translator): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : t("skills.collaboration.requestError");
}
