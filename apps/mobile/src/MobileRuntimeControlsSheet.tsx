import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { PermissionMode } from "@joko/contracts";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import {
  assertMobileModelSelection,
  defaultMobileModelSelection,
  filterMobileModelRoutes,
  formatMobileTokenLimit,
  mobilePermissionModeDescription,
  mobilePermissionModeLabel,
  type MobileModelControlSelection,
  type MobileModelRoute,
  type MobileRuntimeControls
} from "./mobile-runtime-controls";

type RuntimeControlsView =
  | { readonly kind: "root" }
  | { readonly kind: "model"; readonly routeKey: string }
  | { readonly kind: "permission" }
  | { readonly kind: "permission-confirm" };

export function MobileRuntimeControlsSheet({
  visible,
  controls,
  busy,
  colors,
  locale,
  onClose,
  onSetModel,
  onSetPermission,
  onSetPlanMode,
  onError
}: {
  readonly visible: boolean;
  readonly controls?: MobileRuntimeControls;
  readonly busy: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onSetModel: (authorityKey: string, selection: MobileModelControlSelection) => Promise<boolean>;
  readonly onSetPermission: (authorityKey: string, mode: PermissionMode) => Promise<boolean>;
  readonly onSetPlanMode: (authorityKey: string, enabled: boolean) => Promise<boolean>;
  readonly onError: (message: string) => void;
}) {
  const [view, setView] = useState<RuntimeControlsView>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<MobileModelControlSelection>();
  const [settling, setSettling] = useState(false);
  const mountedRef = useRef(true);
  const surfaceOwnerRef = useRef(controls?.surfaceOwnerKey);
  surfaceOwnerRef.current = controls?.surfaceOwnerKey;
  const keyboard = useMobileKeyboardState();
  const safeArea = useSafeAreaInsets();
  const routes = useMemo(
    () => filterMobileModelRoutes(controls?.models ?? [], query),
    [controls?.models, query]
  );
  const activeRoute = view.kind === "model"
    ? controls?.models.find((route) => route.key === view.routeKey)
    : undefined;
  const disabled = busy || settling;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setView({ kind: "root" });
    setQuery("");
    setSelection(undefined);
    setSettling(false);
  }, [controls?.surfaceOwnerKey, visible]);

  useEffect(() => {
    if (view.kind === "model" && activeRoute === undefined) {
      setView({ kind: "root" });
      setSelection(undefined);
    }
  }, [activeRoute, view.kind]);

  if (!controls) return null;

  const back = (): void => {
    if (disabled) return;
    if (view.kind === "root") onClose();
    else {
      setView({ kind: "root" });
      setSelection(undefined);
    }
  };

  const openModel = (route: MobileModelRoute): void => {
    if (disabled) return;
    setSelection(defaultMobileModelSelection(controls, route));
    setView({ kind: "model", routeKey: route.key });
  };

  const settle = async (action: (authorityKey: string) => Promise<boolean>): Promise<void> => {
    if (disabled) return;
    const authorityKey = controls.authorityKey;
    const surfaceOwnerKey = controls.surfaceOwnerKey;
    setSettling(true);
    onError("");
    try {
      const completed = await action(authorityKey);
      if (completed && mountedRef.current && surfaceOwnerRef.current === surfaceOwnerKey) onClose();
    } catch (error) {
      if (mountedRef.current && surfaceOwnerRef.current === surfaceOwnerKey) onError(errorText(error, locale));
    } finally {
      if (mountedRef.current) setSettling(false);
    }
  };

  const applyModel = (): void => {
    if (!selection) return;
    try {
      const validated = assertMobileModelSelection(controls, selection);
      void settle((authorityKey) => onSetModel(authorityKey, validated));
    } catch {
      onError(mobileMessage(locale, "controls.modelInvalid"));
    }
  };

  const choosePermission = (mode: PermissionMode): void => {
    if (disabled || mode === controls.session.permissionMode) return;
    if (mode === PermissionMode.BYPASS_PERMISSIONS) {
      setView({ kind: "permission-confirm" });
      return;
    }
    void settle((authorityKey) => onSetPermission(authorityKey, mode));
  };

  const title = mobileMessage(locale, view.kind === "root" ? "controls.title"
    : view.kind === "model" ? "controls.modelOptions"
      : view.kind === "permission" ? "controls.permissionMode" : "controls.fullAccessQuestion");
  const subtitle = view.kind === "root" ? controls.backend.displayName || controls.backend.backendId
    : view.kind === "model" ? activeRoute?.providerName ?? mobileMessage(locale, "controls.currentModel")
      : mobileMessage(locale, view.kind === "permission" ? "controls.choosePolicy" : "controls.highImpact");

  return <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={back}>
    <MobileKeyboardAvoidingView keyboard={keyboard} consumedBottomInset={safeArea.bottom}
      behavior={Platform.OS === "android" ? "height" : undefined} style={styles.modalRoot}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale,
        view.kind === "root" ? "controls.close" : "controls.back")}
        disabled={disabled} onPress={back} style={styles.backdrop} />
      <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
        style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          {view.kind !== "root" && <IconButton label={mobileMessage(locale, "common.back")} text="‹" disabled={disabled} colors={colors}
            onPress={() => { setView({ kind: "root" }); setSelection(undefined); }} />}
          <View style={styles.headerText}>
            <Text style={[styles.eyebrow, { color: colors.muted }]} numberOfLines={1}>{subtitle}</Text>
            <Text style={[styles.title, { color: colors.ink }]} numberOfLines={2}>{title}</Text>
          </View>
          <IconButton label={mobileMessage(locale, "controls.close")} text="×" disabled={disabled} colors={colors} onPress={onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {view.kind === "root" && <RootControls controls={controls} routes={routes} query={query}
            disabled={disabled} colors={colors} locale={locale} onQuery={setQuery} onOpenModel={openModel}
            onOpenPermission={() => setView({ kind: "permission" })}
            onSetPlanMode={(enabled) => void settle((authorityKey) => onSetPlanMode(authorityKey, enabled))} />}
          {view.kind === "model" && activeRoute && selection && <ModelOptions route={activeRoute}
            controls={controls} selection={selection} disabled={disabled} colors={colors} locale={locale}
            onSelection={setSelection} onApply={applyModel} />}
          {view.kind === "permission" && <PermissionOptions controls={controls} disabled={disabled} locale={locale}
            colors={colors} onSelect={choosePermission} />}
          {view.kind === "permission-confirm" && <PermissionConfirmation disabled={disabled} colors={colors} locale={locale}
            onCancel={() => setView({ kind: "permission" })}
            onConfirm={() => void settle((authorityKey) => onSetPermission(authorityKey, PermissionMode.BYPASS_PERMISSIONS))} />}
        </ScrollView>
      </SafeAreaView>
    </MobileKeyboardAvoidingView>
  </Modal>;
}

