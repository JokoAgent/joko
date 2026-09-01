import type { JSONContent } from "@tiptap/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";
import {
  AlertTriangle,
  AtSign,
  Code2,
  FolderKanban,
  GitBranch,
  Hammer,
  Menu,
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
import type {
  AppSnapshot,
  AttachmentDraft,
  ComposerDraft,
  ComposerMentionDraft,
  NativeSessionCandidateView,
  NewSessionDraftSelection,
  NewSessionLocalDraft,
  PermissionMode,
  TargetWorktreeProbeView,
  WorktreeEligibilityView,
  WorktreeSourceView,
  WorkspaceEntryView
} from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
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
  mentionsStillPresent,
  type ComposerPaletteItem
} from "./composer-palette.js";
import { countComposerPasteLines } from "./composer-paste-pipeline.js";
import { insertNewSessionPaletteDocument } from "./new-session-composer-document.js";
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
import { PermissionSelector, permissionLabel } from "./PermissionSelector.js";
import { ComposerAddMenu } from "./ComposerAddMenu.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { HomeUsageDashboard } from "./HomeUsageDashboard.js";
import { ComposerPastedTextDialog, type ComposerPastedTextDialogTarget } from "./ComposerPastedTextDialog.js";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";
import { isComposerBlankPointerTarget } from "./composer-blank-focus.js";
import { resolveComposerRouteReferenceFromRuntime } from "./composer-route-reference-runtime.js";
import { hasComposerInternalDrop, resolveComposerInternalDrop } from "./composer-internal-drop.js";
import type { Translator } from "./types.js";
import { IconButton, Pill, cx, formatBytes, formatRelativeTime, CheckboxControl, RadioControl, SelectControl } from "./ui.js";

interface NewSessionPageProps {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly initialTargetId?: string;
  readonly initialDialogueBackendId?: string;
  readonly navigationOpen: boolean;
  readonly t: Translator;
  readonly onOpenNavigation: () => void;
  readonly onClose: () => void;
  readonly onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>;
}

