import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { MobileFilesToolbarColors } from "./MobileFilesToolbar";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileImageGalleryMediaType } from "./mobile-image-gallery";
import { mobileModelPreviewKind } from "./mobile-model-preview";
import { mobileFilesGeneratedItems, mobileFilesGridColumns, mobileFilesPathLevels, mobileFilesWorkspaceItems,
  type MobileFilesDisplayItem, type MobileFilesPreferences } from "./mobile-files-presentation";
import type { MobileFilesComposerSource, MobileFilesState } from "./workspace-files";
import { MobileFileThumbnail } from "./MobileFileThumbnail";
import type { MobileFilesThumbnailAccess } from "./mobile-files-thumbnails";

export function MobileFilesBrowser({ files, preferences, colors, locale, disabled, preferencesDisabled, onPreferences,
  onOpen, onAdd, onShare, canShare, onDirectory, onCopy, onCopyDirectory, thumbnailClient }: {
  readonly files: MobileFilesState; readonly preferences: MobileFilesPreferences; readonly colors: MobileFilesToolbarColors;
  readonly locale: MobileSupportedLocale; readonly disabled: boolean; readonly preferencesDisabled: boolean;
  readonly onPreferences: (preferences: MobileFilesPreferences) => void;
  readonly onOpen: (source: MobileFilesComposerSource) => void; readonly onAdd: (source: MobileFilesComposerSource) => void;
  readonly onShare: (source: MobileFilesComposerSource) => void; readonly canShare: (source: MobileFilesComposerSource) => boolean;
  readonly onDirectory: (path: string) => void;
  readonly onCopy: (source: MobileFilesComposerSource) => void; readonly onCopyDirectory: () => void;
  readonly thumbnailClient?: MobileFilesThumbnailAccess;
}) {
  const { width } = useWindowDimensions(); const [measuredWidth, setMeasuredWidth] = useState<number>(); const [optionsOpen, setOptionsOpen] = useState(false);
  const [contextItem, setContextItem] = useState<MobileFilesDisplayItem>();
  useEffect(() => { setOptionsOpen(false); setContextItem(undefined); }, [files.authorityKey, files.location, files.preview, files.status]);
  const generated = files.location.kind === "generated";
  const path = files.location.kind === "workspace" ? files.location.path : "";
  const rootLabel = files.workspace?.displayName || mobileMessage(locale, "files.workspaceRoot");
  const levels = mobileFilesPathLevels(path, rootLabel);
  const columns = preferences.view === "list" ? 1 : mobileFilesGridColumns(measuredWidth ?? width);
  const items = useMemo(() => generated ? mobileFilesGeneratedItems(files.artifacts, preferences.sort, locale, Date.now())
    : mobileFilesWorkspaceItems(files.entries, preferences.sort, locale, Date.now()), [files.artifacts, files.entries, generated, locale, preferences.sort]);
  const currentItem = contextItem && items.find((item) => item.source.kind === contextItem.source.kind
    && (item.source.kind === "workspace-entry" && contextItem.source.kind === "workspace-entry" ? item.source.entry === contextItem.source.entry
      : item.source.kind === "artifact" && contextItem.source.kind === "artifact" && item.source.artifact === contextItem.source.artifact));
  useEffect(() => { if (contextItem && !currentItem) setContextItem(undefined); }, [contextItem, currentItem]);
  const directories = items.filter((item) => item.directory).length; const count = items.length - directories;
  const summary = [directories ? mobileMessage(locale, directories === 1 ? "files.presentation.folderOne" : "files.presentation.folderMany", { count: directories }) : "",
    count ? mobileMessage(locale, count === 1 ? "files.presentation.fileOne" : "files.presentation.fileMany", { count }) : ""].filter(Boolean).join(" · ");
  const currentLabel = generated ? mobileMessage(locale, "files.generatedByTask") : levels[0]!.label;
  const thumbnailScope = JSON.stringify([files.authorityKey, files.location, files.directoryRevision, files.artifactsRevision, files.status, !!files.preview]);
  const cellWidth = Math.max(1, ((measuredWidth ?? width) - 32 - 12 * (columns - 1)) / columns);
  const choice = (label: string, selected: boolean, onPress: () => void, locked = preferencesDisabled) => <Pressable key={label}
    accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled: locked }} disabled={locked}
    onPress={onPress} style={[styles.option, { backgroundColor: selected ? colors.brandBackground : colors.surface }, locked && styles.disabled]}>
    <Text style={[styles.optionText, { color: colors.ink }]}>{label}</Text><Text style={{ color: colors.accent }}>{selected ? "✓" : ""}</Text>
  </Pressable>;
  return <View style={styles.fill} onLayout={(event) => { const next = event.nativeEvent.layout.width; if (next > 0 && Number.isFinite(next)) setMeasuredWidth(next); }}>
    <View style={styles.fill} accessibilityElementsHidden={optionsOpen || currentItem !== undefined} importantForAccessibility={optionsOpen || currentItem ? "no-hide-descendants" : "auto"}>
      <View style={styles.heading}>
        <View style={styles.headingRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.presentation.optionsFor", { name: currentLabel })}
          onPress={() => { setContextItem(undefined); setOptionsOpen(true); }} style={styles.headingButton}>
          <Text numberOfLines={1} style={[styles.headingText, { color: colors.ink }]}>{currentLabel} ⌄</Text>
        </Pressable>
        {!generated && path && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.up")} disabled={disabled}
          accessibilityState={{ disabled }} onPress={() => onDirectory(levels[1]!.path)} style={[styles.up, disabled && styles.disabled]}>
          <Text style={{ color: colors.ink }}>{mobileMessage(locale, "files.up")}</Text>
        </Pressable>}
        </View>
        <Text accessibilityLiveRegion="polite" style={[styles.summary, { color: colors.muted }]}>{summary}</Text>
      </View>
      <FlatList<MobileFilesDisplayItem> key={`${preferences.view}-${columns}`} data={items} numColumns={columns}
        keyExtractor={(item) => item.key} style={styles.fill} contentContainerStyle={styles.content}
        columnWrapperStyle={columns > 1 ? styles.gridRow : undefined} keyboardShouldPersistTaps="handled" initialNumToRender={12} windowSize={5}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.muted }]}>{mobileMessage(locale, generated ? "files.generatedEmpty" : "files.directoryEmpty")}</Text>}
        renderItem={({ item }) => <FileItem item={item} grid={columns > 1} width={cellWidth} colors={colors} locale={locale} disabled={disabled}
          thumbnailClient={thumbnailClient} thumbnailOwner={files.authorityKey} thumbnailScope={thumbnailScope} thumbnailEnabled={files.open && files.status === "ready" && !files.preview && !disabled}
          shareDisabled={!canShare(item.source)} onOpen={() => onOpen(item.source)} onAdd={() => onAdd(item.source)} onShare={() => onShare(item.source)}
          onContext={() => { if (!disabled) { setOptionsOpen(false); setContextItem(item); } }} />} />
    </View>
    <Modal visible={optionsOpen} transparent animationType="fade" onRequestClose={() => setOptionsOpen(false)}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.cancel")} onPress={() => setOptionsOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.panelHeading}><Text accessibilityRole="header" style={[styles.headingText, { color: colors.ink }]}>{mobileMessage(locale, "files.presentation.options")}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.cancel")} onPress={() => setOptionsOpen(false)} style={styles.close}>
              <Text style={{ color: colors.ink }}>×</Text>
            </Pressable></View>
          <ScrollView keyboardShouldPersistTaps="handled">
            {!generated && <View><Text style={[styles.optionSection, { color: colors.muted }]}>{mobileMessage(locale, "files.presentation.path")}</Text>
              {levels.map((level) => <Pressable key={level.path} accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.openDirectory", { name: level.label })}
                accessibilityState={{ selected: level.current, disabled: disabled || level.current }} disabled={disabled || level.current}
                onPress={() => { setOptionsOpen(false); onDirectory(level.path); }} style={[styles.option, (disabled || level.current) && styles.disabled]}>
                <Text style={[styles.optionText, { color: colors.ink }]} numberOfLines={2}>{level.label}</Text>
                <Text style={{ color: colors.accent }}>{level.current ? "✓" : ""}</Text></Pressable>)}
              <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.presentation.copyPath")}
                accessibilityState={{ disabled: disabled || !files.directoryRevision || files.status !== "ready" }} disabled={disabled || !files.directoryRevision || files.status !== "ready"}
                onPress={() => { setOptionsOpen(false); onCopyDirectory(); }} style={[styles.option, (disabled || !files.directoryRevision || files.status !== "ready") && styles.disabled]}>
                <Text style={[styles.optionText, { color: colors.ink }]}>{mobileMessage(locale, "files.presentation.copyPath")}</Text>
              </Pressable>
            </View>}
            <View accessibilityRole="radiogroup" accessibilityLabel={mobileMessage(locale, "files.presentation.view")}>
              <Text style={[styles.optionSection, { color: colors.muted }]}>{mobileMessage(locale, "files.presentation.view")}</Text>
              {choice(mobileMessage(locale, "files.presentation.grid"), preferences.view === "grid", () => { onPreferences({ ...preferences, view: "grid" }); setOptionsOpen(false); })}
              {choice(mobileMessage(locale, "files.presentation.list"), preferences.view === "list", () => { onPreferences({ ...preferences, view: "list" }); setOptionsOpen(false); })}
            </View>
            <View accessibilityRole="radiogroup" accessibilityLabel={mobileMessage(locale, "files.presentation.sort")}>
              <Text style={[styles.optionSection, { color: colors.muted }]}>{mobileMessage(locale, "files.presentation.sort")}</Text>
              {choice(mobileMessage(locale, "files.presentation.sortName"), preferences.sort === "name", () => { onPreferences({ ...preferences, sort: "name" }); setOptionsOpen(false); })}
              {choice(mobileMessage(locale, "files.presentation.sortModified"), preferences.sort === "mtime", () => { onPreferences({ ...preferences, sort: "mtime" }); setOptionsOpen(false); })}
              {choice(mobileMessage(locale, "files.presentation.sortSize"), preferences.sort === "size", () => { onPreferences({ ...preferences, sort: "size" }); setOptionsOpen(false); })}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
    <Modal visible={currentItem !== undefined} transparent animationType="fade" onRequestClose={() => setContextItem(undefined)}>
      {currentItem && <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.cancel")} onPress={() => setContextItem(undefined)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.panelHeading}><View style={styles.fill}>
            <Text accessibilityRole="header" numberOfLines={2} style={[styles.headingText, { color: colors.ink }]}>{currentItem.label}</Text>
            <Text numberOfLines={2} style={[styles.meta, { color: colors.muted }]}>{currentItem.meta}</Text>
          </View><Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.cancel")} onPress={() => setContextItem(undefined)} style={styles.close}>
            <Text style={{ color: colors.ink }}>×</Text></Pressable></View>
          {!currentItem.directory && <ContextAction label={mobileMessage(locale, mobileImageGalleryMediaType(currentItem.mediaType) ? "files.openGalleryFor"
            : currentItem.source.kind === "artifact" ? "files.previewGenerated" : "files.previewFile", { name: currentItem.label })} colors={colors} disabled={disabled}
            onPress={() => { setContextItem(undefined); onOpen(currentItem.source); }} />}
          <ContextAction label={mobileMessage(locale, currentItem.source.kind === "artifact" ? "files.addGenerated" : currentItem.directory ? "files.addDirectory" : "files.addFile",
            { name: currentItem.label })} colors={colors} disabled={disabled} onPress={() => { setContextItem(undefined); onAdd(currentItem.source); }} />
          {(currentItem.source.kind === "workspace-entry" || (currentItem.source.kind === "artifact" && currentItem.source.artifact.blob?.fileName))
            && <ContextAction label={mobileMessage(locale, currentItem.source.kind === "artifact" ? "files.presentation.copyName" : "files.presentation.copyPath")}
              colors={colors} disabled={disabled || files.status !== "ready"} onPress={() => { setContextItem(undefined); onCopy(currentItem.source); }} />}
          {!currentItem.directory && <ContextAction label={mobileMessage(locale, currentItem.source.kind === "artifact" ? "files.shareGenerated" : "files.shareFile", { name: currentItem.label })}
            colors={colors} disabled={disabled || !canShare(currentItem.source)} onPress={() => { setContextItem(undefined); onShare(currentItem.source); }} />}
        </View>
      </View>}
    </Modal>
  </View>;
}

