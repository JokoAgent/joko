import { createContext, useContext, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import type { PartnerAvatarDraft } from "../partner-avatar.js";

const AvatarOwner = createContext<{ readonly ownerKey?: string; readonly read: (partner: PartnerProfileView) => Promise<string> } | undefined>(undefined);

export function PartnerAvatarProvider({ controller, ownerKey, children }: { readonly controller: AppController; readonly ownerKey?: string; readonly children: ReactNode }): JSX.Element {
  const requests = useRef(new Map<string, { readonly abort: AbortController; readonly promise: Promise<string>; readonly bytes: number }>());
  const active = useRef(new Set<AbortController>());
  const owner = useRef(ownerKey); owner.current = ownerKey;
  useEffect(() => () => { for (const abort of active.current) abort.abort(); active.current.clear(); requests.current.clear(); }, [ownerKey]);
  const read = (partner: PartnerProfileView): Promise<string> => {
    if (!ownerKey || owner.current !== ownerKey || typeof partner.avatar === "string") return Promise.reject(new Error("No current Partner image owner."));
    const key = `${ownerKey}:${partner.id}:${partner.revision}:${partner.avatar.sha256}`;
    const existing = requests.current.get(key); if (existing) return existing.promise;
    const abort = new AbortController();
    active.current.add(abort);
    const promise = controller.readPartnerAvatar(partner.id, partner.revision, partner.avatar, abort.signal).then((uri) => {
      abort.signal.throwIfAborted();
      if (owner.current !== ownerKey) throw new Error("The Partner image owner changed.");
      return uri;
    }).finally(() => active.current.delete(abort));
    requests.current.set(key, { abort, promise, bytes: partner.avatar.byteLength });
    void promise.catch(() => { if (requests.current.get(key)?.promise === promise) requests.current.delete(key); });
    let total = 0;
    for (const value of requests.current.values()) total += value.bytes;
    for (const [candidate, value] of requests.current) {
      if (requests.current.size <= 32 && total <= 8 * 1024 * 1024) break;
      if (candidate === key) continue;
      requests.current.delete(candidate); total -= value.bytes;
    }
    return promise;
  };
  return <AvatarOwner.Provider value={{ ownerKey, read }}>{children}</AvatarOwner.Provider>;
}

export function PartnerAvatar({ preset, partner }: { readonly preset: PartnerAvatarDraft; readonly partner?: PartnerProfileView }): JSX.Element {
  const owner = useContext(AvatarOwner);
  const read = owner?.ownerKey ? owner.read : undefined;
  const readRef = useRef(read); readRef.current = read;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly uri: string }>();
  const key = typeof preset === "string" ? preset : "base64" in preset ? preset.base64
    : `${owner?.ownerKey}:${partner?.id}:${partner?.revision}:${preset.sha256}`;
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let current = true; let observer: IntersectionObserver | undefined;
    if (typeof preset !== "string" && !("base64" in preset) && partner && readRef.current) {
      const start = (): void => { observer?.disconnect(); void readRef.current!(partner).then((uri) => {
        if (current) setLoaded({ key, uri });
      }).catch(() => undefined); };
      if (typeof IntersectionObserver === "undefined" || !ref.current) start();
      else { observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) start(); }, { rootMargin: "100px" }); observer.observe(ref.current); }
    }
    return () => { current = false; observer?.disconnect(); };
  }, [key, partner, read !== undefined]);
  const uri = typeof preset !== "string" && "base64" in preset ? `data:image/jpeg;base64,${preset.base64}`
    : loaded?.key === key && read ? loaded.uri : undefined;
  const token = typeof preset === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(preset) ? preset : "photo";
  return <span ref={ref} className={`partner-avatar partner-avatar--${token}`} aria-hidden="true">
    {uri ? <img src={uri} alt="" /> : <span />}
  </span>;
}
