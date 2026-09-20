import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { Image as ExpoImage, type ImageProps as ExpoImageProps } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  type MobilePhotoLibrary,
  type MobilePhotoLibraryAsset,
  type MobilePhotoLibraryCatalog,
  type MobilePhotoLibraryKind
} from "./mobile-photo-library";

const PhotoPreviewImage = ExpoImage as unknown as ComponentType<ExpoImageProps>;

interface PhotoLibraryColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
  readonly brandBackground: string;
}

export function MobilePhotoLibrarySheet({
  visible,
  ownerKey,
  maximumSelection,
  colors,
  library,
  onAdd,
  onClose
}: {
  visible: boolean;
  ownerKey?: string;
  maximumSelection: number;
  colors: PhotoLibraryColors;
  library: MobilePhotoLibrary;
  onAdd: (assets: readonly MobilePhotoLibraryAsset[]) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<MobilePhotoLibraryKind>("recent");
  const [catalog, setCatalog] = useState<MobilePhotoLibraryCatalog>();
  const [selected, setSelected] = useState<readonly MobilePhotoLibraryAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);
  const { width } = useWindowDimensions();
  const thumbSize = Math.max(1, Math.floor((width - 48) / 3));
  const selectedOrder = useMemo(
    () => new Map(selected.map((asset, index) => [asset.id, index + 1])),
    [selected]
  );

  const load = async (requestPermission: boolean): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError("");
    try {
      const next = await library.loadCatalog(kind, requestPermission);
      if (generation !== loadGenerationRef.current) return;
      setCatalog(next);
      if (next.status === "ready") {
        const visibleIds = new Set(next.assets.map((asset) => asset.id));
        setSelected((current) => current.filter((asset) => visibleIds.has(asset.id)));
      } else {
        setSelected([]);
      }
    } catch (failure) {
      if (generation === loadGenerationRef.current) setError(errorText(failure));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadGenerationRef.current += 1;
    setKind("recent");
    setCatalog(undefined);
    setSelected([]);
    setError("");
    setSubmitting(false);
  }, [ownerKey]);

  useEffect(() => {
    if (!visible || !ownerKey) return;
    void load(true);
    return () => { loadGenerationRef.current += 1; };
  }, [visible, ownerKey, kind]);

  const toggle = (asset: MobilePhotoLibraryAsset): void => {
    if (submitting) return;
    setError("");
    setSelected((current) => {
      const existing = current.findIndex((candidate) => candidate.id === asset.id);
      if (existing >= 0) return current.filter((_, index) => index !== existing);
      if (current.length >= maximumSelection) {
        setError(`Select no more than ${maximumSelection} photo${maximumSelection === 1 ? "" : "s"}.`);
        return current;
      }
      return [...current, asset];
    });
  };

  const submit = async (): Promise<void> => {
    if (selected.length === 0 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onAdd(selected);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setSubmitting(false);
    }
  };

  const manageLimited = async (): Promise<void> => {
    if (loading || submitting) return;
    setLoading(true);
    setError("");
    try {
      await library.manageLimitedAccess();
      await load(false);
    } catch (failure) {
      setError(errorText(failure));
      setLoading(false);
    }
  };

  const openSettings = async (): Promise<void> => {
    setError("");
    try { await library.openSettings(); }
    catch (failure) { setError(errorText(failure)); }
  };

  const assets = catalog?.status === "ready" ? catalog.assets : [];
  const denied = catalog?.status === "denied" ? catalog : undefined;
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Photos</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>Choose up to {maximumSelection} for this message.</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close photo library"
          disabled={submitting} onPress={onClose} style={[styles.close, submitting && styles.disabled]}>
          <Text style={[styles.closeText, { color: colors.accent }]}>Close</Text>
        </Pressable>
      </View>

      <View accessibilityRole="tablist" style={[styles.tabs, { borderColor: colors.border }]}>
        {(["recent", "screenshots"] as const).map((candidate) => {
          const active = kind === candidate;
          return <Pressable key={candidate} accessibilityRole="tab" accessibilityState={{ selected: active }}
            accessibilityLabel={candidate === "recent" ? "Recent photos" : "Screenshots"}
            disabled={submitting} onPress={() => setKind(candidate)}
            style={[styles.tab, active && { backgroundColor: colors.brandBackground }]}>
            <Text style={[styles.tabText, { color: active ? colors.ink : colors.muted }]}>
              {candidate === "recent" ? "Recent" : "Screenshots"}
            </Text>
          </Pressable>;
        })}
      </View>

      {catalog?.status === "ready" && catalog.access === "limited" && <View
        style={[styles.notice, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
        <Text style={[styles.noticeText, { color: colors.ink }]}>Only photos currently allowed by iOS are shown.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Manage limited photo access"
          disabled={loading || submitting} onPress={() => void manageLimited()} style={styles.inlineAction}>
          <Text style={[styles.inlineActionText, { color: colors.accent }]}>Manage access</Text>
        </Pressable>
      </View>}

      {error !== "" && <View accessibilityRole="alert" style={[styles.error, { borderColor: colors.negative }]}>
        <Text style={[styles.errorText, { color: colors.negative }]}>{error}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry loading photos"
          disabled={loading || submitting} onPress={() => void load(false)} style={styles.inlineAction}>
          <Text style={[styles.inlineActionText, { color: colors.accent }]}>Retry</Text>
        </Pressable>
      </View>}

      {denied && <View style={styles.center}>
        <Text style={[styles.stateTitle, { color: colors.ink }]}>Photo access is off</Text>
        <Text style={[styles.stateCopy, { color: colors.muted }]}>Joko only reads photos after you open this surface.</Text>
        <Pressable accessibilityRole="button"
          accessibilityLabel={denied.canAskAgain ? "Allow photo access" : "Open Joko photo settings"}
          disabled={loading || submitting}
          onPress={() => void (denied.canAskAgain ? load(true) : openSettings())}
          style={[styles.primary, { backgroundColor: colors.accent }]}>
          <Text style={styles.primaryText}>{denied.canAskAgain ? "Allow photos" : "Open settings"}</Text>
        </Pressable>
      </View>}

      {catalog?.status === "unavailable" && <View style={styles.center}>
        <Text style={[styles.stateTitle, { color: colors.ink }]}>Photos are unavailable</Text>
        <Text style={[styles.stateCopy, { color: colors.muted }]}>This device cannot provide the iOS photo-library surface.</Text>
      </View>}

      {!denied && catalog?.status !== "unavailable" && <FlatList
        accessibilityLabel={kind === "recent" ? "Recent photos" : "Screenshots"}
        data={assets}
        key={kind}
        keyExtractor={(asset) => asset.id}
        numColumns={3}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.gridRow}
        refreshing={loading && assets.length > 0}
        onRefresh={() => void load(false)}
        ListEmptyComponent={loading || !catalog
          ? <View style={styles.center}><ActivityIndicator color={colors.accent} />
              <Text style={[styles.stateCopy, { color: colors.muted }]}>Loading photos…</Text></View>
          : <View style={styles.center}><Text style={[styles.stateTitle, { color: colors.ink }]}>
              {kind === "recent" ? "No recent photos" : "No screenshots"}
            </Text><Text style={[styles.stateCopy, { color: colors.muted }]}>Pull down or use Refresh after adding photos.</Text></View>}
        renderItem={({ item }) => {
          const order = selectedOrder.get(item.id);
          const selectionFull = selected.length >= maximumSelection && order === undefined;
          return <Pressable accessibilityRole="button"
            accessibilityLabel={`${order ? "Deselect" : "Select"} ${item.fileName}`}
            accessibilityState={{ selected: order !== undefined, disabled: submitting || selectionFull }}
            disabled={submitting || selectionFull} onPress={() => toggle(item)}
            style={[styles.thumb, { width: thumbSize, height: thumbSize, backgroundColor: colors.surface },
              selectionFull && styles.disabled]}>
            <PhotoPreviewImage source={{ uri: item.uri }} recyclingKey={item.id} contentFit="cover"
              transition={0} style={styles.image} accessibilityIgnoresInvertColors />
            {order !== undefined && <View style={[styles.badge, { backgroundColor: colors.accent }]}>
              <Text style={styles.badgeText}>{order}</Text>
            </View>}
          </Pressable>;
        }}
      />}

      <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh photo library"
          disabled={loading || submitting} onPress={() => void load(false)}
          style={[styles.secondary, { borderColor: colors.border }, (loading || submitting) && styles.disabled]}>
          <Text style={[styles.secondaryText, { color: colors.ink }]}>Refresh</Text>
        </Pressable>
        <Pressable accessibilityRole="button"
          accessibilityLabel={selected.length === 0 ? "Add selected photos" : `Add ${selected.length} selected photos`}
          accessibilityState={{ disabled: selected.length === 0 || submitting }}
          disabled={selected.length === 0 || submitting} onPress={() => void submit()}
          style={[styles.primary, { backgroundColor: selected.length === 0 ? colors.border : colors.accent }]}>
          {submitting ? <ActivityIndicator color="#2b2316" />
            : <Text style={[styles.primaryText, selected.length === 0 && { color: colors.muted }]}>
                {selected.length === 0 ? "Select photos" : `Add ${selected.length} photo${selected.length === 1 ? "" : "s"}`}
              </Text>}
        </Pressable>
      </View>
    </SafeAreaView>
  </Modal>;
}

