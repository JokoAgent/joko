import { Host } from "@expo/ui";
import { BottomSheet, Button, DisclosureGroup, Form, Group, Picker, ProgressView, Section, Text, TextField, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonStyle, disabled, font, foregroundStyle, frame, lineLimit, pickerStyle, presentationDragIndicator, tag } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import type { MobileObjectiveNativeSheetProps } from "./MobileObjectiveNativeSheet";
import { mobileMessage } from "./mobile-messages";
import { formatMobileObjectiveTokens, mobileObjectiveDefaultLimits, mobileObjectivePresets, type MobileObjectiveLimits } from "./mobile-objective";

export function MobileObjectiveNativeSheet(props: MobileObjectiveNativeSheetProps) {
  return <Host colorScheme={props.dark === undefined ? undefined : props.dark ? "dark" : "light"} seedColor={props.colors.accent}
    pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented={props.visible} onIsPresentedChange={value => { if (!value && !props.busy) props.onClose(); }}>
      <Group modifiers={[presentationDragIndicator("visible")]}><Content {...props} /></Group>
    </BottomSheet>
  </Host>;
}
function Content(props: MobileObjectiveNativeSheetProps) {
  const { colors, locale, objective, disabled: readOnly, busy } = props;
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(locale, key);
  const action = (key: "objective.pause" | "objective.resume" | "objective.clear", onPress: () => void) =>
    <Button label={t(key)} onPress={onPress} modifiers={[buttonStyle("plain"), disabled(busy || readOnly),
      frame({ minHeight: 44 }), foregroundStyle(key === "objective.clear" ? colors.negative : colors.ink)]} />;
  return <Form>
    <Section title={t("objective.title")}>
      <Button label={t("common.close")} systemImage="xmark" onPress={props.onClose} modifiers={[disabled(busy)]} />
      {props.loading && <><ProgressView /><Text>{t("objective.loading")}</Text></>}
    </Section>
    {!props.loading && (objective ? <>
      <Section title={t(`objective.${objective.status}`)}>
        <Text>{objective.text}</Text>
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.muted)]}>{mobileMessage(locale, "objective.progress", {
          turns: `${objective.turnsUsed}${objective.maximumTurns === null ? "" : ` / ${objective.maximumTurns}`}`,
          tokens: `${formatMobileObjectiveTokens(objective.tokensUsed)}${objective.tokenBudget === null ? "" : ` / ${formatMobileObjectiveTokens(objective.tokenBudget)}`}`
        })}</Text>
        {objective.lastReason !== "" && <Text modifiers={[foregroundStyle(colors.muted)]}>{objective.lastReason}</Text>}
      </Section>
      <Section>
        {objective.status === "active" && action("objective.pause", props.onPause)}
        {["paused", "blocked", "usageLimited"].includes(objective.status) && action("objective.resume", props.onResume)}
        {action("objective.clear", props.onClear)}
      </Section>
    </> : <CreateForm {...props} />)}
    {(props.error || readOnly) && <Section><Text modifiers={[foregroundStyle(props.error ? colors.negative : colors.muted)]}>{props.error || t("objective.readOnly")}</Text></Section>}
    {props.onRetry && <Section><Button label={t("objective.check")} onPress={props.onRetry} modifiers={[disabled(busy)]} /></Section>}
  </Form>;
}
function CreateForm(props: MobileObjectiveNativeSheetProps) {
  const { colors, locale, busy } = props;
  const initial = props.initial;
  const nativeText = useNativeState(initial?.text ?? ""), [text, setText] = useState(initial?.text ?? "");
  const [limits, setLimits] = useState<MobileObjectiveLimits>(initial?.limits ?? mobileObjectiveDefaultLimits);
  const [touched, setTouched] = useState(initial?.limits !== undefined), [expanded, setExpanded] = useState(false);
  return <>
    <Section title={mobileMessage(locale, "objective.label")}>
      <TextField text={nativeText} onTextChange={setText} axis="vertical" placeholder={mobileMessage(locale, "objective.placeholder")}
        modifiers={[lineLimit({ min: 3, max: 6 }), disabled(busy), accessibilityLabel(mobileMessage(locale, "objective.label"))]} />
    </Section>
    <Section><DisclosureGroup label={mobileMessage(locale, "objective.advanced")} isExpanded={expanded} onIsExpandedChange={setExpanded}>
      <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.muted)]}>{mobileMessage(locale, "objective.hint")}</Text>
      {(["maximumTurns", "tokenBudget", "noProgressTurnLimit"] as const).map(field => {
        const presets: readonly number[] = mobileObjectivePresets[field], value = limits[field];
        const options = value !== null && !presets.includes(value) ? [value, ...presets] : presets;
        return <Picker key={field} label={mobileMessage(locale, `objective.${field}`)} selection={value ?? "unlimited"}
          onSelectionChange={(next: number | string) => { setTouched(true); setLimits(current => ({ ...current, [field]: typeof next === "number" ? next : null })); }}
          modifiers={[pickerStyle("menu"), disabled(busy)]}>
          {options.map(option => <Text key={option} modifiers={[tag(option)]}>{field === "tokenBudget" ? formatMobileObjectiveTokens(option) : String(option)}</Text>)}
          <Text modifiers={[tag("unlimited")]}>{mobileMessage(locale, "objective.unlimited")}</Text>
        </Picker>;
      })}
    </DisclosureGroup></Section>
    <Section><Button onPress={() => { const value = nativeText.get().trim(); if (value && !busy && !props.disabled) props.onSet({ text: value, ...(touched ? { limits } : {}) }); }}
      modifiers={[buttonStyle("borderedProminent"), frame({ maxWidth: Infinity, minHeight: 44 }), disabled(busy || props.disabled || !text.trim())]}>
      {busy ? <ProgressView /> : <Text>{mobileMessage(locale, "objective.start")}</Text>}
    </Button></Section>
  </>;
}