function FileItem({ item, grid, width, colors, locale, disabled, shareDisabled, onOpen, onAdd, onShare, onContext,
  thumbnailClient, thumbnailOwner, thumbnailScope, thumbnailEnabled }: {
  readonly item: MobileFilesDisplayItem; readonly grid: boolean; readonly width: number; readonly colors: MobileFilesToolbarColors;
  readonly locale: MobileSupportedLocale; readonly disabled: boolean; readonly shareDisabled: boolean;
  readonly onOpen: () => void; readonly onAdd: () => void; readonly onShare: () => void;
  readonly onContext: () => void;
  readonly thumbnailClient?: MobileFilesThumbnailAccess; readonly thumbnailOwner?: string; readonly thumbnailScope: string; readonly thumbnailEnabled: boolean;
}) {
  const artifact = item.source.kind === "artifact"; const gallery = !item.directory && mobileImageGalleryMediaType(item.mediaType) !== undefined;
  const model = !item.directory && mobileModelPreviewKind(item.mediaType, item.label) !== undefined;
  const label = mobileMessage(locale, item.directory ? "files.openDirectory" : gallery ? "files.openGalleryFor" : artifact ? "files.previewGenerated" : "files.previewFile", { name: item.label });
  return <View style={[styles.item, grid ? { width, marginBottom: 16 } : styles.listItem]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onOpen} onLongPress={onContext}
      style={[styles.main, grid ? styles.gridMain : styles.listMain, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
      <View style={[styles.glyphBox, grid ? styles.gridGlyph : styles.listGlyph, { backgroundColor: colors.brandBackground }]}>
        <MobileFileThumbnail client={thumbnailClient} source={item.source} ownerKey={thumbnailOwner} scopeKey={thumbnailScope} enabled={thumbnailEnabled} grid={grid} colors={colors}>
          <Text style={[styles.glyph, { color: colors.ink }]}>{item.directory ? "▰" : gallery ? "▧" : model ? "⬡" : artifact ? "◆" : "◇"}</Text>
        </MobileFileThumbnail>
      </View>
      <View style={grid ? styles.gridLabels : styles.fill}>
        <Text style={[styles.name, { color: colors.ink }]} numberOfLines={grid ? 2 : 1}>{item.label}</Text>
        <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={grid ? 2 : 1}>{item.meta}</Text>
      </View>
      {!grid && <Text style={{ color: colors.muted }}>›</Text>}
    </Pressable>
    <View style={[styles.actions, grid && styles.gridActions]}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, artifact ? "files.addGenerated" : item.directory ? "files.addDirectory" : "files.addFile", { name: item.label })}
        accessibilityState={{ disabled }} disabled={disabled} onPress={onAdd} style={[styles.action, { borderColor: colors.border }, disabled && styles.disabled]}>
        <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.add")}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, artifact ? "files.shareGenerated" : "files.shareFile", { name: item.label })}
        accessibilityState={{ disabled: disabled || shareDisabled }} disabled={disabled || shareDisabled} onPress={onShare} style={[styles.action, { borderColor: colors.border }, (disabled || shareDisabled) && styles.disabled]}>
        <Text style={[styles.actionText, { color: colors.ink }]}>{mobileMessage(locale, "common.share")}</Text>
      </Pressable>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "files.presentation.itemOptions", { name: item.label })}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onContext}
      style={[styles.itemOptions, grid ? styles.gridItemOptions : styles.listItemOptions, { backgroundColor: colors.surface, borderColor: colors.border }, disabled && styles.disabled]}>
      <Text style={{ color: colors.ink }}>⋯</Text>
    </Pressable>
  </View>;
}
function ContextAction({ label, colors, disabled, onPress }: { readonly label: string; readonly colors: MobileFilesToolbarColors; readonly disabled: boolean; readonly onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={[styles.option, disabled && styles.disabled]}><Text style={[styles.optionText, { color: colors.ink }]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  fill: { flex: 1 }, heading: { paddingHorizontal: 16, paddingBottom: 8 }, headingButton: { minHeight: 44, justifyContent: "center", flex: 1 },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 8 }, up: { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center", paddingHorizontal: 8 },
  headingText: { fontSize: 17, fontWeight: "700", flexShrink: 1 }, summary: { fontSize: 12, lineHeight: 18 }, content: { paddingHorizontal: 16, paddingBottom: 36, flexGrow: 1 },
  gridRow: { gap: 12 }, item: { gap: 6 }, listItem: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  main: { borderWidth: 1, borderRadius: 12, minHeight: 64, padding: 8 }, gridMain: { alignItems: "center", gap: 8 },
  itemOptions: { minWidth: 44, minHeight: 44, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  gridItemOptions: { position: "absolute", top: 4, right: 4 }, listItemOptions: { marginLeft: 6 },
  listMain: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }, glyphBox: { alignItems: "center", justifyContent: "center", borderRadius: 9, overflow: "hidden" },
  gridGlyph: { width: "100%", height: 112 }, listGlyph: { width: 36, height: 40 }, glyph: { fontSize: 30 }, gridLabels: { width: "100%", minHeight: 64 },
  name: { fontSize: 14, lineHeight: 20, fontWeight: "600" }, meta: { fontSize: 11, lineHeight: 16 }, actions: { flexDirection: "row", gap: 6 },
  gridActions: { flexWrap: "wrap" }, action: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 12, fontWeight: "600" }, empty: { fontSize: 14, paddingVertical: 16 }, disabled: { opacity: 0.5 },
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.4)", padding: 20 },
  panel: { width: "100%", maxWidth: 440, maxHeight: "85%", borderRadius: 18, padding: 16, borderWidth: 1 },
  panelHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  optionSection: { fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 5 }, option: { minHeight: 44, paddingHorizontal: 10, paddingVertical: 8,
    flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 9 }, optionText: { flex: 1, fontSize: 15 }
});