interface NewTaskWorkspaceMentionIndex {
  readonly workspaceId: string;
  readonly status: "loading" | "ready" | "error";
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly error?: string;
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
  const [planMode, setPlanMode] = useState(false);
  const [worktreeEnabled, setWorktreeEnabled] = useState(() => controller.state.preferences.newSessionWorktreeEnabled);
  const [worktreeSourceRef, setWorktreeSourceRef] = useState<string>();
  const [refreshWorktreeRemote, setRefreshWorktreeRemote] = useState(false);
  const [worktreeProbe, setWorktreeProbe] = useState<TargetWorktreeProbeView>();
  const [worktreeSources, setWorktreeSources] = useState<readonly WorktreeSourceView[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string>();
  const [text, setText] = useState("");
  const [editorDocument, setEditorDocument] = useState<JSONContent>(emptyComposerDocument);
  const [mentions, setMentions] = useState<readonly ComposerMentionDraft[]>([]);
  const [attachments, setAttachments] = useState<readonly AttachmentDraft[]>([]);
  const [extraDirectoryIds, setExtraDirectoryIds] = useState<readonly string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [draftError, setDraftError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [palette, setPalette] = useState<"add" | "mention" | "commands">();
  const [workspaceMentionIndex, setWorkspaceMentionIndex] = useState<NewTaskWorkspaceMentionIndex>();
  const [workspaceMentionReload, setWorkspaceMentionReload] = useState(0);
  const [pastedTextTarget, setPastedTextTarget] = useState<ComposerPastedTextDialogTarget>();
  const [hydrated, setHydrated] = useState(false);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const richEditorRef = useRef<ComposerRichTextEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorDocumentRef = useRef(editorDocument);
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  const submissionRef = useRef(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef(controller);
  const draftSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const restoredExecutionRef = useRef<NewSessionLocalDraft | undefined>(undefined);
  const typedPaletteTriggerRef = useRef<"/" | "@" | undefined>(undefined);
  const worktreeProbeSequenceRef = useRef(0);
  controllerRef.current = controller;
  editorDocumentRef.current = editorDocument;
  textRef.current = text;
  attachmentsRef.current = attachments;

  const selectionKey = selection === undefined ? "" : newSessionSelectionValue(selection);
  const selected = selection?.kind === "target" ? activeTargets.find((target) => target.id === selection.targetId) : undefined;
  const backend = selection?.kind === "dialogue"
    ? eligibleDialogueBackends.find((candidate) => candidate.id === selection.backendId)
    : snapshot.backends.find((candidate) => candidate.id === selected?.backendId);
  const workspace = selected === undefined ? undefined : snapshot.workspaces.find((candidate) => candidate.id === selected.workspaceId);
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
  const selectedModel = execution.selectedModel;
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
  const relevantResources = snapshot.resources.filter((resource) =>
    resource.backendId === backend?.id
    && resource.enabled
    && resource.state === "loaded"
    && (resource.targetId === undefined || resource.targetId === selected?.id));
  const canMention = backend?.capabilities.get("input.mention")?.supported === true;
  const matchingWorkspaceMentionIndex = workspaceMentionIndex?.workspaceId === workspace?.id
    ? workspaceMentionIndex
    : undefined;
  const mentionItems = canMention
    ? composerMentionItems(
        workspace?.entries ?? [],
        workspace?.id,
        relevantResources,
        matchingWorkspaceMentionIndex?.paths ?? []
      )
    : [];
  const knownWorkspacePaths = useMemo(() => workspace === undefined
    ? []
    : [...new Set([
        ...workspaceEntryPaths(workspace.entries),
        ...(matchingWorkspaceMentionIndex?.paths ?? [])
      ])], [matchingWorkspaceMentionIndex?.paths, workspace]);
  const globalCommands = snapshot.commands.filter((command) => command.sessionId === undefined);
  const commandItems = composerCommandItems(
    backend?.capabilities.get("runtime.commands")?.supported === true ? globalCommands : [],
    backend?.capabilities.get("runtime.resources")?.supported === true ? relevantResources : []
  );
  const selectableExtraDirectories = snapshot.extraDirectories.filter((directory) => directory.workspaceId === workspace?.id && directory.trusted);
  const canSelectExtraDirectories = workspace !== undefined && backend?.capabilities.get("workspace.extra_dirs")?.supported === true;
  const canUseAddMenu = attachmentPolicy.images || attachmentPolicy.files || canMention || commandItems.length > 0
    || canSelectExtraDirectories && selectableExtraDirectories.length > 0;
  const worktreeEligible = worktreeProbe !== undefined
    && selected !== undefined
    && worktreeProbe.targetId === selected.id
    && worktreeProbe.eligibility === "eligible";
  const worktreeRequested = selected !== undefined && startKind === "fresh" && worktreeEnabled;
  const effectiveWorktreeEnabled = worktreeRequested && worktreeEligible;

  const profileScope = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeAttachments(attachmentsRef.current);
    };
  }, []);

