import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { create } from '@bufbuild/protobuf';
import { DesktopVoiceConversationAction as Action, DesktopSpeechSelectionSchema, DesktopVoiceConversationPreferenceSchema,
  speechSpeedRange, type SpeechProtocol,
  type DesktopSpeechSelection, type DesktopSpeechModel, type ControlDesktopVoiceConversationResponse, type DesktopSpeechVoiceCatalog, type DesktopVoiceCallRecord } from '@joko/contracts';
import { Phone, Volume2 } from 'lucide-react';
import type { AppController } from '../controller.js';
import type { SessionView } from '../model.js';
import { ContinuousVoiceListener, DesktopSpeechPlayer, DesktopVoiceClient, spokenSentences, voiceExitIntent } from '../desktop-voice-conversation.js';
import { currentVoiceQuestionTarget, type VoiceQuestionTarget } from '../voice-question-bridge.js';
import { Button, CheckboxControl, IconButton, SelectControl } from './ui.js';
import { usePartnerConversation } from './PartnerConversation.js';
import './desktop-voice-conversation.css';

const en = { title: 'Voice conversation', body: 'Talk in a separate call context. Work is handed to this task and follows its permissions.',
  open: 'Open voice conversation', settings: 'Speech settings', conversation: 'Conversation voice', playback: 'Read-aloud voice',
  model: 'Speech model', protocol: 'Protocol', voice: 'Voice ID', speed: 'Speed', automatic: 'Provider default', manual: 'Enter an exact voice ID',
  catalog: 'Load voices', unavailable: 'Speech or microphone is unavailable. Check this task, its provider and voice settings, then retry.',
  empty: 'Configure a direct BYOK provider and its exact speech model in Models first. Native and shared credentials are unavailable here.',
  choose: 'Choose a model', save: 'Save voice settings', reset: 'Reset voice settings', saved: 'Voice settings saved',
  start: 'Start call', end: 'End call', mute: 'Mute microphone', unmute: 'Resume listening', interrupt: 'Interrupt reply',
  listening: 'Listening', starting: 'Starting microphone', submitting: 'Finishing transcription', thinking: 'Waiting for reply',
  text: 'Message in this call', send: 'Send to call', handoff: 'Send as task work', work: 'Task work',
  sentence: 'Read replies sentence by sentence', preview: 'Preview voice', previewText: 'Hello. This is your selected voice.',
  stop: 'Stop playback', read: 'Read aloud', readText: 'Text to read aloud', history: 'Recent calls', retry: 'Retry',
  loading: 'Loading', noCalls: 'No calls yet', truncated: 'The voice list is limited. You can enter an exact ID.',
  voicesUnavailable: 'Account voices could not be loaded. Public reference voices remain available.',
  ready: 'Ready', close: 'Close', missing: 'Saved model is currently unavailable', inherited: 'Use conversation voice',
  speaker: 'Assistant', user: 'You', failed: 'Failed; retry explicitly', accepted: 'Accepted by task', completed: 'Task completed', sending: 'Sending', paused: 'The task needs your attention. Finish its question or approval, then resume listening.',
  microphone: 'Microphone', none: 'Not selected', cancelled: 'Call ended', details: 'Show call', returned: 'Task result', countdown: 'Call ends in', continueCall: 'Keep talking', questionDraft: 'Unsent question answer', retryQuestion: 'Use in the original question', questionHint: 'Speak the visible question choice. Confirm free text and multiple choices explicitly.', waiting: 'Waiting for task acceptance before ending' };
