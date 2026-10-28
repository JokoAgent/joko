import { useEffect } from "react";
import { Host } from "@expo/ui";
import { BottomSheet, Button, Form, Group, Section, Text, TextField, ProgressView, useNativeState } from "@expo/ui/swift-ui";
import { accessibilityLabel, disabled, foregroundStyle, presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import { mobileMessage } from "./mobile-messages";
import type { MobileExtensionDirectoryPickerViewProps } from "./MobileExtensionDirectoryPickerView";

export function MobileExtensionDirectoryPickerView(props: MobileExtensionDirectoryPickerViewProps) {
  const text = useNativeState(props.path);
  useEffect(() => { if (text.get() !== props.path) text.set(props.path); }, [props.path, text]);
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  return <Host colorScheme={props.colors.dark === undefined ? undefined : props.colors.dark ? "dark" : "light"} seedColor={props.colors.ink} pointerEvents="none" style={{ position: "absolute" }}>
    <BottomSheet isPresented onIsPresentedChange={value => { if (!value) props.onCancel(); }}>
      <Group modifiers={[presentationDragIndicator("visible")]}><Form>
        <Section title={props.title}><Text>{t("extension.directory.title")}</Text>{props.purpose && <Text>{props.purpose}</Text>}
          <Button label={t("common.cancel")} onPress={props.onCancel} />
        </Section>
        <Section title={t("extension.directory.path")}>
          <TextField text={text} onTextChange={props.onPath} maxLength={4096} modifiers={[disabled(props.busy), accessibilityLabel(t("extension.directory.path"))]} />
          <Button label={t("extension.directory.go")} onPress={props.onGo} modifiers={[disabled(props.busy || !props.path)]} />
        </Section>
        <Section>
          {props.directory?.parentEntryId && <Button label={t("extension.directory.parent")} systemImage="chevron.up" onPress={() => props.onBrowse(props.directory!.parentEntryId!)} modifiers={[disabled(props.busy)]} />}
          {props.entries.map(entry => <Button key={entry.entryId} label={entry.name} systemImage="folder" onPress={() => props.onBrowse(entry.entryId)} modifiers={[disabled(props.busy)]} />)}
          {props.canMore && <Button label={t("extension.directory.more")} onPress={props.onMore} modifiers={[disabled(props.busy)]} />}
          {props.busy && <ProgressView />}
        </Section>
        {props.error && <Section><Text modifiers={[foregroundStyle(props.colors.negative)]}>{props.error}</Text><Button label={t("common.retry")} onPress={props.onRetry} modifiers={[disabled(props.busy)]} /></Section>}
        <Section><Button label={t("extension.directory.choose")} onPress={props.onChoose} modifiers={[disabled(!props.canChoose)]} /></Section>
      </Form></Group>
    </BottomSheet>
  </Host>;
}
