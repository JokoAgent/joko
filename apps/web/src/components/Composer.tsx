import type { DragEvent, JSX, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSONContent } from "@tiptap/core";
import {
  AlertTriangle,
  AtSign,
  CircleCheck,
  CircleStop,
  Clock3,
  GripVertical,
  Image as ImageIcon,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Send,
  Sparkles,
  Terminal,
  X,
  Zap
} from "lucide-react";
import type { AppController } from "../controller.js";
import type { ComposerSendShortcutPreference } from "../local-state.js";
import { isConversationModel } from "../model-capabilities.js";
import type { AttachmentDraft, BackendView, BrowserCommentDraftItem, ComposerDraft, ComposerMentionDraft, ComposerMessageMentionDraft, ComposerSelectionQuoteDraft, DeliveryMode, ExtraDirectoryView, QueueControlView, QueueItemView, ResourceView, RuntimeCommandView, SessionView, UsageTokensView, WorkspaceView } from "../model.js";
import { browserCommentPreviewTag, removeBrowserCommentAndRepairChains } from "../browser-comment-draft.js";
import { appendQuoteToComposerDocument, appendTextToComposerDocument, composerDocumentIsEmpty, composerDocumentKeepingQuotes, composerDocumentPlainText, composerDocumentQuotes, emptyComposerDocument, joinComposerDocuments, normalizeComposerDocument, plainTextToComposerDocument } from "../composer-quote-document.js";
import { advertisedQueueDeliveryModes } from "./backend-control-capabilities.js";
import { upsertComposerMention } from "../message-reference.js";
import { normalizeSelectionQuoteDrafts } from "../selection-quote.js";
import { randomUuid } from "../web-crypto.js";
import { promptRecommendationStore } from "../prompt-recommendation-store.js";
import { ComposerOperationGuard, composerQueueWindow, currentComposerPlatform, getComposerSendShortcutLabel, resolveComposerAttachmentPolicy, resolveComposerEnterIntent, resolveComposerEscapeIntent, resolveComposerHistoryKey, resolveComposerPaletteKey, resolveQueueReorderShortcut, resolveTypedComposerPalette, resolveUserShellDraft, type ComposerSubmissionKind } from "./composer-behavior.js";
import { composerBuiltInCommand, composerCommandItems, insertComposerPaletteValue, type ComposerPaletteItem } from "./composer-palette.js";
import { ComposerInlineMentionPanel } from "./composer-inline-mention-panel.js";
import { ComposerAddMenu } from "./ComposerAddMenu.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { composerCaretTextOffset, composerDirectoryQueryToken, composerMentionCatalog, composerMentionsFromRanges, composerSelectionTextRange, detectComposerInlineMention, firstEnabledComposerMentionIndex, remapComposerInlineMentionRanges, replaceComposerDocumentTextRange, resolveComposerInlineMentionKey, resolveComposerMentionResults, restoreComposerInlineMentionRanges, setComposerCaretTextOffset, type ComposerInlineMentionActivation, type ComposerInlineMentionRange, type ComposerMentionCatalogItem, type ComposerMentionProviderState } from "./composer-inline-mention.js";
import { ContextCapacityRing } from "./ContextCapacityRing.js";
import { SessionUsageChip } from "./SessionUsageChip.js";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";
import { ComposerPastedTextDialog, type ComposerPastedTextDialogTarget } from "./ComposerPastedTextDialog.js";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { resolveComposerRouteReferenceFromRuntime } from "./composer-route-reference-runtime.js";
import { hasComposerInternalDrop, resolveComposerInternalDrop } from "./composer-internal-drop.js";
import { isComposerBlankPointerTarget } from "./composer-blank-focus.js";
import { shouldAutoFocusComposer } from "./composer-auto-focus.js";
import { isPromptRecommendationAcceptKey, PromptRecommendationEditorFrame, shouldShowPromptRecommendation } from "./PromptRecommendationOverlay.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, SegmentedControl, cx, CheckboxControl, SelectControl, formatBytes } from "./ui.js";
import { supportsVoiceMediaCapture, VoiceInputMediaSession, type VoiceMediaError, type VoiceMediaSessionUpdate } from "../voice-input-media.js";
import { matchesVoiceInputShortcut, readVoiceInputPreferences, releasesVoiceInputShortcut, subscribeVoiceInputPreferences, voiceInputLocale, writeVoiceInputPreferences } from "../voice-input-preferences.js";
import { VoiceInputOverlay } from "./VoiceInputOverlay.js";
import { applyVoiceDraftResult, createVoiceDraftFence, type VoiceDraftFence } from "./voice-draft-fence.js";
import { recordVoiceInputSession } from "../voice-input-history.js";
import { VoiceInputMicrophonePrewarmer } from "../voice-input-prewarm.js";
import { applyVoiceDictionaryAdvice, voiceDictionaryAdviceDraft } from "../voice-input-dictionary.js";
import { createVoiceInsertedEditTracker, inspectVoiceInsertedEdit, type VoiceInsertedEditTracker } from "./voice-inserted-edit.js";

export interface ComposerHistoryEntry {
  readonly text: string;
  readonly editorDocument: JSONContent;
}

interface ComposerWorkspaceMentionIndex {
  readonly workspaceId: string;
  readonly status: "loading" | "ready" | "error";
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly error?: string;
}

interface PendingVoiceDictionaryEdit {
  readonly tracker: VoiceInsertedEditTracker;
  readonly generation: number;
  timer?: number;
  request?: AbortController;
  evidenceKey?: string;
}

