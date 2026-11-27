import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileGroupCatalogTransport, MobileTaskModelGroupCatalog, MobileTaskModelGroupChoice } from "./mobile-task-model-groups";

export function MobileTaskModelGroupPicker({ catalog, transport, value, onSelect, colors, locale, disabled }: {
  catalog?: MobileTaskModelGroupCatalog; transport?: MobileGroupCatalogTransport; value?: string;
  onSelect(choice: MobileTaskModelGroupChoice | undefined): void; disabled: boolean;
  colors: { ink: string; border: string; surface: string; brandBackground: string }; locale: MobileSupportedLocale;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; catalog?: MobileTaskModelGroupCatalog }>();
  const key = transport?.ownerKey;
  useEffect(() => {
    setOpen(false);
    if (!transport) return;
    const request = new AbortController();
    void transport.list(request.signal).then(result => {
      if (!request.signal.aborted) setLoaded({ key: transport.ownerKey, catalog: result });
    }).catch(() => { if (!request.signal.aborted) setLoaded(undefined); });
    return () => request.abort();
  }, [key]);
  const current = catalog ?? (key && loaded?.key === key ? loaded.catalog : undefined);
  if (!value && !current?.groups.length) return null;
  const title = mobileMessage(locale, "models.group"), exact = mobileMessage(locale, "models.exact");
  const press = (label: string, action: () => void, selected = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={action}
    style={[styles.choice, { borderColor: colors.border, backgroundColor: selected ? colors.brandBackground : colors.surface }]}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  return <View style={styles.group}>
    {press(title + " · " + (current?.groups.find(group => group.id === value)?.name ?? value ?? exact), () => setOpen(!open))}
    {open && <View style={styles.group}>
      {press(exact, () => { setOpen(false); onSelect(undefined); }, !value)}
      {current?.groups.map(group => <View key={group.id}>{press(group.name, () => {
        setOpen(false); onSelect({ groupId: group.id, revision: current.revision });
      }, group.id === value)}</View>)}
    </View>}
  </View>;
}

const styles = StyleSheet.create({ group: { gap: 5 }, choice: { padding: 9, borderWidth: 1, borderRadius: 8 } });
