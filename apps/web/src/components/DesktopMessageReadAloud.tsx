import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { DesktopVoiceConversationAction as Action, reconcileDesktopSpeechSelection } from '@joko/contracts';
import { Square, Volume2 } from 'lucide-react';
import type { AppController } from '../controller.js';
import { DesktopSpeechPlayer, DesktopVoiceClient } from '../desktop-voice-conversation.js';
import type { SessionView, TimelineItemView } from '../model.js';
import { usePartnerConversation } from './PartnerConversation.js';
import { timelineMarkdownProse } from './timeline-markdown.js';
import { IconButton } from './ui.js';

type CompletedReply = TimelineItemView & { readonly sourceEventId: string };
interface MessagePlayback {
  readonly item: CompletedReply;
  readonly callId: string;
  readonly operationId: string;
  offered: boolean;
}
interface PlaybackOwner {
  readonly client: DesktopVoiceClient;
  readonly player: DesktopSpeechPlayer;
  panelOpen: boolean;
  run?: MessagePlayback;
}
interface PlaybackActivity {
  readonly owner: PlaybackOwner;
  readonly item: CompletedReply;
  readonly phase: 'active' | 'failed' | 'configure';
}

const messages = {
  en: { read: 'Read aloud', stop: 'Stop playback', configure: 'Choose a read-aloud voice in Speech settings.',
    failed: 'Read aloud failed. Check the selected voice and try again.' },
  zh: { read: '朗读', stop: '停止朗读', configure: '请先在语音设置中选择朗读音色。', failed: '朗读失败。请检查所选音色，再试一次。' }
};

const MessageReadAloudContext = createContext<{
  readonly activity?: PlaybackActivity;
  readonly panelOpen: boolean;
  readonly setPanelOpen: (open: boolean) => void;
  readonly toggle: (item: CompletedReply, chunks: readonly string[]) => Promise<void>;
} | undefined>(undefined);

export function useDesktopMessageReadAloud() { return useContext(MessageReadAloudContext); }

export function useDesktopPartnerVoiceTarget(controller: AppController, session: SessionView) {
  const companion = usePartnerConversation();
  const host = window.jokoDesktop?.voiceConversation;
  const { activeProfile: profile, managedOrchestratorStatus: managed, connectionState, connectionGeneration } = controller.state;
  if (!host || !profile?.managedLocal || managed?.state !== 'ready' || connectionState !== 'connected'
    || managed.connection.serverId !== profile.serverId || companion?.kind !== 'partner' || !companion.confirmed
    || companion.partner?.canonicalSessionId !== session.id || companion.partner.lifecycle !== 'active'
    || session.remoteWorkspace !== undefined) return undefined;
  return { host, serverId: profile.serverId, key: JSON.stringify([
    profile.id, profile.serverId, connectionGeneration, session.id, String(session.generation), companion.partner.id
  ]) };
}