  useEffect(() => {
    if (!canMention || workspace === undefined) {
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
  }, [canMention, t, workspace?.id, workspace?.revision, workspaceMentionReload]);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setSelection(requestedSelection ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends));
    void controllerRef.current.readNewSessionDraft().then((draft) => {
      if (cancelled || draft === undefined) return;
      const restoredSelection = requestedSelection
        ?? parseNewSessionSelection(newSessionSelectionValue(draft.selection), activeTargets, eligibleDialogueBackends)
        ?? defaultNewSessionSelection(activeTargets, eligibleDialogueBackends);
      if (restoredSelection === undefined) return;
      const restored = { ...draft, selection: restoredSelection };
      const restoredDocument = normalizeComposerDocument(restored.editorDocument, restored.text);
      const restoredText = composerDocumentPlainText(restoredDocument);
      restoredExecutionRef.current = restored;
      setSelection(restoredSelection);
      editorDocumentRef.current = restoredDocument;
      setEditorDocument(restoredDocument);
      textRef.current = restoredText;
      setText(restoredText);
      setMentions(mentionsStillPresent(restoredText, restored.mentions));
      setAttachments((current) => {
        revokeAttachments(current);
        return restored.attachments.map(withAttachmentPreview);
      });
      setStartKind(restored.nativeStart.kind);
      setNativeReference(restored.nativeStart.kind === "attach" ? restored.nativeStart.reference : "");
      setNativeSelectionWarning(undefined);
      setWorktreeEnabled(restored.worktree?.enabled ?? controllerRef.current.state.preferences.newSessionWorktreeEnabled);
      setWorktreeSourceRef(restored.worktree?.sourceRef);
      setRefreshWorktreeRemote(restored.worktree?.refreshRemote ?? false);
      setHydrationRevision((current) => current + 1);
    }).catch((error: unknown) => {
      if (!cancelled) setDraftError(messageOf(error));
    }).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
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
      const restoredModel = restoredOptions.selectedModel;
      setModelKey(restoredModel === undefined ? "" : restoredModelKey);
      setEffort(restoredOptions.effortSelectable && restored.effort !== undefined && restoredModel?.efforts.includes(restored.effort)
        ? restored.effort
        : restoredOptions.effortSelectable ? restoredModel?.efforts[0] ?? "" : "");
      setFastMode(restoredOptions.fastModeSelectable && restored.fastMode);
      setPermissionMode(restoredOptions.permissionModes.includes(restored.permissionMode)
        ? restored.permissionMode
        : restoredOptions.permissionModes[0] ?? "ask");
      setPlanMode(restoredOptions.planModeSupported && restored.planMode);
      setWorktreeEnabled(restored.worktree?.enabled ?? controllerRef.current.state.preferences.newSessionWorktreeEnabled);
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
    setModelKey(initialModel === undefined ? "" : modelKeyFor(initialModel.providerId, initialModel.modelId));
    setEffort(options.effortSupported ? defaults?.model?.effort ?? initialModel?.efforts[0] ?? "" : "");
    setFastMode(options.fastModeSupported && initialModel?.supportsFast === true && (defaults?.model?.fastMode ?? false));
    const defaultPermission = defaults?.permissionMode ?? snapshot.settings.policy.defaultMode;
    setPermissionMode(options.permissionModes.includes(defaultPermission) ? defaultPermission : options.permissionModes[0] ?? "ask");
    setPlanMode(options.planModeSupported && (defaults?.planMode ?? false));
    setWorktreeEnabled(controllerRef.current.state.preferences.newSessionWorktreeEnabled);
    setWorktreeSourceRef(undefined);
    setRefreshWorktreeRemote(false);
    setStartKind("fresh");
    setNativeReference("");
    setNativeSelectionWarning(undefined);
    setMentions([]);
    setExtraDirectoryIds([]);
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
    if (selected === undefined || startKind !== "fresh") {
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
    void controllerRef.current.probeTargetWorktree(selected.id, abort.signal).then(async (probe) => {
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeProbe(probe);
      if (!probe.canRefreshRemote) setRefreshWorktreeRemote(false);
      if (probe.eligibility !== "eligible") {
        setWorktreeSourceRef(undefined);
        return;
      }
      const sources = await controllerRef.current.listTargetWorktreeSources(selected.id, abort.signal);
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
  }, [selected?.id, startKind]);

  useEffect(() => {
    if (selectedModel === undefined) {
      if (modelKey.length > 0) {
        setEffort("");
        setFastMode(false);
      }
      return;
    }
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
      providerId: selectedModel?.providerId ?? "",
      modelId: selectedModel?.modelId ?? "",
      ...(execution.effortSelectable && effort.length > 0 ? { effort } : {}),
      fastMode: execution.fastModeSelectable && fastMode,
      permissionMode: execution.permissionModes.includes(permissionMode) ? permissionMode : execution.permissionModes[0] ?? "ask",
      planMode: execution.planModeSupported && planMode,
      worktree: {
        enabled: worktreeEnabled,
        ...(worktreeSourceRef === undefined ? {} : { sourceRef: worktreeSourceRef }),
        refreshRemote: refreshWorktreeRemote
      },
      text,
      editorDocument,
      mentions: mentionsStillPresent(text, mentions),
      attachments,
      ...(canSelectExtraDirectories ? { extraDirectoryIds } : {})
    };
    const timer = window.setTimeout(() => {
      void enqueueNewSessionDraftSave(draftSaveChainRef, controllerRef, draft).then(() => setDraftError(undefined)).catch((error: unknown) => setDraftError(messageOf(error)));
    }, 420);
    return () => window.clearTimeout(timer);
  }, [attachments, canSelectExtraDirectories, editorDocument, effort, execution.effortSelectable, execution.fastModeSelectable, execution.permissionModes, execution.planModeSupported, extraDirectoryIds, fastMode, hydrated, mentions, modelKey, nativeReference, permissionMode, planMode, refreshWorktreeRemote, selected?.id, selectionKey, startKind, submitting, text, worktreeEnabled, worktreeSourceRef]);

