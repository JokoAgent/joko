import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ArrowLeft, Check, GripVertical, Pencil, Plus, Save, Trash2 } from "lucide-react";
import type { AppController } from "../controller.js";
import type { SessionView, TaskTagColorView, TaskTagDeletePreviewView, TaskTagDisplayView, TaskTagView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, IconButton, Modal, cx } from "./ui.js";

export const TASK_TAG_COLORS: readonly TaskTagColorView[] = [
  "red", "orange", "yellow", "green", "blue", "purple",
  "gray", "pink", "coral", "teal", "indigo", "white"
];

export function taskTagDisplayName(tag: TaskTagDisplayView, t: Translator): string {
  if (tag.nameCustomized || tag.presetKey === undefined) return tag.name;
  switch (tag.presetKey) {
    case "red": return t("taskTags.preset.red");
    case "orange": return t("taskTags.preset.orange");
    case "yellow": return t("taskTags.preset.yellow");
    case "green": return t("taskTags.preset.green");
    case "blue": return t("taskTags.preset.blue");
    case "purple": return t("taskTags.preset.purple");
    case "important": return t("taskTags.preset.important");
    case "follow-up": return t("taskTags.preset.followUp");
    case "work": return t("taskTags.preset.work");
    case "life": return t("taskTags.preset.life");
    case "ideas": return t("taskTags.preset.ideas");
    case "reference": return t("taskTags.preset.reference");
    default: return tag.name;
  }
}

function taskTagColorLabel(color: TaskTagColorView, t: Translator): string {
  switch (color) {
    case "red": return t("taskTags.color.red");
    case "orange": return t("taskTags.color.orange");
    case "yellow": return t("taskTags.color.yellow");
    case "green": return t("taskTags.color.green");
    case "blue": return t("taskTags.color.blue");
    case "purple": return t("taskTags.color.purple");
    case "gray": return t("taskTags.color.gray");
    case "pink": return t("taskTags.color.pink");
    case "coral": return t("taskTags.color.coral");
    case "teal": return t("taskTags.color.teal");
    case "indigo": return t("taskTags.color.indigo");
    case "white": return t("taskTags.color.white");
  }
}

export function TaskTagDot({ tag, t }: { readonly tag: TaskTagDisplayView; readonly t: Translator }): JSX.Element {
  const label = taskTagDisplayName(tag, t);
  return <span className="task-tag-dot" data-color={tag.color} title={label} aria-label={label} />;
}

export function TaskTagDots({ tags, t, maximum = 32 }: {
  readonly tags?: readonly TaskTagDisplayView[];
  readonly t: Translator;
  readonly maximum?: number;
}): JSX.Element | null {
  if (tags === undefined || tags.length === 0) return null;
  const visible = tags.slice(0, maximum);
  const hidden = tags.length - visible.length;
  return <span className="task-tag-dots" aria-label={tags.map((tag) => taskTagDisplayName(tag, t)).join(", ")}>
    {visible.map((tag) => <TaskTagDot key={tag.id} tag={tag} t={t} />)}
    {hidden > 0 && <span className="task-tag-dots__more" aria-hidden="true">+{hidden}</span>}
  </span>;
}

