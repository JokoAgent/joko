import { useEffect, useRef, useState, type JSX } from "react";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { Button, Modal } from "./ui.js";

export interface ComposerPastedTextDialogTarget {
  readonly nodePosition: number;
  readonly text: string;
}

export function ComposerPastedTextDialog({
  target,
  title,
  closeLabel,
  cancelLabel,
  saveLabel,
  lineLabel,
  characterLabel,
  onSave,
  onClose
}: {
  readonly target: ComposerPastedTextDialogTarget | undefined;
  readonly title: string;
  readonly closeLabel: string;
  readonly cancelLabel: string;
  readonly saveLabel: string;
  readonly lineLabel: (count: number) => string;
  readonly characterLabel: (count: number) => string;
  readonly onSave: (target: ComposerPastedTextDialogTarget, text: string) => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  const [text, setText] = useState(target?.text ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(target?.text ?? ""), [target?.nodePosition, target?.text]);
  return (
    <Modal
      open={target !== undefined}
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      size="large"
      className="composer-pasted-text-dialog"
      initialFocus={() => textareaRef.current}
      restoreFocusFallback={() => document.querySelector<HTMLElement>(".composer-rich-editor__content")}
    >
      {target !== undefined && <>
        <textarea
          ref={textareaRef}
          className="composer-pasted-text-dialog__editor"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          aria-label={title}
        />
        <footer className="composer-pasted-text-dialog__footer">
          <span>{lineLabel(countComposerPasteLines(text))} · {characterLabel(text.length)}</span>
          <div className="modal__actions">
            <Button tone="ghost" onClick={onClose}>{cancelLabel}</Button>
            <Button tone="primary" onClick={() => onSave(target, text)}>{saveLabel}</Button>
          </div>
        </footer>
      </>}
    </Modal>
  );
}
