import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { partnerGroupMessages } from "@joko/contracts";
import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MobilePartnerAvatar, MobilePartnerAvatarProvider } from "./MobilePartnerAvatar";
import { MobilePartnerDirectoryRow } from "./MobilePartnerDirectoryScreen";
import { MobileActionSheet } from "./MobileActionSheet";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobilePartnerRoster, MobilePartnerRosterShard } from "./mobile-partner-roster";
import type { MobilePartnerGroupRoster, MobilePartnerGroupDisplay } from "./mobile-partner-group-roster";

export type MobileHomePartnerEntry = { readonly kind: "create" | "create-group" } | {
  readonly kind: "partner" | "group"; readonly sourceKey: string; readonly id: string;
};
interface HomeEntry {
  readonly key: string; readonly source: MobilePartnerRosterShard; readonly id: string;
  readonly kind: "partner" | "group"; readonly name: string; readonly at: number;
  readonly unread: boolean; readonly preview: string; readonly online: boolean; readonly working: boolean;
  readonly partner?: MobilePartnerDirectoryProfile; readonly group?: MobilePartnerGroupDisplay;
}
const PREFERENCE_KEY = "joko.mobile.home-partners.v1";

/** All saved sources share the home section; cached rows never grant an action. */
export function MobileHomePartners({ roster, groups, storage, active, visible, query, colors, locale, canCreate, onOpen }: {
  readonly roster: MobilePartnerRoster; readonly groups: MobilePartnerGroupRoster;
  readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">;
  readonly active: boolean; readonly visible: boolean; readonly query: string;
  readonly colors: MobilePartnersColors; readonly locale: MobileSupportedLocale; readonly canCreate: boolean;
  readonly onOpen: (entry: MobileHomePartnerEntry) => void;
}) {
  const shards = useSyncExternalStore(roster.subscribe, () => roster.snapshot);
  const groupShards = useSyncExternalStore(groups.subscribe, () => groups.snapshot);
  const [collapsed, setCollapsed] = useState(false), [showAll, setShowAll] = useState(false);
  const [preferenceError, setPreferenceError] = useState(false);
  const [creating, setCreating] = useState(false);
  const changed = useRef(false), writes = useRef(Promise.resolve());
  useEffect(() => {
    let current = true;
    void storage.getItem(PREFERENCE_KEY).then(value => {
      if (current && !changed.current) setCollapsed(value === "collapsed");
    }).catch(() => { if (current) setPreferenceError(true); });
    return () => { current = false; };
  }, [storage]);
  useEffect(() => {
    roster.setActive(active && visible); groups.setActive(active && visible);
    return () => { roster.setActive(false); groups.setActive(false); };
  }, [roster, groups, active, visible]);
  const search = query.trim().normalize("NFKC").toLocaleLowerCase(locale);
  const entries = useMemo(() => {
    const result: HomeEntry[] = [];
    for (const source of shards) {
      const transport = roster.transport(source.source.key);
      if (transport && source.catalog) for (const partner of source.catalog.partners) {
        if (partner.lifecycle === "archived") continue;
        result.push({ key: JSON.stringify([source.source.key, "partner", partner.partnerId]), source,
          id: partner.partnerId, kind: "partner", name: partner.displayName,
          at: partner.activity.latestReplyAt ?? partner.updatedAt, unread: partner.activity.unreadReplyCount > 0,
          preview: partner.activity.latestReplyPreview ?? "", online: true, working: false, partner });
      } else for (const row of source.display) {
        if (row.lifecycle === "archived") continue;
        result.push({ key: JSON.stringify([source.source.key, "partner", row.partnerId]), source,
          id: row.partnerId, kind: "partner", name: row.displayName, at: row.updatedAt, unread: row.unread > 0,
          preview: row.preview, online: false, working: false });
      }
      const groupShard = groupShards.find(shard => shard.source.key === source.source.key);
      for (const group of groupShard?.display ?? []) {
        const online = !!groups.transport(source.source.key);
        const current = online ? groupShard?.catalog?.groups.find(item => item.id === group.groupId && !item.deleting) : undefined;
        if (online && !current) continue;
        result.push({ key: JSON.stringify([source.source.key, "group", group.groupId]), source,
          id: group.groupId, kind: "group", name: group.name, at: group.updatedAt, unread: group.unread,
          preview: group.preview, online, working: !!current?.speakers.length, group });
      }
    }
    return result.filter(entry => !search || entry.name.normalize("NFKC").toLocaleLowerCase(locale).includes(search))
      .sort((left, right) => right.at - left.at || left.key.localeCompare(right.key));
  }, [shards, groupShards, roster, groups, locale, search]);
  const duplicateNames = new Set(entries.filter((entry, index) => entries.some((other, at) => at !== index && other.name === entry.name)).map(entry => entry.name));
  const folded = collapsed && !search;
  const canCreateGroup = groupShards.some(shard => !!groups.transport(shard.source.key));
  const showCreate = (canCreate || canCreateGroup) && !search;
  const failed = preferenceError || shards.some(shard => shard.status === "error" || shard.status === "offline")
    || groupShards.some(shard => shard.status === "error" || shard.status === "offline");
  const refreshing = shards.some(shard => shard.refreshing) || groupShards.some(shard => shard.refreshing);
  const live = useRef(active); live.current = active;
  useEffect(() => () => { live.current = false; }, []);
  const open = (entry: MobileHomePartnerEntry) => { if (live.current) onOpen(entry); };
  const disabled = (entry: HomeEntry) => !active || (entry.kind === "group" ? !entry.online
    : !entry.online && !entry.source.display.some(row => row.partnerId === entry.id && row.conversation));
  useEffect(() => { if (!active || !visible) setCreating(false); }, [active, visible]);
  const saveCollapsed = (value: boolean) => {
    writes.current = writes.current.catch(() => undefined).then(() => storage.setItem(PREFERENCE_KEY, value ? "collapsed" : "expanded"))
      .then(() => { if (live.current) setPreferenceError(false); }).catch(() => { if (live.current) setPreferenceError(true); });
  };
  const toggle = () => {
    const next = !collapsed; changed.current = true; setCollapsed(next); setShowAll(false); setPreferenceError(false);
    saveCollapsed(next);
  };
  const avatar = (entry: HomeEntry, size: number) => <MobilePartnerAvatarProvider transport={roster.transport(entry.source.source.key)?.avatar}>
    {entry.group ? <View style={[styles.groupAvatars, { width: size, height: size }]}>{entry.group.members.slice(0, 4).map(member => {
      const partner = entry.source.catalog?.partners.find(item => item.partnerId === member.partnerId);
      const cached = entry.source.display.find(item => item.partnerId === member.partnerId);
      return <MobilePartnerAvatar key={member.partnerId} partner={partner} preset={partner?.avatar ?? cached?.avatar ?? "orbit"} colors={colors} size={size / 2} />;
    })}</View> : <MobilePartnerAvatar partner={entry.partner}
      preset={entry.partner?.avatar ?? entry.source.display.find(row => row.partnerId === entry.id)?.avatar ?? "orbit"} colors={colors} size={size} />}
  </MobilePartnerAvatarProvider>;
  if (!visible || !entries.length && (!showCreate || shards.some(shard => !shard.settled && shard.status === "loading")) && !failed) return null;
  const shown = search || showAll ? entries : entries.slice(0, 3);
  return <View testID="home.partners" style={{ backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, folded ? "home.partners.expand" : "home.partners.collapse")}
        accessibilityState={{ expanded: !folded, disabled: !!search }} disabled={!!search} onPress={toggle} style={styles.heading}>
        <Text style={{ color: colors.muted }}>{folded ? "▸" : "▾"}</Text><Text style={[styles.title, { color: colors.ink }]}>{mobileMessage(locale, "partnerDirectory.title")}</Text>
        {!folded && entries.length > 0 && <Text style={{ color: colors.muted }}>{entries.length}</Text>}
      </Pressable>
      {failed && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "common.retry")} disabled={!active || refreshing}
        onPress={() => { roster.refresh(); groups.refresh(); if (preferenceError) saveCollapsed(collapsed); }} style={styles.action}>{refreshing ? <ActivityIndicator color={colors.muted} /> : <Text style={{ color: colors.ink }}>↻</Text>}</Pressable>}
      {!folded && showCreate && entries.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.partners.create")}
        disabled={!active} onPress={() => setCreating(true)} style={styles.action}><Text style={{ color: colors.ink }}>＋</Text></Pressable>}
    </View>
    {folded ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} testID="home.partners.strip">
      {entries.map(entry => <Pressable key={entry.key} accessibilityRole="button" accessibilityLabel={entry.name + (duplicateNames.has(entry.name) ? ` · ${entry.source.source.profile.displayName}` : "")}
        disabled={disabled(entry)} onPress={() => open({ kind: entry.kind, sourceKey: entry.source.source.key, id: entry.id })} style={styles.cell}>
        <View style={!entry.online && styles.offline}>{avatar(entry, 56)}{entry.unread && <View style={[styles.unread, styles.stripUnread, { backgroundColor: colors.accent }]} />}</View>
        <Text style={[styles.cellName, { color: colors.ink }]} numberOfLines={1}>{entry.name}</Text>
      </Pressable>)}
      {showCreate && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.partners.create")} disabled={!active}
        onPress={() => setCreating(true)} style={styles.cell}><Text style={[styles.addAvatar, { color: colors.ink, borderColor: colors.border }]}>＋</Text></Pressable>}
    </ScrollView> : <>
      {shown.map((entry, index) => entry.partner ? <MobilePartnerAvatarProvider key={entry.key} transport={roster.transport(entry.source.source.key)?.avatar}>
        <MobilePartnerDirectoryRow partner={entry.partner} colors={colors} locale={locale} opening={false} online={active && entry.online}
          recoverable={active && entry.online && entry.partner.initializationState !== "ready"} observation={roster.transport(entry.source.source.key)?.observation()}
          deviceName={duplicateNames.has(entry.name) ? entry.source.source.profile.displayName : undefined}
          last={index === shown.length - 1} onOpen={() => open({ kind: "partner", sourceKey: entry.source.source.key, id: entry.id })} />
      </MobilePartnerAvatarProvider> : <Pressable key={entry.key} accessibilityRole="button" accessibilityLabel={entry.name + (duplicateNames.has(entry.name) ? ` · ${entry.source.source.profile.displayName}` : "")}
        disabled={disabled(entry)} accessibilityState={{ disabled: disabled(entry) }}
        onPress={() => open({ kind: entry.kind, sourceKey: entry.source.source.key, id: entry.id })} style={styles.row}>
        <View style={!entry.online && styles.offline}>{avatar(entry, 44)}</View>
        <View style={[styles.rowBody, index < shown.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
          <View style={styles.rowTitle}><Text style={[styles.title, styles.grow, { color: colors.ink }]} numberOfLines={1}>{entry.name}</Text>
            {duplicateNames.has(entry.name) && <Text numberOfLines={1} style={[styles.device, { color: colors.muted }]}>· {entry.source.source.profile.displayName}</Text>}
            {entry.working ? <ActivityIndicator color={colors.muted} /> : <Text style={[styles.time, { color: colors.muted }]}>{formatTime(entry.at, locale)}</Text>}</View>
          <View style={styles.rowTitle}><Text style={[styles.preview, styles.grow, { color: colors.muted }]} numberOfLines={1}>
            {!entry.online ? `${mobileMessage(locale, "common.offline")} · ` : ""}{entry.working ? partnerGroupMessages(locale).replying : entry.preview || entry.group?.members.map(member => member.name).join(" · ") || mobileMessage(locale, "partnerDirectory.startChat")}
          </Text>{entry.unread && <View accessibilityLabel={partnerGroupMessages(locale).unread} style={[styles.unread, { backgroundColor: colors.accent }]} />}</View>
        </View>
      </Pressable>)}
      {!search && entries.length > 3 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAll }}
        accessibilityLabel={mobileMessage(locale, showAll ? "home.partners.showLess" : "home.partners.showAll")} onPress={() => setShowAll(value => !value)} style={styles.more}>
        <Text style={{ color: colors.muted }}>{mobileMessage(locale, showAll ? "home.partners.showLess" : "home.partners.showAll")}</Text>
      </Pressable>}
      {!entries.length && showCreate && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "home.partners.create")}
        disabled={!active} onPress={() => setCreating(true)} style={styles.more}><Text style={{ color: colors.ink }}>＋ {mobileMessage(locale, "home.partners.create")}</Text></Pressable>}
    </>}
    <MobileActionSheet visible={creating && active} colors={colors} locale={locale} onClose={() => setCreating(false)}
      items={[{ id: "create", label: mobileMessage(locale, "partnerCreation.create"), disabled: !canCreate },
        { id: "create-group", label: partnerGroupMessages(locale).create, disabled: !canCreateGroup }]}
      onAction={kind => { if (kind === "create" && canCreate || kind === "create-group" && canCreateGroup) open({ kind }); }} />
  </View>;
}
function formatTime(value: number, locale: MobileSupportedLocale) {
  if (!Number.isSafeInteger(value) || value <= 0) return "";
  const date = new Date(value); if (Number.isNaN(date.valueOf())) return "";
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", minHeight: 48, paddingHorizontal: 16 },
  heading: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }, title: { fontSize: 18, lineHeight: 28, fontWeight: "500", flexShrink: 1 },
  action: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  strip: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 }, cell: { width: 64, alignItems: "center", gap: 4 }, cellName: { fontSize: 12, lineHeight: 18 },
  addAvatar: { width: 56, height: 56, borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, textAlign: "center", fontSize: 28, lineHeight: 54 },
  groupAvatars: { flexDirection: "row", flexWrap: "wrap", overflow: "hidden", borderRadius: 10 },
  row: { height: 78, paddingLeft: 16, gap: 12, flexDirection: "row", alignItems: "center" }, rowBody: { flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center", paddingRight: 16 },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: 4 }, grow: { flex: 1, minWidth: 0 }, device: { maxWidth: "35%", fontSize: 13, lineHeight: 28 },
  preview: { fontSize: 15, lineHeight: 26 }, time: { fontSize: 13, lineHeight: 22 }, unread: { width: 10, height: 10, borderRadius: 5 },
  stripUnread: { position: "absolute", right: 0, top: 0 }, more: { minHeight: 48, alignItems: "center", justifyContent: "center" }, offline: { opacity: 0.5 }
});