function errorText(value: unknown): string {
  return value instanceof Error && value.message ? value.message : "The photo library could not be used.";
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 72, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1,
    flexDirection: "row", alignItems: "center", gap: 12 },
  headingCopy: { flex: 1, gap: 2 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  caption: { fontSize: 13, lineHeight: 18 },
  close: { minWidth: 56, minHeight: 44, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 15, fontWeight: "700" },
  tabs: { minHeight: 52, marginHorizontal: 16, marginVertical: 10, borderWidth: 1, borderRadius: 14,
    padding: 4, flexDirection: "row", gap: 4 },
  tab: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  tabText: { fontSize: 14, fontWeight: "700" },
  notice: { marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 10,
    minHeight: 52, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  inlineAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  inlineActionText: { fontSize: 14, fontWeight: "700" },
  error: { marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, borderWidth: 1, borderRadius: 12,
    minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  grid: { paddingHorizontal: 16, paddingBottom: 28, flexGrow: 1 },
  gridRow: { gap: 8, marginBottom: 8 },
  thumb: { borderRadius: 12, overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  badge: { position: "absolute", right: 7, top: 7, width: 24, height: 24, borderRadius: 12,
    alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#2b2316", fontSize: 12, lineHeight: 16, fontWeight: "800" },
  center: { flexGrow: 1, minHeight: 180, padding: 24, alignItems: "center", justifyContent: "center", gap: 10 },
  stateTitle: { fontSize: 17, lineHeight: 23, fontWeight: "700", textAlign: "center" },
  stateCopy: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  footer: { minHeight: 76, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 10 },
  primary: { minWidth: 142, minHeight: 48, paddingHorizontal: 18, borderRadius: 12,
    alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#2b2316", fontSize: 15, fontWeight: "700" },
  secondary: { minWidth: 92, minHeight: 48, paddingHorizontal: 14, borderWidth: 1, borderRadius: 12,
    alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.5 }
});
