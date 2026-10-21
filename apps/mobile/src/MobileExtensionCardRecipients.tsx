import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { extensionCardRecipients, fitExtensionCardRecipients, extensionCardFieldMaxValue, type ExtensionCardFormField } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";

interface Props {
  readonly fields: ExtensionCardFormField[]; readonly values: Record<string, string>; readonly colors: MobileInteractionSheetColors;
  readonly disabled: boolean; readonly expandLabel: string; readonly collapseLabel: string;
  readonly onChange: (name: string, value: string) => void;
}
export function MobileExtensionCardRecipients(props: Props) {
  const [expanded, setExpanded] = useState(false), [heights, setHeights] = useState<Record<string, number>>({});
  const { fields, values, colors, disabled, onChange } = props;
  return expanded ? <View style={[styles.root, { borderColor: colors.border }]}>
    {fields.map((field, index) => <View key={field.name} style={styles.row}>
      <Text style={[styles.label, styles.editLabel, { color: colors.muted }]}>{field.label}</Text>
      <TextInput accessibilityLabel={field.label} value={values[field.name] ?? field.value} editable={!disabled} multiline scrollEnabled={false}
        autoCapitalize="none" autoCorrect={false} maxLength={extensionCardFieldMaxValue(field.name)}
        onContentSizeChange={event => { const height = Math.max(44, Math.ceil(event.nativeEvent.contentSize.height)); setHeights(previous => previous[field.name] === height ? previous : { ...previous, [field.name]: height }); }}
        style={[styles.input, { height: heights[field.name] ?? 44, color: colors.ink }]} onChangeText={value => onChange(field.name, value)} />
      {index === 0 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: true }} style={styles.control} onPress={() => setExpanded(false)}>
        <Text style={[styles.label, { color: colors.muted }]}>{props.collapseLabel}</Text>
      </Pressable>}
    </View>)}
  </View> : <Summary key={JSON.stringify(fields.map(field => [field.name, field.label, field.collapsed, values[field.name] ?? field.value]))} {...props} onExpand={() => setExpanded(true)} />;
}
function Summary({ fields: allFields, values, colors, disabled, expandLabel, onExpand }: Props & { onExpand(): void }) {
  const fields = allFields.filter(field => field.name !== "bcc" && !field.collapsed), entries = fields.map(field => extensionCardRecipients(values[field.name] ?? field.value));
  const [width, setWidth] = useState(0), [metrics, setMetrics] = useState<Record<string, number>>({});
  const record = (name: string, width: number) => setMetrics(previous => previous[name] === width ? previous : { ...previous, [name]: width });
  const groups = entries.map((items, i) => ({ label: metrics[`label-${i}`] ?? 0, chips: items.map((_, j) => metrics[`chip-${i}-${j}`] ?? 0), more: Array.from({ length: items.length + 1 }, (_, j) => metrics[`more-${i}-${j}`] ?? 0) }));
  const ready = width > 0 && metrics.toggle !== undefined && entries.every((items, i) => metrics[`label-${i}`] !== undefined && items.every((_, j) => metrics[`chip-${i}-${j}`] !== undefined)
    && Array.from({ length: items.length + 1 }, (_, j) => metrics[`more-${i}-${j}`]).every(value => value !== undefined));
  const available = Math.max(0, width - fields.length * 8), fullCounts = ready ? fitExtensionCardRecipients(available, groups) : fields.map(() => 0);
  const canExpand = !disabled || allFields.some(field => (field.name === "bcc" || field.collapsed) && (values[field.name] ?? field.value).trim())
    || ready && entries.some((items, i) => fullCounts[i]! < items.length || items.some((item, j) => item.label !== item.address || metrics[`chip-${i}-${j}`]! >= 160));
  const counts = ready && canExpand ? fitExtensionCardRecipients(Math.max(0, available - metrics.toggle!), groups) : fullCounts;
  const labelStyle = [styles.label, { color: colors.muted }], chipStyle = [styles.chip, { color: colors.ink, backgroundColor: colors.surface }];
  return <View style={[styles.root, { borderColor: colors.border }]} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={styles.summary}>{fields.map((field, i) => <View style={styles.group} key={field.name}>
      <Text style={labelStyle}>{field.label}</Text>
      {entries[i]!.slice(0, counts[i]!).map((item, j) => canExpand ? <Pressable key={j} accessibilityRole="button" accessibilityLabel={`${field.label}: ${item.address}`} style={styles.control} onPress={onExpand}>
        <Text numberOfLines={1} style={chipStyle}>{item.label}</Text>
      </Pressable> : <Text numberOfLines={1} key={j} style={chipStyle}>{item.label}</Text>)}
      {(counts[i]! < entries[i]!.length || !entries[i]!.length) && <Pressable accessibilityRole="button" accessibilityLabel={`${field.label}: ${expandLabel} (${entries[i]!.length})`} style={styles.control} onPress={onExpand}>
        <Text style={[styles.more, { color: colors.muted }]}>{entries[i]!.length - counts[i]! ? `+${entries[i]!.length - counts[i]!}` : "+"}</Text>
      </Pressable>}
    </View>)}
      {canExpand && <Pressable accessibilityRole="button" accessibilityState={{ expanded: false }} style={[styles.control, styles.toggle]} onPress={onExpand}><Text style={labelStyle}>{expandLabel}</Text></Pressable>}
    </View>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.measure}>
      <Text style={labelStyle} onLayout={event => record("toggle", event.nativeEvent.layout.width)}>{expandLabel}</Text>
      {fields.map((field, i) => <View style={styles.measureGroup} key={field.name}>
        <Text style={labelStyle} onLayout={event => record(`label-${i}`, event.nativeEvent.layout.width)}>{field.label}</Text>
        {entries[i]!.map((item, j) => <Text key={j} numberOfLines={1} style={chipStyle} onLayout={event => record(`chip-${i}-${j}`, event.nativeEvent.layout.width)}>{item.label}</Text>)}
        {Array.from({ length: entries[i]!.length + 1 }, (_, j) => <Text key={j} style={[styles.more, { color: colors.muted }]} onLayout={event => record(`more-${i}-${j}`, event.nativeEvent.layout.width)}>{j ? `+${j}` : "+"}</Text>)}
      </View>)}
    </View>
  </View>;
}
const styles = StyleSheet.create({ root: { width: "100%", borderBottomWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 }, summary: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  group: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }, control: { minHeight: 44, justifyContent: "center", flexShrink: 0 }, toggle: { marginLeft: "auto" },
  label: { fontSize: 12, lineHeight: 18 }, editLabel: { paddingTop: 12 }, input: { flex: 1, minWidth: 0, minHeight: 44, padding: 4, textAlignVertical: "top", fontSize: 14, lineHeight: 21 },
  chip: { maxWidth: 160, borderRadius: 16, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, lineHeight: 18 }, more: { paddingHorizontal: 4, fontSize: 12, lineHeight: 18 },
  measure: { position: "absolute", top: 0, left: 0, opacity: 0, flexDirection: "row", width: 100000 }, measureGroup: { flexDirection: "row", alignItems: "center" }
});
