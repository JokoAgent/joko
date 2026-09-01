import type { JSX } from "react";
import { Trash2 } from "lucide-react";

import type { TimelineItemView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, Spinner } from "./ui.js";

export function MessageDeleteDialog({
  item,
  busy,
  blockedReason,
  error,
  t,
  onClose,
  onConfirm
}: {
  readonly item?: TimelineItemView;
  readonly busy: boolean;
  readonly blockedReason?: string;
  readonly error?: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const close = (): void => { if (!busy) onClose(); };
  return (
    <Modal
      open={item !== undefined}
      title={t("timeline.deleteMessageConfirmTitle")}
      description={t("timeline.deleteMessageConfirmDescription")}
      closeLabel={t("common.close")}
      size="small"
      dismissOnBackdrop={!busy}
      onClose={close}
    >
      <div className="delete-dialog message-delete-dialog" aria-busy={busy}>
        {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
        {blockedReason !== undefined && <p className="muted message-delete-dialog__blocked" role="status">{blockedReason}</p>}
        <div className="modal__actions">
          <Button disabled={busy} onClick={close}>{t("common.cancel")}</Button>
          <Button tone="danger" disabled={busy || blockedReason !== undefined} onClick={onConfirm}>
            {busy ? <Spinner label={t("common.working")} /> : <Trash2 aria-hidden="true" />}
            {t("timeline.deleteMessageConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
