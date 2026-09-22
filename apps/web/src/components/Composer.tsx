import type { DragEvent, JSX, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSONContent } from "@tiptap/core";
import {
  AlertTriangle,
  AtSign,
  CircleCheck,
  CircleStop,
  Clock3,
  Image as ImageIcon,
  MessageSquarePlus,
  Paperclip,
  Send,
  Sparkles,
  Terminal,
  X,
  Zap
} from "lucide-react";
import type { AppController } from "../controller.js";
import type { ComposerSendShortcutPreference } from "../local-state.js";
import { modelSourceAccess } from "../model-source-access.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import { ModelSourceNotice } from "./ModelSourceNotice.js";
import type { ArtifactReferenceCatalogItemView, AttachmentDraft, BackendView, BrowserCommentDraftItem, ComposerDraft, ComposerMentionDraft, ComposerMessageMentionDraft, ComposerSelectionQuoteDraft, DeliveryMode, ExtraDirectoryView, QueueControlView, QueueItemView, RuntimeCommandView, SessionResourceView, SessionView, UsageTokensView, WorkspaceView } from "../model.js";
import { browserCommentPreviewTag, removeBrowserCommentAndRepairChains } from "../browser-comment-draft.js";
import { mergeRejectedComposerDraft } from "../composer-draft-recovery.js";
import { appendQuoteToComposerDocument, appendTextToComposerDocument, composerDocumentEndsWithWhitespace, composerDocumentIsEmpty, composerDocumentKeepingQuotes, composerDocumentPlainText, composerDocumentQuotes, emptyComposerDocument, joinComposerDocuments, normalizeComposerDocument, plainTextToComposerDocument } from "../composer-quote-document.js";
import { advertisedQueueDeliveryModes } from "./backend-control-capabilities.js";
import { upsertComposerMention } from "../message-reference.js";
import { normalizeSelectionQuoteDrafts } from "../selection-quote.js";
import { randomUuid } from "../web-crypto.js";
import { promptRecommendationStore } from "../prompt-recommendation-store.js";
import { ComposerOperationGuard, currentComposerPlatform, getComposerSendShortcutLabel, resolveComposerAttachmentPolicy, resolveComposerEnterIntent, resolveComposerEscapeIntent, resolveComposerHistoryKey, resolveComposerPaletteKey, resolveUserShellDraft, type ComposerSubmissionKind } from "./composer-behavior.js";
import { QueueStrip, deliveryLabel } from "./QueueStrip.js";
import { composerBuiltInCommand, composerCommandItems, detectComposerCommandActivation, filterComposerPaletteItems, replaceComposerCommandRun, type ComposerCommandActivation, type ComposerPaletteItem } from "./composer-palette.js";
import { ComposerInlineMentionPanel } from "./composer-inline-mention-panel.js";
import { ComposerAddMenu } from "./ComposerAddMenu.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { composerCaretTextOffset, composerDirectoryQueryToken, composerMentionCatalog, composerMentionsFromRanges, composerSelectionTextRange, detectComposerInlineMention, firstEnabledComposerMentionIndex, remapComposerInlineMentionRanges, replaceComposerDocumentTextRange, resolveComposerInlineMentionKey, resolveComposerMentionResults, restoreComposerInlineMentionRanges, setComposerCaretTextOffset, type ComposerInlineMentionActivation, type ComposerInlineMentionRange, type ComposerMentionCatalogItem, type ComposerMentionProviderState } from "./composer-inline-mention.js";
import { composerMentionsAllowed, resolveComposerMentionPolicy } from "../composer-mention-policy.js";
import { ContextCapacityRing } from "./ContextCapacityRing.js";
import { SessionUsageChip } from "./SessionUsageChip.js";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";
import { ComposerPastedTextDialog, type ComposerPastedTextDialogTarget } from "./ComposerPastedTextDialog.js";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { resolveComposerRouteReferenceFromRuntime } from "./composer-route-reference-runtime.js";
import { classifyComposerInternalDrop } from "./composer-internal-drop.js";
import { isComposerBlankPointerTarget } from "./composer-blank-focus.js";
import { shouldAutoFocusComposer } from "./composer-auto-focus.js";
import { isPromptRecommendationAcceptKey, PromptRecommendationEditorFrame, shouldShowPromptRecommendation } from "./PromptRecommendationOverlay.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, SegmentedControl, cx, CheckboxControl, SelectControl, formatBytes } from "./ui.js";
import { useDraftVoiceInput } from "./use-draft-voice-input.js";
import { useHeldVoiceInput } from "./use-held-voice-input.js";
import { GAMEPAD_SKILL_EVENT, useGamepadVoiceInput } from "../gamepad-client.js";
import { currentGamepadTaskRoot, useGamepadActions } from "../gamepad-actions.js";
import { isGamepadSkillBinding, type GamepadSkillBinding } from "../gamepad-input.js";
import { VoiceInputButton } from "./VoiceInputButton.js";
import { VoiceInputOverlay } from "./VoiceInputOverlay.js";
import { applyVoiceDraftResult, createVoiceDraftFence } from "./voice-draft-fence.js";
import { createVoiceInsertedEditTracker } from "./voice-inserted-edit.js";
import { useVoiceDictionaryLearning } from "./use-voice-dictionary-learning.js";

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