function RootControls({ controls, routes, query, disabled, colors, locale, onQuery, onOpenModel, onOpenPermission, onSetPlanMode }: {
  readonly controls: MobileRuntimeControls;
  readonly routes: readonly MobileModelRoute[];
  readonly query: string;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onQuery: (query: string) => void;
  readonly onOpenModel: (route: MobileModelRoute) => void;
  readonly onOpenPermission: () => void;
  readonly onSetPlanMode: (enabled: boolean) => void;
}) {
  const current = controls.currentModel;
  const configurableCurrent = current?.route !== undefined && current.selectable
    && (controls.canSetEffort || controls.canSetFastMode);
  let previousProvider = "";
  return <View style={styles.stack}>
    <SectionTitle label={mobileMessage(locale, "common.model")} colors={colors} />
    {current ? <Pressable accessibilityRole={configurableCurrent ? "button" : undefined}
      accessibilityLabel={mobileMessage(locale, "controls.currentModelLabel", { name: current.displayName })}
      disabled={disabled || !configurableCurrent}
      onPress={() => current.route && onOpenModel(current.route)}
      style={[styles.currentCard, { borderColor: current.selectable ? colors.accent : colors.border,
        backgroundColor: colors.background }, disabled && styles.disabled]}>
      <View style={styles.flex}>
        <Text style={[styles.rowLabel, { color: colors.ink }]}>{current.displayName}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{current.providerName} · {current.providerId}/{current.modelId}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {current.effortId ? mobileMessage(locale, "controls.effortValue", { effort: current.effortId })
            : mobileMessage(locale, "controls.defaultEffort")}{current.fastMode ? mobileMessage(locale, "controls.fastSuffix") : ""}
        </Text>
        {!current.selectable && <Text style={[styles.warning, { color: colors.negative }]}>{mobileMessage(locale, "controls.routeUnavailable")}</Text>}
      </View>
      {configurableCurrent && <Text style={[styles.disclosure, { color: colors.accent }]}>{mobileMessage(locale, "common.options")}</Text>}
    </Pressable> : <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "controls.noCurrentRoute")}</Text>}

    {controls.canSwitchModel && <>
      <TextInput accessibilityLabel={mobileMessage(locale, "controls.searchModelsLabel")} value={query} editable={!disabled}
        onChangeText={onQuery} placeholder={mobileMessage(locale, "controls.searchModels")} placeholderTextColor={colors.muted}
        style={[styles.search, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.background }]} />
      {routes.map((route) => {
        const showProvider = route.providerId !== previousProvider;
        previousProvider = route.providerId;
        const selected = current?.providerId === route.providerId && current.modelId === route.modelId;
        return <View key={route.key}>
          {showProvider && <Text style={[styles.providerHeading, { color: colors.muted }]}>{route.providerName}</Text>}
          <Pressable accessibilityRole="radio" accessibilityState={{ selected, disabled }} disabled={disabled}
            accessibilityLabel={`${route.displayName}, ${route.providerName}`}
            onPress={() => onOpenModel(route)}
            style={[styles.routeRow, { borderColor: selected ? colors.accent : colors.border }, disabled && styles.disabled]}>
            <View style={styles.flex}>
              <Text style={[styles.rowLabel, { color: colors.ink }]}>{route.displayName}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>{formatMobileTokenLimit(route.contextWindowTokens, locale)} · {route.modelId}</Text>
            </View>
            <Text style={[styles.disclosure, { color: selected ? colors.accent : colors.muted }]}>{selected ? "✓" : "›"}</Text>
          </Pressable>
        </View>;
      })}
      {routes.length === 0 && <Text style={[styles.body, { color: colors.muted }]}>
        {mobileMessage(locale, query.trim() ? "controls.noModelMatch" : "controls.noTextModel")}
      </Text>}
    </>}

    {controls.canSetPermission && <>
      <SectionTitle label={mobileMessage(locale, "common.permission")} colors={colors} />
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "controls.changePermission")} disabled={disabled}
        onPress={onOpenPermission} style={[styles.settingRow, { borderColor: colors.border }, disabled && styles.disabled]}>
        <View style={styles.flex}>
          <Text style={[styles.rowLabel, { color: colors.ink }]}>{mobilePermissionModeLabel(controls.session.permissionMode, locale)}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobilePermissionModeDescription(controls.session.permissionMode, locale)}</Text>
        </View>
        <Text style={[styles.disclosure, { color: colors.accent }]}>{mobileMessage(locale, "common.change")}</Text>
      </Pressable>
    </>}

    {controls.canSetPlanMode && <>
      <SectionTitle label={mobileMessage(locale, "controls.planMode")} colors={colors} />
      <View style={[styles.settingRow, { borderColor: colors.border }]}>
        <View style={styles.flex}>
          <Text style={[styles.rowLabel, { color: colors.ink }]}>{mobileMessage(locale, "controls.planBefore")}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "controls.planDescription")}</Text>
        </View>
        <Switch accessibilityLabel={mobileMessage(locale, "controls.planMode")} accessibilityState={{ disabled }} disabled={disabled}
          value={controls.session.planMode} onValueChange={onSetPlanMode}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface} />
      </View>
    </>}
    {!controls.canSwitchModel && !configurableCurrent && !controls.canSetPermission && !controls.canSetPlanMode
      && <Text style={[styles.body, { color: colors.muted }]}>{mobileMessage(locale, "controls.noneMutable")}</Text>}
  </View>;
}

