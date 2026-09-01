import type { JSX } from "react";
import { Archive, LoaderCircle, MessageSquare, Trash2 } from "lucide-react";

import type { ScheduleView } from "../model.js";
import type { GeneratedSessionDisposition } from "../schedule-deletion.js";
import type { Translator } from "./types.js";
import { Button, Modal, cx } from "./ui.js";

const DISPOSITION_OPTIONS = [
  { value: "keep", Icon: MessageSquare, title: "scheduler.deleteOptionKeep", description: "scheduler.deleteOptionKeepBody" },
  { value: "archive", Icon: Archive, title: "scheduler.deleteOptionArchive", description: "scheduler.deleteOptionArchiveBody" },
  { value: "delete", Icon: Trash2, title: "scheduler.deleteOptionDelete", description: "scheduler.deleteOptionDeleteBody" }
] as const;

export function ScheduleDeleteDialog({ schedule, disposition, generatedCount, inflightCount, previewError, operationError, pending, t, onDispositionChange, onRetryPreview, onClose, onConfirm }: {
  readonly schedule?: ScheduleView;
  readonly disposition: GeneratedSessionDisposition;
  readonly generatedCount?: number;
  readonly inflightCount?: number;
  readonly previewError?: string;
  readonly operationError?: string;
  readonly pending: boolean;
  readonly t: Translator;
  readonly onDispositionChange: (value: GeneratedSessionDisposition) => void;
  readonly onRetryPreview: () => void;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const previewReady = generatedCount !== undefined && previewError === undefined;
  return <Modal
    open={schedule !== undefined}
    title={t("scheduler.deleteTitle", { name: schedule?.name ?? t("scheduler.title") })}
    description={t("scheduler.deleteGeneratedBody")}
    size="small"
    dialogRole="alertdialog"
    dismissOnBackdrop={!pending}
    onClose={onClose}
  >
    <div className="schedule-delete-dialog">
      {previewReady
        ? <p className="schedule-delete-dialog__count">{t("scheduler.deleteGeneratedCount", { count: generatedCount ?? 0 })}{(inflightCount ?? 0) > 0 ? ` · ${t("scheduler.deleteInflightCount", { count: inflightCount ?? 0 })}` : ""}</p>
        : previewError === undefined
          ? <p className="schedule-delete-dialog__count"><LoaderCircle className="spin" aria-hidden="true" />{t("common.loading")}</p>
          : <div className="danger-text" role="alert"><p>{t("scheduler.deletePreviewFailed")}</p><Button disabled={pending} onClick={onRetryPreview}>{t("common.retry")}</Button></div>}
      <div className="schedule-delete-dialog__options" role="radiogroup" aria-label={t("scheduler.deleteGeneratedOptions")}>
        {DISPOSITION_OPTIONS.map(({ value, Icon, title, description }) => {
          const selected = disposition === value;
          return <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={pending || !previewReady}
            className={cx("schedule-delete-dialog__option", selected && "is-selected", value === "delete" && "is-danger")}
            onClick={() => onDispositionChange(value)}
          >
            <span className="schedule-delete-dialog__option-icon"><Icon aria-hidden="true" /></span>
            <span><strong>{t(title)}</strong><small>{t(description)}</small></span>
          </button>;
        })}
      </div>
      {operationError !== undefined && <p className="danger-text" role="alert">{operationError}</p>}
      <div className="modal__actions">
        <Button disabled={pending} onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          tone={disposition === "delete" ? "danger" : "primary"}
          disabled={pending || !previewReady}
          onClick={onConfirm}
        >{pending ? <LoaderCircle className="spin" aria-hidden="true" /> : null}{t(disposition === "delete" ? "scheduler.deleteConfirmWithTasks" : "scheduler.deleteConfirm")}</Button>
      </div>
    </div>
  </Modal>;
}
