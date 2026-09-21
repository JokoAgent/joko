import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { MobileFilesSearchMode } from "./workspace-files";

export interface MobileFilesToolbarColors {
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly brandBackground: string;
}

export function MobileFilesToolbar({ colors, locale, location, generatedCount, navigationDisabled,
  searchDisabled, searching, query, mode, caseSensitive, onOpenWorkspace, onOpenGenerated,
  onQueryChange, onModeChange, onToggleCaseSensitive }: {
  readonly colors: MobileFilesToolbarColors;
  readonly locale: MobileSupportedLocale;
  readonly location: "workspace" | "generated";
  readonly generatedCount: number;
  readonly navigationDisabled: boolean;
  readonly searchDisabled: boolean;
  readonly searching: boolean;
  readonly query: string;
  readonly mode: MobileFilesSearchMode;
  readonly caseSensitive: boolean;
  readonly onOpenWorkspace: () => void;
  readonly onOpenGenerated: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onModeChange: (mode: MobileFilesSearchMode) => void;
  readonly onToggleCaseSensitive: () => void;
}) {
  return <>
    <View accessibilityRole="tablist" style={styles.filesTabs}>
      <ModeTab label={mobileMessage(locale, "files.workspace")} selected={location === "workspace"}
        disabled={navigationDisabled} onPress={onOpenWorkspace} colors={colors} />
      <ModeTab label={generatedCount
        ? mobileMessage(locale, "files.generatedCount", { count: generatedCount })
        : mobileMessage(locale, "files.generated")}
        selected={location === "generated"} disabled={navigationDisabled} onPress={onOpenGenerated} colors={colors} />
    </View>

    <View style={styles.filesSearchControls}>
      <TextInput accessibilityLabel={mobileMessage(locale, "files.searchLabel")}
        placeholder={mobileMessage(locale, mode === "name" ? "files.searchNames" : "files.searchContents")}
        placeholderTextColor={colors.muted} value={query} onChangeText={onQueryChange} autoCapitalize="none" autoCorrect={false}
        editable={!searchDisabled}
        style={[styles.input, styles.searchInput, { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.border }]} />
      {searching && <ActivityIndicator color={colors.accent} />}
    </View>
    <View style={styles.filesSearchOptions}>
      <View accessibilityRole="tablist" style={styles.filesSearchModes}>
        <ModeTab label={mobileMessage(locale, "files.name")} selected={mode === "name"} disabled={searchDisabled}
          onPress={() => onModeChange("name")} colors={colors} />
        <ModeTab label={mobileMessage(locale, "files.content")} selected={mode === "content"} disabled={searchDisabled}
          onPress={() => onModeChange("content")} colors={colors} />
      </View>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: caseSensitive, disabled: searchDisabled }}
        accessibilityLabel={mobileMessage(locale, "files.caseSensitiveLabel")} disabled={searchDisabled}
        onPress={onToggleCaseSensitive} style={[styles.caseChoice, searchDisabled && styles.disabled]}>
        <View style={[styles.choiceBox, { borderColor: caseSensitive ? colors.accent : colors.border,
          backgroundColor: caseSensitive ? colors.accent : colors.surface }]}>
          {caseSensitive && <Text style={styles.choiceCheck}>✓</Text>}
        </View>
        <Text style={[styles.caption, { color: colors.ink }]}>{mobileMessage(locale, "files.matchCase")}</Text>
      </Pressable>
    </View>
  </>;
}

function ModeTab({ label, selected, onPress, colors, disabled }: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly colors: MobileFilesToolbarColors;
  readonly disabled?: boolean;
}) {
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected, disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.modeTab, selected && styles.modeTabSelected, disabled && styles.disabled,
      { backgroundColor: selected ? colors.brandBackground : colors.surface }]}>
    <Text style={[styles.modeTabText, { color: colors.ink }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, fontSize: 16 },
  searchInput: { flex: 1 },
  filesTabs: { paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", gap: 8 },
  filesSearchControls: { minHeight: 52, paddingHorizontal: 16, paddingTop: 4, flexDirection: "row", alignItems: "center", gap: 10 },
  filesSearchOptions: { paddingHorizontal: 16, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  filesSearchModes: { flex: 1, flexDirection: "row", gap: 6 },
  modeTab: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  modeTabSelected: { shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  modeTabText: { fontSize: 14, fontWeight: "700" },
  caseChoice: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 7 },
  choiceBox: { width: 24, height: 24, borderWidth: 1, borderRadius: 7, alignItems: "center", justifyContent: "center", marginTop: 1 },
  choiceCheck: { color: "#2b2316", fontSize: 16, fontWeight: "800", lineHeight: 18 },
  caption: { fontSize: 13, lineHeight: 18 },
  disabled: { opacity: 0.55 }
});