export function Composer({ controller, session, backend, sessionUsage, readOnly = false, autoFocus = true, focusRequest = 0, queue, queueControl, workspace, extraDirectories, resources, commands, messageHistory, controls, runningStatus, messageMentionInsertion, selectionQuoteInsertion, attachmentInsertion, draftReplacement, t, runAction, onLocalSend, onStop, stopInFlight = false, onCompact }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly backend?: BackendView;
  readonly sessionUsage?: UsageTokensView;
  /** Reviewer tasks keep the composer visible but freeze every mutation. */
  readonly readOnly?: boolean;
  readonly autoFocus?: boolean;
  /** Monotonic request used by adjacent controls to return focus to the editor. */
  readonly focusRequest?: number;
  readonly queue: readonly QueueItemView[];
  readonly queueControl?: QueueControlView;
  readonly workspace?: WorkspaceView;
  readonly extraDirectories: readonly ExtraDirectoryView[];
  readonly resources: readonly ResourceView[];
  readonly commands: readonly RuntimeCommandView[];
  readonly messageHistory: readonly ComposerHistoryEntry[];
  readonly controls?: ReactNode;
  readonly runningStatus?: ReactNode;
  readonly messageMentionInsertion?: { readonly id: number; readonly sessionId: string; readonly mention: ComposerMessageMentionDraft };
  readonly selectionQuoteInsertion?: { readonly id: number; readonly sessionId: string; readonly quote: ComposerSelectionQuoteDraft };
  readonly attachmentInsertion?: { readonly id: number; readonly sessionId: string; readonly file: File };
  readonly draftReplacement?: { readonly id: number; readonly sessionId: string; readonly text: string; readonly editorDocument?: JSONContent; readonly attachments?: readonly AttachmentDraft[] };
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onLocalSend: (sessionId: string) => void;
  readonly onStop?: () => void;
  readonly stopInFlight?: boolean;
  readonly onCompact?: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [editorDocument, setEditorDocument] = useState<JSONContent>(emptyComposerDocument);
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [browserComments, setBrowserComments] = useState<readonly BrowserCommentDraftItem[]>([]);
  const [mentions, setMentions] = useState<readonly ComposerMentionDraft[]>([]);
  const [inlineMentionRanges, setInlineMentionRanges] = useState<readonly ComposerInlineMentionRange[]>([]);
  const [inlineMentionActivation, setInlineMentionActivation] = useState<(ComposerInlineMentionActivation & { readonly source: "typed" | "button" })>();
  const [inlineMentionActiveIndex, setInlineMentionActiveIndex] = useState(0);
  const [extraDirectoryIds, setExtraDirectoryIds] = useState<readonly string[] | undefined>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("prompt");
  const [hydratedSession, setHydratedSession] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [palette, setPalette] = useState<"add" | "mention" | "commands">();
  const [workspaceMentionIndex, setWorkspaceMentionIndex] = useState<ComposerWorkspaceMentionIndex>();
  const [workspaceMentionReload, setWorkspaceMentionReload] = useState(0);
  const [queueExpandedSessionId, setQueueExpandedSessionId] = useState<string>();
  const [bashMode, setBashMode] = useState(false);
  const [bashExcluded, setBashExcluded] = useState(false);
  const [submissionKind, setSubmissionKind] = useState<ComposerSubmissionKind>();
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [voiceSupport, setVoiceSupport] = useState<"loading" | "supported" | "unavailable">("loading");
  const [voiceUpdate, setVoiceUpdate] = useState<VoiceMediaSessionUpdate>();
  const [voicePreferences, setVoicePreferences] = useState(readVoiceInputPreferences);
  const [pastedTextTarget, setPastedTextTarget] = useState<ComposerPastedTextDialogTarget>();
  const [commandHelpOpen, setCommandHelpOpen] = useState(false);
  const richEditorRef = useRef<ComposerRichTextEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerStackRef = useRef<HTMLDivElement>(null);
  const focusAnchorRef = useRef<Element | null>(null);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const browserCommentsRef = useRef(browserComments);
  browserCommentsRef.current = browserComments;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const operationGuardRef = useRef(new ComposerOperationGuard());
  operationGuardRef.current.activate(session.id);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const typedPaletteTriggerRef = useRef<"/" | "@" | undefined>(undefined);
  const textRef = useRef(text);
  textRef.current = text;
  const editorDocumentRef = useRef(editorDocument);
  editorDocumentRef.current = editorDocument;
  const editorRevisionRef = useRef(0);
  const voiceSessionRef = useRef<VoiceInputMediaSession | undefined>(undefined);
  const voicePrewarmerRef = useRef<VoiceInputMicrophonePrewarmer | undefined>(undefined);
  const voiceShortcutHeldRef = useRef(false);
  const voiceFenceRef = useRef<VoiceDraftFence | undefined>(undefined);
  const appliedVoiceResultRef = useRef<string | undefined>(undefined);
  const voiceDictionaryEditRef = useRef<PendingVoiceDictionaryEdit | undefined>(undefined);
  const voiceDictionaryEditGenerationRef = useRef(0);
  const inlineMentionRangesRef = useRef(inlineMentionRanges);
  inlineMentionRangesRef.current = inlineMentionRanges;
  const inlineMentionActivationRef = useRef(inlineMentionActivation);
  inlineMentionActivationRef.current = inlineMentionActivation;
  const suppressedInlineMentionFromRef = useRef<number | undefined>(undefined);
  const lastComposerCaretRef = useRef<number | undefined>(undefined);
  const historyDraftRef = useRef<{ readonly text: string; readonly mentions: readonly ComposerMentionDraft[]; readonly inlineMentionRanges: readonly ComposerInlineMentionRange[]; readonly editorDocument: JSONContent } | undefined>(undefined);
  const hydratedHistoryDraftRef = useRef<string | undefined>(undefined);
  const appliedEditorEffectRef = useRef<string | undefined>(undefined);
  const appliedMessageMentionInsertionRef = useRef<number | undefined>(undefined);
  const appliedSelectionQuoteInsertionRef = useRef<number | undefined>(undefined);
  const appliedAttachmentInsertionRef = useRef<number | undefined>(undefined);
  const appliedDraftReplacementRef = useRef<number | undefined>(undefined);
  const promptRecommendationRevision = useSyncExternalStore(
    promptRecommendationStore.subscribe,
    promptRecommendationStore.getRevision
  );
  const editorTextUpdate = controller.state.editorTextUpdate;
  const selectionQuotes = useMemo(() => composerDocumentQuotes(editorDocument), [editorDocument]);

  useEffect(() => {
    if (workspace === undefined) {
      setWorkspaceMentionIndex(undefined);
      return;
    }
    const requestController = new AbortController();
    const workspaceId = workspace.id;
    setWorkspaceMentionIndex((current) => ({
      workspaceId,
      status: "loading",
      paths: current?.workspaceId === workspaceId ? current.paths : [],
      truncated: current?.workspaceId === workspaceId ? current.truncated : false
    }));
    void controllerRef.current.listWorkspaceFiles(workspaceId, requestController.signal).then((index) => {
      if (requestController.signal.aborted) return;
      setWorkspaceMentionIndex({
        workspaceId,
        status: "ready",
        paths: index.paths,
        truncated: index.truncated
      });
    }).catch(() => {
      if (requestController.signal.aborted) return;
      setWorkspaceMentionIndex((current) => ({
        workspaceId,
        status: "error",
        paths: current?.workspaceId === workspaceId ? current.paths : [],
        truncated: current?.workspaceId === workspaceId ? current.truncated : false,
        error: t("composer.mentionLoadFailed")
      }));
    });
    return () => requestController.abort();
  }, [t, workspace?.id, workspace?.revision, workspaceMentionReload]);

  const modelRouteUnavailable = session.model !== undefined
    && (!isConversationModel(session.model) || !session.model.available || session.model.routingEnabled === false);
  const supportedModes = useMemo(
    () => modelRouteUnavailable ? [] : deliveryModesFor(session, backend),
    [backend, modelRouteUnavailable, session]
  );
  const visionBridgeRouted = controller.state.snapshot.settings.visionBridge.enabled && session.model !== undefined &&
    controller.state.snapshot.settings.visionBridge.targetModels.some((target) =>
      target.backendId === session.backendId && target.providerId === session.model?.providerId && target.modelId === session.model.modelId);
  const attachmentPolicy = useMemo(
    () => resolveComposerAttachmentPolicy(backend, session.model?.supportsImages === true || visionBridgeRouted),
    [backend, session.model?.supportsImages, visionBridgeRouted]
  );
  const bashCapable = backend?.capabilities.get("runtime.user_shell")?.supported === true;
  const sessionResetSupported = backend?.capabilities.get("session.reset")?.supported === true;
  const reviewSupported = backend?.capabilities.get("review.isolated")?.supported === true;
  const commandOptions = {
    helpSupported: true,
    jumpSessionSupported: true,
    userShellSupported: bashCapable,
    sessionResetSupported,
    reviewSupported
  } as const;
  const availableCommandItems = composerCommandItems(commands, [], commandOptions);
  const extraDirectoriesSupported = backend?.capabilities.get("workspace.extra_dirs")?.supported === true && workspace !== undefined;
  const selectableExtraDirectories = extraDirectories.filter((directory) => directory.workspaceId === workspace?.id && directory.trusted);
  const shellDraft = resolveUserShellDraft(text, bashMode, bashExcluded);
  const effectiveBashMode = shellDraft !== null && browserComments.length === 0;
  const bashPermitted = bashCapable;
  const turnRunning = session.state === "running" || session.state === "waiting" || session.state === "retrying";
  const stopCapability = session.state === "retrying" ? "context.auto_retry" : "turn.abort";
  const canStop = turnRunning && session.activeRunId !== undefined && backend?.capabilities.get(stopCapability)?.supported === true && onStop !== undefined;
  const voiceActive = voiceUpdate?.state === "starting" || voiceUpdate?.state === "listening" || voiceUpdate?.state === "submitting";
  const desktopGlobalVoiceShortcut = typeof window !== "undefined"
    && window.jokoDesktop?.capabilities.includes("voice.globalDictation") === true;
  const composerLocked = readOnly || submissionKind !== undefined || voiceActive;
  const composerEditorLocked = readOnly || (submissionKind !== undefined && submissionKind !== "send") || voiceActive;
  const sendShortcut = controller.state.preferences.composerSendShortcut;
  const composerPlatform = currentComposerPlatform();

  const resetHistoryNavigation = (): void => {
    setHistoryIndex(-1);
    historyDraftRef.current = undefined;
    hydratedHistoryDraftRef.current = undefined;
  };

  const closePalette = (restoreFocus = false): void => {
    typedPaletteTriggerRef.current = undefined;
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    setPalette(undefined);
    if (restoreFocus) requestAnimationFrame(() => richEditorRef.current?.focus());
  };

  const replaceInlineMentionRanges = (next: readonly ComposerInlineMentionRange[]): void => {
    inlineMentionRangesRef.current = next;
    setInlineMentionRanges(next);
  };

  const closeInlineMention = (restoreFocus: boolean, suppressTyped: boolean): void => {
    const activation = inlineMentionActivationRef.current;
    if (suppressTyped && activation?.source === "typed") suppressedInlineMentionFromRef.current = activation.from;
    closePalette(restoreFocus);
  };

  useEffect(() => subscribeVoiceInputPreferences(setVoicePreferences), []);

  useEffect(() => {
    if (
      readOnly
      || voiceSupport !== "supported"
      || !voicePreferences.fastActivationEnabled
      || typeof navigator === "undefined"
      || navigator.mediaDevices?.getUserMedia === undefined
    ) {
      voicePrewarmerRef.current?.release();
      voicePrewarmerRef.current = undefined;
      return;
    }
    const prewarmer = new VoiceInputMicrophonePrewarmer(navigator.mediaDevices);
    voicePrewarmerRef.current = prewarmer;
    const warm = (): void => { void prewarmer.warm(voicePreferences.deviceId); };
    warm();
    const releaseForHost = (): void => prewarmer.release();
    const visibilityChanged = (): void => {
      if (document.visibilityState === "visible") warm();
      else prewarmer.release();
    };
    const microphoneRelease = window.jokoDesktop?.microphone?.onRelease(releaseForHost);
    window.addEventListener("focus", warm);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      microphoneRelease?.();
      window.removeEventListener("focus", warm);
      document.removeEventListener("visibilitychange", visibilityChanged);
      prewarmer.release();
      if (voicePrewarmerRef.current === prewarmer) voicePrewarmerRef.current = undefined;
    };
  }, [readOnly, voicePreferences.deviceId, voicePreferences.fastActivationEnabled, voiceSupport]);

  useEffect(() => {
    if (readOnly || typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined || typeof MediaRecorder === "undefined") {
      setVoiceSupport("unavailable");
      return;
    }
    const request = new AbortController();
    setVoiceSupport("loading");
    void controllerRef.current.getVoiceInputCapabilities(request.signal).then((capability) => {
      if (!request.signal.aborted) setVoiceSupport(supportsVoiceMediaCapture(capability, globalThis.MediaRecorder) ? "supported" : "unavailable");
    }).catch(() => {
      if (!request.signal.aborted) setVoiceSupport("unavailable");
    });
    return () => request.abort();
  }, [readOnly, session.id]);

  useEffect(() => () => {
    const active = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    void active?.dispose();
    const dictionaryEdit = voiceDictionaryEditRef.current;
    if (dictionaryEdit?.timer !== undefined) window.clearTimeout(dictionaryEdit.timer);
    dictionaryEdit?.request?.abort();
    voiceDictionaryEditRef.current = undefined;
  }, []);

  const clearVoiceDictionaryEdit = (): void => {
    const current = voiceDictionaryEditRef.current;
    if (current?.timer !== undefined) window.clearTimeout(current.timer);
    current?.request?.abort();
    voiceDictionaryEditRef.current = undefined;
  };

  const observeVoiceDictionaryEdit = (nextText: string, isComposing: boolean): void => {
    const current = voiceDictionaryEditRef.current;
    if (current === undefined || isComposing) return;
    if (
      current.tracker.sessionId !== session.id
      || !voicePreferences.autoDictionaryEnabled
      || !controller.state.snapshot.settings.voiceInput.refinementEnabled
    ) {
      clearVoiceDictionaryEdit();
      return;
    }
    const inspection = inspectVoiceInsertedEdit(current.tracker, nextText);
    if (!inspection.edited) {
      if (current.timer !== undefined) window.clearTimeout(current.timer);
      current.timer = undefined;
      current.evidenceKey = undefined;
      current.request?.abort();
      current.request = undefined;
      return;
    }
    const evidenceKey = JSON.stringify(inspection);
    if (current.evidenceKey === evidenceKey && (current.timer !== undefined || current.request !== undefined)) return;
    if (current.timer !== undefined) window.clearTimeout(current.timer);
    current.request?.abort();
    current.request = undefined;
    current.evidenceKey = evidenceKey;
    const generation = current.generation;
    current.timer = window.setTimeout(() => {
      const pending = voiceDictionaryEditRef.current;
      if (pending === undefined || pending.generation !== generation || pending.evidenceKey !== evidenceKey) return;
      pending.timer = undefined;
      const preferences = readVoiceInputPreferences();
      if (!preferences.autoDictionaryEnabled) {
        voiceDictionaryEditRef.current = undefined;
        return;
      }
      const request = new AbortController();
      pending.request = request;
      const locale = voiceInputLocale(preferences);
      void controllerRef.current.adviseVoiceInputDictionaryEdit(voiceDictionaryAdviceDraft(preferences.dictionary, {
        beforeText: inspection.beforeText,
        afterText: inspection.afterText,
        ...(inspection.rawTranscriptText === undefined ? {} : { rawTranscriptText: inspection.rawTranscriptText }),
        ...(locale === undefined ? {} : { locale })
      }), request.signal).then((advice) => {
        const active = voiceDictionaryEditRef.current;
        if (request.signal.aborted || active?.generation !== generation || active.evidenceKey !== evidenceKey) return;
        const latest = readVoiceInputPreferences();
        if (!latest.autoDictionaryEnabled) return;
        const dictionary = applyVoiceDictionaryAdvice(latest.dictionary, advice.actions);
        if (dictionary !== latest.dictionary) writeVoiceInputPreferences({ dictionary });
      }).catch(() => undefined).finally(() => {
        const active = voiceDictionaryEditRef.current;
        if (active?.generation === generation && active.evidenceKey === evidenceKey) {
          voiceDictionaryEditRef.current = undefined;
        }
      });
    }, 1_200);
  };

  const applyVoiceTranscript = (voiceSession: NonNullable<VoiceMediaSessionUpdate["session"]>): boolean => {
    const result = voiceSession?.result;
    const fence = voiceFenceRef.current;
    if (result === undefined || fence === undefined || appliedVoiceResultRef.current === voiceSession.id) return false;
    appliedVoiceResultRef.current = voiceSession.id;
    const applied = applyVoiceDraftResult({
      fence,
      sessionId: session.id,
      revision: editorRevisionRef.current,
      document: editorDocumentRef.current,
      text: textRef.current,
      transcript: result.text
    });
    if (!applied.applied) {
      if (applied.reason !== "empty") setAttachmentError(t("voice.errors.draftChanged"));
      return false;
    }
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, applied.text, inlineMentionRangesRef.current);
    editorDocumentRef.current = applied.document;
    setEditorDocument(applied.document);
    textRef.current = applied.text;
    setText(applied.text);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    if (voicePreferences.autoDictionaryEnabled && controller.state.snapshot.settings.voiceInput.refinementEnabled) {
      voiceDictionaryEditRef.current = {
        tracker: createVoiceInsertedEditTracker({
          fence,
          insertedText: result.text,
          ...(result.rawTranscriptText === undefined ? {} : { rawTranscriptText: result.rawTranscriptText })
        }),
        generation: ++voiceDictionaryEditGenerationRef.current
      };
    } else {
      clearVoiceDictionaryEdit();
    }
    resetHistoryNavigation();
    requestAnimationFrame(() => {
      richEditorRef.current?.focus();
      const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      setComposerCaretTextOffset(root, window.getSelection(), applied.caret);
    });
    return true;
  };

  const acceptVoiceUpdate = (update: VoiceMediaSessionUpdate): void => {
    setVoiceUpdate(update);
    if ((update.state === "done" || update.state === "error") && update.session?.outcome !== undefined) {
      recordVoiceInputSession(update.session);
    }
    if (update.state === "done" && update.session !== undefined) applyVoiceTranscript(update.session);
  };

  const startVoiceInput = (): void => {
    if (voiceSupport !== "supported" || composerLocked || hydratedSession !== session.id) return;
    clearVoiceDictionaryEdit();
    const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    voiceFenceRef.current = createVoiceDraftFence({
      sessionId: session.id,
      revision: editorRevisionRef.current,
      text: textRef.current,
      selection: composerSelectionTextRange(root, window.getSelection())
    });
    appliedVoiceResultRef.current = undefined;
    setAttachmentError(undefined);
    closePalette();
    const active = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    void active?.cancel();
    let media: VoiceInputMediaSession;
    try {
      const locale = voiceInputLocale(voicePreferences);
      media = new VoiceInputMediaSession({
        api: controllerRef.current,
        preferences: {
          ...(locale === undefined ? {} : { locale }),
          ...(voicePreferences.deviceId === undefined ? {} : { deviceId: voicePreferences.deviceId }),
          ...(voicePreferences.refinementInstructions === ""
            ? {}
            : { refinementInstructions: voicePreferences.refinementInstructions }),
          dictionaryTerms: voicePreferences.dictionaryTerms,
          playInteractionSound: voicePreferences.playInteractionSound
        },
        prewarmedStream: voicePrewarmerRef.current?.checkout(),
        onUpdate: acceptVoiceUpdate
      });
    } catch (error) {
      const failure = error as VoiceMediaError;
      setVoiceUpdate({ state: "error", error: failure });
      return;
    }
    voiceSessionRef.current = media;
    void media.start().catch(() => undefined);
  };

  const stopVoiceInput = (): void => {
    void voiceSessionRef.current?.stop().catch(() => undefined);
  };

  const cancelVoiceInput = (): void => {
    const active = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    voiceFenceRef.current = undefined;
    appliedVoiceResultRef.current = undefined;
    setVoiceUpdate(undefined);
    setPastedTextTarget(undefined);
    void active?.cancel().finally(() => requestAnimationFrame(() => richEditorRef.current?.focus()));
  };

  const retryVoiceInput = (): void => {
    const active = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    voiceFenceRef.current = undefined;
    setVoiceUpdate(undefined);
    void (active?.cancel() ?? Promise.resolve()).finally(startVoiceInput);
  };

  const useRetainedVoiceTranscript = (): void => {
    const retained = voiceUpdate?.session;
    if (retained === undefined || retained.result === undefined || !applyVoiceTranscript(retained)) return;
    const active = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    voiceFenceRef.current = undefined;
    setVoiceUpdate(undefined);
    void active?.cancel();
  };

  useEffect(() => {
    if (voiceSupport !== "supported" || readOnly || desktopGlobalVoiceShortcut) return;
    const platform = typeof navigator === "undefined" ? "" : navigator.platform;
    const onVoiceShortcutDown = (event: KeyboardEvent): void => {
      if (event.isComposing || !matchesVoiceInputShortcut(event, voicePreferences.shortcut)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || voiceShortcutHeldRef.current || voiceActive) return;
      voiceShortcutHeldRef.current = true;
      startVoiceInput();
    };
    const onVoiceShortcutUp = (event: KeyboardEvent): void => {
      if (!voiceShortcutHeldRef.current || !releasesVoiceInputShortcut(event, voicePreferences.shortcut, platform)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      voiceShortcutHeldRef.current = false;
      stopVoiceInput();
    };
    const onWindowBlur = (): void => {
      if (!voiceShortcutHeldRef.current) return;
      voiceShortcutHeldRef.current = false;
      stopVoiceInput();
    };
    window.addEventListener("keydown", onVoiceShortcutDown, true);
    window.addEventListener("keyup", onVoiceShortcutUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onVoiceShortcutDown, true);
      window.removeEventListener("keyup", onVoiceShortcutUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [desktopGlobalVoiceShortcut, readOnly, voiceActive, voicePreferences, voiceSupport, voiceUpdate?.state, hydratedSession, session.id]);

  useLayoutEffect(() => {
    let cancelled = false;
    focusAnchorRef.current = document.activeElement;
    const owner = operationGuardRef.current.capture(session.id);
    editorRevisionRef.current += 1;
    appliedVoiceResultRef.current = undefined;
    voiceFenceRef.current = undefined;
    clearVoiceDictionaryEdit();
    const previousVoice = voiceSessionRef.current;
    voiceSessionRef.current = undefined;
    void previousVoice?.cancel();
    setVoiceUpdate(undefined);
    setHydratedSession(undefined);
    textRef.current = "";
    setText("");
    setEditorDocument(emptyComposerDocument());
    setDeliveryMode(supportedModes[0] ?? "prompt");
    setMentions([]);
    replaceInlineMentionRanges([]);
    setExtraDirectoryIds(undefined);
    setBashMode(false);
    setSubmissionKind(operationGuardRef.current.activeSubmission(session.id));
    setAttachmentError(undefined);
    setSaved(false);
    setPalette(undefined);
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    suppressedInlineMentionFromRef.current = undefined;
    typedPaletteTriggerRef.current = undefined;
    setHistoryIndex(-1);
    historyDraftRef.current = undefined;
    hydratedHistoryDraftRef.current = undefined;
    setAttachments((current) => { revokeAttachments(current); return []; });
    setBrowserComments((current) => { revokeBrowserCommentPreviews(current); return []; });
    void controllerRef.current.readDraft(session.id).then((draft) => {
      if (cancelled || !operationGuardRef.current.ownsActivation(owner)) return;
      if (operationGuardRef.current.draftUnchanged(owner)) {
        const restoredDocument = normalizeComposerDocument(draft?.editorDocument, draft?.text ?? "");
        const restoredText = composerDocumentPlainText(restoredDocument);
        const restoredMentions = draft?.mentions ?? [];
        setEditorDocument(restoredDocument);
        textRef.current = restoredText;
        setText(restoredText);
        setMentions(restoredMentions);
        replaceInlineMentionRanges(restoreComposerInlineMentionRanges(restoredText, restoredMentions));
        setExtraDirectoryIds(draft?.extraDirectoryIds === undefined
          ? undefined
          : draft.extraDirectoryIds.filter((id) => selectableExtraDirectories.some((directory) => directory.id === id)));
        setAttachments((draft?.attachments ?? []).map(withAttachmentPreview));
        setBrowserComments((draft?.browserComments ?? []).map(withBrowserCommentPreview));
        setDeliveryMode(draft !== undefined && supportedModes.includes(draft.deliveryMode) ? draft.deliveryMode : supportedModes[0] ?? "prompt");
      }
      setHydratedSession(session.id);
    }).catch((error: unknown) => {
      if (!cancelled && operationGuardRef.current.ownsActivation(owner)) {
        setHydratedSession(session.id);
        setAttachmentError(messageOf(error));
      }
    });
    return () => { cancelled = true; };
  }, [session.id]); // supported modes are intentionally reconciled below without re-reading storage.

  useEffect(() => {
    const container = composerStackRef.current;
    const ownerDocument = container?.ownerDocument;
    const activeElement = ownerDocument?.activeElement ?? null;
    const neutral = activeElement === null
      || activeElement === ownerDocument?.body
      || activeElement === ownerDocument?.documentElement;
    if (!shouldAutoFocusComposer({
      enabled: autoFocus,
      readOnly,
      hydrated: hydratedSession === session.id,
      activeElementIsNeutral: neutral,
      activeElementMatchesAnchor: activeElement !== null && activeElement === focusAnchorRef.current,
      activeElementInsideComposer: activeElement !== null && container?.contains(activeElement) === true
    })) return;
    const frame = window.requestAnimationFrame(() => {
      const currentContainer = composerStackRef.current;
      const currentDocument = currentContainer?.ownerDocument;
      const currentActive = currentDocument?.activeElement ?? null;
      const currentNeutral = currentActive === null
        || currentActive === currentDocument?.body
        || currentActive === currentDocument?.documentElement;
      if (!shouldAutoFocusComposer({
        enabled: autoFocus,
        readOnly,
        hydrated: hydratedSession === session.id,
        activeElementIsNeutral: currentNeutral,
        activeElementMatchesAnchor: currentActive !== null && currentActive === focusAnchorRef.current,
        activeElementInsideComposer: currentActive !== null && currentContainer?.contains(currentActive) === true
      })) return;
      richEditorRef.current?.focus("end");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, hydratedSession, readOnly, session.id]);

  useEffect(() => {
    if (focusRequest <= 0 || readOnly || hydratedSession !== session.id) return;
    const frame = window.requestAnimationFrame(() => richEditorRef.current?.focus("end"));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, hydratedSession, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly ||
      editorTextUpdate === undefined ||
      editorTextUpdate.sessionId !== session.id ||
      appliedEditorEffectRef.current === editorTextUpdate.eventId
    ) return;
    appliedEditorEffectRef.current = editorTextUpdate.eventId;
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    const replaced = appendTextToComposerDocument(composerDocumentKeepingQuotes(editorDocument), editorTextUpdate.text);
    const nextText = composerDocumentPlainText(replaced);
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, nextText, inlineMentionRangesRef.current);
    setEditorDocument(replaced);
    textRef.current = nextText;
    setText(nextText);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    requestAnimationFrame(() => richEditorRef.current?.focus());
  }, [editorTextUpdate, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly ||
      messageMentionInsertion === undefined ||
      messageMentionInsertion.sessionId !== session.id ||
      appliedMessageMentionInsertionRef.current === messageMentionInsertion.id
    ) return;
    appliedMessageMentionInsertionRef.current = messageMentionInsertion.id;
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    setBashMode(false);
    setMentions((current) => upsertComposerMention(current, messageMentionInsertion.mention));
    requestAnimationFrame(() => richEditorRef.current?.focus());
  }, [messageMentionInsertion, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly
      || selectionQuoteInsertion === undefined
      || selectionQuoteInsertion.sessionId !== session.id
      || appliedSelectionQuoteInsertionRef.current === selectionQuoteInsertion.id
    ) return;
    appliedSelectionQuoteInsertionRef.current = selectionQuoteInsertion.id;
    const quote = normalizeSelectionQuoteDrafts([selectionQuoteInsertion.quote])[0];
    if (quote === undefined) return;
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    setBashMode(false);
    const next = appendQuoteToComposerDocument(editorDocument, quote);
    const nextText = composerDocumentPlainText(next);
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, nextText, inlineMentionRangesRef.current);
    setEditorDocument(next);
    textRef.current = nextText;
    setText(nextText);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    requestAnimationFrame(() => richEditorRef.current?.focus());
  }, [selectionQuoteInsertion, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly
      || draftReplacement === undefined
      || draftReplacement.sessionId !== session.id
      || appliedDraftReplacementRef.current === draftReplacement.id
    ) return;
    appliedDraftReplacementRef.current = draftReplacement.id;
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    setBashMode(false);
    const replacementDocument = normalizeComposerDocument(draftReplacement.editorDocument, draftReplacement.text);
    setEditorDocument(replacementDocument);
    const replacementText = composerDocumentPlainText(replacementDocument);
    textRef.current = replacementText;
    setText(replacementText);
    setMentions([]);
    replaceInlineMentionRanges([]);
    setAttachmentError(undefined);
    setAttachments((current) => {
      revokeAttachments(current);
      return (draftReplacement.attachments ?? []).map(withAttachmentPreview);
    });
    requestAnimationFrame(() => richEditorRef.current?.focus());
  }, [draftReplacement, readOnly, session.id]);

  useEffect(() => {
    if (!supportedModes.includes(deliveryMode)) setDeliveryMode(supportedModes[0] ?? "prompt");
  }, [deliveryMode, supportedModes]);

  useEffect(() => {
    if (readOnly || hydratedSession !== session.id || (submissionKind !== undefined && submissionKind !== "send")) return;
    const owner = operationGuardRef.current.capture(session.id);
    const draft = {
      text,
      editorDocument,
      deliveryMode,
      mentions,
      attachments,
      browserComments,
      ...(extraDirectoriesSupported && extraDirectoryIds !== undefined ? { extraDirectoryIds } : {})
    } satisfies ComposerDraft;
    const timer = window.setTimeout(() => {
      if (!operationGuardRef.current.ownsActivation(owner) || !operationGuardRef.current.draftUnchanged(owner)) return;
      void enqueueDraftSave(draftSaveChainRef, controllerRef, session.id, draft).then(() => {
        if (!operationGuardRef.current.ownsActivation(owner) || !operationGuardRef.current.draftUnchanged(owner)) return;
        setSaved(true);
        window.setTimeout(() => {
          if (operationGuardRef.current.ownsActivation(owner)) setSaved(false);
        }, 1200);
      }).catch((error: unknown) => {
        if (operationGuardRef.current.ownsActivation(owner)) setAttachmentError(messageOf(error));
      });
    }, 420);
    return () => window.clearTimeout(timer);
  }, [attachments, browserComments, deliveryMode, editorDocument, extraDirectoriesSupported, extraDirectoryIds, hydratedSession, mentions, readOnly, session.id, submissionKind, text]);

  useEffect(() => () => {
    revokeAttachments(attachmentsRef.current);
    revokeBrowserCommentPreviews(browserCommentsRef.current);
  }, []);

  const updateDocument = (nextDocument: JSONContent, isComposing: boolean): void => {
    operationGuardRef.current.markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    const next = composerDocumentPlainText(nextDocument);
    observeVoiceDictionaryEdit(next, isComposing);
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, next, inlineMentionRangesRef.current);
    setEditorDocument(nextDocument);
    textRef.current = next;
    setText(next);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const caret = composerCaretTextOffset(root, typeof window === "undefined" ? null : window.getSelection()) ?? next.length;
    lastComposerCaretRef.current = caret;
    const mentionTrigger = !isComposing && !bashMode ? detectComposerInlineMention(next, caret) : null;
    if (mentionTrigger !== null) {
      if (suppressedInlineMentionFromRef.current !== mentionTrigger.from) {
        const activation = { ...mentionTrigger, source: "typed" as const };
        inlineMentionActivationRef.current = activation;
        setInlineMentionActivation(activation);
        typedPaletteTriggerRef.current = undefined;
        setInlineMentionActiveIndex(0);
        setPalette("mention");
      }
      return;
    }
    if (suppressedInlineMentionFromRef.current !== undefined) suppressedInlineMentionFromRef.current = undefined;
    const typedPalette = resolveTypedComposerPalette(next, isComposing, bashMode);
    if (typedPalette === "commands") {
      typedPaletteTriggerRef.current = "/";
      setPalette(typedPalette);
      return;
    }
    closePalette();
  };

  useEffect(() => {
    const trackComposerSelection = (): void => {
      const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      const caret = composerCaretTextOffset(root, selection);
      if (caret === undefined) return;
      lastComposerCaretRef.current = caret;
      if (composerLocked || effectiveBashMode) return;
      const detected = detectComposerInlineMention(textRef.current, caret);
      if (detected === null) {
        suppressedInlineMentionFromRef.current = undefined;
        if (inlineMentionActivationRef.current?.source === "typed") closePalette();
        return;
      }
      if (suppressedInlineMentionFromRef.current === detected.from) return;
      const previous = inlineMentionActivationRef.current;
      if (
        previous?.source === "typed"
        && previous.from === detected.from
        && previous.to === detected.to
        && previous.query === detected.query
        && previous.quoted === detected.quoted
      ) return;
      const activation = { ...detected, source: "typed" as const };
      inlineMentionActivationRef.current = activation;
      setInlineMentionActivation(activation);
      setInlineMentionActiveIndex(0);
      setPalette("mention");
    };
    document.addEventListener("selectionchange", trackComposerSelection);
    return () => document.removeEventListener("selectionchange", trackComposerSelection);
  }, [composerLocked, effectiveBashMode]);

  const handleHistoryNavigation = (event: KeyboardEvent, activeDocument: JSONContent): boolean => {
    if (composerLocked || palette !== undefined || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    const historyText = composerDocumentIsEmpty(activeDocument) ? "" : (text || "\uFFFC");
    const intent = resolveComposerHistoryKey(
      event.key,
      historyText,
      historyIndex,
      messageHistory.length,
      historyIndex >= 0 && hydratedHistoryDraftRef.current === composerHistoryDraftSignature(activeDocument)
    );
    if (intent === null) return false;
    const nextEntry = intent.index < 0 ? historyDraftRef.current : messageHistory[intent.index];
    if (nextEntry === undefined) return false;
    event.preventDefault();
    if (historyIndex < 0) historyDraftRef.current = { text, mentions, inlineMentionRanges, editorDocument: activeDocument };
    operationGuardRef.current.markDraftEdited(session.id);
    setHistoryIndex(intent.index);
    textRef.current = nextEntry.text;
    setText(nextEntry.text);
    setEditorDocument(nextEntry.editorDocument);
    if (intent.index < 0) {
      setMentions(historyDraftRef.current?.mentions ?? []);
      replaceInlineMentionRanges(historyDraftRef.current?.inlineMentionRanges ?? []);
      historyDraftRef.current = undefined;
      hydratedHistoryDraftRef.current = undefined;
    } else {
      setMentions([]);
      replaceInlineMentionRanges([]);
      hydratedHistoryDraftRef.current = composerHistoryDraftSignature(nextEntry.editorDocument);
    }
    requestAnimationFrame(() => richEditorRef.current?.focus("end"));
    return true;
  };

  const addFiles = (files: FileList | readonly File[]): void => {
    if (composerLocked) return;
    setAttachmentError(undefined);
    const maximumItems = attachmentPolicy.maximumItems;
    const maximumBytes = attachmentPolicy.maximumBytes;
    const available = maximumItems === undefined
      ? files.length
      : Math.max(0, maximumItems - attachments.length - browserComments.length);
    const next: AttachmentDraft[] = [];
    for (const file of [...files].slice(0, available)) {
      const kind = file.type.startsWith("image/") ? "image" as const : "file" as const;
      if ((kind === "image" && !attachmentPolicy.images) || (kind === "file" && !attachmentPolicy.files)) {
        setAttachmentError(t("composer.attachmentUnsupported", { name: file.name }));
        continue;
      }
      if (maximumBytes !== undefined && file.size > maximumBytes) {
        setAttachmentError(t("composer.attachmentTooLarge", { name: file.name, limit: formatBytes(maximumBytes) }));
        continue;
      }
      next.push({ id: randomUuid(), file, kind, ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}) });
    }
    if (maximumItems !== undefined && [...files].length > available) setAttachmentError(t("composer.attachmentCount", { count: maximumItems }));
    if (next.length > 0) {
      promptRecommendationStore.dismiss(session.id);
      operationGuardRef.current.markDraftEdited(session.id);
      setAttachments((current) => [...current, ...next]);
    }
  };

  const consumeInternalDrop = (dataTransfer: DataTransfer): boolean => {
    if (!hasComposerInternalDrop(dataTransfer)) return false;
    const insertion = resolveComposerInternalDrop(dataTransfer, workspace?.id);
    if (insertion === undefined || effectiveBashMode || composerLocked) return true;
    if (richEditorRef.current?.insertRouteReference(insertion) !== true) return true;
    closePalette();
    setBashMode(false);
    return true;
  };

  useEffect(() => {
    if (
      readOnly
      || attachmentInsertion === undefined
      || attachmentInsertion.sessionId !== session.id
      || appliedAttachmentInsertionRef.current === attachmentInsertion.id
    ) return;
    appliedAttachmentInsertionRef.current = attachmentInsertion.id;
    addFiles([attachmentInsertion.file]);
    window.requestAnimationFrame(() => richEditorRef.current?.focus("end"));
  }, [attachmentInsertion, readOnly, session.id]);

  const finishSubmission = (sessionId: string, kind: ComposerSubmissionKind): void => {
    operationGuardRef.current.finishSubmission(sessionId, kind);
    if (operationGuardRef.current.activeSessionId === sessionId) setSubmissionKind(operationGuardRef.current.activeSubmission(sessionId));
  };

  const sendDraft = (modeOverride?: DeliveryMode): void => {
    if (readOnly) return;
    const recommendationAtSend = recommendationVisible !== undefined && composerDocumentIsEmpty(editorDocument)
      ? recommendationVisible
      : undefined;
    const draftText = recommendationAtSend ?? text;
    const draftDocument = recommendationAtSend === undefined
      ? editorDocument
      : plainTextToComposerDocument(recommendationAtSend);
    if (recommendationAtSend !== undefined) {
      operationGuardRef.current.markDraftEdited(session.id);
      promptRecommendationStore.dismiss(session.id);
      editorDocumentRef.current = draftDocument;
      setEditorDocument(draftDocument);
      textRef.current = draftText;
      setText(draftText);
    }
    if (effectiveBashMode) {
      const command = shellDraft?.command ?? "";
      if (!bashPermitted || command.length === 0 || attachments.length > 0) return;
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "bash")) return;
      promptRecommendationStore.dismiss(sourceSessionId);
      const sourceDeliveryMode = deliveryMode;
      const retainedQuoteDocument = composerDocumentKeepingQuotes(editorDocument);
      setSubmissionKind("bash");
      runAction(`user-shell:${sourceSessionId}`, async () => {
        try {
          await controllerRef.current.executeUserShell(sourceSessionId, command, shellDraft?.excludeFromContext ?? bashExcluded);
          if (operationGuardRef.current.ownsActivation(owner)) onLocalSend(sourceSessionId);
          if (!operationGuardRef.current.draftUnchanged(owner)) return;
          if (operationGuardRef.current.ownsActivation(owner)) {
            resetHistoryNavigation();
            closePalette();
            textRef.current = "";
            setText("");
            setEditorDocument(retainedQuoteDocument);
            setMentions([]);
            replaceInlineMentionRanges([]);
            setBashMode(false);
          }
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, { text: "", editorDocument: retainedQuoteDocument, deliveryMode: sourceDeliveryMode, mentions: [], attachments: [] });
        } finally {
          finishSubmission(sourceSessionId, "bash");
        }
      });
      return;
    }
    const builtInCommand = browserComments.length === 0
      ? composerBuiltInCommand(draftText, commandOptions)
      : null;
    if (builtInCommand?.kind === "userShell") {
      if (builtInCommand.command.length === 0) {
        runAction(`user-shell-usage:${session.id}`, async () => {
          throw new Error("Usage: /cmd <workspace shell command>");
        });
        return;
      }
      if (attachments.length > 0 || selectionQuotes.length > 0 || mentions.length > 0) return;
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "bash")) return;
      promptRecommendationStore.dismiss(sourceSessionId);
      const sourceDeliveryMode = deliveryMode;
      setSubmissionKind("bash");
      runAction(`user-shell:${sourceSessionId}`, async () => {
        try {
          await controllerRef.current.executeUserShell(sourceSessionId, builtInCommand.command, false);
          if (operationGuardRef.current.ownsActivation(owner)) onLocalSend(sourceSessionId);
          if (!operationGuardRef.current.draftUnchanged(owner)) return;
          if (operationGuardRef.current.ownsActivation(owner)) {
            resetHistoryNavigation();
            closePalette();
            textRef.current = "";
            setText("");
            setEditorDocument(emptyComposerDocument());
            setMentions([]);
            replaceInlineMentionRanges([]);
            setExtraDirectoryIds(undefined);
            setAttachmentError(undefined);
            requestAnimationFrame(() => richEditorRef.current?.focus());
          }
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, {
            text: "",
            editorDocument: emptyComposerDocument(),
            deliveryMode: sourceDeliveryMode,
            mentions: [],
            attachments: []
          });
        } finally {
          finishSubmission(sourceSessionId, "bash");
        }
      });
      return;
    }
    if (builtInCommand?.kind === "help") {
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "send")) return;
      const sourceDeliveryMode = deliveryMode;
      const retainedQuoteDocument = composerDocumentKeepingQuotes(draftDocument);
      const sourceAttachments = attachments;
      setSubmissionKind("send");
      setCommandHelpOpen(true);
      runAction(`command-help:${sourceSessionId}`, async () => {
        try {
          if (!operationGuardRef.current.draftUnchanged(owner)) return;
          operationGuardRef.current.consumeUnchangedDraft(owner);
          if (operationGuardRef.current.ownsActivation(owner)) {
            resetHistoryNavigation();
            closePalette();
            textRef.current = "";
            setText("");
            setEditorDocument(retainedQuoteDocument);
            setMentions([]);
            replaceInlineMentionRanges([]);
            requestAnimationFrame(() => richEditorRef.current?.focus());
          }
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, {
            text: "",
            editorDocument: retainedQuoteDocument,
            deliveryMode: sourceDeliveryMode,
            mentions: [],
            attachments: sourceAttachments
          });
        } finally {
          finishSubmission(sourceSessionId, "send");
        }
      });
      return;
    }
    if (builtInCommand?.kind === "jumpSession") {
      if (builtInCommand.sessionId.length === 0) {
        runAction(`jump-session-usage:${session.id}`, async () => {
          throw new Error("Usage: /jump-session <task ID>");
        });
        return;
      }
      const targetExists = controllerRef.current.state.snapshot.sessions.some((candidate) =>
        candidate.id === builtInCommand.sessionId);
      if (!targetExists) {
        runAction(`jump-session-missing:${session.id}`, async () => {
          throw new Error("The requested task does not exist or is unavailable.");
        });
        return;
      }
      if (attachments.length > 0 || selectionQuotes.length > 0 || mentions.length > 0) return;
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "send")) return;
      const sourceDeliveryMode = deliveryMode;
      setSubmissionKind("send");
      runAction(`jump-session:${builtInCommand.sessionId}`, async () => {
        try {
          if (!operationGuardRef.current.draftUnchanged(owner)) return;
          operationGuardRef.current.consumeUnchangedDraft(owner);
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, {
            text: "",
            editorDocument: emptyComposerDocument(),
            deliveryMode: sourceDeliveryMode,
            mentions: [],
            attachments: []
          });
          if (!operationGuardRef.current.ownsActivation(owner)) return;
          controllerRef.current.navigate({ kind: "session", sessionId: builtInCommand.sessionId });
        } finally {
          finishSubmission(sourceSessionId, "send");
        }
      });
      return;
    }
    if (builtInCommand?.kind === "review") {
      if (!attachmentsAllowed(attachments, attachmentPolicy)) return;
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "review")) return;
      promptRecommendationStore.dismiss(sourceSessionId);
      const sourceDeliveryMode = deliveryMode;
      const sourceAttachments = [...attachments];
      setSubmissionKind("review");
      runAction(`review:${sourceSessionId}`, async () => {
        try {
          try {
            await controllerRef.current.startReview(sourceSessionId, builtInCommand.focus, sourceAttachments);
          } catch (error: unknown) {
            // Never expose typed Main/Service Review failures as raw
            // internal messages. The accepted=false path leaves this draft
            // and its object URLs untouched for an immediate retry.
            if (isCodedReviewDispatchFailure(error)) throw new Error(t("review.startFailed"), { cause: error });
            throw error;
          }
          if (operationGuardRef.current.activeSessionId === sourceSessionId) onLocalSend(sourceSessionId);
          // An accepted /review consumes exactly the invocation snapshot. If
          // the user typed while acceptance was pending, retain the new draft.
          if (!operationGuardRef.current.consumeUnchangedDraft(owner)) return;
          if (operationGuardRef.current.activeSessionId === sourceSessionId) {
            resetHistoryNavigation();
            closePalette();
            textRef.current = "";
            setText("");
            setEditorDocument(emptyComposerDocument());
            setMentions([]);
            replaceInlineMentionRanges([]);
            setExtraDirectoryIds(undefined);
            setAttachments((current) => {
              revokeAttachments(current);
              return [];
            });
            setAttachmentError(undefined);
            requestAnimationFrame(() => richEditorRef.current?.focus());
          }
          revokeAttachments(sourceAttachments);
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, {
            text: "",
            editorDocument: emptyComposerDocument(),
            deliveryMode: sourceDeliveryMode,
            mentions: [],
            attachments: []
          });
        } finally {
          finishSubmission(sourceSessionId, "review");
        }
      });
      return;
    }
    if (builtInCommand?.kind === "sessionReset") {
      const sourceSessionId = session.id;
      const owner = operationGuardRef.current.capture(sourceSessionId);
      if (!operationGuardRef.current.beginSubmission(sourceSessionId, "reset")) return;
      promptRecommendationStore.dismiss(sourceSessionId);
      const sourceDeliveryMode = deliveryMode;
      const sourceAttachments = attachments;
      setSubmissionKind("reset");
      runAction(`reset-session:${sourceSessionId}`, async () => {
        try {
          await controllerRef.current.resetSession(sourceSessionId);
          if (operationGuardRef.current.ownsActivation(owner)) onLocalSend(sourceSessionId);
          if (!operationGuardRef.current.draftUnchanged(owner)) return;
          if (operationGuardRef.current.ownsActivation(owner)) {
            resetHistoryNavigation();
            closePalette();
            textRef.current = "";
            setText("");
            setEditorDocument(emptyComposerDocument());
            setMentions([]);
            replaceInlineMentionRanges([]);
            setExtraDirectoryIds(undefined);
            setAttachments([]);
            setAttachmentError(undefined);
            requestAnimationFrame(() => richEditorRef.current?.focus());
          }
          revokeAttachments(sourceAttachments);
          await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, {
            text: "",
            editorDocument: emptyComposerDocument(),
            deliveryMode: sourceDeliveryMode,
            mentions: [],
            attachments: []
          });
        } finally {
          finishSubmission(sourceSessionId, "reset");
        }
      });
      return;
    }
    const sourceDeliveryMode = modeOverride ?? deliveryMode;
    const draftMedia = [...attachments, ...browserComments.map((item) => item.screenshot)];
    if (!(browserComments.length > 0 || canSend(draftText, attachments, mentions, composerDocumentQuotes(draftDocument), supportedModes, sourceDeliveryMode)) || !attachmentsAllowed(draftMedia, attachmentPolicy)) return;
    const sourceSessionId = session.id;
    const owner = operationGuardRef.current.capture(sourceSessionId);
    if (!operationGuardRef.current.beginSubmission(sourceSessionId, "send")) return;
    if (!operationGuardRef.current.consumeUnchangedDraft(owner)) {
      operationGuardRef.current.finishSubmission(sourceSessionId, "send");
      return;
    }
    promptRecommendationStore.dismiss(sourceSessionId);
    const sourceText = draftText.trim();
    const sourceEditorDocument = draftDocument;
    const sourceAttachments = [...attachments];
    const sourceBrowserComments = [...browserComments];
    const sourceMentions = composerMentionsFromRanges(mentions, inlineMentionRanges);
    const sourceExtraDirectoryIds = extraDirectoriesSupported ? extraDirectoryIds : undefined;
    const clearedDocument = emptyComposerDocument();
    const clearedOwner = operationGuardRef.current.capture(sourceSessionId);
    setSubmissionKind("send");
    if (operationGuardRef.current.ownsActivation(clearedOwner)) onLocalSend(sourceSessionId);
    resetHistoryNavigation();
    closePalette();
    editorRevisionRef.current += 1;
    editorDocumentRef.current = clearedDocument;
    textRef.current = "";
    attachmentsRef.current = [];
    browserCommentsRef.current = [];
    mentionsRef.current = [];
    setEditorDocument(clearedDocument);
    setText("");
    setMentions([]);
    replaceInlineMentionRanges([]);
    setExtraDirectoryIds(undefined);
    setAttachments([]);
    setBrowserComments([]);
    setAttachmentError(undefined);
    requestAnimationFrame(() => richEditorRef.current?.focus());
    const clearedDraft = {
      text: "",
      editorDocument: clearedDocument,
      deliveryMode: sourceDeliveryMode,
      mentions: [],
      attachments: [],
      browserComments: []
    } satisfies ComposerDraft;
    const clearSave = enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, clearedDraft);

    const restoreRejectedDraft = async (): Promise<void> => {
      const ownsLiveComposer = operationGuardRef.current.ownsActivation(clearedOwner);
      const current: ComposerDraft = ownsLiveComposer
        ? {
            text: textRef.current,
            editorDocument: editorDocumentRef.current,
            deliveryMode,
            mentions: mentionsRef.current,
            attachments: attachmentsRef.current,
            browserComments: browserCommentsRef.current
          } satisfies ComposerDraft
        : await controllerRef.current.readDraft(sourceSessionId) ?? clearedDraft;
      const restoredDocument = joinComposerDocuments(sourceEditorDocument, current.editorDocument);
      const restoredText = composerDocumentPlainText(restoredDocument);
      const restoredMentions = mergeDraftItemsById(sourceMentions, current.mentions);
      const restoredAttachments = mergeDraftItemsById(sourceAttachments, current.attachments);
      const restoredBrowserComments = mergeDraftItemsById(sourceBrowserComments, current.browserComments ?? []);
      const restoredDraft = {
        text: restoredText,
        editorDocument: restoredDocument,
        deliveryMode: current.deliveryMode,
        mentions: restoredMentions,
        attachments: restoredAttachments,
        browserComments: restoredBrowserComments,
        ...((current.extraDirectoryIds ?? sourceExtraDirectoryIds) === undefined
          ? {}
          : { extraDirectoryIds: current.extraDirectoryIds ?? sourceExtraDirectoryIds })
      } satisfies ComposerDraft;
      if (ownsLiveComposer) {
        operationGuardRef.current.markDraftEdited(sourceSessionId);
        editorRevisionRef.current += 1;
        editorDocumentRef.current = restoredDocument;
        textRef.current = restoredText;
        mentionsRef.current = restoredMentions;
        attachmentsRef.current = restoredAttachments;
        browserCommentsRef.current = restoredBrowserComments;
        setEditorDocument(restoredDocument);
        setText(restoredText);
        setMentions(restoredMentions);
        replaceInlineMentionRanges(restoreComposerInlineMentionRanges(restoredText, restoredMentions));
        setExtraDirectoryIds(current.extraDirectoryIds ?? sourceExtraDirectoryIds);
        setAttachments(restoredAttachments);
        setBrowserComments(restoredBrowserComments);
        requestAnimationFrame(() => richEditorRef.current?.focus("end"));
      }
      await enqueueDraftSave(draftSaveChainRef, controllerRef, sourceSessionId, restoredDraft);
    };

    runAction(`send:${sourceSessionId}`, async () => {
      try {
        await clearSave;
        await controllerRef.current.send(sourceSessionId, {
          text: sourceText,
          editorDocument: sourceEditorDocument,
          attachments: sourceAttachments,
          browserComments: sourceBrowserComments,
          mentions: sourceMentions,
          deliveryMode: sourceDeliveryMode,
          ...(sourceExtraDirectoryIds === undefined ? {} : { extraDirectoryIds: sourceExtraDirectoryIds })
        });
        revokeAttachments(sourceAttachments);
        revokeBrowserCommentPreviews(sourceBrowserComments);
      } catch (error) {
        await restoreRejectedDraft();
        throw error;
      } finally {
        finishSubmission(sourceSessionId, "send");
      }
    });
  };

  const insert = (item: ComposerPaletteItem): void => {
    if (composerLocked) return;
    operationGuardRef.current.markDraftEdited(session.id);
    resetHistoryNavigation();
    const typedTrigger = typedPaletteTriggerRef.current;
    const nextText = insertComposerPaletteValue(text, typedTrigger, item);
    const nextDocument = typedTrigger !== undefined && text === typedTrigger
      ? plainTextToComposerDocument(nextText)
      : appendTextToComposerDocument(editorDocument, nextText.slice(text.length));
    const normalizedNextText = composerDocumentPlainText(nextDocument);
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, normalizedNextText, inlineMentionRangesRef.current);
    setEditorDocument(nextDocument);
    textRef.current = normalizedNextText;
    setText(normalizedNextText);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    const mention = item.mention;
    if (mention !== undefined) setMentions((current) => [...current.filter((candidate) => candidate.id !== mention.id), mention]);
    closePalette();
    requestAnimationFrame(() => richEditorRef.current?.focus());
  };

  const selectInlineMention = (item: ComposerMentionCatalogItem): void => {
    if (composerLocked || item.disabled === true) return;
    const activation = inlineMentionActivationRef.current;
    if (activation === undefined) return;
    const directoryToken = item.kind === "directory" ? composerDirectoryQueryToken(item.path) : undefined;
    const mention = item.mention;
    if (directoryToken === undefined && mention === undefined) return;
    const existingSeparator = /\s/u.test(textRef.current[activation.to] ?? "");
    const replacement = directoryToken ?? `${mention!.token}${existingSeparator ? "" : " "}`;
    const nextDocument = replaceComposerDocumentTextRange(editorDocument, activation.from, activation.to, replacement);
    if (nextDocument === undefined) return;
    operationGuardRef.current.markDraftEdited(session.id);
    resetHistoryNavigation();
    const previousText = textRef.current;
    const nextText = composerDocumentPlainText(nextDocument);
    const mappedRanges = remapComposerInlineMentionRanges(previousText, nextText, inlineMentionRangesRef.current);
    setEditorDocument(nextDocument);
    textRef.current = nextText;
    setText(nextText);
    if (directoryToken !== undefined) {
      replaceInlineMentionRanges(mappedRanges);
      setMentions((current) => composerMentionsFromRanges(current, mappedRanges));
      const caret = activation.from + directoryToken.length;
      lastComposerCaretRef.current = caret;
      const detected = detectComposerInlineMention(nextText, caret);
      if (detected === null) {
        closePalette();
      } else {
        const nextActivation = { ...detected, source: activation.source };
        inlineMentionActivationRef.current = nextActivation;
        setInlineMentionActivation(nextActivation);
        setInlineMentionActiveIndex(0);
        setPalette("mention");
      }
      focusComposerAt(caret);
      return;
    }
    const nextRanges = [...mappedRanges, {
      mentionId: mention!.id,
      from: activation.from,
      to: activation.from + mention!.token.length
    }];
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => [
      ...composerMentionsFromRanges(current, mappedRanges).filter((candidate) => candidate.id !== mention!.id),
      mention!
    ]);
    const mentionCaret = activation.from + mention!.token.length + (existingSeparator ? 1 : 0);
    lastComposerCaretRef.current = mentionCaret;
    closePalette();
    focusComposerAt(mentionCaret);
  };

  const focusComposerAt = (offset: number): void => {
    requestAnimationFrame(() => {
      richEditorRef.current?.focus();
      const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      setComposerCaretTextOffset(root, typeof window === "undefined" ? null : window.getSelection(), offset);
    });
  };

  const openInlineMentionPalette = (): void => {
    if (composerLocked) return;
    if (palette === "mention") {
      closeInlineMention(true, false);
      return;
    }
    const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const selectedOffset = composerCaretTextOffset(root, typeof window === "undefined" ? null : window.getSelection());
    const from = Math.min(Math.max(selectedOffset ?? lastComposerCaretRef.current ?? text.length, 0), text.length);
    const activation = { from, to: from, query: "", quoted: false, source: "button" as const };
    typedPaletteTriggerRef.current = undefined;
    inlineMentionActivationRef.current = activation;
    setInlineMentionActivation(activation);
    setInlineMentionActiveIndex(0);
    setPalette("mention");
  };

  const changeDeliveryMode = (mode: DeliveryMode): void => {
    if (composerLocked || mode === deliveryMode) return;
    operationGuardRef.current.markDraftEdited(session.id);
    setDeliveryMode(mode);
  };

  const sessionQueue = queue.filter((item) => item.sessionId === session.id && !["completed", "cancelled"].includes(item.state));
  const showQueue = !readOnly && (sessionQueue.length > 0 || queueControl?.state === "paused");
  const queueExpanded = queueExpandedSessionId === session.id;
  const draftMedia = [...attachments, ...browserComments.map((item) => item.screenshot)];
  const shortcutLabel = getComposerSendShortcutLabel(sendShortcut, composerPlatform);
  const matchingWorkspaceMentionIndex = workspaceMentionIndex?.workspaceId === workspace?.id
    ? workspaceMentionIndex
    : undefined;
  const mentionCatalogItems = useMemo(
    () => composerMentionCatalog(
      workspace?.entries ?? [],
      workspace?.id,
      resources,
      matchingWorkspaceMentionIndex?.paths ?? []
    ),
    [matchingWorkspaceMentionIndex?.paths, resources, workspace?.entries, workspace?.id]
  );
  const knownWorkspacePaths = useMemo(() => workspace === undefined
    ? []
    : [...new Set([
        ...workspaceEntryPaths(workspace.entries),
        ...(matchingWorkspaceMentionIndex?.paths ?? [])
      ])], [matchingWorkspaceMentionIndex?.paths, workspace]);
  const mentionProviderState = useMemo<ComposerMentionProviderState>(
    () => matchingWorkspaceMentionIndex?.status === "loading"
      ? {
          kind: "loading",
          items: mentionCatalogItems,
          truncated: matchingWorkspaceMentionIndex.truncated
        }
      : matchingWorkspaceMentionIndex?.status === "error"
        ? {
            kind: "error",
            message: matchingWorkspaceMentionIndex.error ?? t("composer.mentionLoadFailed"),
            items: mentionCatalogItems,
            truncated: matchingWorkspaceMentionIndex.truncated
          }
        : {
            kind: "ready",
            items: mentionCatalogItems,
            truncated: matchingWorkspaceMentionIndex?.truncated ?? false
          },
    [matchingWorkspaceMentionIndex, mentionCatalogItems, t]
  );
  const mentionResults = useMemo(
    () => resolveComposerMentionResults(mentionProviderState, inlineMentionActivation?.query ?? ""),
    [inlineMentionActivation?.query, mentionProviderState]
  );

  useEffect(() => {
    const current = mentionResults.items[inlineMentionActiveIndex];
    if (current !== undefined && current.disabled !== true) return;
    setInlineMentionActiveIndex(firstEnabledComposerMentionIndex(mentionResults.items));
  }, [inlineMentionActiveIndex, mentionResults.items]);

  const captureInlineMentionKey = (event: KeyboardEvent): boolean => {
    if (palette !== "mention" || inlineMentionActivationRef.current === undefined || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return false;
    const intent = resolveComposerInlineMentionKey(event.key, inlineMentionActiveIndex, mentionResults.items);
    if (intent === null) return false;
    event.preventDefault();
    if (intent.kind === "close") {
      closeInlineMention(true, true);
      return true;
    }
    if (intent.kind === "move") {
      setInlineMentionActiveIndex(intent.index);
      return true;
    }
    const selected = mentionResults.items[intent.index];
    if (selected !== undefined && selected.disabled !== true) selectInlineMention(selected);
    return true;
  };
  const promptRecommendationSetting = controller.state.snapshot.settings.promptRecommendation;
  const recommendationEligible = shouldShowPromptRecommendation({
    enabled: promptRecommendationSetting.enabled,
    available: promptRecommendationSetting.available,
    hydrated: hydratedSession === session.id,
    readOnly,
    locked: composerLocked,
    bashMode: effectiveBashMode,
    paletteOpen: palette !== undefined,
    documentEmpty: composerDocumentIsEmpty(editorDocument),
    hasAttachments: attachments.length > 0 || browserComments.length > 0,
    hasMentions: mentions.length > 0,
    hasSelectionQuotes: selectionQuotes.length > 0,
    hasUnfinishedQueue: sessionQueue.some((item) => item.state !== "failed"),
    queuePaused: queueControl?.state === "paused"
  });
  const promptRecommendation = useMemo(() => promptRecommendationStore.recommendation(
    session.id,
    session.generation,
    session.updatedAt
  ), [promptRecommendationRevision, session.generation, session.id, session.updatedAt]);
  const recommendationVisible = recommendationEligible ? promptRecommendation : undefined;
  const draftCanSend = !modelRouteUnavailable && (recommendationVisible !== undefined
    || browserComments.length > 0
    || canSend(text, attachments, mentions, selectionQuotes, supportedModes, deliveryMode))
    && attachmentsAllowed(draftMedia, attachmentPolicy);
  const mainSlotIsStop = canStop && (!draftCanSend || submissionKind === "send");
  const showSecondaryStop = canStop && draftCanSend && submissionKind !== "send";

  useEffect(() => {
    if (!recommendationEligible) return;
    promptRecommendationStore.request(
      session.id,
      session.generation,
      session.updatedAt,
      (fence) => controller.predictNextPrompt(fence.sessionId, fence.updatedAt, fence.generation)
    );
  }, [controller, promptRecommendationRevision, recommendationEligible, session.generation, session.id, session.updatedAt]);

  useEffect(() => {
    if (
      !readOnly &&
      attachments.length === 0 &&
      browserComments.length === 0 &&
      mentions.length === 0 &&
      selectionQuotes.length === 0
    ) return;
    promptRecommendationStore.dismiss(session.id);
  }, [attachments.length, browserComments.length, mentions.length, promptRecommendationRevision, readOnly, selectionQuotes.length, session.id]);

  useEffect(() => {
    if (!queueExpanded) return;
    const collapseOnOutsidePointer = (event: MouseEvent): void => {
      const root = composerStackRef.current;
      if (root?.contains(event.target as Node)) return;
      setQueueExpandedSessionId(undefined);
    };
    document.addEventListener("mousedown", collapseOnOutsidePointer, true);
    return () => document.removeEventListener("mousedown", collapseOnOutsidePointer, true);
  }, [queueExpanded]);

  const paletteInAddMenu = palette === "add"
    || (palette === "commands" && typedPaletteTriggerRef.current === undefined)
    || (palette === "mention" && inlineMentionActivation?.source === "button");

  return (
    <div className="composer-region">
      {runningStatus}
      <div
        ref={composerStackRef}
        className={cx("composer-stack", showQueue && "composer-stack--with-queue")}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && (voiceActive || voiceUpdate?.state === "error")) {
            event.preventDefault();
            event.stopPropagation();
            cancelVoiceInput();
            return;
          }
          if (event.key === "Escape" && palette === "mention" && inlineMentionActivationRef.current !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            closeInlineMention(true, true);
            return;
          }
          const intent = resolveComposerEscapeIntent({
            key: event.key,
            repeat: event.repeat,
            isComposing: event.nativeEvent.isComposing,
            paletteTarget: event.target instanceof Element && event.target.closest(".composer-palette") !== null
          }, {
            queueExpanded,
            canStopRun: canStop,
            shellRunning: !readOnly && effectiveBashMode && submissionKind === "bash",
            shellMode: !readOnly && effectiveBashMode
          });
          if (intent === null) return;
          event.preventDefault();
          event.stopPropagation();
          if (intent === "collapseQueue") {
            setQueueExpandedSessionId(undefined);
          } else if (intent === "stopRun") {
            onStop?.();
          } else if (intent === "stopShell") {
            runAction(`user-shell-abort:${session.id}`, () => controller.abortUserShell(session.id));
          } else {
            const retained = composerDocumentKeepingQuotes(editorDocument);
            setEditorDocument(retained);
            textRef.current = "";
            setText("");
            setMentions([]);
            replaceInlineMentionRanges([]);
            setBashMode(false);
          }
        }}
      >
      {showQueue && <QueueStrip sessionId={session.id} items={sessionQueue} control={queueControl} supportedDispositions={supportedModes} controller={controller} runAction={runAction} t={t} expanded={queueExpanded} onExpandedChange={(expanded) => setQueueExpandedSessionId(expanded ? session.id : undefined)} />}
      <div
        className={cx("composer", dragging && "is-dragging", effectiveBashMode && "composer--bash")}
        aria-busy={submissionKind !== undefined}
        aria-disabled={readOnly}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          const editorDom = event.currentTarget.querySelector("[data-composer-editor='true']");
          if (!isComposerBlankPointerTarget(event.target, event.currentTarget, editorDom, event)) return;
          event.preventDefault();
          richEditorRef.current?.focusFromBlankSurface();
        }}
        onDragEnter={(event) => { preventDrag(event); if (!composerLocked) setDragging(true); }}
        onDragOver={preventDrag}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => {
          preventDrag(event);
          setDragging(false);
          if (consumeInternalDrop(event.dataTransfer)) return;
          if (!effectiveBashMode && !composerLocked) addFiles(event.dataTransfer.files);
        }}
      >
        {dragging && !effectiveBashMode && <div className="composer__drop"><Paperclip aria-hidden="true" /><span>{t("composer.drop")}</span></div>}
        {effectiveBashMode && <div className="composer__bash-notice" role="status"><Terminal aria-hidden="true" /><div><strong>{t("composer.shell")}</strong><span>{t("composer.shellHelp")}</span>{!bashPermitted && <em>{t("composer.shellUnavailable")}</em>}{attachments.length > 0 && <em>{t("composer.shellAttachments")}</em>}</div></div>}
        {mentions.some((mention) => mention.kind === "message") && (
          <div className="composer-reference-list" aria-label={t("composer.messageReferences")}>
            {mentions.filter((mention): mention is ComposerMessageMentionDraft => mention.kind === "message").map((mention) => (
              <div className="composer-reference-chip" key={mention.id}>
                <MessageSquarePlus aria-hidden="true" />
                <span><strong>{mention.label}</strong><small>{mention.role === "user" ? t("composer.userMessageReference") : t("composer.agentMessageReference")}</small></span>
                <IconButton label={t("composer.removeMessageReference", { name: mention.label })} onClick={() => {
                  if (composerLocked) return;
                  operationGuardRef.current.markDraftEdited(session.id);
                  setMentions((current) => current.filter((item) => item.id !== mention.id));
                }} disabled={composerLocked}><X aria-hidden="true" /></IconButton>
              </div>
            ))}
          </div>
        )}
        {browserComments.length > 0 && (
          <details className="browser-comment-chip">
            <summary><MessageSquarePlus aria-hidden="true" /><span>{t("composer.browserComments", { count: browserComments.length })}</span><small>{t("composer.browserCommentsPreview")}</small></summary>
            <div className="browser-comment-chip__preview">
              {browserComments.map((item) => (
                <article key={item.id}>
                  {item.screenshot.previewUrl === undefined ? <ImageIcon aria-hidden="true" /> : <img src={item.screenshot.previewUrl} alt="" />}
                  <span><strong><b>{item.markerNumber}</b>{browserCommentPreviewTag(item)}</strong><small title={item.pageUrl}>{browserCommentPageLabel(item.pageUrl)}</small><p>{item.comment || t("composer.browserCommentNoText")}</p></span>
                  <IconButton label={t("composer.removeBrowserComment", { number: item.markerNumber })} disabled={composerLocked} onClick={() => {
                    if (composerLocked) return;
                    operationGuardRef.current.markDraftEdited(session.id);
                    revokeAttachments([item.screenshot]);
                    setBrowserComments((current) => removeBrowserCommentAndRepairChains(current, item.id));
                  }}><X aria-hidden="true" /></IconButton>
                </article>
              ))}
              <Button tone="ghost" disabled={composerLocked} onClick={() => {
                if (composerLocked) return;
                operationGuardRef.current.markDraftEdited(session.id);
                revokeBrowserCommentPreviews(browserComments);
                setBrowserComments([]);
              }}>{t("composer.clearBrowserComments")}</Button>
            </div>
          </details>
        )}
        {attachments.length > 0 && (
          <ComposerAttachmentTray
            attachments={attachments}
            removeDisabled={composerLocked}
            t={t}
            onRemove={(attachment) => {
              if (composerLocked) return;
              operationGuardRef.current.markDraftEdited(session.id);
              if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
              setAttachments((current) => current.filter((item) => item.id !== attachment.id));
            }}
          />
        )}
        {attachmentError !== undefined && <p className="composer__error" role="alert"><AlertTriangle aria-hidden="true" />{attachmentError}</p>}
        <PromptRecommendationEditorFrame
          recommendation={recommendationVisible}
          acceptLabel="Tab"
          {...(recommendationVisible === undefined ? {} : { onAccept: () => {
            const accepted = plainTextToComposerDocument(recommendationVisible);
            operationGuardRef.current.markDraftEdited(session.id);
            promptRecommendationStore.dismiss(session.id);
            editorDocumentRef.current = accepted;
            setEditorDocument(accepted);
            const acceptedText = composerDocumentPlainText(accepted);
            textRef.current = acceptedText;
            setText(acceptedText);
            requestAnimationFrame(() => richEditorRef.current?.focus("end"));
          } })}
        >
          <ComposerRichTextEditor
            ref={richEditorRef}
            document={editorDocument}
            editable={!composerEditorLocked}
            disabled={!effectiveBashMode && supportedModes.length === 0}
            placeholder={effectiveBashMode ? t("composer.shellPlaceholder") : supportedModes.length === 0 ? t("composer.inputUnavailable") : t("composer.placeholder")}
            onDocumentChange={updateDocument}
            onKeyDown={(event, activeDocument) => {
              if (captureInlineMentionKey(event)) return true;
              if (
                recommendationVisible !== undefined &&
                composerDocumentIsEmpty(activeDocument) &&
                isPromptRecommendationAcceptKey(event)
              ) {
                event.preventDefault();
                const accepted = plainTextToComposerDocument(recommendationVisible);
                operationGuardRef.current.markDraftEdited(session.id);
                promptRecommendationStore.dismiss(session.id);
                editorDocumentRef.current = accepted;
                setEditorDocument(accepted);
                const acceptedText = composerDocumentPlainText(accepted);
                textRef.current = acceptedText;
                setText(acceptedText);
                requestAnimationFrame(() => richEditorRef.current?.focus("end"));
                return true;
              }
              if (handleHistoryNavigation(event, activeDocument)) return true;
              return handleComposerKey(event, sendShortcut, turnRunning, composerPlatform, (intent) => {
                const mode = intent === "steer" ? "steer" : queueDeliveryMode(turnRunning, supportedModes);
                if (mode !== undefined) sendDraft(mode);
              });
            }}
            onClipboardFiles={(files) => { if (!effectiveBashMode && !composerLocked) addFiles(files); }}
            pastedTextLabel={(lines) => t("composer.pastedTextChip", { lines })}
            onPastedTextOpen={setPastedTextTarget}
            workingDirectory={workspace?.serverPath}
            knownWorkspacePaths={knownWorkspacePaths}
            resolveRouteReference={(target) => resolveComposerRouteReferenceFromRuntime(controllerRef.current, target, t("session.unnamed"))}
          />
        </PromptRecommendationEditorFrame>
        {voiceUpdate !== undefined && voiceUpdate.state !== "idle" && voiceUpdate.state !== "done" && voiceUpdate.state !== "cancelled" && (
          <VoiceInputOverlay
            state={voiceUpdate.state}
            transcript={voiceUpdate.session?.result?.text ?? voiceUpdate.session?.draft?.text ?? ""}
            error={voiceInputErrorMessage(voiceUpdate, t)}
            stallWarning={voiceUpdate.session?.stallWarning === true}
            canUseTranscript={voiceUpdate.session?.result !== undefined && (voiceUpdate.session.failure?.transcriptKept === true || voiceUpdate.session.result.salvaged)}
            t={t}
            onStop={stopVoiceInput}
            onCancel={cancelVoiceInput}
            onRetry={retryVoiceInput}
            onUseTranscript={useRetainedVoiceTranscript}
          />
        )}
        <div className="composer__toolbar">
          <div className="composer__tools">
            <input ref={fileInputRef} className="sr-only" type="file" multiple disabled={composerLocked} accept={attachmentPolicy.images && !attachmentPolicy.files ? "image/*" : undefined} onChange={(event) => { if (event.target.files !== null) addFiles(event.target.files); event.target.value = ""; }} />
            {!effectiveBashMode && <div className="palette-anchor">
              <ComposerAddMenu
                open={paletteInAddMenu}
                onOpenChange={(next) => {
                  if (next) {
                    typedPaletteTriggerRef.current = undefined;
                    setPalette("add");
                  } else if (paletteInAddMenu) {
                    closePalette(false);
                  }
                }}
                label={t("common.add")}
                panelLabel={palette === "mention" ? t("composer.mention") : palette === "commands" ? t("composer.commands") : t("common.add")}
                closeLabel={t("common.close")}
                disabled={composerLocked}
                disabledReason={composerLocked ? t("composer.inputUnavailable") : undefined}
                count={extraDirectoryIds?.length}
              >
                {palette === "add" && <><div className="composer-add-menu__actions" role="menu">
                  {(attachmentPolicy.images || attachmentPolicy.files) && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { setPalette(undefined); fileInputRef.current?.click(); }}><Paperclip aria-hidden="true" /><span><strong>{t("composer.attach")}</strong><small>{t("composer.attachments")}</small></span></button>}
                  <button className="composer-add-menu__action" type="button" role="menuitem" onClick={openInlineMentionPalette}><AtSign aria-hidden="true" /><span><strong>{t("composer.mention")}</strong><small>{t("composer.noMentions")}</small></span></button>
                  <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { typedPaletteTriggerRef.current = undefined; setPalette("commands"); }}><Sparkles aria-hidden="true" /><span><strong>{t("composer.commands")}</strong><small>{availableCommandItems.length}</small></span></button>
                </div>
                {extraDirectoriesSupported && selectableExtraDirectories.length > 0 && <fieldset className="composer-add-menu__directories">
                  <legend>{t("composer.extraDirectories")}</legend>
                  {selectableExtraDirectories.map((directory) => {
                    const effective = extraDirectoryIds ?? selectableExtraDirectories.map((candidate) => candidate.id);
                    return <label key={directory.id}><CheckboxControl disabled={composerLocked} checked={effective.includes(directory.id)} onChange={(event) => {
                      operationGuardRef.current.markDraftEdited(session.id);
                      const current = extraDirectoryIds ?? selectableExtraDirectories.map((candidate) => candidate.id);
                      setExtraDirectoryIds(event.target.checked ? [...new Set([...current, directory.id])] : current.filter((id) => id !== directory.id));
                    }} /><span><strong>{directory.serverPath}</strong><small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")}</small></span></label>;
                  })}
                  <button className="composer-add-menu__directory-reset" type="button" disabled={composerLocked || extraDirectoryIds === undefined} onClick={() => { operationGuardRef.current.markDraftEdited(session.id); setExtraDirectoryIds(undefined); }}>{t("composer.extraDirectoriesUseDefault")}</button>
                </fieldset>}</>}
                {palette === "mention" && inlineMentionActivation !== undefined && paletteInAddMenu && <ComposerInlineMentionPanel
                  embedded
                  title={t("composer.mention")}
                  query={inlineMentionActivation.query}
                  state={mentionProviderState}
                  results={mentionResults}
                  activeIndex={inlineMentionActiveIndex}
                  labels={{ close: t("common.close"), loading: t("common.loading"), empty: t("composer.noMentions"), more: t("common.more"), retry: t("common.retry") }}
                  onActiveIndexChange={setInlineMentionActiveIndex}
                  onSelect={selectInlineMention}
                  onClose={() => closeInlineMention(true, true)}
                  onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
                />}
                {palette === "commands" && paletteInAddMenu && <ComposerPalette embedded title={t("composer.commands")} items={availableCommandItems} empty={t("composer.noCommands")} t={t} onSelect={insert} onClose={() => closePalette(true)} />}
              </ComposerAddMenu>
              {palette === "mention" && inlineMentionActivation !== undefined && !paletteInAddMenu && <ComposerInlineMentionPanel
                title={t("composer.mention")}
                query={inlineMentionActivation.query}
                state={mentionProviderState}
                results={mentionResults}
                activeIndex={inlineMentionActiveIndex}
                labels={{ close: t("common.close"), loading: t("common.loading"), empty: t("composer.noMentions"), more: t("common.more"), retry: t("common.retry") }}
                onActiveIndexChange={setInlineMentionActiveIndex}
                onSelect={selectInlineMention}
                onClose={() => closeInlineMention(true, true)}
                onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
              />}
              {palette === "commands" && !paletteInAddMenu && <ComposerPalette title={t("composer.commands")} items={availableCommandItems} empty={t("composer.noCommands")} t={t} onSelect={insert} onClose={() => closePalette(true)} />}
            </div>}
            {!effectiveBashMode && voiceSupport === "supported" && <IconButton label={t("voice.start")} disabled={composerLocked || hydratedSession !== session.id} onClick={startVoiceInput}><Mic aria-hidden="true" /></IconButton>}
            {bashCapable && <IconButton label={effectiveBashMode ? t("composer.shellExit") : t("composer.shellEnter")} disabled={composerLocked} aria-pressed={effectiveBashMode} onClick={() => { setBashMode((current) => !current); requestAnimationFrame(() => richEditorRef.current?.focus()); }}><Terminal aria-hidden="true" /></IconButton>}
            {effectiveBashMode && <label className="composer__bash-option"><CheckboxControl checked={shellDraft?.excludeFromContext ?? bashExcluded} disabled={composerLocked || shellDraft?.prefix === "exclude"} onChange={(event) => setBashExcluded(event.target.checked)} />{t("composer.shellExclude")}</label>}
            {saved && <span className="draft-saved" role="status"><CircleCheck aria-hidden="true" />{t("composer.saved")}</span>}
          </div>
          {!effectiveBashMode && controls}
          <div className="composer__send">
            {!effectiveBashMode && showSecondaryStop && <ComposerStopButton label={t("common.stop")} disabled={stopInFlight} onStop={onStop} />}
            {!effectiveBashMode && supportedModes.length > 1 && (
              <><SegmentedControl
                  label={t("composer.deliveryMode")}
                  value={deliveryMode}
                  options={supportedModes.map((mode) => ({ value: mode, label: deliveryLabel(mode, t), disabled: composerLocked }))}
                  onChange={changeDeliveryMode}
                /><label className="composer__mobile-delivery"><span className="sr-only">{t("composer.deliveryMode")}</span><SelectControl value={deliveryMode} disabled={composerLocked} onChange={(event) => changeDeliveryMode(event.target.value as DeliveryMode)}>{supportedModes.map((mode) => <option value={mode} key={mode}>{deliveryLabel(mode, t)}</option>)}</SelectControl></label></>
            )}
            {!effectiveBashMode && supportedModes.length === 1 && <Pill tone={deliveryMode === "steer" ? "accent" : "neutral"}>{deliveryLabel(deliveryMode, t)}</Pill>}
            {effectiveBashMode && submissionKind === "bash" && <IconButton className="send-button send-button--stop" label={t("composer.shellAbort")} onClick={() => runAction(`user-shell-abort:${session.id}`, () => controller.abortUserShell(session.id))}><CircleStop aria-hidden="true" /></IconButton>}
            {!effectiveBashMode && mainSlotIsStop && <ComposerStopButton label={t("common.stop")} disabled={stopInFlight} onStop={onStop} />}
            {((!effectiveBashMode && !mainSlotIsStop) || (effectiveBashMode && submissionKind !== "bash")) && <IconButton
              className="send-button"
              label={effectiveBashMode ? t("composer.shellEnter") : deliveryLabel(deliveryMode, t)}
              tip={effectiveBashMode ? `${t("composer.shellEnter")} (${shortcutLabel})` : `${deliveryLabel(deliveryMode, t)} (${shortcutLabel})`}
              disabled={composerLocked || (effectiveBashMode ? !bashPermitted || (shellDraft?.command.length ?? 0) === 0 || attachments.length > 0 : !draftCanSend)}
              disabledReason={composerLocked
                ? t("composer.inputUnavailable")
                : effectiveBashMode && !bashPermitted
                  ? t("composer.shellUnavailable")
                  : effectiveBashMode && attachments.length > 0
                    ? t("composer.shellAttachments")
                    : effectiveBashMode
                      ? t("composer.shellPlaceholder")
                      : t("composer.placeholder")}
              onClick={() => sendDraft()}
            >
              {effectiveBashMode ? <Terminal aria-hidden="true" /> : deliveryMode === "steer" ? <Zap aria-hidden="true" /> : deliveryMode === "followUp" ? <Clock3 aria-hidden="true" /> : <Send aria-hidden="true" />}
            </IconButton>}
          </div>
        </div>
      </div>
      <div className="composer-statusbar">
        <span className="composer-statusbar__workspace" title={workspace?.serverPath}>{workspace?.serverPath ?? ""}</span>
        <SessionUsageChip
          usage={sessionUsage}
          supported={backend?.capabilities.get("context.usage")?.supported === true}
          locale={controller.state.preferences.locale}
          t={t}
        />
        <ContextCapacityRing context={session.context} modelContextWindow={session.model?.contextWindow} onCompact={onCompact} t={t} />
      </div>
    </div>
    <ComposerPastedTextDialog
      target={pastedTextTarget}
      title={t("composer.pastedTextEditTitle")}
      closeLabel={t("common.close")}
      cancelLabel={t("composer.pastedTextCancelEdit")}
      saveLabel={t("composer.pastedTextSaveEdit")}
      lineLabel={(count) => t("composer.pastedTextLineCount", { count })}
      characterLabel={(count) => t("composer.pastedTextCharacterCount", { count })}
      onSave={(target, nextText) => {
        richEditorRef.current?.editPastedText(
          target.nodePosition,
          target.text,
          nextText,
          t("composer.pastedTextChip", { lines: countComposerPasteLines(nextText) })
        );
        setPastedTextTarget(undefined);
        requestAnimationFrame(() => richEditorRef.current?.focus());
      }}
      onClose={() => {
        setPastedTextTarget(undefined);
        requestAnimationFrame(() => richEditorRef.current?.focus());
      }}
    />
    <Modal
      open={commandHelpOpen}
      title={t("composer.commands")}
      onClose={() => setCommandHelpOpen(false)}
      closeLabel={t("common.close")}
      size="medium"
      showClose
    >
      <div className="settings-list" aria-label={t("composer.commands")}>
        {availableCommandItems.map((item) => (
          <article key={item.id}>
            <div><span><strong>{item.label}</strong><small>{item.meta}</small></span></div>
          </article>
        ))}
      </div>
    </Modal>
    </div>
  );
}

