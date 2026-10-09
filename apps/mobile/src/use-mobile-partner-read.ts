import { useEffect, useMemo, useRef, useState } from "react";
import type { Event } from "@joko/contracts";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { mobilePartnerVisibleReply, type MobilePartnerConversationTransport,
  type MobilePartnerVisibleReply } from "./mobile-partner-conversation";

interface ReadState {
  readonly ownerKey?: string;
  readonly partner?: MobilePartnerDirectoryProfile;
  readonly resolved?: boolean;
  readonly failed: boolean;
}

interface ReadFlight {
  readonly ownerKey: string;
  readonly controller: AbortController;
  committed: bigint;
  pending?: MobilePartnerVisibleReply;
  running: boolean;
  failed: boolean;
}

export function useMobilePartnerRead(transport: MobilePartnerConversationTransport | undefined,
  events: readonly Event[], generation: bigint, visibleMessageIds: ReadonlySet<string>, enabled: boolean) {
  const [state, setState] = useState<ReadState>({ failed: false });
  const [attempt, setAttempt] = useState(0);
  const [pulse, setPulse] = useState(0);
  const flightRef = useRef<ReadFlight | undefined>(undefined);
  const contextRef = useRef({ transport, enabled, visibleMessageIds, partner: state.partner });
  const partner = state.ownerKey === transport?.ownerKey ? state.partner : undefined;
  contextRef.current = { transport, enabled, visibleMessageIds, partner };
  const reply = useMemo(() => transport === undefined ? undefined
    : mobilePartnerVisibleReply(events, transport.sessionId, generation, visibleMessageIds),
  [events, generation, transport?.sessionId, visibleMessageIds]);

  useEffect(() => {
    flightRef.current?.controller.abort();
    flightRef.current = undefined;
    setState({ ownerKey: transport?.ownerKey, failed: false });
    if (!transport) return;
    const controller = new AbortController();
    const ownerKey = transport.ownerKey;
    void transport.resolve(controller.signal).then((resolved) => {
      if (controller.signal.aborted || contextRef.current.transport?.ownerKey !== ownerKey) return;
      setState({ ownerKey, partner: resolved, failed: false, resolved: true });
    }).catch(() => {
      if (!controller.signal.aborted && contextRef.current.transport?.ownerKey === ownerKey) {
        setState({ ownerKey, failed: true });
      }
    });
    return () => { controller.abort(); flightRef.current?.controller.abort(); };
  }, [transport?.ownerKey, attempt]);

  useEffect(() => {
    if (!enabled || !transport) {
      flightRef.current?.controller.abort();
      flightRef.current = undefined;
      return;
    }
    if (!partner || !reply || state.failed) return;
    let flight = flightRef.current;
    if (!flight || flight.ownerKey !== transport.ownerKey || flight.controller.signal.aborted) {
      flight = { ownerKey: transport.ownerKey, controller: new AbortController(),
        committed: partner.activity.readThroughCursor, running: false, failed: false };
      flightRef.current = flight;
    }
    flight.committed = flight.committed > partner.activity.readThroughCursor
      ? flight.committed : partner.activity.readThroughCursor;
    if (reply.cursor > flight.committed) flight.pending = reply;
    if (flight.running || flight.failed || !flight.pending || flight.pending.cursor <= flight.committed) return;
    const currentFlight = flight;
    const visible = (candidate: MobilePartnerVisibleReply): boolean => !currentFlight.controller.signal.aborted
      && contextRef.current.enabled && contextRef.current.transport?.ownerKey === currentFlight.ownerKey
      && contextRef.current.partner?.partnerId === partner.partnerId
      && contextRef.current.visibleMessageIds.has(candidate.messageId);
    currentFlight.running = true;
    void (async () => {
      while (currentFlight.pending && currentFlight.pending.cursor > currentFlight.committed) {
        const requested = currentFlight.pending;
        if (!visible(requested)) return;
        const current = contextRef.current;
        const activity = await current.transport!.acknowledge(current.partner!, requested,
          currentFlight.controller.signal, () => visible(requested));
        if (!visible(requested)) return;
        currentFlight.committed = activity.readThroughCursor > currentFlight.committed
          ? activity.readThroughCursor : currentFlight.committed;
        setState((previous) => previous.ownerKey !== currentFlight.ownerKey || !previous.partner ? previous
          : { ...previous, failed: false, partner: { ...previous.partner, activity } });
      }
    })().catch(() => {
      if (currentFlight.pending && visible(currentFlight.pending)) {
        currentFlight.failed = true;
        setState((previous) => previous.ownerKey === currentFlight.ownerKey ? { ...previous, failed: true } : previous);
      }
    }).finally(() => {
      currentFlight.running = false;
      if (!currentFlight.failed && currentFlight.pending && visible(currentFlight.pending)
        && currentFlight.pending.cursor > currentFlight.committed) setPulse((value) => value + 1);
    });
  }, [enabled, partner, pulse, reply, state.failed, transport?.ownerKey]);

  return { partner, ready: transport === undefined || state.ownerKey === transport.ownerKey && state.resolved === true,
    failed: state.ownerKey === transport?.ownerKey && state.failed,
    retry: () => setAttempt((value) => value + 1) };
}