  const attachmentsAllowed = attachments.every((attachment) => attachment.kind === "image" ? attachmentPolicy.images : attachmentPolicy.files);
  const hasInput = !composerDocumentIsEmpty(editorDocument) || attachments.length > 0;
  const validContext = selection !== undefined && backend !== undefined
    && (startKind === "fresh" || (selected !== undefined && nativeSelectionReady));
  const modelRouteReady = !execution.modelSwitchSupported || selectedModel !== undefined;
  const worktreeDecisionReady = !worktreeRequested || (
    !worktreeLoading && worktreeError === undefined && worktreeProbe?.targetId === selected?.id
  );
  const canSend = validContext && modelRouteReady && hasInput && attachmentsAllowed && worktreeDecisionReady && !submitting;

  const closePalette = (restoreFocus = false): void => {
    typedPaletteTriggerRef.current = undefined;
    setPalette(undefined);
    if (restoreFocus) requestAnimationFrame(() => richEditorRef.current?.focus());
  };

  const updateDocument = (nextDocument: JSONContent, isComposing = false): void => {
    const normalizedDocument = normalizeComposerDocument(nextDocument);
    const nextText = composerDocumentPlainText(normalizedDocument);
    editorDocumentRef.current = normalizedDocument;
    setEditorDocument(normalizedDocument);
    textRef.current = nextText;
    setText(nextText);
    setMentions((current) => mentionsStillPresent(nextText, current));
    const typedPalette = resolveTypedComposerPalette(nextText, isComposing, false);
    if ((typedPalette === "mention" && !canMention) || (typedPalette === "commands" && commandItems.length === 0)) {
      closePalette();
      return;
    }
    if (typedPalette !== null) {
      typedPaletteTriggerRef.current = nextText as "/" | "@";
      setPalette(typedPalette);
      return;
    }
    closePalette();
  };

  const insertPaletteItem = (item: ComposerPaletteItem): void => {
    const typedTrigger = typedPaletteTriggerRef.current;
    const next = insertNewSessionPaletteDocument(editorDocumentRef.current, typedTrigger, item);
    editorDocumentRef.current = next.document;
    setEditorDocument(next.document);
    textRef.current = next.text;
    setText(next.text);
    if (item.mention !== undefined) setMentions((current) => [...current.filter((candidate) => candidate.id !== item.mention?.id), item.mention!]);
    closePalette(true);
  };

  const addFiles = (files: FileList | readonly File[]): void => {
    if (submitting) return;
    setAttachmentError(undefined);
    const list = [...files];
    const maximumItems = attachmentPolicy.maximumItems;
    const maximumBytes = attachmentPolicy.maximumBytes;
    const available = maximumItems === undefined ? list.length : Math.max(0, maximumItems - attachments.length);
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
    const previous = worktreeEnabled;
    setWorktreeEnabled(enabled);
    void controllerRef.current.setNewSessionWorktreeEnabled(enabled).catch((error: unknown) => {
      if (mountedRef.current) {
        setWorktreeEnabled(previous);
        setDraftError(messageOf(error));
      }
    });
  };

