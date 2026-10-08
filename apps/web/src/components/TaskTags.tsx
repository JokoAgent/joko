import { useEffect, useState } from "react";
import type { JSX } from "react";
import { ArrowDown, ArrowUp, Save, Tags, Trash2 } from "lucide-react";
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
  const [createName, setCreateName] = useState("");
  const [createColor, setCreateColor] = useState<TaskTagColorView>("blue");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deletePreview, setDeletePreview] = useState<TaskTagDeletePreviewView>();

  useEffect(() => {
    setCreateName("");
    setCreateColor("blue");
    setBusy(false);
    setError(undefined);
    setDeletePreview(undefined);
  }, [session?.id]);

  const attached = new Set((session?.taskTags ?? []).map((tag) => tag.id));
  const run = async (action: () => Promise<void>, onSuccess?: () => void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onSuccess?.();
    } catch {
      setError(t("taskTags.changeFailed"));
    } finally {
      setBusy(false);
    }
  };
  const reorder = (tagId: string, direction: -1 | 1): void => {
    if (session === undefined) return;
    const index = catalog.findIndex((tag) => tag.id === tagId);
    const other = index + direction;
    if (index < 0 || other < 0 || other >= catalog.length) return;
    const ids = catalog.map((tag) => tag.id);
    [ids[index], ids[other]] = [ids[other] as string, ids[index] as string];
    void run(() => controller.reorderTaskTags(session.id, ids, catalogRevision));
  };
  const previewDeletion = async (tag: TaskTagView): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setDeletePreview(await controller.previewTaskTagDeletion(tag.id));
    } catch {
      setError(t("taskTags.previewFailed"));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Modal
      open={session !== undefined}
      title={t("taskTags.title")}
      description={session?.name}
      closeLabel={t("common.close")}
      size="large"
      className="task-tag-modal"
      showClose
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) onClose(); }}
    >
      <div className="task-tag-editor" aria-busy={busy}>
        <p className="task-tag-editor__help">{t("taskTags.help")}</p>
        <div className="task-tag-editor__list">
          {catalog.map((tag, index) => <TaskTagEditorRow
            key={tag.id}
            tag={tag}
            t={t}
            attached={attached.has(tag.id)}
            disabled={busy}
            canMoveUp={index > 0}
            canMoveDown={index < catalog.length - 1}
            onAttachedChange={(next) => {
              if (session !== undefined) void run(() => controller.setSessionTaskTags(session.id, [session.id], [tag.id], next));
            }}
            onUpdate={(patch) => {
              if (session !== undefined) void run(() => controller.updateTaskTag(session.id, tag.id, tag.revision, patch));
            }}
            onMoveUp={() => reorder(tag.id, -1)}
            onMoveDown={() => reorder(tag.id, 1)}
            onDelete={() => void previewDeletion(tag)}
          />)}
          {catalog.length === 0 && <p className="task-tag-editor__empty">{t("taskTags.empty")}</p>}
        </div>
        <form className="task-tag-editor__create" onSubmit={(event) => {
          event.preventDefault();
          const name = createName.trim();
          if (session === undefined || name === "" || catalog.length >= 256) return;
          void run(
            () => controller.createTaskTag(session.id, name, createColor, catalogRevision),
            () => { setCreateName(""); setCreateColor("blue"); }
          );
        }}>
          <label><span>{t("taskTags.newName")}</span><input value={createName} maxLength={80} disabled={busy || catalog.length >= 256} onChange={(event) => setCreateName(event.target.value)} /></label>
          <TaskTagColorSelect color={createColor} t={t} disabled={busy || catalog.length >= 256} onChange={setCreateColor} />
          <Button type="submit" tone="primary" disabled={busy || createName.trim() === "" || catalog.length >= 256}><Tags aria-hidden="true" />{t("taskTags.create")}</Button>
        </form>
        {catalog.length >= 256 && <p className="task-tag-editor__limit" role="status">{t("taskTags.catalogLimit")}</p>}
        {error !== undefined && <p className="task-tag-editor__error" role="alert">{error}</p>}
      </div>
    </Modal>
    <Modal
      open={deletePreview !== undefined}
      title={t("taskTags.deleteTitle")}
      description={deletePreview === undefined ? undefined : t("taskTags.deleteAffected", { count: deletePreview.affectedSessionCount })}
      closeLabel={t("common.close")}
      size="small"
      dialogRole="alertdialog"
      dismissOnBackdrop={!busy}
      onClose={() => { if (!busy) setDeletePreview(undefined); }}
    >
      <div className="task-tag-delete">
        <p>{t("taskTags.deleteBody")}</p>
        {error !== undefined && <p className="task-tag-editor__error" role="alert">{error}</p>}
        <div className="modal__actions">
          <Button disabled={busy} onClick={() => setDeletePreview(undefined)}>{t("common.cancel")}</Button>
          <Button tone="danger" disabled={busy} onClick={() => {
            const preview = deletePreview;
            if (session === undefined || preview === undefined) return;
            void run(() => controller.deleteTaskTag(session.id, preview), () => setDeletePreview(undefined));
          }}><Trash2 aria-hidden="true" />{t("common.delete")}</Button>
        </div>
      </div>
    </Modal>
  </>;
}