const zh: typeof en = { title: '持续语音', body: '在独立通话上下文中交流。需要执行的工作交给当前任务，并沿用任务权限。',
  open: '打开持续语音', settings: '语音设置', conversation: '通话朗读', playback: '单独朗读', model: '语音模型', protocol: '协议', voice: '音色 ID', speed: '语速', automatic: '提供方默认', manual: '输入准确音色 ID',
  catalog: '加载音色', unavailable: '语音或麦克风不可用。请检查当前任务、提供方和语音设置后明确重试。', empty: '请先在模型设置中配置直接 BYOK 提供方和准确语音模型。此处不使用原生或分享凭据。',
  choose: '选择模型', save: '保存语音设置', reset: '重置语音设置', saved: '已保存语音设置', start: '开始通话', end: '结束通话', mute: '关闭麦克风', unmute: '恢复收听', interrupt: '打断回复',
  listening: '正在收听', starting: '正在启动麦克风', submitting: '正在完成转写', thinking: '等待回复', text: '通话内文字', send: '发送到通话', handoff: '作为任务工作发送', work: '任务工作',
  sentence: '逐句朗读回复', preview: '试听音色', previewText: '你好，这是你选择的音色。', stop: '停止朗读', read: '朗读', readText: '要朗读的文字', history: '最近通话', retry: '重试', loading: '加载中', noCalls: '暂无通话',
  truncated: '音色列表已达到上限，仍可输入准确 ID。', voicesUnavailable: '未能读取账号音色，仍可选择公开参考音色。', ready: '就绪', close: '关闭', missing: '已保存的模型当前不可用', inherited: '使用通话音色',
  speaker: '助手', user: '你', failed: '失败，请明确重试', accepted: '任务已接纳', completed: '任务已完成', sending: '正在发送', paused: '任务需要你的处理。完成原提问或批准后，再恢复收听。', microphone: '麦克风', none: '尚未选择', cancelled: '通话已结束', details: '查看通话', returned: '任务结果', countdown: '通话将在以下秒数后结束', continueCall: '继续聊', questionDraft: '尚未提交的问题答案', retryQuestion: '用于原问题', questionHint: '可口述当前提问卡的选项；自由回答和多选请明确说“确认”。', waiting: '正在等待任务接纳后结束通话' };
const protocols = ['openai', 'elevenlabs', 'minimax', 'qwen-tts', 'dashscope-tts'] as const;
const key = (value: Pick<DesktopSpeechSelection, 'backendId' | 'providerId' | 'modelId'>) => JSON.stringify([value.backendId, value.providerId, value.modelId]);

