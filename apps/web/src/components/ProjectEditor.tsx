import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, TargetDraft, TargetView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, Modal, SelectControl } from "./ui.js";

export function ProjectEditor({ open, target, initialDirectory, controller, snapshot, t, saving = false, error, onClose, onSave }: {
  readonly open: boolean;
  readonly target?: TargetView;
  readonly initialDirectory?: string;
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
  readonly saving?: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSave: (draft: TargetDraft) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<TargetDraft>(() => emptyTargetDraft(snapshot));
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string>();
  const pickerGenerationRef = useRef(0);
  const currentRef = useRef({ open, controller });
  currentRef.current = { open, controller };
  const pickerOwner = localProjectPickerOwner(controller);
  useEffect(() => {
    pickerGenerationRef.current += 1;
    setPicking(false);
    setPickerError(undefined);
    if (!open) return;
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === target?.workspaceId);
    setDraft(target === undefined ? {
      ...emptyTargetDraft(snapshot),
      ...(initialDirectory === undefined ? {} : {
        serverPath: initialDirectory,
        name: projectNameFromDirectory(initialDirectory)
      })
    } : {
      backendId: target.backendId, name: target.name, workspaceKind: workspace?.kind ?? "userProject",
      serverPath: workspace?.serverPath ?? "", createIfMissing: false
    });
  }, [open, target?.id, initialDirectory]);
  useEffect(() => () => { pickerGenerationRef.current += 1; }, []);
  const pickDirectory = async (): Promise<void> => {
    const owner = pickerOwner;
    const picker = window.jokoDesktop?.projects?.pickDirectory;
    if (owner === undefined || picker === undefined || picking || saving) return;
    const generation = ++pickerGenerationRef.current;
    setPicking(true);
    setPickerError(undefined);
    try {
      const result = await picker(owner);
      const current = currentRef.current;
      if (pickerGenerationRef.current !== generation || !current.open
        || !sameProjectPickerOwner(localProjectPickerOwner(current.controller), owner)) return;
      if (!result.cancelled) setDraft((value) => ({ ...value, serverPath: result.path,
        name: value.name.trim() === "" ? projectNameFromDirectory(result.path) : value.name }));
    } catch (cause) {
      const current = currentRef.current;
      if (pickerGenerationRef.current === generation && current.open
        && sameProjectPickerOwner(localProjectPickerOwner(current.controller), owner)) {
        setPickerError(cause instanceof Error ? cause.message : t("error.unexpected"));
      }
    } finally {
      if (pickerGenerationRef.current === generation) setPicking(false);
    }
  };
  const editing = target !== undefined;
  const valid = draft.name.trim().length > 0 && draft.backendId.length > 0
    && (editing || draft.workspaceKind === "managedDialogue" || draft.serverPath.trim().length > 0);
  return <Modal open={open} title={editing ? t("projects.edit") : t("projects.new")}
    description={editing ? t("projects.editBody") : pickerOwner === undefined ? t("projects.createBody") : t("projects.createLocalBody")} size="large"
    onClose={saving ? () => undefined : onClose}>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (valid && !saving) onSave(draft); }}>
      <div className="settings-form__grid">
        <label className="field"><span>{t("projects.name")}</span><input required maxLength={120} value={draft.name} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label className="field"><span>{t("controls.backend")}</span><SelectControl disabled={editing || saving} value={draft.backendId} onChange={(event) => setDraft((current) => ({ ...current, backendId: event.target.value }))}>{snapshot.backends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name}</option>)}</SelectControl></label>
        {!editing && <>
          <label className="field"><span>{t("projects.workspaceType")}</span><SelectControl value={draft.workspaceKind} disabled={saving || picking} onChange={(event) => setDraft((current) => ({ ...current, workspaceKind: event.target.value as TargetDraft["workspaceKind"] }))}><option value="userProject">{t("projects.userProject")}</option><option value="managedDialogue">{t("projects.managed")}</option></SelectControl></label>
          {draft.workspaceKind === "userProject" && <div className="field settings-form__wide"><label htmlFor="project-editor-path">{t("projects.serverPath")}</label><div className="project-editor__path"><input id="project-editor-path" required value={draft.serverPath} disabled={saving || picking} onChange={(event) => setDraft((current) => ({ ...current, serverPath: event.target.value }))} placeholder={t("projects.serverPathPlaceholder")} />{pickerOwner !== undefined && <Button disabled={saving || picking} onClick={() => { void pickDirectory(); }}>{picking ? t("common.working") : t("projects.browseLocal")}</Button>}</div><small>{pickerOwner === undefined ? t("projects.serverPathHelp") : t("projects.localPathHelp")}</small></div>}
          <label className="check-row settings-form__wide"><CheckboxControl checked={draft.createIfMissing} disabled={saving || draft.workspaceKind === "managedDialogue"} onChange={(event) => setDraft((current) => ({ ...current, createIfMissing: event.target.checked }))} /><span><strong>{t("projects.createMissing")}</strong><small>{t("projects.createMissingBody")}</small></span></label>
        </>}
      </div>
      {(error ?? pickerError) !== undefined && <p role="alert" className="project-card__error">{error ?? pickerError}</p>}
      <div className="modal__actions"><Button disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={!valid || saving || picking}>{saving ? t("common.working") : editing ? t("common.save") : t("projects.create")}</Button></div>
    </form>
  </Modal>;
}

function emptyTargetDraft(snapshot: AppSnapshot): TargetDraft {
  return { backendId: snapshot.backends[0]?.id ?? "", name: "", workspaceKind: "userProject", serverPath: "", createIfMissing: false };
}

function projectNameFromDirectory(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export type ProjectPickerOwner = { readonly profileId: string; readonly deviceId: string; readonly serverId: string; readonly origin: string };

export function localProjectPickerOwner(controller: AppController): ProjectPickerOwner | undefined {
  const profile = controller.state.activeProfile;
  const status = controller.state.managedOrchestratorStatus;
  if (controller.state.connectionState !== "connected" || profile?.managedLocal !== true || status?.state !== "ready"
    || window.jokoDesktop?.capabilities.includes("projects.directoryPicker") !== true
    || window.jokoDesktop.projects?.pickDirectory === undefined) return undefined;
  const connection = status.connection;
  return profile.id === connection.profileId && profile.deviceId === connection.deviceId
    && profile.serverId === connection.serverId && profile.origin === connection.origin
    ? { profileId: profile.id, deviceId: profile.deviceId, serverId: profile.serverId, origin: profile.origin }
    : undefined;
}

export function sameProjectPickerOwner(left: ProjectPickerOwner | undefined, right: ProjectPickerOwner): boolean {
  return left !== undefined && left.profileId === right.profileId && left.deviceId === right.deviceId
    && left.serverId === right.serverId && left.origin === right.origin;
}