export function TaskTagDialog({ session, catalog, catalogRevision, controller, t, onClose }: {
  readonly session?: SessionView;
  readonly catalog: readonly TaskTagView[];
  readonly catalogRevision: bigint;
  readonly controller: AppController;
  readonly t: Translator;
  readonly onClose: () => void;
}): JSX.Element {
  const [page, setPage] = useState<"list" | "add" | "edit">("list");
  const [editing, setEditing] = useState<TaskTagView>();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TaskTagColorView>("blue");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deletePreview, setDeletePreview] = useState<TaskTagDeletePreviewView>();
  const [dragging, setDragging] = useState<{ id: string; to: number }>();
  const list = useRef<HTMLDivElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const drag = useRef<{ id: string; pointerId: number; y: number; ids: string[]; revision: bigint; to: number } | undefined>(undefined);
  const action = useRef<symbol | undefined>(undefined);
  const returnFocus = useRef<string | undefined>(undefined);
  const scope = JSON.stringify([controller.state?.activeProfile?.id, controller.state?.activeProfile?.serverId,
    controller.state?.activeProfile?.origin, controller.state?.activeProfile?.deviceId, controller.state?.connectionState, session?.id, session?.generation?.toString()]);
  const live = useRef({ scope, session, catalog, catalogRevision });
  live.current = { scope, session, catalog, catalogRevision };
  const alive = useRef(true);
  const current = () => alive.current && live.current.scope === scope && live.current.session !== undefined
    && (controller.state?.connectionState === undefined || controller.state.connectionState === "connected");

  const cancelDrag = (): void => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    drag.current = undefined;
    setDragging(undefined);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    action.current = undefined;
    setPage("list"); setEditing(undefined); setName(""); setColor("blue");
    setBusy(false); setError(undefined); setDeletePreview(undefined); cancelDrag();
  }, [scope]);
  useEffect(() => { cancelDrag(); }, [catalogRevision, page]);
  useEffect(() => {
    if (page !== "list" || returnFocus.current === undefined) return;
    const id = returnFocus.current; returnFocus.current = undefined;
    const row = [...list.current?.querySelectorAll<HTMLElement>("[data-tag-id]") ?? []].find(row => row.dataset.tagId === id);
    (row?.querySelector<HTMLButtonElement>("button:last-child") ?? list.current?.parentElement?.querySelector<HTMLButtonElement>(".button"))?.focus();
  }, [page]);
  useEffect(() => {
    const cancel = () => cancelDrag();
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => { window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", cancel); };
  }, []);
  const attached = new Set((session?.taskTags ?? []).map((tag) => tag.id));
  const run = async (perform: () => Promise<void>, success?: () => void, failure = t("taskTags.changeFailed")): Promise<void> => {
    if (action.current !== undefined || !current() || drag.current !== undefined) return;
    const owner = Symbol("task-tag-operation"); action.current = owner;
    setBusy(true); setError(undefined);
    try { await perform(); if (current() && action.current === owner) success?.(); }
    catch { if (current() && action.current === owner) setError(failure); }
    finally {
      if (current() && action.current === owner) { action.current = undefined; setBusy(false); }
    }
  };
  const openForm = (tag?: TaskTagView): void => {
    returnFocus.current = tag?.id ?? "";
    setEditing(tag); setName(tag === undefined ? "" : taskTagDisplayName(tag, t));
    setColor(tag?.color ?? "blue"); setError(undefined); setPage(tag === undefined ? "add" : "edit");
  };
  const reorder = (id: string, to: number, ids = catalog.map(tag => tag.id), revision = catalogRevision): void => {
    const from = ids.indexOf(id);
    if (session === undefined || from < 0 || to < 0 || to >= ids.length || from === to) return;
    const next = [...ids]; next.splice(from, 1); next.splice(to, 0, id);
    void run(() => controller.reorderTaskTags(session.id, next, revision));
  };
  const track = (): void => {
    const active = drag.current, container = list.current;
    if (active === undefined || container === null) return;
    const bounds = container.getBoundingClientRect();
    const speed = active.y < bounds.top + 32 ? -10 : active.y > bounds.bottom - 32 ? 10 : 0;
    if (speed !== 0) container.scrollTop += speed;
    const rows = [...container.querySelectorAll<HTMLElement>("[data-tag-id]")];
    let to = 0;
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index]!.getBoundingClientRect();
      if (active.y >= row.top + row.height / 2) to = index;
    }
    active.to = to; setDragging({ id: active.id, to });
    frame.current = requestAnimationFrame(track);
  };
  const finishDrag = (pointerId: number, commit: boolean): void => {
    const active = drag.current;
    if (active === undefined || active.pointerId !== pointerId) return;
    cancelDrag();
    if (commit && current() && live.current.catalogRevision === active.revision) reorder(active.id, active.to, active.ids, active.revision);
  };
  const previewDeletion = (): void => {
    if (editing === undefined) return;
    void run(async () => {
      const preview = await controller.previewTaskTagDeletion(editing.id);
      if (current()) setDeletePreview(preview);
    }, undefined, t("taskTags.previewFailed"));
  };
  const formChanged = editing === undefined || name.trim() !== taskTagDisplayName(editing, t) || color !== editing.color;

  return <>
    <Modal open={session !== undefined} title={t(page === "list" ? "taskTags.title" : page === "add" ? "taskTags.create" : "taskTags.manage")}
      description={session?.name} closeLabel={t("common.close")} size="small" className="task-tag-modal"
      showClose dismissOnBackdrop={!busy && dragging === undefined} onClose={() => { if (!busy) { cancelDrag(); onClose(); } }}>
      <div className="task-tag-editor" aria-busy={busy}>
        {page === "list" ? <>
          <p className="task-tag-editor__help">{t("taskTags.help")}</p>
          <div ref={list} className="task-tag-editor__list" onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancelDrag(); } }}>
            {catalog.map((tag, index) => <div key={tag.id} data-tag-id={tag.id}
              className={cx("task-tag-editor__row", dragging?.id === tag.id && "task-tag-editor__row--dragging", dragging?.to === index && "task-tag-editor__row--target")}>
              <IconButton className="task-tag-editor__handle" label={t("taskTags.reorderLabel", { name: taskTagDisplayName(tag, t) })}
                aria-describedby="task-tag-reorder-hint" disabled={busy || catalog.length < 2} aria-pressed={dragging?.id === tag.id}
                onPointerDown={event => {
                  if (event.button !== 0 || action.current !== undefined || !current()) return;
                  event.preventDefault(); cancelDrag();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  drag.current = { id: tag.id, pointerId: event.pointerId, y: event.clientY, ids: catalog.map(tag => tag.id), revision: catalogRevision, to: index };
                  setDragging({ id: tag.id, to: index }); frame.current = requestAnimationFrame(track);
                }}
                onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) drag.current.y = event.clientY; }}
                onPointerUp={event => finishDrag(event.pointerId, true)}
                onPointerCancel={event => finishDrag(event.pointerId, false)}
                onLostPointerCapture={event => finishDrag(event.pointerId, false)}
                onKeyDown={event => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault(); reorder(tag.id, index + (event.key === "ArrowUp" ? -1 : 1));
                }}><GripVertical aria-hidden="true" /></IconButton>
              <label className="task-tag-editor__attach">
                <CheckboxControl checked={attached.has(tag.id)} disabled={busy || dragging !== undefined}
                  aria-label={t(attached.has(tag.id) ? "taskTags.detach" : "taskTags.attach") + " " + taskTagDisplayName(tag, t)}
                  onChange={event => { if (session) void run(() => controller.setSessionTaskTags(session.id, [session.id], [tag.id], event.target.checked)); }} />
                <TaskTagDot tag={tag} t={t} /><span>{taskTagDisplayName(tag, t)}</span>
              </label>
              <IconButton label={t("taskTags.editLabel", { name: taskTagDisplayName(tag, t) })} disabled={busy || dragging !== undefined} onClick={() => openForm(tag)}><Pencil aria-hidden="true" /></IconButton>
            </div>)}
            {catalog.length === 0 && <p className="task-tag-editor__empty">{t("taskTags.empty")}</p>}
          </div>
          {catalog.length > 1 && <p id="task-tag-reorder-hint" className="task-tag-editor__help">{t("taskTags.reorderHint")}</p>}
          <Button disabled={busy || dragging !== undefined || catalog.length >= 256} onClick={() => openForm()}><Plus aria-hidden="true" />{t("taskTags.create")}</Button>
          {catalog.length >= 256 && <p className="task-tag-editor__limit" role="status">{t("taskTags.catalogLimit")}</p>}
        </> : <form className="task-tag-editor__form" onSubmit={event => {
          event.preventDefault();
          if (!session || !name.trim() || !formChanged) return;
          void run(() => editing === undefined
            ? controller.createTaskTag(session.id, name.trim(), color, catalogRevision)
            : controller.updateTaskTag(session.id, editing.id, editing.revision, {
              ...(name.trim() === taskTagDisplayName(editing, t) ? {} : { name: name.trim() }),
              ...(color === editing.color ? {} : { color })
            }), () => { setPage("list"); setEditing(undefined); });
        }}>
          <Button disabled={busy} onClick={() => { setPage("list"); setError(undefined); }}><ArrowLeft aria-hidden="true" />{t("common.back")}</Button>
          <label className="task-tag-editor__name"><span>{t("taskTags.name")}</span><input autoFocus aria-label={t("taskTags.name")} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <fieldset className="task-tag-editor__palette" disabled={busy}><legend>{t("taskTags.color")}</legend>
            {TASK_TAG_COLORS.map(value => <button key={value} type="button" className="task-tag-editor__swatch" aria-pressed={color === value}
              aria-label={taskTagColorLabel(value, t)} onClick={() => setColor(value)}>
              <span className="task-tag-dot" data-color={value}>{color === value && <Check aria-hidden="true" />}</span>
            </button>)}
          </fieldset>
          <div className="modal__actions">
            {editing !== undefined && <Button tone="danger" disabled={busy} onClick={previewDeletion}><Trash2 aria-hidden="true" />{t("taskTags.deleteTitle")}</Button>}
            <Button type="submit" tone="primary" disabled={busy || !name.trim() || !formChanged}><Save aria-hidden="true" />{t("common.save")}</Button>
          </div>
        </form>}
        {error !== undefined && <p className="task-tag-editor__error" role="alert">{error}</p>}
      </div>
    </Modal>
    <Modal open={deletePreview !== undefined} title={t("taskTags.deleteTitle")}
      description={deletePreview === undefined ? undefined : t("taskTags.deleteAffected", { count: deletePreview.affectedSessionCount })}
      closeLabel={t("common.close")} size="small" dialogRole="alertdialog" dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) setDeletePreview(undefined); }}>
      <div className="task-tag-delete"><p>{t("taskTags.deleteBody")}</p>
        {error !== undefined && <p className="task-tag-editor__error" role="alert">{error}</p>}
        <div className="modal__actions">
          <Button disabled={busy} onClick={() => setDeletePreview(undefined)}>{t("common.cancel")}</Button>
          <Button tone="danger" disabled={busy} onClick={() => {
            if (!session || !deletePreview) return;
            void run(() => controller.deleteTaskTag(session.id, deletePreview), () => { setDeletePreview(undefined); setEditing(undefined); setPage("list"); });
          }}><Trash2 aria-hidden="true" />{t("common.delete")}</Button>
        </div>
      </div>
    </Modal>
  </>;
}
