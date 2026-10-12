import { useEffect, useRef, useState, type JSX } from "react";
import { partnerAvatarInput, preparePartnerPhoto, type PartnerAvatarDraft } from "../partner-avatar.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import { cx } from "./ui.js";
import type { Translator } from "./types.js";
import type { PartnerProfileView } from "../model.js";

export function AvatarPicker({ value, options, ownerKey, disabled = false, t, onChange, onPreparing, partner }: {
  readonly value: PartnerAvatarDraft; readonly options: readonly string[]; readonly disabled?: boolean; readonly t: Translator;
  readonly onChange: (value: string | { readonly base64: string }) => void; readonly onPreparing: (preparing: boolean) => void;
  readonly partner?: PartnerProfileView;
  readonly ownerKey: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null); const request = useRef<AbortController | undefined>(undefined);
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const ownerRef = useRef(ownerKey); ownerRef.current = ownerKey;
  const callbacks = useRef({ onChange, onPreparing }); callbacks.current = { onChange, onPreparing };
  useEffect(() => {
    request.current = undefined; setBusy(false); setFailed(false);
    const retire = (): void => { request.current?.abort(); callbacks.current.onPreparing(false); };
    window.addEventListener("pagehide", retire);
    return () => { retire(); window.removeEventListener("pagehide", retire); };
  }, [ownerKey]);
  return <fieldset className="partner-avatar-picker" disabled={disabled || busy}><legend>{t("partners.avatar")}</legend><div>
    {options.map((option) => <button type="button" key={option} className={cx(value === option && "is-selected")}
      aria-label={t("partners.avatarOption", { name: option })} aria-pressed={value === option} onClick={() => onChange(option)}><PartnerAvatar preset={option} /></button>)}
    <button type="button" aria-label={t("partners.uploadAvatar")} aria-pressed={typeof value !== "string"}
      className={cx(typeof value !== "string" && "is-selected")} onClick={() => input.current?.click()}>
      {typeof value !== "string" ? <PartnerAvatar preset={value} partner={partner} /> : <span className="partner-avatar-upload">+</span>}
    </button>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("partners.uploadAvatar")} hidden
      onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file || disabledRef.current || request.current) return;
        const abort = new AbortController(); request.current = abort; setBusy(true); setFailed(false); callbacks.current.onPreparing(true);
        void preparePartnerPhoto(file, abort.signal).then((photo) => {
          if (!abort.signal.aborted && ownerRef.current === ownerKey && !disabledRef.current && partnerAvatarInput(photo)) callbacks.current.onChange(photo);
        }).catch(() => { if (!abort.signal.aborted) setFailed(true); }).finally(() => {
          if (request.current === abort) { request.current = undefined; callbacks.current.onPreparing(false); if (!abort.signal.aborted) setBusy(false); }
        });
      }} />
  </div>{busy && <p role="status">{t("common.loading")}</p>}{failed && <p role="alert">{t("partners.avatarFailed")}</p>}</fieldset>;
}