function ComposerStopButton({ label, disabled, onStop }: { readonly label: string; readonly disabled: boolean; readonly onStop?: () => void }): JSX.Element {
  return <IconButton className="send-button send-button--stop" label={label} disabled={disabled} disabledReason={disabled ? label : undefined} onClick={onStop}><CircleStop aria-hidden="true" /></IconButton>;
}

function isCodedReviewDispatchFailure(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && error.code.length > 0;
}

function QueueStrip({ sessionId, items, control, supportedDispositions, controller, runAction, t, expanded, onExpandedChange }: { readonly sessionId: string; readonly items: readonly QueueItemView[]; readonly control?: QueueControlView; readonly supportedDispositions: readonly DeliveryMode[]; readonly controller: AppController; readonly runAction: RunAction; readonly t: Translator; readonly expanded: boolean; readonly onExpandedChange: (expanded: boolean) => void }): JSX.Element {
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const [draggingQueueItemId, setDraggingQueueItemId] = useState<string>();
  const [dragTargetQueueItemId, setDragTargetQueueItemId] = useState<string>();
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(() => new Set());
  const [queueControlPending, setQueueControlPending] = useState(false);
  const pendingItemIdsRef = useRef(new Set<string>());
  const queueControlPendingRef = useRef(false);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const editLockRef = useRef<{ readonly queueItemId: string; readonly token: string } | undefined>(undefined);
  const dragLockRef = useRef<{
    readonly token: string;
    readonly promise: Promise<void>;
    acquired: boolean;
    dropInProgress: boolean;
    released: boolean;
  } | undefined>(undefined);
  const queueItemsId = useId();
  const ordered = [...items].sort((left, right) => left.ordinal - right.ordinal || left.createdAt - right.createdAt);
  const queueWindow = composerQueueWindow(ordered, expanded);
  const unknown = ordered.some((item) => item.state === "dispatchUnknown");
  const paused = control?.state === "paused";
  const interactionLocked = control?.interactionLocked === true && dragLockRef.current === undefined;
  useEffect(() => {
    if (!queueWindow.collapsible && expanded) onExpandedChange(false);
  }, [expanded, onExpandedChange, queueWindow.collapsible]);
  const trackItemAction = (queueItemId: string, key: string, action: () => Promise<void>): Promise<void> | undefined => {
    if (pendingItemIdsRef.current.has(queueItemId)) return undefined;
    pendingItemIdsRef.current.add(queueItemId);
    setPendingItemIds(new Set(pendingItemIdsRef.current));
    const promise = action().finally(() => {
      pendingItemIdsRef.current.delete(queueItemId);
      setPendingItemIds(new Set(pendingItemIdsRef.current));
    });
    runAction(key, () => promise);
    return promise;
  };
  const releaseEditLock = (lock: { readonly queueItemId: string; readonly token: string }): Promise<void> => {
    if (editLockRef.current?.token === lock.token) editLockRef.current = undefined;
    const promise = controller.setQueueItemEditLock(lock.queueItemId, lock.token, false);
    runAction(`queue-edit-unlock:${lock.queueItemId}`, () => promise);
    return promise;
  };
  const closeEditor = (): void => {
    const lock = editLockRef.current;
    setEditingId(undefined);
    if (lock !== undefined) void releaseEditLock(lock).catch(() => undefined);
  };
  const beginEdit = (item: QueueItemView): void => {
    if (editLockRef.current?.queueItemId === item.id) return;
    const token = randomUuid();
    const promise = trackItemAction(
      item.id,
      `queue-edit-lock:${item.id}`,
      async () => {
        const previous = editLockRef.current;
        if (previous !== undefined) {
          setEditingId(undefined);
          await releaseEditLock(previous);
        }
        await controller.setQueueItemEditLock(item.id, token, true);
      }
    );
    if (promise === undefined) return;
    void promise.then(() => {
      editLockRef.current = { queueItemId: item.id, token };
      setEditingId(item.id);
      setEditingText(item.text);
    }).catch(() => undefined);
  };
  const runWithEditLock = (
    item: QueueItemView,
    key: string,
    action: (lockToken: string) => Promise<void>
  ): void => {
    const token = randomUuid();
    const promise = trackItemAction(item.id, key, async () => {
      await controller.setQueueItemEditLock(item.id, token, true);
      try {
        await action(token);
      } finally {
        await controller.setQueueItemEditLock(item.id, token, false);
      }
    });
    void promise?.catch(() => undefined);
  };
  const beginInteractionLock = (): NonNullable<typeof dragLockRef.current> => {
    const token = randomUuid();
    const promise = controller.setQueueInteractionLock(sessionId, token, true);
    const lock = { token, promise, acquired: false, dropInProgress: false, released: false };
    dragLockRef.current = lock;
    runAction(`queue-interaction-lock:${sessionId}`, () => promise);
    void promise.then(() => { lock.acquired = true; }).catch(() => undefined);
    return lock;
  };
  const releaseInteractionLock = async (lock: NonNullable<typeof dragLockRef.current>): Promise<void> => {
    if (lock.released) return;
    lock.released = true;
    if (dragLockRef.current === lock) dragLockRef.current = undefined;
    await lock.promise.catch(() => undefined);
    if (!lock.acquired) return;
    const promise = controller.setQueueInteractionLock(sessionId, lock.token, false);
    runAction(`queue-interaction-unlock:${sessionId}`, () => promise);
    await promise;
  };
  const reorderWithInteractionLock = (
    queueItemId: string,
    placement: "first" | "last" | "before" | "after",
    anchorQueueItemId?: string,
    existingLock?: NonNullable<typeof dragLockRef.current>
  ): void => {
    const lock = existingLock ?? beginInteractionLock();
    lock.dropInProgress = true;
    void (async () => {
      try {
        await lock.promise;
        const reorder = trackItemAction(
          queueItemId,
          `queue-reorder:${queueItemId}`,
          () => controller.reorderQueueItem(queueItemId, placement, anchorQueueItemId, lock.token)
        );
        if (reorder !== undefined) await reorder;
      } finally {
        await releaseInteractionLock(lock);
      }
    })().catch(() => undefined);
  };
  useEffect(() => {
    const lock = editLockRef.current;
    if (lock === undefined || editingId !== lock.queueItemId) return;
    const item = ordered.find((candidate) => candidate.id === lock.queueItemId);
    if (item === undefined || item.source !== "user" || (item.state !== "accepted" && item.state !== "queued")) {
      closeEditor();
      return;
    }
    const timer = window.setInterval(() => {
      const promise = controller.setQueueItemEditLock(lock.queueItemId, lock.token, true);
      runAction(`queue-edit-renew:${lock.queueItemId}`, () => promise);
      void promise.catch(() => {
        if (editLockRef.current?.token === lock.token) {
          editLockRef.current = undefined;
          setEditingId(undefined);
        }
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [controller, editingId, items, runAction]);
  useEffect(() => () => {
    const editLock = editLockRef.current;
    if (editLock !== undefined) void controllerRef.current.setQueueItemEditLock(editLock.queueItemId, editLock.token, false).catch(() => undefined);
    const dragLock = dragLockRef.current;
    if (dragLock !== undefined && !dragLock.released) {
      dragLock.released = true;
      void dragLock.promise.then(() => controllerRef.current.setQueueInteractionLock(sessionId, dragLock.token, false)).catch(() => undefined);
    }
  }, [sessionId]);
  const steerSupported = supportedDispositions.includes("steer");
  const deliveryUnavailable = supportedDispositions.length === 0;
  return (
    <div className={cx("queue-strip", unknown && "queue-strip--warning", paused && "queue-strip--paused")} aria-label={t("context.queue")}>
      <div className="queue-strip__title">{unknown ? <AlertTriangle aria-hidden="true" /> : paused ? <Pause aria-hidden="true" /> : <Clock3 aria-hidden="true" />}<strong>{t("composer.queueCount", { count: ordered.length })}</strong>{paused && <Pill tone="warning">{t("queue.paused")}</Pill>}{interactionLocked && <Pill tone="warning">{t("queue.interactionLocked")}</Pill>}<IconButton label={paused ? t("queue.resume") : t("queue.pause")} disabled={queueControlPending} onClick={() => {
        if (queueControlPendingRef.current) return;
        queueControlPendingRef.current = true;
        setQueueControlPending(true);
        runAction(paused ? `resume-queue:${sessionId}` : `pause-queue:${sessionId}`, async () => {
          try {
            await (paused ? controller.resumeQueue(sessionId) : controller.pauseQueue(sessionId));
          } finally {
            queueControlPendingRef.current = false;
            setQueueControlPending(false);
          }
        });
      }}>{paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</IconButton></div>
      <div id={queueItemsId} className={cx("queue-strip__items", expanded && "is-expanded")}>{queueWindow.items.map((item) => {
        const index = ordered.findIndex((candidate) => candidate.id === item.id);
        const mutable = item.state === "accepted" || item.state === "queued";
        const userEditable = mutable && item.source === "user";
        const pending = pendingItemIds.has(item.id);
        const editLocked = item.editLocked && editLockRef.current?.queueItemId !== item.id;
        const lockReason = interactionLocked
          ? t("queue.interactionLockedReason")
          : editLocked
            ? t("queue.editLockedReason")
            : undefined;
        const blocked = pending || lockReason !== undefined;
        const itemDeliveryUnavailable = !supportedDispositions.includes(item.mode);
        const reorder = (placement: "first" | "last" | "before" | "after", anchorQueueItemId?: string): void => {
          if (!blocked) reorderWithInteractionLock(item.id, placement, anchorQueueItemId);
        };
        return (
          <article
            key={item.id}
            className={cx(editingId === item.id && "is-editing", draggingQueueItemId === item.id && "is-dragging", dragTargetQueueItemId === item.id && "is-drag-target")}
            onDragOver={(event) => {
              if (draggingQueueItemId === undefined || draggingQueueItemId === item.id || !mutable || pending) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragTargetQueueItemId(item.id);
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDragTargetQueueItemId((current) => current === item.id ? undefined : current);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggingQueueItemId ?? event.dataTransfer.getData("text/x-joko-queue-item");
              const lock = dragLockRef.current;
              setDraggingQueueItemId(undefined);
              setDragTargetQueueItemId(undefined);
              if (sourceId === "" || sourceId === item.id || !mutable || pending || lock === undefined) {
                if (lock !== undefined) void releaseInteractionLock(lock).catch(() => undefined);
                return;
              }
              const source = ordered.find((candidate) => candidate.id === sourceId);
              if (source === undefined || !(source.state === "accepted" || source.state === "queued") || source.editLocked || pendingItemIdsRef.current.has(source.id)) {
                void releaseInteractionLock(lock).catch(() => undefined);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              const placement = event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
              reorderWithInteractionLock(source.id, placement, item.id, lock);
            }}
          >
            <div className="queue-strip__row">
              {mutable && <IconButton
                className="queue-strip__drag-handle"
                draggable={editingId !== item.id && !blocked}
                disabled={editingId === item.id || blocked}
                disabledReason={lockReason}
                label={`${t("queue.moveUp")} / ${t("queue.moveDown")}`}
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
                onDragStart={(event) => {
                  if (editingId === item.id || blocked) { event.preventDefault(); return; }
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/x-joko-queue-item", item.id);
                  setDraggingQueueItemId(item.id);
                  beginInteractionLock();
                }}
                onDragEnd={() => { const lock = dragLockRef.current; setDraggingQueueItemId(undefined); setDragTargetQueueItemId(undefined); if (lock !== undefined && !lock.dropInProgress) void releaseInteractionLock(lock).catch(() => undefined); }}
                onKeyDown={(event) => {
                  if (event.repeat || event.nativeEvent.isComposing || editingId === item.id || blocked) return;
                  const intent = resolveQueueReorderShortcut(event.key, index, ordered.length);
                  if (intent === null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if ("anchorIndex" in intent) reorder(intent.placement, ordered[intent.anchorIndex]?.id);
                  else reorder(intent.placement);
                }}
              ><GripVertical aria-hidden="true" /></IconButton>}
              <Pill tone={item.state === "dispatchUnknown" ? "warning" : item.mode === "steer" ? "accent" : "neutral"}>{deliveryLabel(item.mode, t)}</Pill>
              {item.source !== "user" && <Pill tone="neutral">{queueSourceLabel(item.source, t)}</Pill>}
              {editLocked && <Pill tone="warning">{t("queue.editLocked")}</Pill>}
              <span className="queue-strip__text">{item.text}</span>
              {mutable && editingId !== item.id && <div className="queue-strip__actions">{userEditable && <IconButton label={t("queue.edit")} disabled={blocked || itemDeliveryUnavailable} disabledReason={lockReason ?? (itemDeliveryUnavailable ? t("queue.deliveryUnavailable") : undefined)} onClick={() => beginEdit(item)}><Pencil aria-hidden="true" /></IconButton>}{userEditable && steerSupported && <IconButton label={t("queue.steerNow")} disabled={blocked} disabledReason={lockReason} onClick={() => runWithEditLock(item, `steer-now:${item.id}`, (lockToken) => controller.steerQueueItemNow(item.id, item.text, lockToken))}><Zap aria-hidden="true" /></IconButton>}<IconButton label={t("queue.cancel")} disabled={blocked} disabledReason={lockReason} onClick={() => { const promise = trackItemAction(item.id, `cancel-queue:${item.id}`, () => controller.cancelQueueItem(item.id)); void promise?.catch(() => undefined); }}><X aria-hidden="true" /></IconButton></div>}
            </div>
            {editingId === item.id && <form className="queue-strip__editor" onSubmit={(event) => { event.preventDefault(); if (itemDeliveryUnavailable || pending || interactionLocked) return; const lock = editLockRef.current; if (lock?.queueItemId !== item.id) return; const promise = trackItemAction(item.id, `edit-queue:${item.id}`, async () => { await controller.editQueueItem(item.id, editingText, item.mode, lock.token); setEditingId(undefined); await releaseEditLock(lock); }); void promise?.catch(() => undefined); }}><textarea rows={2} value={editingText} disabled={pending || interactionLocked} onChange={(event) => setEditingText(event.target.value)} aria-label={t("queue.editText")} /><Button disabled={pending} onClick={closeEditor}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={pending || interactionLocked || editingText.trim().length === 0 || itemDeliveryUnavailable}>{t("common.save")}</Button></form>}
          </article>
        );
      })}</div>
      {queueWindow.collapsible && <button className="queue-strip__toggle" type="button" aria-controls={queueItemsId} aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>{expanded ? t("queue.showLess") : t("queue.showMore", { count: queueWindow.hiddenCount })}</button>}
      {unknown && <p>{t("error.dispatchUnknown")}</p>}
      {paused && control?.pauseReason !== undefined && <p>{control.pauseReason}</p>}
      {deliveryUnavailable && <p role="status">{t("queue.deliveryUnavailable")}</p>}
    </div>
  );
}

function ComposerPalette({ title, items, empty, t, onSelect, onClose, embedded = false }: { readonly title: string; readonly items: readonly ComposerPaletteItem[]; readonly empty: string; readonly t: Translator; readonly onSelect: (item: ComposerPaletteItem) => void; readonly onClose: () => void; readonly embedded?: boolean }): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const visible = items.filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
  const selectedIndex = visible.length > 0 ? Math.min(activeIndex, visible.length - 1) : 0;
  const activeOptionId = visible.length > 0 ? `${listId}-option-${selectedIndex}` : undefined;

  useEffect(() => {
    if (visible.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
      return;
    }
    if (activeIndex >= visible.length) setActiveIndex(visible.length - 1);
  }, [activeIndex, visible.length]);

  useEffect(() => {
    if (activeOptionId === undefined) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  return (
    <div className={cx("composer-palette", embedded && "composer-palette--embedded")} role={embedded ? "group" : "dialog"} aria-label={title}>
      {!embedded && <header><strong>{title}</strong><IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton></header>}
      <input
        autoFocus
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded="true"
        aria-activedescendant={activeOptionId}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return;
          const intent = resolveComposerPaletteKey(event.key, selectedIndex, visible.length);
          if (intent === null) return;
          event.preventDefault();
          if (intent.kind === "close") {
            onClose();
          } else if (intent.kind === "move") {
            setActiveIndex(intent.index);
          } else {
            const selected = visible[intent.index];
            if (selected !== undefined) onSelect(selected);
          }
        }}
        placeholder={t("common.filter")}
        aria-label={`${t("common.filter")} ${title}`}
      />
      <div id={listId} className="composer-palette__list" role="listbox">
        {visible.map((item, index) => <button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} key={item.id} onMouseMove={() => setActiveIndex(index)} onClick={() => onSelect(item)}><span>{item.label}</span><small>{item.meta}</small></button>)}
        {visible.length === 0 && <p>{empty}</p>}
      </div>
    </div>
  );
}

function deliveryModesFor(session: SessionView, backend?: BackendView): readonly DeliveryMode[] {
  const advertised = advertisedQueueDeliveryModes(backend);
  if (session.state !== "running" && session.state !== "waiting" && session.state !== "retrying") {
    return advertised.includes("prompt") ? ["prompt"] : [];
  }
  return advertised.filter((mode) => mode !== "prompt");
}

function deliveryLabel(mode: DeliveryMode, t: Translator): string {
  if (mode === "steer") return t("composer.steer");
  if (mode === "followUp") return t("composer.followUp");
  return t("composer.send");
}

function queueSourceLabel(source: QueueItemView["source"], t: Translator): string {
  if (source === "schedule") return t("queue.sourceAutomation");
  if (source === "retry") return t("queue.sourceRetry");
  if (source === "backend") return t("queue.sourceSystem");
  return t("queue.sourceUser");
}

function canSend(text: string, attachments: readonly AttachmentDraft[], mentions: readonly ComposerMentionDraft[], selectionQuotes: readonly ComposerSelectionQuoteDraft[], supportedModes: readonly DeliveryMode[], mode: DeliveryMode): boolean {
  return supportedModes.includes(mode) && (text.trim() !== "" || attachments.length > 0 || selectionQuotes.length > 0 || mentions.some((mention) => mention.kind === "message"));
}

function composerHistoryDraftSignature(document: JSONContent): string {
  return JSON.stringify(normalizeComposerDocument(document));
}

function attachmentsAllowed(attachments: readonly AttachmentDraft[], policy: { readonly images: boolean; readonly files: boolean; readonly maximumItems?: number; readonly maximumBytes?: number }): boolean {
  if (policy.maximumItems !== undefined && attachments.length > policy.maximumItems) return false;
  return attachments.every((attachment) => {
    if (policy.maximumBytes !== undefined && attachment.file.size > policy.maximumBytes) return false;
    return attachment.kind === "image" ? policy.images : policy.files;
  });
}

function mergeDraftItemsById<T extends { readonly id: string }>(
  first: readonly T[],
  second: readonly T[]
): readonly T[] {
  const merged = new Map<string, T>();
  for (const item of [...first, ...second]) merged.set(item.id, item);
  return [...merged.values()];
}

function queueDeliveryMode(turnRunning: boolean, supportedModes: readonly DeliveryMode[]): DeliveryMode | undefined {
  const mode: DeliveryMode = turnRunning ? "followUp" : "prompt";
  return supportedModes.includes(mode) ? mode : undefined;
}

function handleComposerKey(
  event: KeyboardEvent,
  preference: ComposerSendShortcutPreference,
  turnRunning: boolean,
  platform: string | undefined,
  dispatch: (intent: "queue" | "steer") => void
): boolean {
  const intent = resolveComposerEnterIntent({
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    repeat: event.repeat,
    isComposing: event.isComposing
  }, preference, { turnRunning, platform });
  if (intent === null || intent === "native") return false;
  event.preventDefault();
  if (intent !== "ignore") dispatch(intent);
  return true;
}

function enqueueDraftSave(
  chainRef: { current: Promise<void> },
  controllerRef: { current: AppController },
  sessionId: string,
  draft: ComposerDraft
): Promise<void> {
  const operation = chainRef.current.then(() => controllerRef.current.saveDraft(sessionId, draft));
  chainRef.current = operation.catch(() => undefined);
  return operation;
}

function preventDrag(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function revokeAttachments(attachments: readonly AttachmentDraft[]): void {
  for (const attachment of attachments) if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
}

function withAttachmentPreview(attachment: AttachmentDraft): AttachmentDraft {
  return attachment.kind === "image" ? { ...attachment, previewUrl: URL.createObjectURL(attachment.file) } : attachment;
}

function withBrowserCommentPreview(item: BrowserCommentDraftItem): BrowserCommentDraftItem {
  return { ...item, screenshot: withAttachmentPreview(item.screenshot) };
}

function revokeBrowserCommentPreviews(items: readonly BrowserCommentDraftItem[]): void {
  revokeAttachments(items.map((item) => item.screenshot));
}

function browserCommentPageLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the durable draft.";
}

function voiceInputErrorMessage(update: VoiceMediaSessionUpdate, t: Translator): string | undefined {
  switch (update.error?.code) {
    case "unsupported": return t("voice.errors.unsupported");
    case "permissionDenied": return t("voice.errors.permissionDenied");
    case "deviceUnavailable": return t("voice.errors.deviceUnavailable");
    case "deviceBusy": return t("voice.errors.deviceBusy");
    case "captureFailed": return t("voice.errors.captureFailed");
    case "audioLimit": return t("voice.errors.audioLimit");
    case "serviceUnavailable": return t("voice.errors.serviceUnavailable");
    case "cancelled": return undefined;
    case undefined: break;
  }
  const failure = update.session?.failure?.code;
  if (update.session?.outcome === "noSpeech") return t("voice.errors.noSpeech");
  if (failure === "emptyTranscript") return t("voice.errors.noSpeech");
  if (failure === "providerAuthentication") return t("voice.errors.providerAuthentication");
  if (failure === "providerQuota") return t("voice.errors.providerQuota");
  return failure === undefined ? undefined : t("voice.errors.serviceUnavailable");
}

function workspaceEntryPaths(entries: WorkspaceView["entries"]): readonly string[] {
  return entries.flatMap((entry) => [entry.path, ...workspaceEntryPaths(entry.children ?? [])]);
}
