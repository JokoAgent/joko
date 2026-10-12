import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import type { AppController } from "../controller.js";
import type { PartnerListView, PartnerMutationView, PartnerProfileView, SessionView } from "../model.js";
import { isLoopbackHostname } from "../connection-origin.js";
import { PartnerSettingsDialog } from "./PartnersPage.js";
import type { Translator } from "./types.js";

type ConversationIdentity =
  | { readonly kind: "task" }
  | { readonly kind: "partner"; readonly catalog: PartnerListView; readonly partner: PartnerProfileView };

interface IdentityProjection {
  readonly key: string;
  readonly owner: object;
  readonly phase: "loading" | "ready" | "failed";
  readonly identity?: ConversationIdentity;
}

export interface PartnerConversationView {
  readonly sessionId: string;
  readonly ownerKey: string;
  readonly kind?: "task" | "partner";
  readonly partner?: PartnerProfileView;
  readonly confirmed: boolean;
  readonly editable: boolean;
  readonly failed: boolean;
  readonly connected: boolean;
  readonly entryReadCursor?: bigint;
  readonly readFailed: boolean;
  readonly readRetry: number;
  readonly acknowledge: (cursor: bigint) => void;
  readonly retryRead: () => void;
  readonly refresh: () => void;
  readonly openSettings: (section?: "profile" | "activity") => void;
  readonly openPrivateThread: (threadId: string) => void;
  readonly workbenchAvailable: boolean;
  readonly workbenchRequest?: number;
  readonly workbenchOpenFailed: boolean;
  readonly openWorkbench: () => void;
}

const PartnerConversationContext = createContext<PartnerConversationView | undefined>(undefined);
export function usePartnerConversation(): PartnerConversationView | undefined { return useContext(PartnerConversationContext); }

export function PartnerConversationScope({ session, ...props }: Omit<Parameters<typeof PartnerConversationProvider>[0], "session"> & { readonly session?: SessionView }): JSX.Element {
  return session === undefined ? <>{props.children}</> : <PartnerConversationProvider {...props} session={session} />;
}

/** One authenticated view owner supplies identity to the header, messages and
 * input without remounting the conversation or moving its frozen entry cursor. */
