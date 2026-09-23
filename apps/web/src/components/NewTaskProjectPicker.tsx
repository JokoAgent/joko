import { ChevronDown, FolderKanban, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import type { RecentProject } from "../recent-projects.js";
import { MorphPopover } from "./MorphPopover.js";
import type { Translator } from "./types.js";
import { cx } from "./ui.js";

export interface ProjectPickerOption {
  readonly value: string;
  readonly name: string;
  readonly location?: string;
  readonly disabled?: boolean;
}

export interface RecentProjectPickerOption {
  readonly entry: RecentProject;
  readonly available: boolean;
}

export function NewTaskProjectPicker({ value, selectedName, projects, dialogues, recent, ownerKey, requestId, disabled,
  canBrowse, error, onChoose, onChooseRecent, onRemoveRecent, onBrowse, onAdd, onOpen, t }: {
  readonly value: string;
  readonly selectedName: string;
  readonly projects: readonly ProjectPickerOption[];
  readonly dialogues: readonly ProjectPickerOption[];
  readonly recent: readonly RecentProjectPickerOption[];
  readonly ownerKey: string;
  readonly requestId?: number;
  readonly disabled: boolean;
  readonly canBrowse: boolean;
  readonly error?: string;
  readonly onChoose: (value: string) => void;
  readonly onChooseRecent: (entry: RecentProject) => boolean;
  readonly onRemoveRecent: (entry: RecentProject) => void;
  readonly onBrowse: () => void;
  readonly onAdd: () => void;
  readonly onOpen: () => void;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const consumedRequestRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { setOpen(false); }, [ownerKey]);
  const setVisible = (next: boolean): void => {
    if (disabled) return;
    if (next && !open) onOpen();
    setOpen(next);
  };
  useLayoutEffect(() => {
    if (requestId === undefined || consumedRequestRef.current === requestId || disabled) return;
    consumedRequestRef.current = requestId;
    setVisible(true);
  }, [requestId, disabled]);
  useEffect(() => { if (disabled && open) setOpen(false); }, [disabled, open]);
  const choose = (next: string): void => {
    setOpen(false);
    if (next === "__new_project__") onAdd();
    else if (next === "__browse_local__") onBrowse();
    else onChoose(next);
  };
  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-project-picker-choice]:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const current = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
  };
  const firstChoice = (): HTMLElement | null => panelRef.current?.querySelector<HTMLElement>("[data-project-picker-choice]:not(:disabled)") ?? null;
  const row = (option: ProjectPickerOption): JSX.Element => <button key={option.value} type="button"
    className={cx("new-task-project-picker__choice", option.value === value && "is-selected")}
    data-project-picker-choice="" disabled={option.disabled} aria-current={option.value === value ? "true" : undefined}
    onClick={() => choose(option.value)}><span><strong>{option.name}</strong>{option.location && <small>{option.location}</small>}</span></button>;
  return <div className="new-task-context__control--target">
    <MorphPopover open={open && !disabled} onOpenChange={setVisible} label={t("newTask.location")}
      trigger={<button className="new-task-project-picker__trigger" type="button" disabled={disabled}
        aria-label={`${t("newTask.location")}: ${selectedName}`} aria-haspopup="dialog" aria-expanded={open && !disabled}
        onClick={() => setVisible(!open)}><FolderKanban aria-hidden="true" /><span>{selectedName}</span><ChevronDown aria-hidden="true" /></button>}
      className="new-task-context__control new-task-project-picker"
      panelClassName="new-task-project-picker__panel" panelWidth={360} side="bottom"
      initialFocus={firstChoice} onPanelKeyDown={handleKeys} panelElementRef={panelRef}>
      <div data-new-task-project-picker="" data-state={open ? "open" : "closed"} className="new-task-project-picker__body">
        {error && <p role="alert" className="new-task-project-picker__error">{error}</p>}
        {recent.length > 0 && <section aria-label={t("newTask.recentProjects")}>
          <h3>{t("newTask.recentProjects")}</h3>
          {recent.map(({ entry, available }) => <div className="new-task-project-picker__recent" key={`${entry.targetId}:${entry.workspaceId}:${entry.serverPath}:${entry.remoteHostId ?? ""}`}>
            <button type="button" data-project-picker-choice="" disabled={!available}
              className="new-task-project-picker__choice" onClick={() => { if (onChooseRecent(entry)) setOpen(false); }}>
              <span><strong>{entry.name}{available ? "" : ` · ${t("newTask.unavailable")}`}</strong>
                <small>{entry.remoteHostId === undefined ? entry.serverPath : `${entry.remoteHostId} · ${entry.remoteWorkspaceRoot}`}</small></span>
            </button>
            <button type="button" className="new-task-project-picker__remove"
              aria-label={`${t("newTask.removeRecentProject")}: ${entry.name}`} onClick={() => onRemoveRecent(entry)}><X aria-hidden="true" /></button>
          </div>)}
        </section>}
        {projects.length > 0 && <section aria-label={t("nav.projects")}><h3>{t("nav.projects")}</h3>{projects.map(row)}</section>}
        {dialogues.length > 0 && <section aria-label={t("newTask.dialogues")}><h3>{t("newTask.dialogues")}</h3>{dialogues.map(row)}</section>}
        <section aria-label={t("newTask.projectActions")}>
          {canBrowse && row({ value: "__browse_local__", name: t("newTask.browseLocalProject") })}
          {row({ value: "__new_project__", name: t("newTask.addProject") })}
        </section>
      </div>
    </MorphPopover>
    <select className="select-control__native-bridge" aria-hidden="true" tabIndex={-1} value={value}
      disabled={disabled} onChange={(event) => choose(event.currentTarget.value)}>
      {value !== "" && !projects.some((option) => option.value === value) && !dialogues.some((option) => option.value === value)
        && <option value={value} disabled>{selectedName}</option>}
      {projects.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>{option.name}{option.location ? ` · ${option.location}` : ""}</option>)}
      {dialogues.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>{option.name}{option.location ? ` · ${option.location}` : ""}</option>)}
      {canBrowse && <option value="__browse_local__">{t("newTask.browseLocalProject")}</option>}
      <option value="__new_project__">{t("newTask.addProject")}</option>
    </select>
  </div>;
}
