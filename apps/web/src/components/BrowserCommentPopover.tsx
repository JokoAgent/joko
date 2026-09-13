import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  BROWSER_COMMENT_DESIGN_PROPERTIES,
  type BrowserCommentDesignBaselineView,
  type BrowserCommentDesignPropertyView,
  type BrowserCommentStyleChangeView,
  type BrowserCommentTargetView
} from "../model.js";
import { parseCssColor, styleValuesEquivalent } from "../browser-comment-draft.js";
import type { Translator } from "./types.js";
import { Button, IconButton } from "./ui.js";

export interface BrowserCommentEditorDraft {
  readonly text: string;
  readonly styleEdits: Readonly<Partial<Record<BrowserCommentDesignPropertyView, string>>>;
  readonly textEdit?: string;
}

export interface BrowserCommentDesignPreview {
  readonly styles: Readonly<Partial<Record<BrowserCommentDesignPropertyView, string>>>;
  readonly text?: string;
}

export function emptyBrowserCommentEditorDraft(): BrowserCommentEditorDraft {
  return { text: "", styleEdits: {} };
}

export function hasBrowserCommentDesignDraft(editor: BrowserCommentEditorDraft): boolean {
  return editor.textEdit !== undefined || Object.keys(editor.styleEdits).length > 0;
}

export function hasBrowserCommentEditorDraft(editor: BrowserCommentEditorDraft): boolean {
  return editor.text.length > 0 || hasBrowserCommentDesignDraft(editor);
}

export function browserCommentStyleChanges(
  baseline: BrowserCommentDesignBaselineView | undefined,
  editor: BrowserCommentEditorDraft
): readonly BrowserCommentStyleChangeView[] {
  if (baseline === undefined) return [];
  const changes: BrowserCommentStyleChangeView[] = [];
  if (baseline.editableText !== undefined && editor.textEdit !== undefined && editor.textEdit !== baseline.editableText) {
    changes.push({ property: "text content", previousValue: baseline.editableText, value: editor.textEdit.slice(0, 8_000) });
  }
  for (const property of BROWSER_COMMENT_DESIGN_PROPERTIES) {
    const value = editor.styleEdits[property]?.trim();
    if (value === undefined || value.length === 0) continue;
    const previousValue = baseline.styles[property] ?? "";
    if (!styleValuesEquivalent(value, previousValue)) changes.push({ property, previousValue, value: value.slice(0, 512) });
  }
  return changes;
}

export function browserCommentDesignPreview(
  baseline: BrowserCommentDesignBaselineView | undefined,
  editor: BrowserCommentEditorDraft
): BrowserCommentDesignPreview {
  const changes = browserCommentStyleChanges(baseline, editor);
  const styles: Partial<Record<BrowserCommentDesignPropertyView, string>> = {};
  let text: string | undefined;
  for (const change of changes) {
    if (change.property === "text content") text = change.value;
    else styles[change.property] = change.value;
  }
  return { styles, ...(text === undefined ? {} : { text }) };
}

