import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { PlanReviewDecisionKind } from "@joko/contracts";
import { AlertTriangle, ArrowRight, Check, Clock3, CornerDownLeft, FileText, HelpCircle, ListChecks, Pencil, Shield, X } from "lucide-react";
import type { AppController } from "../controller.js";
import type { InteractionResolutionDraft, InteractionView, PermissionArgumentView, PermissionSubjectView, QuestionAnswerDraft, QuestionFieldView } from "../model.js";
import { formatCommand } from "../permission-format.js";
import { QuestionWizardDraftStore, clampQuestionStep, hasQuestionAnswer, initialQuestionAnswers, questionOtherAnswer, replaceQuestionOtherAnswer, resolveQuestionWizardKey, toggleQuestionOptionAnswer, validQuestionAnswer, type QuestionWizardDraft } from "./coding-ui-behavior.js";
import { StreamingMarkdown } from "./Timeline.js";
import type { RunAction, Translator } from "./types.js";
import { useGamepadActions } from "../gamepad-actions.js";
import { createCurrentV1InteractionOwnershipCoordinator, questionWizardDraftCodec, type InteractionOwnershipCoordinator, type InteractionOwnershipSnapshot } from "../interaction-ownership-coordinator.js";
import { Button, IconButton, Modal, Pill, StatusDot, cx, formatRelativeTime, CheckboxControl, RadioControl } from "./ui.js";

type AnswerMap = Record<string, QuestionAnswerDraft>;
type InteractionOwnershipState = { readonly scope: string; readonly snapshot: InteractionOwnershipSnapshot<QuestionWizardDraft> };

const questionDrafts = new QuestionWizardDraftStore();

