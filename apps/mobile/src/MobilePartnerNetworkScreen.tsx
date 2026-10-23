import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { randomUUID } from "expo-crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { MobilePartnerNetworkApi } from "./mobile-partner-network";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { MobileImageLightbox } from "./MobileImageLightbox";
import { inspectMobileImageGalleryBytes, mobileImageGalleryPreviewUri } from "./mobile-image-gallery";
import { encodeMobileBase64 } from "./mobile-image-annotation";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import type { MobilePartnerDirectoryProfile, MobilePartnerDirectoryTransport } from "./mobile-partner-directory";
import { useMobilePartnerNetworkFailures } from "./use-mobile-partner-network-failures";
type MobileNetworkDraft = { text: string; tracked: contract.NetworkTrackedMention[]; mentions: string[] };
const mobileNetworkDrafts = new Map<string, MobileNetworkDraft>();

export function MobilePartnerNetworkScreen({ api, directory, colors, locale, foreground, storage, onBack }: {
  api?: MobilePartnerNetworkApi; colors: MobilePartnersColors; locale: MobileSupportedLocale; foreground: boolean;
  directory?: MobilePartnerDirectoryTransport; storage: contract.PartnerNetworkOutboxStorage; onBack(): void;
}) {
  const m = contract.partnerNetworkMessages(locale), [rooms, setRooms] = useState<contract.PartnerNetworkRoom[]>(), [selected, setSelected] = useState<contract.PartnerNetworkRoom>();
  const [snapshot, setSnapshot] = useState<contract.PartnerNetworkSnapshot>(), [messages, setMessages] = useState<contract.PartnerNetworkMessage[]>([]), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [draft, setDraft] = useState(""), [mentions, setMentions] = useState<string[]>([]), [members, setMembers] = useState(false), [history, setHistory] = useState(false), [image, setImage] = useState<MobileComposerImageEditorSession>();
  const [retained, setRetained] = useState<readonly contract.PartnerNetworkOutboxEntry[]>([]), [journalReady, setJournalReady] = useState(false);
  const [name, setName] = useState(""), [owned, setOwned] = useState<readonly MobilePartnerDirectoryProfile[]>([]);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const trackedMentions = useRef<contract.NetworkTrackedMention[]>([]);
  const lifetime = useRef(new AbortController()), apiRef = useRef(api), following = useRef(true), list = useRef<FlatList<contract.PartnerNetworkMessage>>(null), request = useRef<{ body: string; id: string } | undefined>(undefined), lastRead = useRef(0n), pages = useRef<bigint[]>([]), readVersion = useRef(0), draftRef = useRef(draft);
  apiRef.current = api; draftRef.current = draft;
  const journal = useMemo(() => api ? new contract.PartnerNetworkSendJournal(storage, api.ownerKey.replace(/:\d+$/u, "")) : undefined, [api?.ownerKey]);
  const room = snapshot?.room ?? selected, self = room?.members.find(actor => actor.id === room.selfId), admin = self?.state === "joined" && ["owner", "admin"].includes(self.role), canSend = self?.state === "joined" && room?.state === "active" && !!snapshot;
  const target = room ? { roomId: room.id, joinId: room.joinId } : undefined;
  const failures = useMobilePartnerNetworkFailures(api, target, messages, foreground, () => { setMessages([]); setSnapshot(undefined); setError(m.denied); });
  const mentionMembers = room?.members.filter(actor => actor.state === "joined" && actor.id !== room.selfId).map(actor => ({ actorId: actor.id, name: contract.partnerNetworkActorName(actor, room), displayName: actor.name, nickname: actor.nickname })) ?? [];
  const mentionInput = { members: mentionMembers, allLabels: [m.everyone, "all", "everyone", "所有人"], tracked: trackedMentions.current };
  const draftKey = selected && api ? JSON.stringify([api.ownerKey.replace(/:\d+$/u, ""), selected.hostServerId, selected.id, selected.joinId]) : undefined, activeDraftKey = useRef<string | undefined>(undefined), activeDraft = useRef<MobileNetworkDraft>({ text: "", mentions: [], tracked: [] });
  activeDraft.current = { text: draft, mentions, tracked: trackedMentions.current };
  useEffect(() => { if (activeDraftKey.current === draftKey) return; if (activeDraftKey.current) mobileNetworkDrafts.set(activeDraftKey.current, activeDraft.current);
    const restored = draftKey && mobileNetworkDrafts.get(draftKey); activeDraftKey.current = draftKey; setDraft(restored ? restored.text : ""); setMentions(restored ? restored.mentions : []); trackedMentions.current = restored ? [...restored.tracked] : []; request.current = undefined;
    while (mobileNetworkDrafts.size > 100) mobileNetworkDrafts.delete(mobileNetworkDrafts.keys().next().value!); }, [draftKey]);
  useEffect(() => () => { if (activeDraftKey.current) mobileNetworkDrafts.set(activeDraftKey.current, activeDraft.current); }, []);
  const editDraft = (value: string) => { trackedMentions.current = contract.retainNetworkTrackedMentions(draft, value, { ...mentionInput, tracked: trackedMentions.current }); setDraft(value); setMentions(contract.resolveNetworkMentions(value, { ...mentionInput, tracked: trackedMentions.current }).actorIds); };
  const pickMention = (actorId?: string) => { const label = actorId ? mentionMembers.find(actor => actor.actorId === actorId)?.name : m.everyone; if (!label) return;
    const prefix = draft && !/\s$/u.test(draft) ? `${draft} ` : draft, inserted = `${prefix}@${label} `;
    if (actorId) trackedMentions.current.push({ actorId, label, start: prefix.length }); setDraft(inserted); setMentions(contract.resolveNetworkMentions(inserted, { ...mentionInput, tracked: trackedMentions.current }).actorIds); };
  const failure = (reason: unknown) => reason instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(reason.code) ? m.denied : m.unavailable;
  const load = async (older = false, signal = lifetime.current.signal) => {
    const current = apiRef.current, version = ++readVersion.current; if (!current || signal.aborted) return;
    try {
      if (!selected) { const response = await current.listPartnerNetwork({}, { signal }); if (!signal.aborted && version === readVersion.current) { setRooms(response.rooms); setError(undefined); } return; }
      const key = { roomId: selected.id, joinId: selected.joinId }, before = older ? messages[0]?.sequence : undefined;
      const response = await current.getPartnerNetwork({ ...key, ...(before ? { beforeSequence: before } : {}) }, { signal });
      if (signal.aborted || version !== readVersion.current || !response.snapshot?.room) return;
      if (before && !pages.current.includes(before)) pages.current.push(before);
      const prior = older ? [] : await Promise.all(pages.current.map(beforeSequence => current.getPartnerNetwork({ ...key, beforeSequence }, { signal })));
      if (signal.aborted || version !== readVersion.current) return;
      const rows = [...response.snapshot.messages, ...prior.flatMap(page => page.snapshot?.messages ?? [])];
      setSnapshot(create(contract.PartnerNetworkSnapshotSchema, { ...response.snapshot, hasMore: prior.at(-1)?.snapshot?.hasMore ?? response.snapshot.hasMore }));
      setMessages(previous => [...new Map([...older ? previous : [], ...rows].map(row => [row.id, row])).values()].sort((a, b) => a.sequence < b.sequence ? -1 : 1));
      setError(undefined); await journal?.displayed(new Set(rows.map(row => row.id))); if (!signal.aborted) setRetained(journal?.list() ?? []);
    } catch (reason) { if (!signal.aborted && version === readVersion.current) { setError(failure(reason)); if (reason instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(reason.code)) { setMessages([]); setSnapshot(undefined); } } }
  };
  useEffect(() => { let active = true; setJournalReady(false); void journal?.initialize().then(entries => { if (active) { setRetained(entries); setJournalReady(true); } }).catch(() => { if (active) setError(m.unavailable); });
    return () => { active = false; }; }, [journal]);
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => { if (!members || !foreground || !directory) return; const scope = new AbortController();
    void directory.list(scope.signal).then(result => { if (!scope.signal.aborted) setOwned(result.partners); }).catch(() => { if (!scope.signal.aborted) setOwned([]); });
    return () => scope.abort(); }, [members, foreground, directory?.ownerKey]);
  useEffect(() => { if (!foreground || !api) return; const scope = new AbortController(); const refresh = () => { void load(false, scope.signal); }; refresh(); const timer = setInterval(refresh, selected ? 2_000 : 5_000);
    return () => { scope.abort(); clearInterval(timer); }; }, [api?.ownerKey, selected?.id, foreground]);
  const action = async (type: string, actorId = "", value = "") => {
    if (!api || !target || !room || busy) return; setBusy(true);
    try { const response = await api.managePartnerNetwork({ ...target, operationId: randomUUID(), expectedRevision: room.revision, action: type, actorId, value }, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted && response.room) { setSelected(response.room); if (["leave", "remove-list", "archive"].includes(type)) { setMembers(false); setSelected(undefined); setSnapshot(undefined); setMessages([]); } else await load(); } }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(failure(reason)); } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const confirm = (type: string, actorId = "", value = "", warning = m.destructive) => Alert.alert(m.settings, warning, [{ text: m.cancel, style: "cancel" }, { text: m.confirm, style: "destructive", onPress: () => { void action(type, actorId, value); } }]);
  const send = async (previous?: contract.PartnerNetworkOutboxEntry) => {
    if (!api || !target || !canSend || !journal || !journalReady || busy || !previous && !draft.trim()) return;
    const resolved = contract.resolveNetworkMentions(draft, mentionInput), body = JSON.stringify([target, draft, resolved]); if (request.current?.body !== body) request.current = { body, id: randomUUID() };
    const retainedRequest = retained.find(entry => !entry.messageId && entry.request.roomId === target.roomId && entry.request.joinId === target.joinId && entry.request.text === draft && entry.request.mentionAll === resolved.all && JSON.stringify(entry.request.mentions) === JSON.stringify(resolved.actorIds))?.request;
    const input = previous?.request ?? retainedRequest ?? create(contract.SendPartnerNetworkRequestSchema, { ...target, operationId: request.current.id, text: draft, mentions: resolved.actorIds, mentionAll: resolved.all });
    setBusy(true); setError(undefined);
    try { await journal.prepare(input, previous?.createdAt); lifetime.current.signal.throwIfAborted(); setRetained(journal.list());
      const result = await api.sendPartnerNetwork(input, { signal: lifetime.current.signal }); lifetime.current.signal.throwIfAborted(); if (!result.message) throw new Error();
      await journal.acknowledge(input.operationId, result.message.id); lifetime.current.signal.throwIfAborted();
      if (draftRef.current === input.text) { setDraft(""); setMentions([]); trackedMentions.current = []; request.current = undefined; } await load();
    } catch (reason) { if (!lifetime.current.signal.aborted) { setRetained(journal.list()); setError(failure(reason)); } } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const media = async (attachment: contract.PartnerNetworkAttachment) => {
    if (!api || !target || !room || busy) return; setBusy(true);
    try {
      if (!attachment.mediaType.startsWith("image/")) {
        const response = await api.mediaPartnerNetwork({ ...target, action: "authorize", mediaId: attachment.id }, { signal: lifetime.current.signal }); lifetime.current.signal.throwIfAborted();
        const url = new URL(response.downloadUrl); if (url.origin !== room.hostOrigin || !["https:", "http:"].includes(url.protocol) || url.username || url.password || !/^\/v1\/blobs\/download\/[^/]+\/[^/]+$/u.test(url.pathname) || url.search || url.hash) throw new Error();
        await Linking.openURL(url.href); return;
      }
      if (attachment.sizeBytes > 20n * 1024n * 1024n) throw new Error();
      const bytes = new Uint8Array(Number(attachment.sizeBytes)); let offset = 0n;
      while (offset < attachment.sizeBytes) { const response = await api.mediaPartnerNetwork({ ...target, action: "read", mediaId: attachment.id, offset }, { signal: lifetime.current.signal }); lifetime.current.signal.throwIfAborted();
        if (response.offset !== offset + BigInt(response.data.length) || !response.data.length || response.offset > attachment.sizeBytes) throw new Error(); bytes.set(response.data, Number(offset)); offset = response.offset; }
      const decoded = inspectMobileImageGalleryBytes(bytes, attachment.mediaType);
      setImage({ leaseId: randomUUID(), fileName: attachment.name, sourceBase64: encodeMobileBase64(bytes), sourceMediaType: attachment.mediaType, previewUri: mobileImageGalleryPreviewUri(bytes, decoded),
        initialStrokes: [], annotatable: false, expectedWidthPixels: decoded.width, expectedHeightPixels: decoded.height, animated: decoded.animated === true, maximumBytes: 20 * 1024 * 1024 });
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(failure(reason)); } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const markVisible = (through: bigint | undefined) => {
    if (!foreground || !following.current || !api || !target || !through || through <= lastRead.current) return;
    lastRead.current = through; void api.managePartnerNetwork({ ...target, operationId: randomUUID(), action: "mark-read", throughSequence: through }, { signal: lifetime.current.signal }).catch(() => { lastRead.current = 0n; });
  };
  const markVisibleRef = useRef(markVisible); markVisibleRef.current = markVisible;
  const viewable = useRef(({ viewableItems }: { viewableItems: readonly { isViewable: boolean; item: contract.PartnerNetworkMessage }[] }) => markVisibleRef.current(viewableItems.filter(item => item.isViewable).map(item => item.item.sequence).sort((a, b) => a < b ? -1 : 1).at(-1))).current;
  const viewability = useRef({ itemVisiblePercentThreshold: 65, minimumViewTime: 250 }).current;
  const button = (label: string, onPress: () => void, disabled = false) => label === m.continue && !snapshot?.canContinue ? null : <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, { borderColor: colors.border, opacity: disabled ? 0.45 : 1 }]}><Text style={{ color: colors.ink }}>{label}</Text></Pressable>;
  return <View style={[styles.screen, { backgroundColor: colors.background }]}><View style={styles.header}>{button(m.back, () => { if (selected) { setSelected(undefined); setSnapshot(undefined); setMessages([]); pages.current = []; } else onBack(); })}<Text style={[styles.title, { color: colors.ink }]}>{room?.name ?? m.title}</Text>{selected ? button(m.settings, () => { setName(room?.name ?? ""); setMembers(true); }, !room) : button(m.refresh, () => { void load(); }, !api)}</View>
    {error && <Text accessibilityRole="alert" style={[styles.notice, { color: colors.negative }]}>{error}</Text>}
    {failures.error && !error && <Text style={[styles.notice, { color: colors.muted }]}>{m.unavailable}</Text>}
    {!api && <Text style={[styles.notice, { color: colors.muted }]}>{m.unavailable}</Text>}
    {!selected ? <><View style={styles.header}>{button(m.showArchived, () => setHistory(value => !value))}</View><FlatList data={rooms?.filter(item => !item.removedFromList && (history || item.state === "active"))} keyExtractor={item => `${item.hostServerId}:${item.id}`} ListEmptyComponent={!rooms && api ? <ActivityIndicator color={colors.accent} /> : <Text style={{ color: colors.muted }}>{m.empty}</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" onPress={() => { pages.current = []; lastRead.current = 0n; setSelected(item); setSnapshot(undefined); }} style={[styles.row, { borderColor: colors.border }]}><Text style={[styles.title, { color: colors.ink }]}>{item.name}{item.unread ? ` · ${m.unread}` : ""}</Text><Text style={{ color: colors.muted }}>{item.state === "archived" ? m.archived : item.members.filter(actor => actor.state === "joined").map(actor => contract.partnerNetworkActorName(actor, item)).join(" · ")}</Text></Pressable>} /></>
      : <><FlatList ref={list} data={messages} keyExtractor={item => item.id} contentContainerStyle={styles.timeline} onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 48; }}
        onContentSizeChange={() => { if (following.current) list.current?.scrollToEnd({ animated: false }); }} onViewableItemsChanged={viewable} viewabilityConfig={viewability}
        ListHeaderComponent={snapshot?.hasMore ? button(m.older, () => { following.current = false; void load(true); }) : undefined}
        ListFooterComponent={<>{retained.filter(entry => entry.request.roomId === selected.id && entry.request.joinId === selected.joinId && (!entry.messageId || !messages.some(message => message.id === entry.messageId))).map(entry => <View key={entry.request.operationId} style={styles.row}><Text style={{ color: colors.ink }}>{entry.request.text}</Text><Text style={{ color: colors.negative }}>{m.failed}</Text>{button(m.retry, () => { void send(entry); }, busy)}</View>)}{snapshot?.executions.filter(job => ["queued", "running"].includes(job.status)).map(job => <Text key={job.id} style={{ color: colors.muted }}>{room?.members.find(actor => actor.id === job.actorId)?.name} · {job.status === "queued" ? m.waiting : m.replying}</Text>)}</>}
        renderItem={({ item }) => <View style={[styles.row, { borderColor: colors.border, alignSelf: item.authorId === room?.selfId ? "flex-end" : "flex-start" }]}><Text style={[styles.author, { color: colors.muted }]}>{item.authorName}</Text>
          {item.kind === "member-joined" ? <Text style={{ color: colors.muted }}>{room?.members.find(actor => actor.id === item.eventActorId)?.name ?? item.authorName} {m.joinedEvent}</Text>
            : item.kind === "plan" ? <MobileNetworkPlan plan={snapshot?.plans.find(plan => plan.id === item.planId)} colors={colors} locale={locale} room={room!} />
            : <MobileMarkdownMessage text={contract.partnerNetworkMessageBody(item, locale)} colors={colors} locale={locale} ownerKey={JSON.stringify([api?.ownerKey, room?.id, item.id])} />}
          {item.task && <View><Text style={{ color: colors.ink }}>{item.task.title}</Text><Text style={{ color: colors.muted }}>{contract.partnerNetworkTaskStatus(item.task.status, locale)}</Text>{!!item.task.question && <Text style={{ color: colors.muted }}>{item.task.question}</Text>}</View>}
          {item.quoteId && <Text style={{ color: colors.muted }}>{messages.find(message => message.id === item.quoteId && !message.deleted)?.text.slice(0, 240) ?? m.sourceUnavailable}</Text>}
          {item.attachments.map(attachment => <View key={attachment.id}>{button(attachment.name, () => { void media(attachment); }, busy)}</View>)}
          {failures.bySource.get(item.id)?.map(job => <Text accessibilityLiveRegion="polite" key={`${job.id}:${job.lease}`} style={{ color: colors.negative }}>{room?.members.find(actor => actor.id === job.actorId)?.name}: {contract.partnerNetworkFailureMessage(job.failureCode, locale)}</Text>)}</View>} />
        <View style={[styles.composer, { borderColor: colors.border }]}><ScrollView horizontal>{button(`@${m.everyone}`, () => pickMention(), !canSend)}{room?.members.filter(actor => actor.state === "joined" && actor.id !== room.selfId).map(actor => <Pressable accessibilityRole="button" accessibilityState={{ selected: mentions.includes(actor.id) }} key={actor.id} onPress={() => pickMention(actor.id)} style={[styles.button, { borderColor: mentions.includes(actor.id) ? colors.accent : colors.border }]}><Text style={{ color: colors.ink }}>@{contract.partnerNetworkActorName(actor, room)}</Text></Pressable>)}</ScrollView><TextInput accessibilityLabel={m.message} multiline maxLength={8000} value={draft} onChangeText={editDraft} editable={canSend} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} /><View style={styles.actions}>{button(m.continue, () => { void action("continue"); }, !canSend || busy)}{button(m.stop, () => { void action("stop"); }, !canSend || busy)}{button(m.send, () => { void send(); }, !canSend || !journalReady || busy || !draft.trim())}</View></View></>}
    <Modal visible={members && !!room} animationType="slide" onRequestClose={() => setMembers(false)}><SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}><View style={styles.header}>{button(m.back, () => setMembers(false))}<Text style={[styles.title, { color: colors.ink }]}>{m.settings}</Text></View><ScrollView contentContainerStyle={styles.timeline}>
      <TextInput accessibilityLabel={m.name} value={name} maxLength={120} onChangeText={setName} editable={admin && !busy && room?.state !== "dissolved"} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />{admin && button(m.save, () => { void action("rename", "", name); }, busy || !name.trim() || name === room?.name)}
      {admin && room?.state !== "dissolved" && <><Text style={{ color: colors.muted }}>{m.replyMode}</Text><View style={styles.actions}>{button(m.all, () => { void action("reply-mode", "", "all"); }, busy || room?.replyMode === "all")}{button(m.mentioned, () => { void action("reply-mode", "", "mentioned"); }, busy || room?.replyMode === "mentioned")}</View><Text style={{ color: colors.muted }}>{m.speakingMode}</Text><View style={styles.actions}>{button(m.auto, () => { void action("speaking-mode", "", "auto"); }, busy || room?.speakingMode === "auto")}{button(m.sequential, () => { void action("speaking-mode", "", "sequential"); }, busy || room?.speakingMode === "sequential")}</View></>}
      {room?.members.filter(actor => actor.state === "joined").map(actor => <View style={[styles.row, { borderColor: colors.border }]} key={actor.id}><Text style={{ color: colors.ink }}>{contract.partnerNetworkActorName(actor, room)}</Text><Text style={{ color: colors.muted }}>{actor.role === "owner" ? m.owner : actor.role === "admin" ? m.admin : m.member}</Text>{actor.kind === "partner" && <Text style={{ color: colors.muted }}>{actor.guestAccess === "tools" ? m.accessTools : actor.guestAccess === "chat" ? m.accessChat : m.accessNone}</Text>}
        {(actor.id === room.selfId || actor.ownerId === room.selfId) && <><TextInput accessibilityLabel={`${m.nickname}: ${actor.name}`} maxLength={128} value={nicknames[actor.id] ?? actor.nickname} onChangeText={value => setNicknames(previous => ({ ...previous, [actor.id]: value }))} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />{button(m.save, () => { void action("nickname", actor.id, nicknames[actor.id] ?? actor.nickname); }, busy || (nicknames[actor.id] ?? actor.nickname) === actor.nickname)}</>}
        {actor.kind === "partner" && actor.ownerId === room.selfId && <>{button(m.accessNone, () => { void action("set-access", actor.id, "none"); }, busy)}{button(m.accessChat, () => { void action("set-access", actor.id, "chat"); }, busy)}{button(m.accessTools, () => confirm("set-access", actor.id, "tools", m.accessWarning), busy)}</>}
        {actor.kind === "partner" && actor.ownerId === room.selfId && button(m.removePartner, () => confirm("remove-partner", actor.id), busy)}
        {actor.kind === "human" && actor.id !== room.selfId && self?.role === "owner" && <>{button(m.transfer, () => confirm("set-role", actor.id, "owner"), busy)}{button(actor.role === "admin" ? m.member : m.admin, () => { void action("set-role", actor.id, actor.role === "admin" ? "member" : "admin"); }, busy)}</>}
        {actor.kind === "human" && actor.id !== room.selfId && admin && actor.role !== "owner" && button(m.remove, () => confirm("remove-member", actor.id), busy)}
      </View>)}{self?.state === "joined" && room?.state === "active" && <><Text style={{ color: colors.muted }}>{m.addPartner}</Text>{owned.filter(partner => partner.lifecycle === "active" && partner.initializationState === "ready" && !room.members.some(actor => actor.state === "joined" && actor.ownerId === room.selfId && actor.partnerId === partner.partnerId)).map(partner => <View key={partner.partnerId}>{button(`${m.addPartner}: ${partner.displayName}`, () => { void action("add-partner", partner.partnerId); }, busy)}</View>)}</>}
      {admin && room?.state !== "dissolved" && button(room?.state === "archived" ? m.restore : m.archive, () => confirm(room?.state === "archived" ? "restore" : "archive"), busy)}{self?.role === "owner" && room?.state !== "dissolved" && button(m.dissolve, () => confirm("dissolve"), busy)}{self?.state === "joined" && (self.role !== "owner" || room!.members.filter(actor => actor.kind === "human" && actor.role === "owner" && actor.state === "joined").length > 1 || room!.state === "dissolved") && button(m.leave, () => confirm("leave"), busy)}{button(m.removeList, () => { void action("remove-list"); }, busy)}
    </ScrollView></SafeAreaView></Modal>
    {image && foreground && <MobileImageLightbox session={image} locale={locale} onClose={() => setImage(undefined)} onSave={async () => {}} />}
  </View>;
}
function MobileNetworkPlan({ plan, room, colors, locale }: { plan?: contract.PartnerNetworkPlan; room: contract.PartnerNetworkRoom; colors: MobilePartnersColors; locale: string }) {
  const m = contract.partnerGroupMessages(locale), status = (value: string) => ({ pending: m.pending, running: m.running, completed: m.done, failed: m.failed, proposed: m.proposed, waiting: m.waiting, stopped: m.stopped, dismissed: m.dismissed, superseded: m.superseded } as Record<string, string>)[value] ?? m.memberUnavailable;
  return <View accessibilityLabel={m.plan}><Text style={{ color: colors.ink }}>{m.plan}{plan ? ` · ${status(plan.status)}` : ` · ${m.memberUnavailable}`}</Text>{plan?.steps.map(step => <View key={step.position}><Text style={{ color: colors.ink }}>{step.position + 1}. {room.members.find(actor => actor.id === step.actorId)?.name ?? m.memberUnavailable} · {step.task}</Text><Text style={{ color: colors.muted }}>{status(step.status)}</Text></View>)}</View>;
}
const styles = StyleSheet.create({ screen: { flex: 1 }, header: { minHeight: 54, padding: 12, gap: 12, flexDirection: "row", alignItems: "center" }, actions: { gap: 12, flexDirection: "row", flexWrap: "wrap" }, title: { flex: 1, fontWeight: "600", fontSize: 16 }, author: { fontSize: 12 }, button: { borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12 }, row: { padding: 16, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, maxWidth: "100%" }, notice: { padding: 16 }, timeline: { padding: 16, gap: 12 }, composer: { padding: 12, gap: 12, borderTopWidth: StyleSheet.hairlineWidth }, input: { padding: 12, borderWidth: 1, borderRadius: 8, minHeight: 52, maxHeight: 160 } });