export function Composer({ controller, session, backend, sessionUsage, readOnly = false, autoFocus = true, focusRequest = 0, queue, queueControl, workspace, extraDirectories, resources, artifacts, sessions, commands, messageHistory, controls, runningStatus, messageMentionInsertion, selectionQuoteInsertion, attachmentInsertion, draftReplacement, t, runAction, onLocalSend, onDraftMutation, onStop, stopInFlight = false, onCompact }: {
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
  readonly resources: readonly SessionResourceView[];
  readonly artifacts?: readonly ArtifactReferenceCatalogItemView[];
  readonly sessions?: readonly SessionView[];
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
  readonly onDraftMutation?: () => void;
  readonly onStop?: () => void;
  readonly stopInFlight?: boolean;
  readonly onCompact?: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [gamepadSkillError, setGamepadSkillError] = useState<string>();
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
  const [commandActivation, setCommandActivation] = useState<ComposerCommandActivation>();
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [workspaceMentionIndex, setWorkspaceMentionIndex] = useState<ComposerWorkspaceMentionIndex>();
  const [workspaceMentionReload, setWorkspaceMentionReload] = useState(0);
  const [queueExpandedSessionId, setQueueExpandedSessionId] = useState<string>();
  const [bashMode, setBashMode] = useState(false);
  const [bashExcluded, setBashExcluded] = useState(false);
  const [submissionKind, setSubmissionKind] = useState<ComposerSubmissionKind>();
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [pastedTextTarget, setPastedTextTarget] = useState<ComposerPastedTextDialogTarget>();
  const [commandHelpOpen, setCommandHelpOpen] = useState(false);
  const richEditorRef = useRef<ComposerRichTextEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerStackRef = useRef<HTMLDivElement>(null);
  const [voiceRoot, setVoiceRoot] = useState<HTMLDivElement>();
  const bindComposer = useCallback((node: HTMLDivElement | null) => { composerStackRef.current = node; setVoiceRoot(node ?? undefined); }, []);
  const requestComposerFrame = useCallback((callback: FrameRequestCallback): number | undefined => {
    const ownerWindow = composerStackRef.current?.ownerDocument.defaultView;
    return ownerWindow?.requestAnimationFrame(callback);
  }, []);
  const [voiceSendTarget, setVoiceSendTarget] = useState<HTMLButtonElement>();
  const bindVoiceSend = useCallback((node: HTMLButtonElement | null) => setVoiceSendTarget(node ?? undefined), []);
  const voiceCaretRef = useRef<number | undefined>(undefined);
  const focusAnchorRef = useRef<Element | null>(null);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const browserCommentsRef = useRef(browserComments);
  browserCommentsRef.current = browserComments;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const operationGuard = useMemo(() => new ComposerOperationGuard(), [controller.getArtifactUrl, session.generation]);
  const operationGuardRef = useRef(operationGuard);
  operationGuardRef.current = operationGuard;
  operationGuardRef.current.activate(session.id);
  const markDraftEdited = (sessionId: string): void => {
    operationGuardRef.current.markDraftEdited(sessionId);
    onDraftMutation?.();
  };
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const textRef = useRef(text);
  textRef.current = text;
  const editorDocumentRef = useRef(editorDocument);
  editorDocumentRef.current = editorDocument;
  const editorRevisionRef = useRef(0);
  const hydratedDraftRevisionRef = useRef(0);

  const inlineMentionRangesRef = useRef(inlineMentionRanges);
  inlineMentionRangesRef.current = inlineMentionRanges;
  const inlineMentionActivationRef = useRef(inlineMentionActivation);
  inlineMentionActivationRef.current = inlineMentionActivation;
  const commandActivationRef = useRef(commandActivation);
  commandActivationRef.current = commandActivation;
  const composerIsComposingRef = useRef(false);
  const suppressedInlineMentionFromRef = useRef<number | undefined>(undefined);
  const suppressedCommandFromRef = useRef<number | undefined>(undefined);
  const lastComposerCaretRef = useRef<number | undefined>(undefined);
  const historyDraftRef = useRef<{ readonly text: string; readonly mentions: readonly ComposerMentionDraft[]; readonly inlineMentionRanges: readonly ComposerInlineMentionRange[]; readonly editorDocument: JSONContent } | undefined>(undefined);
  const hydratedHistoryDraftRef = useRef<string | undefined>(undefined);
  const appliedEditorEffectRef = useRef<string | undefined>(undefined);
  const appliedMessageMentionInsertionRef = useRef<number | undefined>(undefined);
  const appliedSelectionQuoteInsertionRef = useRef<number | undefined>(undefined);
  const appliedAttachmentInsertionRef = useRef<number | undefined>(undefined);
  const appliedDraftReplacementRef = useRef<number | undefined>(undefined);
  const appliedRejectedFirstInputRecoveryRef = useRef<number | undefined>(undefined);
  const promptRecommendationRevision = useSyncExternalStore(
    promptRecommendationStore.subscribe,
    promptRecommendationStore.getRevision
  );
  const editorTextUpdate = controller.state.editorTextUpdate;
  const rejectedFirstInputRecovery = controller.state.rejectedFirstInputRecovery;
  const selectionQuotes = useMemo(() => composerDocumentQuotes(editorDocument), [editorDocument]);
  const mentionCapability = backend?.capabilities.get("input.mention");
  const mentionPolicy = useMemo(() => resolveComposerMentionPolicy(mentionCapability), [mentionCapability]);
  const workspaceMentionsAvailable = mentionPolicy.files || mentionPolicy.directories;
  const canMention = workspaceMentionsAvailable || mentionPolicy.resources || mentionPolicy.artifacts || mentionPolicy.sessions;

  useEffect(() => {
    if (!workspaceMentionsAvailable || workspace === undefined) {
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
  }, [t, workspace?.id, workspace?.revision, workspaceMentionReload, workspaceMentionsAvailable]);

  const modelRouteUnavailable = !modelSourceAccess(backend, session.model, session.model, controller.state.snapshot.providers).available;
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
  const availableCommandItems = composerCommandItems(commands, commandOptions);
  const extraDirectoriesSupported = backend?.capabilities.get("workspace.extra_dirs")?.supported === true && workspace !== undefined;
  const selectableExtraDirectories = extraDirectories.filter((directory) => directory.workspaceId === workspace?.id && directory.trusted);
  const shellDraft = resolveUserShellDraft(text, bashMode, bashExcluded);
  const effectiveBashMode = shellDraft !== null && browserComments.length === 0;
  const bashPermitted = bashCapable;
  const turnRunning = session.state === "running" || session.state === "waiting" || session.state === "retrying";
  const stopCapability = session.state === "retrying" ? "context.auto_retry" : "turn.abort";
  const canStop = turnRunning && session.activeRunId !== undefined && backend?.capabilities.get(stopCapability)?.supported === true && onStop !== undefined;

  const sendShortcut = controller.state.preferences.composerSendShortcut;
  const composerPlatform = currentComposerPlatform();

  const resetHistoryNavigation = (): void => {
    setHistoryIndex(-1);
    historyDraftRef.current = undefined;
    hydratedHistoryDraftRef.current = undefined;
  };

  const closePalette = (restoreFocus = false): void => {
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    commandActivationRef.current = undefined;
    setCommandActivation(undefined);
    setPalette(undefined);
    if (restoreFocus) requestComposerFrame(() => richEditorRef.current?.focus());
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

  const closeTypedCommand = (restoreFocus: boolean, suppressTyped: boolean): void => {
    const activation = commandActivationRef.current;
    if (suppressTyped && activation !== undefined) suppressedCommandFromRef.current = activation.from;
    closePalette(restoreFocus);
  };

  const retireTypedInlineMention = (): void => {
    if (inlineMentionActivationRef.current?.source !== "typed") return;
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    setPalette((current) => current === "mention" ? undefined : current);
  };

  const retireTypedCommand = (): void => {
    const wasTyped = commandActivationRef.current !== undefined;
    commandActivationRef.current = undefined;
    setCommandActivation(undefined);
    if (wasTyped) setPalette((current) => current === "commands" ? undefined : current);
  };

  const activateTypedCommand = (nextText: string, caret: number, isComposing: boolean, isBash: boolean): boolean => {
    const activation = detectComposerCommandActivation(nextText, caret, { isComposing, bashMode: isBash });
    if (activation === undefined) {
      suppressedCommandFromRef.current = undefined;
      retireTypedCommand();
      return false;
    }
    if (suppressedCommandFromRef.current === activation.from) {
      retireTypedCommand();
      return false;
    }
    suppressedCommandFromRef.current = undefined;
    const previous = commandActivationRef.current;
    if (
      previous?.from !== activation.from
      || previous.to !== activation.to
      || previous.query !== activation.query
    ) {
      commandActivationRef.current = activation;
      setCommandActivation(activation);
      setCommandActiveIndex(0);
    }
    setPalette("commands");
    return true;
  };

  useEffect(() => {
    if (!canMention && palette === "mention") {
      inlineMentionActivationRef.current = undefined;
      setInlineMentionActivation(undefined);
      setPalette(undefined);
    }
  }, [canMention, palette]);

  const voiceDictionaryOwnerKey = JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id, session.id, String(session.generation)]);
  const voiceDictionaryLearning = useVoiceDictionaryLearning({
    controller, ownerKey: voiceDictionaryOwnerKey,
    enabled: !readOnly && controller.state.snapshot.settings.voiceInput.refinementEnabled
  });
  const clearVoiceDictionaryEdit = voiceDictionaryLearning.clear;
  const observeVoiceDictionaryEdit = voiceDictionaryLearning.observe;
  const voice = useDraftVoiceInput({
    controller, ownerKey: voiceDictionaryOwnerKey, root: voiceRoot,
    enabled: !readOnly && !effectiveBashMode && submissionKind === undefined && hydratedSession === session.id, t,
    focus: () => {
      richEditorRef.current?.focus();
      const root = voiceRoot?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      if (voiceCaretRef.current !== undefined) setComposerCaretTextOffset(root, root?.ownerDocument.getSelection() ?? null, voiceCaretRef.current);
    },
    capture: () => {
      clearVoiceDictionaryEdit(); closePalette(); setAttachmentError(undefined);
      const root = voiceRoot?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      const fence = createVoiceDraftFence({
        sessionId: session.id, revision: editorRevisionRef.current, text: textRef.current,
        selection: composerSelectionTextRange(root, root?.ownerDocument.getSelection() ?? null)
      });
      return (transcript, rawTranscriptText) => {
        const applied = applyVoiceDraftResult({ fence, sessionId: session.id, revision: editorRevisionRef.current,
          document: editorDocumentRef.current, text: textRef.current, transcript });
        if (!applied.applied) return undefined;
        markDraftEdited(session.id); editorRevisionRef.current += 1;
        const ranges = remapComposerInlineMentionReplacement(inlineMentionRangesRef.current, fence.from, fence.to, applied.caret - fence.from);
        editorDocumentRef.current = applied.document; textRef.current = applied.text;
        setEditorDocument(applied.document); setText(applied.text); replaceInlineMentionRanges(ranges);
        const nextMentions = composerMentionsFromRanges(mentionsRef.current, ranges);
        mentionsRef.current = nextMentions; setMentions(nextMentions);
        voiceCaretRef.current = applied.caret;
        voiceDictionaryLearning.track(createVoiceInsertedEditTracker({ fence, insertedText: transcript,
          ...(rawTranscriptText === undefined ? {} : { rawTranscriptText }) }), voiceDictionaryOwnerKey);
        resetHistoryNavigation();
        return applied;
      };
    }
  });
  const voiceUpdate = voice.update;
  const voiceActive = voice.active;
  const composerLocked = readOnly || submissionKind !== undefined || voiceActive;
  const composerEditorLocked = readOnly || (submissionKind !== undefined && submissionKind !== "send") || voiceActive;
  const cancelVoiceInput = voice.cancel;
  const stopVoiceInput = (): void => { void voice.finish(); };
  const retryVoiceInput = (): void => { voice.start(); };
  const useRetainedVoiceTranscript = voice.useTranscript;
  useGamepadVoiceInput(voiceRoot, voice.scope, {
    enabled: voice.supported && !readOnly && submissionKind === undefined && !effectiveBashMode && hydratedSession === session.id,
    isActive: voice.isActive, getCaptureIdentity: voice.getCaptureIdentity, start: voice.start, finish: voice.finish, cancel: voice.cancel
  });
  const sendRouteKey = JSON.stringify([session.backendId, session.targetId, session.model?.providerId, session.model?.modelId]);
  const sendOwner = useMemo(() => ({}), [voiceDictionaryOwnerKey, controller.getArtifactUrl, controller.state.snapshot.generation, sendRouteKey]);
  const gamepadSkillFlight = useRef<{ readonly owner: object } | undefined>(undefined);
  const gamepadSkillState = useRef({ owner: sendOwner, locked: composerLocked, bashMode: effectiveBashMode, connected: controller.state.connectionState === "connected", serverId: controller.state.activeProfile?.serverId });
  gamepadSkillState.current = { owner: sendOwner, locked: composerLocked, bashMode: effectiveBashMode, connected: controller.state.connectionState === "connected", serverId: controller.state.activeProfile?.serverId };
  useLayoutEffect(() => { setGamepadSkillError(undefined); }, [sendOwner]);
  const sendEpochRef = useRef<object | undefined>(undefined);
  useLayoutEffect(() => {
    const ownerWindow = voiceRoot?.ownerDocument.defaultView;
    const activate = (): void => { sendEpochRef.current = {}; };
    const retire = (): void => { sendEpochRef.current = undefined; };
    activate();
    ownerWindow?.addEventListener("pagehide", retire); ownerWindow?.addEventListener("pageshow", activate);
    return () => { retire(); ownerWindow?.removeEventListener("pagehide", retire); ownerWindow?.removeEventListener("pageshow", activate); };
  }, [voiceDictionaryOwnerKey, controller.getArtifactUrl, voiceRoot]);
  const sendStateRef = useRef({ owner: sendOwner, readOnly, connected: controller.state.connectionState === "connected", supportedModes, attachmentPolicy, mentionPolicy, resources, route: sendRouteKey });
  sendStateRef.current = { owner: sendOwner, readOnly, connected: controller.state.connectionState === "connected", supportedModes, attachmentPolicy, mentionPolicy, resources, route: sendRouteKey };
  const voiceSendFlight = useRef<object | undefined>(undefined);
  const sendDraftRef = useRef<(mode?: DeliveryMode, completedDocument?: JSONContent) => void>(() => undefined);
  const canFinishVoiceSend = !readOnly && controller.state.connectionState === "connected" && submissionKind === undefined && !effectiveBashMode && !modelRouteUnavailable && supportedModes.includes(deliveryMode)
    && attachmentsAllowed([...attachments, ...browserComments.map(item => item.screenshot)], attachmentPolicy)
    && composerMentionsAllowed(composerMentionsFromRanges(mentions, inlineMentionRanges), mentionPolicy, resources);
  const finishVoiceAndSend = (event?: KeyboardEvent): void => {
    if (!canFinishVoiceSend || voiceSendFlight.current !== undefined) return;
    const intent = event === undefined ? null : resolveComposerEnterIntent({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.isComposing, repeat: event.repeat }, sendShortcut, { platform: composerPlatform, turnRunning });
    const mode = intent === "steer" ? "steer" : intent === "queue" ? queueDeliveryMode(turnRunning, supportedModes) : deliveryMode;
    const flight = {}; voiceSendFlight.current = flight;
    const owner = sendOwner; const route = sendRouteKey;
    void voice.finish().then((result) => {
      if (voiceSendFlight.current !== flight || result.kind !== "applied" || !result.isCurrent() || sendStateRef.current.owner !== owner || sendStateRef.current.route !== route) return;
      clearVoiceDictionaryEdit();
      sendDraftRef.current(mode, result.value.document);
    }).finally(() => { if (voiceSendFlight.current === flight) voiceSendFlight.current = undefined; });
  };
  useLayoutEffect(() => () => { voiceSendFlight.current = undefined; }, [sendOwner]);
  const heldVoice = useHeldVoiceInput({
    scope: voice.scope, root: voiceRoot, sendTarget: voiceSendTarget, canSend: canFinishVoiceSend,
    enabled: voice.supported && !readOnly && submissionKind === undefined && !effectiveBashMode && hydratedSession === session.id,
    phase: voice.phase, shortcut: voice.preferences.shortcut,
    nativeShortcut: window.jokoDesktop?.capabilities.includes("voice.globalDictation") === true,
    isActive: voice.isActive, start: voice.start, finish: voice.finish, cancel: voice.cancel, onSend: finishVoiceAndSend,
    isSendKey: (event) => {
      if (palette !== undefined) return false;
      const intent = resolveComposerEnterIntent({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, isComposing: event.isComposing, repeat: event.repeat }, sendShortcut, { platform: composerPlatform, turnRunning });
      return intent === "queue" || intent === "steer";
    }
  });

  useLayoutEffect(() => {
    let cancelled = false;
    focusAnchorRef.current = composerStackRef.current?.ownerDocument.activeElement ?? null;
    const owner = operationGuardRef.current.capture(session.id);
    editorRevisionRef.current += 1;
    clearVoiceDictionaryEdit();
    setHydratedSession(undefined);
    hydratedDraftRevisionRef.current = 0;
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
    commandActivationRef.current = undefined;
    setCommandActivation(undefined);
    setCommandActiveIndex(0);
    composerIsComposingRef.current = false;
    suppressedInlineMentionFromRef.current = undefined;
    suppressedCommandFromRef.current = undefined;
    setHistoryIndex(-1);
    historyDraftRef.current = undefined;
    hydratedHistoryDraftRef.current = undefined;
    setAttachments((current) => { revokeAttachments(current); return []; });
    setBrowserComments((current) => { revokeBrowserCommentPreviews(current); return []; });
    void controllerRef.current.readDraftSnapshot(session.id).then(({ draft, revision }) => {
      if (cancelled || !operationGuardRef.current.ownsActivation(owner)) return;
      hydratedDraftRevisionRef.current = revision;
      if (operationGuardRef.current.draftUnchanged(owner)) {
        const restoredDocument = normalizeComposerDocument(draft?.editorDocument, draft?.text ?? "");
        const restoredText = composerDocumentPlainText(restoredDocument);
        const restoredMentions = draft?.mentions ?? [];
        setEditorDocument(restoredDocument);
        textRef.current = restoredText;
        setText(restoredText);
        setMentions(restoredMentions);
        replaceInlineMentionRanges(restoreComposerInlineMentionRanges(restoredText, restoredMentions, draft?.inlineMentionRanges));
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
  }, [controller.readDraftSnapshot, session.id, session.generation]); // Delivery capability updates are reconciled without re-reading storage.

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
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
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
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [autoFocus, hydratedSession, readOnly, session.id]);

  useEffect(() => {
    if (focusRequest <= 0 || readOnly || hydratedSession !== session.id) return;
    const ownerWindow = composerStackRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => richEditorRef.current?.focus("end"));
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [focusRequest, hydratedSession, readOnly, session.id]);

  useEffect(() => {
    if (readOnly
      || hydratedSession !== session.id
      || submissionKind !== undefined
      || rejectedFirstInputRecovery === undefined
      || rejectedFirstInputRecovery.sessionId !== session.id
      || appliedRejectedFirstInputRecoveryRef.current === rejectedFirstInputRecovery.eventId) return;
    appliedRejectedFirstInputRecoveryRef.current = rejectedFirstInputRecovery.eventId;
    if (hydratedDraftRevisionRef.current >= rejectedFirstInputRecovery.revision) return;
    const current: ComposerDraft = {
      text: textRef.current,
      editorDocument: editorDocumentRef.current,
      deliveryMode,
      mentions: mentionsRef.current,
      inlineMentionRanges: inlineMentionRangesRef.current,
      attachments: attachmentsRef.current,
      browserComments: browserCommentsRef.current,
      ...(extraDirectoryIds === undefined ? {} : { extraDirectoryIds })
    };
    const restored = mergeRejectedComposerDraft(rejectedFirstInputRecovery.input, current);
    const restoredDocument = normalizeComposerDocument(restored.editorDocument, restored.text);
    const restoredText = composerDocumentPlainText(restoredDocument);
    markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    hydratedDraftRevisionRef.current = rejectedFirstInputRecovery.revision;
    resetHistoryNavigation();
    closePalette();
    setBashMode(false);
    editorDocumentRef.current = restoredDocument;
    textRef.current = restoredText;
    mentionsRef.current = restored.mentions;
    attachmentsRef.current = restored.attachments;
    browserCommentsRef.current = restored.browserComments ?? [];
    setEditorDocument(restoredDocument);
    setText(restoredText);
    setMentions(restored.mentions);
    replaceInlineMentionRanges(restored.inlineMentionRanges ?? []);
    setExtraDirectoryIds(restored.extraDirectoryIds === undefined
      ? undefined
      : restored.extraDirectoryIds.filter((id) => selectableExtraDirectories.some((directory) => directory.id === id)));
    setDeliveryMode(supportedModes.includes(restored.deliveryMode) ? restored.deliveryMode : supportedModes[0] ?? "prompt");
    setAttachmentError(undefined);
    setAttachments((existing) => {
      revokeAttachments(existing);
      return restored.attachments.map(withAttachmentPreview);
    });
    setBrowserComments((existing) => {
      revokeBrowserCommentPreviews(existing);
      return (restored.browserComments ?? []).map(withBrowserCommentPreview);
    });
    requestComposerFrame(() => richEditorRef.current?.focus("end"));
  }, [hydratedSession, readOnly, rejectedFirstInputRecovery, session.id, submissionKind]);

  useEffect(() => {
    if (
      readOnly ||
      editorTextUpdate === undefined ||
      editorTextUpdate.sessionId !== session.id ||
      appliedEditorEffectRef.current === editorTextUpdate.eventId
    ) return;
    appliedEditorEffectRef.current = editorTextUpdate.eventId;
    markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    const replaced = appendTextToComposerDocument(composerDocumentKeepingQuotes(editorDocument), editorTextUpdate.text);
    const nextText = composerDocumentPlainText(replaced);
    const nextRanges: readonly ComposerInlineMentionRange[] = [];
    setEditorDocument(replaced);
    textRef.current = nextText;
    setText(nextText);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    requestComposerFrame(() => richEditorRef.current?.focus());
  }, [editorTextUpdate, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly ||
      messageMentionInsertion === undefined ||
      messageMentionInsertion.sessionId !== session.id ||
      appliedMessageMentionInsertionRef.current === messageMentionInsertion.id
    ) return;
    appliedMessageMentionInsertionRef.current = messageMentionInsertion.id;
    markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    closePalette();
    setBashMode(false);
    setMentions((current) => upsertComposerMention(current, messageMentionInsertion.mention));
    requestComposerFrame(() => richEditorRef.current?.focus());
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
    markDraftEdited(session.id);
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
    requestComposerFrame(() => richEditorRef.current?.focus());
  }, [selectionQuoteInsertion, readOnly, session.id]);

  useEffect(() => {
    if (
      readOnly
      || draftReplacement === undefined
      || draftReplacement.sessionId !== session.id
      || appliedDraftReplacementRef.current === draftReplacement.id
    ) return;
    appliedDraftReplacementRef.current = draftReplacement.id;
    markDraftEdited(session.id);
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
    requestComposerFrame(() => richEditorRef.current?.focus());
  }, [draftReplacement, readOnly, session.id]);

  useEffect(() => {
    if (!supportedModes.includes(deliveryMode)) setDeliveryMode(supportedModes[0] ?? "prompt");
  }, [deliveryMode, supportedModes]);

  useEffect(() => {
    if (readOnly || hydratedSession !== session.id || (submissionKind !== undefined && submissionKind !== "send")) return;
    const ownerWindow = composerStackRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const owner = operationGuardRef.current.capture(session.id);
    const draft = {
      text,
      editorDocument,
      deliveryMode,
      mentions,
      inlineMentionRanges,
      attachments,
      browserComments,
      ...(extraDirectoriesSupported && extraDirectoryIds !== undefined ? { extraDirectoryIds } : {})
    } satisfies ComposerDraft;
    const sourceControllerRef = { current: controllerRef.current };
    let cancelled = false;
    let savedTimer: number | undefined;
    const timer = ownerWindow.setTimeout(() => {
      if (cancelled || !operationGuardRef.current.ownsActivation(owner) || !operationGuardRef.current.draftUnchanged(owner)) return;
      void enqueueDraftSave(draftSaveChainRef, sourceControllerRef, session.id, draft).then(() => {
        if (cancelled || !operationGuardRef.current.ownsActivation(owner) || !operationGuardRef.current.draftUnchanged(owner)) return;
        setSaved(true);
        savedTimer = ownerWindow.setTimeout(() => {
          if (!cancelled && operationGuardRef.current.ownsActivation(owner)) setSaved(false);
        }, 1200);
      }).catch((error: unknown) => {
        if (!cancelled && operationGuardRef.current.ownsActivation(owner)) setAttachmentError(messageOf(error));
      });
    }, 420);
    return () => {
      cancelled = true;
      ownerWindow.clearTimeout(timer);
      if (savedTimer !== undefined) ownerWindow.clearTimeout(savedTimer);
    };
  }, [controller.saveDraft, attachments, browserComments, deliveryMode, editorDocument, extraDirectoriesSupported, extraDirectoryIds, hydratedSession, mentions, inlineMentionRanges, readOnly, session.id, submissionKind, text]);

  useEffect(() => () => {
    revokeAttachments(attachmentsRef.current);
    revokeBrowserCommentPreviews(browserCommentsRef.current);
  }, []);

  const updateDocument = (nextDocument: JSONContent, isComposing: boolean, mapRanges?: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]): void => {
    composerIsComposingRef.current = isComposing;
    markDraftEdited(session.id);
    editorRevisionRef.current += 1;
    resetHistoryNavigation();
    const next = composerDocumentPlainText(nextDocument);
    observeVoiceDictionaryEdit(next, isComposing);
    const nextRanges = mapRanges?.(inlineMentionRangesRef.current) ?? [];
    setEditorDocument(nextDocument);
    textRef.current = next;
    setText(next);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const caret = composerCaretTextOffset(root, root?.ownerDocument.getSelection() ?? null) ?? next.length;
    lastComposerCaretRef.current = caret;
    const mentionTrigger = canMention && !isComposing && !bashMode ? detectComposerInlineMention(next, caret, nextRanges) : null;
    if (mentionTrigger !== null) {
      retireTypedCommand();
      if (suppressedInlineMentionFromRef.current !== mentionTrigger.from) {
        const activation = { ...mentionTrigger, source: "typed" as const };
        inlineMentionActivationRef.current = activation;
        setInlineMentionActivation(activation);
        setInlineMentionActiveIndex(0);
        setPalette("mention");
      }
      return;
    }
    if (suppressedInlineMentionFromRef.current !== undefined) suppressedInlineMentionFromRef.current = undefined;
    retireTypedInlineMention();
    activateTypedCommand(
      next,
      caret,
      isComposing,
      resolveUserShellDraft(next, bashMode, bashExcluded) !== null
    );
  };

  useEffect(() => {
    const ownerDocument = composerStackRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const trackComposerSelection = (): void => {
      const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      const selection = ownerWindow.getSelection();
      const caret = composerCaretTextOffset(root, selection);
      if (caret === undefined) return;
      lastComposerCaretRef.current = caret;
      if (composerLocked || effectiveBashMode || composerIsComposingRef.current) {
        retireTypedInlineMention();
        retireTypedCommand();
        return;
      }
      const detectedMention = canMention
        ? detectComposerInlineMention(textRef.current, caret, inlineMentionRangesRef.current)
        : null;
      if (detectedMention !== null) {
        retireTypedCommand();
        if (suppressedInlineMentionFromRef.current === detectedMention.from) return;
        const previous = inlineMentionActivationRef.current;
        if (
          previous?.source === "typed"
          && previous.from === detectedMention.from
          && previous.to === detectedMention.to
          && previous.query === detectedMention.query
          && previous.quoted === detectedMention.quoted
        ) return;
        const activation = { ...detectedMention, source: "typed" as const };
        inlineMentionActivationRef.current = activation;
        setInlineMentionActivation(activation);
        setInlineMentionActiveIndex(0);
        setPalette("mention");
        return;
      }
      suppressedInlineMentionFromRef.current = undefined;
      retireTypedInlineMention();
      activateTypedCommand(textRef.current, caret, false, false);
    };
    ownerDocument.addEventListener("selectionchange", trackComposerSelection);
    return () => ownerDocument.removeEventListener("selectionchange", trackComposerSelection);
  }, [composerLocked, effectiveBashMode, canMention, voiceRoot?.ownerDocument]);

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
    markDraftEdited(session.id);
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
    requestComposerFrame(() => richEditorRef.current?.focus("end"));
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
      markDraftEdited(session.id);
      setAttachments((current) => [...current, ...next]);
    }
  };

  const updateInternalDrop = (dataTransfer: DataTransfer, clientX: number, clientY: number): boolean => {
    const state = classifyComposerInternalDrop(dataTransfer, workspace?.id);
    if (state.kind === "none") {
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
      return false;
    }
    setDragging(false);
    if (state.kind === "invalid" || effectiveBashMode || composerLocked) {
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
      return true;
    }
    if (richEditorRef.current?.routeReferenceDrop({ kind: "start" }) !== true) return true;
    richEditorRef.current.routeReferenceDrop({ kind: "move", clientX, clientY });
    return true;
  };

  const consumeInternalDrop = (dataTransfer: DataTransfer, clientX: number, clientY: number): boolean => {
    const state = classifyComposerInternalDrop(dataTransfer, workspace?.id);
    if (state.kind === "none") {
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
      return false;
    }
    setDragging(false);
    if (state.kind !== "ready" || effectiveBashMode || composerLocked) {
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
      return true;
    }
    if (richEditorRef.current?.routeReferenceDrop({ kind: "start" }) !== true
      || richEditorRef.current.routeReferenceDrop({ kind: "commit", clientX, clientY, insertion: state.insertion }) !== true) {
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
      return true;
    }
    closePalette();
    setBashMode(false);
    return true;
  };

  useLayoutEffect(() => {
    setDragging(false);
    richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
    return () => { richEditorRef.current?.routeReferenceDrop({ kind: "cancel" }); };
  }, [composerLocked, effectiveBashMode, session.generation, session.id, workspace?.id]);

  useEffect(() => {
    const ownerDocument = voiceRoot?.ownerDocument;
    if (ownerDocument === undefined) return;
    const cancelDrop = (): void => {
      setDragging(false);
      richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
    };
    ownerDocument.addEventListener("dragend", cancelDrop);
    return () => ownerDocument.removeEventListener("dragend", cancelDrop);
  }, [voiceRoot?.ownerDocument]);

  useEffect(() => {
    if (
      readOnly
      || attachmentInsertion === undefined
      || attachmentInsertion.sessionId !== session.id
      || appliedAttachmentInsertionRef.current === attachmentInsertion.id
    ) return;
    appliedAttachmentInsertionRef.current = attachmentInsertion.id;
    addFiles([attachmentInsertion.file]);
    requestComposerFrame(() => richEditorRef.current?.focus("end"));
  }, [attachmentInsertion, readOnly, session.id]);

  const finishSubmission = (sessionId: string, kind: ComposerSubmissionKind): void => {
    operationGuardRef.current.finishSubmission(sessionId, kind);
    if (operationGuardRef.current.activeSessionId === sessionId) setSubmissionKind(operationGuardRef.current.activeSubmission(sessionId));
  };

  const sendDraft = (modeOverride?: DeliveryMode, completedDocument?: JSONContent): void => {
    if (readOnly) return;
    const recommendationAtSend = completedDocument === undefined && recommendationVisible !== undefined && composerDocumentIsEmpty(editorDocument)
      ? recommendationVisible
      : undefined;
    const draftDocument = completedDocument ?? (recommendationAtSend === undefined ? editorDocument : plainTextToComposerDocument(recommendationAtSend));
    const draftText = composerDocumentPlainText(draftDocument);
    if (recommendationAtSend !== undefined) {
      markDraftEdited(session.id);
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
            requestComposerFrame(() => richEditorRef.current?.focus());
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
            requestComposerFrame(() => richEditorRef.current?.focus());
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
            requestComposerFrame(() => richEditorRef.current?.focus());
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
            requestComposerFrame(() => richEditorRef.current?.focus());
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
    const sourceController = controllerRef.current;
    const sourceControllerRef = { current: sourceController };
    const sourceSend = sourceController.send;
    const sourceGeneration = session.generation;
    const sourceGuard = operationGuardRef.current;
    const sourceSendOwner = sendOwner;
    const sourceRoute = sendRouteKey;
    const sourceEpoch = sendEpochRef.current;
    const sourceDeliveryMode = modeOverride ?? deliveryMode;
    const draftMedia = [...attachments, ...browserComments.map((item) => item.screenshot)];
    const sourceMentions = composerMentionsFromRanges(mentionsRef.current, inlineMentionRangesRef.current);
    const sourceMentionRanges = [...inlineMentionRangesRef.current];
    if (modelRouteUnavailable || !(browserComments.length > 0 || canSend(draftText, attachments, mentions, composerDocumentQuotes(draftDocument), supportedModes, sourceDeliveryMode)) || !attachmentsAllowed(draftMedia, attachmentPolicy) || !composerMentionsAllowed(sourceMentions, mentionPolicy, resources)) return;
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
    requestComposerFrame(() => richEditorRef.current?.focus());
    const clearedDraft = {
      text: "",
      editorDocument: clearedDocument,
      deliveryMode: sourceDeliveryMode,
      mentions: [],
      attachments: [],
      browserComments: []
    } satisfies ComposerDraft;
    const clearSave = enqueueDraftSave(draftSaveChainRef, sourceControllerRef, sourceSessionId, clearedDraft);

    const restoreRejectedDraft = async (): Promise<void> => {
      const ownsLiveComposer = operationGuardRef.current === sourceGuard && sourceGuard.ownsActivation(clearedOwner) && sourceEpoch !== undefined && sendEpochRef.current === sourceEpoch;
      const current: ComposerDraft = ownsLiveComposer
        ? {
            text: textRef.current,
            editorDocument: editorDocumentRef.current,
            deliveryMode,
            mentions: mentionsRef.current,
            inlineMentionRanges: inlineMentionRangesRef.current,
            attachments: attachmentsRef.current,
            browserComments: browserCommentsRef.current
          } satisfies ComposerDraft
        : await sourceController.readDraft(sourceSessionId) ?? clearedDraft;
      const currentDocument = normalizeComposerDocument(current.editorDocument, current.text);
      const currentText = composerDocumentPlainText(currentDocument);
      const restoredDocument = joinComposerDocuments(sourceEditorDocument, currentDocument);
      const restoredText = composerDocumentPlainText(restoredDocument);
      const restoredMentions = mergeDraftItemsById(sourceMentions, current.mentions);
      const currentRanges = restoreComposerInlineMentionRanges(currentText, current.mentions, current.inlineMentionRanges);
      const currentOffset = restoredText.length - currentText.length;
      const restoredRanges = restoreComposerInlineMentionRanges(restoredText, restoredMentions, [
        ...sourceMentionRanges,
        ...currentRanges.map((range) => ({ ...range, from: range.from + currentOffset, to: range.to + currentOffset }))
      ]);
      const restoredAttachments = mergeDraftItemsById(sourceAttachments, current.attachments);
      const restoredBrowserComments = mergeDraftItemsById(sourceBrowserComments, current.browserComments ?? []);
      const restoredDraft = {
        text: restoredText,
        editorDocument: restoredDocument,
        deliveryMode: current.deliveryMode,
        mentions: restoredMentions,
        inlineMentionRanges: restoredRanges,
        attachments: restoredAttachments,
        browserComments: restoredBrowserComments,
        ...((current.extraDirectoryIds ?? sourceExtraDirectoryIds) === undefined
          ? {}
          : { extraDirectoryIds: current.extraDirectoryIds ?? sourceExtraDirectoryIds })
      } satisfies ComposerDraft;
      if (ownsLiveComposer) {
        markDraftEdited(sourceSessionId);
        editorRevisionRef.current += 1;
        editorDocumentRef.current = restoredDocument;
        textRef.current = restoredText;
        mentionsRef.current = restoredMentions;
        attachmentsRef.current = restoredAttachments;
        browserCommentsRef.current = restoredBrowserComments;
        setEditorDocument(restoredDocument);
        setText(restoredText);
        setMentions(restoredMentions);
        replaceInlineMentionRanges(restoredRanges);
        setExtraDirectoryIds(current.extraDirectoryIds ?? sourceExtraDirectoryIds);
        setAttachments(restoredAttachments);
        setBrowserComments(restoredBrowserComments);
        requestComposerFrame(() => richEditorRef.current?.focus("end"));
      }
      await enqueueDraftSave(draftSaveChainRef, sourceControllerRef, sourceSessionId, restoredDraft);
    };

    runAction(`send:${sourceSessionId}`, async () => {
      try {
        await clearSave;
        const current = sendStateRef.current;
        if (sourceEpoch === undefined || sendEpochRef.current !== sourceEpoch || current.owner !== sourceSendOwner || current.readOnly || !current.connected || current.route !== sourceRoute || !current.supportedModes.includes(sourceDeliveryMode) || !attachmentsAllowed(draftMedia, current.attachmentPolicy) || !composerMentionsAllowed(sourceMentions, current.mentionPolicy, current.resources)) throw new Error(t("composer.inputUnavailable"));
        await sourceSend(sourceSessionId, {
          text: sourceText,
          editorDocument: sourceEditorDocument,
          attachments: sourceAttachments,
          browserComments: sourceBrowserComments,
          mentions: sourceMentions,
          inlineMentionRanges: sourceMentionRanges,
          deliveryMode: sourceDeliveryMode,
          ...(sourceExtraDirectoryIds === undefined ? {} : { extraDirectoryIds: sourceExtraDirectoryIds })
        }, { expectedGeneration: sourceGeneration });
        revokeAttachments(sourceAttachments);
        revokeBrowserCommentPreviews(sourceBrowserComments);
      } catch (error) {
        await restoreRejectedDraft();
        throw error;
      } finally {
        if (operationGuardRef.current === sourceGuard) finishSubmission(sourceSessionId, "send");
        else sourceGuard.finishSubmission(sourceSessionId, "send");
      }
    });
  };

  sendDraftRef.current = sendDraft;

  const insert = (item: ComposerPaletteItem): void => {
    if (composerLocked || item.mention !== undefined && !composerMentionsAllowed([item.mention], mentionPolicy, resources)) return;
    const typedActivation = commandActivationRef.current;
    if (typedActivation !== undefined) {
      const replacement = replaceComposerCommandRun(textRef.current, typedActivation, item.value);
      if (replacement === undefined) return;
      const nextDocument = replaceComposerDocumentTextRange(
        editorDocumentRef.current,
        typedActivation.from,
        typedActivation.to,
        replacement.replacement
      );
      const normalizedReplacementText = composerDocumentPlainText(plainTextToComposerDocument(replacement.text));
      if (nextDocument === undefined || composerDocumentPlainText(nextDocument) !== normalizedReplacementText) return;
      markDraftEdited(session.id);
      resetHistoryNavigation();
      const nextRanges = remapComposerInlineMentionReplacement(
        inlineMentionRangesRef.current,
        typedActivation.from,
        typedActivation.to,
        replacement.replacement.length
      );
      editorDocumentRef.current = nextDocument;
      setEditorDocument(nextDocument);
      textRef.current = normalizedReplacementText;
      setText(normalizedReplacementText);
      replaceInlineMentionRanges(nextRanges);
      const nextMentions = composerMentionsFromRanges(mentionsRef.current, nextRanges);
      mentionsRef.current = nextMentions;
      setMentions(nextMentions);
      const caret = Math.min(replacement.caret, normalizedReplacementText.length);
      lastComposerCaretRef.current = caret;
      closePalette();
      if (replacement.caret > normalizedReplacementText.length) {
        requestComposerFrame(() => richEditorRef.current?.focus("end"));
      } else {
        focusComposerAt(caret);
      }
      return;
    }
    markDraftEdited(session.id);
    resetHistoryNavigation();
    const prefix = composerDocumentIsEmpty(editorDocumentRef.current) || composerDocumentEndsWithWhitespace(editorDocumentRef.current) ? "" : " ";
    const nextDocument = appendTextToComposerDocument(editorDocumentRef.current, `${prefix}${item.value} `);
    const normalizedNextText = composerDocumentPlainText(nextDocument);
    const nextRanges = remapComposerInlineMentionRanges(textRef.current, normalizedNextText, inlineMentionRangesRef.current);
    editorDocumentRef.current = nextDocument;
    setEditorDocument(nextDocument);
    textRef.current = normalizedNextText;
    setText(normalizedNextText);
    replaceInlineMentionRanges(nextRanges);
    setMentions((current) => composerMentionsFromRanges(current, nextRanges));
    const mention = item.mention;
    if (mention !== undefined && mention.kind !== "message" && normalizedNextText.endsWith(mention.token)) {
      replaceInlineMentionRanges([...nextRanges, { mentionId: mention.id, from: normalizedNextText.length - mention.token.length, to: normalizedNextText.length }]);
      setMentions((current) => [...current.filter((candidate) => candidate.id !== mention.id), mention]);
    }
    closePalette();
    requestComposerFrame(() => richEditorRef.current?.focus());
  };

  const selectInlineMention = (item: ComposerMentionCatalogItem, reference = false): void => {
    if (composerLocked || item.disabled === true || !canMention) return;
    const activation = inlineMentionActivationRef.current;
    if (activation === undefined) return;
    const directoryToken = item.kind === "directory" && !reference ? composerDirectoryQueryToken(item.path) : undefined;
    const mention = item.mention;
    if (directoryToken !== undefined ? !workspaceMentionsAvailable : mention !== undefined && !composerMentionsAllowed([mention], mentionPolicy, resources)) return;
    if (directoryToken === undefined && mention === undefined) return;
    const existingSeparator = /\s/u.test(textRef.current[activation.to] ?? "");
    const replacement = directoryToken ?? `${mention!.token}${existingSeparator ? "" : " "}`;
    const nextDocument = replaceComposerDocumentTextRange(editorDocument, activation.from, activation.to, replacement);
    if (nextDocument === undefined) return;
    markDraftEdited(session.id);
    resetHistoryNavigation();
    const nextText = composerDocumentPlainText(nextDocument);
    const mappedRanges = remapComposerInlineMentionReplacement(inlineMentionRangesRef.current, activation.from, activation.to, replacement.length);
    setEditorDocument(nextDocument);
    textRef.current = nextText;
    setText(nextText);
    if (directoryToken !== undefined) {
      replaceInlineMentionRanges(mappedRanges);
      setMentions((current) => composerMentionsFromRanges(current, mappedRanges));
      const caret = activation.from + directoryToken.length;
      lastComposerCaretRef.current = caret;
      const detected = detectComposerInlineMention(nextText, caret, mappedRanges);
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
    requestComposerFrame(() => {
      richEditorRef.current?.focus();
      const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      setComposerCaretTextOffset(root, root?.ownerDocument.getSelection() ?? null, offset);
    });
  };
  const insertSkillRef = useRef(insert);
  insertSkillRef.current = insert;
  const receiveGamepadSkillRef = useRef<(binding: GamepadSkillBinding) => void>(() => undefined);
  receiveGamepadSkillRef.current = (binding) => {
    const source = gamepadSkillState.current;
    const ownerDocument = voiceRoot?.ownerDocument;
    const taskRoot = voiceRoot?.closest<HTMLElement>(".session-pane, .new-task-page");
    if (ownerDocument === undefined || source.locked || source.bashMode || !source.connected
      || source.serverId === undefined || source.serverId !== binding.serverId
      || ownerDocument.body.classList.contains("modal-open")
      || (taskRoot !== null && taskRoot !== undefined && currentGamepadTaskRoot(ownerDocument) !== taskRoot)) {
      setGamepadSkillError(t("settings.gamepad.skillInputUnavailable"));
      return;
    }
    if (gamepadSkillFlight.current?.owner === source.owner) return;
    const operation = { owner: source.owner };
    gamepadSkillFlight.current = operation;
    setGamepadSkillError(undefined);
    const sourceDraftDocument = editorDocumentRef.current;
    const isCurrent = (): boolean => gamepadSkillFlight.current === operation
      && gamepadSkillState.current.owner === source.owner
      && !gamepadSkillState.current.locked && !gamepadSkillState.current.bashMode
      && gamepadSkillState.current.connected && gamepadSkillState.current.serverId === binding.serverId
      && voiceRoot?.isConnected === true && voiceRoot.ownerDocument === ownerDocument
      && editorDocumentRef.current === sourceDraftDocument
      && !ownerDocument.body.classList.contains("modal-open")
      && (taskRoot === null || taskRoot === undefined || currentGamepadTaskRoot(ownerDocument) === taskRoot);
    void controller.listCommands(session.id).then((currentCommands) => {
      if (!isCurrent()) return;
      const matches = currentCommands.filter((command) => command.source === "skill" && command.loaded
        && command.resourceId === binding.resourceId && (command.sessionId === undefined || command.sessionId === session.id));
      const item = matches.length === 1 ? composerCommandItems(matches)[0] : undefined;
      if (item === undefined) { setGamepadSkillError(t("settings.gamepad.skillInputUnavailable")); return; }
      insertSkillRef.current(item);
      setGamepadSkillError(undefined);
    }).catch(() => {
      if (isCurrent()) setGamepadSkillError(t("settings.gamepad.skillInputUnavailable"));
    }).finally(() => {
      if (gamepadSkillFlight.current === operation) gamepadSkillFlight.current = undefined;
    });
  };
  useLayoutEffect(() => {
    if (voiceRoot === undefined) return;
    voiceRoot.dataset.gamepadSkill = "true";
    const receive = (event: Event): void => {
      if (event instanceof CustomEvent && isGamepadSkillBinding(event.detail)) receiveGamepadSkillRef.current(event.detail);
    };
    voiceRoot.addEventListener(GAMEPAD_SKILL_EVENT, receive);
    return () => {
      voiceRoot.removeEventListener(GAMEPAD_SKILL_EVENT, receive);
      delete voiceRoot.dataset.gamepadSkill;
    };
  }, [voiceRoot, sendOwner]);

  const openInlineMentionPalette = (): void => {
    if (composerLocked || !canMention) return;
    if (palette === "mention") {
      closeInlineMention(true, false);
      return;
    }
    const root = composerStackRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const selectedOffset = composerCaretTextOffset(root, root?.ownerDocument.getSelection() ?? null);
    const from = Math.min(Math.max(selectedOffset ?? lastComposerCaretRef.current ?? text.length, 0), text.length);
    const activation = { from, to: from, query: "", quoted: false, source: "button" as const };
    retireTypedCommand();
    inlineMentionActivationRef.current = activation;
    setInlineMentionActivation(activation);
    setInlineMentionActiveIndex(0);
    setPalette("mention");
  };

  const openCommandMenu = (): void => {
    commandActivationRef.current = undefined;
    setCommandActivation(undefined);
    suppressedCommandFromRef.current = undefined;
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    setPalette("commands");
  };

  const changeDeliveryMode = (mode: DeliveryMode): void => {
    if (composerLocked || mode === deliveryMode) return;
    markDraftEdited(session.id);
    setDeliveryMode(mode);
  };

  const sessionQueue = queue.filter((item) => item.sessionId === session.id && !["completed", "cancelled"].includes(item.state));
  const showQueue = !readOnly && (sessionQueue.length > 0 || queueControl?.state === "paused");
  const queueExpanded = queueExpandedSessionId === session.id;
  const draftMedia = [...attachments, ...browserComments.map((item) => item.screenshot)];
  const shortcutLabel = getComposerSendShortcutLabel(sendShortcut, composerPlatform);
  const matchingWorkspaceMentionIndex = workspaceMentionsAvailable && workspaceMentionIndex?.workspaceId === workspace?.id
    ? workspaceMentionIndex
    : undefined;
  const mentionReferenceOptions = {
    directory: mentionPolicy.directories,
    lineRange: mentionPolicy.lineRanges,
    directoryLabel: t("composer.referenceDirectory"),
    startLineLabel: t("composer.referenceStartLine"),
    endLineLabel: t("composer.referenceEndLine"),
    lineRangeLabel: t("composer.referenceLines")
  };
  const mentionCatalogItems = useMemo(
    () => composerMentionCatalog(
      workspaceMentionsAvailable ? workspace?.entries ?? [] : [],
      workspace?.id,
      mentionPolicy.resources ? resources : [],
      matchingWorkspaceMentionIndex?.paths ?? [],
      mentionPolicy.artifacts ? artifacts ?? [] : [],
      mentionPolicy.sessions ? sessions ?? [] : [],
      controller.state.snapshot.sessions
    ).filter((item) => item.kind !== "file" || mentionPolicy.files),
    [controller.state.snapshot.sessions, matchingWorkspaceMentionIndex?.paths, resources, artifacts, sessions, mentionPolicy, workspaceMentionsAvailable, workspace?.entries, workspace?.id]
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

  const typedCommandItems = commandActivation === undefined
    ? []
    : filterComposerPaletteItems(availableCommandItems, commandActivation.query);
  const selectedCommandIndex = typedCommandItems.length > 0
    ? Math.min(commandActiveIndex, typedCommandItems.length - 1)
    : 0;

  useEffect(() => {
    if (typedCommandItems.length === 0) {
      if (commandActiveIndex !== 0) setCommandActiveIndex(0);
      return;
    }
    if (commandActiveIndex >= typedCommandItems.length) setCommandActiveIndex(typedCommandItems.length - 1);
  }, [commandActiveIndex, typedCommandItems.length]);

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

  const captureTypedCommandKey = (event: KeyboardEvent): boolean => {
    if (palette !== "commands" || commandActivationRef.current === undefined || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return false;
    if (typedCommandItems.length === 0 && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      return true;
    }
    const intent = resolveComposerPaletteKey(event.key, selectedCommandIndex, typedCommandItems.length);
    if (intent === null) return false;
    event.preventDefault();
    if (intent.kind === "close") {
      closeTypedCommand(true, true);
    } else if (intent.kind === "move") {
      setCommandActiveIndex(intent.index);
    } else {
      const selected = typedCommandItems[intent.index];
      if (selected !== undefined) insert(selected);
    }
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
    && attachmentsAllowed(draftMedia, attachmentPolicy)
    && composerMentionsAllowed(composerMentionsFromRanges(mentions, inlineMentionRanges), mentionPolicy, resources);
  const mainSlotIsStop = canStop && !voiceActive && (!draftCanSend || submissionKind === "send");
  const showSecondaryStop = canStop && draftCanSend && submissionKind !== "send";

  useEffect(() => {
    if (!recommendationEligible) return;
    promptRecommendationStore.request(
      session.id,
      session.generation,
      session.updatedAt,
      (fence, signal) => controller.predictNextPrompt(fence.sessionId, fence.updatedAt, fence.generation, signal)
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
    const root = composerStackRef.current;
    const ownerDocument = root?.ownerDocument;
    if (root === null || ownerDocument === undefined) return;
    const collapseOnOutsidePointer = (event: MouseEvent): void => {
      if (event.composedPath().includes(root)) return;
      setQueueExpandedSessionId(undefined);
    };
    ownerDocument.addEventListener("mousedown", collapseOnOutsidePointer, true);
    return () => ownerDocument.removeEventListener("mousedown", collapseOnOutsidePointer, true);
  }, [queueExpanded, voiceRoot?.ownerDocument]);

  const paletteInAddMenu = palette === "add"
    || (palette === "commands" && commandActivation === undefined)
    || (palette === "mention" && inlineMentionActivation?.source === "button");

  useGamepadActions(voiceRoot, sendOwner, "composer", {
    submit: () => {
      if (readOnly || controller.state.connectionState !== "connected" || effectiveBashMode) return;
      if (voiceActive) { if (canFinishVoiceSend) finishVoiceAndSend(); }
      else if (!composerLocked && draftCanSend) sendDraft();
    },
    "add-attachments": () => {
      if (!composerLocked && !effectiveBashMode && controller.state.connectionState === "connected" && (attachmentPolicy.images || attachmentPolicy.files)) {
        closePalette(); fileInputRef.current?.click();
      }
    },
    "open-commands": () => {
      if (!composerLocked && !effectiveBashMode && controller.state.connectionState === "connected") {
        openCommandMenu();
      }
    }
  });

  return (
    <div className="composer-region">
      {runningStatus}
      <div
        ref={bindComposer}
        className={cx("composer-stack", showQueue && "composer-stack--with-queue")}
        onKeyDownCapture={(event) => {
          const eventTarget = ownedEventElement(event.target, event.currentTarget.ownerDocument);
          if (event.key === "Escape" && eventTarget !== null && eventTarget.closest(".queue-strip__editor") !== null) return;
          if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === "Escape" && (voiceActive || voiceUpdate?.state === "error")) {
            event.preventDefault();
            event.stopPropagation();
            cancelVoiceInput();
            return;
          }
          if (!event.nativeEvent.isComposing && event.key === "Escape" && palette === "commands" && commandActivationRef.current !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            closeTypedCommand(true, true);
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
            paletteTarget: eventTarget !== null && eventTarget.closest(".composer-palette") !== null
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
            if (text.length > 0 || mentions.length > 0) markDraftEdited(session.id);
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
        onDragEnter={(event) => {
          preventDrag(event);
          if (updateInternalDrop(event.dataTransfer, event.clientX, event.clientY)) event.dataTransfer.dropEffect = composerLocked || effectiveBashMode ? "none" : "copy";
          else if (!composerLocked) setDragging(true);
        }}
        onDragOver={(event) => {
          preventDrag(event);
          if (updateInternalDrop(event.dataTransfer, event.clientX, event.clientY)) event.dataTransfer.dropEffect = composerLocked || effectiveBashMode ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
          richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
        }}
        onDragEnd={() => {
          setDragging(false);
          richEditorRef.current?.routeReferenceDrop({ kind: "cancel" });
        }}
        onDrop={(event) => {
          preventDrag(event);
          setDragging(false);
          if (consumeInternalDrop(event.dataTransfer, event.clientX, event.clientY)) return;
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
                  markDraftEdited(session.id);
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
                    markDraftEdited(session.id);
                    revokeAttachments([item.screenshot]);
                    setBrowserComments((current) => removeBrowserCommentAndRepairChains(current, item.id));
                  }}><X aria-hidden="true" /></IconButton>
                </article>
              ))}
              <Button tone="ghost" disabled={composerLocked} onClick={() => {
                if (composerLocked) return;
                markDraftEdited(session.id);
                revokeBrowserCommentPreviews(browserComments);
                setBrowserComments([]);
              }}>{t("composer.clearBrowserComments")}</Button>
            </div>
          </details>
        )}
        {attachments.length > 0 && (
          <ComposerAttachmentTray
            ownerKey={voiceDictionaryOwnerKey}
            attachments={attachments}
            removeDisabled={composerLocked}
            t={t}
            onRemove={(attachment) => {
              if (composerLocked) return;
              markDraftEdited(session.id);
              if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
              setAttachments((current) => current.filter((item) => item.id !== attachment.id));
            }}
          />
        )}
        {attachmentError !== undefined && <p className="composer__error" role="alert"><AlertTriangle aria-hidden="true" />{attachmentError}</p>}
        {gamepadSkillError !== undefined && <p className="composer__error" role="alert"><AlertTriangle aria-hidden="true" />{gamepadSkillError}</p>}
        <PromptRecommendationEditorFrame
          recommendation={recommendationVisible}
          acceptLabel="Tab"
          {...(recommendationVisible === undefined ? {} : { onAccept: () => {
            const accepted = plainTextToComposerDocument(recommendationVisible);
            markDraftEdited(session.id);
            promptRecommendationStore.dismiss(session.id);
            editorDocumentRef.current = accepted;
            setEditorDocument(accepted);
            const acceptedText = composerDocumentPlainText(accepted);
            textRef.current = acceptedText;
            setText(acceptedText);
            requestComposerFrame(() => richEditorRef.current?.focus("end"));
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
              if (captureTypedCommandKey(event)) return true;
              if (captureInlineMentionKey(event)) return true;
              if (
                recommendationVisible !== undefined &&
                composerDocumentIsEmpty(activeDocument) &&
                isPromptRecommendationAcceptKey(event)
              ) {
                event.preventDefault();
                const accepted = plainTextToComposerDocument(recommendationVisible);
                markDraftEdited(session.id);
                promptRecommendationStore.dismiss(session.id);
                editorDocumentRef.current = accepted;
                setEditorDocument(accepted);
                const acceptedText = composerDocumentPlainText(accepted);
                textRef.current = acceptedText;
                setText(acceptedText);
                requestComposerFrame(() => richEditorRef.current?.focus("end"));
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
        {voice.draftError !== undefined && <p className="composer__error" role="alert">{voice.draftError}</p>}
        {!readOnly && <ModelSourceNotice key={JSON.stringify([voiceDictionaryOwnerKey, sendRouteKey])} controller={controller} backend={backend} selection={session.model} model={session.model} t={t} />}
        {voiceUpdate !== undefined && voiceUpdate.state !== "idle" && voiceUpdate.state !== "done" && voiceUpdate.state !== "cancelled" && (
          <VoiceInputOverlay
            state={voice.phase ?? voiceUpdate.state}
            transcript={voiceUpdate.session?.result?.text ?? voiceUpdate.session?.draft?.text ?? ""}
            error={voice.error}
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
                    commandActivationRef.current = undefined;
                    setCommandActivation(undefined);
                    suppressedCommandFromRef.current = undefined;
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
                  {(attachmentPolicy.images || attachmentPolicy.files) && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { closePalette(); fileInputRef.current?.click(); }}><Paperclip aria-hidden="true" /><span><strong>{t("composer.attach")}</strong><small>{t("composer.attachments")}</small></span></button>}
                  {canMention && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={openInlineMentionPalette}><AtSign aria-hidden="true" /><span><strong>{t("composer.mention")}</strong><small>{t("composer.mentionCount", { count: mentionCatalogItems.filter((item) => item.disabled !== true).length })}</small></span></button>}
                  <button className="composer-add-menu__action" type="button" role="menuitem" onClick={openCommandMenu}><Sparkles aria-hidden="true" /><span><strong>{t("composer.commands")}</strong><small>{availableCommandItems.length}</small></span></button>
                </div>
                {extraDirectoriesSupported && selectableExtraDirectories.length > 0 && <fieldset className="composer-add-menu__directories">
                  <legend>{t("composer.extraDirectories")}</legend>
                  {selectableExtraDirectories.map((directory) => {
                    const effective = extraDirectoryIds ?? selectableExtraDirectories.map((candidate) => candidate.id);
                    return <label key={directory.id}><CheckboxControl disabled={composerLocked} checked={effective.includes(directory.id)} onChange={(event) => {
                      markDraftEdited(session.id);
                      const current = extraDirectoryIds ?? selectableExtraDirectories.map((candidate) => candidate.id);
                      setExtraDirectoryIds(event.target.checked ? [...new Set([...current, directory.id])] : current.filter((id) => id !== directory.id));
                    }} /><span><strong>{directory.serverPath}</strong><small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")}</small></span></label>;
                  })}
                  <button className="composer-add-menu__directory-reset" type="button" disabled={composerLocked || extraDirectoryIds === undefined} onClick={() => { markDraftEdited(session.id); setExtraDirectoryIds(undefined); }}>{t("composer.extraDirectoriesUseDefault")}</button>
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
                  onReference={(item) => selectInlineMention(item, true)}
                  referenceOptions={mentionReferenceOptions}
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
                onReference={(item) => selectInlineMention(item, true)}
                referenceOptions={mentionReferenceOptions}
                onClose={() => closeInlineMention(true, true)}
                onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
              />}
              {palette === "commands" && commandActivation !== undefined && !paletteInAddMenu && <ComposerTypedCommandPalette
                title={t("composer.commands")}
                items={typedCommandItems}
                empty={t("composer.noCommands")}
                activeIndex={selectedCommandIndex}
                t={t}
                onActiveIndexChange={setCommandActiveIndex}
                onSelect={insert}
                onClose={() => closeTypedCommand(true, true)}
              />}
            </div>}
            {!effectiveBashMode && voice.supported && <VoiceInputButton phase={voice.phase} held={heldVoice.held} sendTargetActive={heldVoice.sendTargetActive} startedAt={voice.startedAt} ownerWindow={voice.ownerWindow} enabled={!readOnly && submissionKind === undefined && hydratedSession === session.id} buttonProps={heldVoice.buttonProps} t={t} />}
            {bashCapable && <IconButton label={effectiveBashMode ? t("composer.shellExit") : t("composer.shellEnter")} disabled={composerLocked} aria-pressed={effectiveBashMode} onClick={() => { closePalette(); setBashMode((current) => !current); requestComposerFrame(() => richEditorRef.current?.focus()); }}><Terminal aria-hidden="true" /></IconButton>}
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
              buttonRef={bindVoiceSend}
              className={cx("send-button", heldVoice.sendTargetActive && "is-voice-target")}
              tooltipOpen={heldVoice.sendTargetActive ? true : undefined}
              label={voiceActive ? t(heldVoice.sendTargetActive ? "voice.releaseToSend" : "voice.finishAndSend") : effectiveBashMode ? t("composer.shellEnter") : deliveryLabel(deliveryMode, t)}
              tip={voiceActive ? t(heldVoice.sendTargetActive ? "voice.releaseToSend" : "voice.finishAndSend") : effectiveBashMode ? `${t("composer.shellEnter")} (${shortcutLabel})` : `${deliveryLabel(deliveryMode, t)} (${shortcutLabel})`}
              disabled={voiceActive ? !canFinishVoiceSend : composerLocked || (effectiveBashMode ? !bashPermitted || (shellDraft?.command.length ?? 0) === 0 || attachments.length > 0 : !draftCanSend)}
              disabledReason={composerLocked || !composerMentionsAllowed(composerMentionsFromRanges(mentions, inlineMentionRanges), mentionPolicy, resources)
                ? t("composer.inputUnavailable")
                : effectiveBashMode && !bashPermitted
                  ? t("composer.shellUnavailable")
                  : effectiveBashMode && attachments.length > 0
                    ? t("composer.shellAttachments")
                    : effectiveBashMode
                      ? t("composer.shellPlaceholder")
                      : t("composer.placeholder")}
              onClick={() => { if (voice.isActive()) finishVoiceAndSend(); else sendDraft(); }}
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
        requestComposerFrame(() => richEditorRef.current?.focus());
      }}
      onClose={() => {
        setPastedTextTarget(undefined);
        requestComposerFrame(() => richEditorRef.current?.focus());
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

function ComposerTypedCommandPalette({ title, items, empty, activeIndex, t, onActiveIndexChange, onSelect, onClose }: {
  readonly title: string;
  readonly items: readonly ComposerPaletteItem[];
  readonly empty: string;
  readonly activeIndex: number;
  readonly t: Translator;
  readonly onActiveIndexChange: (index: number) => void;
  readonly onSelect: (item: ComposerPaletteItem) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const activeOptionId = items.length > 0 ? `${listId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (activeOptionId === undefined) return;
    rootRef.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  return (
    <div ref={rootRef} className="composer-palette" role="dialog" aria-label={title} data-composer-typed-command-palette="true">
      <header><strong>{title}</strong><IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton></header>
      <div id={listId} className="composer-palette__list" role="listbox" aria-label={title} aria-activedescendant={activeOptionId}>
        {items.map((item, index) => <button
          id={`${listId}-option-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          tabIndex={-1}
          key={item.id}
          onMouseMove={() => onActiveIndexChange(index)}
          onClick={() => onSelect(item)}
        ><span>{item.label}</span><small>{item.meta}</small></button>)}
        {items.length === 0 && <p>{empty}</p>}
      </div>
    </div>
  );
}


function ComposerPalette({ title, items, empty, t, onSelect, onClose, embedded = false }: { readonly title: string; readonly items: readonly ComposerPaletteItem[]; readonly empty: string; readonly t: Translator; readonly onSelect: (item: ComposerPaletteItem) => void; readonly onClose: () => void; readonly embedded?: boolean }): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
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
    rootRef.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  return (
    <div ref={rootRef} className={cx("composer-palette", embedded && "composer-palette--embedded")} role={embedded ? "group" : "dialog"} aria-label={title}>
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
  const saveDraft = controllerRef.current.saveDraft;
  const operation = chainRef.current.then(() => saveDraft(sessionId, draft));
  chainRef.current = operation.catch(() => undefined);
  return operation;
}

function preventDrag(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function ownedEventElement(target: EventTarget | null, ownerDocument: Document): Element | null {
  if (target === null || typeof target !== "object") return null;
  const candidate = target as Partial<Element>;
  return candidate.ownerDocument === ownerDocument && typeof candidate.closest === "function"
    ? target as Element
    : null;
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

function workspaceEntryPaths(entries: WorkspaceView["entries"]): readonly string[] {
  return entries.flatMap((entry) => [entry.path, ...workspaceEntryPaths(entry.children ?? [])]);
}
