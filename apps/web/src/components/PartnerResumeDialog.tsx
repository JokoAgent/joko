import { useEffect, useMemo, useRef, useSyncExternalStore, type JSX } from "react";
import { PartnerResumeEditor, partnerResumeMessages } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { Button, Modal } from "./ui.js";

const resumeProfile = (profile: PartnerProfileView) => ({ ...profile, partnerId: profile.id,
  backendId: profile.capabilities.modelChain[0]?.backendId ?? "" });

export function PartnerResumeDialog({ controller, ownerKey, foreground, partner, onClose, onChanged, onBusyChange }: {
  readonly controller: AppController; readonly ownerKey: string; readonly foreground: boolean;
  readonly partner: PartnerProfileView; readonly onClose: () => void;
  readonly onChanged: (partner: PartnerProfileView) => void; readonly onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const current = useRef({ controller, ownerKey, onChanged, onBusyChange });
  current.current = { controller, ownerKey, onChanged, onBusyChange };
  const editor = useMemo(() => new PartnerResumeEditor({ ownerKey,
    read: async signal => { const value = await current.current.controller.getPartner(partner.id, signal);
      signal.throwIfAborted(); if (current.current.ownerKey !== ownerKey) throw new Error("The Partner owner changed.");
      return resumeProfile(value); },
    resume: async (selected, signal) => {
      signal.throwIfAborted(); if (current.current.ownerKey !== ownerKey) throw new Error("The Partner owner changed.");
      const result = await current.current.controller.setPartnerLifecycle(selected.partnerId, selected.revision, "active", signal);
      signal.throwIfAborted(); if (current.current.ownerKey !== ownerKey) throw new Error("The Partner owner changed.");
      return resumeProfile(result.partner);
    }
  }, resumeProfile(partner)), [ownerKey, partner.id]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const online = foreground && controller.state.connectionState === "connected";
  const m = partnerResumeMessages(controller.state.effectiveLocale);
  const notified = useRef<bigint | undefined>(undefined);
  useEffect(() => { if (online) editor.activate(); else editor.suspend(); }, [editor, online]);
  useEffect(() => () => editor.dispose(), [editor]);
  useEffect(() => { current.current.onBusyChange?.(online && editor.busy); }, [online, state.phase]);
  useEffect(() => { if (online && state.phase === "completed" && state.profile && notified.current !== state.profile.revision) {
    notified.current = state.profile.revision; current.current.onChanged(state.profile);
  } }, [online, state]);
  return <Modal open title={m.title.replace("{name}", online ? state.profile?.displayName ?? partner.displayName : "")}
    description={m.body} size="small" onClose={editor.busy && online ? () => undefined : onClose}>
    <div className="partner-delete-dialog">
      {state.phase === "loading" && <p role="status">{m.loading}</p>}
      {state.phase === "resuming" && <p role="status">{m.working}</p>}
      {state.phase === "completed" && <p role="status">{m.completed}</p>}
      {state.phase === "suspended" && <p role="status">{m.suspended}</p>}
      {state.profile?.lifecycle === "paused" && <p role="status">{state.profile.pauseCleanupPending ? m.cleanup : m.paused}</p>}
      {state.error && <p role="alert">{m[state.error]}</p>}
      <div className="modal__actions">
        <Button disabled={editor.busy && online} onClick={onClose}>{state.phase === "completed" ? m.close : m.cancel}</Button>
        {state.phase !== "completed" && <Button disabled={!online || editor.busy} onClick={() => void editor.refresh()}>{m.refresh}</Button>}
        {state.phase !== "completed" && <Button tone="primary" disabled={!online || !editor.available} onClick={() => void editor.resume()}>{m.action}</Button>}
      </div>
    </div>
  </Modal>;
}
