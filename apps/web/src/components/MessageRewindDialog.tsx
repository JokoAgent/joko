import { AlertTriangle, FileDiff, MessagesSquare, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { JSX } from "react";
import type { WorkspaceRewindPreviewView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, Pill, Spinner } from "./ui.js";

export interface MessageRewindPreviewState {
  readonly loadingFiles: boolean;
  readonly preview?: WorkspaceRewindPreviewView;
  readonly filePreviewError?: string;
}

export function MessageRewindDialog({ open, state, t, onClose, onDialogueOnly, onFilesOnly }: {
  readonly open: boolean;
  readonly state: MessageRewindPreviewState;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onDialogueOnly: () => Promise<void>;
  readonly onFilesOnly: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState<"dialogue" | "files">();
  const [operationError, setOperationError] = useState<string>();
  const run = async (kind: "dialogue" | "files", operation: () => Promise<void>): Promise<void> => {
    if (busy !== undefined) return;
    setBusy(kind);
    setOperationError(undefined);
    try {
      await operation();
      onClose();
    } catch (cause) {
      setOperationError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t("timeline.rewindFailed"));
    } finally {
      setBusy(undefined);
    }
  };
  const filesExecutable = state.preview !== undefined && state.preview.safety !== "blocked";
  return (
    <Modal open={open} title={t("timeline.rewindTitle")} description={t("timeline.rewindDescription")} size="large" onClose={busy === undefined ? onClose : () => undefined}>
      <div className="message-rewind-preview" data-message-rewind-preview="true">
        <section className="message-rewind-preview__dialogue">
          <MessagesSquare aria-hidden="true" />
          <div><strong>{t("timeline.rewindDialogueTitle")}</strong><p>{t("timeline.rewindDialogueBody")}</p></div>
        </section>
        <section className="message-rewind-preview__files">
          <FileDiff aria-hidden="true" />
          <div>
            <strong>{t("timeline.rewindFilesTitle")}</strong>
            {state.loadingFiles && <p><Spinner label={t("common.loading")} />{t("timeline.rewindFilesLoading")}</p>}
            {!state.loadingFiles && state.preview === undefined && state.filePreviewError === undefined && <p>{t("timeline.rewindNoFiles")}</p>}
            {state.filePreviewError !== undefined && <p className="message-rewind-preview__warning"><AlertTriangle aria-hidden="true" />{t("timeline.rewindFilesUnavailable")}</p>}
            {state.preview !== undefined && <>
              <p><Pill tone={state.preview.safety === "blocked" ? "danger" : "warning"}>{state.preview.safety}</Pill>{t("workspace.restoreCount", { count: state.preview.inversePaths.length })}</p>
              {state.preview.conflicts.length > 0 && <p className="message-rewind-preview__warning"><AlertTriangle aria-hidden="true" />{t("workspace.conflicts")}: {state.preview.conflicts.join(", ")}</p>}
              {state.preview.gaps.length > 0 && <p className="message-rewind-preview__warning"><AlertTriangle aria-hidden="true" />{t("workspace.captureGaps")}: {state.preview.gaps.join(", ")}</p>}
            </>}
          </div>
        </section>
        <p className="message-rewind-preview__boundary"><AlertTriangle aria-hidden="true" />{t("timeline.rewindAtomicBoundary")}</p>
        {operationError !== undefined && <p className="message-rewind-preview__error" role="alert">{operationError}</p>}
        <div className="modal__actions">
          <Button disabled={busy !== undefined} onClick={onClose}>{t("common.cancel")}</Button>
          {state.preview !== undefined && <Button tone="danger" disabled={!filesExecutable || busy !== undefined} onClick={() => { void run("files", onFilesOnly); }}>{busy === "files" && <Spinner label={t("common.working")} />}{t("timeline.rewindFilesOnly")}</Button>}
          <Button tone="secondary" disabled={busy !== undefined} onClick={() => { void run("dialogue", onDialogueOnly); }}>{busy === "dialogue" ? <Spinner label={t("common.working")} /> : <RotateCcw aria-hidden="true" />}{t("timeline.rewindDialogueOnly")}</Button>
        </div>
      </div>
    </Modal>
  );
}