/** Mounted only in an owned task on the locally managed Desktop node. */
export function DesktopVoiceConversationEntry({ controller, session, disabled }: {
  readonly controller: AppController; readonly session: SessionView; readonly disabled: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const companion = usePartnerConversation();
  const text = controller.state.effectiveLocale === 'zh-CN' ? zh : en;
  const profile = controller.state.activeProfile, managed = controller.state.managedOrchestratorStatus;
  const available = Boolean(window.jokoDesktop?.voiceConversation && profile?.managedLocal && managed?.state === 'ready'
    && companion?.kind === 'partner' && companion.confirmed && companion.partner?.canonicalSessionId === session.id && companion.partner.lifecycle === 'active'
    && session.remoteWorkspace === undefined && managed.connection.serverId === profile.serverId && controller.state.connectionState === 'connected');
  const scope = `${profile?.serverId}:${session.id}:${session.generation}:${controller.state.connectionGeneration}`;
  useEffect(() => setOpen(false), [scope, available]);
  if (!available || !profile) return null;
  return <><IconButton label={text.open} disabled={disabled} onClick={() => setOpen(true)}><Phone aria-hidden="true" /></IconButton>
    {open && <DesktopVoiceConversationPanel key={scope} controller={controller} session={session} serverId={profile.serverId} onClose={() => setOpen(false)} />}</>;
}

export function DesktopVoiceConversationPanel({ controller, session, serverId, onClose }: {
  readonly controller: AppController; readonly session: SessionView; readonly serverId: string; readonly onClose: () => void;
}): JSX.Element {
  const text = controller.state.effectiveLocale === 'zh-CN' ? zh : en;
  const host = window.jokoDesktop!.voiceConversation!;
  const client = useMemo(() => new DesktopVoiceClient(host, serverId, session.id, session.generation), [host, serverId, session.id, session.generation]);
  const [value, setValue] = useState<ControlDesktopVoiceConversationResponse>(), [error, setError] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [conversation, setConversation] = useState<DesktopSpeechSelection>(), [playback, setPlayback] = useState<DesktopSpeechSelection>();
  const [sentence, setSentence] = useState(true), [settings, setSettings] = useState(false), [message, setMessage] = useState(''), [reading, setReading] = useState('');
  const [mic, setMic] = useState(false), [micState, setMicState] = useState(''), [speaking, setSpeaking] = useState(false);
  const [historyDetails, setHistoryDetails] = useState<Readonly<Record<string, DesktopVoiceCallRecord>>>({});
  const [draft, setDraft] = useState(''), [questionDraft, setQuestionDraft] = useState('');
  const [countdown, setCountdown] = useState<{ readonly reason: string; readonly seconds: number; readonly waiting?: boolean }>();
  const surface = useRef<HTMLDivElement>(null);
  const interactions = controller.state.snapshot?.interactions.filter(row => row.sessionId === session.id && row.generation === session.generation) ?? [];
  const question = interactions.find(row => row.kind === 'question' && row.runId && value?.call?.handoffs.some(handoff => handoff.runId === row.runId && ['accepted', 'completed'].includes(handoff.state)));
  const questionRef = useRef(question); questionRef.current = question;
  const blocked = interactions.some(row => row.kind !== 'question')
    || controller.state.snapshot?.queueControls.some(row => row.sessionId === session.id && row.state === 'paused') || false;
  const current = useRef<{ live: boolean; callId?: string; kind?: string; polling: boolean; ending?: boolean; readId: number }>({ live: true, polling: false, readId: 0 });
  const player = useMemo(() => new DesktopSpeechPlayer(), []), listener = useRef<ContinuousVoiceListener | undefined>(undefined);
  const spoken = useRef(new Set<string>()), speechTail = useRef<Promise<unknown>>(Promise.resolve());
  const speechRequestIds = useRef(new Map<string, string>());
  const speechGeneration = useRef(0);
  const semanticVersion = useRef(0), idleSince = useRef<number | undefined>(undefined);
  const exit = useRef<{ readonly reason: 'idle' | 'farewell' | 'semantic'; readonly deadline: number } | undefined>(undefined);
  const speechCandidate = useRef(false), capturedQuestion = useRef<{ readonly pending: boolean; readonly target?: VoiceQuestionTarget } | undefined>(undefined);
  const hasSpeechSession = useRef(false);
  const questionDraftRef = useRef(questionDraft); questionDraftRef.current = questionDraft;
  const retainedQuestion = useRef<VoiceQuestionTarget | undefined>(undefined);
  const pendingSends = useRef(new Set<Promise<unknown>>());
  const latestValue = useRef(value); latestValue.current = value;
  const idleCheck = useRef<() => boolean>(() => false);
  const saveRequest = useRef<Parameters<DesktopVoiceClient['control']>[1] | undefined>(undefined);
  const pendingInput = useRef<{ readonly inputId: string; readonly text: string; readonly forceHandoff: boolean } | undefined>(undefined);
  const read = useCallback(async () => {
    const owner = current.current; if (!owner.live || owner.polling || owner.ending) return;
    owner.polling = true; const readId = ++owner.readId;
    try {
      const result = await client.control(Action.SNAPSHOT, { callId: owner.callId ?? '' });
      if (current.current !== owner || !owner.live || owner.readId !== readId) return;
      setValue(result); setError(false);
      if (result.call?.endedAtMs === undefined && result.call) { owner.callId = result.call.callId; owner.kind = result.call.kind; }
      if (!result.call && owner.callId) { listener.current?.stop(); player.stop(); owner.callId = undefined; setMic(false); }
    } catch { if (owner.live) setError(true); }
    finally { owner.polling = false; }
  }, [client, player]);
  const stop = useCallback(async () => {
    const owner = current.current, id = owner.callId;
    owner.readId++; owner.ending = true;
    speechGeneration.current++; semanticVersion.current++; exit.current = undefined; idleSince.current = undefined; setCountdown(undefined);
    listener.current?.stop(); player.stop(); setMic(false); setSpeaking(false);
    owner.callId = undefined; owner.kind = undefined;
    try { if (id) await client.control(Action.END, { callId: id }).catch(() => undefined); }
    finally { owner.ending = false; }
  }, [client, player]);
  useEffect(() => {
    const owner = { live: true, polling: false, readId: 0 } as typeof current.current; current.current = owner;
    client.activate();
    void read(); const timer = window.setInterval(() => { void read(); }, 800);
    const hidden = () => { if (document.hidden) void stop(); };
    const retire = () => { void stop(); };
    window.addEventListener('pagehide', retire); document.addEventListener('visibilitychange', hidden);
    return () => {
      void stop(); owner.live = false; client.close(); window.clearInterval(timer);
      window.removeEventListener('pagehide', retire); document.removeEventListener('visibilitychange', hidden);
    };
  }, [client, read, stop]);
  useEffect(() => {
    const previous = document.activeElement; surface.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!value?.preference || settings) return;
    setConversation(value.preference.conversation); setPlayback(value.preference.playback); setSentence(value.preference.sentencePlayback);
  }, [value?.preference?.revision, settings]);
  const action = async (work: () => Promise<unknown>) => {
    if (busy) return; current.current.readId++; setBusy(true); setError(false); setNotice('');
    try { await work(); } catch { if (current.current.live) setError(true); }
    finally { if (current.current.live) { setBusy(false); void read(); } }
  };
  const interrupt = useCallback((notify = true): Promise<unknown> => {
    speechGeneration.current++; semanticVersion.current++; exit.current = undefined; idleSince.current = undefined; setCountdown(undefined);
    for (const turn of latestValue.current?.call?.turns ?? []) if (turn.role === 'assistant') spoken.current.add(turn.id);
    const id = current.current.callId; player.stop(); setSpeaking(false);
    return id && notify ? client.control(Action.INTERRUPT, { callId: id }).catch(() => { if (current.current.live) setError(true); }) : Promise.resolve();
  }, [client, player]);
  useEffect(() => {
    if (!blocked) return;
    const unfinished = listener.current?.draft;
    if (unfinished?.trim()) {
      if (capturedQuestion.current?.pending) { retainedQuestion.current = capturedQuestion.current.target; setQuestionDraft(unfinished); }
      else setMessage(unfinished);
    }
    listener.current?.stop(); speechCandidate.current = false; capturedQuestion.current = undefined; setDraft(''); setMic(false); interrupt();
  }, [blocked, interrupt]);
  useEffect(() => { if (question) player.pause(); else if (!speechCandidate.current && !exit.current) player.resume(); }, [question?.id, player]);
  const say = useCallback(async (body: string, id: string = crypto.randomUUID()) => {
    const owner = current.current, callId = owner.callId; if (!callId || !body.trim()) return;
    setSpeaking(true);
    try { await player.play(client, callId, id, body); }
    finally { if (current.current === owner && owner.live) setSpeaking(false); }
  }, [client, player]);
  useEffect(() => {
    const call = value?.call;
    if (blocked || question || exit.current || speechCandidate.current || !call || call.kind !== 'conversation' || call.endedAtMs !== undefined || current.current.callId !== call.callId) return;
    for (const turn of call.turns) {
      if (turn.role !== 'assistant' || !turn.complete || turn.failed || spoken.current.has(turn.id)) continue;
      spoken.current.add(turn.id);
      const texts = sentence ? spokenSentences(turn.text) : [turn.text], speechOwner = speechGeneration.current;
      speechTail.current = speechTail.current.catch(() => undefined).then(async () => {
        if (!current.current.live || current.current.callId !== call.callId || speechOwner !== speechGeneration.current) return;
        for (const [index, text] of texts.entries()) {
          if (!current.current.live || current.current.callId !== call.callId || speechOwner !== speechGeneration.current) return;
          while (current.current.live && current.current.callId === call.callId && speechOwner === speechGeneration.current
            && (questionRef.current || speechCandidate.current || exit.current)) await new Promise<void>(resolve => window.setTimeout(resolve, 50));
          if (!current.current.live || current.current.callId !== call.callId || speechOwner !== speechGeneration.current) return;
          const key = JSON.stringify([call.callId, turn.id, index]);
          if (!speechRequestIds.current.has(key)) speechRequestIds.current.set(key, crypto.randomUUID());
          await say(text, speechRequestIds.current.get(key)!);
        }
      }).catch(() => { if (current.current.live) setError(true); });
    }
  }, [value?.call, sentence, say, blocked, question?.id, countdown]);
  const cancelExit = useCallback(() => {
    semanticVersion.current++; exit.current = undefined; idleSince.current = undefined; setCountdown(undefined);
    if (!questionRef.current && !speechCandidate.current) player.resume();
  }, [player]);
  const beginExit = (reason: 'idle' | 'farewell' | 'semantic') => {
    if (!current.current.callId) return;
    const delay = reason === 'idle' ? 10_000 : 3000;
    player.pause(); exit.current = { reason, deadline: Date.now() + delay }; setCountdown({ reason, seconds: delay / 1000 });
  };
  idleCheck.current = () => current.current.kind === 'conversation' && Boolean(current.current.callId) && mic && hasSpeechSession.current
    && !blocked && !question && !busy && !speaking && !speechCandidate.current && !draft.trim() && !message.trim() && !questionDraft.trim()
    && !pendingInput.current && pendingSends.current.size === 0 && !(value?.call?.handoffs.some(row => ['sending', 'accepted'].includes(row.state)))
    && !(value?.call?.turns.at(-1)?.role === 'user' && !value.call.turns.at(-1)?.failed && !value.call.handoffs.some(row => row.inputId === value.call!.turns.at(-1)?.id))
    && !(value?.call?.turns.some(turn => !turn.complete)) && !['running', 'waiting', 'retrying'].includes(session.state)
    && !(controller.state.snapshot?.queue.some(row => row.sessionId === session.id && ['accepted', 'dispatching', 'acceptedByBackend', 'dispatchUnknown'].includes(row.state)))
    && !(controller.state.snapshot?.backgroundTasks.some(row => row.sessionId === session.id && ['queued', 'running', 'waiting', 'unknown'].includes(row.state)));
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!current.current.live || !current.current.callId) return;
      const now = Date.now(), countdown = exit.current;
      if (countdown) {
        if (countdown.reason === 'idle' && !idleCheck.current()) { exit.current = undefined; idleSince.current = undefined; setCountdown(undefined); player.resume(); return; }
        if (now >= countdown.deadline) {
          if (pendingSends.current.size || pendingInput.current) { setCountdown({ reason: countdown.reason, seconds: 0, waiting: true }); return; }
          void stop().then(() => { if (current.current.live) onClose(); });
        } else setCountdown(previous => previous?.seconds === Math.ceil((countdown.deadline - now) / 1000) ? previous : { reason: countdown.reason, seconds: Math.ceil((countdown.deadline - now) / 1000) });
      } else if (idleCheck.current()) {
        idleSince.current ??= now; if (now - idleSince.current >= 60_000) beginExit('idle');
      } else idleSince.current = undefined;
    }, 250);
    return () => window.clearInterval(timer);
  }, [client, player, stop, onClose]);
  const startMic = async () => {
    if (blocked || !current.current.callId || current.current.kind !== 'conversation') return;
    listener.current?.stop();
    hasSpeechSession.current = false;
    const next = new ContinuousVoiceListener({ api: controller, onSpeech: () => {
      const question = questionRef.current;
      capturedQuestion.current = { pending: Boolean(question), target: question?.runId ? currentVoiceQuestionTarget(serverId, session.id, question.runId) : undefined };
      speechCandidate.current = true; semanticVersion.current++; exit.current = undefined; idleSince.current = undefined; setCountdown(undefined); player.pause();
    }, onDraft: setDraft, onEmpty: () => {
      speechCandidate.current = false; capturedQuestion.current = undefined; if (!questionRef.current && !exit.current) player.resume();
    },
      onText: (id, text) => {
        const callId = current.current.callId; if (!callId) return;
        speechCandidate.current = false; setDraft('');
        const captured = capturedQuestion.current; capturedQuestion.current = undefined;
        const local = !pendingInput.current && !pendingSends.current.size && !questionDraftRef.current ? voiceExitIntent(text) : null;
        if (local === 'command') { void stop().then(() => { if (current.current.live) onClose(); }); return; }
        if (local === 'farewell') { beginExit('farewell'); return; }
        const question = questionRef.current;
        if (captured?.pending || question) {
          const target = question?.runId ? currentVoiceQuestionTarget(serverId, session.id, question.runId) : undefined;
          if (captured?.target && target === captured.target && target.isCurrent()) { target.receive(text); setQuestionDraft(''); retainedQuestion.current = undefined; }
          else { retainedQuestion.current = captured?.target; setQuestionDraft(text); }
          return;
        }
        // SUBMIT cancels the previous reply atomically in the service. A
        // separate concurrent INTERRUPT could otherwise arrive after SUBMIT.
        void interrupt(false); current.current.readId++;
        const version = semanticVersion.current;
        const submitted = client.control(Action.SUBMIT, { callId, inputId: id, text }); pendingSends.current.add(submitted);
        void submitted.then(() => { if (current.current.live) void read(); }).catch(() => {
          if (current.current.live) { pendingInput.current = { inputId: id, text, forceHandoff: false }; setMessage(text); setError(true); listener.current?.stop(); setMic(false); }
        }).finally(() => pendingSends.current.delete(submitted));
        void client.control(Action.CLASSIFY_EXIT, { callId, inputId: id, text }).then(async decision => {
          if (decision.exitDecision === 'continue' || current.current.callId !== callId || version !== semanticVersion.current) return;
          await submitted;
          if (current.current.callId !== callId || version !== semanticVersion.current) return;
          if (decision.exitDecision === 'submit_then_exit') {
            setCountdown({ reason: 'semantic', seconds: 0, waiting: true });
            const result = await client.control(Action.PROMOTE, { callId, inputId: id });
            if (current.current.callId !== callId || version !== semanticVersion.current) return;
            if (result.call?.handoffs.some(row => row.inputId === id && ['accepted', 'completed'].includes(row.state))) await stop().then(onClose);
            else setCountdown(undefined);
          } else if (decision.exitDecision === 'exit') beginExit('semantic');
        }).catch(() => { if (current.current.callId === callId && version === semanticVersion.current) { setCountdown(undefined); setError(true); } });
      }, onState: state => { if (state === 'listening') hasSpeechSession.current = true; setMicState(state); }, onFailure: partial => {
        if (capturedQuestion.current?.pending && partial.trim()) { retainedQuestion.current = capturedQuestion.current.target; setQuestionDraft(partial); }
        else if (partial.trim()) setMessage(partial);
        speechCandidate.current = false; capturedQuestion.current = undefined; setDraft(''); setMic(false); setError(true);
      } });
    listener.current = next; setMic(true);
    try { await next.start(); } catch { next.stop(); if (current.current.live) { setMic(false); setError(true); } }
  };
  const start = async (playbackOnly: boolean, chosen: DesktopSpeechSelection | undefined) => {
    if (!chosen) { setSettings(true); return; }
    if (current.current.callId) await stop();
    const callId = crypto.randomUUID(), operationId = `voice-start-${callId}`;
    const result = await client.control(Action.START, { callId, operationId, selection: chosen, playbackOnly });
    if (!current.current.live) { void client.control(Action.END, { callId }).catch(() => undefined); return; }
    current.current.callId = callId; current.current.kind = playbackOnly ? 'playback' : 'conversation';
    setValue(result); spoken.current.clear(); speechRequestIds.current.clear();
    if (!playbackOnly) await startMic();
  };
  const save = (reset: boolean) => void action(async () => {
    if (!saveRequest.current) saveRequest.current = { operationId: crypto.randomUUID(), preference: create(DesktopVoiceConversationPreferenceSchema, {
      ...(reset ? {} : { conversation, playback }), sentencePlayback: reset ? true : sentence, revision: value?.preference?.revision ?? 0n }) };
    const result = await client.control(Action.SAVE_PREFERENCE, saveRequest.current);
    if (current.current.live) { setValue(result); setSettings(false); setNotice(text.saved); saveRequest.current = undefined; }
  });
  const changed = () => { saveRequest.current = undefined; setNotice(''); };
  const call = value?.call, active = Boolean(current.current.callId && call && call.endedAtMs === undefined);
  const playText = (body: string, selected = playback ?? conversation) => void action(async () => {
    if (blocked) return;
    if (!body.trim() || !selected) { setSettings(true); return; }
    if (current.current.callId && current.current.kind === 'conversation') { await interrupt(); await say(body); return; }
    await start(true, selected);
    try { await say(body); } finally { await stop(); }
  });
  const send = (forceHandoff: boolean) => void action(async () => {
    if (!current.current.callId || !message.trim()) return;
    cancelExit();
    if (pendingInput.current?.text !== message || pendingInput.current.forceHandoff !== forceHandoff) pendingInput.current = { inputId: crypto.randomUUID(), text: message, forceHandoff };
    const submitted = client.control(Action.SUBMIT, { callId: current.current.callId, ...pendingInput.current }); pendingSends.current.add(submitted);
    try { await submitted; if (current.current.live) { pendingInput.current = undefined; setMessage(''); } }
    finally { pendingSends.current.delete(submitted); }
  });
  return createPortal(<div ref={surface} role="dialog" tabIndex={-1} aria-label={text.title} className="desktop-voice-conversation"
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing) { event.stopPropagation(); void stop(); onClose(); } }}>
    <header className="desktop-voice-conversation__heading"><div><strong>{text.title}</strong><p>{session.name} · {text.body}</p></div><Button aria-label={text.close} onClick={() => { void stop(); onClose(); }}>{text.close}</Button></header>
    <div className="desktop-voice-conversation__actions">
      <Button disabled={busy || active || blocked} tone="primary" onClick={() => void action(() => start(false, conversation))}>{text.start}</Button>
      {active && <><Button disabled={busy} onClick={() => { void stop().then(read); }}>{text.end}</Button>
        {current.current.kind === 'conversation' && <Button aria-pressed={mic} disabled={busy || blocked} onClick={() => {
          cancelExit();
          if (mic) {
            if (capturedQuestion.current?.pending && listener.current?.draft.trim()) { retainedQuestion.current = capturedQuestion.current.target; setQuestionDraft(listener.current.draft); }
            else if (listener.current?.draft.trim()) setMessage(listener.current.draft);
            listener.current?.stop(); speechCandidate.current = false; capturedQuestion.current = undefined; setDraft(''); setMic(false); player.resume();
          } else void startMic();
        }}>{mic ? text.mute : text.unmute}</Button>}
        <Button onClick={() => { void interrupt(); }}>{speaking ? text.stop : text.interrupt}</Button></>}
      <Button aria-expanded={settings} disabled={busy || active} onClick={() => setSettings(value => !value)}>{text.settings}</Button>
    </div>
    <p role="status">{notice || (busy ? text.loading : mic ? micState === 'starting' ? text.starting : micState === 'submitting' ? text.submitting : text.listening : active ? text.ready : '')}</p>
    {draft && <p role="status">{draft}</p>}
    {question && <p role="status">{text.questionHint}</p>}
    {questionDraft && <div><label>{text.questionDraft}<textarea readOnly value={questionDraft} /></label>
      <Button disabled={!retainedQuestion.current?.isCurrent()} onClick={() => { const target = retainedQuestion.current; if (target?.isCurrent()) target.receive(questionDraft); retainedQuestion.current = undefined; setQuestionDraft(''); }}>{text.retryQuestion}</Button>
      <Button onClick={() => { retainedQuestion.current = undefined; setQuestionDraft(''); }}>{text.close}</Button></div>}
    {countdown && <div role="status">{countdown.waiting ? text.waiting : `${text.countdown} ${countdown.seconds}`}
      <Button onClick={cancelExit}>{text.continueCall}</Button></div>}
    {blocked && <p role="status">{text.paused}</p>}
    {error && <p role="alert">{text.unavailable}<Button disabled={busy} onClick={() => { void read(); }}>{text.retry}</Button></p>}
    {settings && <div className="desktop-voice-conversation__settings">
      {!value?.models.length && <p>{text.empty}</p>}
      <SpeechChoice title={text.conversation} value={conversation} models={value?.models ?? []} client={client} disabled={busy || blocked} language={controller.state.effectiveLocale}
        onChange={next => { changed(); setConversation(next); }} onPreview={selection => playText(text.previewText, selection)} />
      <SpeechChoice title={text.playback} value={playback} models={value?.models ?? []} client={client} disabled={busy || blocked} language={controller.state.effectiveLocale}
        onChange={next => { changed(); setPlayback(next); }} onPreview={selection => playText(text.previewText, selection)} />
      <label className="desktop-voice-conversation__check"><CheckboxControl checked={sentence} disabled={busy} onChange={event => { changed(); setSentence(event.target.checked); }} />{text.sentence}</label>
      <div className="desktop-voice-conversation__actions"><Button disabled={busy} onClick={() => save(false)}>{text.save}</Button><Button disabled={busy} onClick={() => save(true)}>{text.reset}</Button></div>
    </div>}
    {call && <section className="desktop-voice-conversation__transcript" aria-label={text.title} aria-live="polite">
      {call.turns.map(turn => <article key={turn.id} className={`desktop-voice-conversation__turn desktop-voice-conversation__turn--${turn.role}`}>
        <strong>{turn.role === 'user' ? text.user : text.speaker}</strong><p>{turn.text}</p>
        {turn.failed && <p>{text.failed}</p>}
        {turn.failed && turn.role === 'user' && active && <Button disabled={busy} onClick={() => void action(() => client.control(
          call.handoffs.some(row => row.inputId === turn.id) ? Action.PROMOTE : Action.SUBMIT,
          { callId: call.callId, inputId: turn.id, text: turn.text }))}>{text.retry}</Button>}
        {turn.complete && <div className="desktop-voice-conversation__actions">
          {turn.role === 'user' && active && <Button disabled={busy || call.handoffs.some(row => row.inputId === turn.id && ['accepted', 'completed', 'sending'].includes(row.state))}
            onClick={() => void action(() => client.control(Action.PROMOTE, { callId: call.callId, inputId: turn.id }))}>{text.handoff}</Button>}
          {turn.role === 'assistant' && <Button disabled={busy} onClick={() => playText(turn.text)}><Volume2 aria-hidden="true" />{text.read}</Button>}
        </div>}
      </article>)}
      {call.handoffs.map(row => <details key={row.id}><summary>{text.work} · {row.state === 'accepted' ? text.accepted : row.state === 'completed' ? text.completed : row.state === 'sending' ? text.sending : text.failed}</summary>
        <p>{row.text}</p>{row.result && <p>{text.returned}: {row.result}</p>}</details>)}
    </section>}
    {active && current.current.kind === 'conversation' && <form onSubmit={event => { event.preventDefault(); send(false); }} className="desktop-voice-conversation__input">
      <label>{text.text}<textarea value={message} maxLength={32_000} onChange={event => setMessage(event.target.value)} /></label>
      <div className="desktop-voice-conversation__actions"><Button type="submit" disabled={busy || !message.trim()}>{text.send}</Button><Button disabled={busy || !message.trim()} onClick={() => send(true)}>{text.handoff}</Button></div>
    </form>}
    {!active && <form onSubmit={event => { event.preventDefault(); playText(reading); }} className="desktop-voice-conversation__input">
      <label>{text.readText}<textarea value={reading} maxLength={32_000} onChange={event => setReading(event.target.value)} /></label>
      <Button type="submit" disabled={busy || !reading.trim()}>{text.read}</Button>
    </form>}
    <details><summary>{text.history}</summary>{!value?.history.length && <p>{text.noCalls}</p>}
      {value?.history.map(row => <details key={row.callId}><summary>{new Date(Number(row.startedAtMs)).toLocaleString()} · {row.endedAtMs === undefined ? text.ready : text.cancelled}</summary>
        {row.endedAtMs !== undefined && !historyDetails[row.callId] && <Button disabled={busy} onClick={() => void action(async () => {
          const result = await client.control(Action.SNAPSHOT, { callId: row.callId });
          if (current.current.live && result.call?.callId === row.callId) setHistoryDetails(previous => ({ ...previous, [row.callId]: result.call! }));
        })}>{text.details}</Button>}
        {historyDetails[row.callId]?.turns.map(turn => <p key={turn.id}><strong>{turn.role === 'user' ? text.user : text.speaker}</strong> {turn.text}</p>)}
      </details>)}
    </details>
  </div>, document.body);
}