export function PartnerConversationProvider({ controller, session, active, t, children }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly active: boolean;
  readonly t: Translator;
  readonly children: ReactNode;
}): JSX.Element {
  const profile = controller.state.activeProfile;
  const ownerKey = JSON.stringify([profile?.id, profile?.serverId, profile?.origin,
    String(controller.state.snapshot.generation), session.id, session.targetId, String(session.generation)]);
  const connected = controller.state.ready && controller.state.connectionState === "connected";
  const [refresh, setRefresh] = useState(0);
  const [documentActive, setDocumentActive] = useState(true);
  const conversationOwner = useMemo(() => ({}), [ownerKey, connected, documentActive]);
  const conversationOwnerRef = useRef(conversationOwner);
  conversationOwnerRef.current = conversationOwner;
  const requestOwner = useMemo(() => ({}), [conversationOwner, refresh]);
  const requestOwnerRef = useRef(requestOwner);
  requestOwnerRef.current = requestOwner;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [projection, setProjection] = useState<IdentityProjection>();
  const [settings, setSettings] = useState<{ readonly owner: object; readonly section: "profile" | "activity"; readonly threadId?: string }>();
  const entryReadRef = useRef<{ readonly owner: object; readonly partnerId: string; readonly cursor: bigint } | undefined>(undefined);
  const [readRetry, setReadRetry] = useState(0);
  const [readFailure, setReadFailure] = useState<object>();
  const [workbenchRequest, setWorkbenchRequest] = useState<{ readonly owner: string; readonly sequence: number }>();
  const [workbenchOpenFailure, setWorkbenchOpenFailure] = useState<object>();
  const readFlightRef = useRef<{ readonly owner: object; readonly abort: AbortController; pending: bigint; committed: bigint; running: boolean; failed: boolean } | undefined>(undefined);
  if (readFlightRef.current?.owner !== conversationOwner) {
    readFlightRef.current?.abort.abort();
    readFlightRef.current = { owner: conversationOwner, abort: new AbortController(), pending: 0n, committed: 0n, running: false, failed: false };
  }

  useEffect(() => {
    const hide = (): void => {
      requestOwnerRef.current = {};
      conversationOwnerRef.current = {};
      readFlightRef.current?.abort.abort();
      setDocumentActive(false);
    };
    const show = (): void => { setDocumentActive(true); setRefresh((value) => value + 1); };
    const visible = (): void => { if (document.visibilityState === "visible") setRefresh((value) => value + 1); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", visible);
    return () => {
      requestOwnerRef.current = {};
      conversationOwnerRef.current = {};
      readFlightRef.current?.abort.abort();
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
    setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "loading",
      ...(previous?.key === ownerKey && previous.identity?.kind === "partner" ? { identity: previous.identity } : {}) }));
    void (async () => {
      const catalog = await controllerRef.current.listPartners(undefined, abort.signal);
      if (!current()) return;
      const candidates = catalog.partners.filter((partner) => partner.canonicalSessionId === session.id);
      if (candidates.length === 0) {
        setProjection({ key: ownerKey, owner: requestOwner, phase: "ready", identity: { kind: "task" } });
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
      setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "ready",
        identity: retainNewerIdentity(previous?.key === ownerKey ? previous.identity : undefined, { kind: "partner", catalog, partner }) }));
    })().catch(() => {
      if (current()) setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "failed",
        ...(previous?.key === ownerKey && previous.identity?.kind === "partner" ? { identity: previous.identity } : {}) }));
    });
    return () => { alive = false; abort.abort(); };
  }, [connected, documentActive, requestOwner, ownerKey, session.id, session.targetId]);

  const confirmed = projection?.key === ownerKey && projection.owner === requestOwner && projection.phase === "ready";
  const identity = projection?.key === ownerKey ? projection.identity : undefined;
  const partnerIdentity = identity?.kind === "partner" ? identity : undefined;
  const editable = connected && documentActive && confirmed && partnerIdentity !== undefined;
  const failed = !connected || projection?.owner === requestOwner && projection.phase === "failed";
  if (editable && partnerIdentity !== undefined && (entryReadRef.current?.owner !== conversationOwner || entryReadRef.current.partnerId !== partnerIdentity.partner.id)) {
    entryReadRef.current = { owner: conversationOwner, partnerId: partnerIdentity.partner.id, cursor: partnerIdentity.partner.activity.readThroughCursor };
  }
  const readContextRef = useRef({ editable, active, partnerIdentity, session });
  readContextRef.current = { editable, active, partnerIdentity, session };
  const acceptMutation = (result: PartnerMutationView): void => {
    if (conversationOwnerRef.current !== conversationOwner || !connected || !documentActive || partnerIdentity === undefined) return;
    if (result.partner.id !== partnerIdentity.partner.id || !ownsConversation(result.partner, session)) {
      setSettings(undefined); setRefresh((value) => value + 1); return;
    }
    setProjection((previous) => ({ key: ownerKey, owner: requestOwnerRef.current, phase: "ready",
      identity: retainNewerIdentity(previous?.key === ownerKey ? previous.identity : undefined, {
          kind: "partner", partner: result.partner,
          catalog: { directory: result.directory, partners: partnerIdentity.catalog.partners.map((partner) => partner.id === result.partner.id ? result.partner : partner) }
        }) }));
  };

  const acknowledge = useCallback((cursor: bigint): void => {
    const flight = readFlightRef.current;
    const context = readContextRef.current;
    const visible = (): boolean => flight !== undefined && !flight.abort.signal.aborted
      && conversationOwnerRef.current === conversationOwner && readContextRef.current.editable && readContextRef.current.active
      && !["running", "waiting", "retrying"].includes(readContextRef.current.session.state)
      && document.visibilityState === "visible" && document.hasFocus();
    if (flight === undefined || flight.owner !== conversationOwner || cursor <= 0n || !visible() || context.partnerIdentity === undefined) return;
    const partnerId = context.partnerIdentity.partner.id;
    flight.committed = maxCursor(flight.committed, context.partnerIdentity.partner.activity.readThroughCursor);
    flight.pending = maxCursor(flight.pending, cursor);
    if (flight.running || flight.failed || flight.pending <= flight.committed) return;
    flight.running = true;
    void (async () => {
      while (flight.pending > flight.committed && visible()) {
        const requested = flight.pending;
        const current = await controllerRef.current.getPartner(partnerId, flight.abort.signal);
        if (!visible()) return;
        if (current.id !== partnerId || !ownsConversation(current, readContextRef.current.session)) throw new Error("Partner read owner changed.");
        flight.committed = maxCursor(flight.committed, current.activity.readThroughCursor);
        if (requested <= flight.committed) continue;
        const links = await controllerRef.current.listPartnerSessions(partnerId, flight.abort.signal);
        if (!visible()) return;
        const canonical = links.filter((link) => link.role === "canonical");
        if (canonical.length !== 1 || canonical[0]?.partnerId !== partnerId || canonical[0].sessionId !== readContextRef.current.session.id
          || !canonical[0].available || canonical[0].deleted || canonical[0].profileVersion > current.profileVersion) throw new Error("Partner read link changed.");
        const activity = await controllerRef.current.markPartnerRead(partnerId, requested, flight.abort.signal);
        if (!visible()) return;
        if (activity.partnerId !== partnerId || activity.readThroughCursor < requested) throw new Error("Partner read acknowledgement is invalid.");
        flight.committed = maxCursor(flight.committed, activity.readThroughCursor);
        setProjection((previous) => previous?.key === ownerKey && previous.identity?.kind === "partner" && previous.identity.partner.id === partnerId
          ? { ...previous, identity: { ...previous.identity, partner: { ...previous.identity.partner, activity } } } : previous);
        setReadFailure(undefined);
      }
    })().catch(() => {
      if (!flight.abort.signal.aborted && conversationOwnerRef.current === conversationOwner) {
        flight.failed = true; setReadFailure(conversationOwner);
      }
    }).finally(() => { flight.running = false; });
  }, [conversationOwner, ownerKey]);
  const retryRead = (): void => {
    const flight = readFlightRef.current;
    if (flight?.owner === conversationOwner) { flight.failed = false; flight.pending = flight.committed; setReadFailure(undefined); setReadRetry((value) => value + 1); }
  };
  const openSettings = (section: "profile" | "activity" = "profile"): void => { if (editable) setSettings({ owner: conversationOwner, section }); };
  const openPrivateThread = (threadId: string): void => { if (editable) setSettings({ owner: conversationOwner, section: "activity", threadId }); };
  const target = controller.state.snapshot.targets.find((item) => item.id === session.targetId);
  const workbenchAvailable = partnerIdentity !== undefined && target?.trusted === true && target.remoteWorkspace === undefined && isLocalOrigin(profile?.origin);
  const openWorkbench = (): void => {
    if (!workbenchAvailable || !editable) return;
    setWorkbenchOpenFailure(undefined);
    setWorkbenchRequest((previous) => ({ owner: ownerKey, sequence: (previous?.sequence ?? 0) + 1 }));
    void controllerRef.current.setInspectorOpen(true).catch(() => {
      if (conversationOwnerRef.current === conversationOwner) setWorkbenchOpenFailure(conversationOwner);
    });
  };
  const view: PartnerConversationView = {
    sessionId: session.id, ownerKey, kind: identity?.kind, partner: partnerIdentity?.partner, confirmed, editable, failed, connected,
    entryReadCursor: entryReadRef.current?.owner === conversationOwner ? entryReadRef.current.cursor : undefined,
    readFailed: readFailure === conversationOwner, readRetry, acknowledge, retryRead,
    refresh: () => setRefresh((value) => value + 1), openSettings, openPrivateThread,
    workbenchAvailable, workbenchRequest: workbenchRequest?.owner === ownerKey ? workbenchRequest.sequence : undefined,
    workbenchOpenFailed: workbenchOpenFailure === conversationOwner, openWorkbench
  };
  return <PartnerConversationContext.Provider value={view}>
    {children}
    {connected && documentActive && !failed && settings?.owner === conversationOwner && partnerIdentity !== undefined && <PartnerSettingsDialog
      key={`${ownerKey}\u0000${partnerIdentity.partner.id}`}
      partner={partnerIdentity.partner} partners={partnerIdentity.catalog.partners} directory={partnerIdentity.catalog.directory}
      snapshot={controller.state.snapshot} controller={controller} ownerKey={ownerKey} t={t}
      initialSection={settings.section} initialPrivateThreadId={settings.threadId} showClose onClose={() => setSettings(undefined)} onUpdated={acceptMutation}
      onActivityUpdated={(partner) => acceptMutation({ partner, directory: partnerIdentity.catalog.directory })}
    />}
  </PartnerConversationContext.Provider>;
}

function isLocalOrigin(origin: string | undefined): boolean {
  try { return origin !== undefined && isLoopbackHostname(new URL(origin).hostname); } catch { return false; }
}

function ownsConversation(partner: PartnerProfileView, session: SessionView): boolean {
  return partner.lifecycle !== "deleted" && partner.initializationState === "ready"
    && partner.canonicalSessionId === session.id && partner.homeTargetId === session.targetId;
}
function maxCursor(left: bigint, right: bigint): bigint { return left > right ? left : right; }
function retainNewerIdentity(previous: ConversationIdentity | undefined, incoming: Extract<ConversationIdentity, { kind: "partner" }>): ConversationIdentity {
  if (previous?.kind !== "partner" || previous.partner.id !== incoming.partner.id) return incoming;
  const profile = previous.partner.revision > incoming.partner.revision ? previous.partner : incoming.partner;
  const activity = previous.partner.activity.readThroughCursor > incoming.partner.activity.readThroughCursor ? previous.partner.activity : incoming.partner.activity;
  const partner = { ...profile, activity };
  return { ...incoming, partner, catalog: { ...incoming.catalog, partners: incoming.catalog.partners.map((item) => item.id === partner.id ? partner : item) } };
}
