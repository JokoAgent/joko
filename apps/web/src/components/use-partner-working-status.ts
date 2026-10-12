import { useEffect, useRef, useState } from "react";
import { hasPublicWorkingSubject, workingStatusTurnKey, type SessionWorkingStatus } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";

export function partnerWorkingOwnerKey(controller: AppController): string {
  const state = controller.state;
  return JSON.stringify([state.activeProfile?.id, state.activeProfile?.serverId, state.activeProfile?.origin,
    state.activeProfile?.deviceId, state.connectionGeneration, state.connectionState, state.snapshot.generation.toString()]);
}

export function usePartnerDocumentForeground(ownerDocument: Document = document): boolean {
  const [foreground, setForeground] = useState(() => ({ owner: ownerDocument, active: ownerDocument.visibilityState === "visible" }));
  useEffect(() => {
    const ownerWindow = ownerDocument.defaultView;
    let active = true;
    const update = (): void => setForeground({ owner: ownerDocument, active: active && ownerWindow !== null && !ownerWindow.closed && ownerDocument.visibilityState === "visible" });
    const hide = (): void => { active = false; update(); };
    const show = (): void => { active = true; update(); };
    update();
    ownerWindow?.addEventListener("pagehide", hide);
    ownerWindow?.addEventListener("pageshow", show);
    ownerDocument.addEventListener("visibilitychange", update);
    return () => { ownerWindow?.removeEventListener("pagehide", hide); ownerWindow?.removeEventListener("pageshow", show);
      ownerDocument.removeEventListener("visibilitychange", update); };
  }, [ownerDocument]);
  return foreground.owner === ownerDocument && foreground.active;
}

/** The selected conversation reads live facts independently of its historical message window. */
export function usePartnerWorkingProfile(controller: AppController, partner: PartnerProfileView | undefined,
  scope: string, active: boolean): { readonly profile: PartnerProfileView; readonly observed: boolean } | undefined {
  const key = JSON.stringify([scope, partner?.id, partner?.revision.toString(), active]);
  const [result, setResult] = useState<{ readonly key: string; readonly profile?: PartnerProfileView }>();
  const current = useRef({ controller, key }); current.current = { controller, key };
  useEffect(() => {
    if (!active || !partner) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const value = await current.current.controller.getPartner(partner.id, abort.signal);
        if (abort.signal.aborted || current.current.key !== key) return;
        if (value.id !== partner.id || value.revision < partner.revision) throw new Error("The Partner working owner changed.");
        setResult({ key, profile: value });
        if (value.lifecycle === "active" && value.initializationState === "ready" && value.activity.workingStatus) {
          timer = setTimeout(() => { void read(); }, 1000);
        }
      } catch {
        if (!abort.signal.aborted && current.current.key === key) setResult({ key });
      }
    };
    void read();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [key]);
  if (!active || !partner) return undefined;
  if (result?.key !== key) return { profile: partner, observed: false };
  if (result.profile) return { profile: result.profile, observed: true };
  const { workingStatus: _working, ...activity } = partner.activity;
  return { profile: { ...partner, activity }, observed: false };
}

/** Both surfaces consume the Host's per-turn/per-language single-phase cache. */
export function usePartnerWorkingCaption(controller: AppController, partner: PartnerProfileView,
  status: SessionWorkingStatus | undefined, ownerKey: string): string | undefined {
  const locale = controller.state.effectiveLocale;
  const scope = JSON.stringify([ownerKey, partner.id, partner.revision.toString(), status && workingStatusTurnKey(status), status?.phase, locale]);
  const [caption, setCaption] = useState<{ readonly scope: string; readonly text: string }>();
  const current = useRef({ controller, scope }); current.current = { controller, scope };
  useEffect(() => {
    if (!status || !hasPublicWorkingSubject(status.phase) || locale !== "en" && locale !== "zh-CN") return;
    const abort = new AbortController();
    void current.current.controller.readPartnerWorkingStatus(partner.id, status, locale, abort.signal).then((text) => {
      if (!abort.signal.aborted && current.current.scope === scope && text?.trim()) setCaption({ scope, text });
    }).catch(() => { /* The factual label remains immediately available. */ });
    return () => abort.abort();
  }, [scope]);
  return status && caption?.scope === scope ? caption.text : undefined;
}
