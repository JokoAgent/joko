import { useRef } from "react";
import type { JSX } from "react";

import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export function MessageForkDialog({
  open,
  checkOriginal,
  pending,
  t,
  onClose,
  onConfirm
}: {
  readonly open: boolean;
  readonly checkOriginal?: boolean;
  readonly pending?: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Modal
      open={open}
      title={t(checkOriginal ? "timeline.forkCheckAction" : "timeline.forkConfirmTitle")}
      description={t(checkOriginal ? "timeline.forkCheckDescription" : "timeline.forkConfirmDescription")}
      closeLabel={t("common.close")}
      size="small"
      dialogRole="alertdialog"
      initialFocus={() => contentRef.current?.querySelector<HTMLElement>("[data-message-fork-confirm='true']") ?? null}
      onClose={onClose}
    >
      <div ref={contentRef} className="modal__actions message-fork-dialog__actions">
        <Button data-message-fork-cancel="true" onClick={onClose}>{t("common.cancel")}</Button>
        <Button data-message-fork-confirm="true" tone="primary" disabled={pending} onClick={onConfirm}>{t(checkOriginal ? "timeline.forkCheckAction" : "timeline.forkConfirmAction")}</Button>
      </div>
    </Modal>
  );
}
