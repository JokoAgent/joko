import type { JSONContent } from "@tiptap/core";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";
import {
  AlertTriangle,
  AtSign,
  Code2,
  FolderKanban,
  GitBranch,
  Hammer,
  Image as ImageIcon,
  Menu,
  MessageSquarePlus,
  MessageSquareCode,
  Paperclip,
  SearchCode,
  Send,
  Shield,
  Sparkles,
  X
} from "lucide-react";
import type { AppController } from "../controller.js";
import {
  composerDocumentIsEmpty,
  composerDocumentPlainText,
  emptyComposerDocument,
  normalizeComposerDocument,
  plainTextToComposerDocument
} from "../composer-quote-document.js";
import { modelPreferenceOwnerId } from "../model-picker-preferences.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import { composerMentionsAllowed, resolveComposerMentionPolicy } from "../composer-mention-policy.js";
import { browserCommentPreviewTag, removeBrowserCommentAndRepairChains } from "../browser-comment-draft.js";
import { applyPendingExtensionUse, resolvePendingExtensionUse } from "../extension-use-handoff.js";
import type {
  AppSnapshot,
  AttachmentDraft,
  BrowserCommentDraftItem,
  ComposerDraft,
  ComposerInlineMentionRange,
  ComposerMentionDraft,
  NativeSessionCandidateView,
  NewSessionDraftSelection,
  NewSessionLocalDraft,
  PermissionMode,
  SessionView,
  TargetWorktreeProbeView,
  WorktreeEligibilityView,
  WorktreeSourceView,
  WorkspaceEntryView
} from "../model.js";
import type { DelayedNewSessionDraft, NewSessionSubmissionOwner } from "../new-session-flow.js";
import { randomUuid } from "../web-crypto.js";
import {
  currentComposerPlatform,
  resolveComposerAttachmentPolicy,
  resolveComposerEnterIntent,
  resolveComposerPaletteKey,
  resolveTypedComposerPalette
} from "./composer-behavior.js";
import {
  composerCommandItems,
  composerMentionItems,
  detectComposerCommandActivation,
  filterComposerPaletteItems,
  type ComposerCommandActivation,
  type ComposerPaletteItem
} from "./composer-palette.js";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { insertNewSessionPaletteDocument, replaceNewSessionCommandDocument } from "./new-session-composer-document.js";
import {
  defaultNewSessionSelection,
  dialogueBackends,
  newSessionTargets,
  newSessionSelectionValue,
  parseNewSessionSelection,
  resolveNewSessionExecutionOptions
} from "./new-session-options.js";
import { nativeSessionDiscoveryAvailability } from "./session-discovery.js";
import { ModelPicker, type ModelPickerSelection } from "./ModelPicker.js";
import { ModelSourceNotice } from "./ModelSourceNotice.js";
import { modelSourceAccess, type ModelSourceSelection } from "../model-source-access.js";
import { PermissionSelector, permissionLabel } from "./PermissionSelector.js";
import { ComposerAddMenu } from "./ComposerAddMenu.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { ComposerInlineMentionPanel } from "./composer-inline-mention-panel.js";
import { HomeUsageDashboard } from "./HomeUsageDashboard.js";
import { ComposerPastedTextDialog, type ComposerPastedTextDialogTarget } from "./ComposerPastedTextDialog.js";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";
import { VoiceInputOverlay } from "./VoiceInputOverlay.js";
import { useDraftVoiceInput } from "./use-draft-voice-input.js";
import { useGamepadVoiceInput } from "../gamepad-client.js";
import { useHeldVoiceInput } from "./use-held-voice-input.js";
import { VoiceInputButton } from "./VoiceInputButton.js";
import { applyVoiceDraftResult, createVoiceDraftFence } from "./voice-draft-fence.js";
import { createVoiceInsertedEditTracker } from "./voice-inserted-edit.js";
import { useVoiceDictionaryLearning } from "./use-voice-dictionary-learning.js";
import {
  composerCaretTextOffset,
  composerDirectoryQueryToken,
  composerMentionCatalog,
  composerMentionsFromRanges,
  composerSelectionTextRange,
  detectComposerInlineMention,
  firstEnabledComposerMentionIndex,
  replaceComposerDocumentTextRange,
  resolveComposerInlineMentionKey,
  resolveComposerMentionResults,
  restoreComposerInlineMentionRanges,
  setComposerCaretTextOffset,
  type ComposerInlineMentionActivation,
  type ComposerMentionCatalogItem,
  type ComposerMentionProviderState
} from "./composer-inline-mention.js";
import { isComposerBlankPointerTarget } from "./composer-blank-focus.js";
import { resolveComposerRouteReferenceFromRuntime } from "./composer-route-reference-runtime.js";
import { hasComposerInternalDrop, resolveComposerInternalDrop } from "./composer-internal-drop.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, cx, formatBytes, formatRelativeTime, CheckboxControl, RadioControl, SelectControl } from "./ui.js";

interface NewSessionPageProps {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly initialTargetId?: string;
  readonly initialDialogueBackendId?: string;
  readonly navigationOpen: boolean;
  readonly t: Translator;
  readonly onOpenNavigation: () => void;
  readonly onClose: () => void;
  readonly onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft, owner: NewSessionSubmissionOwner) => Promise<void>;
}

interface NewTaskWorkspaceMentionIndex {
  readonly workspaceId: string;
  readonly status: "loading" | "ready" | "error";
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly error?: string;
}

interface FullAccessConfirmation {
  readonly scope: object;
  readonly ownerDocument: Document;
}

interface NewTaskInlineMentionActivation extends ComposerInlineMentionActivation {
  readonly source: "typed" | "button";
}

const QUICK_STARTS = [
  { key: "explore", label: "newTask.quickExplore", icon: SearchCode },
  { key: "build", label: "newTask.quickBuild", icon: Code2 },
  { key: "review", label: "newTask.quickReview", icon: MessageSquareCode },
  { key: "fix", label: "newTask.quickFix", icon: Hammer }
] as const;

