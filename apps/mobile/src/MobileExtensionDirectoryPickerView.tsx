import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import type { ExtensionDirectoryPickerEntry } from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export interface MobileExtensionDirectoryPickerViewProps {
  readonly title: string; readonly purpose?: string; readonly colors: MobilePartnersColors & { readonly dark?: boolean }; readonly locale: MobileSupportedLocale;
  readonly path: string; readonly busy: boolean; readonly error?: string; readonly directory?: ExtensionDirectoryPickerEntry;
  readonly entries: readonly ExtensionDirectoryPickerEntry[]; readonly canChoose: boolean; readonly canMore: boolean;
  readonly onPath: (path: string) => void; readonly onGo: () => void; readonly onBrowse: (entryId: string) => void;
  readonly onMore: () => void; readonly onRetry: () => void; readonly onCancel: () => void; readonly onChoose: () => void;
}
export function MobileExtensionDirectoryPickerView(props: MobileExtensionDirectoryPickerViewProps) {
  const t = (key: Parameters<typeof mobileMessage>[1]) => mobileMessage(props.locale, key);
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled} accessibilityState={{ disabled }} onPress={action} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }}>
    <Text style={{ color: disabled ? props.colors.muted : props.colors.accent }}>{label}</Text>
  </Pressable>;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onCancel}>
    <View accessibilityViewIsModal style={{ flex: 1, padding: 20, gap: 12, backgroundColor: props.colors.background }}>
      <Text accessibilityRole="header" style={{ color: props.colors.ink, fontSize: 20 }}>{props.title}</Text>
      <Text style={{ color: props.colors.muted }}>{t("extension.directory.title")}</Text>
      {props.purpose && <Text style={{ color: props.colors.muted }}>{props.purpose}</Text>}
      <TextInput accessibilityLabel={t("extension.directory.path")} value={props.path} editable={!props.busy} onChangeText={props.onPath} maxLength={4096}
        autoCapitalize="none" autoCorrect={false} onSubmitEditing={props.onGo} style={{ minHeight: 44, borderWidth: 1, borderColor: props.colors.border, color: props.colors.ink, padding: 10 }} />
      {button(t("extension.directory.go"), props.onGo, props.busy || !props.path)}
      {props.directory?.parentEntryId && button(t("extension.directory.parent"), () => props.onBrowse(props.directory!.parentEntryId!), props.busy)}
      {props.busy && <ActivityIndicator color={props.colors.accent} />}
      {props.error && <Text accessibilityRole="alert" style={{ color: props.colors.negative }}>{props.error}</Text>}
      <FlatList data={props.entries} keyExtractor={entry => entry.entryId} renderItem={({ item }) => button(item.name, () => props.onBrowse(item.entryId), props.busy)}
        ListFooterComponent={props.canMore ? button(t("extension.directory.more"), props.onMore) : undefined} />
      {props.error && button(t("common.retry"), props.onRetry, props.busy)}
      {button(t("extension.directory.choose"), props.onChoose, !props.canChoose)}
      {button(t("common.cancel"), props.onCancel)}
    </View>
  </Modal>;
}