function TaskTagEditorRow({ tag, t, attached, disabled, canMoveUp, canMoveDown, onAttachedChange, onUpdate, onMoveUp, onMoveDown, onDelete }: {
  readonly tag: TaskTagView;
  readonly t: Translator;
  readonly attached: boolean;
  readonly disabled: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onAttachedChange: (attached: boolean) => void;
  readonly onUpdate: (patch: { readonly name?: string; readonly color?: TaskTagColorView }) => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  useEffect(() => { setName(tag.name); setColor(tag.color); }, [tag.id, tag.name, tag.color, tag.revision]);
  const normalized = name.trim();
  const changed = normalized !== "" && (normalized !== tag.name || color !== tag.color);
  return <div className="task-tag-editor__row">
    <label className="task-tag-editor__attach" title={attached ? t("taskTags.detach") : t("taskTags.attach")}>
      <CheckboxControl checked={attached} disabled={disabled} onChange={(event) => onAttachedChange(event.target.checked)} />
      <TaskTagDot tag={{ ...tag, color }} t={t} />
    </label>
    <input aria-label={t("taskTags.name")} value={name} maxLength={80} disabled={disabled} onChange={(event) => setName(event.target.value)} />
    <TaskTagColorSelect color={color} t={t} disabled={disabled} onChange={setColor} compact />
    <IconButton label={t("common.save")} disabled={disabled || !changed} onClick={() => onUpdate({ ...(normalized === tag.name ? {} : { name: normalized }), ...(color === tag.color ? {} : { color }) })}><Save aria-hidden="true" /></IconButton>
    <IconButton label={t("taskTags.moveUp")} disabled={disabled || !canMoveUp} onClick={onMoveUp}><ArrowUp aria-hidden="true" /></IconButton>
    <IconButton label={t("taskTags.moveDown")} disabled={disabled || !canMoveDown} onClick={onMoveDown}><ArrowDown aria-hidden="true" /></IconButton>
    <IconButton className="danger-text" label={t("taskTags.deleteTitle")} disabled={disabled} onClick={onDelete}><Trash2 aria-hidden="true" /></IconButton>
  </div>;
}

function TaskTagColorSelect({ color, t, disabled, onChange, compact = false }: {
  readonly color: TaskTagColorView;
  readonly t: Translator;
  readonly disabled: boolean;
  readonly onChange: (color: TaskTagColorView) => void;
  readonly compact?: boolean;
}): JSX.Element {
  const select = <select className={cx("select-control", compact && "task-tag-color-select--compact")} aria-label={t("taskTags.color")} value={color} disabled={disabled} onChange={(event) => onChange(event.target.value as TaskTagColorView)}>
    {TASK_TAG_COLORS.map((value) => <option key={value} value={value}>{taskTagColorLabel(value, t)}</option>)}
  </select>;
  return compact ? select : <label><span>{t("taskTags.color")}</span>{select}</label>;
}