/** Delayed-create route rendered within Joko's visual language. */
export function NewSessionPage({ controller, snapshot, initialTargetId, initialDialogueBackendId, navigationOpen, t, onOpenNavigation, onClose, onSubmit }: NewSessionPageProps): JSX.Element {
  const activeTargets = newSessionTargets(snapshot.targets, snapshot.settings.backendSettings);
  const eligibleDialogueBackends = dialogueBackends(snapshot.backends, snapshot.settings.backendSettings);
  const requestedTargetSelection: NewSessionDraftSelection | undefined = initialTargetId !== undefined
    && activeTargets.some((target) => target.id === initialTargetId)
    ? { kind: "target", targetId: initialTargetId }
    : undefined;
  const requestedSelection: NewSessionDraftSelection | undefined = requestedTargetSelection ?? (initialDialogueBackendId !== undefined
    && eligibleDialogueBackends.some((backend) => backend.id === initialDialogueBackendId)
    ? { kind: "dialogue", backendId: initialDialogueBackendId }
    : undefined);
  const [selection, setSelection] = useState<NewSessionDraftSelection | undefined>(() => requestedSelection ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends));
  const [startKind, setStartKind] = useState<"fresh" | "attach">("fresh");
  const [nativeSessions, setNativeSessions] = useState<readonly NativeSessionCandidateView[]>([]);
  const [nativeReference, setNativeReference] = useState("");
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string>();
  const [nativeDiscoveryState, setNativeDiscoveryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [nativeDiscoveryRevision, setNativeDiscoveryRevision] = useState(0);
  const [nativeSelectionWarning, setNativeSelectionWarning] = useState<string>();
  const [modelKey, setModelKey] = useState("");
  const [effort, setEffort] = useState("");
  const [fastMode, setFastMode] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [fullAccessConfirmation, setFullAccessConfirmation] = useState<FullAccessConfirmation>();
  const [planMode, setPlanMode] = useState(false);
  const [worktreeEnabled, setWorktreeEnabled] = useState(() => controller.state.preferences.newSessionWorktreeEnabled);
  const [worktreeSourceRef, setWorktreeSourceRef] = useState<string>();
  const [refreshWorktreeRemote, setRefreshWorktreeRemote] = useState(false);
  const [worktreeProbe, setWorktreeProbe] = useState<TargetWorktreeProbeView>();
  const [worktreeSources, setWorktreeSources] = useState<readonly WorktreeSourceView[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string>();
  const [worktreeProbeRevision, setWorktreeProbeRevision] = useState(0);
  const [worktreePreferenceSaving, setWorktreePreferenceSaving] = useState(false);
  const [text, setText] = useState("");
  const [editorDocument, setEditorDocument] = useState<JSONContent>(emptyComposerDocument);
  const [mentions, setMentions] = useState<readonly ComposerMentionDraft[]>([]);
  const [inlineMentionRanges, setInlineMentionRanges] = useState<readonly ComposerInlineMentionRange[]>([]);
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [browserComments, setBrowserComments] = useState<readonly BrowserCommentDraftItem[]>([]);
  const [extraDirectoryIds, setExtraDirectoryIds] = useState<readonly string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [draftError, setDraftError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [palette, setPalette] = useState<"add" | "mention" | "commands">();
  const [inlineMentionActivation, setInlineMentionActivation] = useState<NewTaskInlineMentionActivation>();
  const [inlineMentionActiveIndex, setInlineMentionActiveIndex] = useState(0);
  const [commandActivation, setCommandActivation] = useState<ComposerCommandActivation>();
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [workspaceMentionIndex, setWorkspaceMentionIndex] = useState<NewTaskWorkspaceMentionIndex>();
  const [workspaceMentionReload, setWorkspaceMentionReload] = useState(0);
  const [pastedTextTarget, setPastedTextTarget] = useState<ComposerPastedTextDialogTarget>();
  const [hydrated, setHydrated] = useState(false);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const richEditorRef = useRef<ComposerRichTextEditorHandle>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const [voiceRoot, setVoiceRoot] = useState<HTMLDivElement>();
  const bindComposer = useCallback((node: HTMLDivElement | null) => { composerRootRef.current = node; setVoiceRoot(node ?? undefined); }, []);
  const [voiceSendTarget, setVoiceSendTarget] = useState<HTMLButtonElement>();
  const bindVoiceSend = useCallback((node: HTMLButtonElement | null) => setVoiceSendTarget(node ?? undefined), []);
  const voiceCaretRef = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorDocumentRef = useRef(editorDocument);
  const textRef = useRef(text);
  const mentionsRef = useRef(mentions);
  const inlineMentionRangesRef = useRef(inlineMentionRanges);
  const attachmentsRef = useRef(attachments);
  const browserCommentsRef = useRef(browserComments);
  const submissionRef = useRef<object | undefined>(undefined);
  const submittingRef = useRef(submitting);
  const submissionAbortRef = useRef<AbortController | undefined>(undefined);
  const submissionOriginRef = useRef<NewSessionSubmissionOwner | undefined>(undefined);
  const fullAccessConfirmationRef = useRef<FullAccessConfirmation | undefined>(undefined);
  const mountedRef = useRef(true);
  const controllerRef = useRef(controller);
  const translatorRef = useRef(t);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestDraftRef = useRef<{ readonly controller: AppController; readonly draft: NewSessionLocalDraft } | undefined>(undefined);
  const restoredExecutionRef = useRef<NewSessionLocalDraft | undefined>(undefined);
  const typedPaletteTriggerRef = useRef<"/" | "@" | undefined>(undefined);
  const inlineMentionActivationRef = useRef<NewTaskInlineMentionActivation | undefined>(undefined);
  const suppressedInlineMentionFromRef = useRef<number | undefined>(undefined);
  const commandActivationRef = useRef<ComposerCommandActivation | undefined>(undefined);
  const commandComposingRef = useRef(false);
  const suppressedCommandFromRef = useRef<number | undefined>(undefined);
  const worktreeProbeSequenceRef = useRef(0);
  const worktreeAuthorityTargetRef = useRef<string | undefined>(undefined);
  const worktreePreferenceSavingRef = useRef(false);
  controllerRef.current = controller;
  translatorRef.current = t;
  editorDocumentRef.current = editorDocument;
  textRef.current = text;
  mentionsRef.current = mentions;
  inlineMentionRangesRef.current = inlineMentionRanges;
  attachmentsRef.current = attachments;
  browserCommentsRef.current = browserComments;
  submittingRef.current = submitting;
  commandActivationRef.current = commandActivation;

  const replaceInlineMentionActivation = (next: NewTaskInlineMentionActivation | undefined): void => {
    inlineMentionActivationRef.current = next;
    setInlineMentionActivation(next);
  };

  const replaceMentions = (nextMentions: readonly ComposerMentionDraft[], nextRanges: readonly ComposerInlineMentionRange[]): void => {
    mentionsRef.current = nextMentions;
    inlineMentionRangesRef.current = nextRanges;
    setMentions(nextMentions);
    setInlineMentionRanges(nextRanges);
  };

  const replaceBrowserComments = (next: readonly BrowserCommentDraftItem[]): void => {
    browserCommentsRef.current = next;
    setBrowserComments(next);
  };

  const replaceCommandActivation = (next: ComposerCommandActivation | undefined): void => {
    commandActivationRef.current = next;
    setCommandActivation(next);
  };

  const selectionKey = selection === undefined ? "" : newSessionSelectionValue(selection);
  const selected = selection?.kind === "target" ? activeTargets.find((target) => target.id === selection.targetId) : undefined;
  const backend = selection?.kind === "dialogue"
    ? eligibleDialogueBackends.find((candidate) => candidate.id === selection.backendId)
    : snapshot.backends.find((candidate) => candidate.id === selected?.backendId);
  const workspace = selected === undefined ? undefined : snapshot.workspaces.find((candidate) => candidate.id === selected.workspaceId);
  const workspaceIdRef = useRef(workspace?.id); workspaceIdRef.current = workspace?.id;
  const discoveryAvailability = nativeSessionDiscoveryAvailability(selected === undefined ? undefined : backend?.capabilities);
  const canDiscover = discoveryAvailability.visible;
  const canAttach = discoveryAvailability.attachEnabled;
  const selectedNativeSession = nativeSessions.find((candidate) => candidate.reference === nativeReference);
  const nativeSelectionReady = nativeDiscoveryState === "ready"
    && canAttach
    && selectedNativeSession !== undefined
    && selectedNativeSession.state !== "error"
    && selectedNativeSession.boundSessionId === undefined;
  const execution = resolveNewSessionExecutionOptions(backend, snapshot.models, modelKey);
  const modelSelection = backend === undefined ? undefined : modelSelectionFor(backend.id, modelKey);
  const selectedModel = execution.selectedModel ?? snapshot.models.find((model) => model.backendId === backend?.id
    && modelKeyFor(model.providerId, model.modelId) === modelKey);
  const pickerOwnerId = modelPreferenceOwnerId(controller.state.activeProfile?.serverId);
  const pickerBackendDefaults = snapshot.settings.backendSettings.find((settings) => settings.backendId === backend?.id);
  const pickerDefaultModel = pickerBackendDefaults?.model === undefined
    ? execution.availableModels[0]
    : execution.availableModels.find((model) =>
        model.providerId === pickerBackendDefaults.model?.providerId && model.modelId === pickerBackendDefaults.model.modelId);
  const pickerDefaultSelection: ModelPickerSelection | undefined = pickerDefaultModel === undefined ? undefined : {
    backendId: pickerDefaultModel.backendId,
    providerId: pickerDefaultModel.providerId,
    modelId: pickerDefaultModel.modelId,
    ...(pickerBackendDefaults?.model?.effort !== undefined && pickerDefaultModel.efforts.includes(pickerBackendDefaults.model.effort)
      ? { effort: pickerBackendDefaults.model.effort }
      : pickerDefaultModel.efforts[0] === undefined ? {} : { effort: pickerDefaultModel.efforts[0] }),
    fastMode: execution.fastModeSupported && pickerDefaultModel.supportsFast && (pickerBackendDefaults?.model?.fastMode ?? false)
  };
  const attachmentPolicy = useMemo(
    () => resolveComposerAttachmentPolicy(backend, selectedModel?.supportsImages),
    [backend, selectedModel?.supportsImages]
  );
  const mentionCapability = backend?.capabilities.get("input.mention");
  const mentionPolicy = useMemo(() => resolveComposerMentionPolicy(mentionCapability), [mentionCapability]);
  const mentionPolicyRef = useRef(mentionPolicy); mentionPolicyRef.current = mentionPolicy;
  // A new task has no live runtime resource or Artifact inventory, but it can quote an existing task.
  const canMention = mentionPolicy.files || mentionPolicy.directories || mentionPolicy.sessions;
  const workspaceMentionNavigation = mentionPolicy.files || mentionPolicy.directories;
  const matchingWorkspaceMentionIndex = mentionPolicy.files && workspaceMentionIndex?.workspaceId === workspace?.id
    ? workspaceMentionIndex
    : undefined;
  const mentionItems = canMention
    ? composerMentionItems(
        mentionPolicy.files ? workspace?.entries ?? [] : [],
        workspace?.id,
        matchingWorkspaceMentionIndex?.paths ?? [],
        mentionPolicy.sessions ? snapshot.sessions.filter((session): session is SessionView => session.state !== "closed") : []
      )
    : [];
  const inlineMentionCatalogItems = useMemo(
    () => composerMentionCatalog(
      workspaceMentionNavigation ? workspace?.entries ?? [] : [],
      workspace?.id,
      [],
      matchingWorkspaceMentionIndex?.paths ?? [],
      [],
      mentionPolicy.sessions ? snapshot.sessions : []
    ).filter((item) => item.kind === "directory"
      || item.kind === "file" && mentionPolicy.files
      || item.kind === "session" && mentionPolicy.sessions),
    [matchingWorkspaceMentionIndex?.paths, mentionPolicy.files, mentionPolicy.sessions, snapshot.sessions, workspace?.entries, workspace?.id, workspaceMentionNavigation]
  );
  const inlineMentionProviderState = useMemo<ComposerMentionProviderState>(
    () => matchingWorkspaceMentionIndex?.status === "loading"
      ? { kind: "loading", items: inlineMentionCatalogItems, truncated: matchingWorkspaceMentionIndex.truncated }
      : matchingWorkspaceMentionIndex?.status === "error"
        ? {
            kind: "error",
            message: matchingWorkspaceMentionIndex.error ?? t("composer.mentionLoadFailed"),
            items: inlineMentionCatalogItems,
            truncated: matchingWorkspaceMentionIndex.truncated
          }
        : { kind: "ready", items: inlineMentionCatalogItems, truncated: matchingWorkspaceMentionIndex?.truncated ?? false },
    [inlineMentionCatalogItems, matchingWorkspaceMentionIndex, t]
  );
  const inlineMentionResults = useMemo(
    () => resolveComposerMentionResults(inlineMentionProviderState, inlineMentionActivation?.query ?? ""),
    [inlineMentionActivation?.query, inlineMentionProviderState]
  );
  const mentionItemCount = mentionPolicy.directories
    ? inlineMentionCatalogItems.filter((item) => item.disabled !== true).length
    : mentionItems.length;
  useEffect(() => {
    const current = inlineMentionResults.items[inlineMentionActiveIndex];
    if (current !== undefined && current.disabled !== true) return;
    setInlineMentionActiveIndex(firstEnabledComposerMentionIndex(inlineMentionResults.items));
  }, [inlineMentionActiveIndex, inlineMentionResults.items]);
  const knownWorkspacePaths = useMemo(() => workspace === undefined
    ? []
    : [...new Set([
        ...workspaceEntryPaths(workspace.entries),
        ...(matchingWorkspaceMentionIndex?.paths ?? [])
      ])], [matchingWorkspaceMentionIndex?.paths, workspace]);
  const globalCommands = snapshot.commands.filter((command) => command.sessionId === undefined);
  const commandItems = composerCommandItems(
    backend?.capabilities.get("runtime.commands")?.supported === true ? globalCommands : []
  );
  const commandCatalogKey = commandItems.map((item) => `${item.id}\u0000${item.value}\u0000${item.meta}`).join("\u0001");
  const selectableExtraDirectories = snapshot.extraDirectories.filter((directory) => directory.workspaceId === workspace?.id && directory.trusted);
  const canSelectExtraDirectories = workspace !== undefined && backend?.capabilities.get("workspace.extra_dirs")?.supported === true;
  const canUseAddMenu = attachmentPolicy.images || attachmentPolicy.files || canMention || commandItems.length > 0
    || canSelectExtraDirectories && selectableExtraDirectories.length > 0;
  const worktreeApplicable = selected !== undefined && startKind === "fresh"
    && workspace?.kind === "userProject" && selected.remoteWorkspace === undefined;
  const currentWorktreeProbe = worktreeApplicable && worktreeProbe?.targetId === selected?.id
    ? worktreeProbe
    : undefined;
  const worktreeEligible = currentWorktreeProbe?.eligibility === "eligible";
  const worktreeConfirmedIneligible = currentWorktreeProbe !== undefined
    && worktreeEligibilityConfirmsPlainTask(currentWorktreeProbe.eligibility);
  const worktreeProbeNeedsRetry = currentWorktreeProbe?.eligibility === "unsafe"
    || currentWorktreeProbe?.eligibility === "unavailable";
  const worktreeRequested = worktreeApplicable && worktreeEnabled;
  const effectiveWorktreeEnabled = worktreeRequested && worktreeEligible;
  const worktreePreferenceRelevant = worktreeApplicable && !worktreeConfirmedIneligible;
  const showWorktreeControls = worktreePreferenceRelevant && (worktreeEnabled || worktreeEligible);

  const profileScope = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}`;
  useEffect(() => {
    if (worktreePreferenceSavingRef.current) return;
    setWorktreeEnabled(controller.state.preferences.newSessionWorktreeEnabled);
  }, [controller.state.preferences.newSessionWorktreeEnabled, profileScope, worktreePreferenceSaving]);
  const inlineMentionPaletteScope = useMemo(() => ({}), [
    profileScope,
    selectionKey,
    backend?.id,
    backend?.instanceGeneration,
    workspace?.id,
    workspace?.revision,
    voiceRoot?.ownerDocument
  ]);
  useLayoutEffect(() => {
    const retire = (): void => {
      inlineMentionActivationRef.current = undefined;
      suppressedInlineMentionFromRef.current = undefined;
      setInlineMentionActivation(undefined);
      setPalette((current) => current === "mention" ? undefined : current);
    };
    retire();
    const ownerWindow = voiceRoot?.ownerDocument.defaultView;
    ownerWindow?.addEventListener("pagehide", retire);
    return () => {
      ownerWindow?.removeEventListener("pagehide", retire);
      inlineMentionActivationRef.current = undefined;
      suppressedInlineMentionFromRef.current = undefined;
    };
  }, [inlineMentionPaletteScope, voiceRoot?.ownerDocument.defaultView]);
  const commandPaletteScope = useMemo(() => ({}), [
    profileScope,
    selectionKey,
    backend?.id,
    backend?.instanceGeneration,
    commandCatalogKey,
    voiceRoot?.ownerDocument
  ]);
  useLayoutEffect(() => {
    const retire = (): void => {
      commandActivationRef.current = undefined;
      commandComposingRef.current = false;
      suppressedCommandFromRef.current = undefined;
      setCommandActivation(undefined);
      setPalette((current) => current === "commands" ? undefined : current);
    };
    retire();
    const ownerWindow = voiceRoot?.ownerDocument.defaultView;
    ownerWindow?.addEventListener("pagehide", retire);
    return () => {
      ownerWindow?.removeEventListener("pagehide", retire);
      commandActivationRef.current = undefined;
      commandComposingRef.current = false;
      suppressedCommandFromRef.current = undefined;
    };
  }, [commandPaletteScope, voiceRoot?.ownerDocument.defaultView]);
  const permissionModesKey = execution.permissionModes.join("\u0000");
  const fullAccessConfirmationScope = useMemo(() => ({}), [
    profileScope,
    selectionKey,
    backend?.id,
    backend?.instanceGeneration,
    permissionModesKey,
    voiceRoot?.ownerDocument
  ]);
  const fullAccessConfirmationScopeRef = useRef(fullAccessConfirmationScope);
  fullAccessConfirmationScopeRef.current = fullAccessConfirmationScope;
  const retireFullAccessConfirmation = useCallback((candidate?: FullAccessConfirmation): void => {
    const current = fullAccessConfirmationRef.current;
    if (candidate !== undefined && current !== candidate) return;
    fullAccessConfirmationRef.current = undefined;
    setFullAccessConfirmation((pending) => candidate === undefined || pending === candidate ? undefined : pending);
  }, []);
  useLayoutEffect(() => {
    retireFullAccessConfirmation();
    const ownerWindow = voiceRoot?.ownerDocument.defaultView;
    const retire = (): void => retireFullAccessConfirmation();
    ownerWindow?.addEventListener("pagehide", retire);
    return () => {
      ownerWindow?.removeEventListener("pagehide", retire);
      fullAccessConfirmationRef.current = undefined;
    };
  }, [fullAccessConfirmationScope, retireFullAccessConfirmation, voiceRoot?.ownerDocument.defaultView]);
  const voiceOwnerKey = `${profileScope}\u0000${selectionKey}\u0000${startKind}`;
  const voiceDictionaryLearning = useVoiceDictionaryLearning({
    controller,
    ownerKey: voiceOwnerKey,
    enabled: hydrated && !submitting && snapshot.settings.voiceInput.refinementEnabled
  });
  const voice = useDraftVoiceInput({
    controller,
    ownerKey: voiceOwnerKey,
    root: voiceRoot,
    enabled: hydrated && !submitting && controller.state.connectionState === "connected",
    t,
    focus: () => {
      richEditorRef.current?.focus();
      const editor = voiceRoot?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      if (voiceCaretRef.current !== undefined) setComposerCaretTextOffset(editor, editor?.ownerDocument.getSelection() ?? null, voiceCaretRef.current);
    },
    capture: () => {
      voiceDictionaryLearning.clear();
      commandActivationRef.current = undefined;
      setCommandActivation(undefined);
      setPalette(undefined);
      const sourceDocument = editorDocumentRef.current;
      const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      const fence = createVoiceDraftFence({ sessionId: voiceOwnerKey, revision: 0, text: textRef.current, selection: composerSelectionTextRange(editor, editor?.ownerDocument.getSelection() ?? null) });
      return (transcript, rawTranscriptText) => {
        if (editorDocumentRef.current !== sourceDocument) return undefined;
        const applied = applyVoiceDraftResult({ fence, sessionId: voiceOwnerKey, revision: 0, document: sourceDocument, text: textRef.current, transcript });
        if (!applied.applied) return undefined;
        const nextRanges = remapComposerInlineMentionReplacement(inlineMentionRangesRef.current, fence.from, fence.to, applied.caret - fence.from);
        replaceMentions(composerMentionsFromRanges(mentionsRef.current, nextRanges), nextRanges);
        editorDocumentRef.current = applied.document;
        textRef.current = applied.text;
        setEditorDocument(applied.document);
        setText(applied.text);
        voiceDictionaryLearning.track(createVoiceInsertedEditTracker({
          fence,
          insertedText: transcript,
          ...(rawTranscriptText === undefined ? {} : { rawTranscriptText })
        }), voiceOwnerKey);
        voiceCaretRef.current = applied.caret;
        return applied;
      };
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const latest = latestDraftRef.current;
      if (!submittingRef.current && latest !== undefined) {
        void enqueueNewSessionDraftSave(draftSaveChainRef, { current: latest.controller }, latest.draft).catch(() => undefined);
      }
      revokeAttachments(attachmentsRef.current);
      revokeBrowserCommentPreviews(browserCommentsRef.current);
    };
  }, []);

  useEffect(() => {
    if (!mentionPolicy.files || workspace === undefined) {
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
  }, [mentionPolicy.files, t, workspace?.id, workspace?.revision, workspaceMentionReload]);

  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();
    setHydrated(false);
    worktreeAuthorityTargetRef.current = undefined;
    setDraftError(undefined);
    setSelection(requestedSelection ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends));
    void (async () => {
      const pendingReader = typeof controllerRef.current.readPendingExtensionUse === "function"
        ? controllerRef.current.readPendingExtensionUse()
        : Promise.resolve(undefined);
      const [draftResult, pendingResult] = await Promise.allSettled([
        controllerRef.current.readNewSessionDraft(),
        pendingReader
      ]);
      if (cancelled) return;
      const draft = draftResult.status === "fulfilled" ? draftResult.value : undefined;
      const pending = pendingResult.status === "fulfilled" ? pendingResult.value : undefined;
      let hydrationError = draftResult.status === "rejected"
        ? messageOf(draftResult.reason)
        : pendingResult.status === "rejected" ? messageOf(pendingResult.reason) : undefined;
      const restoredSelection = draft === undefined
        ? requestedSelection ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends)
        : requestedSelection
          ?? parseNewSessionSelection(newSessionSelectionValue(draft.selection), activeTargets, eligibleDialogueBackends)
          ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends);
      const restored = draft === undefined || restoredSelection === undefined
        ? undefined
        : { ...draft, selection: restoredSelection };
      let restoredDocument = normalizeComposerDocument(draft?.editorDocument, draft?.text ?? "");
      let restoredText = composerDocumentPlainText(restoredDocument);
      const restoredMentions = draft?.mentions ?? [];
      let restoredRanges = restoreComposerInlineMentionRanges(restoredText, restoredMentions, draft?.inlineMentionRanges);

      if (pending !== undefined) {
        try {
          const catalog = await controllerRef.current.getExtension(
            pending.extensionId,
            pending.runtimeSessionId,
            requestController.signal
          );
          if (cancelled) return;
          const extension = resolvePendingExtensionUse(pending, catalog);
          const applied = extension === undefined
            ? undefined
            : applyPendingExtensionUse(restoredDocument, restoredRanges, pending.commandName);
          if (applied === undefined) {
            hydrationError = translatorRef.current("extensions.useExpired");
          } else {
            restoredDocument = applied.document;
            restoredText = applied.text;
            restoredRanges = applied.inlineMentionRanges;
          }
          await controllerRef.current.clearPendingExtensionUse();
        } catch (error) {
          if (requestController.signal.aborted) return;
          hydrationError = messageOf(error);
        }
      }
      if (cancelled) return;

      restoredExecutionRef.current = restored;
      setSelection(restoredSelection);
      editorDocumentRef.current = restoredDocument;
      setEditorDocument(restoredDocument);
      textRef.current = restoredText;
      setText(restoredText);
      replaceMentions(restoredMentions, restoredRanges);
      setAttachments((current) => {
        revokeAttachments(current);
        return (draft?.attachments ?? []).map(withAttachmentPreview);
      });
      setBrowserComments((current) => {
        revokeBrowserCommentPreviews(current);
        const next = (draft?.browserComments ?? []).map(withBrowserCommentPreview);
        browserCommentsRef.current = next;
        return next;
      });
      setStartKind(draft?.nativeStart.kind ?? "fresh");
      setNativeReference(draft?.nativeStart.kind === "attach" ? draft.nativeStart.reference : "");
      setNativeSelectionWarning(undefined);
      setWorktreeEnabled(controllerRef.current.state.preferences.newSessionWorktreeEnabled);
      setWorktreeSourceRef(draft?.worktree?.sourceRef);
      setRefreshWorktreeRemote(draft?.worktree?.refreshRemote ?? false);
      setDraftError(hydrationError);
      setHydrationRevision((current) => current + 1);
    })().catch((error: unknown) => {
      if (!cancelled) setDraftError(messageOf(error));
    }).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [initialDialogueBackendId, initialTargetId, profileScope]);

  useEffect(() => {
    if (!hydrated) return;
    const frame = window.requestAnimationFrame(() => richEditorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [hydrated, profileScope]);

  useEffect(() => {
    const stillValid = selection === undefined
      ? undefined
      : parseNewSessionSelection(selectionKey, activeTargets, eligibleDialogueBackends);
    if (stillValid !== undefined) return;
    setSelection(defaultNewSessionSelection(activeTargets, eligibleDialogueBackends));
  }, [selectionKey, snapshot.backends, snapshot.settings.backendSettings, snapshot.targets]);

  useEffect(() => {
    if (backend === undefined || selection === undefined) return;
    const restored = restoredExecutionRef.current;
    if (restored !== undefined && newSessionSelectionValue(restored.selection) === selectionKey) {
      restoredExecutionRef.current = undefined;
      const restoredModelKey = restored.providerId.length > 0 && restored.modelId.length > 0
        ? modelKeyFor(restored.providerId, restored.modelId)
        : "";
      const restoredOptions = resolveNewSessionExecutionOptions(backend, snapshot.models, restoredModelKey);
      const restoredModel = snapshot.models.find((model) => model.backendId === backend.id
        && modelKeyFor(model.providerId, model.modelId) === restoredModelKey);
      setModelKey(restoredModelKey);
      setEffort(restoredModel === undefined ? restored.effort ?? "" : restoredOptions.effortSupported && restored.effort !== undefined && restoredModel.efforts.includes(restored.effort)
        ? restored.effort
        : restoredOptions.effortSupported ? restoredModel?.efforts[0] ?? "" : "");
      setFastMode(restoredModel === undefined ? restored.fastMode : restoredOptions.fastModeSupported && restoredModel.supportsFast && restored.fastMode);
      setPermissionMode(restoredOptions.permissionModes.includes(restored.permissionMode)
        ? restored.permissionMode
        : restoredOptions.permissionModes[0] ?? "ask");
      setPlanMode(restoredOptions.planModeSupported && restored.planMode);
      setWorktreeEnabled(controllerRef.current.state.preferences.newSessionWorktreeEnabled);
      setWorktreeSourceRef(restored.worktree?.sourceRef);
      setRefreshWorktreeRemote(restored.worktree?.refreshRemote ?? false);
      setExtraDirectoryIds(canSelectExtraDirectories
        ? (restored.extraDirectoryIds ?? []).filter((id) => selectableExtraDirectories.some((directory) => directory.id === id))
        : []);
      if (selection.kind === "dialogue") {
        setStartKind("fresh");
        setNativeReference("");
        setNativeSelectionWarning(undefined);
      }
      return;
    }
    const defaults = snapshot.settings.backendSettings.find((settings) => settings.backendId === backend.id);
    const availableOptions = resolveNewSessionExecutionOptions(backend, snapshot.models, "");
    const defaultModel = defaults?.model === undefined
      ? availableOptions.availableModels[0]
      : availableOptions.availableModels.find((model) =>
          model.providerId === defaults.model?.providerId && model.modelId === defaults.model.modelId);
    const options = resolveNewSessionExecutionOptions(backend, snapshot.models, defaultModel === undefined ? "" : modelKeyFor(defaultModel.providerId, defaultModel.modelId));
    const initialModel = options.modelSwitchSupported ? options.selectedModel : undefined;
    setModelKey(!options.modelSwitchSupported ? "" : defaults?.model !== undefined
      ? modelKeyFor(defaults.model.providerId, defaults.model.modelId)
      : initialModel === undefined ? "" : modelKeyFor(initialModel.providerId, initialModel.modelId));
    setEffort(options.effortSupported ? defaults?.model?.effort ?? initialModel?.efforts[0] ?? "" : "");
    setFastMode(initialModel === undefined && defaults?.model !== undefined ? defaults.model.fastMode
      : options.fastModeSupported && initialModel?.supportsFast === true && (defaults?.model?.fastMode ?? false));
    const defaultPermission = defaults?.permissionMode ?? snapshot.settings.policy.defaultMode;
    setPermissionMode(options.permissionModes.includes(defaultPermission) ? defaultPermission : options.permissionModes[0] ?? "ask");
    setPlanMode(options.planModeSupported && (defaults?.planMode ?? false));
    setWorktreeEnabled(controllerRef.current.state.preferences.newSessionWorktreeEnabled);
    setWorktreeSourceRef(undefined);
    setRefreshWorktreeRemote(false);
    setStartKind("fresh");
    setNativeReference("");
    setNativeSelectionWarning(undefined);
    replaceMentions([], []);
    setExtraDirectoryIds([]);
    inlineMentionActivationRef.current = undefined;
    setInlineMentionActivation(undefined);
    suppressedInlineMentionFromRef.current = undefined;
    commandActivationRef.current = undefined;
    setCommandActivation(undefined);
    suppressedCommandFromRef.current = undefined;
    setPalette(undefined);
    typedPaletteTriggerRef.current = undefined;
  }, [backend?.id, hydrationRevision, selectionKey]);

  useEffect(() => {
    if (selected === undefined || !canDiscover) {
      setNativeSessions([]);
      setNativeError(undefined);
      setNativeLoading(false);
      setNativeDiscoveryState("idle");
      return;
    }
    let current = true;
    setNativeLoading(true);
    setNativeDiscoveryState("loading");
    setNativeError(undefined);
    setNativeSelectionWarning(undefined);
    setNativeSessions([]);
    void controllerRef.current.discoverNativeSessions(selected.id).then((sessions) => {
      if (!current) return;
      setNativeSessions(sessions);
      setNativeDiscoveryState("ready");
    }).catch((cause: unknown) => {
      if (!current) return;
      setNativeError(cause instanceof Error ? cause.message : t("session.nativeLoadFailed"));
      setNativeDiscoveryState("error");
    }).finally(() => {
      if (current) setNativeLoading(false);
    });
    return () => { current = false; };
  }, [canDiscover, nativeDiscoveryRevision, selected?.id, t]);

  useEffect(() => {
    if (!hydrated || startKind !== "attach" || nativeReference.length === 0 || nativeDiscoveryState !== "ready") return;
    if (nativeSelectionReady) return;
    setNativeReference("");
    setNativeSelectionWarning(t("session.nativeSelectionUnavailable"));
  }, [hydrated, nativeDiscoveryState, nativeReference, nativeSelectionReady, startKind, t]);

  useEffect(() => {
    const sequence = ++worktreeProbeSequenceRef.current;
    if (!hydrated) return;
    const authorityTargetId = worktreeApplicable ? selected!.id : undefined;
    const previousAuthorityTargetId = worktreeAuthorityTargetRef.current;
    worktreeAuthorityTargetRef.current = authorityTargetId;
    if (authorityTargetId === undefined || previousAuthorityTargetId !== undefined && previousAuthorityTargetId !== authorityTargetId) {
      setWorktreeSourceRef(undefined);
      setRefreshWorktreeRemote(false);
    }
    if (authorityTargetId === undefined) {
      setWorktreeProbe(undefined);
      setWorktreeSources([]);
      setWorktreeLoading(false);
      setWorktreeError(undefined);
      return;
    }
    const abort = new AbortController();
    setWorktreeProbe(undefined);
    setWorktreeSources([]);
    setWorktreeLoading(true);
    setWorktreeError(undefined);
    void controllerRef.current.probeTargetWorktree(authorityTargetId, abort.signal).then(async (probe) => {
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      if (probe.targetId !== authorityTargetId) {
        throw new Error(translatorRef.current("worktree.probeTargetMismatch"));
      }
      setWorktreeProbe(probe);
      if (!probe.canRefreshRemote) setRefreshWorktreeRemote(false);
      if (probe.eligibility !== "eligible") {
        setWorktreeSourceRef(undefined);
        return;
      }
      const sources = await controllerRef.current.listTargetWorktreeSources(authorityTargetId, abort.signal);
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeSources(sources);
      setWorktreeSourceRef((current) => sources.some((source) => source.ref === current)
        ? current
        : sources.find((source) => source.current)?.ref ?? sources[0]?.ref);
    }).catch((cause: unknown) => {
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeError(cause instanceof Error ? cause.message : "Could not inspect isolated workspace support.");
    }).finally(() => {
      if (!abort.signal.aborted && sequence === worktreeProbeSequenceRef.current) setWorktreeLoading(false);
    });
    return () => abort.abort();
  }, [hydrated, selected?.id, startKind, worktreeApplicable, worktreeProbeRevision]);

  useEffect(() => {
    if (selectedModel === undefined) return;
    if (!selectedModel.efforts.includes(effort)) setEffort(selectedModel.efforts[0] ?? "");
    if (!selectedModel.supportsFast) setFastMode(false);
  }, [modelKey, selectedModel?.modelId, selectedModel?.providerId]);

  useEffect(() => {
    if (!hydrated || selection === undefined || submitting) return;
    const draft: NewSessionLocalDraft = {
      selection,
      nativeStart: startKind === "attach" && selected !== undefined && nativeReference.length > 0
        ? { kind: "attach", reference: nativeReference }
        : { kind: "fresh" },
      providerId: modelSelection?.providerId ?? "",
      modelId: modelSelection?.modelId ?? "",
      ...((selectedModel === undefined ? effort.length > 0 : execution.effortSupported && selectedModel.efforts.includes(effort)) ? { effort } : {}),
      fastMode: selectedModel === undefined ? fastMode : execution.fastModeSupported && selectedModel.supportsFast && fastMode,
      permissionMode: execution.permissionModes.includes(permissionMode) ? permissionMode : execution.permissionModes[0] ?? "ask",
      planMode: execution.planModeSupported && planMode,
      worktree: {
        enabled: worktreeEnabled,
        ...(worktreeSourceRef === undefined ? {} : { sourceRef: worktreeSourceRef }),
        refreshRemote: refreshWorktreeRemote
      },
      text,
      editorDocument,
      mentions: composerMentionsFromRanges(mentions, inlineMentionRanges),
      inlineMentionRanges,
      attachments,
      browserComments,
      ...(canSelectExtraDirectories ? { extraDirectoryIds } : {})
    };
    const sourceControllerRef = { current: controllerRef.current };
    latestDraftRef.current = { controller: sourceControllerRef.current, draft };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void enqueueNewSessionDraftSave(draftSaveChainRef, sourceControllerRef, draft).then(() => { if (!cancelled) setDraftError(undefined); }).catch((error: unknown) => { if (!cancelled) setDraftError(messageOf(error)); });
    }, 420);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [controller.saveNewSessionDraft, attachments, browserComments, canSelectExtraDirectories, editorDocument, effort, execution.effortSupported, execution.fastModeSupported, execution.permissionModes, execution.planModeSupported, extraDirectoryIds, fastMode, hydrated, mentions, inlineMentionRanges, modelKey, nativeReference, permissionMode, planMode, refreshWorktreeRemote, selected?.id, selectedModel?.efforts, selectedModel?.supportsFast, selectionKey, startKind, submitting, text, worktreeEnabled, worktreeSourceRef]);

  const draftMedia = [...attachments, ...browserComments.map((item) => item.screenshot)];
  const attachmentsAllowed = draftAttachmentsAllowed(draftMedia, attachmentPolicy);
  const mentionsAllowed = newTaskMentionsAllowed(
    composerMentionsFromRanges(mentions, inlineMentionRanges),
    mentionPolicy,
    workspace?.id
  );
  const hasInput = !composerDocumentIsEmpty(editorDocument) || attachments.length > 0 || browserComments.length > 0;
  const validContext = selection !== undefined && backend !== undefined
    && (startKind === "fresh" || (selected !== undefined && nativeSelectionReady));
  const modelRouteReady = modelSourceAccess(backend, modelSelection, selectedModel, snapshot.providers).available;
  const worktreeDecisionReady = !worktreePreferenceRelevant || (
    !worktreePreferenceSaving
    && (!worktreeEnabled || (!worktreeLoading && worktreeError === undefined && worktreeEligible))
  );
  const canFinishVoiceSend = hydrated && controller.state.connectionState === "connected" && validContext && modelRouteReady && attachmentsAllowed && mentionsAllowed && worktreeDecisionReady && fullAccessConfirmation === undefined && !submitting;
  const canSend = canFinishVoiceSend && hasInput && !voice.active;
  const submissionScope = useMemo(() => ({}), [profileScope, selectionKey, startKind, nativeReference, modelKey, selectedModel?.providerId, selectedModel?.modelId, effort, fastMode, permissionMode, planMode, effectiveWorktreeEnabled, worktreeSourceRef, refreshWorktreeRemote, snapshot.generation, controller.getArtifactUrl, voiceRoot]);
  const submissionEpochRef = useRef<object | undefined>(undefined);
  const submissionScopeRef = useRef(submissionScope); submissionScopeRef.current = submissionScope;
  const submissionValidityRef = useRef(false);
  submissionValidityRef.current = hydrated && validContext && modelRouteReady && attachmentsAllowed && mentionsAllowed && worktreeDecisionReady && fullAccessConfirmationRef.current === undefined && controller.state.connectionState === "connected";
  useLayoutEffect(() => {
    const ownerWindow = voiceRoot?.ownerDocument.defaultView;
    const activate = (): void => { submissionEpochRef.current = {}; };
    const retire = (): void => { submissionEpochRef.current = undefined; submissionRef.current = undefined; submissionAbortRef.current?.abort(); submissionAbortRef.current = undefined; submissionOriginRef.current = undefined; setSubmitting(false); };
    activate();
    ownerWindow?.addEventListener("pagehide", retire); ownerWindow?.addEventListener("pageshow", activate);
    return () => { retire(); ownerWindow?.removeEventListener("pagehide", retire); ownerWindow?.removeEventListener("pageshow", activate); };
  }, [submissionScope, voiceRoot]);
  useLayoutEffect(() => {
    if (submissionOriginRef.current !== undefined && !submissionOriginRef.current.isCurrent()) submissionAbortRef.current?.abort();
  });
  const submitRef = useRef<(document?: JSONContent) => Promise<void>>(async () => undefined);
  const voiceSendFlight = useRef<object | undefined>(undefined);
  const finishVoiceAndSend = (): void => {
    if (!canFinishVoiceSend || voiceSendFlight.current !== undefined) return;
    const flight = {}; voiceSendFlight.current = flight;
    const scope = submissionScope; const epoch = submissionEpochRef.current;
    void voice.finish().then(async (result) => {
      if (voiceSendFlight.current !== flight || result.kind !== "applied" || !result.isCurrent() || submissionScopeRef.current !== scope || submissionEpochRef.current !== epoch || !submissionValidityRef.current) return;
      await submitRef.current(result.value.document);
    }).finally(() => { if (voiceSendFlight.current === flight) voiceSendFlight.current = undefined; });
  };
  useLayoutEffect(() => () => { voiceSendFlight.current = undefined; }, [submissionScope]);
  useGamepadVoiceInput(voiceRoot, voice.scope, {
    enabled: voice.supported && hydrated && !submitting,
    isActive: voice.isActive, getCaptureIdentity: voice.getCaptureIdentity,
    start: voice.start, finish: voice.finish, cancel: voice.cancel
  });
  const heldVoice = useHeldVoiceInput({
    scope: voice.scope, root: voiceRoot, sendTarget: voiceSendTarget, canSend: canFinishVoiceSend,
    enabled: voice.supported && hydrated && !submitting, phase: voice.phase,
    shortcut: voice.preferences.shortcut, nativeShortcut: window.jokoDesktop?.capabilities.includes("voice.globalDictation") === true,
    isActive: voice.isActive, start: voice.start, finish: voice.finish, cancel: voice.cancel, onSend: finishVoiceAndSend,
    isSendKey: (event) => {
      if (palette !== undefined) return false;
      const intent = resolveComposerEnterIntent(event, controller.state.preferences.composerSendShortcut, { turnRunning: false, platform: currentComposerPlatform() });
      return intent === "queue" || intent === "steer";
    }
  });

  const closePalette = (restoreFocus = false): void => {
    typedPaletteTriggerRef.current = undefined;
    replaceInlineMentionActivation(undefined);
    replaceCommandActivation(undefined);
    setPalette(undefined);
    if (restoreFocus) requestAnimationFrame(() => richEditorRef.current?.focus());
  };

  const closeInlineMention = (restoreFocus = false, suppress = false): void => {
    const active = inlineMentionActivationRef.current;
    if (suppress && active?.source === "typed") suppressedInlineMentionFromRef.current = active.from;
    closePalette(restoreFocus);
  };

  useEffect(() => {
    if (!canMention && palette === "mention") {
      typedPaletteTriggerRef.current = undefined;
      replaceInlineMentionActivation(undefined);
      setPalette(undefined);
      return;
    }
    if (!mentionPolicy.directories && inlineMentionActivationRef.current !== undefined) {
      typedPaletteTriggerRef.current = undefined;
      replaceInlineMentionActivation(undefined);
      if (palette === "mention") setPalette(undefined);
    }
  }, [canMention, mentionPolicy.directories, palette]);

  const updateDocument = (nextDocument: JSONContent, isComposing = false, mapRanges?: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]): void => {
    const normalizedDocument = normalizeComposerDocument(nextDocument);
    const nextText = composerDocumentPlainText(normalizedDocument);
    // An update without its originating transaction has no occurrence authority.
    const nextRanges = mapRanges?.(inlineMentionRangesRef.current) ?? [];
    replaceMentions(composerMentionsFromRanges(mentionsRef.current, nextRanges), nextRanges);
    voiceDictionaryLearning.observe(nextText, isComposing);
    editorDocumentRef.current = normalizedDocument;
    setEditorDocument(normalizedDocument);
    textRef.current = nextText;
    setText(nextText);
    commandComposingRef.current = isComposing;
    const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const caret = composerCaretTextOffset(editor, editor?.ownerDocument.getSelection() ?? null) ?? nextText.length;
    const command = commandItems.length === 0
      ? undefined
      : detectComposerCommandActivation(nextText, caret, { isComposing, bashMode: false });
    if (command !== undefined) {
      typedPaletteTriggerRef.current = undefined;
      replaceInlineMentionActivation(undefined);
      suppressedInlineMentionFromRef.current = undefined;
      if (suppressedCommandFromRef.current === command.from) {
        replaceCommandActivation(undefined);
        if (palette === "commands") setPalette(undefined);
        return;
      }
      replaceCommandActivation(command);
      setCommandActiveIndex(0);
      setPalette("commands");
      return;
    }
    suppressedCommandFromRef.current = undefined;
    replaceCommandActivation(undefined);
    const mentionTrigger = mentionPolicy.directories && !isComposing
      ? detectComposerInlineMention(nextText, caret, nextRanges)
      : null;
    if (mentionTrigger !== null) {
      typedPaletteTriggerRef.current = "@";
      if (suppressedInlineMentionFromRef.current === mentionTrigger.from) {
        replaceInlineMentionActivation(undefined);
        if (palette === "mention") setPalette(undefined);
        return;
      }
      replaceInlineMentionActivation({ ...mentionTrigger, source: "typed" });
      setInlineMentionActiveIndex(0);
      setPalette("mention");
      return;
    }
    suppressedInlineMentionFromRef.current = undefined;
    replaceInlineMentionActivation(undefined);
    const typedPalette = resolveTypedComposerPalette(nextText, isComposing, false);
    if (typedPalette === "mention" && !canMention) {
      closePalette();
      return;
    }
    if (typedPalette === "mention") {
      typedPaletteTriggerRef.current = "@";
      setPalette("mention");
      return;
    }
    closePalette();
  };

  useEffect(() => {
    const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const ownerDocument = editor?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (editor === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const trackSelection = (): void => {
      const caret = composerCaretTextOffset(editor, ownerWindow.getSelection());
      if (caret === undefined || submitting) return;
      if (mentionPolicy.directories) {
        const activeMention = inlineMentionActivationRef.current;
        if (activeMention?.source === "button") return;
        const detectedMention = commandComposingRef.current
          ? null
          : detectComposerInlineMention(textRef.current, caret, inlineMentionRangesRef.current);
        if (detectedMention !== null) {
          replaceCommandActivation(undefined);
          suppressedCommandFromRef.current = undefined;
          if (suppressedInlineMentionFromRef.current === detectedMention.from) return;
          if (activeMention?.from === detectedMention.from
            && activeMention.to === detectedMention.to
            && activeMention.query === detectedMention.query
            && activeMention.quoted === detectedMention.quoted) return;
          typedPaletteTriggerRef.current = "@";
          replaceInlineMentionActivation({ ...detectedMention, source: "typed" });
          setInlineMentionActiveIndex(0);
          setPalette("mention");
          return;
        }
        suppressedInlineMentionFromRef.current = undefined;
        if (activeMention?.source === "typed") {
          replaceInlineMentionActivation(undefined);
          if (palette === "mention") setPalette(undefined);
        }
      }
      const command = commandItems.length === 0
        ? undefined
        : detectComposerCommandActivation(textRef.current, caret, {
            isComposing: commandComposingRef.current,
            bashMode: false
          });
      if (command === undefined) {
        suppressedCommandFromRef.current = undefined;
        if (commandActivationRef.current !== undefined) {
          replaceCommandActivation(undefined);
          if (palette === "commands") setPalette(undefined);
        }
        return;
      }
      if (suppressedCommandFromRef.current === command.from) return;
      const previous = commandActivationRef.current;
      if (previous?.from === command.from && previous.to === command.to && previous.query === command.query) return;
      typedPaletteTriggerRef.current = undefined;
      replaceCommandActivation(command);
      setCommandActiveIndex(0);
      setPalette("commands");
    };
    ownerDocument.addEventListener("selectionchange", trackSelection);
    return () => ownerDocument.removeEventListener("selectionchange", trackSelection);
  }, [commandItems.length, mentionPolicy.directories, palette, submitting]);

  const focusComposerAt = (offset: number): void => {
    requestAnimationFrame(() => {
      richEditorRef.current?.focus();
      const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
      setComposerCaretTextOffset(editor, editor?.ownerDocument.getSelection() ?? null, offset);
    });
  };

  const openInlineMentionPalette = (): void => {
    if (submitting || !mentionPolicy.directories) return;
    const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
    const selectedOffset = composerCaretTextOffset(editor, editor?.ownerDocument.getSelection() ?? null);
    const from = Math.min(Math.max(selectedOffset ?? textRef.current.length, 0), textRef.current.length);
    typedPaletteTriggerRef.current = undefined;
    suppressedInlineMentionFromRef.current = undefined;
    suppressedCommandFromRef.current = undefined;
    replaceCommandActivation(undefined);
    replaceInlineMentionActivation({ from, to: from, query: "", quoted: false, source: "button" });
    setInlineMentionActiveIndex(0);
    setPalette("mention");
  };

  const selectInlineMention = (item: ComposerMentionCatalogItem, reference = false): void => {
    if (submitting || !mentionPolicy.directories) return;
    const activation = inlineMentionActivationRef.current;
    const selectedItem = inlineMentionCatalogItems.find((candidate) => candidate.id === item.id);
    if (activation === undefined || selectedItem === undefined || selectedItem.disabled === true) return;
    const directoryToken = selectedItem.kind === "directory" && !reference
      ? composerDirectoryQueryToken(selectedItem.path)
      : undefined;
    const mention = selectedItem.mention;
    if (directoryToken === undefined) {
      if (mention === undefined || !newTaskMentionsAllowed([mention], mentionPolicy, workspace?.id)) return;
      if (mention.kind === "workspace"
        && (mention.workspaceId !== workspace?.id || (selectedItem.kind === "directory") !== (mention.directory === true))) return;
    }
    const existingSeparator = /\s/u.test(textRef.current[activation.to] ?? "");
    const replacement = directoryToken ?? `${mention!.token}${existingSeparator ? "" : " "}`;
    const nextDocument = replaceComposerDocumentTextRange(
      editorDocumentRef.current,
      activation.from,
      activation.to,
      replacement
    );
    if (nextDocument === undefined) return;
    voiceDictionaryLearning.clear();
    const nextText = composerDocumentPlainText(nextDocument);
    const mappedRanges = remapComposerInlineMentionReplacement(
      inlineMentionRangesRef.current,
      activation.from,
      activation.to,
      replacement.length
    );
    editorDocumentRef.current = nextDocument;
    setEditorDocument(nextDocument);
    textRef.current = nextText;
    setText(nextText);
    if (directoryToken !== undefined) {
      replaceMentions(composerMentionsFromRanges(mentionsRef.current, mappedRanges), mappedRanges);
      const caret = activation.from + directoryToken.length;
      const detected = detectComposerInlineMention(nextText, caret, mappedRanges);
      if (detected === null) {
        closePalette();
      } else {
        replaceInlineMentionActivation({ ...detected, source: activation.source });
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
    }].sort((left, right) => left.from - right.from || left.to - right.to);
    replaceMentions([
      ...composerMentionsFromRanges(mentionsRef.current, mappedRanges).filter((candidate) => candidate.id !== mention!.id),
      mention!
    ], nextRanges);
    const caret = activation.from + mention!.token.length + (existingSeparator ? 1 : 0);
    closePalette();
    focusComposerAt(Math.min(caret, nextText.length));
  };

  const insertPaletteItem = (item: ComposerPaletteItem): void => {
    if (submitting || item.mention !== undefined && !newTaskMentionsAllowed([item.mention], mentionPolicy, workspace?.id)) return;
    voiceDictionaryLearning.clear();
    const activeCommand = commandActivationRef.current;
    if (palette === "commands" && activeCommand !== undefined) {
      const next = replaceNewSessionCommandDocument(editorDocumentRef.current, activeCommand, item);
      if (next === undefined) return;
      const replacementLength = next.caret - activeCommand.from;
      const nextRanges = remapComposerInlineMentionReplacement(
        inlineMentionRangesRef.current,
        activeCommand.from,
        activeCommand.to,
        replacementLength
      );
      replaceMentions(composerMentionsFromRanges(mentionsRef.current, nextRanges), nextRanges);
      editorDocumentRef.current = next.document;
      setEditorDocument(next.document);
      textRef.current = next.text;
      setText(next.text);
      closePalette();
      requestAnimationFrame(() => {
        richEditorRef.current?.focus();
        const editor = composerRootRef.current?.querySelector<HTMLElement>(".composer-rich-editor__content") ?? null;
        setComposerCaretTextOffset(editor, editor?.ownerDocument.getSelection() ?? null, Math.min(next.caret, next.text.length));
      });
      return;
    }
    const typedTrigger = typedPaletteTriggerRef.current;
    const previousText = textRef.current;
    const next = insertNewSessionPaletteDocument(editorDocumentRef.current, typedTrigger, item);
    const previousRanges = typedTrigger !== undefined && previousText === typedTrigger ? [] : inlineMentionRangesRef.current;
    const retainedMentions = composerMentionsFromRanges(mentionsRef.current, previousRanges);
    if (item.mention !== undefined && item.mention.kind !== "message") {
      const mention = item.mention;
      const from = next.text.length - mention.token.length;
      const nextRanges = [...previousRanges, { mentionId: mention.id, from, to: next.text.length }];
      replaceMentions([...retainedMentions.filter((candidate) => candidate.id !== mention.id), mention], nextRanges);
    } else {
      replaceMentions(retainedMentions, previousRanges);
    }
    editorDocumentRef.current = next.document;
    setEditorDocument(next.document);
    textRef.current = next.text;
    setText(next.text);
    closePalette(true);
  };

  const visibleCommandItems = filterComposerPaletteItems(commandItems, commandActivation?.query ?? "");
  const selectedCommandIndex = visibleCommandItems.length === 0
    ? 0
    : Math.min(commandActiveIndex, visibleCommandItems.length - 1);
  useEffect(() => {
    if (visibleCommandItems.length === 0) {
      if (commandActiveIndex !== 0) setCommandActiveIndex(0);
    } else if (commandActiveIndex >= visibleCommandItems.length) {
      setCommandActiveIndex(visibleCommandItems.length - 1);
    }
  }, [commandActiveIndex, visibleCommandItems.length]);

  const captureInlineMentionKey = (event: KeyboardEvent): boolean => {
    if (palette !== "mention" || inlineMentionActivationRef.current === undefined || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return false;
    const intent = resolveComposerInlineMentionKey(event.key, inlineMentionActiveIndex, inlineMentionResults.items);
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
    const selectedItem = inlineMentionResults.items[intent.index];
    if (selectedItem !== undefined && selectedItem.disabled !== true) selectInlineMention(selectedItem);
    return true;
  };

  const captureTypedCommandKey = (event: KeyboardEvent): boolean => {
    const active = commandActivationRef.current;
    if (palette !== "commands" || active === undefined || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return false;
    if (visibleCommandItems.length === 0 && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      return true;
    }
    const intent = resolveComposerPaletteKey(event.key, selectedCommandIndex, visibleCommandItems.length);
    if (intent === null) return false;
    event.preventDefault();
    if (intent.kind === "close") {
      suppressedCommandFromRef.current = active.from;
      closePalette(true);
      return true;
    }
    if (intent.kind === "move") {
      setCommandActiveIndex(intent.index);
      return true;
    }
    const selectedItem = visibleCommandItems[intent.index];
    if (selectedItem !== undefined) insertPaletteItem(selectedItem);
    return true;
  };

  useEffect(() => {
    if (commandItems.length > 0 || commandActivationRef.current === undefined) return;
    replaceCommandActivation(undefined);
    if (palette === "commands") setPalette(undefined);
  }, [commandItems.length, palette]);

  const addFiles = (files: FileList | readonly File[]): void => {
    if (submitting) return;
    setAttachmentError(undefined);
    const list = [...files];
    const maximumItems = attachmentPolicy.maximumItems;
    const maximumBytes = attachmentPolicy.maximumBytes;
    const available = maximumItems === undefined ? list.length : Math.max(0, maximumItems - attachments.length - browserComments.length);
    const next: AttachmentDraft[] = [];
    for (const file of list.slice(0, available)) {
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
    if (maximumItems !== undefined && list.length > available) setAttachmentError(t("composer.attachmentCount", { count: maximumItems }));
    if (next.length > 0) setAttachments((current) => [...current, ...next]);
  };

  const consumeInternalDrop = (dataTransfer: DataTransfer): boolean => {
    if (!hasComposerInternalDrop(dataTransfer)) return false;
    if (submitting) return true;
    const insertion = resolveComposerInternalDrop(dataTransfer, workspace?.id);
    if (insertion !== undefined) richEditorRef.current?.insertRouteReference(insertion);
    return true;
  };

  const updateWorktreeEnabled = (enabled: boolean): void => {
    if (worktreePreferenceSavingRef.current || submittingRef.current) return;
    const previous = worktreeEnabled;
    worktreePreferenceSavingRef.current = true;
    setWorktreePreferenceSaving(true);
    setDraftError(undefined);
    setWorktreeEnabled(enabled);
    void controllerRef.current.setNewSessionWorktreeEnabled(enabled).then(() => {
      if (mountedRef.current) {
        worktreePreferenceSavingRef.current = false;
        setWorktreePreferenceSaving(false);
      }
    }).catch((error: unknown) => {
      if (mountedRef.current) {
        worktreePreferenceSavingRef.current = false;
        setWorktreePreferenceSaving(false);
        setWorktreeEnabled(previous);
        setDraftError(messageOf(error));
      }
    });
  };

  const submit = async (activeDocument: JSONContent = editorDocumentRef.current): Promise<void> => {
    const sourceEditorDocument = normalizeComposerDocument(activeDocument, textRef.current);
    const sourceText = composerDocumentPlainText(sourceEditorDocument);
    const sourceRanges = restoreComposerInlineMentionRanges(sourceText, mentionsRef.current, inlineMentionRangesRef.current);
    const sourceMentions = composerMentionsFromRanges(mentionsRef.current, sourceRanges);
    const sourceBrowserComments = browserCommentsRef.current;
    const activeCanSend = validContext
      && modelRouteReady
      && (!composerDocumentIsEmpty(sourceEditorDocument) || attachments.length > 0 || sourceBrowserComments.length > 0)
      && attachmentsAllowed
      && newTaskMentionsAllowed(sourceMentions, mentionPolicy, workspace?.id)
      && worktreeDecisionReady
      && !(worktreePreferenceRelevant && worktreePreferenceSavingRef.current)
      && fullAccessConfirmationRef.current === undefined
      && !submitting && !voice.isActive();
    if (!activeCanSend || selection === undefined || submissionRef.current) return;
    voiceDictionaryLearning.clear();
    const sourceScope = submissionScope;
    const sourceEpoch = submissionEpochRef.current;
    const ownerDocument = voiceRoot?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined || sourceEpoch === undefined) return;
    const sourceDraft = editorDocumentRef.current;
    const sourceAttachments = attachmentsRef.current;
    const attempt = {}; submissionRef.current = attempt;
    const request = new AbortController(); submissionAbortRef.current = request;
    const owner: NewSessionSubmissionOwner = {
      ownerDocument,
      signal: request.signal,
      isCurrent: () => submissionScopeRef.current === sourceScope && submissionEpochRef.current === sourceEpoch && submissionRef.current === attempt
        && !request.signal.aborted && submissionValidityRef.current && voiceRoot?.isConnected === true && voiceRoot.ownerDocument === ownerDocument && !ownerWindow.closed
        && editorDocumentRef.current === sourceDraft && attachmentsRef.current === sourceAttachments && browserCommentsRef.current === sourceBrowserComments
        && newTaskMentionsAllowed(sourceMentions, mentionPolicyRef.current, workspaceIdRef.current)
    };
    submissionOriginRef.current = owner;
    submittingRef.current = true;
    setSubmitting(true);
    const allowedPermissions = execution.permissionModes;
    const resolvedPermission = allowedPermissions.includes(permissionMode) ? permissionMode : allowedPermissions[0] ?? "ask";
    const worktree = effectiveWorktreeEnabled
      ? {
          ...(worktreeSourceRef === undefined ? {} : { sourceRef: worktreeSourceRef }),
          refreshRemote: refreshWorktreeRemote && currentWorktreeProbe?.canRefreshRemote === true
        }
      : undefined;
    try {
      await draftSaveChainRef.current;
      if (!owner.isCurrent()) return;
      await onSubmit({
        selection,
        name: t("session.newName"),
        nativeStart: selected !== undefined && startKind === "attach" && nativeSelectionReady
          ? { kind: "attach", reference: selectedNativeSession!.reference }
          : { kind: "fresh" },
        providerId: selectedModel?.providerId ?? "",
        modelId: selectedModel?.modelId ?? "",
        ...(execution.effortSelectable && effort.length > 0 ? { effort } : {}),
        fastMode: execution.fastModeSelectable && fastMode,
        permissionMode: resolvedPermission,
        planMode: execution.planModeSupported && planMode,
        ...(worktree === undefined ? {} : { worktree })
      }, {
        text: sourceText,
        editorDocument: sourceEditorDocument,
        attachments: sourceAttachments,
        browserComments: sourceBrowserComments,
        mentions: sourceMentions,
        inlineMentionRanges: sourceRanges,
        deliveryMode: "prompt",
        ...(canSelectExtraDirectories ? { extraDirectoryIds } : {})
      }, owner);
    } catch {
      // App owns the operation banner; the persistent draft intentionally remains.
    } finally {
      if (submissionRef.current === attempt) {
        submissionRef.current = undefined;
        submissionOriginRef.current = undefined; submissionAbortRef.current = undefined; request.abort();
        if (mountedRef.current) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    }
  };

  submitRef.current = submit;

  const handleEditorKeyDown = (event: KeyboardEvent, activeDocument: JSONContent): boolean => {
    if (captureInlineMentionKey(event)) return true;
    if (captureTypedCommandKey(event)) return true;
    const intent = resolveComposerEnterIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      repeat: event.repeat,
      isComposing: event.isComposing
    }, controller.state.preferences.composerSendShortcut, { turnRunning: false, platform: currentComposerPlatform() });
    if (intent === null || intent === "native") return false;
    event.preventDefault();
    if (intent !== "ignore") void submit(activeDocument);
    return true;
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files !== null) addFiles(event.target.files);
    event.target.value = "";
  };

  const preventDrag = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const selectPermissionMode = (mode: PermissionMode): void => {
    if (submitting || !execution.permissionModes.includes(mode)) return;
    if (mode !== "bypassPermissions" || permissionMode === "bypassPermissions") {
      retireFullAccessConfirmation();
      setPermissionMode(mode);
      return;
    }
    const ownerDocument = voiceRoot?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!hydrated || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined || ownerWindow.closed) return;
    const confirmation: FullAccessConfirmation = { scope: fullAccessConfirmationScope, ownerDocument };
    fullAccessConfirmationRef.current = confirmation;
    setFullAccessConfirmation(confirmation);
  };

  const confirmFullAccess = (confirmation: FullAccessConfirmation): void => {
    const ownerDocument = voiceRoot?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const current = fullAccessConfirmationRef.current;
    if (current !== confirmation
      || confirmation.scope !== fullAccessConfirmationScopeRef.current
      || confirmation.ownerDocument !== ownerDocument
      || ownerWindow === null
      || ownerWindow === undefined
      || ownerWindow.closed
      || submitting
      || !execution.permissionModes.includes("bypassPermissions")) {
      retireFullAccessConfirmation(confirmation);
      return;
    }
    retireFullAccessConfirmation(confirmation);
    setPermissionMode("bypassPermissions");
  };

  const paletteInAddMenu = palette !== undefined
    && typedPaletteTriggerRef.current === undefined
    && commandActivation === undefined;
  const activeFullAccessConfirmation = fullAccessConfirmation?.scope === fullAccessConfirmationScope
    ? fullAccessConfirmation
    : undefined;

  return <main className="new-task-page">
    <header className="new-task-page__header">
      {!navigationOpen && <IconButton label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      <div className="new-task-context" aria-label={t("session.newDescription")}>
        <label className="new-task-context__control new-task-context__control--target">
          <FolderKanban aria-hidden="true" />
          <span className="sr-only">{t("newTask.location")}</span>
          <SelectControl value={selectionKey} disabled={submitting || (activeTargets.length === 0 && eligibleDialogueBackends.length === 0)} onChange={(event) => {
            const next = parseNewSessionSelection(event.target.value, activeTargets, eligibleDialogueBackends);
            if (next !== undefined) setSelection(next);
          }}>
            {activeTargets.length === 0 && eligibleDialogueBackends.length === 0 && <option value="">{t("session.noProjects")}</option>}
            {activeTargets.length > 0 && <optgroup label={t("nav.projects")}>{activeTargets.map((target) => <option value={newSessionSelectionValue({ kind: "target", targetId: target.id })} key={target.id}>{target.name} · {target.workspaceName}</option>)}</optgroup>}
            {eligibleDialogueBackends.length > 0 && <optgroup label={t("newTask.dialogues")}>{eligibleDialogueBackends.map((candidate) => <option value={newSessionSelectionValue({ kind: "dialogue", backendId: candidate.id })} key={`dialogue:${candidate.id}`}>{t("newTask.dialogue")} · {candidate.name}</option>)}</optgroup>}
          </SelectControl>
        </label>
        {canDiscover && <label className="new-task-context__control new-task-context__control--native">
          <span className="sr-only">{t("session.startMode")}</span>
          <SelectControl value={startKind} disabled={submitting} onChange={(event) => { const next = event.target.value as "fresh" | "attach"; setStartKind(next); setNativeSelectionWarning(undefined); if (next === "fresh") setNativeReference(""); }}>
            <option value="fresh">{t("session.startFresh")}</option>
            <option value="attach" disabled={!canAttach}>{t("session.startAttach")}</option>
          </SelectControl>
        </label>}
      </div>
      <IconButton label={t("common.close")} disabled={submitting} onClick={onClose}><X aria-hidden="true" /></IconButton>
    </header>

    <div className="new-task-page__scroll">
      <section className="new-task-page__content" aria-labelledby="new-task-title">
        <div className="new-task-brand">
          <span className="brand-mark brand-mark--avatar" aria-hidden="true" />
          <div><strong>{t("app.name")}</strong><h1 id="new-task-title">{t("nav.newTask")}</h1></div>
        </div>

        {selected !== undefined && !selected.trusted && <div className="new-task-warning" role="status"><AlertTriangle aria-hidden="true" /><span>{t("session.projectInert")}</span></div>}
        {draftError !== undefined && <div className="new-task-warning" role="alert"><AlertTriangle aria-hidden="true" /><span>{draftError}</span></div>}
        {showWorktreeControls && <section className="new-task-worktree" aria-labelledby="new-task-worktree-title">
          <header>
            <span><GitBranch aria-hidden="true" /><strong id="new-task-worktree-title">{t("worktree.title")}</strong></span>
            <label className="new-task-worktree__toggle">
              <CheckboxControl
                checked={worktreeEnabled}
                disabled={submitting || worktreePreferenceSaving || (!worktreeEligible && !worktreeEnabled)}
                onChange={(event) => updateWorktreeEnabled(event.target.checked)}
              />
              <span>{t("worktree.enable")}</span>
            </label>
          </header>
          {worktreeLoading && <p className="muted" role="status">{t("worktree.checking")}</p>}
          {worktreeError !== undefined && <div className="new-task-worktree__recovery" role={worktreeEnabled ? "alert" : "status"}><p className={worktreeEnabled ? "inline-error" : "muted"}>{worktreeError}</p><button type="button" disabled={submitting || worktreeLoading} onClick={() => setWorktreeProbeRevision((value) => value + 1)}>{t("worktree.retry")}</button></div>}
          {!worktreeLoading && worktreeError === undefined && currentWorktreeProbe !== undefined && currentWorktreeProbe.eligibility !== "eligible" && (worktreeProbeNeedsRetry
            ? <div className="new-task-worktree__recovery" role={worktreeEnabled ? "alert" : "status"}><p className={worktreeEnabled ? "inline-error" : "muted"}>{t(worktreeEligibilityMessage(currentWorktreeProbe.eligibility))}</p><button type="button" disabled={submitting} onClick={() => setWorktreeProbeRevision((value) => value + 1)}>{t("worktree.retry")}</button></div>
            : <p className="muted">{t(worktreeEligibilityMessage(currentWorktreeProbe.eligibility))}</p>)}
          {worktreeEligible && <div className="new-task-worktree__options">
            <label>
              <span>{t("worktree.source")}</span>
              <SelectControl value={worktreeSourceRef ?? ""} disabled={submitting || worktreeSources.length === 0} onChange={(event) => setWorktreeSourceRef(event.target.value || undefined)}>
                {worktreeSources.length === 0 && <option value="">{worktreeProbe?.currentBranch ?? t("worktree.defaultSource")}</option>}
                {worktreeSources.map((source) => <option value={source.ref} key={`${source.ref}\u0000${source.commit}`}>{source.name}{source.current ? ` · ${t("worktree.current")}` : ""}</option>)}
              </SelectControl>
            </label>
            {currentWorktreeProbe?.canRefreshRemote && <label className="new-task-worktree__refresh"><CheckboxControl checked={refreshWorktreeRemote} disabled={submitting} onChange={(event) => setRefreshWorktreeRemote(event.target.checked)} /><span>{t("worktree.refreshRemote")}</span></label>}
          </div>}
        </section>}
        {startKind === "attach" && selected !== undefined && <section className="native-session-picker new-task-native" aria-label={t("session.nativeSessions")}>
          {nativeLoading && <p className="muted">{t("common.loading")}</p>}
          {nativeError !== undefined && <div className="new-task-native__recovery" role="alert"><p className="inline-error">{nativeError}</p><button type="button" disabled={submitting || nativeLoading} onClick={() => setNativeDiscoveryRevision((value) => value + 1)}>{t("session.nativeRetry")}</button></div>}
          {nativeSelectionWarning !== undefined && <div className="new-task-native__recovery" role="alert"><p className="inline-error">{nativeSelectionWarning}</p><button type="button" disabled={submitting || nativeLoading} onClick={() => setNativeDiscoveryRevision((value) => value + 1)}>{t("session.nativeRetry")}</button></div>}
          {!nativeLoading && nativeError === undefined && nativeSessions.length === 0 && <p className="muted">{t("session.noNativeSessions")}</p>}
          {nativeSessions.map((candidate) => {
            const disabled = !canAttach || candidate.state === "error" || candidate.boundSessionId !== undefined;
            return <label className={nativeReference === candidate.reference ? "is-active" : ""} key={candidate.id}>
              <RadioControl name="new-task-native-session" value={candidate.reference} checked={nativeReference === candidate.reference} disabled={submitting || disabled} onChange={() => { setNativeReference(candidate.reference); setNativeSelectionWarning(undefined); }} />
              <span><strong>{candidate.name || candidate.id}</strong><small>{t("session.nativeMeta", { count: candidate.messageCount, time: candidate.modifiedAt > 0 ? formatRelativeTime(candidate.modifiedAt, controller.state.preferences.locale) : t("common.unknown") })}</small><small>{candidate.workspaceRoot}</small>{candidate.boundSessionId !== undefined && <em>{t("session.nativeBound", { id: candidate.boundSessionId })}</em>}{candidate.state === "error" && <em>{t("session.nativeError")}</em>}</span>
            </label>;
          })}
        </section>}

        <div className="new-task-composer-wrap">
          {submitting && effectiveWorktreeEnabled && <div className="new-task-worktree__creating" role="status" aria-live="polite" aria-atomic="true"><GitBranch aria-hidden="true" /><span><strong>{t("worktree.creating")}</strong><small>{t("worktree.creatingDescription")}</small></span></div>}
          <div
            ref={bindComposer}
            className={cx("composer new-task-composer", dragging && "is-dragging")}
            aria-busy={submitting}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              const editorDom = event.currentTarget.querySelector("[data-composer-editor='true']");
              if (!isComposerBlankPointerTarget(event.target, event.currentTarget, editorDom, event)) return;
              event.preventDefault();
              richEditorRef.current?.focusFromBlankSurface();
            }}
            onDragEnter={(event) => { preventDrag(event); setDragging(true); }}
            onDragOver={preventDrag}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(event) => {
              preventDrag(event);
              setDragging(false);
              if (consumeInternalDrop(event.dataTransfer)) return;
              if (!submitting) addFiles(event.dataTransfer.files);
            }}
          >
            {dragging && <div className="composer__drop"><Paperclip aria-hidden="true" /><span>{t("composer.drop")}</span></div>}
            {browserComments.length > 0 && (
              <details className="browser-comment-chip">
                <summary><MessageSquarePlus aria-hidden="true" /><span>{t("composer.browserComments", { count: browserComments.length })}</span><small>{t("composer.browserCommentsPreview")}</small></summary>
                <div className="browser-comment-chip__preview">
                  {browserComments.map((item) => (
                    <article key={item.id}>
                      {item.screenshot.previewUrl === undefined ? <ImageIcon aria-hidden="true" /> : <img src={item.screenshot.previewUrl} alt="" />}
                      <span><strong><b>{item.markerNumber}</b>{browserCommentPreviewTag(item)}</strong><small title={item.pageUrl}>{browserCommentPageLabel(item.pageUrl)}</small><p>{item.comment || t("composer.browserCommentNoText")}</p></span>
                      <IconButton label={t("composer.removeBrowserComment", { number: item.markerNumber })} disabled={submitting} onClick={() => {
                        if (submitting) return;
                        revokeAttachments([item.screenshot]);
                        replaceBrowserComments(removeBrowserCommentAndRepairChains(browserCommentsRef.current, item.id));
                      }}><X aria-hidden="true" /></IconButton>
                    </article>
                  ))}
                  <Button tone="ghost" disabled={submitting} onClick={() => {
                    if (submitting) return;
                    revokeBrowserCommentPreviews(browserCommentsRef.current);
                    replaceBrowserComments([]);
                  }}>{t("composer.clearBrowserComments")}</Button>
                </div>
              </details>
            )}
            {attachments.length > 0 && <ComposerAttachmentTray
              ownerKey={voiceOwnerKey}
              attachments={attachments}
              removeDisabled={submitting}
              t={t}
              onRemove={(attachment) => {
                if (submitting) return;
                if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
                setAttachments((current) => current.filter((item) => item.id !== attachment.id));
              }}
            />}
            {attachmentError !== undefined && <p className="composer__error" role="alert"><AlertTriangle aria-hidden="true" />{attachmentError}</p>}
            <ComposerRichTextEditor
              ref={richEditorRef}
              document={editorDocument}
              editable={!submitting && !voice.active}
              disabled={false}
              placeholder={t("composer.placeholder")}
              onDocumentChange={updateDocument}
              onKeyDown={handleEditorKeyDown}
              onClipboardFiles={addFiles}
              pastedTextLabel={(lines) => t("composer.pastedTextChip", { lines })}
              onPastedTextOpen={setPastedTextTarget}
              workingDirectory={workspace?.serverPath}
              knownWorkspacePaths={knownWorkspacePaths}
              resolveRouteReference={(target) => resolveComposerRouteReferenceFromRuntime(controller, target, t("session.unnamed"))}
            />
            {voice.draftError !== undefined && <p className="composer__error" role="alert">{voice.draftError}</p>}
            <ModelSourceNotice key={JSON.stringify([profileScope, selectionKey, modelKey])} controller={controller} backend={backend} selection={modelSelection} model={selectedModel} t={t} />
            {voice.update !== undefined && voice.update.state !== "done" && voice.update.state !== "cancelled" && voice.update.state !== "idle" && <VoiceInputOverlay
              state={voice.phase ?? voice.update.state}
              transcript={voice.update.session?.result?.text ?? voice.update.session?.draft?.text ?? ""}
              error={voice.error}
              stallWarning={voice.update.session?.stallWarning === true}
              canUseTranscript={voice.update.session?.result !== undefined && (voice.update.session.failure?.transcriptKept === true || voice.update.session.result.salvaged)}
              onStop={() => { void voice.finish(); }}
              onCancel={voice.cancel}
              onRetry={voice.start}
              onUseTranscript={voice.useTranscript}
              t={t}
            />}
            <div className="composer__toolbar new-task-composer__toolbar">
              <div className="composer__tools">
                <input ref={fileInputRef} className="sr-only" type="file" multiple disabled={submitting} accept={attachmentPolicy.images && !attachmentPolicy.files ? "image/*" : undefined} onChange={handleFiles} />
                {canUseAddMenu && <div className="palette-anchor">
                  <ComposerAddMenu
                    open={paletteInAddMenu}
                    onOpenChange={(next) => {
                      if (next) {
                        typedPaletteTriggerRef.current = undefined;
                        suppressedCommandFromRef.current = undefined;
                        replaceCommandActivation(undefined);
                        setPalette("add");
                      } else if (paletteInAddMenu) {
                        closePalette(false);
                      }
                    }}
                    label={t("common.add")}
                    panelLabel={palette === "mention" ? t("composer.mention") : palette === "commands" ? t("composer.commands") : t("common.add")}
                    closeLabel={t("common.close")}
                    disabled={submitting}
                    disabledReason={submitting ? t("common.working") : undefined}
                    count={extraDirectoryIds.length}
                  >
                    {palette === "add" && <><div className="composer-add-menu__actions" role="menu">
                      {(attachmentPolicy.images || attachmentPolicy.files) && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { closePalette(); fileInputRef.current?.click(); }}><Paperclip aria-hidden="true" /><span><strong>{t("composer.attach")}</strong><small>{t("composer.attachments")}</small></span></button>}
                      {canMention && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => {
                        if (mentionPolicy.directories) {
                          openInlineMentionPalette();
                          return;
                        }
                        typedPaletteTriggerRef.current = undefined;
                        suppressedCommandFromRef.current = undefined;
                        replaceCommandActivation(undefined);
                        setPalette("mention");
                      }}><AtSign aria-hidden="true" /><span><strong>{t("composer.mention")}</strong><small>{t("composer.mentionCount", { count: mentionItemCount })}</small></span></button>}
                      {commandItems.length > 0 && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { typedPaletteTriggerRef.current = undefined; suppressedCommandFromRef.current = undefined; replaceCommandActivation(undefined); setPalette("commands"); }}><Sparkles aria-hidden="true" /><span><strong>{t("composer.commands")}</strong><small>{commandItems.length}</small></span></button>}
                    </div>
                    {canSelectExtraDirectories && selectableExtraDirectories.length > 0 && <fieldset className="composer-add-menu__directories">
                      <legend>{t("composer.extraDirectories")}</legend>
                      {selectableExtraDirectories.map((directory) => <label key={directory.id}><CheckboxControl disabled={submitting} checked={extraDirectoryIds.includes(directory.id)} onChange={(event) => setExtraDirectoryIds((current) => event.target.checked ? [...new Set([...current, directory.id])] : current.filter((id) => id !== directory.id))} /><span><strong>{directory.serverPath}</strong><small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")}</small></span></label>)}
                      <button className="composer-add-menu__directory-reset" type="button" disabled={submitting || extraDirectoryIds.length === 0} onClick={() => setExtraDirectoryIds([])}>{t("common.none")}</button>
                    </fieldset>}</>}
                    {palette === "mention" && mentionPolicy.directories && inlineMentionActivation !== undefined && paletteInAddMenu && <ComposerInlineMentionPanel
                      embedded
                      title={t("composer.mention")}
                      query={inlineMentionActivation.query}
                      state={inlineMentionProviderState}
                      results={inlineMentionResults}
                      activeIndex={inlineMentionActiveIndex}
                      labels={{ close: t("common.close"), loading: t("common.loading"), empty: t("composer.noMentions"), more: t("common.more"), retry: t("common.retry") }}
                      onActiveIndexChange={setInlineMentionActiveIndex}
                      onSelect={selectInlineMention}
                      onReference={(item) => selectInlineMention(item, true)}
                      referenceOptions={{
                        directory: true,
                        lineRange: mentionPolicy.lineRanges,
                        directoryLabel: t("composer.referenceDirectory"),
                        startLineLabel: t("composer.referenceStartLine"),
                        endLineLabel: t("composer.referenceEndLine"),
                        lineRangeLabel: t("composer.referenceLines")
                      }}
                      onClose={() => closeInlineMention(true, true)}
                      onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
                    />}
                    {palette === "mention" && !mentionPolicy.directories && paletteInAddMenu && <NewTaskPalette
                      embedded
                      title={t("composer.mention")}
                      items={mentionItems}
                      empty={t("composer.noMentions")}
                      loading={matchingWorkspaceMentionIndex?.status === "loading"}
                      error={matchingWorkspaceMentionIndex?.status === "error" ? matchingWorkspaceMentionIndex.error : undefined}
                      truncated={matchingWorkspaceMentionIndex?.truncated === true}
                      t={t}
                      onSelect={insertPaletteItem}
                      onClose={() => closePalette(true)}
                      onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
                    />}
                    {palette === "commands" && paletteInAddMenu && <NewTaskPalette embedded title={t("composer.commands")} items={commandItems} empty={t("composer.noCommands")} t={t} onSelect={insertPaletteItem} onClose={() => closePalette(true)} />}
                  </ComposerAddMenu>
                  {palette === "mention" && mentionPolicy.directories && inlineMentionActivation !== undefined && !paletteInAddMenu && <ComposerInlineMentionPanel
                    title={t("composer.mention")}
                    query={inlineMentionActivation.query}
                    state={inlineMentionProviderState}
                    results={inlineMentionResults}
                    activeIndex={inlineMentionActiveIndex}
                    labels={{ close: t("common.close"), loading: t("common.loading"), empty: t("composer.noMentions"), more: t("common.more"), retry: t("common.retry") }}
                    onActiveIndexChange={setInlineMentionActiveIndex}
                    onSelect={selectInlineMention}
                    onReference={(item) => selectInlineMention(item, true)}
                    referenceOptions={{
                      directory: true,
                      lineRange: mentionPolicy.lineRanges,
                      directoryLabel: t("composer.referenceDirectory"),
                      startLineLabel: t("composer.referenceStartLine"),
                      endLineLabel: t("composer.referenceEndLine"),
                      lineRangeLabel: t("composer.referenceLines")
                    }}
                    onClose={() => closeInlineMention(true, true)}
                    onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
                  />}
                  {palette === "mention" && !mentionPolicy.directories && !paletteInAddMenu && <NewTaskPalette
                  title={t("composer.mention")}
                  items={mentionItems}
                  empty={t("composer.noMentions")}
                  loading={matchingWorkspaceMentionIndex?.status === "loading"}
                  error={matchingWorkspaceMentionIndex?.status === "error" ? matchingWorkspaceMentionIndex.error : undefined}
                  truncated={matchingWorkspaceMentionIndex?.truncated === true}
                  t={t}
                  onSelect={insertPaletteItem}
                  onClose={() => closePalette(true)}
                  onRetry={() => setWorkspaceMentionReload((current) => current + 1)}
                />}
                  {palette === "commands" && !paletteInAddMenu && <NewTaskPalette
                    title={t("composer.commands")}
                    items={commandItems}
                    empty={t("composer.noCommands")}
                    typedQuery={commandActivation?.query}
                    controlledActiveIndex={selectedCommandIndex}
                    onControlledActiveIndexChange={setCommandActiveIndex}
                    t={t}
                    onSelect={insertPaletteItem}
                    onClose={() => {
                      const active = commandActivationRef.current;
                      if (active !== undefined) suppressedCommandFromRef.current = active.from;
                      closePalette(true);
                    }}
                  />}
                </div>}
              </div>
              <div className="new-task-composer__controls">
                {voice.supported && <VoiceInputButton phase={voice.phase} held={heldVoice.held} sendTargetActive={heldVoice.sendTargetActive} startedAt={voice.startedAt} ownerWindow={voice.ownerWindow} enabled={hydrated && !submitting} buttonProps={heldVoice.buttonProps} t={t} />}
                {execution.modelSwitchSupported && <ModelPicker
                  className="new-task-composer__select--model"
                  models={snapshot.models.filter((model) => model.backendId === backend?.id)}
                  ownerId={pickerOwnerId}
                  value={modelSelection === undefined ? undefined : {
                    ...modelSelection,
                    ...(effort.length === 0 ? {} : { effort }),
                    fastMode
                  }}
                  allowDefault
                  defaultLabel={t("settings.backendNativeDefault")}
                  seedDefault={pickerDefaultSelection}
                  disabled={submitting}
                  disabledReason={submitting ? t("common.working") : undefined}
                  useMorphPopover
                  onSelectionFocus={() => richEditorRef.current?.focus("end")}
                  effortEnabled={execution.effortSupported}
                  fastEnabled={execution.fastModeSupported}
                  t={t}
                  onOpen={() => backend === undefined ? undefined : controller.refreshProviderModels(backend.id, undefined, true).catch(() => undefined)}
                  onConnectSource={() => { window.location.hash = "#/settings/providers"; }}
                  onSelect={(selection) => {
                    if (selection === undefined) {
                      setModelKey("");
                      setEffort("");
                      setFastMode(false);
                      return;
                    }
                    const nextModel = execution.availableModels.find((model) =>
                      model.providerId === selection.providerId && model.modelId === selection.modelId);
                    if (nextModel === undefined || !nextModel.available) return;
                    setModelKey(modelKeyFor(nextModel.providerId, nextModel.modelId));
                    setEffort(selection.effort !== undefined && nextModel.efforts.includes(selection.effort)
                      ? selection.effort
                      : nextModel.efforts[0] ?? "");
                    setFastMode(execution.fastModeSupported && nextModel.supportsFast && selection.fastMode);
                  }}
                />}
                {execution.permissionSelectable ? <PermissionSelector value={permissionMode} modes={execution.permissionModes} disabled={submitting} disabledReason={submitting ? t("common.working") : undefined} onChange={selectPermissionMode} t={t} /> : <Pill tone="neutral"><Shield aria-hidden="true" />{permissionLabel(execution.permissionModes[0] ?? "ask", t)}</Pill>}
                {execution.planModeSupported && <button className={cx("new-task-composer__toggle", planMode && "is-active")} type="button" disabled={submitting} aria-pressed={planMode} onClick={() => setPlanMode((value) => !value)}><Sparkles aria-hidden="true" />{t("controls.plan")}</button>}
              </div>
              <IconButton buttonRef={bindVoiceSend} className={cx("send-button", heldVoice.sendTargetActive && "is-voice-target")} tooltipOpen={heldVoice.sendTargetActive ? true : undefined} label={voice.active ? t(heldVoice.sendTargetActive ? "voice.releaseToSend" : "voice.finishAndSend") : t("composer.send")} disabled={voice.active ? !canFinishVoiceSend : !canSend} disabledReason={!canSend ? submitting ? t("common.working") : !hasInput ? t("composer.placeholder") : t("composer.inputUnavailable") : undefined} onClick={() => { if (voice.isActive()) finishVoiceAndSend(); else void submit(); }}><Send aria-hidden="true" /></IconButton>
            </div>
          </div>
          <div className="new-task-composer__meta"><span>{selection?.kind === "dialogue" ? t("newTask.dialogue") : selected?.workspaceName ?? t("session.noProjects")}</span><span>{backend?.name ?? ""}</span></div>
        </div>

        <section className="new-task-quick" aria-labelledby="new-task-quick-title">
          <h2 id="new-task-quick-title">{t("newTask.quickStart")}</h2>
          <div className="new-task-quick__grid">
            {QUICK_STARTS.map(({ key, label, icon: Icon }) => <button type="button" key={key} disabled={submitting} onClick={() => {
              voiceDictionaryLearning.clear();
              const nextDocument = plainTextToComposerDocument(t(label));
              const nextText = composerDocumentPlainText(nextDocument);
              editorDocumentRef.current = nextDocument;
              setEditorDocument(nextDocument);
              textRef.current = nextText;
              setText(nextText);
              replaceMentions([], []);
              closePalette();
              requestAnimationFrame(() => richEditorRef.current?.focus());
            }}><span><Icon aria-hidden="true" /></span><strong>{t(label)}</strong></button>)}
          </div>
        </section>
        <HomeUsageDashboard controller={controller} ownerId={pickerOwnerId} locale={controller.state.preferences.locale} t={t} />
      </section>
    </div>
    <Modal
      open={activeFullAccessConfirmation !== undefined}
      ownerDocument={activeFullAccessConfirmation?.ownerDocument}
      title={t("permission.full")}
      description={t("permission.fullHelp")}
      dialogRole="alertdialog"
      size="small"
      onClose={() => {
        if (activeFullAccessConfirmation !== undefined) retireFullAccessConfirmation(activeFullAccessConfirmation);
      }}
    >
      <div className="risk-confirmation">
        <div className="risk-confirmation__icon"><Shield aria-hidden="true" /></div>
        <p>{t("permission.fullHelp")}</p>
        <div className="modal__actions">
          <Button onClick={() => {
            if (activeFullAccessConfirmation !== undefined) retireFullAccessConfirmation(activeFullAccessConfirmation);
          }}>{t("common.cancel")}</Button>
          <Button tone="danger" onClick={() => {
            if (activeFullAccessConfirmation !== undefined) confirmFullAccess(activeFullAccessConfirmation);
          }}>{t("common.enable")} {t("permission.full")}</Button>
        </div>
      </div>
    </Modal>
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
  </main>;
}

function newTaskMentionsAllowed(
  mentions: readonly ComposerMentionDraft[],
  policy: ReturnType<typeof resolveComposerMentionPolicy>,
  workspaceId: string | undefined
): boolean {
  return composerMentionsAllowed(mentions, policy, []) && mentions.every((mention) =>
    mention.kind !== "workspace" || workspaceId !== undefined && mention.workspaceId === workspaceId);
}

function NewTaskPalette({ title, items, empty, loading = false, error, truncated = false, typedQuery, controlledActiveIndex, onControlledActiveIndexChange, t, onSelect, onClose, onRetry, embedded = false }: {
  readonly title: string;
  readonly items: readonly ComposerPaletteItem[];
  readonly empty: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly truncated?: boolean;
  readonly typedQuery?: string;
  readonly controlledActiveIndex?: number;
  readonly onControlledActiveIndexChange?: (index: number) => void;
  readonly t: Translator;
  readonly onSelect: (item: ComposerPaletteItem) => void;
  readonly onClose: () => void;
  readonly onRetry?: () => void;
  readonly embedded?: boolean;
}): JSX.Element {
  const [localQuery, setLocalQuery] = useState("");
  const [localActiveIndex, setLocalActiveIndex] = useState(0);
  const query = typedQuery ?? localQuery;
  const activeIndex = controlledActiveIndex ?? localActiveIndex;
  const rootRef = useRef<HTMLDivElement>(null);
  const updateActiveIndex = (index: number): void => {
    if (controlledActiveIndex === undefined) setLocalActiveIndex(index);
    else onControlledActiveIndexChange?.(index);
  };
  const listId = useId();
  const visible = filterComposerPaletteItems(items, query);
  const selectedIndex = visible.length > 0 ? Math.min(activeIndex, visible.length - 1) : 0;
  const activeOptionId = visible.length > 0 ? `${listId}-option-${selectedIndex}` : undefined;
  useEffect(() => {
    if (visible.length === 0 && activeIndex !== 0) updateActiveIndex(0);
    else if (activeIndex >= visible.length && visible.length > 0) updateActiveIndex(visible.length - 1);
  }, [activeIndex, visible.length]);
  useEffect(() => { if (activeOptionId !== undefined) rootRef.current?.ownerDocument.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" }); }, [activeOptionId]);
  return <div ref={rootRef} className={cx("composer-palette", embedded && "composer-palette--embedded")} role={embedded ? "group" : "dialog"} aria-label={title}>
    {!embedded && <header><strong>{title}</strong><IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton></header>}
    {typedQuery === undefined && <input autoFocus type="search" role="combobox" aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={activeOptionId} value={query} onChange={(event) => { setLocalQuery(event.target.value); updateActiveIndex(0); }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return;
      const intent = resolveComposerPaletteKey(event.key, selectedIndex, visible.length);
      if (intent === null) return;
      event.preventDefault();
      if (intent.kind === "close") onClose();
      else if (intent.kind === "move") updateActiveIndex(intent.index);
      else {
        const selectedItem = visible[intent.index];
        if (selectedItem !== undefined) onSelect(selectedItem);
      }
    }} placeholder={t("common.filter")} aria-label={`${t("common.filter")} ${title}`} />}
    <div id={listId} className="composer-palette__list" role="listbox">
      {visible.map((item, index) => <button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} key={item.id} onMouseMove={() => updateActiveIndex(index)} onClick={() => onSelect(item)}><span>{item.label}</span><small>{item.meta}</small></button>)}
      {visible.length === 0 && !loading && error === undefined && <p>{empty}</p>}
    </div>
    {loading && <p role="status">{t("common.loading")}</p>}
    {error !== undefined && <p role="alert">{error}{onRetry === undefined ? null : <button type="button" onClick={onRetry}>{t("common.retry")}</button>}</p>}
    {truncated && <p role="status">{t("common.more")}</p>}
  </div>;
}

function modelKeyFor(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function modelSelectionFor(backendId: string, modelKey: string): ModelSourceSelection | undefined {
  if (modelKey.length === 0) return undefined;
  const separator = modelKey.indexOf("\u0000");
  return { backendId, providerId: modelKey.slice(0, separator), modelId: modelKey.slice(separator + 1) };
}

function worktreeEligibilityMessage(
  value: Exclude<WorktreeEligibilityView, "eligible">
): "worktree.ineligible.notGitRepository" | "worktree.ineligible.alreadyLinked" | "worktree.ineligible.gitNotFound" | "worktree.ineligible.unsafe" | "worktree.ineligible.unavailable" {
  if (value === "notGitRepository") return "worktree.ineligible.notGitRepository";
  if (value === "alreadyLinked") return "worktree.ineligible.alreadyLinked";
  if (value === "gitNotFound") return "worktree.ineligible.gitNotFound";
  if (value === "unsafe") return "worktree.ineligible.unsafe";
  return "worktree.ineligible.unavailable";
}

function revokeAttachments(attachments: readonly AttachmentDraft[]): void {
  for (const attachment of attachments) if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
}

function withAttachmentPreview(attachment: AttachmentDraft): AttachmentDraft {
  return attachment.kind === "image" ? { ...attachment, previewUrl: URL.createObjectURL(attachment.file) } : attachment;
}

function worktreeEligibilityConfirmsPlainTask(value: WorktreeEligibilityView): boolean {
  return value === "notGitRepository" || value === "alreadyLinked" || value === "gitNotFound";
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

function draftAttachmentsAllowed(
  attachments: readonly AttachmentDraft[],
  policy: { readonly images: boolean; readonly files: boolean; readonly maximumItems?: number; readonly maximumBytes?: number }
): boolean {
  if (policy.maximumItems !== undefined && attachments.length > policy.maximumItems) return false;
  return attachments.every((attachment) => {
    if (policy.maximumBytes !== undefined && attachment.file.size > policy.maximumBytes) return false;
    return attachment.kind === "image" ? policy.images : policy.files;
  });
}

function enqueueNewSessionDraftSave(
  chainRef: { current: Promise<void> },
  controllerRef: { current: AppController },
  draft: NewSessionLocalDraft
): Promise<void> {
  const operation = controllerRef.current.saveNewSessionDraft(draft);
  chainRef.current = operation.catch(() => undefined);
  return operation;
}

function workspaceEntryPaths(entries: readonly WorkspaceEntryView[]): readonly string[] {
  return entries.flatMap((entry) => [entry.path, ...workspaceEntryPaths(entry.children ?? [])]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the new-task draft.";
}