function ModelOptions({ route, controls, selection, disabled, colors, locale, onSelection, onApply }: {
  readonly route: MobileModelRoute;
  readonly controls: MobileRuntimeControls;
  readonly selection: MobileModelControlSelection;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onSelection: (selection: MobileModelControlSelection) => void;
  readonly onApply: () => void;
}) {
  let selectionValid = true;
  let validationError: string | undefined;
  try { assertMobileModelSelection(controls, selection); }
  catch {
    selectionValid = false;
    const current = controls.currentModel;
    const unchanged = current?.providerId === selection.providerId && current.modelId === selection.modelId
      && (current.effortId ?? "") === (selection.effortId ?? "")
      && (current.fastMode ?? false) === selection.fastMode;
    if (!unchanged) validationError = mobileMessage(locale, "controls.modelInvalid");
  }
  return <View style={styles.stack}>
    <View style={[styles.currentCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Text style={[styles.modelTitle, { color: colors.ink }]}>{route.displayName}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{route.providerName} · {route.providerId}/{route.modelId}</Text>
      <Text style={[styles.caption, { color: colors.muted }]}>{formatMobileTokenLimit(route.contextWindowTokens, locale)}</Text>
    </View>
    {controls.canSetEffort && route.efforts.length > 0 && <>
      <SectionTitle label={mobileMessage(locale, "common.effort")} colors={colors} />
      <View style={styles.choiceStack}>
        {route.efforts.map((effort) => <ChoiceRow key={effort.id} label={effort.label}
          description={effort.default ? mobileMessage(locale, "controls.backendDefault") : undefined}
          selected={selection.effortId === effort.id} disabled={disabled} colors={colors}
          onPress={() => onSelection({ ...selection, effortId: effort.id })} />)}
      </View>
    </>}
    {controls.canSetFastMode && <>
      <SectionTitle label={mobileMessage(locale, "controls.fastMode")} colors={colors} />
      <View style={[styles.settingRow, { borderColor: colors.border }]}>
        <View style={styles.flex}>
          <Text style={[styles.rowLabel, { color: colors.ink }]}>{mobileMessage(locale, "controls.faster")}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{route.supportsFastMode
            ? mobileMessage(locale, "controls.fastSupported") : mobileMessage(locale, "controls.fastUnsupported")}</Text>
        </View>
        <Switch accessibilityLabel={mobileMessage(locale, "controls.fastMode")} accessibilityState={{ disabled: disabled || !route.supportsFastMode }}
          disabled={disabled || !route.supportsFastMode} value={selection.fastMode}
          onValueChange={(fastMode) => onSelection({ ...selection, fastMode })}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface} />
      </View>
    </>}
    {validationError && <Text accessibilityRole="alert" style={[styles.warning, { color: colors.negative }]}>{validationError}</Text>}
    <SheetButton label={mobileMessage(locale, "controls.applyModel")} disabled={disabled || !selectionValid}
      colors={colors} onPress={onApply} />
  </View>;
}

function PermissionOptions({ controls, disabled, colors, locale, onSelect }: {
  readonly controls: MobileRuntimeControls;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onSelect: (mode: PermissionMode) => void;
}) {
  return <View style={styles.choiceStack}>
    {controls.permissionModes.map((mode) => <ChoiceRow key={mode} label={mobilePermissionModeLabel(mode, locale)}
      description={mobilePermissionModeDescription(mode, locale)} selected={mode === controls.session.permissionMode}
      disabled={disabled || mode === controls.session.permissionMode} danger={mode === PermissionMode.BYPASS_PERMISSIONS}
      colors={colors} onPress={() => onSelect(mode)} />)}
  </View>;
}

function PermissionConfirmation({ disabled, colors, locale, onCancel, onConfirm }: {
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return <View style={styles.stack}>
    <View style={[styles.riskCard, { borderColor: colors.negative, backgroundColor: colors.background }]}>
      <Text style={[styles.modelTitle, { color: colors.negative }]}>{mobileMessage(locale, "controls.fullAccessTitle")}</Text>
      <Text style={[styles.body, { color: colors.ink }]}>{mobileMessage(locale, "controls.fullAccessBody")}</Text>
    </View>
    <View style={styles.actions}>
      <SheetButton label={mobileMessage(locale, "common.cancel")} quiet disabled={disabled} colors={colors} onPress={onCancel} />
      <SheetButton label={mobileMessage(locale, "controls.enableFullAccess")} danger disabled={disabled} colors={colors} onPress={onConfirm} />
    </View>
  </View>;
}

function ChoiceRow({ label, description, selected, disabled, danger, colors, onPress }: {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly danger?: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected, disabled }} disabled={disabled}
    onPress={onPress} style={[styles.routeRow, { borderColor: selected ? colors.accent : danger ? colors.negative : colors.border },
      disabled && styles.disabled]}>
    <View style={styles.flex}>
      <Text style={[styles.rowLabel, { color: danger ? colors.negative : colors.ink }]}>{label}</Text>
      {description && <Text style={[styles.caption, { color: colors.muted }]}>{description}</Text>}
    </View>
    <Text style={[styles.disclosure, { color: selected ? colors.accent : colors.muted }]}>{selected ? "✓" : "›"}</Text>
  </Pressable>;
}

function SectionTitle({ label, colors }: { readonly label: string; readonly colors: MobileInteractionSheetColors }) {
  return <Text style={[styles.sectionTitle, { color: colors.muted }]}>{label}</Text>;
}

function IconButton({ label, text, disabled, colors, onPress }: {
  readonly label: string;
  readonly text: string;
  readonly disabled: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[styles.iconButton, disabled && styles.disabled]}>
    <Text style={[styles.iconText, { color: colors.ink }]}>{text}</Text>
  </Pressable>;
}

function SheetButton({ label, disabled, quiet, danger, colors, onPress }: {
  readonly label: string;
  readonly disabled: boolean;
  readonly quiet?: boolean;
  readonly danger?: boolean;
  readonly colors: MobileInteractionSheetColors;
  readonly onPress: () => void;
}) {
  const backgroundColor = disabled ? colors.border : quiet ? colors.surface : danger ? colors.negative : colors.accent;
  const color = disabled ? colors.muted : quiet ? colors.accent : danger ? "#fff" : "#2b2316";
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={[styles.button, quiet && { borderWidth: 1, borderColor: colors.border }, { backgroundColor }]}>
    <Text style={[styles.buttonText, { color }]}>{label}</Text>
  </Pressable>;
}

function errorText(error: unknown, locale: MobileSupportedLocale): string {
  return error instanceof Error ? error.message : mobileMessage(locale, "controls.changeError");
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.42)" },
  sheet: { maxHeight: "94%", borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" },
  header: { minHeight: 76, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  headerText: { flex: 1, gap: 3 },
  eyebrow: { fontSize: 12, lineHeight: 17, fontWeight: "700", textTransform: "uppercase" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 30, lineHeight: 34, fontWeight: "500" },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 26 },
  stack: { gap: 12 },
  flex: { flex: 1 },
  sectionTitle: { marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: "800", textTransform: "uppercase" },
  currentCard: { minHeight: 68, borderWidth: 1, borderRadius: 16, padding: 13, flexDirection: "row", alignItems: "center", gap: 10 },
  settingRow: { minHeight: 60, borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  routeRow: { minHeight: 56, borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  rowLabel: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  modelTitle: { fontSize: 18, lineHeight: 24, fontWeight: "800" },
  caption: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 22 },
  warning: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  disclosure: { minHeight: 44, minWidth: 44, textAlign: "right", textAlignVertical: "center", fontSize: 14, lineHeight: 44, fontWeight: "700" },
  search: { minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9, fontSize: 16, lineHeight: 22 },
  providerHeading: { marginTop: 4, marginBottom: -4, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  choiceStack: { gap: 9 },
  riskCard: { borderWidth: 1, borderRadius: 16, padding: 15, gap: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 9 },
  button: { minHeight: 48, borderRadius: 13, paddingHorizontal: 17, paddingVertical: 11, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  disabled: { opacity: 0.5 }
});