export function BrowserCommentPopover({
  target,
  baseline,
  editor,
  saving,
  t,
  onChange,
  onSubmit,
  onCancel,
  onPreview,
  onReset
}: {
  readonly target: BrowserCommentTargetView;
  readonly baseline?: BrowserCommentDesignBaselineView;
  readonly editor: BrowserCommentEditorDraft;
  readonly saving: boolean;
  readonly t: Translator;
  readonly onChange: (editor: BrowserCommentEditorDraft) => void;
  readonly onSubmit: (text: string, changes: readonly BrowserCommentStyleChangeView[]) => void;
  readonly onCancel: () => void;
  readonly onPreview: (preview: BrowserCommentDesignPreview) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [showStyles, setShowStyles] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const changes = useMemo(() => browserCommentStyleChanges(baseline, editor), [baseline, editor]);
  const preview = useMemo(() => browserCommentDesignPreview(baseline, editor), [baseline, editor]);
  const canSubmit = !saving && (editor.text.trim().length > 0 || changes.length > 0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement ?? null;
    if (root === null || parent === null) return;
    const anchorX = target.point.x / target.viewport.width * parent.clientWidth;
    const anchorY = target.point.y / target.viewport.height * parent.clientHeight;
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(anchorX - width / 2, parent.clientWidth - width - 8));
    const below = anchorY + 12;
    const top = below + height <= parent.clientHeight - 8 ? below : Math.max(8, anchorY - height - 12);
    setPosition({ left, top });
    if (!showStyles) textRef.current?.focus();
  }, [showStyles, target.point.x, target.point.y, target.viewport.height, target.viewport.width]);

  useEffect(() => {
    onPreview(preview);
  }, [onPreview, preview]);

  useEffect(() => {
    if (baseline?.editableText !== undefined || editor.textEdit === undefined) return;
    onChange({ ...editor, textEdit: undefined });
  }, [baseline?.editableText, editor, onChange]);

  const setStyle = useCallback((property: BrowserCommentDesignPropertyView, value: string) => {
    onChange({ ...editor, styleEdits: { ...editor.styleEdits, [property]: value.slice(0, 512) } });
  }, [editor, onChange]);

  const submit = (): void => {
    if (canSubmit) onSubmit(editor.text.trim().slice(0, 8_000), changes);
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return <div
    ref={rootRef}
    className="browser-comment-popover"
    style={{ left: position.left, top: position.top }}
    onKeyDown={handleKey}
  >
    <textarea
      ref={textRef}
      rows={3}
      value={editor.text}
      maxLength={8_000}
      disabled={saving}
      placeholder={t("browser.commentPlaceholder")}
      onChange={(event) => onChange({ ...editor, text: event.target.value.slice(0, 8_000) })}
    />
    {baseline !== undefined && showStyles && <div className="browser-comment-popover__styles">
      {baseline.editableText !== undefined && <label><span>{t("browser.commentStyleText")}</span><input
        type="text"
        value={editor.textEdit ?? baseline.editableText}
        maxLength={8_000}
        disabled={saving}
        onChange={(event) => onChange({ ...editor, textEdit: event.target.value.slice(0, 8_000) })}
      /></label>}
      {BROWSER_COMMENT_DESIGN_PROPERTIES.map((property) => {
        const baselineValue = baseline.styles[property] ?? "";
        const value = editor.styleEdits[property] ?? baselineValue;
        const color = property === "color" || property === "background-color";
        const pickerValue = color ? opaqueHexColor(value) ?? opaqueHexColor(baselineValue) : undefined;
        return <label key={property}><span>{property}</span>{pickerValue === undefined ? <input
          type="text"
          value={value}
          maxLength={512}
          disabled={saving}
          onChange={(event) => setStyle(property, event.target.value)}
        /> : <input
          type="color"
          aria-label={property}
          value={pickerValue}
          disabled={saving}
          onChange={(event) => setStyle(property, event.target.value)}
        />}</label>;
      })}
      <Button tone="ghost" type="button" disabled={saving} onClick={() => {
        onChange({ ...editor, styleEdits: {}, textEdit: undefined });
        onReset();
      }}>{t("browser.commentStyleReset")}</Button>
    </div>}
    <footer>
      {baseline === undefined ? <span /> : <IconButton
        type="button"
        label={showStyles ? t("browser.commentStyleCollapse") : t("browser.commentStyleExpand")}
        disabled={saving}
        className={changes.length > 0 || showStyles ? "is-active" : undefined}
        onClick={() => setShowStyles((current) => !current)}
      ><SlidersHorizontal aria-hidden="true" /></IconButton>}
      <span><Button type="button" disabled={saving} onClick={onCancel}>{t("common.cancel")}</Button><Button type="button" tone="primary" disabled={!canSubmit} onClick={submit}>{saving ? t("browser.commentSaving") : t("browser.commentAdd")}</Button></span>
    </footer>
  </div>;
}

function opaqueHexColor(value: string): string | undefined {
  const color = parseCssColor(value);
  if (color === undefined || Math.abs(color.a - 1) > 0.000_1) return undefined;
  const channel = (number: number): string => Math.round(number).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}
