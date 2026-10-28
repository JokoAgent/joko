import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import type { AppController } from "../controller.js";
import type { PartnerListView, PartnerMutationView, PartnerProfileView, PartnerSessionView, PartnerReplyQuoteView, SessionView, TimelineItemView } from "../model.js";
import { clearSentPartnerReplyQuote, partnerReplyQuoteFor, setPendingPartnerReplyQuote, usePendingPartnerReplyQuote } from '../partner-reply-quote.js';
import { isLoopbackHostname } from "../connection-origin.js";
import { validatePartnerSourceSession } from "../partner-sources.js";
import { taskSourceKey } from "../task-sharing.js";
import { PartnerSettingsDialog } from "./PartnersPage.js";
import type { PartnerLearningSettingsDestination } from "@joko/contracts";
import type { Translator } from "./types.js";

type ConversationIdentity =
  | { readonly kind: "task" }
  | { readonly kind: "partner"; readonly catalog: PartnerListView; readonly partner: PartnerProfileView; readonly topic?: PartnerSessionView; readonly topics?: readonly PartnerSessionView[] };

interface IdentityProjection {
  readonly key: string;
  readonly owner: object;
  readonly phase: "loading" | "ready" | "failed";
  readonly identity?: ConversationIdentity;
}

export interface PartnerConversationView {
  readonly sessionId: string;
  readonly locale?: string;
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
  readonly openLearningSettings: (destination: PartnerLearningSettingsDestination) => void;
  readonly openPrivateThread: (threadId: string) => void;
  readonly topicRoot?: PartnerSessionView['topicRoot'];
  readonly topics?: readonly PartnerSessionView[];
  readonly openingTopicId?: string;
  readonly topicFailed?: boolean;
  readonly openTopic?: (item: TimelineItemView) => void;
  readonly openTopicSession?: (sessionId: string) => void;
  readonly returnToMain?: () => void;
  readonly replyQuote?: PartnerReplyQuoteView;
  readonly quoteReply?: (item: TimelineItemView) => void;
  readonly clearReplyQuote?: () => void;
  readonly clearSentReplyQuote?: (quote: PartnerReplyQuoteView) => void;
  readonly locateReplyQuote?: (quote: PartnerReplyQuoteView) => void;
  readonly showReplyQuotes?: boolean;
  readonly toggleReplyQuotes?: () => void;
  readonly quoteSettingFailed?: boolean;
  readonly autonomyApi?: import("@joko/contracts").PartnerAutonomyApi;
  readonly engaged?: boolean;
  readonly userSent?: () => void;
  readonly openObservedTask?: (sessionId: string) => void;
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
export function PartnerConversationProvider({ controller, session, active, t, children, onOpenTopic }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly active: boolean;
  readonly t: Translator;
  readonly children: ReactNode;
  readonly onOpenTopic?: (sessionId: string) => void;
}): JSX.Element {
  const profile = controller.state.activeProfile;
  const source = controller.state.taskSource, access = controller.state.sessionAccess;
  const sharedSource = source?.kind === "joined" || access?.role === "guest";
  const sharedTask = source?.kind === "joined" && profile !== undefined && access?.role === "guest" && access.memberId === source.memberId
    && source.sessionId === session.id && source.homeProfileId === profile?.id
    && source.homeServerId === profile.serverId && source.homeOrigin === profile.origin;
  const expectedPartnerId = controller.state.route?.kind === "session" ? controller.state.route.partnerId : undefined;
  const ownerKey = JSON.stringify([profile?.id, profile?.serverId, profile?.origin, expectedPartnerId,
    taskSourceKey(source ?? { kind: "own" }), access?.role, access?.memberId,
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
  const quoteOwner = JSON.stringify([profile?.serverId, profile?.id, session.id, session.generation.toString()]);
  const pendingQuote = usePendingPartnerReplyQuote(quoteOwner);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [projection, setProjection] = useState<IdentityProjection>();
  const [settings, setSettings] = useState<{ readonly owner: object; readonly section: "profile" | "activity";
    readonly threadId?: string; readonly learningDestination?: PartnerLearningSettingsDestination }>();
  const entryReadRef = useRef<{ readonly owner: object; readonly partnerId: string; readonly cursor: bigint } | undefined>(undefined);
  const [readRetry, setReadRetry] = useState(0);
  const [readFailure, setReadFailure] = useState<object>();
  const [workbenchRequest, setWorkbenchRequest] = useState<{ readonly owner: string; readonly sequence: number }>();
  const [workbenchOpenFailure, setWorkbenchOpenFailure] = useState<object>();
  const [topicAction, setTopicAction] = useState<{ readonly owner: object; readonly messageId: string; readonly failed: boolean }>();
  const [quoteSettingFailed, setQuoteSettingFailed] = useState(false);
  const [engagedOwner, setEngagedOwner] = useState<string>();
  const autonomyApi = useMemo(() => {
    if (!connected || sharedSource || !controller.partnerAutonomyApi) return undefined;
    try { return controller.partnerAutonomyApi(ownerKey); } catch { return undefined; }
  }, [controller, connected, sharedSource, ownerKey]);
  const topicAttempts = useRef(new Map<string, { readonly operationId: string; readonly revision: bigint }>());
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
    if (sharedSource) {
      // The authenticated task projection already supplies this identity. A
      // guest cannot inspect the Home node's unrelated Partner directory.
      setProjection({ key: ownerKey, owner: requestOwner, phase: sharedTask ? "ready" : "failed",
        ...(sharedTask ? { identity: { kind: "task" as const } } : {}) });
      return () => { alive = false; abort.abort(); };
    }
    setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "loading",
      ...(previous?.key === ownerKey && previous.identity?.kind === "partner" ? { identity: previous.identity } : {}) }));
    void (async () => {
      const catalog = await controllerRef.current.listPartners(undefined, abort.signal);
      if (!current()) return;
      const topic = await controllerRef.current.getPartnerTopic?.(session.id, abort.signal);
      if (!current()) return;
      const candidates = catalog.partners.filter((partner) => topic ? partner.id === topic.partnerId : partner.canonicalSessionId === session.id);
      if (candidates.length === 0) {
        if (expectedPartnerId !== undefined) throw new Error("The requested Partner no longer owns this task.");
        setProjection({ key: ownerKey, owner: requestOwner, phase: "ready", identity: { kind: "task" } });
        return;
      }
      const partner = candidates[0];
      if (candidates.length !== 1 || partner === undefined || !ownsConversation(partner, session, topic)) throw new Error("Partner conversation ownership is unavailable.");
      if (expectedPartnerId !== undefined && partner.id !== expectedPartnerId) throw new Error("The task now belongs to another Partner.");
      const links = await controllerRef.current.listPartnerSessions(partner.id, abort.signal);
      if (!current()) return;
      const canonical = links.filter((link) => topic ? link.role === 'topic' && link.sessionId === topic.sessionId : link.role === "canonical");
      const link = canonical[0];
      if (canonical.length !== 1 || link === undefined || link.partnerId !== partner.id || link.sessionId !== session.id
        || !link.available || link.deleted || link.profileVersion > partner.profileVersion) throw new Error("Partner canonical session is unavailable.");
      if (expectedPartnerId !== undefined && !topic) validatePartnerSourceSession(expectedPartnerId, partner, links, controllerRef.current.state.snapshot);
      setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "ready",
        identity: retainNewerIdentity(previous?.key === ownerKey ? previous.identity : undefined, { kind: "partner", catalog, partner,
          ...(topic ? { topic } : {}), topics: links.filter(link => link.role === 'topic' && link.topicRoot?.sessionId === (topic?.topicRoot?.sessionId ?? session.id) && link.available && !link.deleted) }) }));
    })().catch(() => {
      if (current()) setProjection((previous) => ({ key: ownerKey, owner: requestOwner, phase: "failed",
        ...(previous?.key === ownerKey && previous.identity?.kind === "partner" ? { identity: previous.identity } : {}) }));
    });
    return () => { alive = false; abort.abort(); };
  }, [connected, documentActive, requestOwner, ownerKey, session.id, session.targetId, sharedSource, sharedTask]);

  const confirmed = projection?.key === ownerKey && projection.owner === requestOwner && projection.phase === "ready";
  const identity = projection?.key === ownerKey ? projection.identity : undefined;
  const partnerIdentity = identity?.kind === "partner" ? identity : undefined;
  const editable = connected && documentActive && confirmed && partnerIdentity !== undefined && partnerIdentity.topic?.readOnly !== true;
  const failed = !connected || projection?.owner === requestOwner && projection.phase === "failed";
  if (editable && partnerIdentity !== undefined && (entryReadRef.current?.owner !== conversationOwner || entryReadRef.current.partnerId !== partnerIdentity.partner.id)) {
    entryReadRef.current = { owner: conversationOwner, partnerId: partnerIdentity.partner.id, cursor: partnerIdentity.partner.activity.readThroughCursor };
  }
  const readContextRef = useRef({ editable, active, partnerIdentity, session });
  readContextRef.current = { editable, active, partnerIdentity, session };
  const acceptMutation = (result: PartnerMutationView): void => {
    if (conversationOwnerRef.current !== conversationOwner || !connected || !documentActive || partnerIdentity === undefined) return;
    if (result.partner.id !== partnerIdentity.partner.id || !ownsConversation(result.partner, session, partnerIdentity.topic)) {
      setSettings(undefined); setRefresh((value) => value + 1); return;
    }
    setProjection((previous) => ({ key: ownerKey, owner: requestOwnerRef.current, phase: "ready",
      identity: retainNewerIdentity(previous?.key === ownerKey ? previous.identity : undefined, {
          ...partnerIdentity, kind: "partner", partner: result.partner,
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
    if (flight === undefined || flight.owner !== conversationOwner || cursor <= 0n || !visible() || context.partnerIdentity === undefined || context.partnerIdentity.topic) return;
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
  const openLearningSettings = (destination: PartnerLearningSettingsDestination): void => {
    if (editable && conversationOwnerRef.current === conversationOwner) setSettings({ owner: conversationOwner, section: "profile", learningDestination: destination });
  };
  const openPrivateThread = (threadId: string): void => { if (editable) setSettings({ owner: conversationOwner, section: "activity", threadId }); };
  const target = controller.state.snapshot.targets.find((item) => item.id === session.targetId);
  const workbenchAvailable = partnerIdentity !== undefined && !partnerIdentity.topic && target?.trusted === true && target.remoteWorkspace === undefined && isLocalOrigin(profile?.origin);
  const openTopicSession = (sessionId: string): void => {
    if (!editable || conversationOwnerRef.current !== conversationOwner) return;
    if (onOpenTopic) onOpenTopic(sessionId); else controllerRef.current.navigate({ kind: 'session', sessionId });
  };
  const openTopic = (item: TimelineItemView): void => {
    if (!editable || !partnerIdentity || partnerIdentity.topic || !controllerRef.current.ensurePartnerTopic || item.streaming || !item.sourceEventId
      || !['user', 'assistant'].includes(item.kind) || topicAction?.owner === conversationOwner && !topicAction.failed) return;
    const root = { sessionId: session.id, generation: session.generation, eventId: item.sourceEventId, messageId: item.messageId ?? item.id };
    const key = JSON.stringify([ownerKey, root.eventId]);
    const attempt = topicAttempts.current.get(key) ?? { operationId: crypto.randomUUID(), revision: partnerIdentity.partner.revision };
    topicAttempts.current.set(key, attempt); setTopicAction({ owner: conversationOwner, messageId: item.id, failed: false });
    void controllerRef.current.ensurePartnerTopic(attempt.operationId, partnerIdentity.partner.id, attempt.revision, root).then(topic => {
      if (conversationOwnerRef.current !== conversationOwner) return;
      setTopicAction(undefined); setRefresh(value => value + 1); openTopicSession(topic.sessionId);
    }).catch(() => { if (conversationOwnerRef.current === conversationOwner) setTopicAction({ owner: conversationOwner, messageId: item.id, failed: true }); });
  };
  const openWorkbench = (): void => {
    if (!workbenchAvailable || !editable) return;
    setWorkbenchOpenFailure(undefined);
    setWorkbenchRequest((previous) => ({ owner: ownerKey, sequence: (previous?.sequence ?? 0) + 1 }));
    void controllerRef.current.setInspectorOpen(true).catch(() => {
      if (conversationOwnerRef.current === conversationOwner) setWorkbenchOpenFailure(conversationOwner);
    });
  };
  const view: PartnerConversationView = {
    sessionId: session.id, locale: controller.state.effectiveLocale, ownerKey, kind: identity?.kind, partner: partnerIdentity?.partner, confirmed, editable, failed, connected,
    entryReadCursor: entryReadRef.current?.owner === conversationOwner ? entryReadRef.current.cursor : undefined,
    readFailed: readFailure === conversationOwner, readRetry, acknowledge, retryRead,
    refresh: () => setRefresh((value) => value + 1), openSettings, openLearningSettings, openPrivateThread,
    topicRoot: partnerIdentity?.topic?.topicRoot, topics: partnerIdentity?.topics, openTopic: editable && !partnerIdentity?.topic && controller.ensurePartnerTopic ? openTopic : undefined,
    openTopicSession, returnToMain: partnerIdentity?.topic?.topicRoot ? () => { const root = partnerIdentity.topic!.topicRoot!;
      controllerRef.current.navigate({ kind: 'session', sessionId: root.sessionId, messageId: root.messageId, messageEventId: root.eventId }); } : undefined,
    openingTopicId: topicAction?.owner === conversationOwner && !topicAction.failed ? topicAction.messageId : undefined,
    topicFailed: topicAction?.owner === conversationOwner && topicAction.failed,
    replyQuote: partnerIdentity ? pendingQuote : undefined,
    quoteReply: editable ? item => { const quote = partnerReplyQuoteFor(item, session.generation); if (quote) setPendingPartnerReplyQuote(quoteOwner, quote); } : undefined,
    clearReplyQuote: () => setPendingPartnerReplyQuote(quoteOwner, undefined),
    clearSentReplyQuote: quote => clearSentPartnerReplyQuote(quoteOwner, quote),
    locateReplyQuote: quote => { if (conversationOwnerRef.current === conversationOwner && quote.generation === session.generation)
      controllerRef.current.navigate({ kind: 'session', sessionId: session.id, messageId: quote.messageId, messageEventId: quote.eventId }); },
    showReplyQuotes: controller.state.preferences?.showPartnerReplyQuotes !== false,
    toggleReplyQuotes: controller.setPartnerReplyQuotesVisible ? () => { setQuoteSettingFailed(false);
      void controllerRef.current.setPartnerReplyQuotesVisible?.(controller.state.preferences?.showPartnerReplyQuotes === false)
        .catch(() => { if (conversationOwnerRef.current === conversationOwner) setQuoteSettingFailed(true); }); } : undefined,
    quoteSettingFailed,
    autonomyApi: partnerIdentity && !partnerIdentity.topic ? autonomyApi : undefined, engaged: engagedOwner === ownerKey,
    userSent: () => { if (conversationOwnerRef.current === conversationOwner) setEngagedOwner(ownerKey); },
    openObservedTask: sessionId => { if (conversationOwnerRef.current === conversationOwner && editable) void controller.navigate({ kind: "session", sessionId }); },
    workbenchAvailable, workbenchRequest: workbenchRequest?.owner === ownerKey ? workbenchRequest.sequence : undefined,
    workbenchOpenFailed: workbenchOpenFailure === conversationOwner, openWorkbench
  };
  return <PartnerConversationContext.Provider value={view}>
    {children}
    {connected && documentActive && !failed && settings?.owner === conversationOwner && partnerIdentity !== undefined && <PartnerSettingsDialog
      key={`${ownerKey}\u0000${partnerIdentity.partner.id}`}
      partner={partnerIdentity.partner} partners={partnerIdentity.catalog.partners} directory={partnerIdentity.catalog.directory}
      snapshot={controller.state.snapshot} controller={controller} ownerKey={ownerKey} t={t}
      initialSection={settings.section} initialPrivateThreadId={settings.threadId} initialLearningDestination={settings.learningDestination}
      showClose onClose={() => setSettings(undefined)} onUpdated={acceptMutation}
      onActivityUpdated={(partner) => acceptMutation({ partner, directory: partnerIdentity.catalog.directory })}
    />}
  </PartnerConversationContext.Provider>;
}

function isLocalOrigin(origin: string | undefined): boolean {
  try { return origin !== undefined && isLoopbackHostname(new URL(origin).hostname); } catch { return false; }
}

function ownsConversation(partner: PartnerProfileView, session: SessionView, topic?: PartnerSessionView): boolean {
  return partner.lifecycle !== "deleted" && partner.initializationState === "ready"
    && (partner.canonicalSessionId === session.id || topic?.role === 'topic' && topic.sessionId === session.id && topic.partnerId === partner.id && topic.available && !topic.deleted)
    && partner.homeTargetId === session.targetId;
}
function maxCursor(left: bigint, right: bigint): bigint { return left > right ? left : right; }
function retainNewerIdentity(previous: ConversationIdentity | undefined, incoming: Extract<ConversationIdentity, { kind: "partner" }>): ConversationIdentity {
  if (previous?.kind !== "partner" || previous.partner.id !== incoming.partner.id) return incoming;
  const profile = previous.partner.revision > incoming.partner.revision ? previous.partner : incoming.partner;
  const activity = previous.partner.activity.readThroughCursor > incoming.partner.activity.readThroughCursor ? previous.partner.activity : incoming.partner.activity;
  const partner = { ...profile, activity };
  return { ...incoming, partner, catalog: { ...incoming.catalog, partners: incoming.catalog.partners.map((item) => item.id === partner.id ? partner : item) } };
}
