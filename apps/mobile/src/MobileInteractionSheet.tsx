import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  PermissionDecisionKind,
  PermissionRisk,
  PlanReviewDecisionKind,
  type Interaction,
  type QuestionField
} from "@joko/contracts";
import { mobileInteractionDrafts } from "./storage";
import {
  mobileInteractionDraftIdentity,
  mobileInteractionDraftIdentityKey
} from "./interaction-draft-store";
import {
  clampMobileQuestionIndex,
  initialMobileInteractionDraft,
  mobileInteractionAuthorityKey,
  mobileInteractionKindLabel,
  mobileInteractionTitle,
  mobilePermissionDecisionDanger,
  mobilePermissionDecisionLabel,
  mobilePermissionDecisionNeedsConfirmation,
  mobilePermissionDetails,
  mobilePermissionRiskLabel,
  mobilePlanDecisionLabel,
  mobilePlanStepStateLabel,
  mobileQuestionCanSubmit,
  mobileQuestionFieldError,
  setMobileQuestionOther,
  toggleMobileQuestionChoice,
  type MobileInteractionDraft,
  type MobileInteractionSubmission,
  type MobileQuestionAnswerDraft,
  type MobileQuestionAnswers
} from "./mobile-interactions";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";

export interface MobileInteractionSheetColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export function MobileInteractionSheet({
  visible,
  profileId,
  interactions,
  selectedId,
  busy,
  colors,
  onSelect,
  onMinimize,
  onResolve,
  onDismiss,
  onError
}: {
  readonly visible: boolean;
  readonly profileId?: string;
  readonly interactions: readonly Interaction[];
  readonly selectedId?: string;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onSelect: (interactionId: string) => void;
  readonly onMinimize: () => void;
  readonly onResolve: (interaction: Interaction, submission: MobileInteractionSubmission) => Promise<boolean>;
  readonly onDismiss: (interaction: Interaction) => Promise<boolean>;
  readonly onError: (message: string) => void;
}) {
  const interaction = interactions.find((candidate) => candidate.interactionId === selectedId) ?? interactions[0];
  const interactionIndex = interaction === undefined ? -1 : interactions.indexOf(interaction);
  const validation = useMemo(() => validateForDisplay(interaction), [interaction]);
  const authorityKey = interaction === undefined ? undefined : `${profileId ?? ""}\u001f${displayAuthorityKey(interaction)}`;
  const authorityRef = useRef(authorityKey);
  authorityRef.current = authorityKey;
  const identity = useMemo(() => mobileInteractionDraftIdentity(profileId, interaction), [
    profileId,
    interaction?.interactionId,
    interaction?.sessionId,
    interaction?.generation,
    interaction?.version?.revision?.value,
    interaction?.request.case
  ]);
  const identityKey = identity === undefined ? undefined : mobileInteractionDraftIdentityKey(identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(true);
  const [draft, setDraft] = useState<MobileInteractionDraft | undefined>(validation.initialDraft);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(identity === undefined ? undefined : identityKey);
  const [draftReady, setDraftReady] = useState(identity === undefined || mobileInteractionDrafts.readSync(identity) !== null);
  const [settling, setSettling] = useState(false);
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();

  useEffect(() => mobileInteractionDrafts.subscribeErrors((failedIdentity, error) => {
    if (!mountedRef.current || identityKey === undefined
      || mobileInteractionDraftIdentityKey(failedIdentity) !== identityKey) return;
    onError(error.message);
  }), [identityKey, onError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setSettling(false);
    if (identity === undefined) {
      setDraft(validation.initialDraft);
      setLoadedKey(undefined);
      setDraftReady(true);
      return;
    }
    let current = true;
    const key = mobileInteractionDraftIdentityKey(identity);
    const cached = mobileInteractionDrafts.readSync(identity);
    setDraft(cached ?? validation.initialDraft);
    setLoadedKey(key);
    setDraftReady(cached !== null);
    void mobileInteractionDrafts.read(identity).then((stored) => {
      if (!current || !mountedRef.current || identityRef.current === undefined
        || mobileInteractionDraftIdentityKey(identityRef.current) !== key) return;
      setDraft(stored ?? validation.initialDraft);
      setLoadedKey(key);
      setDraftReady(true);
    }).catch((error) => {
      if (!current || !mountedRef.current || identityRef.current === undefined
        || mobileInteractionDraftIdentityKey(identityRef.current) !== key) return;
      setDraft(validation.initialDraft);
      setLoadedKey(key);
      setDraftReady(true);
      onError(errorText(error));
    });
    return () => {
      current = false;
      void mobileInteractionDrafts.flush(identity).catch(() => undefined);
    };
  }, [identityKey, validation.initialDraft, validation.error, onError]);

  if (!interaction) return null;
  const ready = identity === undefined || loadedKey === identityKey && draftReady;
  const disabled = busy || settling || !ready;

  const updateDraft = (next: MobileInteractionDraft): void => {
    setDraft(next);
    if (!identity) return;
    try { mobileInteractionDrafts.save(identity, next); }
    catch (error) { onError(errorText(error)); }
  };

  const settle = async (submission: MobileInteractionSubmission): Promise<void> => {
    if (disabled) return;
    const currentAuthorityKey = authorityKey;
    setSettling(true);
    onError("");
    try {
      const completed = await onResolve(interaction, submission);
      if (!completed) return;
      if (identity) await mobileInteractionDrafts.clear(identity);
      if (mountedRef.current && authorityRef.current === currentAuthorityKey) setDraft(validation.initialDraft);
    } catch (error) {
      if (mountedRef.current) onError(errorText(error));
    } finally {
      if (mountedRef.current) setSettling(false);
    }
  };

  const dismiss = (): void => {
    if (disabled) return;
    Alert.alert(
      "Dismiss this request?",
      "This sends a durable dismissal to the current task. Minimizing the sheet does not dismiss it.",
      [
        { text: "Keep request", style: "cancel" },
        { text: "Dismiss", style: "destructive", onPress: () => {
          const currentAuthorityKey = authorityKey;
          setSettling(true);
          onError("");
          void onDismiss(interaction).then(async (completed) => {
            if (!completed) return;
            if (identity) await mobileInteractionDrafts.clear(identity);
            if (mountedRef.current && authorityRef.current === currentAuthorityKey) setDraft(validation.initialDraft);
          }).catch((error) => {
            if (mountedRef.current) onError(errorText(error));
          }).finally(() => {
            if (mountedRef.current) setSettling(false);
          });
        } }
      ]
    );
  };

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onMinimize}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={sheetStyles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel="Minimize request" onPress={onMinimize}
        style={sheetStyles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[sheetStyles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={sheetStyles.header}>
          <View style={sheetStyles.headerText}>
            <Text style={[sheetStyles.eyebrow, { color: colors.muted }]}>
              {mobileInteractionKindLabel(interaction)} · Request {interactionIndex + 1} of {interactions.length}
            </Text>
            <Text accessibilityRole="header" style={[sheetStyles.title, { color: colors.ink }]}>
              {mobileInteractionTitle(interaction)}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Minimize request" onPress={onMinimize}
            style={sheetStyles.iconButton}>
            <Text style={[sheetStyles.iconText, { color: colors.accent }]}>—</Text>
          </Pressable>
        </View>
        {interactions.length > 1 && <View style={sheetStyles.requestNavigation}>
          <SheetButton label="Previous request" colors={colors} quiet disabled={interactionIndex <= 0 || disabled}
            onPress={() => onSelect(interactions[interactionIndex - 1]!.interactionId)} />
          <SheetButton label="Next request" colors={colors} quiet disabled={interactionIndex >= interactions.length - 1 || disabled}
            onPress={() => onSelect(interactions[interactionIndex + 1]!.interactionId)} />
        </View>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={sheetStyles.content}>
          {validation.error !== undefined
            ? <Text accessibilityRole="alert" style={[sheetStyles.error, { color: colors.negative }]}>{validation.error}</Text>
            : !ready
              ? <Text style={[sheetStyles.body, { color: colors.muted }]}>Restoring saved response…</Text>
              : interaction.request.case === "permission"
                ? <PermissionRequest interaction={interaction} disabled={disabled} colors={colors} onResolve={(decision) => {
                  const submit = () => void settle({ kind: "permission", decision });
                  if (!mobilePermissionDecisionNeedsConfirmation(interaction, decision)) { submit(); return; }
                  Alert.alert(
                    `${mobilePermissionRiskLabel(interaction.request.case === "permission" ? interaction.request.value.risk : 0)} permission`,
                    "This approval can perform a high-impact action. Review the exact subject before continuing.",
                    [{ text: "Cancel", style: "cancel" }, { text: mobilePermissionDecisionLabel(decision), style: "destructive", onPress: submit }]
                  );
                }} />
                : interaction.request.case === "question" && draft?.kind === "question"
                  ? <QuestionRequest interaction={interaction} draft={draft} disabled={disabled} colors={colors}
                    onDraft={updateDraft} onResolve={(answers) => void settle({ kind: "question", answers })} />
                  : interaction.request.case === "planReview" && draft?.kind === "plan"
                    ? <PlanRequest interaction={interaction} draft={draft} disabled={disabled} colors={colors}
                      onDraft={updateDraft} onResolve={(decision, feedback) => void settle({ kind: "plan", decision, feedback })} />
                    : <Text accessibilityRole="alert" style={[sheetStyles.error, { color: colors.negative }]}>This response draft no longer matches the current request.</Text>}
        </ScrollView>
        <View style={[sheetStyles.footer, { borderColor: colors.border }]}>
          <SheetButton label="Dismiss request" colors={colors} quiet danger disabled={disabled} onPress={dismiss} />
          <SheetButton label="Minimize" colors={colors} quiet disabled={settling} onPress={onMinimize} />
        </View>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

function PermissionRequest({ interaction, disabled, colors, onResolve }: {
  readonly interaction: Interaction;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onResolve: (decision: PermissionDecisionKind) => void;
}) {
  if (interaction.request.case !== "permission") return null;
  const request = interaction.request.value;
  const riskDanger = request.risk !== PermissionRisk.READ_ONLY
    && request.risk !== PermissionRisk.LOW
    && request.risk !== PermissionRisk.MEDIUM;
  const details = mobilePermissionDetails(request.subject);
  return <View style={sheetStyles.sectionStack}>
    <View style={[sheetStyles.riskPill, { backgroundColor: riskDanger ? colors.negative : colors.brandBackground }]}>
      <Text style={[sheetStyles.riskText, { color: riskDanger ? "#fff" : colors.ink }]}>{mobilePermissionRiskLabel(request.risk)}</Text>
    </View>
    {request.explanation.trim() !== "" && <Text selectable style={[sheetStyles.body, { color: colors.ink }]}>{request.explanation}</Text>}
    {details.length > 0 && <View style={[sheetStyles.detailCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
      {details.map((detail, index) => <View key={`${detail.label}:${index}`} style={sheetStyles.detailRow}>
        <Text style={[sheetStyles.detailLabel, { color: colors.muted }]}>{detail.label}</Text>
        <Text selectable style={[sheetStyles.detailValue, { color: detail.redacted ? colors.muted : colors.ink }]}>{detail.value}</Text>
      </View>)}
    </View>}
    <View style={sheetStyles.decisionStack}>
      {request.allowedDecisions.map((decision) => <SheetButton key={decision} label={mobilePermissionDecisionLabel(decision)}
        colors={colors} disabled={disabled} danger={mobilePermissionDecisionDanger(decision)}
        quiet={decision === PermissionDecisionKind.DENY_ONCE || decision === PermissionDecisionKind.DENY_FOR_SESSION}
        onPress={() => onResolve(decision)} />)}
    </View>
  </View>;
}

function QuestionRequest({ interaction, draft, disabled, colors, onDraft, onResolve }: {
  readonly interaction: Interaction;
  readonly draft: Extract<MobileInteractionDraft, { readonly kind: "question" }>;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onDraft: (draft: MobileInteractionDraft) => void;
  readonly onResolve: (answers: MobileQuestionAnswers) => void;
}) {
  if (interaction.request.case !== "question") return null;
  const request = interaction.request.value;
  const index = clampMobileQuestionIndex(draft.fieldIndex, request.fields.length);
  const field = request.fields[index]!;
  const answer = draft.answers[field.fieldId];
  const fieldError = mobileQuestionFieldError(field, answer);
  const canSubmit = mobileQuestionCanSubmit(interaction, draft.answers);
  const updateAnswer = (next: MobileQuestionAnswerDraft | undefined): void => {
    const answers = { ...draft.answers };
    if (next === undefined) delete answers[field.fieldId];
    else answers[field.fieldId] = next;
    onDraft({ ...draft, fieldIndex: index, answers });
  };
  const go = (fieldIndex: number): void => onDraft({ ...draft, fieldIndex: clampMobileQuestionIndex(fieldIndex, request.fields.length) });
  return <View style={sheetStyles.sectionStack}>
    {request.prompt.trim() !== "" && <Text selectable style={[sheetStyles.body, { color: colors.ink }]}>{request.prompt}</Text>}
    <Text style={[sheetStyles.eyebrow, { color: colors.muted }]}>Question {index + 1} of {request.fields.length}</Text>
    <View style={[sheetStyles.questionCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Text style={[sheetStyles.questionLabel, { color: colors.ink }]}>{field.label || field.fieldId}{field.required ? " *" : ""}</Text>
      {field.description.trim() !== "" && <Text style={[sheetStyles.caption, { color: colors.muted }]}>{field.description}</Text>}
      <QuestionFieldInput field={field} answer={answer} disabled={disabled} colors={colors} onChange={updateAnswer} />
      {fieldError !== undefined && <Text accessibilityRole="alert" style={[sheetStyles.fieldError, { color: colors.negative }]}>{fieldError}</Text>}
    </View>
    <View style={sheetStyles.requestNavigation}>
      <SheetButton label="Back" colors={colors} quiet disabled={disabled || index === 0} onPress={() => go(index - 1)} />
      {!field.required && <SheetButton label="Skip" colors={colors} quiet disabled={disabled} onPress={() => {
        const answers = { ...draft.answers };
        delete answers[field.fieldId];
        onDraft({ ...draft, answers,
          fieldIndex: index < request.fields.length - 1 ? index + 1 : index });
      }} />}
      {index < request.fields.length - 1
        ? <SheetButton label="Continue" colors={colors} disabled={disabled || fieldError !== undefined} onPress={() => go(index + 1)} />
        : <SheetButton label="Submit answers" colors={colors} disabled={disabled || !canSubmit} onPress={() => onResolve(draft.answers)} />}
    </View>
  </View>;
}

function QuestionFieldInput({ field, answer, disabled, colors, onChange }: {
  readonly field: QuestionField;
  readonly answer: MobileQuestionAnswerDraft | undefined;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onChange: (answer: MobileQuestionAnswerDraft | undefined) => void;
}) {
  const input = field.input;
  if (input.case === "text") return <TextInput accessibilityLabel={field.label || field.fieldId}
    multiline={input.value.multiline} editable={!disabled} value={answer?.kind === "text" ? answer.value : ""}
    placeholder={input.value.placeholder || "Type your answer"} placeholderTextColor={colors.muted}
    onChangeText={(value) => onChange({ kind: "text", value })}
    style={[sheetStyles.textInput, input.value.multiline && sheetStyles.multilineInput,
      { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />;
  if (input.case === "boolean") return <View style={sheetStyles.choiceStack}>
    <ChoiceRow label="Yes" selected={answer?.kind === "boolean" && answer.value} disabled={disabled} colors={colors}
      role="radio" onPress={() => onChange({ kind: "boolean", value: true })} />
    <ChoiceRow label="No" selected={answer?.kind === "boolean" && !answer.value} disabled={disabled} colors={colors}
      role="radio" onPress={() => onChange({ kind: "boolean", value: false })} />
  </View>;
  if (input.case === "singleChoice") {
    const other = answer?.kind === "single" && answer.selection.kind === "other" ? answer.selection.text : "";
    return <View style={sheetStyles.choiceStack}>
      {input.value.choices.map((choice) => <ChoiceRow key={choice.choiceId} label={choice.label || choice.choiceId}
        description={choice.description} role="radio" disabled={disabled}
        selected={answer?.kind === "single" && answer.selection.kind === "choice" && answer.selection.choiceId === choice.choiceId}
        colors={colors} onPress={() => onChange(toggleMobileQuestionChoice(field, answer, choice.choiceId))} />)}
      {input.value.allowOther && <View style={sheetStyles.otherStack}>
        <ChoiceRow label="Other" role="radio" disabled={disabled}
          selected={answer?.kind === "single" && answer.selection.kind === "other"}
          colors={colors} onPress={() => onChange(setMobileQuestionOther(field, answer, other))} />
        <TextInput accessibilityLabel={`${field.label || field.fieldId} other response`} editable={!disabled}
          value={other} placeholder="Type another response" placeholderTextColor={colors.muted}
          onFocus={() => onChange(setMobileQuestionOther(field, answer, other))}
          onChangeText={(value) => onChange(setMobileQuestionOther(field, answer, value))}
          style={[sheetStyles.textInput, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
      </View>}
    </View>;
  }
  if (input.case === "multipleChoice") {
    const selected = answer?.kind === "multiple" ? answer.choiceIds : [];
    const other = answer?.kind === "multiple" ? answer.otherText ?? "" : "";
    const maximum = input.value.maximumSelections === 0 ? undefined : input.value.maximumSelections;
    const atMaximum = maximum !== undefined && selected.length + (answer?.kind === "multiple" && answer.otherText !== undefined ? 1 : 0) >= maximum;
    const minimum = Math.max(field.required ? 1 : 0, input.value.minimumSelections);
    return <View style={sheetStyles.choiceStack}>
      {input.value.choices.map((choice) => {
        const checked = selected.includes(choice.choiceId);
        return <ChoiceRow key={choice.choiceId} label={choice.label || choice.choiceId} description={choice.description}
          role="checkbox" selected={checked} disabled={disabled || atMaximum && !checked} colors={colors}
          onPress={() => onChange(toggleMobileQuestionChoice(field, answer, choice.choiceId))} />;
      })}
      {input.value.allowOther && <View style={sheetStyles.otherStack}>
        <TextInput accessibilityLabel={`${field.label || field.fieldId} other response`} editable={!disabled && (!atMaximum || other !== "")}
          value={other} placeholder="Add another response" placeholderTextColor={colors.muted}
          onChangeText={(value) => onChange(setMobileQuestionOther(field, answer, value))}
          style={[sheetStyles.textInput, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
      </View>}
      <Text style={[sheetStyles.caption, { color: colors.muted }]}>
        Select at least {minimum}{maximum === undefined ? "" : ` and at most ${maximum}`}.
      </Text>
    </View>;
  }
  return null;
}

function PlanRequest({ interaction, draft, disabled, colors, onDraft, onResolve }: {
  readonly interaction: Interaction;
  readonly draft: Extract<MobileInteractionDraft, { readonly kind: "plan" }>;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onDraft: (draft: MobileInteractionDraft) => void;
  readonly onResolve: (decision: PlanReviewDecisionKind, feedback: string) => void;
}) {
  if (interaction.request.case !== "planReview") return null;
  const request = interaction.request.value;
  return <View style={sheetStyles.sectionStack}>
    <Text selectable style={[sheetStyles.planText, { color: colors.ink, backgroundColor: colors.background, borderColor: colors.border }]}>
      {request.markdown || "No plan text was supplied."}
    </Text>
    {request.steps.length > 0 && <View style={sheetStyles.stepStack}>
      {request.steps.map((step, index) => <View key={step.stepId} style={[sheetStyles.stepCard, { borderColor: colors.border }]}>
        <Text style={[sheetStyles.questionLabel, { color: colors.ink }]}>{index + 1}. {step.title || step.stepId}</Text>
        <Text style={[sheetStyles.eyebrow, { color: colors.muted }]}>{mobilePlanStepStateLabel(step.state)}</Text>
        {step.description.trim() !== "" && <Text style={[sheetStyles.caption, { color: colors.muted }]}>{step.description}</Text>}
      </View>)}
    </View>}
    <View style={sheetStyles.otherStack}>
      <Text style={[sheetStyles.questionLabel, { color: colors.ink }]}>Feedback</Text>
      <TextInput accessibilityLabel="Plan feedback" multiline editable={!disabled} value={draft.feedback}
        placeholder="Describe changes if the plan needs refinement" placeholderTextColor={colors.muted}
        onChangeText={(feedback) => onDraft({ kind: "plan", feedback })}
        style={[sheetStyles.textInput, sheetStyles.multilineInput,
          { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]} />
    </View>
    <View style={sheetStyles.decisionStack}>
      {request.allowedDecisions.map((decision) => <SheetButton key={decision} label={mobilePlanDecisionLabel(decision)}
        colors={colors} disabled={disabled || decision === PlanReviewDecisionKind.REFINE && draft.feedback.trim() === ""}
        quiet={decision === PlanReviewDecisionKind.STAY_IN_PLAN_MODE}
        onPress={() => onResolve(decision, draft.feedback)} />)}
    </View>
  </View>;
}

function ChoiceRow({ label, description, selected, disabled, role, colors, onPress }: {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly role: "radio" | "checkbox";
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole={role} accessibilityState={{ checked: selected, disabled }} disabled={disabled}
    onPress={onPress} style={[sheetStyles.choiceRow, disabled && sheetStyles.disabled, { borderColor: selected ? colors.accent : colors.border }]}>
    <View style={[sheetStyles.choiceMark, { borderColor: selected ? colors.accent : colors.border, backgroundColor: selected ? colors.accent : colors.surface }]}>
      {selected && <Text style={sheetStyles.choiceCheck}>✓</Text>}
    </View>
    <View style={sheetStyles.flex}>
      <Text style={[sheetStyles.choiceLabel, { color: colors.ink }]}>{label}</Text>
      {description !== undefined && description.trim() !== "" && <Text style={[sheetStyles.caption, { color: colors.muted }]}>{description}</Text>}
    </View>
  </Pressable>;
}

function SheetButton({ label, colors, onPress, disabled, quiet, danger }: {
  readonly label: string;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly quiet?: boolean;
  readonly danger?: boolean;
}) {
  const background = disabled ? colors.border : quiet ? colors.surface : danger ? colors.negative : colors.accent;
  const foreground = disabled ? colors.muted : danger && !quiet ? "#fff" : quiet ? (danger ? colors.negative : colors.accent) : "#2b2316";
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={[sheetStyles.button, quiet && { borderWidth: 1, borderColor: danger ? colors.negative : colors.border }, { backgroundColor: background }]}>
    <Text style={[sheetStyles.buttonText, { color: foreground }]}>{label}</Text>
  </Pressable>;
}

function validateForDisplay(interaction: Interaction | undefined): { readonly initialDraft?: MobileInteractionDraft; readonly error?: string } {
  if (!interaction) return {};
  try { return { initialDraft: initialMobileInteractionDraft(interaction) }; }
  catch (error) { return { error: errorText(error) }; }
}

function displayAuthorityKey(interaction: Interaction): string {
  try { return mobileInteractionAuthorityKey(interaction); }
  catch {
    return [interaction.sessionId, interaction.backendId, interaction.targetId, interaction.interactionId,
      interaction.kind.toString(10), interaction.request.case, interaction.generation.toString(10),
      interaction.version?.generation.toString(10) ?? "0",
      interaction.version?.revision?.value.toString(10) ?? "0"].join("\u001f");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "This request could not be updated.";
}

const sheetStyles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "94%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 76, paddingHorizontal: 18, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  headerText: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 26, lineHeight: 30, fontWeight: "700" },
  requestNavigation: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8, paddingHorizontal: 18, paddingBottom: 8 },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 22 },
  sectionStack: { gap: 14 },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
  error: { fontSize: 15, lineHeight: 22, paddingVertical: 14 },
  fieldError: { fontSize: 13, lineHeight: 18 },
  riskPill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  riskText: { fontSize: 12, lineHeight: 16, fontWeight: "700" },
  detailCard: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 8, gap: 4 },
  detailRow: { minHeight: 44, paddingVertical: 7, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  detailLabel: { width: 104, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  detailValue: { flex: 1, fontSize: 14, lineHeight: 20 },
  decisionStack: { gap: 9 },
  questionCard: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  questionLabel: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  textInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10, fontSize: 16, lineHeight: 22 },
  multilineInput: { minHeight: 112, textAlignVertical: "top" },
  choiceStack: { gap: 8 },
  choiceRow: { minHeight: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "flex-start", gap: 10 },
  choiceMark: { width: 24, height: 24, borderWidth: 1, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  choiceCheck: { color: "#2b2316", fontSize: 16, lineHeight: 18, fontWeight: "800" },
  choiceLabel: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  otherStack: { gap: 8 },
  planText: { borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 22 },
  stepStack: { gap: 8 },
  stepCard: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  footer: { minHeight: 64, borderTopWidth: 1, paddingHorizontal: 18, paddingVertical: 10, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 },
  button: { minHeight: 44, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 14, lineHeight: 20, fontWeight: "700" },
  flex: { flex: 1 },
  disabled: { opacity: 0.55 }
});
