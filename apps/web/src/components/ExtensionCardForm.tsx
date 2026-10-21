import { useLayoutEffect, useRef, useState } from "react";
import { extensionCardRecipients, fitExtensionCardRecipients, extensionCardFieldMaxValue, visibleMailAttachments,
  removeMailAttachment, insertMailImage, canInsertMailImage, mailPreviewImages, type ExtensionCardFormField } from "@joko/contracts";
import type { Translator } from "./types.js";
import { ExtensionMailPreview } from "./ExtensionMailPreview.js";

export function ExtensionCardForm({ fields, values, disabled, expanded, t, onChange, images = [], onAttachment }: {
  readonly fields: ExtensionCardFormField[]; readonly values: Record<string, string>; readonly disabled: boolean;
  readonly expanded: boolean; readonly t: Translator; readonly onChange: (values: Record<string, string>) => void;
  readonly images?: { cid: string; url: string }[];
  readonly onAttachment?: (file: File, inline: boolean) => void;
}) {
  const change = (name: string, value: string) => onChange({ ...values, [name]: value });
  const recipients = fields.filter(field => field.kind === "recipients");
  return <div className="extension-card-form">
    {recipients.length > 0 && <Recipients fields={recipients} values={values} disabled={disabled} t={t} onChange={change} />}
    {fields.map(field => {
      if (field.kind === "hidden" || field.kind === "recipients") return null;
      const value = values[field.name] ?? field.value;
      if (field.kind === "mail-html") return <ExtensionMailPreview key={field.name} value={value} disabled={disabled} expanded={expanded}
        images={[...images, ...mailPreviewImages(values)]} title={t("extensionCards.mailPreview")}
        onChange={disabled ? undefined : (html, text) => {
          const plain = field.name === "quoteHtml" ? "quote" : "body";
          onChange({ ...values, [field.name]: html, ...(plain in values ? { [plain]: text } : {}) });
        }} />;
      if (field.kind === "mail-attachments") return <div key={field.name} className="extension-card-form__attachments">
        {visibleMailAttachments(values, field.name).map(file => <div key={file.key} className="extension-card-form__attachment">
          <span title={file.filename}>{file.filename}{file.bytes !== undefined ? ` · ${Math.ceil(file.bytes / 1024)} KB` : ""}</span>
          {!disabled && canInsertMailImage(values, file) && <button type="button" onClick={() => onChange(insertMailImage(values, field.name, file.key))}>{t("extensionCards.insertImage")}</button>}
          {!disabled && <button type="button" aria-label={t("extensionCards.removeAttachment", { name: file.filename })}
            onClick={() => onChange(removeMailAttachment(values, field.name, file.key))}>×</button>}
        </div>)}
        {!disabled && onAttachment && <>
          <AttachmentPicker label={t("extensionCards.attachFile")} onSelect={file => onAttachment(file, false)} />
          {typeof values.bodyHtml === "string" && <AttachmentPicker label={t("extensionCards.insertImage")} images onSelect={file => onAttachment(file, true)} />}
        </>}
      </div>;
      const control = disabled ? <div className="extension-card-form__static">{value}</div> : field.multiline
        ? <GrowingTextarea label={field.label} value={value} maxLength={extensionCardFieldMaxValue(field.name)} expanded={expanded} onChange={text => change(field.name, text)} />
        : <input aria-label={field.label} value={value} maxLength={extensionCardFieldMaxValue(field.name)} onChange={event => change(field.name, event.target.value)} />;
      if (field.collapsed) return <details key={field.name} className="extension-card-form__collapsed"><summary>{field.label}</summary>{control}</details>;
      return <label key={field.name} className={`extension-card-form__field${field.multiline ? " is-multiline" : ""}${field.row ? " is-grouped" : ""}`}>
        {!field.multiline && <span>{field.label}</span>}{control}
      </label>;
    })}
  </div>;
}
function AttachmentPicker({ label, images, onSelect }: { label: string; images?: boolean; onSelect(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} type="file" aria-label={label} hidden accept={images ? "image/png,image/jpeg,image/gif,image/webp" : undefined}
    onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) onSelect(file); }} />
    <button type="button" onClick={() => input.current?.click()}>{label}</button></>;
}
function GrowingTextarea({ value, label, maxLength, expanded, onChange }: {
  value: string; label: string; maxLength: number; expanded: boolean; onChange(value: string): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const fit = () => { if (!node.clientWidth) return; node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight + 2, expanded ? 1200 : 440)}px`; };
    fit(); let width = node.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (node.clientWidth !== width) { width = node.clientWidth; fit(); } });
    observer?.observe(node); return () => observer?.disconnect();
  }, [value, expanded]);
  return <textarea ref={input} aria-label={label} rows={3} value={value} maxLength={maxLength} onChange={event => onChange(event.target.value)} />;
}
function Recipients({ fields, values, disabled, t, onChange }: {
  fields: ExtensionCardFormField[]; values: Record<string, string>; disabled: boolean; t: Translator; onChange(name: string, value: string): void;
}) {
  const [expanded, setExpanded] = useState(false), [counts, setCounts] = useState<number[]>([]);
  const root = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const summary = fields.filter(field => field.name !== "bcc" && !field.collapsed);
  const entries = summary.map(field => extensionCardRecipients(values[field.name] ?? field.value));
  const signature = JSON.stringify([fields, values]);
  useLayoutEffect(() => {
    const node = root.current, probe = measure.current;
    if (!node || !probe || expanded) return;
    const layout = () => {
      const width = (key: string) => probe.querySelector<HTMLElement>(`[data-measure="${key}"]`)?.getBoundingClientRect().width ?? 0;
      node.style.setProperty("--extension-card-toggle-width", `${Math.ceil(width("toggle")) + 12}px`);
      const groups = entries.map((items, i) => ({ label: width(`label-${i}`), chips: items.map((_, j) => width(`chip-${i}-${j}`)),
        more: Array.from({ length: items.length + 1 }, (_, j) => width(`more-${i}-${j}`)) }));
      const next = fitExtensionCardRecipients(Math.max(0, node.clientWidth - width("toggle") - summary.length * 12), groups);
      setCounts(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    layout(); const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(layout);
    observer?.observe(node); observer?.observe(probe); return () => observer?.disconnect();
  }, [signature, expanded, t]);
  const toggle = expanded ? t("extensionCards.collapseFields") : t("extensionCards.expandFields");
  return <div ref={root} className="extension-card-recipients">
    {expanded ? <>{fields.map(field => <label className="extension-card-form__field" key={field.name}><span>{field.label}</span>
      {disabled ? <div className="extension-card-form__static">{values[field.name]}</div> : <textarea aria-label={field.label} rows={1}
        value={values[field.name] ?? field.value} maxLength={extensionCardFieldMaxValue(field.name)} onChange={event => onChange(field.name, event.target.value)} />}
    </label>)}</> : <div className="extension-card-recipients__summary">{summary.map((field, i) => <div className="extension-card-recipients__group" key={field.name}>
      <span>{field.label}</span>{entries[i]!.slice(0, counts[i] ?? entries[i]!.length).map((entry, j) => <button key={j} type="button"
        className="extension-card-recipients__chip" title={entry.address} onClick={() => setExpanded(true)}>{entry.label}</button>)}
      {entries[i]!.length > (counts[i] ?? entries[i]!.length) && <button type="button" className="extension-card-recipients__more" onClick={() => setExpanded(true)}>+{entries[i]!.length - counts[i]!}</button>}
    </div>)}</div>}
    <button type="button" className="extension-card-recipients__toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{toggle}</button>
    {!expanded && <div ref={measure} className="extension-card-recipients__measure" aria-hidden="true">
      {summary.map((field, i) => <div key={field.name}><span data-measure={`label-${i}`}>{field.label}</span>
        {entries[i]!.map((entry, j) => <span key={j} className="extension-card-recipients__chip" data-measure={`chip-${i}-${j}`}>{entry.label}</span>)}
        {Array.from({ length: entries[i]!.length + 1 }, (_, j) => <span key={j} className="extension-card-recipients__more" data-measure={`more-${i}-${j}`}>+{j || ""}</span>)}
      </div>)}<span className="extension-card-recipients__toggle" data-measure="toggle">{toggle}</span>
    </div>}
  </div>;
}
