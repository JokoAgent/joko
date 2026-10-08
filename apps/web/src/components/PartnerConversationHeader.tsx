import { Menu, RefreshCcw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import type { AppController } from "../controller.js";
import type { PartnerListView, PartnerMutationView, PartnerProfileView, SessionView } from "../model.js";
import { PartnerAvatar, PartnerSettingsDialog } from "./PartnersPage.js";
import { IconButton, Spinner } from "./ui.js";
import type { Translator } from "./types.js";

type ConversationIdentity =
  | { readonly kind: "task" }
  | { readonly kind: "partner"; readonly catalog: PartnerListView; readonly partner: PartnerProfileView };

interface IdentityProjection {
  readonly owner: object;
  readonly phase: "loading" | "ready" | "failed";
  readonly identity?: ConversationIdentity;
}

interface PartnerConversationHeaderProps {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly navigationOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly t: Translator;
  readonly children: ReactNode;
}

export function PartnerConversationHeader(props: PartnerConversationHeaderProps): JSX.Element {
  const { controller, session } = props;
  const profile = controller.state.activeProfile;
  const ownerKey = JSON.stringify([
    profile?.id, profile?.serverId, profile?.origin,
    String(controller.state.snapshot.generation), session.id, session.targetId, String(session.generation)
  ]);
  return <PartnerConversationHeaderOwner key={ownerKey} {...props} ownerKey={ownerKey} />;
}

function PartnerConversationHeaderOwner({ controller, session, navigationOpen, onOpenNavigation, t, children, ownerKey }: PartnerConversationHeaderProps & {
  readonly ownerKey: string;
}): JSX.Element {
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  const [refresh, setRefresh] = useState(0);
  const [documentActive, setDocumentActive] = useState(true);
  const conversationOwner = useMemo(() => ({}), [connected, documentActive]);
  const conversationOwnerRef = useRef(conversationOwner);
  conversationOwnerRef.current = conversationOwner;
  const requestOwner = useMemo(() => ({}), [connected, refresh, documentActive]);
  const requestOwnerRef = useRef(requestOwner);
  requestOwnerRef.current = requestOwner;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [projection, setProjection] = useState<IdentityProjection>();
  const [settingsOwner, setSettingsOwner] = useState<object>();

  useEffect(() => {
    const hide = (): void => {
      requestOwnerRef.current = {};
      conversationOwnerRef.current = {};
      setDocumentActive(false);
    };
    const show = (): void => { setDocumentActive(true); setRefresh((value) => value + 1); };
    const visible = (): void => { if (document.visibilityState === "visible") setRefresh((value) => value + 1); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  useEffect(() => {
    if (!connected || !documentActive) return;
    const abort = new AbortController();
    let alive = true;
    const current = (): boolean => alive && !abort.signal.aborted && requestOwnerRef.current === requestOwner;
    setProjection((previous) => ({
      owner: requestOwner, phase: "loading",
      ...(previous?.identity?.kind === "partner" ? { identity: previous.identity } : {})
    }));
    void (async () => {
      const catalog = await controllerRef.current.listPartners(undefined, abort.signal);
      if (!current()) return;
      const candidates = catalog.partners.filter((partner) => partner.canonicalSessionId === session.id);
      if (candidates.length === 0) {
        setProjection({ owner: requestOwner, phase: "ready", identity: { kind: "task" } });
        return;
      }
      const partner = candidates[0];
      if (candidates.length !== 1 || partner === undefined || !ownsConversation(partner, session)) throw new Error("Partner conversation ownership is unavailable.");
      const links = await controllerRef.current.listPartnerSessions(partner.id, abort.signal);
      if (!current()) return;
      const canonical = links.filter((link) => link.role === "canonical");
      const link = canonical[0];
      if (canonical.length !== 1 || link === undefined || link.partnerId !== partner.id || link.sessionId !== session.id
        || !link.available || link.deleted || link.profileVersion > partner.profileVersion) throw new Error("Partner canonical session is unavailable.");
      setProjection((previous) => ({
        owner: requestOwner, phase: "ready",
        identity: previous?.identity?.kind === "partner" && previous.identity.partner.id === partner.id
          && previous.identity.partner.revision > partner.revision
          ? previous.identity : { kind: "partner", catalog, partner }
      }));
    })().catch(() => {
      if (current()) setProjection((previous) => ({
        owner: requestOwner, phase: "failed",
        ...(previous?.identity?.kind === "partner" ? { identity: previous.identity } : {})
      }));
    });
    return () => { alive = false; abort.abort(); };
  }, [connected, documentActive, requestOwner, session.id, session.targetId]);

  const confirmed = projection?.owner === requestOwner && projection.phase === "ready";
  if (projection?.identity?.kind === "task" && (confirmed || !connected)) return <>{children}</>;
  const identity = projection?.identity?.kind === "partner" ? projection.identity : undefined;
  const editable = connected && documentActive && confirmed && identity !== undefined;
  const failed = !connected || projection?.owner === requestOwner && projection.phase === "failed";
  const openSettings = (): void => { if (editable) setSettingsOwner(conversationOwner); };
  const acceptMutation = (result: PartnerMutationView): void => {
    if (conversationOwnerRef.current !== conversationOwner || !connected || !documentActive || identity === undefined) return;
    if (result.partner.id !== identity.partner.id || !ownsConversation(result.partner, session)) {
      setSettingsOwner(undefined);
      setRefresh((value) => value + 1);
      return;
    }
    setProjection((previous) => ({
      owner: requestOwnerRef.current, phase: "ready",
      identity: previous?.identity?.kind === "partner" && previous.identity.partner.id === result.partner.id
        && previous.identity.partner.revision > result.partner.revision ? previous.identity : {
        kind: "partner", partner: result.partner,
        catalog: {
          directory: result.directory,
          partners: identity.catalog.partners.map((partner) => partner.id === result.partner.id ? result.partner : partner)
        }
      }
    }));
  };

  return <>
    <header className="session-header partner-conversation-header" aria-busy={!confirmed && !failed}>
      <div className="session-header__leading">
        {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
        {identity !== undefined ? <button
          type="button" className="partner-conversation-identity" onClick={openSettings} disabled={!editable}
          aria-label={t("partners.settingsTitle", { name: identity.partner.displayName })}
          title={t("partners.settingsTitle", { name: identity.partner.displayName })}
        ><PartnerAvatar preset={identity.partner.avatar} /><span>{identity.partner.displayName}</span></button>
          : <span className="partner-conversation-placeholder">{!failed && <Spinner />}{failed ? session.name : t("partners.loading")}</span>}
      </div>
      <div className="session-header__actions">
        {failed && <span className="partner-conversation-error" role="status">{t("partners.reloadFailed")}</span>}
        {failed && connected && <IconButton label={t("common.retry")} onClick={() => setRefresh((value) => value + 1)}><RefreshCcw aria-hidden="true" /></IconButton>}
        {identity !== undefined && <IconButton label={t("partners.profileSettings")} onClick={openSettings} disabled={!editable} aria-haspopup="dialog"><Settings2 aria-hidden="true" /></IconButton>}
      </div>
    </header>
    {connected && documentActive && !failed && settingsOwner === conversationOwner && identity !== undefined && <PartnerSettingsDialog
      key={`${ownerKey}\u0000${identity.partner.id}`}
      partner={identity.partner} partners={identity.catalog.partners} directory={identity.catalog.directory}
      snapshot={controller.state.snapshot} controller={controller} ownerKey={ownerKey} t={t}
      initialSection="profile" showClose
      onClose={() => setSettingsOwner(undefined)} onUpdated={acceptMutation}
      onActivityUpdated={(partner) => acceptMutation({ partner, directory: identity.catalog.directory })}
    />}
  </>;
}

function ownsConversation(partner: PartnerProfileView, session: SessionView): boolean {
  return partner.lifecycle !== "deleted" && partner.initializationState === "ready"
    && partner.canonicalSessionId === session.id && partner.homeTargetId === session.targetId;
}
