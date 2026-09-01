import { useRef } from "react";
import type { JSX } from "react";

import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export function MessageForkDialog({
  open,
  t,
  onClose,
  onConfirm
}: {
  readonly open: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Modal
      open={open}
      title={t("timeline.forkConfirmTitle")}
      description={t("timeline.forkConfirmDescription")}
      closeLabel={t("common.close")}
      size="small"
      dialogRole="alertdialog"
      initialFocus={() => contentRef.current?.querySelector<HTMLElement>("[data-message-fork-confirm='true']") ?? null}
      onClose={onClose}
    >
      <div ref={contentRef} className="modal__actions message-fork-dialog__actions">
        <Button data-message-fork-cancel="true" onClick={onClose}>{t("common.cancel")}</Button>
        <Button data-message-fork-confirm="true" tone="primary" onClick={onConfirm}>{t("timeline.forkConfirmAction")}</Button>
      </div>
    </Modal>
  );
}