export function InteractionDialog({ controller, interaction, remaining, inline = false, t, runAction }: {
  readonly controller: AppController;
  readonly interaction?: InteractionView;
  readonly remaining: number;
  readonly inline?: boolean;
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element | null {
  const activeProfile = controller.state.activeProfile;
  const interactionScope = (interaction?.kind === "question" || interaction?.kind === "permission") && activeProfile !== undefined
    ? JSON.stringify([activeProfile.serverId, activeProfile.id, interaction.sessionId, interaction.id, interaction.generation.toString()])
    : undefined;
  const actionScope = interaction !== undefined && activeProfile !== undefined
    ? JSON.stringify([activeProfile.serverId, activeProfile.id, interaction.sessionId, interaction.id, interaction.generation.toString()])
    : undefined;
  const interactionDraftKey = interaction === undefined ? undefined : `${actionScope ?? "unavailable"}\u0000${interaction.sessionId}\u0000${interaction.id}\u0000${interaction.generation}`;
  const initialDraft = interaction?.kind === "question" && interactionScope !== undefined ? questionDrafts.read(interactionScope, interaction.id) : undefined;
  const [ownership, setOwnership] = useState<InteractionOwnershipState>();
  const [extensionValue, setExtensionValue] = useState(interaction?.prefill ?? "");
  const [planFeedback, setPlanFeedback] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [settling, setSettling] = useState(false);
  const settlingRef = useRef(false);
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const ownerSentinelRef = useRef<HTMLSpanElement>(null);
  const coordinatorRef = useRef<InteractionOwnershipCoordinator<QuestionWizardDraft> | undefined>(undefined);
  const currentOwnership = ownership !== undefined && ownership.scope === interactionScope ? ownership.snapshot : undefined;
  const ownsInteraction = currentOwnership?.status === "owner" && currentOwnership.ownerToken !== undefined;
  const ownsQuestionDraft = interaction?.kind === "question" && ownsInteraction;
  const ownershipStatus = currentOwnership?.status ?? (interactionScope === undefined ? "unavailable" : "claiming");
  const previousOwnershipRef = useRef({ scope: interactionScope, owns: ownsInteraction });
  const actionFenceRef = useRef(0);
  const liveActionScopeRef = useRef(interactionDraftKey);
  liveActionScopeRef.current = interactionDraftKey;
  const gamepadDecisionRef = useRef<(action: "approve" | "reject") => void>(() => undefined);
  gamepadDecisionRef.current = () => undefined;
  useGamepadActions(dialogContentRef, interactionDraftKey, "interaction", {
    approve: () => gamepadDecisionRef.current("approve"),
    reject: () => gamepadDecisionRef.current("reject")
  });

  useEffect(() => {
    setExtensionValue(interaction?.prefill ?? "");
    setPlanFeedback("");
    setMinimized(false);
    settlingRef.current = false;
    setSettling(false);
    actionFenceRef.current += 1;
  }, [interaction?.id, interactionDraftKey]);

  useEffect(() => {
    if ((interaction?.kind !== "question" && interaction?.kind !== "permission") || interactionScope === undefined || activeProfile === undefined) {
      coordinatorRef.current = undefined;
      setOwnership(undefined);
      return;
    }
    const sentinel = ownerSentinelRef.current;
    const ownerWindow = sentinel?.ownerDocument.defaultView;
    if (sentinel === null || ownerWindow === null || ownerWindow === undefined) {
      setOwnership(undefined);
      return;
    }
    const stored = interaction.kind === "question" ? questionDrafts.read(interactionScope, interaction.id) : undefined;
    const coordinator = createCurrentV1InteractionOwnershipCoordinator<QuestionWizardDraft>({
      serverId: activeProfile.serverId,
      profileId: activeProfile.id,
      sessionId: interaction.sessionId,
      interactionId: interaction.id,
      interactionGeneration: interaction.generation
    }, interaction.kind === "question" ? { kind: "draft", initialDraft: stored ?? {
      answers: { ...initialQuestionAnswers(interaction.fields) },
      otherText: {},
      currentIndex: 0,
      minimized: false
    }, codec: questionWizardDraftCodec } : { kind: "ownership-only" }, ownerWindow as Window & typeof globalThis);
    coordinatorRef.current = coordinator;
    const unsubscribe = coordinator.subscribe((snapshot) => {
      if (coordinatorRef.current !== coordinator) return;
      setOwnership({ scope: interactionScope, snapshot });
      if (interaction.kind === "question") {
        if (snapshot.draft === undefined) questionDrafts.delete(interactionScope, interaction.id);
        else questionDrafts.write(interactionScope, interaction.id, snapshot.draft);
      }
    });
    const pause = (): void => coordinator.pause();
    const restore = (): void => { void coordinator.resume(); };
    ownerWindow.addEventListener("pagehide", pause);
    ownerWindow.addEventListener("pageshow", restore);
    void coordinator.start();
    return () => {
      ownerWindow.removeEventListener("pagehide", pause);
      ownerWindow.removeEventListener("pageshow", restore);
      coordinator.dispose();
      unsubscribe();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = undefined;
    };
  }, [interactionScope]);

  useEffect(() => {
    if (interaction?.kind !== "question" || currentOwnership?.draft?.minimized !== false || !ownsQuestionDraft) return;
    const dialog = dialogContentRef.current;
    const ownerWindow = dialog?.ownerDocument.defaultView;
    if (dialog === null || ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (!dialog.isConnected || dialog.ownerDocument.defaultView !== ownerWindow) return;
      dialog.querySelector<HTMLElement>(".question-field input, .question-field textarea")?.focus();
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [currentOwnership?.draft?.currentIndex, currentOwnership?.draft?.minimized, interaction?.id, interaction?.kind, ownsQuestionDraft]);

  useEffect(() => {
    if (!inline || minimized || (interaction?.kind !== "permission" && interaction?.kind !== "plan" && interaction?.kind !== "select" && interaction?.kind !== "confirm")) return;
    const dialog = dialogContentRef.current;
    const ownerWindow = dialog?.ownerDocument.defaultView;
    if (dialog === null || ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (dialog.isConnected && dialog.ownerDocument.defaultView === ownerWindow) dialog.focus();
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [inline, interaction?.id, interaction?.kind, minimized]);

  useEffect(() => {
    const previous = previousOwnershipRef.current;
    const lostOwnership = previous.scope === interactionScope && previous.owns && !ownsInteraction;
    previousOwnershipRef.current = { scope: interactionScope, owns: ownsInteraction };
    if ((interaction?.kind !== "question" && interaction?.kind !== "permission") || ownsInteraction || minimized) return;
    const dialog = dialogContentRef.current;
    const ownerWindow = dialog?.ownerDocument.defaultView;
    if (dialog === null || ownerWindow === null || ownerWindow === undefined) return;
    const activeElement = dialog.ownerDocument.activeElement;
    if (!lostOwnership && activeElement !== dialog && (activeElement === null || !dialog.contains(activeElement))) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (!dialog.isConnected || dialog.ownerDocument.defaultView !== ownerWindow) return;
      (dialog.querySelector<HTMLElement>(".interaction-ownership button:not(:disabled)") ?? dialog).focus();
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [currentOwnership?.status, interaction?.kind, interactionScope, minimized, ownsInteraction]);

  if (interaction === undefined) return null;
  const fallbackQuestionDraft = initialDraft ?? {
    answers: { ...initialQuestionAnswers(interaction.fields) },
    otherText: {},
    currentIndex: 0,
    minimized: false
  };
  const visibleQuestionDraft = currentOwnership?.draft ?? fallbackQuestionDraft;
  const visibleAnswers: AnswerMap = { ...visibleQuestionDraft.answers };
  const visibleOtherText: Readonly<Record<string, string>> = visibleQuestionDraft.otherText;
  const visibleQuestionIndex = clampQuestionStep(visibleQuestionDraft.currentIndex, interaction.fields.length);
  const visibleMinimized = interaction.kind === "question" && ownsInteraction ? visibleQuestionDraft.minimized : minimized;
  const renderedOwnerToken = currentOwnership?.ownerToken;
  const updateQuestionDraft = (update: (draft: typeof visibleQuestionDraft) => typeof visibleQuestionDraft): boolean => {
    const coordinator = coordinatorRef.current;
    if (renderedOwnerToken === undefined || coordinator?.snapshot.ownerToken !== renderedOwnerToken || coordinator.snapshot.draft === undefined) return false;
    return coordinator.writeDraft(renderedOwnerToken, update(coordinator.snapshot.draft));
  };
  const settle = (key: string, action: () => Promise<void>): void => {
    if (settlingRef.current) return;
    const coordinated = interaction.kind === "question" || interaction.kind === "permission";
    const settleCoordinator = coordinated ? coordinatorRef.current : undefined;
    const settleToken = coordinated && renderedOwnerToken !== undefined
      ? settleCoordinator?.beginSettle(renderedOwnerToken)
      : undefined;
    if (coordinated && settleToken === undefined) return;
    const actionFence = ++actionFenceRef.current;
    const actionScope = interactionDraftKey;
    settlingRef.current = true;
    setSettling(true);
    runAction(key, async () => {
      try {
        await action();
        if (settleToken !== undefined) settleCoordinator?.finishSettle(settleToken, "succeeded");
        if (interaction.kind === "question" && interactionScope !== undefined) questionDrafts.delete(interactionScope, interaction.id);
      } catch (error) {
        if (settleToken !== undefined) settleCoordinator?.finishSettle(settleToken, "failed");
        if (actionFenceRef.current === actionFence && liveActionScopeRef.current === actionScope) {
          settlingRef.current = false;
          setSettling(false);
        }
        throw error;
      }
    });
  };
  const resolve = (resolution: InteractionResolutionDraft): void => settle(`interaction:${interactionDraftKey}`, () => controller.resolveInteraction(interaction, resolution));
  const dismiss = (): void => settle(`dismiss:${interactionDraftKey}`, () => controller.dismissInteraction(interaction));
  gamepadDecisionRef.current = (action) => {
    if (visibleMinimized || settlingRef.current || controller.state.connectionState !== "connected"
      || (interaction.kind !== "permission" && interaction.kind !== "plan") || (interaction.kind === "permission" && !ownsInteraction)) return;
    const input = { key: action === "approve" ? "Enter" : "Escape", repeat: false, isComposing: false,
      metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, editableTarget: false, buttonTarget: false };
    const intent = resolveInteractionShortcut(input, { kind: interaction.kind, options: interaction.options });
    if (intent?.kind === "dismiss") dismiss();
    else if (intent?.kind === "resolve") {
      if (interaction.kind === "permission") resolve({ kind: "permission", decisionId: intent.decisionId });
      else resolve({ kind: "plan", decisionId: intent.decisionId, feedback: planFeedback.trim() });
    }
  };
  const skipCurrentQuestion = (): void => {
    if (interaction.kind === "question" && !ownsQuestionDraft) return;
    const field = interaction.kind === "question" ? interaction.fields[visibleQuestionIndex] : undefined;
    if (field === undefined || field.required) {
      updateQuestionDraft((draft) => ({ ...draft, minimized: false }));
      return;
    }
    const nextAnswers = { ...visibleAnswers };
    delete nextAnswers[field.id];
    updateQuestionDraft((draft) => ({ ...draft, answers: nextAnswers }));
    if (visibleQuestionIndex === interaction.fields.length - 1) {
      if (interaction.fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) resolve({ kind: "question", answers: nextAnswers });
      else updateQuestionDraft((draft) => ({ ...draft, minimized: false }));
    }
    else updateQuestionDraft((draft) => ({ ...draft, currentIndex: visibleQuestionIndex + 1 }));
  };
  const icon = interaction.kind === "permission" ? <Shield /> : interaction.kind === "plan" ? <ListChecks /> : interaction.kind === "confirm" ? <HelpCircle /> : <FileText />;
  const handleSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (interaction.kind === "plan") return;
    if (interaction.kind === "permission" && !ownsInteraction) return;
    const intent = resolveInteractionShortcut({
      key: event.key,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editableTarget: isInteractionEditableTarget(event.target),
      buttonTarget: isInteractionButtonTarget(event.target)
    }, interaction);
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (intent.kind === "dismiss") dismiss();
    else if (intent.kind === "extension") resolve({ kind: "extension", value: intent.value });
    else if (interaction.kind === "permission") resolve({ kind: "permission", decisionId: intent.decisionId });
  };
  const continueHere = (): void => {
    const coordinator = coordinatorRef.current;
    if (coordinator === undefined) return;
    void coordinator.takeover().then((owned) => {
      const ownerToken = coordinator.snapshot.ownerToken;
      const draft = coordinator.snapshot.draft;
      if (owned && ownerToken !== undefined && draft !== undefined && draft.minimized) {
        coordinator.writeDraft(ownerToken, { ...draft, minimized: false });
      }
    });
  };

  if (visibleMinimized) {
    const cancelMinimized = (): void => {
      if (interaction.kind === "question") skipCurrentQuestion();
      else if (interaction.kind === "confirm") resolve({ kind: "extension", value: false });
      else if (interaction.kind === "permission" || interaction.kind === "plan") {
        const intent = resolveInteractionShortcut({ key: "Escape", repeat: false, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, editableTarget: false, buttonTarget: false }, interaction);
        if (intent?.kind === "resolve" && interaction.kind === "permission") resolve({ kind: "permission", decisionId: intent.decisionId });
        else dismiss();
      } else dismiss();
    };
    const reviewLabel = interaction.kind === "question" && interaction.fields.length > 1
      ? `${t("interaction.review")} · ${visibleQuestionIndex + 1} / ${interaction.fields.length}`
      : t("interaction.review");
    return <><span ref={ownerSentinelRef} hidden /><MinimizedInteraction className={inline ? "interaction-takeover-minimized" : "interaction-minimized"} title={interaction.title || interactionTitle(interaction.kind, t)} icon={icon} reviewLabel={reviewLabel} disabled={settling} cancelDisabled={settling || ((interaction.kind === "question" || interaction.kind === "permission") && !ownsInteraction)} onRestore={() => interaction.kind === "question" && ownsInteraction ? updateQuestionDraft((draft) => ({ ...draft, minimized: false })) : setMinimized(false)} onCancel={cancelMinimized} /></>;
  }

  const content = (
      <div ref={dialogContentRef} className="interaction-dialog" tabIndex={-1} aria-busy={settling} onKeyDown={handleSurfaceKeyDown}>
        <div className={cx("interaction-dialog__hero", interaction.risk !== undefined && `interaction-dialog__hero--${interaction.risk}`)}>
          <span aria-hidden="true">{icon}</span>
          <div><strong>{interactionTitle(interaction.kind, t)}</strong>{interaction.risk !== undefined && <Pill tone={interaction.risk === "high" || interaction.risk === "critical" ? "danger" : interaction.risk === "medium" ? "warning" : "neutral"}>{t("interaction.risk", { risk: interaction.risk })}</Pill>}</div>
        </div>
        {inline && interaction.message.trim() !== "" && interaction.kind !== "plan" && <p className="interaction-takeover__message">{interaction.message}</p>}
        {interaction.expiresAt !== undefined && <p className="interaction-expiry"><Clock3 aria-hidden="true" />{t("interaction.expires", { time: formatRelativeTime(interaction.expiresAt, controller.state.preferences.locale) })}</p>}
        {interaction.kind === "permission" && interaction.permissionSubject !== undefined && <PermissionSubject subject={interaction.permissionSubject} t={t} />}
        {(interaction.kind === "question" || interaction.kind === "permission") && !ownsInteraction && <div className="interaction-ownership" role="status"><p>{ownershipStatus === "unavailable" ? t("interaction.ownershipUnavailable") : ownershipStatus === "observer" ? t("interaction.ownershipElsewhere") : ownershipStatus === "handoff" ? t("interaction.ownershipHandoff") : ownershipStatus === "settled" ? t("interaction.ownershipSettled") : t("interaction.ownershipClaiming")}</p>{ownershipStatus === "observer" && <Button onClick={continueHere}>{t("interaction.ownershipContinueHere")}</Button>}</div>}
        {interaction.kind === "permission" && <PermissionDecision disabled={!ownsInteraction || settling} interaction={interaction} onResolve={(decisionId) => resolve({ kind: "permission", decisionId })} t={t} />}
        {interaction.kind === "question" && <QuestionDecision disabled={!ownsQuestionDraft || settling} fields={interaction.fields} answers={visibleAnswers} otherText={visibleOtherText} currentIndex={visibleQuestionIndex} onCurrentIndexChange={(currentIndex) => updateQuestionDraft((draft) => ({ ...draft, currentIndex }))} onChange={(answers) => updateQuestionDraft((draft) => ({ ...draft, answers }))} onOtherTextChange={(otherText) => updateQuestionDraft((draft) => ({ ...draft, otherText }))} onMinimize={() => updateQuestionDraft((draft) => ({ ...draft, minimized: true }))} onResolve={(submittedAnswers) => resolve({ kind: "question", answers: submittedAnswers })} t={t} />}
        {interaction.kind === "select" && <OptionDecision interaction={interaction} onResolve={(value) => resolve({ kind: "extension", value })} />}
        {(interaction.kind === "input" || interaction.kind === "editor") && <TextDecision interaction={interaction} value={extensionValue} onChange={setExtensionValue} onResolve={() => resolve({ kind: "extension", value: extensionValue })} onDismiss={dismiss} t={t} />}
        {interaction.kind === "confirm" && <ConfirmDecision onResolve={(value) => resolve({ kind: "extension", value })} t={t} />}
        {interaction.kind === "plan" && <PlanDecision interaction={interaction} feedback={planFeedback} disabled={settling} onFeedback={setPlanFeedback} onResolve={(decisionId, submittedFeedback) => resolve({ kind: "plan", decisionId, feedback: submittedFeedback ?? planFeedback.trim() })} onDismiss={dismiss} t={t} />}
        {remaining > 0 && <p className="interaction-remaining"><AlertTriangle aria-hidden="true" />{t("interaction.remaining", { count: remaining })}</p>}
      </div>
  );
  if (inline) {
    return (
      <section className={cx("interaction-takeover", `interaction-takeover--${interaction.kind}`)} aria-label={interaction.title || interactionTitle(interaction.kind, t)}>
        <span ref={ownerSentinelRef} hidden />
        <header className="interaction-takeover__header"><strong>{interaction.title || interactionTitle(interaction.kind, t)}</strong>{interaction.kind === "question" && <button type="button" disabled={settling || !ownsQuestionDraft} onClick={() => updateQuestionDraft((draft) => ({ ...draft, minimized: true }))}>{t("interaction.minimize")}</button>}</header>
        {content}
      </section>
    );
  }
  return (
    <><span ref={ownerSentinelRef} hidden /><Modal open showClose closeLabel={t("interaction.minimize")} title={interaction.title || interactionTitle(interaction.kind, t)} description={interaction.message} size={interaction.kind === "editor" || interaction.kind === "plan" || interaction.fields.length > 1 ? "large" : "medium"} onClose={() => { if (interaction.kind === "question" && ownsInteraction) updateQuestionDraft((draft) => ({ ...draft, minimized: true })); else setMinimized(true); }}>
      {content}
    </Modal></>
  );
}

function MinimizedInteraction({ className, title, icon, reviewLabel, disabled, cancelDisabled, onRestore, onCancel }: {
  readonly className: string;
  readonly title: string;
  readonly icon: JSX.Element;
  readonly reviewLabel: string;
  readonly disabled: boolean;
  readonly cancelDisabled: boolean;
  readonly onRestore: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pageActiveRef = useRef(true);
  useEffect(() => {
    const button = buttonRef.current;
    const ownerWindow = button?.ownerDocument.defaultView;
    if (button === null || button === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      if (button.isConnected && button.ownerDocument.defaultView === ownerWindow && !button.disabled) button.focus();
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const ownerWindow = buttonRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const cancelOnEscape = (event: KeyboardEvent): void => {
      const button = buttonRef.current;
      if (!pageActiveRef.current || button === null || !button.isConnected || button.ownerDocument.defaultView !== ownerWindow
        || event.defaultPrevented || event.key !== "Escape" || event.repeat || event.isComposing || cancelDisabled || isInteractionEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    const retire = (): void => { pageActiveRef.current = false; };
    const restore = (): void => { pageActiveRef.current = true; };
    ownerWindow.addEventListener("keydown", cancelOnEscape, true);
    ownerWindow.addEventListener("pagehide", retire);
    ownerWindow.addEventListener("pageshow", restore);
    return () => {
      ownerWindow.removeEventListener("keydown", cancelOnEscape, true);
      ownerWindow.removeEventListener("pagehide", retire);
      ownerWindow.removeEventListener("pageshow", restore);
    };
  }, [cancelDisabled, onCancel]);

  return <button ref={buttonRef} className={className} type="button" disabled={disabled} onClick={onRestore}><span aria-hidden="true">{icon}</span><strong>{title}</strong><span>{reviewLabel}</span></button>;
}

function PermissionSubject({ subject, t }: { readonly subject: PermissionSubjectView; readonly t: Translator }): JSX.Element {
  if (subject.kind === "file") return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{t("interaction.subject.file")}</strong><Pill tone={subject.outsidePrimaryWorkspace ? "danger" : "neutral"}>{permissionActionLabel(subject.action, t)}</Pill></header>
      <SubjectRow label={t("interaction.workspace")} value={subject.workspaceId} />
      <div className="permission-subject__group"><span>{t("interaction.paths")}</span><ul>{subject.paths.map((path, index) => <li key={`${path}:${index}`}><code>{path}</code></li>)}</ul></div>
      {subject.outsidePrimaryWorkspace && <SubjectWarning>{t("interaction.outsideWorkspace")}</SubjectWarning>}
    </section>
  );
  if (subject.kind === "command") return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{t("interaction.subject.command")}</strong></header>
      <SubjectRow label={t("interaction.command")} value={formatCommand(subject.executable, subject.arguments)} code />
      <SubjectRow label={t("interaction.workingDirectory")} value={subject.workingDirectory} code />
      <div className="permission-subject__warnings">
        {subject.networkAccess && <SubjectWarning>{t("interaction.networkAccess")}</SubjectWarning>}
        {subject.writesOutsideWorkspace && <SubjectWarning>{t("interaction.writesOutsideWorkspace")}</SubjectWarning>}
        {subject.usesShell && <SubjectWarning>{t("interaction.usesShell")}</SubjectWarning>}
      </div>
    </section>
  );
  if (subject.kind === "mcp") return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{t("interaction.subject.mcp")}</strong></header>
      <SubjectRow label={t("interaction.server")} value={subject.serverId} />
      <SubjectRow label={t("interaction.tool")} value={subject.toolName} code />
      <PermissionArguments arguments={subject.arguments} t={t} />
    </section>
  );
  if (subject.kind === "browser") return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{t("interaction.subject.browser")}</strong><Pill>{permissionActionLabel(subject.action, t)}</Pill></header>
      <SubjectRow label={t("interaction.origin")} value={subject.origin} code />
      <SubjectRow label={t("interaction.provider")} value={subject.providerId} />
      <SubjectRow label={t("interaction.page")} value={subject.pageId} />
    </section>
  );
  if (subject.kind === "customTool") return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{subject.displayName || t("interaction.subject.tool")}</strong></header>
      <SubjectRow label={t("interaction.tool")} value={subject.toolId} code />
      <PermissionArguments arguments={subject.arguments} t={t} />
    </section>
  );
  return (
    <section className="permission-subject" aria-label={t("interaction.requestDetails")}>
      <header><strong>{t("interaction.subject.resource")}</strong><Pill>{permissionActionLabel(subject.action, t)}</Pill></header>
      <SubjectRow label={t("interaction.resource")} value={subject.resourceId} />
      <SubjectRow label={t("interaction.sourcePath")} value={subject.sourcePath} code />
    </section>
  );
}

function SubjectRow({ label, value, code = false }: { readonly label: string; readonly value: string; readonly code?: boolean }): JSX.Element | null {
  if (value.length === 0) return null;
  return <div className="permission-subject__row"><span>{label}</span>{code ? <code>{value}</code> : <strong>{value}</strong>}</div>;
}

function SubjectWarning({ children }: { readonly children: string }): JSX.Element {
  return <Pill tone="warning"><AlertTriangle aria-hidden="true" />{children}</Pill>;
}

function PermissionArguments({ arguments: values, t }: { readonly arguments: readonly PermissionArgumentView[]; readonly t: Translator }): JSX.Element | null {
  if (values.length === 0) return null;
  return <div className="permission-subject__arguments"><span>{t("interaction.arguments")}</span><dl>{values.map((argument, index) => <div key={`${argument.fieldPath}:${index}`}><dt><code>{argument.fieldPath || "·"}</code></dt><dd><code className={argument.redacted ? "is-redacted" : undefined}>{argument.value}</code></dd></div>)}</dl></div>;
}

function permissionActionLabel(action: Extract<PermissionSubjectView, { readonly action: string }>["action"], t: Translator): string {
  if (action === "read") return t("interaction.action.read");
  if (action === "create") return t("interaction.action.create");
  if (action === "update") return t("interaction.action.update");
  if (action === "delete") return t("interaction.action.delete");
  if (action === "move") return t("interaction.action.move");
  if (action === "readPage") return t("interaction.action.readPage");
  if (action === "navigate") return t("interaction.action.navigate");
  if (action === "interact") return t("interaction.action.interact");
  if (action === "upload") return t("interaction.action.upload");
  if (action === "download") return t("interaction.action.download");
  if (action === "takeOver") return t("interaction.action.takeOver");
  if (action === "approve") return t("interaction.action.approve");
  if (action === "install") return t("interaction.action.install");
  if (action === "enable") return t("interaction.action.enable");
  return t("common.unknown");
}

function PermissionDecision({ disabled, interaction, onResolve, t }: { readonly disabled: boolean; readonly interaction: InteractionView; readonly onResolve: (value: string) => void; readonly t: Translator }): JSX.Element {
  if (interaction.options.length === 0) {
    return <p className="interaction-empty" role="status">{t("interaction.noPermissionDecisions")}</p>;
  }
  return <div className="decision-options">{interaction.options.map((option) => {
    const denying = option.id === "4" || option.id === "5" || option.id === "6" || option.label.toLowerCase().includes("deny") || option.label.toLowerCase().includes("stop");
    const localized = permissionDecision(option.id, option.label, option.description, t);
    return <button type="button" disabled={disabled} className={cx("decision-option", denying ? "decision-option--deny" : "decision-option--allow")} key={option.id} onClick={() => onResolve(option.id)}><span>{denying ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}</span><div><strong>{localized.label}</strong><p>{localized.description}</p></div></button>;
  })}</div>;
}

function permissionDecision(id: string, fallbackLabel: string, fallbackDescription: string | undefined, t: Translator): { readonly label: string; readonly description: string } {
  if (id === "1") return { label: t("interaction.allowOnce"), description: t("interaction.allowHelp") };
  if (id === "2") return { label: t("interaction.allowTurn"), description: t("interaction.allowTurnHelp") };
  if (id === "3") return { label: t("interaction.allowTask"), description: t("interaction.allowTaskHelp") };
  if (id === "4") return { label: t("interaction.deny"), description: t("interaction.denyHelp") };
  if (id === "5") return { label: t("interaction.denyTask"), description: t("interaction.denyTaskHelp") };
  if (id === "6") return { label: t("interaction.stopTask"), description: t("interaction.stopTaskHelp") };
  return { label: fallbackLabel, description: fallbackDescription ?? t("interaction.chooseHelp") };
}

function QuestionDecision({ disabled, fields, answers, otherText, currentIndex, onCurrentIndexChange, onChange, onOtherTextChange, onMinimize, onResolve, t }: {
  readonly disabled: boolean;
  readonly fields: readonly QuestionFieldView[];
  readonly answers: AnswerMap;
  readonly otherText: Readonly<Record<string, string>>;
  readonly currentIndex: number;
  readonly onCurrentIndexChange: (index: number) => void;
  readonly onChange: (answers: AnswerMap) => void;
  readonly onOtherTextChange: (otherText: Record<string, string>) => void;
  readonly onMinimize: () => void;
  readonly onResolve: (answers: AnswerMap) => void;
  readonly t: Translator;
}): JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const step = clampQuestionStep(currentIndex, fields.length);
  const field = fields[step];
  const currentValid = field !== undefined && hasQuestionAnswer(field, answers[field.id]);
  const last = step === fields.length - 1;
  const [slideDirection, setSlideDirection] = useState<"left" | "right">();
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (transitionTimerRef.current !== undefined) clearTimeout(transitionTimerRef.current);
  }, []);
  const navigateQuestion = (nextStep: number, direction: "left" | "right"): void => {
    if (disabled || slideDirection !== undefined || nextStep < 0 || nextStep >= fields.length) return;
    setSlideDirection(direction);
    transitionTimerRef.current = setTimeout(() => {
      onCurrentIndexChange(nextStep);
      requestOwnerAnimationFrame(formRef.current, (ownerDocument) => {
        const form = formRef.current;
        if (form?.ownerDocument === ownerDocument && form.isConnected) setSlideDirection(undefined);
      });
    }, 200);
  };
  const advance = (nextAnswers: AnswerMap = answers): void => {
    if (disabled || field === undefined || !hasQuestionAnswer(field, nextAnswers[field.id])) return;
    if (last) {
      if (fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) onResolve(nextAnswers);
      return;
    }
    navigateQuestion(step + 1, "left");
  };
  const skip = (): void => {
    if (disabled || field === undefined || field.required) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[field.id];
    onChange(nextAnswers);
    if (last) {
      if (fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) onResolve(nextAnswers);
    }
    else navigateQuestion(step + 1, "left");
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
    if (disabled) return;
    if (field === undefined) return;
    if (slideDirection !== undefined) {
      if (event.key === "Enter" || event.key === "Escape" || /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const intent = resolveQuestionWizardKey({
      key: event.key,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editableTarget: isQuestionTextEntryTarget(event.target)
    }, { kind: field.kind, optionCount: field.options.length, allowOther: field.allowOther, required: field.required, currentValid });
    if (intent === null) {
      if (event.repeat && (event.key === "Enter" || event.key === "Escape" || /^[1-9]$/.test(event.key))) {
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === "Escape" && event.nativeEvent.isComposing) {
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (intent.kind === "minimize") {
      onMinimize();
      return;
    }
    if (intent.kind === "skip") {
      skip();
      return;
    }
    if (intent.kind === "advance") {
      advance();
      return;
    }
    if (intent.kind === "other") {
      const toggle = [...event.currentTarget.querySelectorAll<HTMLInputElement>("[data-question-other-toggle]")].find((candidate) => candidate.dataset.questionOtherToggle === field.id);
      toggle?.click();
      return;
    }
    const option = field.options[intent.index];
    if (option !== undefined) {
      const nextAnswers = { ...answers, [field.id]: toggleQuestionOptionAnswer(field, answers[field.id], option.id) };
      onChange(nextAnswers);
      if (field.kind === "single") advance(nextAnswers);
    }
  };
  return (
    <form ref={formRef} className="question-form question-wizard" aria-disabled={disabled} onKeyDown={handleKeyDown} onSubmit={(event) => { event.preventDefault(); if (!disabled) advance(); }}>
      <fieldset className="question-wizard__lease" disabled={disabled}>
        {fields.length === 0 && <p className="muted">{t("interaction.noFields")}</p>}
        {field !== undefined && <><div className="question-wizard__progress" aria-live="polite"><span>{t("interaction.step", { current: step + 1, total: fields.length })}</span><progress value={step + 1} max={fields.length} /></div><div className="question-wizard__scroll"><div className={cx("question-wizard__step", slideDirection === "left" && "is-leaving-left", slideDirection === "right" && "is-leaving-right")}><QuestionField key={field.id} ownerRoot={formRef} field={field} value={answers[field.id]} otherText={otherText[field.id] ?? questionOtherAnswer(field, answers[field.id])} autoFocus={!disabled} lastQuestion={last} t={t} onAdvance={advance} onSkip={skip} onMinimize={onMinimize} onSingleChoice={(choiceId) => { const nextAnswers = { ...answers, [field.id]: { kind: "single", selection: { kind: "choice", choiceId } } as const }; onChange(nextAnswers); advance(nextAnswers); }} onOtherTextChange={(value) => onOtherTextChange({ ...otherText, [field.id]: value })} onChange={(value) => onChange({ ...answers, [field.id]: value })} /></div></div></>}
        <div className="modal__actions question-wizard__actions">
          {step > 0 && <Button disabled={slideDirection !== undefined} onClick={() => navigateQuestion(step - 1, "right")}>{t("common.back")}</Button>}
          {field !== undefined && !field.required && <Button disabled={slideDirection !== undefined} onClick={skip}>{t("interaction.skip")}</Button>}
          {field?.kind !== "single" && <Button type="submit" tone="primary" disabled={slideDirection !== undefined || !currentValid || fields.length === 0}>{last ? t("interaction.submit") : t("common.continue")}</Button>}
        </div>
      </fieldset>
    </form>
  );
}

function QuestionField({ ownerRoot, field, value, otherText, autoFocus, lastQuestion, t, onChange, onOtherTextChange, onSingleChoice, onAdvance, onSkip, onMinimize }: { readonly ownerRoot: { readonly current: HTMLFormElement | null }; readonly field: QuestionFieldView; readonly value?: QuestionAnswerDraft; readonly otherText: string; readonly autoFocus: boolean; readonly lastQuestion: boolean; readonly t: Translator; readonly onChange: (value: QuestionAnswerDraft) => void; readonly onOtherTextChange: (value: string) => void; readonly onSingleChoice: (value: string) => void; readonly onAdvance: () => void; readonly onSkip: () => void; readonly onMinimize: () => void }): JSX.Element {
  const hasOtherAnswer = field.allowOther && (field.kind === "single" || field.kind === "multiple") && (otherText.trim() !== "" || questionOtherAnswer(field, value) !== "");
  const [otherExpanded, setOtherExpanded] = useState(hasOtherAnswer);
  useEffect(() => {
    if (hasOtherAnswer) setOtherExpanded(true);
  }, [field.id, hasOtherAnswer]);
  const openOther = (): void => {
    setOtherExpanded(true);
    requestOwnerAnimationFrame(ownerRoot.current, (ownerDocument) => {
      const root = ownerRoot.current;
      if (root?.ownerDocument === ownerDocument) focusQuestionOtherInput(root, field.id);
    });
  };
  const closeOther = (): void => {
    setOtherExpanded(false);
    onOtherTextChange("");
    onChange(replaceQuestionOtherAnswer(field, value, ""));
    requestOwnerAnimationFrame(ownerRoot.current, (ownerDocument) => {
      const root = ownerRoot.current;
      if (root?.ownerDocument === ownerDocument) focusQuestionOtherToggle(root, field.id);
    });
  };
  const handleTextKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) {
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (field.required) onMinimize();
      else onSkip();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onAdvance();
    }
  };
  const handleOtherKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeOther();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (otherText.trim() !== "") onAdvance();
    }
  };
  const legend = <><strong>{field.label}</strong>{field.required && <span aria-label={t("interaction.required")}> *</span>}{field.description !== undefined && <small>{field.description}</small>}</>;
  if (field.kind === "text") {
    const text = value?.kind === "text" ? value.value : "";
    return <label className="interaction-input question-field"><span>{legend}</span>{field.multiline ? <textarea autoFocus={autoFocus} rows={1} value={text} placeholder={field.placeholder} onKeyDown={handleTextKeyDown} onChange={(event) => onChange({ kind: "text", value: event.target.value })} /> : <input autoFocus={autoFocus} type="text" value={text} placeholder={field.placeholder} onKeyDown={handleTextKeyDown} onChange={(event) => onChange({ kind: "text", value: event.target.value })} />}</label>;
  }
  if (field.kind === "boolean") {
    const selected = value?.kind === "boolean" ? value.value : undefined;
    return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid"><label><RadioControl autoFocus={autoFocus} name={field.id} checked={selected === true} onChange={() => onChange({ kind: "boolean", value: true })} /><span>{t("common.yes")}</span></label><label><RadioControl name={field.id} checked={selected === false} onChange={() => onChange({ kind: "boolean", value: false })} /><span>{t("common.no")}</span></label></div></fieldset>;
  }
  if (field.kind === "single") {
    const selected = value?.kind === "single" && value.selection.kind === "choice" ? value.selection.choiceId : "";
    const custom = questionOtherAnswer(field, value);
    return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid">{field.options.map((option, index) => <label key={option.id}><RadioControl autoFocus={autoFocus && index === 0} name={field.id} checked={selected === option.id} onChange={() => onSingleChoice(option.id)} /><span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span><kbd aria-hidden="true">{index + 1}</kbd></label>)}{field.allowOther && <div className={cx("question-choice-other", custom !== "" && "is-selected", otherExpanded && "is-expanded")}>{otherExpanded ? <div className="question-choice-other__editor"><textarea data-question-other-input={field.id} rows={1} value={otherText} placeholder={t("interaction.otherPlaceholder")} onKeyDown={handleOtherKeyDown} onFocus={() => { if (otherText.trim() !== "" && custom === "") onChange(replaceQuestionOtherAnswer(field, value, otherText)); }} onChange={(event) => { onOtherTextChange(event.target.value); onChange(replaceQuestionOtherAnswer(field, value, event.target.value)); }} /><button type="button" disabled={otherText.trim() === ""} aria-label={lastQuestion ? t("interaction.submit") : t("common.continue")} onClick={onAdvance}>{lastQuestion ? t("interaction.submit") : <ArrowRight aria-hidden="true" />}</button></div> : <label><RadioControl data-question-other-toggle={field.id} name={field.id} checked={false} onChange={openOther} /><span><strong>{t("interaction.other")}</strong></span><kbd aria-hidden="true">{field.options.length + 1}</kbd></label>}</div>}</div></fieldset>;
  }
  const selected = value?.kind === "multiple" ? value.choiceIds : [];
  const custom = questionOtherAnswer(field, value);
  const minimum = Math.max(field.required ? 1 : 0, field.minimumSelections);
  const atMaximum = field.maximumSelections !== undefined && selected.length + (custom === "" ? 0 : 1) >= field.maximumSelections;
  const otherDisabled = custom === "" && atMaximum;
  return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid">{field.options.map((option, index) => <label key={option.id}><CheckboxControl autoFocus={autoFocus && index === 0} checked={selected.includes(option.id)} disabled={!selected.includes(option.id) && atMaximum} onChange={() => onChange(toggleQuestionOptionAnswer(field, value, option.id))} /><span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span><kbd aria-hidden="true">{index + 1}</kbd></label>)}{field.allowOther && <div className={cx("question-choice-other", custom !== "" && "is-selected", otherExpanded && "is-expanded")}>{otherExpanded ? <div className="question-choice-other__editor"><CheckboxControl className="question-choice-other__check" checked={custom !== ""} readOnly tabIndex={-1} aria-hidden="true" /><textarea data-question-other-input={field.id} rows={1} value={otherText} placeholder={t("interaction.otherPlaceholder")} onKeyDown={handleOtherKeyDown} onChange={(event) => { onOtherTextChange(event.target.value); onChange(replaceQuestionOtherAnswer(field, value, event.target.value)); }} /></div> : <label><CheckboxControl data-question-other-toggle={field.id} checked={false} disabled={otherDisabled} onChange={openOther} /><span><strong>{t("interaction.other")}</strong></span><kbd aria-hidden="true">{field.options.length + 1}</kbd></label>}</div>}</div><small>{field.maximumSelections === undefined ? t("interaction.selectionMinimum", { min: minimum }) : t("interaction.selectionRange", { min: minimum, max: field.maximumSelections })}</small></fieldset>;
}

function focusQuestionOtherInput(ownerRoot: HTMLElement | null, fieldId: string): void {
  const input = [...(ownerRoot?.querySelectorAll<HTMLTextAreaElement>("[data-question-other-input]") ?? [])].find((candidate) => candidate.dataset.questionOtherInput === fieldId);
  input?.focus();
}

function focusQuestionOtherToggle(ownerRoot: HTMLElement | null, fieldId: string): void {
  const input = [...(ownerRoot?.querySelectorAll<HTMLElement>("[data-question-other-toggle]") ?? [])].find((candidate) => candidate.dataset.questionOtherToggle === fieldId);
  input?.focus();
}

function isQuestionTextEntryTarget(target: EventTarget): boolean {
  const element = interactionHTMLElement(target);
  const ownerWindow = element?.ownerDocument.defaultView;
  if (element === null || ownerWindow === null || ownerWindow === undefined) return false;
  if (element instanceof ownerWindow.HTMLTextAreaElement || element.isContentEditable) return true;
  if (!(element instanceof ownerWindow.HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "submit", "reset"].includes(element.type);
}

function OptionDecision({ interaction, onResolve }: { readonly interaction: InteractionView; readonly onResolve: (value: string) => void }): JSX.Element {
  return <div className="decision-options">{interaction.options.map((option, index) => <button type="button" className="decision-option" key={option.id} onClick={() => onResolve(option.id)}><span><Check aria-hidden="true" /></span><div><strong>{option.label}</strong>{option.description !== undefined && <p>{option.description}</p>}</div><kbd aria-hidden="true">{index + 1}</kbd></button>)}</div>;
}

function TextDecision({ interaction, value, onChange, onResolve, onDismiss, t }: { readonly interaction: InteractionView; readonly value: string; readonly onChange: (value: string) => void; readonly onResolve: () => void; readonly onDismiss: () => void; readonly t: Translator }): JSX.Element {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) {
      if (event.key === "Escape") event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && value.trim() !== "") {
      event.preventDefault();
      event.stopPropagation();
      onResolve();
    }
  };
  return <form onSubmit={(event) => { event.preventDefault(); if (value.trim() !== "") onResolve(); }}><label className="interaction-input"><span>{interaction.title}</span>{interaction.kind === "editor" ? <textarea autoFocus rows={12} value={value} placeholder={interaction.placeholder} onKeyDown={handleKeyDown} onChange={(event) => onChange(event.target.value)} /> : <input autoFocus value={value} placeholder={interaction.placeholder} onKeyDown={handleKeyDown} onChange={(event) => onChange(event.target.value)} />}</label><div className="modal__actions"><Button onClick={onDismiss}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={value.trim() === ""}>{t("common.continue")}</Button></div></form>;
}

function ConfirmDecision({ onResolve, t }: { readonly onResolve: (value: boolean) => void; readonly t: Translator }): JSX.Element {
  return <div className="modal__actions interaction-confirm-actions"><Button onClick={() => onResolve(false)}>{t("common.cancel")}<kbd aria-hidden="true">2</kbd></Button><Button tone="primary" onClick={() => onResolve(true)}>{t("common.confirm")}<kbd aria-hidden="true">1</kbd></Button></div>;
}

export interface InteractionShortcutInput {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly editableTarget: boolean;
  readonly buttonTarget: boolean;
}

export type InteractionShortcutIntent =
  | { readonly kind: "resolve"; readonly decisionId: string }
  | { readonly kind: "extension"; readonly value: string | boolean }
  | { readonly kind: "dismiss" };

export function resolveInteractionShortcut(
  input: InteractionShortcutInput,
  interaction: Pick<InteractionView, "kind" | "options">
): InteractionShortcutIntent | null {
  if (input.repeat || input.isComposing || input.editableTarget || input.altKey || input.shiftKey) return null;
  if (interaction.kind === "permission") {
    if (input.key === "Escape") {
      const deny = findDecisionOption(interaction.options, ["4", "5", "6"], /deny|stop|reject/u);
      return deny === undefined ? null : { kind: "resolve", decisionId: deny.id };
    }
    if (input.key !== "Enter" || input.buttonTarget) return null;
    const allow = input.metaKey || input.ctrlKey
      ? findDecisionOption(interaction.options, ["3", "2", "1"], /allow|approve/u)
      : findDecisionOption(interaction.options, ["1"], /allow once|approve/u);
    return allow === undefined ? null : { kind: "resolve", decisionId: allow.id };
  }
  if (interaction.kind === "plan") {
    if (input.metaKey || input.ctrlKey || input.buttonTarget) return null;
    if (input.key === "Escape") return { kind: "dismiss" };
    if (input.key !== "Enter" || input.buttonTarget) return null;
    const execute = findPlanDecisionOption(interaction.options, PlanReviewDecisionKind.EXECUTE);
    return execute === undefined ? null : { kind: "resolve", decisionId: execute.id };
  }
  if (input.metaKey || input.ctrlKey) return null;
  if (interaction.kind === "select") {
    if (input.key === "Escape") return { kind: "dismiss" };
    if (!/^[1-9]$/.test(input.key)) return null;
    const option = interaction.options[Number(input.key) - 1];
    return option === undefined ? null : { kind: "extension", value: option.id };
  }
  if (interaction.kind === "confirm") {
    if (input.key === "Escape" || input.key === "2") return { kind: "extension", value: false };
    if (input.key === "1") return { kind: "extension", value: true };
  }
  return null;
}

function findDecisionOption(
  options: InteractionView["options"],
  preferredIds: readonly string[],
  fallback: RegExp
): InteractionView["options"][number] | undefined {
  for (const id of preferredIds) {
    const option = options.find((candidate) => candidate.id === id);
    if (option !== undefined) return option;
  }
  return options.find((option) => fallback.test(option.label.toLocaleLowerCase()));
}

function findPlanDecisionOption(
  options: InteractionView["options"],
  decision: PlanReviewDecisionKind
): InteractionView["options"][number] | undefined {
  return options.find((option) => option.id === String(decision));
}

export interface PlanFeedbackKeyInput {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export type PlanFeedbackKeyIntent = "collapse" | "submit" | "blockEmptySubmit" | null;

export function resolvePlanFeedbackKey(input: PlanFeedbackKeyInput, feedback: string): PlanFeedbackKeyIntent {
  if (input.repeat || input.isComposing || input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.key === "Escape") return "collapse";
  if (input.key !== "Enter" || input.shiftKey) return null;
  return feedback.trim() === "" ? "blockEmptySubmit" : "submit";
}

function isInteractionEditableTarget(target: EventTarget | null): boolean {
  const element = interactionHTMLElement(target);
  const ownerWindow = element?.ownerDocument.defaultView;
  if (element === null || ownerWindow === null || ownerWindow === undefined) return false;
  return element instanceof ownerWindow.HTMLTextAreaElement
    || element instanceof ownerWindow.HTMLInputElement
    || element instanceof ownerWindow.HTMLSelectElement
    || element.isContentEditable
    || element.closest("[contenteditable='true']") !== null;
}

function isInteractionButtonTarget(target: EventTarget | null): boolean {
  const element = interactionHTMLElement(target);
  const ownerWindow = element?.ownerDocument.defaultView;
  return element !== null && ownerWindow !== null && ownerWindow !== undefined && element instanceof ownerWindow.HTMLButtonElement;
}

function interactionHTMLElement(target: EventTarget | null): HTMLElement | null {
  if (target === null || !("ownerDocument" in target)) return null;
  const ownerDocument = (target as { readonly ownerDocument?: Document | null }).ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  return ownerWindow !== null && ownerWindow !== undefined && target instanceof ownerWindow.HTMLElement ? target : null;
}

function interactionOwnsEventTarget(owner: Element, target: EventTarget | null): boolean {
  const ownerWindow = owner.ownerDocument.defaultView;
  return ownerWindow !== null && target instanceof ownerWindow.Node && owner.contains(target);
}

function requestOwnerAnimationFrame(owner: Element | null, callback: (ownerDocument: Document) => void): void {
  const ownerDocument = owner?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
  ownerWindow.requestAnimationFrame(() => callback(ownerDocument));
}

function PlanDecision({ interaction, feedback, disabled, onFeedback, onResolve, onDismiss, t }: {
  readonly interaction: InteractionView;
  readonly feedback: string;
  readonly disabled: boolean;
  readonly onFeedback: (value: string) => void;
  readonly onResolve: (value: string, feedback?: string) => void;
  readonly onDismiss: () => void;
  readonly t: Translator;
}): JSX.Element {
  const [feedbackEditing, setFeedbackEditing] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const pageActiveRef = useRef(true);
  const feedbackRowRef = useRef<HTMLButtonElement>(null);
  const feedbackEditorRef = useRef<HTMLTextAreaElement>(null);
  const execute = findPlanDecisionOption(interaction.options, PlanReviewDecisionKind.EXECUTE);
  const refine = findPlanDecisionOption(interaction.options, PlanReviewDecisionKind.REFINE);
  const actionOptions = refine === undefined ? interaction.options : interaction.options.filter((option) => option.id !== refine.id);

  useEffect(() => {
    setFeedbackEditing(false);
  }, [interaction.id]);

  useEffect(() => {
    const preview = previewRef.current;
    const dialog = preview?.closest(".interaction-dialog");
    const ownerWindow = preview?.ownerDocument.defaultView;
    if (preview === null || preview === undefined || dialog === null || dialog === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (!pageActiveRef.current || !preview.isConnected || preview.ownerDocument.defaultView !== ownerWindow
        || event.defaultPrevented || feedbackEditing || disabled || !interactionOwnsEventTarget(dialog, event.target)) return;
      const intent = resolveInteractionShortcut({
        key: event.key,
        repeat: event.repeat,
        isComposing: event.isComposing,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: isInteractionEditableTarget(event.target),
        buttonTarget: isInteractionButtonTarget(event.target)
      }, interaction);
      if (intent === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (intent.kind === "dismiss") onDismiss();
      else if (intent.kind === "resolve") onResolve(intent.decisionId);
    };
    const retire = (): void => { pageActiveRef.current = false; };
    const restore = (): void => { pageActiveRef.current = true; };
    ownerWindow.addEventListener("keydown", handleGlobalKeyDown, true);
    ownerWindow.addEventListener("pagehide", retire);
    ownerWindow.addEventListener("pageshow", restore);
    return () => {
      ownerWindow.removeEventListener("keydown", handleGlobalKeyDown, true);
      ownerWindow.removeEventListener("pagehide", retire);
      ownerWindow.removeEventListener("pageshow", restore);
    };
  }, [disabled, feedbackEditing, interaction, onDismiss, onResolve]);

  const openFeedback = (): void => {
    if (disabled || refine === undefined) return;
    setFeedbackEditing(true);
    requestOwnerAnimationFrame(feedbackRowRef.current ?? previewRef.current, (ownerDocument) => {
      const editor = feedbackEditorRef.current;
      if (editor?.ownerDocument === ownerDocument && editor.isConnected) editor.focus();
    });
  };
  const closeFeedback = (): void => {
    setFeedbackEditing(false);
    onFeedback("");
    requestOwnerAnimationFrame(feedbackEditorRef.current ?? previewRef.current, (ownerDocument) => {
      const row = feedbackRowRef.current;
      if (row?.ownerDocument === ownerDocument && row.isConnected) row.focus();
    });
  };
  const handleFeedbackKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const intent = resolvePlanFeedbackKey({
      key: event.key,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    }, feedback);
    if (intent === null) {
      if ((event.key === "Enter" || event.key === "Escape") && (event.repeat || event.nativeEvent.isComposing)) event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (intent === "collapse") closeFeedback();
    else if (intent === "submit" && refine !== undefined) onResolve(refine.id, feedback.trim());
  };

  return <>
    <div ref={previewRef} className="plan-preview"><FileText aria-hidden="true" /><div className="markdown-body"><StreamingMarkdown text={interaction.planMarkdown ?? interaction.message} streaming={false} t={t} /></div></div>
    {interaction.planSteps.length > 0 && <ol className="plan-step-list">{interaction.planSteps.map((step) => <li key={step.id}><StatusDot state={step.state} label={step.state} /><div><strong>{step.title}</strong>{step.description !== undefined && <span>{step.description}</span>}</div></li>)}</ol>}
    {refine !== undefined && <div className={cx("plan-feedback", feedbackEditing && "is-editing")}>
      {feedbackEditing
        ? <div className="plan-feedback__editor"><Pencil aria-hidden="true" /><textarea ref={feedbackEditorRef} rows={1} disabled={disabled} aria-label={t("interaction.feedback")} value={feedback} onBlur={() => { if (feedback === "") setFeedbackEditing(false); }} onChange={(event) => onFeedback(event.target.value)} onKeyDown={handleFeedbackKeyDown} placeholder={t("interaction.feedbackPlaceholder")} />{feedback.trim() !== "" && <IconButton disabled={disabled} disabledReason={disabled ? t("common.working") : undefined} label={t("interaction.submitFeedback")} tip={t("interaction.feedbackShortcut")} onClick={() => onResolve(refine.id, feedback.trim())}><CornerDownLeft aria-hidden="true" /></IconButton>}</div>
        : <button ref={feedbackRowRef} type="button" disabled={disabled} className="plan-feedback__row" onClick={openFeedback}><Pencil aria-hidden="true" /><span>{t("interaction.feedbackPlaceholder")}</span></button>}
    </div>}
    <div className="modal__actions"><Button disabled={disabled} onClick={onDismiss}>{t("interaction.dismiss")}</Button>{actionOptions.map((option) => <Button key={option.id} disabled={disabled} tone={execute?.id === option.id ? "primary" : "secondary"} onClick={() => onResolve(option.id)}>{option.label}</Button>)}</div>
  </>;
}

function interactionTitle(kind: InteractionView["kind"], t: Translator): string {
  if (kind === "permission") return t("interaction.permission");
  if (kind === "plan") return t("interaction.plan");
  if (kind === "confirm") return t("common.confirm");
  return t("interaction.question");
}