  const submit = async (activeDocument: JSONContent = editorDocumentRef.current): Promise<void> => {
    const sourceEditorDocument = normalizeComposerDocument(activeDocument, textRef.current);
    const sourceText = composerDocumentPlainText(sourceEditorDocument);
    const activeCanSend = validContext
      && modelRouteReady
      && (!composerDocumentIsEmpty(sourceEditorDocument) || attachments.length > 0)
      && attachmentsAllowed
      && worktreeDecisionReady
      && !submitting;
    if (!activeCanSend || selection === undefined || submissionRef.current) return;
    submissionRef.current = true;
    setSubmitting(true);
    const allowedPermissions = execution.permissionModes;
    const resolvedPermission = allowedPermissions.includes(permissionMode) ? permissionMode : allowedPermissions[0] ?? "ask";
    const worktree = effectiveWorktreeEnabled
      ? {
          ...(worktreeSourceRef === undefined ? {} : { sourceRef: worktreeSourceRef }),
          refreshRemote: refreshWorktreeRemote && worktreeProbe?.canRefreshRemote === true
        }
      : undefined;
    try {
      await draftSaveChainRef.current;
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
        text: sourceText.trim(),
        editorDocument: sourceEditorDocument,
        attachments,
        mentions: mentionsStillPresent(sourceText, mentions),
        deliveryMode: "prompt",
        ...(canSelectExtraDirectories ? { extraDirectoryIds } : {})
      });
    } catch {
      // App owns the operation banner; the persistent draft intentionally remains.
    } finally {
      submissionRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent, activeDocument: JSONContent): boolean => {
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

  const paletteInAddMenu = palette !== undefined && typedPaletteTriggerRef.current === undefined;

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
        {selected !== undefined && startKind === "fresh" && <section className="new-task-worktree" aria-labelledby="new-task-worktree-title">
          <header>
            <span><GitBranch aria-hidden="true" /><strong id="new-task-worktree-title">{t("worktree.title")}</strong></span>
            <label className="new-task-worktree__toggle">
              <CheckboxControl
                checked={worktreeEnabled}
                disabled={submitting || worktreeLoading || (!worktreeEligible && !worktreeEnabled)}
                onChange={(event) => updateWorktreeEnabled(event.target.checked)}
              />
              <span>{t("worktree.enable")}</span>
            </label>
          </header>
          {worktreeLoading && <p className="muted" role="status">{t("worktree.checking")}</p>}
          {worktreeError !== undefined && <p className="inline-error" role="alert">{worktreeError}</p>}
          {!worktreeLoading && worktreeError === undefined && worktreeProbe !== undefined && worktreeProbe.eligibility !== "eligible" && <p className="muted">{t(worktreeEligibilityMessage(worktreeProbe.eligibility))}</p>}
          {worktreeEligible && <div className="new-task-worktree__options">
            <label>
              <span>{t("worktree.source")}</span>
              <SelectControl value={worktreeSourceRef ?? ""} disabled={submitting || worktreeSources.length === 0} onChange={(event) => setWorktreeSourceRef(event.target.value || undefined)}>
                {worktreeSources.length === 0 && <option value="">{worktreeProbe?.currentBranch ?? t("worktree.defaultSource")}</option>}
                {worktreeSources.map((source) => <option value={source.ref} key={`${source.ref}\u0000${source.commit}`}>{source.name}{source.current ? ` · ${t("worktree.current")}` : ""}</option>)}
              </SelectControl>
            </label>
            {worktreeProbe?.canRefreshRemote && <label className="new-task-worktree__refresh"><CheckboxControl checked={refreshWorktreeRemote} disabled={submitting} onChange={(event) => setRefreshWorktreeRemote(event.target.checked)} /><span>{t("worktree.refreshRemote")}</span></label>}
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
            {attachments.length > 0 && <ComposerAttachmentTray
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
              editable={!submitting}
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
            <div className="composer__toolbar new-task-composer__toolbar">
              <div className="composer__tools">
                <input ref={fileInputRef} className="sr-only" type="file" multiple disabled={submitting} accept={attachmentPolicy.images && !attachmentPolicy.files ? "image/*" : undefined} onChange={handleFiles} />
                {canUseAddMenu && <div className="palette-anchor">
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
                    disabled={submitting}
                    disabledReason={submitting ? t("common.working") : undefined}
                    count={extraDirectoryIds.length}
                  >
                    {palette === "add" && <><div className="composer-add-menu__actions" role="menu">
                      {(attachmentPolicy.images || attachmentPolicy.files) && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { setPalette(undefined); fileInputRef.current?.click(); }}><Paperclip aria-hidden="true" /><span><strong>{t("composer.attach")}</strong><small>{t("composer.attachments")}</small></span></button>}
                      {canMention && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { typedPaletteTriggerRef.current = undefined; setPalette("mention"); }}><AtSign aria-hidden="true" /><span><strong>{t("composer.mention")}</strong><small>{mentionItems.length}</small></span></button>}
                      {commandItems.length > 0 && <button className="composer-add-menu__action" type="button" role="menuitem" onClick={() => { typedPaletteTriggerRef.current = undefined; setPalette("commands"); }}><Sparkles aria-hidden="true" /><span><strong>{t("composer.commands")}</strong><small>{commandItems.length}</small></span></button>}
                    </div>
                    {canSelectExtraDirectories && selectableExtraDirectories.length > 0 && <fieldset className="composer-add-menu__directories">
                      <legend>{t("composer.extraDirectories")}</legend>
                      {selectableExtraDirectories.map((directory) => <label key={directory.id}><CheckboxControl disabled={submitting} checked={extraDirectoryIds.includes(directory.id)} onChange={(event) => setExtraDirectoryIds((current) => event.target.checked ? [...new Set([...current, directory.id])] : current.filter((id) => id !== directory.id))} /><span><strong>{directory.serverPath}</strong><small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")}</small></span></label>)}
                      <button className="composer-add-menu__directory-reset" type="button" disabled={submitting || extraDirectoryIds.length === 0} onClick={() => setExtraDirectoryIds([])}>{t("common.none")}</button>
                    </fieldset>}</>}
                    {palette === "mention" && paletteInAddMenu && <NewTaskPalette
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
                  {palette === "mention" && !paletteInAddMenu && <NewTaskPalette
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
                  {palette === "commands" && !paletteInAddMenu && <NewTaskPalette title={t("composer.commands")} items={commandItems} empty={t("composer.noCommands")} t={t} onSelect={insertPaletteItem} onClose={() => closePalette(true)} />}
                </div>}
              </div>
              <div className="new-task-composer__controls">
                {execution.modelSwitchSupported && <ModelPicker
                  className="new-task-composer__select--model"
                  models={execution.availableModels}
                  ownerId={pickerOwnerId}
                  value={selectedModel === undefined ? undefined : {
                    backendId: selectedModel.backendId,
                    providerId: selectedModel.providerId,
                    modelId: selectedModel.modelId,
                    ...(effort.length === 0 ? {} : { effort }),
                    fastMode: execution.fastModeSelectable && fastMode
                  }}
                  allowDefault
                  defaultLabel={t("scheduler.taskDefault")}
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
                {execution.permissionSelectable ? <PermissionSelector value={permissionMode} modes={execution.permissionModes} disabled={submitting} disabledReason={submitting ? t("common.working") : undefined} onChange={setPermissionMode} t={t} /> : <Pill tone="neutral"><Shield aria-hidden="true" />{permissionLabel(execution.permissionModes[0] ?? "ask", t)}</Pill>}
                {execution.planModeSupported && <button className={cx("new-task-composer__toggle", planMode && "is-active")} type="button" disabled={submitting} aria-pressed={planMode} onClick={() => setPlanMode((value) => !value)}><Sparkles aria-hidden="true" />{t("controls.plan")}</button>}
              </div>
              <IconButton className="send-button" label={t("composer.send")} disabled={!canSend} disabledReason={!canSend ? submitting ? t("common.working") : !hasInput ? t("composer.placeholder") : t("composer.inputUnavailable") : undefined} onClick={() => void submit()}><Send aria-hidden="true" /></IconButton>
            </div>
          </div>
          <div className="new-task-composer__meta"><span>{selection?.kind === "dialogue" ? t("newTask.dialogue") : selected?.workspaceName ?? t("session.noProjects")}</span><span>{backend?.name ?? ""}</span></div>
        </div>

        <section className="new-task-quick" aria-labelledby="new-task-quick-title">
          <h2 id="new-task-quick-title">{t("newTask.quickStart")}</h2>
          <div className="new-task-quick__grid">
            {QUICK_STARTS.map(({ key, label, icon: Icon }) => <button type="button" key={key} disabled={submitting} onClick={() => {
              const nextDocument = plainTextToComposerDocument(t(label));
              const nextText = composerDocumentPlainText(nextDocument);
              editorDocumentRef.current = nextDocument;
              setEditorDocument(nextDocument);
              textRef.current = nextText;
              setText(nextText);
              setMentions([]);
              closePalette();
              requestAnimationFrame(() => richEditorRef.current?.focus());
            }}><span><Icon aria-hidden="true" /></span><strong>{t(label)}</strong></button>)}
          </div>
        </section>
        <HomeUsageDashboard controller={controller} ownerId={pickerOwnerId} locale={controller.state.preferences.locale} t={t} />
      </section>
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
  </main>;
}

function NewTaskPalette({ title, items, empty, loading = false, error, truncated = false, t, onSelect, onClose, onRetry, embedded = false }: {
  readonly title: string;
  readonly items: readonly ComposerPaletteItem[];
  readonly empty: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly truncated?: boolean;
  readonly t: Translator;
  readonly onSelect: (item: ComposerPaletteItem) => void;
  readonly onClose: () => void;
  readonly onRetry?: () => void;
  readonly embedded?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const visible = items.filter((item) => `${item.label} ${item.meta}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
  const selectedIndex = visible.length > 0 ? Math.min(activeIndex, visible.length - 1) : 0;
  const activeOptionId = visible.length > 0 ? `${listId}-option-${selectedIndex}` : undefined;
  useEffect(() => {
    if (visible.length === 0 && activeIndex !== 0) setActiveIndex(0);
    else if (activeIndex >= visible.length && visible.length > 0) setActiveIndex(visible.length - 1);
  }, [activeIndex, visible.length]);
  useEffect(() => { if (activeOptionId !== undefined) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" }); }, [activeOptionId]);
  return <div className={cx("composer-palette", embedded && "composer-palette--embedded")} role={embedded ? "group" : "dialog"} aria-label={title}>
    {!embedded && <header><strong>{title}</strong><IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton></header>}
    <input autoFocus type="search" role="combobox" aria-autocomplete="list" aria-controls={listId} aria-expanded="true" aria-activedescendant={activeOptionId} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.key === "Tab" && event.shiftKey)) return;
      const intent = resolveComposerPaletteKey(event.key, selectedIndex, visible.length);
      if (intent === null) return;
      event.preventDefault();
      if (intent.kind === "close") onClose();
      else if (intent.kind === "move") setActiveIndex(intent.index);
      else {
        const selectedItem = visible[intent.index];
        if (selectedItem !== undefined) onSelect(selectedItem);
      }
    }} placeholder={t("common.filter")} aria-label={`${t("common.filter")} ${title}`} />
    <div id={listId} className="composer-palette__list" role="listbox">
      {visible.map((item, index) => <button id={`${listId}-option-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} key={item.id} onMouseMove={() => setActiveIndex(index)} onClick={() => onSelect(item)}><span>{item.label}</span><small>{item.meta}</small></button>)}
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

function worktreeEligibilityMessage(
  value: Exclude<WorktreeEligibilityView, "eligible">
): "worktree.ineligible.notGitRepository" | "worktree.ineligible.alreadyLinked" | "worktree.ineligible.unsafe" | "worktree.ineligible.unavailable" {
  if (value === "notGitRepository") return "worktree.ineligible.notGitRepository";
  if (value === "alreadyLinked") return "worktree.ineligible.alreadyLinked";
  if (value === "unsafe") return "worktree.ineligible.unsafe";
  return "worktree.ineligible.unavailable";
}

function revokeAttachments(attachments: readonly AttachmentDraft[]): void {
  for (const attachment of attachments) if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
}

function withAttachmentPreview(attachment: AttachmentDraft): AttachmentDraft {
  return attachment.kind === "image" ? { ...attachment, previewUrl: URL.createObjectURL(attachment.file) } : attachment;
}

function enqueueNewSessionDraftSave(
  chainRef: { current: Promise<void> },
  controllerRef: { current: AppController },
  draft: NewSessionLocalDraft
): Promise<void> {
  const operation = chainRef.current.then(() => controllerRef.current.saveNewSessionDraft(draft));
  chainRef.current = operation.catch(() => undefined);
  return operation;
}

function workspaceEntryPaths(entries: readonly WorkspaceEntryView[]): readonly string[] {
  return entries.flatMap((entry) => [entry.path, ...workspaceEntryPaths(entry.children ?? [])]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the new-task draft.";
}
