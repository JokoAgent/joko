import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { PlanReviewDecisionKind } from "@joko/contracts";
import { AlertTriangle, ArrowRight, Check, Clock3, CornerDownLeft, FileText, HelpCircle, ListChecks, Pencil, Shield, X } from "lucide-react";
import type { AppController } from "../controller.js";
import type { InteractionResolutionDraft, InteractionView, PermissionArgumentView, PermissionSubjectView, QuestionAnswerDraft, QuestionFieldView } from "../model.js";
import { formatCommand } from "../permission-format.js";
import { QuestionWizardDraftStore, clampQuestionStep, hasQuestionAnswer, initialQuestionAnswers, questionOtherAnswer, replaceQuestionOtherAnswer, resolveQuestionWizardKey, toggleQuestionOptionAnswer, validQuestionAnswer } from "./coding-ui-behavior.js";
import { StreamingMarkdown } from "./Timeline.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, StatusDot, cx, formatRelativeTime, CheckboxControl, RadioControl } from "./ui.js";

type AnswerMap = Record<string, QuestionAnswerDraft>;

const questionDrafts = new QuestionWizardDraftStore();

export function InteractionDialog({ controller, interaction, remaining, inline = false, t, runAction }: {
  readonly controller: AppController;
  readonly interaction?: InteractionView;
  readonly remaining: number;
  readonly inline?: boolean;
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element | null {
  const interactionDraftKey = interaction === undefined ? undefined : `${interaction.sessionId}\u0000${interaction.id}`;
  const initialDraft = interaction === undefined ? undefined : questionDrafts.read(interaction.sessionId, interaction.id);
  const [answers, setAnswers] = useState<AnswerMap>(() => initialDraft?.answers ?? { ...initialQuestionAnswers(interaction?.fields ?? []) });
  const [questionOtherText, setQuestionOtherText] = useState<Record<string, string>>(() => ({ ...initialDraft?.otherText }));
  const [questionIndex, setQuestionIndex] = useState(() => clampQuestionStep(initialDraft?.currentIndex ?? 0, interaction?.fields.length ?? 0));
  const [questionDraftOwner, setQuestionDraftOwner] = useState<string | undefined>(interactionDraftKey);
  const [extensionValue, setExtensionValue] = useState(interaction?.prefill ?? "");
  const [planFeedback, setPlanFeedback] = useState("");
  const [minimized, setMinimized] = useState(initialDraft?.minimized ?? false);
  const [settling, setSettling] = useState(false);
  const settlingRef = useRef(false);
  const dialogContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = interaction === undefined ? undefined : questionDrafts.read(interaction.sessionId, interaction.id);
    setAnswers(stored?.answers ?? { ...initialQuestionAnswers(interaction?.fields ?? []) });
    setQuestionOtherText({ ...stored?.otherText });
    setQuestionIndex(clampQuestionStep(stored?.currentIndex ?? 0, interaction?.fields.length ?? 0));
    setExtensionValue(interaction?.prefill ?? "");
    setPlanFeedback("");
    setMinimized(stored?.minimized ?? false);
    settlingRef.current = false;
    setSettling(false);
    setQuestionDraftOwner(interactionDraftKey);
  }, [interaction?.id, interactionDraftKey]);

  useEffect(() => {
    if (interaction?.kind !== "question" || interactionDraftKey === undefined || questionDraftOwner !== interactionDraftKey) return;
    questionDrafts.write(interaction.sessionId, interaction.id, { answers, otherText: questionOtherText, currentIndex: questionIndex, minimized });
  }, [answers, interaction?.id, interaction?.kind, interaction?.sessionId, interactionDraftKey, minimized, questionDraftOwner, questionIndex, questionOtherText]);

  useEffect(() => {
    if (interaction?.kind !== "question" || minimized) return;
    const frame = requestAnimationFrame(() => dialogContentRef.current?.querySelector<HTMLElement>(".question-field input, .question-field textarea")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [interaction?.id, interaction?.kind, minimized, questionIndex]);

  useEffect(() => {
    if (!inline || minimized || (interaction?.kind !== "permission" && interaction?.kind !== "plan" && interaction?.kind !== "select" && interaction?.kind !== "confirm")) return;
    const frame = requestAnimationFrame(() => dialogContentRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [inline, interaction?.id, interaction?.kind, minimized]);

  if (interaction === undefined) return null;
  const ownsQuestionDraft = questionDraftOwner === interactionDraftKey;
  const visibleAnswers: AnswerMap = ownsQuestionDraft ? answers : initialDraft?.answers ?? { ...initialQuestionAnswers(interaction.fields) };
  const visibleOtherText: Readonly<Record<string, string>> = ownsQuestionDraft ? questionOtherText : initialDraft?.otherText ?? {};
  const visibleQuestionIndex = ownsQuestionDraft ? questionIndex : clampQuestionStep(initialDraft?.currentIndex ?? 0, interaction.fields.length);
  const visibleMinimized = ownsQuestionDraft ? minimized : initialDraft?.minimized ?? false;
  const settle = (key: string, action: () => Promise<void>): void => {
    if (settlingRef.current) return;
    settlingRef.current = true;
    setSettling(true);
    runAction(key, async () => {
      try {
        await action();
        questionDrafts.delete(interaction.sessionId, interaction.id);
      } catch (error) {
        settlingRef.current = false;
        setSettling(false);
        throw error;
      }
    });
  };
  const resolve = (resolution: InteractionResolutionDraft): void => settle(`interaction:${interaction.id}`, () => controller.resolveInteraction(interaction, resolution));
  const dismiss = (): void => settle(`dismiss:${interaction.id}`, () => controller.dismissInteraction(interaction));
  const skipCurrentQuestion = (): void => {
    const field = interaction.kind === "question" ? interaction.fields[visibleQuestionIndex] : undefined;
    if (field === undefined || field.required) {
      setMinimized(false);
      return;
    }
    const nextAnswers = { ...visibleAnswers };
    delete nextAnswers[field.id];
    setAnswers(nextAnswers);
    if (visibleQuestionIndex === interaction.fields.length - 1) {
      if (interaction.fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) resolve({ kind: "question", answers: nextAnswers });
      else setMinimized(false);
    }
    else setQuestionIndex(visibleQuestionIndex + 1);
  };
  const icon = interaction.kind === "permission" ? <Shield /> : interaction.kind === "plan" ? <ListChecks /> : interaction.kind === "confirm" ? <HelpCircle /> : <FileText />;
  const handleSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (interaction.kind === "plan") return;
    const intent = resolveInteractionShortcut({
      key: event.key,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editableTarget: isInteractionEditableTarget(event.target),
      buttonTarget: event.target instanceof HTMLButtonElement
    }, interaction);
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (intent.kind === "dismiss") dismiss();
    else if (intent.kind === "extension") resolve({ kind: "extension", value: intent.value });
    else if (interaction.kind === "permission") resolve({ kind: "permission", decisionId: intent.decisionId });
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
    return <MinimizedInteraction className={inline ? "interaction-takeover-minimized" : "interaction-minimized"} title={interaction.title || interactionTitle(interaction.kind, t)} icon={icon} reviewLabel={reviewLabel} disabled={settling} onRestore={() => setMinimized(false)} onCancel={cancelMinimized} />;
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
        {interaction.kind === "permission" && <PermissionDecision interaction={interaction} onResolve={(decisionId) => resolve({ kind: "permission", decisionId })} t={t} />}
        {interaction.kind === "question" && <QuestionDecision fields={interaction.fields} answers={visibleAnswers} otherText={visibleOtherText} currentIndex={visibleQuestionIndex} onCurrentIndexChange={setQuestionIndex} onChange={setAnswers} onOtherTextChange={setQuestionOtherText} onMinimize={() => setMinimized(true)} onResolve={(submittedAnswers) => resolve({ kind: "question", answers: submittedAnswers })} t={t} />}
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
        <header className="interaction-takeover__header"><strong>{interaction.title || interactionTitle(interaction.kind, t)}</strong>{interaction.kind === "question" && <button type="button" disabled={settling} onClick={() => setMinimized(true)}>{t("interaction.minimize")}</button>}</header>
        {content}
      </section>
    );
  }
  return (
    <Modal open showClose closeLabel={t("interaction.minimize")} title={interaction.title || interactionTitle(interaction.kind, t)} description={interaction.message} size={interaction.kind === "editor" || interaction.kind === "plan" || interaction.fields.length > 1 ? "large" : "medium"} onClose={() => setMinimized(true)}>
      {content}
    </Modal>
  );
}

function MinimizedInteraction({ className, title, icon, reviewLabel, disabled, onRestore, onCancel }: {
  readonly className: string;
  readonly title: string;
  readonly icon: JSX.Element;
  readonly reviewLabel: string;
  readonly disabled: boolean;
  readonly onRestore: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.repeat || event.isComposing || disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [disabled, onCancel]);

  return <button className={className} type="button" disabled={disabled} onClick={onRestore}><span aria-hidden="true">{icon}</span><strong>{title}</strong><span>{reviewLabel}</span></button>;
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

function PermissionDecision({ interaction, onResolve, t }: { readonly interaction: InteractionView; readonly onResolve: (value: string) => void; readonly t: Translator }): JSX.Element {
  const options = interaction.options.length > 0 ? interaction.options : [
    { id: "4", label: t("interaction.deny"), description: t("interaction.denyHelp") },
    { id: "1", label: t("interaction.allowOnce"), description: t("interaction.allowHelp") }
  ];
  return <div className="decision-options">{options.map((option) => {
    const denying = option.id === "4" || option.id === "5" || option.id === "6" || option.label.toLowerCase().includes("deny") || option.label.toLowerCase().includes("stop");
    const localized = permissionDecision(option.id, option.label, option.description, t);
    return <button type="button" className={cx("decision-option", denying ? "decision-option--deny" : "decision-option--allow")} key={option.id} onClick={() => onResolve(option.id)}><span>{denying ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}</span><div><strong>{localized.label}</strong><p>{localized.description}</p></div></button>;
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

function QuestionDecision({ fields, answers, otherText, currentIndex, onCurrentIndexChange, onChange, onOtherTextChange, onMinimize, onResolve, t }: {
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
    if (slideDirection !== undefined || nextStep < 0 || nextStep >= fields.length) return;
    setSlideDirection(direction);
    transitionTimerRef.current = setTimeout(() => {
      onCurrentIndexChange(nextStep);
      requestAnimationFrame(() => setSlideDirection(undefined));
    }, 200);
  };
  const advance = (nextAnswers: AnswerMap = answers): void => {
    if (field === undefined || !hasQuestionAnswer(field, nextAnswers[field.id])) return;
    if (last) {
      if (fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) onResolve(nextAnswers);
      return;
    }
    navigateQuestion(step + 1, "left");
  };
  const skip = (): void => {
    if (field === undefined || field.required) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[field.id];
    onChange(nextAnswers);
    if (last) {
      if (fields.every((candidate) => validQuestionAnswer(candidate, nextAnswers[candidate.id]))) onResolve(nextAnswers);
    }
    else navigateQuestion(step + 1, "left");
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>): void => {
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
    }, { kind: field.kind, optionCount: field.options.length, required: field.required, currentValid });
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
    <form className="question-form question-wizard" onKeyDown={handleKeyDown} onSubmit={(event) => { event.preventDefault(); advance(); }}>
      {fields.length === 0 && <p className="muted">{t("interaction.noFields")}</p>}
      {field !== undefined && <><div className="question-wizard__progress" aria-live="polite"><span>{t("interaction.step", { current: step + 1, total: fields.length })}</span><progress value={step + 1} max={fields.length} /></div><div className="question-wizard__scroll"><div className={cx("question-wizard__step", slideDirection === "left" && "is-leaving-left", slideDirection === "right" && "is-leaving-right")}><QuestionField key={field.id} field={field} value={answers[field.id]} otherText={otherText[field.id] ?? questionOtherAnswer(field, answers[field.id])} autoFocus lastQuestion={last} t={t} onAdvance={advance} onSkip={skip} onMinimize={onMinimize} onSingleChoice={(value) => { const nextAnswers = { ...answers, [field.id]: value }; onChange(nextAnswers); advance(nextAnswers); }} onOtherTextChange={(value) => onOtherTextChange({ ...otherText, [field.id]: value })} onChange={(value) => onChange({ ...answers, [field.id]: value })} /></div></div></>}
      <div className="modal__actions question-wizard__actions">
        {step > 0 && <Button disabled={slideDirection !== undefined} onClick={() => navigateQuestion(step - 1, "right")}>{t("common.back")}</Button>}
        {field !== undefined && !field.required && <Button disabled={slideDirection !== undefined} onClick={skip}>{t("interaction.skip")}</Button>}
        {field?.kind !== "single" && <Button type="submit" tone="primary" disabled={slideDirection !== undefined || !currentValid || fields.length === 0}>{last ? t("interaction.submit") : t("common.continue")}</Button>}
      </div>
    </form>
  );
}

function QuestionField({ field, value, otherText, autoFocus, lastQuestion, t, onChange, onOtherTextChange, onSingleChoice, onAdvance, onSkip, onMinimize }: { readonly field: QuestionFieldView; readonly value?: QuestionAnswerDraft; readonly otherText: string; readonly autoFocus: boolean; readonly lastQuestion: boolean; readonly t: Translator; readonly onChange: (value: QuestionAnswerDraft) => void; readonly onOtherTextChange: (value: string) => void; readonly onSingleChoice: (value: string) => void; readonly onAdvance: () => void; readonly onSkip: () => void; readonly onMinimize: () => void }): JSX.Element {
  const hasOtherAnswer = (field.kind === "single" || field.kind === "multiple") && (otherText.trim() !== "" || questionOtherAnswer(field, value) !== "");
  const [otherExpanded, setOtherExpanded] = useState(hasOtherAnswer);
  useEffect(() => {
    if (hasOtherAnswer) setOtherExpanded(true);
  }, [field.id, hasOtherAnswer]);
  const openOther = (): void => {
    setOtherExpanded(true);
    requestAnimationFrame(() => focusQuestionOtherInput(field.id));
  };
  const closeOther = (): void => {
    setOtherExpanded(false);
    onOtherTextChange("");
    onChange(replaceQuestionOtherAnswer(field, value, ""));
    requestAnimationFrame(() => focusQuestionOtherToggle(field.id));
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
    const text = typeof value === "string" ? value : "";
    return <label className="interaction-input question-field"><span>{legend}</span>{field.multiline ? <textarea autoFocus={autoFocus} rows={1} value={text} placeholder={field.placeholder} onKeyDown={handleTextKeyDown} onChange={(event) => onChange(event.target.value)} /> : <input autoFocus={autoFocus} type={field.sensitive ? "password" : "text"} autoComplete={field.sensitive ? "off" : undefined} value={text} placeholder={field.placeholder} onKeyDown={handleTextKeyDown} onChange={(event) => onChange(event.target.value)} />}{field.sensitive && <small><Shield aria-hidden="true" />{t("interaction.sensitiveHelp")}</small>}</label>;
  }
  if (field.kind === "boolean") {
    const selected = typeof value === "boolean" ? value : undefined;
    return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid"><label><RadioControl autoFocus={autoFocus} name={field.id} checked={selected === true} onChange={() => onChange(true)} /><span>{t("common.yes")}</span></label><label><RadioControl name={field.id} checked={selected === false} onChange={() => onChange(false)} /><span>{t("common.no")}</span></label></div></fieldset>;
  }
  if (field.kind === "single") {
    const selected = typeof value === "string" ? value : "";
    const custom = questionOtherAnswer(field, value);
    return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid">{field.options.map((option, index) => <label key={option.id}><RadioControl autoFocus={autoFocus && index === 0} name={field.id} checked={selected === option.id} onChange={() => onSingleChoice(option.id)} /><span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span><kbd aria-hidden="true">{index + 1}</kbd></label>)}<div className={cx("question-choice-other", custom !== "" && "is-selected", otherExpanded && "is-expanded")}>{otherExpanded ? <div className="question-choice-other__editor"><textarea data-question-other-input={field.id} rows={1} value={otherText} placeholder={t("interaction.otherPlaceholder")} onKeyDown={handleOtherKeyDown} onFocus={() => { if (otherText.trim() !== "" && custom === "") onChange(replaceQuestionOtherAnswer(field, value, otherText)); }} onChange={(event) => { onOtherTextChange(event.target.value); onChange(replaceQuestionOtherAnswer(field, value, event.target.value)); }} /><button type="button" disabled={otherText.trim() === ""} aria-label={lastQuestion ? t("interaction.submit") : t("common.continue")} onClick={onAdvance}>{lastQuestion ? t("interaction.submit") : <ArrowRight aria-hidden="true" />}</button></div> : <label><RadioControl data-question-other-toggle={field.id} name={field.id} checked={false} onChange={openOther} /><span><strong>{t("interaction.other")}</strong></span><kbd aria-hidden="true">{field.options.length + 1}</kbd></label>}</div></div></fieldset>;
  }
  const selected = Array.isArray(value) ? value : [];
  const custom = questionOtherAnswer(field, value);
  const minimum = Math.max(field.required ? 1 : 0, field.minimumSelections);
  const atMaximum = field.maximumSelections !== undefined && selected.length >= field.maximumSelections;
  const otherDisabled = custom === "" && atMaximum;
  return <fieldset className="question-field"><legend>{legend}</legend><div className="question-choice-grid">{field.options.map((option, index) => <label key={option.id}><CheckboxControl autoFocus={autoFocus && index === 0} checked={selected.includes(option.id)} disabled={!selected.includes(option.id) && atMaximum} onChange={() => onChange(toggleQuestionOptionAnswer(field, value, option.id))} /><span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span><kbd aria-hidden="true">{index + 1}</kbd></label>)}<div className={cx("question-choice-other", custom !== "" && "is-selected", otherExpanded && "is-expanded")}>{otherExpanded ? <div className="question-choice-other__editor"><CheckboxControl className="question-choice-other__check" checked={custom !== ""} readOnly tabIndex={-1} aria-hidden="true" /><textarea data-question-other-input={field.id} rows={1} value={otherText} placeholder={t("interaction.otherPlaceholder")} onKeyDown={handleOtherKeyDown} onChange={(event) => { onOtherTextChange(event.target.value); onChange(replaceQuestionOtherAnswer(field, value, event.target.value)); }} /></div> : <label><CheckboxControl data-question-other-toggle={field.id} checked={false} disabled={otherDisabled} onChange={openOther} /><span><strong>{t("interaction.other")}</strong></span><kbd aria-hidden="true">{field.options.length + 1}</kbd></label>}</div></div><small>{field.maximumSelections === undefined ? t("interaction.selectionMinimum", { min: minimum }) : t("interaction.selectionRange", { min: minimum, max: field.maximumSelections })}</small></fieldset>;
}

function focusQuestionOtherInput(fieldId: string): void {
  const input = [...document.querySelectorAll<HTMLTextAreaElement>("[data-question-other-input]")].find((candidate) => candidate.dataset.questionOtherInput === fieldId);
  input?.focus();
}

function focusQuestionOtherToggle(fieldId: string): void {
  const input = [...document.querySelectorAll<HTMLInputElement>("[data-question-other-toggle]")].find((candidate) => candidate.dataset.questionOtherToggle === fieldId);
  input?.focus();
}

function isQuestionTextEntryTarget(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "submit", "reset"].includes(target.type);
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
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target.isContentEditable || target.closest("[contenteditable='true']") !== null;
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
  const feedbackRowRef = useRef<HTMLButtonElement>(null);
  const feedbackEditorRef = useRef<HTMLTextAreaElement>(null);
  const execute = findPlanDecisionOption(interaction.options, PlanReviewDecisionKind.EXECUTE);
  const refine = findPlanDecisionOption(interaction.options, PlanReviewDecisionKind.REFINE);
  const actionOptions = refine === undefined ? interaction.options : interaction.options.filter((option) => option.id !== refine.id);

  useEffect(() => {
    setFeedbackEditing(false);
  }, [interaction.id]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (feedbackEditing || disabled) return;
      const intent = resolveInteractionShortcut({
        key: event.key,
        repeat: event.repeat,
        isComposing: event.isComposing,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: isInteractionEditableTarget(event.target),
        buttonTarget: event.target instanceof HTMLButtonElement
      }, interaction);
      if (intent === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (intent.kind === "dismiss") onDismiss();
      else if (intent.kind === "resolve") onResolve(intent.decisionId);
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [disabled, feedbackEditing, interaction, onDismiss, onResolve]);

  const openFeedback = (): void => {
    if (disabled || refine === undefined) return;
    setFeedbackEditing(true);
    requestAnimationFrame(() => feedbackEditorRef.current?.focus());
  };
  const closeFeedback = (): void => {
    setFeedbackEditing(false);
    onFeedback("");
    requestAnimationFrame(() => feedbackRowRef.current?.focus());
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
    <div className="plan-preview"><FileText aria-hidden="true" /><div className="markdown-body"><StreamingMarkdown text={interaction.planMarkdown ?? interaction.message} streaming={false} t={t} /></div></div>
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