export function DesktopMessageReadAloudProvider({ controller, session, enabled, items, children }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly enabled: boolean;
  readonly items: readonly TimelineItemView[];
  readonly children: ReactNode;
}): JSX.Element {
  const target = useDesktopPartnerVoiceTarget(controller, session);
  const editable = usePartnerConversation()?.editable === true;
  const host = target?.host, serverId = target?.serverId, scope = target?.key;
  const owner = useMemo<PlaybackOwner | undefined>(() => enabled && editable && host && serverId ? {
    client: new DesktopVoiceClient(host, serverId, session.id, session.generation),
    player: new DesktopSpeechPlayer(), panelOpen: false
  } : undefined, [enabled, editable, host, serverId, scope, session.id, session.generation]);
  const currentOwner = useRef<PlaybackOwner | undefined>(undefined);
  const retiring = useRef(Promise.resolve());
  const [activity, setActivity] = useState<PlaybackActivity>();
  const [panelOwner, setPanelOwner] = useState<PlaybackOwner>();

  const retire = useCallback((owner: PlaybackOwner) => {
    const run = owner.run;
    owner.run = undefined;
    if (!run) return retiring.current;
    owner.player.stop();
    if (run.offered) {
      const end = owner.client.control(Action.END, { callId: run.callId, operationId: run.operationId, playbackOnly: true });
      retiring.current = Promise.allSettled([retiring.current, end]).then(() => undefined);
    }
    return retiring.current;
  }, []);
  const stop = useCallback((owner: PlaybackOwner) => {
    void retire(owner);
    setActivity(previous => previous?.owner === owner ? undefined : previous);
  }, [retire]);

  useLayoutEffect(() => {
    if (!owner) return;
    currentOwner.current = owner;
    owner.client.activate();
    const onRetire = () => stop(owner);
    const onVisibility = () => { if (document.hidden) onRetire(); };
    window.addEventListener('pagehide', onRetire);
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = window.jokoDesktop?.microphone?.onRelease(onRetire);
    return () => {
      currentOwner.current = undefined;
      void retire(owner);
      owner.client.close();
      window.removeEventListener('pagehide', onRetire);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.();
    };
  }, [owner, retire, stop]);

  useLayoutEffect(() => {
    const source = owner?.run?.item;
    if (owner && source && !items.some(item => isCompletedReply(item) && sameReply(source, item))) stop(owner);
  }, [items, owner, stop]);

  const setPanelOpen = useCallback((open: boolean) => {
    if (!owner || currentOwner.current !== owner) return;
    owner.panelOpen = open;
    setPanelOwner(previous => open ? owner : previous === owner ? undefined : previous);
    if (open) stop(owner);
  }, [owner, stop]);

  const toggle = useCallback(async (item: CompletedReply, chunks: readonly string[]) => {
    if (!owner || currentOwner.current !== owner || owner.panelOpen || document.hidden) return;
    const previous = owner.run?.item;
    const stopped = retire(owner);
    if (previous && sameReply(previous, item)) { setActivity(undefined); return; }
    const callId = crypto.randomUUID();
    const run: MessagePlayback = { item, callId, operationId: `voice-start-${callId}`, offered: false };
    owner.run = run;
    setActivity({ owner, item, phase: 'active' });
    const current = () => currentOwner.current === owner && owner.run === run;
    let failure: 'failed' | 'configure' | undefined;
    try {
      await stopped;
      if (!current()) return;
      const snapshot = await owner.client.control(Action.SNAPSHOT);
      if (!current()) return;
      if (snapshot.call && snapshot.call.endedAtMs === undefined) throw new Error('Another call owns audio.');
      const selection = reconcileDesktopSpeechSelection(snapshot.preference?.playback ?? snapshot.preference?.conversation, snapshot.models);
      if (!selection) { failure = 'configure'; return; }
      run.offered = true;
      const { call } = await owner.client.control(Action.START, { callId, operationId: run.operationId, selection, playbackOnly: true });
      if (!current()) return;
      if (call?.callId !== callId || call.kind !== 'playback' || call.endedAtMs !== undefined
        || call.sessionId !== owner.client.sessionId || call.sessionGeneration !== owner.client.generation) throw new Error('The reply playback did not start.');
      for (const text of chunks) {
        if (!current()) return;
        await owner.player.play(owner.client, callId, crypto.randomUUID(), text);
      }
    } catch {
      failure = 'failed';
    } finally {
      if (current()) {
        void retire(owner);
        setActivity(failure ? { owner, item, phase: failure } : undefined);
      }
    }
  }, [owner, retire]);

  return <MessageReadAloudContext.Provider value={owner ? {
    activity: activity?.owner === owner ? activity : undefined,
    panelOpen: panelOwner === owner, setPanelOpen, toggle
  } : undefined}>{children}</MessageReadAloudContext.Provider>;
}

export function DesktopMessageReadAloudAction({ item, text, locale }: {
  readonly item: TimelineItemView; readonly text: string; readonly locale: string;
}): JSX.Element | null {
  const playback = useDesktopMessageReadAloud();
  const eligible = playback !== undefined && isCompletedReply(item);
  const chunks = useMemo(() => eligible ? replySpeechChunks(text) : [], [eligible, text]);
  if (!playback || !isCompletedReply(item) || chunks.length === 0) return null;
  const phase = playback.activity && sameReply(playback.activity.item, item) ? playback.activity.phase : undefined;
  const active = phase === 'active';
  const labels = locale === 'zh-CN' ? messages.zh : messages.en;
  const error = phase === 'configure' || phase === 'failed' ? labels[phase] : undefined;
  return <><IconButton className="copy-button" label={active ? labels.stop : labels.read} aria-pressed={active} disabled={playback.panelOpen}
    onClick={() => { void playback.toggle(item, chunks); }}>{active ? <Square aria-hidden="true" /> : <Volume2 aria-hidden="true" />}</IconButton>
    {error && <span className="message-share-feedback is-error" role="alert">{error}</span>}</>;
}

function isCompletedReply(item: TimelineItemView): item is CompletedReply {
  return item.kind === 'assistant' && item.sourceEventId !== undefined && item.completionCursor !== undefined
    && item.streaming !== true && item.samplingInterrupted !== true && item.partnerPrivateOrigin === undefined;
}

function sameReply(left: CompletedReply, right: CompletedReply): boolean {
  return left.id === right.id && left.sourceEventId === right.sourceEventId && left.text === right.text;
}

function replySpeechChunks(markdown: string): readonly string[] {
  const text = timelineMarkdownProse(markdown);
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 500, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > offset + 250) end = space;
      if (/[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
    }
    chunks.push(text.slice(offset, end).trim());
    offset = end;
  }
  return chunks;
}