function SpeechChoice({ title, value, models, client, disabled, language, onChange, onPreview }: {
  readonly title: string; readonly value: DesktopSpeechSelection | undefined; readonly models: readonly DesktopSpeechModel[];
  readonly client: DesktopVoiceClient; readonly disabled: boolean; readonly language: string;
  readonly onChange: (value: DesktopSpeechSelection | undefined) => void; readonly onPreview: (value: DesktopSpeechSelection) => void;
}): JSX.Element {
  const text = language === 'zh-CN' ? zh : en;
  const catalogId = useId();
  const [catalog, setCatalog] = useState<DesktopSpeechVoiceCatalog>(), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const selectionKey = value ? JSON.stringify([key(value), value.protocol]) : '';
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setCatalog(undefined); setFailed(false); setLoading(false); }, [selectionKey]);
  const current = models.find(model => value && key(model) === key(value));
  const speedRange = value ? speechSpeedRange(value.modelId, value.protocol as SpeechProtocol) : null;
  useEffect(() => () => { sequence.current++; }, []);
  const patch = (body: Partial<DesktopSpeechSelection>) => { if (value) onChange(create(DesktopSpeechSelectionSchema, { ...value, ...body })); };
  return <fieldset disabled={disabled} className="desktop-voice-conversation__choice"><legend>{title}</legend>
    <label>{text.model}<SelectControl value={value ? key(value) : ''} onChange={event => {
      const model = models.find(row => key(row) === event.target.value);
      onChange(model ? create(DesktopSpeechSelectionSchema, { backendId: model.backendId, providerId: model.providerId, modelId: model.modelId,
        protocol: model.protocol ?? '', voice: '' }) : undefined);
    }}><option value="">{text.none}</option>
      {value && !current && <option value={key(value)}>{value.modelId} · {text.missing}</option>}
      {models.map(model => <option key={key(model)} value={key(model)}>{model.providerName} · {model.displayName}</option>)}
    </SelectControl></label>
    {value && <><label>{text.protocol}<SelectControl value={value.protocol} disabled={current?.protocolLocked} onChange={event => patch({ protocol: event.target.value, speed: undefined })}>
      <option value="">{text.choose}</option>{protocols.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
    </SelectControl></label>
      <label>{text.voice}<input value={value.voice} maxLength={256} placeholder={text.manual} onChange={event => patch({ voice: event.target.value })} list={catalogId} /></label>
      <datalist id={catalogId}>{catalog?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</datalist>
      {speedRange && <label>{text.speed}<input type="number" min={speedRange.min} max={speedRange.max} step="0.05" value={value.speed ?? ''} placeholder={text.automatic}
        onChange={event => patch({ speed: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>}
      <div className="desktop-voice-conversation__actions"><Button disabled={loading || !value.protocol || !current} onClick={() => {
        const id = ++sequence.current, original = selectionKey; setLoading(true); setFailed(false);
        // Voice lists need the exact model/protocol; a nonempty temporary ID
        // permits catalog discovery without inventing a saved default voice.
        void client.control(Action.VOICES, { selection: { ...value, voice: value.voice || 'catalog' } }).then(result => {
          if (id === sequence.current && original === selectionKey) setCatalog(result.voices);
        }).catch(() => { if (id === sequence.current) setFailed(true); }).finally(() => { if (id === sequence.current) setLoading(false); });
      }}>{loading ? text.loading : text.catalog}</Button><Button disabled={!value.voice.trim() || !value.protocol || !current} onClick={() => onPreview(value)}>{text.preview}</Button></div>
      {failed && <p role="alert">{text.unavailable}</p>}{catalog?.truncated && <p>{text.truncated}</p>}{catalog?.customVoicesUnavailable && <p>{text.voicesUnavailable}</p>}
    </>}
  </fieldset>;
}
