import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewToken } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as wire from "@joko/contracts";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileGroupAttachmentTransport } from "./mobile-partner-groups";
import type { MobileLocalComposerAttachment } from "./mobile-attachments";
import { MobilePartnerAvatar } from "./MobilePartnerAvatar";
import { MobileMarkdownMessage } from "./MobileMarkdownMessage";
import { MobileInteractionSheet } from "./MobileInteractionSheet";
import { createMobileInteractionResolution } from "./mobile-interactions";
import { MobileKeyboardAvoidingView, useMobileKeyboardState } from "./MobileKeyboardAvoidingView";
import { mobileMessage } from "./mobile-messages";
import { MobilePhotoLibrarySheet } from "./MobilePhotoLibrarySheet";
import type { MobilePhotoLibraryAsset } from "./mobile-photo-library";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import { MobileImageLightbox } from "./MobileImageLightbox";
import { MobileGroupAttachments } from "./MobileGroupAttachments";
import { MobileComposerRichInput, type MobileComposerRichInputHandle } from "./MobileComposerRichInput";
import { plainTextMobileComposerDraft, replaceMobileComposerRange, type MobileComposerSelection } from "./mobile-composer-document";
import { MobileActionSheet } from "./MobileActionSheet";
import { MobileGroupIcon } from "./MobileGroupIcon";

type GroupView = wire.PartnerGroupViewController;
const offline: wire.PartnerGroupViewState = { status: "offline", busy: false, refreshing: false };
const subscribeOffline = () => () => undefined;
export function useMobilePartnerGroups(api: wire.PartnerGroupApi | undefined, scope: string | undefined, selectedId?: string) {
  const previous = useRef<{ scope: string; api: wire.PartnerGroupApi } | undefined>(undefined);
  if (scope && api) previous.current = { scope, api }; else if (previous.current?.scope !== scope) previous.current = undefined;
  const retained = previous.current?.api;
  const view = useMemo(() => retained ? new wire.PartnerGroupViewController(retained) : undefined, [retained?.ownerKey]);
  const state = useSyncExternalStore(view?.subscribe ?? subscribeOffline, () => view?.state ?? offline);
  useEffect(() => {
    if (!view) return; view.setActive(!!api && AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", value => view.setActive(!!api && value === "active"));
    return () => { subscription.remove(); view.setActive(false); };
  }, [view, api?.ownerKey]);
  useEffect(() => { view?.select(selectedId); }, [view, selectedId]);
  return { view, state };
}
export function MobileGroupAction({ label, colors, onPress, disabled = false, selected = false, compact = false, primary = false, testID }: {
  label: string; colors: MobilePartnersColors; onPress(): void; disabled?: boolean; selected?: boolean; compact?: boolean; primary?: boolean; testID?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} testID={testID}
    hitSlop={compact ? 4 : undefined} style={[styles.action, compact && styles.compactAction, { borderColor: primary ? colors.accent : colors.border, backgroundColor: primary || selected ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}><Text style={[styles.actionText, { color: primary ? colors.accent : colors.ink }]}>{label}</Text></Pressable>;
}
function GroupIconAction({ label, name, colors, onPress, disabled = false, primary = false }: { label: string; name: Parameters<typeof MobileGroupIcon>[0]["name"]; colors: MobilePartnersColors; onPress(): void; disabled?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={4} onPress={onPress}
    style={[styles.iconAction, { borderColor: primary ? colors.accent : colors.border, backgroundColor: primary ? colors.brandBackground : colors.surface }, disabled && styles.disabled]}><MobileGroupIcon name={name} color={primary ? colors.accent : colors.ink} size={18} /></Pressable>;
}
function GroupAvatars({ group, partners, colors }: { group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors }) {
  return <View style={styles.avatars}>{group.members.slice(0, 4).map(member => {
    const partner = partners.find(item => item.partnerId === member.partnerId);
    return <View key={member.partnerId} style={styles.avatar}><MobilePartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} colors={colors} size={26} /></View>;
  })}</View>;
}
export function MobilePartnerGroupRow({ group, partners, colors, locale, onOpen, disabled }: {
  group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale; onOpen(): void; disabled: boolean;
}) {
  const m = wire.partnerGroupMessages(locale);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${group.name} · ${m.groups}${group.unread ? ` · ${m.unread}` : ""}`} disabled={disabled} accessibilityState={{ disabled }} onPress={onOpen}
    testID={`partnerGroups.item.${group.id}`} style={[styles.directoryRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <GroupAvatars group={group} partners={partners} colors={colors} /><View style={styles.grow}><Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>{group.name}</Text>
      <Text style={{ color: colors.muted }} numberOfLines={1}>{group.speakers.length ? m.replying : group.openPlan ? m.plan : group.lastMessage?.content || group.members.map(member => member.name).join(" · ")}</Text></View>
    {group.unread && <View style={[styles.unread, { backgroundColor: colors.accent }]} />}
  </Pressable>;
}
export function MobilePartnerGroupCreateSheet({ view, partners, colors, locale, storage, receiptScope, onClose, onCreated }: {
  view: GroupView; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale;
  storage?: wire.RoutineReceiptStorage; receiptScope?: string; onClose(): void; onCreated(id: string): void;
}) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale);
  const [name, setName] = useState(""), [ids, setIds] = useState<string[]>([]), [receipt, setReceipt] = useState<string>(), [ready, setReady] = useState(false), [error, setError] = useState<string>();
  const key = receiptScope ? `joko.group-creation.v1:${receiptScope}` : undefined;
  const keyboard = useMobileKeyboardState(), insets = useSafeAreaInsets();
  useEffect(() => { let active = true; if (!key || !storage) { setError(m.pendingCreate); return; }
    void Promise.resolve(storage.getItem(key)).then(value => { if (!active) return; if (value && !/^[A-Za-z0-9_-]{16,100}$/u.test(value)) throw new Error(m.pendingCreate); setReceipt(value ?? undefined); setReady(true); })
      .catch(reason => { if (active) setError(String(reason)); }); return () => { active = false; };
  }, [key, storage]);
  const clear = async () => { await storage!.removeItem(key!); setReceipt(undefined); };
  const act = (label: string, run: (signal: AbortSignal) => Promise<unknown>, disabled = false) => <MobileGroupAction label={label} colors={colors} disabled={state.busy || state.status !== "ready" || !ready || disabled} onPress={() => void view.action(run)} />;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} allowSwipeDismissal={false}>
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}><MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
      <View style={styles.header}><MobileGroupAction label={m.cancel} colors={colors} onPress={onClose} disabled={state.busy} /><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.create}</Text></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><Text style={{ color: colors.ink }}>{m.name}</Text>
        <TextInput accessibilityLabel={m.name} maxLength={40} value={name} onChangeText={setName} editable={ready && !state.busy && !receipt} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
        <Text style={{ color: colors.muted }}>{m.membersHint}</Text><View style={styles.choices}>{partners.filter(item => item.lifecycle !== "archived").map(partner => <MobileGroupAction key={partner.partnerId} label={partner.displayName} colors={colors} selected={ids.includes(partner.partnerId)}
          disabled={!ready || state.busy || !!receipt || ids.length >= 6 && !ids.includes(partner.partnerId)} onPress={() => setIds(current => current.includes(partner.partnerId) ? current.filter(id => id !== partner.partnerId) : [...current, partner.partnerId])} />)}</View>
        {(error || state.error) && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error || state.error}</Text>}
        {receipt ? <View style={styles.content}><Text style={{ color: colors.muted }}>{m.pendingCreate}</Text>{act(m.checkCreate, async signal => { const result = await view.api.lookup(receipt, signal); if (result.group) { await clear(); onCreated(result.group.id); } else if (result.retired) await clear(); })}
          {act(m.retireCreate, async signal => { const result = await view.api.retire(receipt, signal); if (result.retired) await clear(); else if (result.group) { await clear(); onCreated(result.group.id); } })}</View>
          : act(m.create, async signal => { const id = view.api.newRequestId(); await storage!.setItem(key!, id); if (await storage!.getItem(key!) !== id) throw new Error(m.pendingCreate); setReceipt(id);
            const group = await view.api.create(state.catalog!.revision!.value, name.trim(), ids, id, signal); await clear(); onCreated(group.id); }, !name.trim() || ids.length < 2 || ids.length > 6 || !state.catalog?.revision)}
      </ScrollView></MobileKeyboardAvoidingView></SafeAreaView>
  </Modal>;
}
export function MobilePartnerGroupChat({ view, partners, colors, locale, attachments, onBack }: {
  view: GroupView; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale; attachments?: MobileGroupAttachmentTransport; onBack(): void;
}) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale), group = state.detail?.detail?.group, detail = state.detail?.detail;
  const timeGroups = useMemo(() => wire.collectPartnerGroupMessageTimeGroups(detail?.messages ?? []), [detail?.messages]);
  const retainedGroup = useRef(group), retainedProfile = useRef(attachments?.profileId);
  if (group) retainedGroup.current = group; if (attachments?.profileId) retainedProfile.current = attachments.profileId;
  const composerGroup = group ?? retainedGroup.current;
  const [settings, setSettings] = useState(false), [decision, setDecision] = useState<string>(), [localError, setLocalError] = useState<string>();
  const keyboard = useMobileKeyboardState(), insets = useSafeAreaInsets(), list = useRef<FlatList<wire.PartnerGroupMessage>>(null), following = useRef(true);
  const viewRef = useRef(view); viewRef.current = view;
  const visible = useRef(({ viewableItems }: { viewableItems: ViewToken<wire.PartnerGroupMessage>[] }) => {
    if (AppState.currentState === "active") { const sequence = viewableItems.reduce((last, item) => item.isViewable && item.item.sequence > last ? item.item.sequence : last, 0n); viewRef.current.markVisible(sequence); }
  }).current;
  const interactions = state.detail?.interactions.flatMap(context => context.interactions) ?? [];
  const act = (label: string, run: (signal: AbortSignal) => Promise<unknown>) => <MobileGroupAction label={label} colors={colors} disabled={state.busy || state.status !== "ready"} onPress={() => void view.action(run)} />;
  return <SafeAreaView edges={["bottom"]} style={[styles.screen, { backgroundColor: colors.background }]}><MobileKeyboardAvoidingView style={styles.screen} keyboard={keyboard} consumedBottomInset={insets.bottom}>
    <View style={[styles.header, { borderColor: colors.border }]}><GroupIconAction name="back" label={m.back} colors={colors} onPress={onBack} /><View style={styles.grow}><Text accessibilityRole="header" style={[styles.chatTitle, { color: colors.ink }]}>{group?.name ?? m.groups}</Text><Text style={[styles.caption, { color: colors.muted }]} numberOfLines={1}>{group?.members.map(member => member.name).join(" · ")}</Text></View>
      <GroupIconAction name="settings" label={m.settings} colors={colors} disabled={!group || state.busy} onPress={() => setSettings(true)} /></View>
    {(state.error || localError) && <View style={styles.notice}><Text accessibilityRole="alert" style={{ color: colors.negative }}>{state.error || localError}</Text><MobileGroupAction label={m.refresh} colors={colors} onPress={() => { setLocalError(undefined); view.setActive(true); }} /></View>}
    {!detail ? <View style={styles.center}>{state.status === "loading" && <ActivityIndicator color={colors.accent} />}<Text style={{ color: colors.muted }}>{state.status === "loading" ? m.loading : m.unavailable}</Text></View>
      : <><FlatList ref={list} data={detail.messages} keyExtractor={message => message.id} testID="partnerGroups.messages" keyboardShouldPersistTaps="handled"
        onViewableItemsChanged={visible} viewabilityConfig={{ itemVisiblePercentThreshold: 65, minimumViewTime: 250 }} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} contentContainerStyle={styles.timeline}
        onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 48; }}
        onContentSizeChange={() => { if (following.current) list.current?.scrollToEnd({ animated: false }); }}
        ListHeaderComponent={detail.hasMoreBefore ? <MobileGroupAction label={m.older} colors={colors} disabled={state.busy || state.status !== "ready"} onPress={() => { following.current = false; void view.older(); }} /> : undefined}
        ListEmptyComponent={<Text style={{ color: colors.muted }}>{m.empty}</Text>}
        ListFooterComponent={<View style={styles.timelineFooter}>{group!.speakers.map(speaker => { const partner = partners.find(item => item.partnerId === speaker.partnerId); return <View key={speaker.partnerId} style={styles.partnerMessage}>
          <MobilePartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} colors={colors} size={28} /><View style={styles.partnerBody}><Text style={[styles.authorName, { color: colors.ink }]}>{group!.members.find(member => member.partnerId === speaker.partnerId)?.name}</Text>
            <Text style={[styles.body, { color: colors.muted }]}>{speaker.activity === wire.PartnerGroupSpeakerActivity.PLANNING ? m.planning : speaker.activity === wire.PartnerGroupSpeakerActivity.STEP ? m.running : m.replying}</Text></View></View>; })}
          {detail.plans.filter(plan => plan.status === wire.PartnerGroupPlanStatus.WAITING && plan.id === (group!.openPlan?.id ?? detail.plans.at(-1)?.id)).map(plan => <View key={plan.id} style={styles.indented}><MobileGroupPlanFollowUp plan={plan} view={view} group={group!} partners={partners} colors={colors} locale={locale} /></View>)}
          {detail.canContinue && <View style={styles.dividerRow}><View style={[styles.dividerLine, { backgroundColor: colors.border }]} /><Text style={[styles.caption, { color: colors.muted }]}>{m.roundEnd}</Text>{act(m.continue, signal => view.api.continue(group!.id, signal))}<View style={[styles.dividerLine, { backgroundColor: colors.border }]} /></View>}
        </View>}
        renderItem={({ item, index }) => { const previous = detail.messages[index - 1], continued = !timeGroups.has(item.id) && item.kind === wire.PartnerGroupMessageKind.MESSAGE && item.authorKind === wire.PartnerGroupAuthorKind.PARTNER && previous?.kind === wire.PartnerGroupMessageKind.MESSAGE && previous.authorKind === wire.PartnerGroupAuthorKind.PARTNER && previous.authorPartnerId === item.authorPartnerId;
          return <View style={styles.timelineItem}>{timeGroups.has(item.id) && <Text style={[styles.time, { color: colors.muted }]}>{wire.formatPartnerGroupMessageTime(timeGroups.get(item.id)!, locale)}</Text>}
            {!(detail.canContinue && item.id === detail.messages.at(-1)?.id && item.kind === wire.PartnerGroupMessageKind.ROUND_END) && <MobileGroupMessage message={item} plans={detail.plans} view={view} group={group!} partners={partners} colors={colors} locale={locale} attachments={attachments} continued={continued} />}
          </View>; }} />
        {interactions.length > 0 && <MobileGroupAction label={`${m.decision} · ${interactions.length}`} colors={colors} onPress={() => setDecision(interactions[0]!.interactionId)} />}
      </>}
    {composerGroup && <MobileGroupComposer key={composerGroup.id} view={view} group={composerGroup} colors={colors} locale={locale} transport={attachments}
      running={detail?.roundRunning ?? false}
      onSent={() => { following.current = true; list.current?.scrollToEnd({ animated: false }); }} />}
    {settings && group && <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal={false} onRequestClose={() => setSettings(false)}>
      <SafeAreaView style={styles.screen}><MobilePartnerGroupSettings view={view} group={group} partners={partners} colors={colors} locale={locale} onBack={() => setSettings(false)} onDeleted={onBack} /></SafeAreaView></Modal>}
    <MobileInteractionSheet visible={!!decision && interactions.length > 0} profileId={retainedProfile.current} interactions={interactions} selectedId={decision} busy={state.busy || state.status !== "ready"} colors={colors} locale={locale}
      onSelect={setDecision} onMinimize={() => setDecision(undefined)} onError={setLocalError}
      onResolve={async (interaction, submission) => !!await view.action(async signal => { const resolution = createMobileInteractionResolution(interaction, submission, view.api.ownerKey); if (!resolution.decision.case) throw new Error(m.decision);
        await view.api.respond(group!.id, interaction, resolution.decision, signal); return true; })}
      onDismiss={async interaction => !!await view.action(async signal => { await view.api.respond(group!.id, interaction, { case: "dismissal", value: { reason: "" } }, signal); return true; })} />
  </MobileKeyboardAvoidingView></SafeAreaView>;
}
function MobileGroupMessage({ message, plans, view, group, partners, colors, locale, attachments, continued = false }: {
  message: wire.PartnerGroupMessage; plans: wire.PartnerGroupPlan[]; view: GroupView; group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale;
  attachments?: MobileGroupAttachmentTransport;
  continued?: boolean;
}) {
  const m = wire.partnerGroupMessages(locale), plan = plans.find(item => item.id === message.planId), isPlan = message.kind === wire.PartnerGroupMessageKind.PLAN && !!plan;
  const author = partners.find(item => item.partnerId === (isPlan ? plan?.organizerPartnerId : message.authorPartnerId));
  const notices = ["", m.memberFailed, m.memberTimeout, m.memberUnavailable, m.planFailed, m.planStopped, m.workdirUnavailable];
  if (!isPlan && (message.kind === wire.PartnerGroupMessageKind.ROUND_END || message.kind === wire.PartnerGroupMessageKind.PLAN_END))
    return <View style={styles.dividerRow}><View style={[styles.dividerLine, { backgroundColor: colors.border }]} /><Text style={[styles.caption, { color: colors.muted }]}>{message.kind === wire.PartnerGroupMessageKind.ROUND_END ? m.roundEnd : m.planEnd}</Text><View style={[styles.dividerLine, { backgroundColor: colors.border }]} /></View>;
  if (!isPlan && (message.kind === wire.PartnerGroupMessageKind.NOTICE || message.authorKind === wire.PartnerGroupAuthorKind.SYSTEM)) return <Text style={[styles.groupNotice, { color: colors.muted }]}>{notices[message.noticeCode] || message.content}</Text>;
  if (message.authorKind === wire.PartnerGroupAuthorKind.USER) return <View style={styles.userMessage}><View style={styles.userColumn}>
    {message.attachments.length > 0 && <MobileGroupAttachments key={view.api.ownerKey} group={group} message={message} transport={attachments} colors={colors} locale={locale} />}
    {!!message.content && <View style={[styles.userBubble, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text selectable style={[styles.body, { color: colors.ink }]}>{wire.splitPartnerGroupMentionSegments(message.content, ["all", "所有人", ...group.members.map(member => member.name)]).map((segment, index) => segment.mention ? <Text key={index} style={{ backgroundColor: colors.brandBackground, fontWeight: "500" }}>{segment.text}</Text> : segment.text)}</Text></View>}
  </View></View>;
  return <View style={[styles.partnerMessage, continued && styles.partnerContinued]}>{continued ? <View style={styles.avatarSpacer} /> : <MobilePartnerAvatar preset={author?.avatar ?? "orbit"} partner={author} colors={colors} size={28} />}<View style={styles.partnerBody}>
    {!continued && <View style={styles.authorRow}><Text style={[styles.authorName, { color: colors.ink }]}>{isPlan ? plan!.organizerName : message.authorName}</Text>{isPlan && <View style={[styles.organizerBadge, { backgroundColor: colors.brandBackground }]}><Text style={[styles.organizerText, { color: colors.muted }]}>{m.organizer}</Text></View>}</View>}
    {isPlan ? <MobileGroupPlan plan={plan!} view={view} group={group} partners={partners} colors={colors} locale={locale} /> : !!message.content && <MobileMarkdownMessage text={message.content} colors={colors} locale={locale} ownerKey={`${view.api.ownerKey}:${group.id}`} messageId={message.id} />}
    {message.attachments.length > 0 && <MobileGroupAttachments key={view.api.ownerKey} group={group} message={message} transport={attachments} colors={colors} locale={locale} />}
    {message.files.length > 0 && <View style={styles.choices}>{message.files.map(path => <Pressable key={path} accessibilityRole="button" accessibilityLabel={path} hitSlop={6} onPress={() => Alert.alert(path, m.readOnlyFiles)} style={[styles.fileChip, { borderColor: colors.border, backgroundColor: colors.surface }]}><MobileGroupIcon name="file" color={colors.muted} size={13} /><Text numberOfLines={1} style={[styles.caption, { color: colors.ink }]}>{path.split(/[\\/]/u).at(-1)}</Text></Pressable>)}</View>}
    </View>
  </View>;
}
function MobileGroupPlan({ plan, view, group, partners, colors, locale }: { plan: wire.PartnerGroupPlan; view: GroupView; group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale), [editing, setEditing] = useState<number>();
  const selected = useRef<wire.PartnerGroupPlanStep | undefined>(undefined);
  const proposed = plan.status === wire.PartnerGroupPlanStatus.PROPOSED, waiting = plan.status === wire.PartnerGroupPlanStatus.WAITING;
  const muted = plan.status === wire.PartnerGroupPlanStatus.SUPERSEDED || plan.status === wire.PartnerGroupPlanStatus.DISMISSED, locked = state.busy || state.status !== "ready";
  const statuses = ["", m.pending, m.running, m.done, m.failed], done = plan.steps.filter(step => step.status === wire.PartnerGroupStepStatus.DONE).length;
  const progress = proposed ? m.proposed : plan.status === wire.PartnerGroupPlanStatus.DONE ? m.done : `${done} / ${plan.steps.length}`;
  return <View style={[styles.planCard, { borderColor: colors.border, backgroundColor: colors.surface }, muted && styles.disabled]}><View style={styles.planEyebrow}><Text style={[styles.planEyebrowText, { color: colors.muted }]}>{m.plan}</Text><Text style={[styles.caption, { color: colors.muted }]}>{progress}</Text></View>
    <Text style={[styles.planTitle, { color: colors.ink }]}>{m.planIntro.replace("{count}", String(plan.steps.length))}</Text>
    <View>{plan.steps.map(step => { const partner = partners.find(item => item.partnerId === step.partnerId), editable = proposed || waiting && (step.status === wire.PartnerGroupStepStatus.PENDING || step.status === wire.PartnerGroupStepStatus.FAILED);
      const content = <><View style={styles.stepLead}>{proposed || muted ? <Text style={[styles.caption, { color: colors.muted }]}>{step.position + 1}</Text> : step.status === wire.PartnerGroupStepStatus.RUNNING ? <View style={[styles.runningDot, { backgroundColor: colors.accent }]} /> : <MobileGroupIcon name={step.status === wire.PartnerGroupStepStatus.DONE ? "check" : step.status === wire.PartnerGroupStepStatus.FAILED ? "failed" : "pending"} color={step.status === wire.PartnerGroupStepStatus.FAILED ? colors.negative : colors.muted} />}</View>
        <MobilePartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} colors={colors} size={24} /><Text numberOfLines={1} style={[styles.stepText, { color: colors.muted }]}><Text style={[styles.stepName, { color: colors.ink }]}>{step.partnerName}</Text>{" "}{step.task}</Text>
        {!proposed && !muted && step.status !== wire.PartnerGroupStepStatus.PENDING && <Text style={[styles.caption, { color: colors.muted }]}>{statuses[step.status]}</Text>}</>;
      return editable ? <Pressable key={step.position} accessibilityRole="button" accessibilityLabel={`${m.reassign} ${step.position + 1}`} accessibilityHint={`${step.partnerName} ${step.task}`} accessibilityState={{ disabled: locked }} disabled={locked} style={styles.stepRow} onPress={() => { selected.current = step; setEditing(step.position); }}>{content}</Pressable> : <View key={step.position} style={styles.stepRow}>{content}</View>;
    })}</View>
    {proposed && <><View style={styles.planActions}><View style={styles.grow}><MobileGroupAction label={m.dismiss} compact colors={colors} disabled={locked} onPress={() => void view.action(signal => view.api.planAction(group.id, plan, wire.PartnerGroupPlanAction.DISMISS, signal))} /></View><View style={styles.grow}><MobileGroupAction label={m.start} compact primary colors={colors} disabled={locked} onPress={() => void view.action(signal => view.api.planAction(group.id, plan, wire.PartnerGroupPlanAction.START, signal))} /></View></View><Text style={[styles.groupNotice, { color: colors.muted }]}>{m.pauseNote}</Text></>}
    {(muted || plan.status === wire.PartnerGroupPlanStatus.STOPPED) && <Text style={[styles.caption, { color: colors.muted }]}>{["", m.proposed, m.running, m.waiting, m.done, m.stopped, m.dismissed, m.superseded][plan.status]}</Text>}
    <MobileActionSheet visible={editing !== undefined && state.status === "ready"} items={[...group.members.filter(member => member.status === wire.PartnerGroupMemberStatus.ACTIVE).map(member => ({ id: `member:${member.partnerId}`, label: member.name, disabled: locked })), ...(proposed ? [{ id: "remove-step", label: m.remove, destructive: true, separatorBefore: true, disabled: locked || plan.steps.length <= 1 }] : [])]} colors={colors} locale={locale} onClose={() => setEditing(undefined)} onAction={id => { const step = selected.current; if (!step) return; const partnerId = id === "remove-step" ? undefined : id.slice("member:".length);
      if (partnerId === step.partnerId) return; void view.action(signal => view.api.planEdit(group.id, plan, step.position, id === "remove-step" ? wire.PartnerGroupPlanEditAction.REMOVE : wire.PartnerGroupPlanEditAction.REASSIGN, partnerId, signal)); }} />
  </View>;
}
function MobileGroupPlanFollowUp({ plan, view, group, partners, colors, locale }: { plan: wire.PartnerGroupPlan; view: GroupView; group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale), current = plan.currentStep === undefined ? undefined : plan.steps[plan.currentStep];
  const failed = current?.status === wire.PartnerGroupStepStatus.FAILED, step = failed ? current : plan.steps[(plan.currentStep ?? -1) + 1];
  if (!step || !failed && current?.status !== wire.PartnerGroupStepStatus.DONE) return null;
  const partner = partners.find(item => item.partnerId === step.partnerId), locked = state.busy || state.status !== "ready", act = (action: wire.PartnerGroupPlanAction) => void view.action(signal => view.api.planAction(group.id, plan, action, signal));
  return <View style={[styles.planCard, { borderColor: colors.border, backgroundColor: colors.surface }]}><View style={styles.planEyebrow}><Text style={[styles.planEyebrowText, { color: colors.muted }]}>{failed ? m.failed : m.nextStep}</Text><Text style={[styles.caption, { color: colors.muted }]}>{step.position + 1} / {plan.steps.length}</Text></View>
    <View style={styles.followUpWho}><MobilePartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} colors={colors} size={24} /><Text numberOfLines={2} style={[styles.planTitle, styles.grow, { color: colors.ink }]}><Text style={{ fontWeight: "500" }}>{step.partnerName}</Text>{" "}{step.task}</Text></View>
    <View style={styles.planActions}><View style={styles.grow}><MobileGroupAction label={m.stop} compact colors={colors} disabled={locked} onPress={() => act(wire.PartnerGroupPlanAction.DISMISS)} /></View><View style={styles.grow}><MobileGroupAction label={failed ? m.retry : m.next} compact primary colors={colors} disabled={locked} onPress={() => act(failed ? wire.PartnerGroupPlanAction.RETRY : wire.PartnerGroupPlanAction.CONTINUE)} /></View></View>
  </View>;
}
function MobileGroupComposer({ view, group, colors, locale, transport, running, onSent }: { view: GroupView; group: wire.PartnerGroupSummary; colors: MobilePartnersColors; locale: MobileSupportedLocale; transport?: MobileGroupAttachmentTransport; running: boolean; onSent(): void }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale);
  const [text, setText] = useState(""), [selection, setSelection] = useState<MobileComposerSelection>({ start: 0, end: 0 }), [files, setFiles] = useState<readonly MobileLocalComposerAttachment[]>([]), [division, setDivision] = useState(false);
  const [picking, setPicking] = useState(false), [pickError, setPickError] = useState<string>(), [photos, setPhotos] = useState(false), [browsable, setBrowsable] = useState(false);
  const [more, setMore] = useState(false);
  const [image, setImage] = useState<{ session: MobileComposerImageEditorSession; attachment: MobileLocalComposerAttachment; transport: MobileGroupAttachmentTransport }>();
  const input = useRef<MobileComposerRichInputHandle>(null), staged = useRef(files); staged.current = files;
  const draft = useMemo(() => plainTextMobileComposerDraft(text), [text]), draftRef = useRef(draft); draftRef.current = draft;
  const [inputHeight, setInputHeight] = useState(44), caret = selection.start;
  const paste = useRef<{ draft: typeof draft; count: number; transport: MobileGroupAttachmentTransport; abort: AbortController } | undefined>(undefined);
  const fileOwner = useRef(transport), nativePick = useRef<AbortController | undefined>(undefined); if (transport) fileOwner.current = transport;
  const uploads = useRef(new Map<string, wire.PartnerGroupAttachment>()), attempt = useRef<{ id: string; signature: string } | undefined>(undefined);
  const tracked = useRef<wire.PartnerGroupTrackedMention[]>([]);
  const disabled = picking || state.busy || state.status !== "ready" || group.deleting, query = wire.findPartnerGroupMentionQuery(text, caret);
  const divisionBlocked = !!group.openPlan && group.openPlan.status !== wire.PartnerGroupPlanStatus.PROPOSED, showStop = running && !text.trim() && !files.length;
  useEffect(() => () => { nativePick.current?.abort(); if (fileOwner.current) for (const file of staged.current) void fileOwner.current.remove(file).catch(() => undefined); }, []);
  useEffect(() => { if (state.status !== "ready" || paste.current && paste.current.transport.ownerKey !== transport?.ownerKey) {
    nativePick.current?.abort(); nativePick.current = undefined; paste.current = undefined; setPicking(false);
  } }, [state.status, transport?.ownerKey]);
  useEffect(() => { let active = true; if (transport) void transport.photoLibrary.directlyBrowsable().then(value => { if (active) setBrowsable(value); }).catch(() => undefined); return () => { active = false; }; }, [transport?.ownerKey]);
  const pick = async (source: "files" | "photos" | "camera", assets?: readonly MobilePhotoLibraryAsset[]) => {
    if (disabled || !transport) return; const abort = nativePick.current = new AbortController(); setPicking(true); setPickError(undefined);
    try { const incoming = await transport.pick(group, files, abort.signal, source, assets); abort.signal.throwIfAborted(); setFiles(current => [...current, ...incoming]); setPhotos(false); }
    catch (error) { if (!abort.signal.aborted) { setPickError(String(error)); throw error; } }
    finally { if (nativePick.current === abort && !abort.signal.aborted) { nativePick.current = undefined; setPicking(false); } }
  };
  const send = () => void view.action(async signal => {
    const mentions = wire.resolvePartnerGroupMentions(text, { members: group.members, allLabels: ["all", "所有人"], tracked: tracked.current });
    const signature = JSON.stringify([text, division, files.map(file => [file.attachmentId, file.sha256Hex]), mentions]); if (attempt.current?.signature !== signature) attempt.current = { id: view.api.newRequestId(), signature };
    const attachments: wire.PartnerGroupAttachment[] = [];
    for (const file of files) { let uploaded = uploads.current.get(file.attachmentId); if (!uploaded) { if (!transport) throw new Error(m.unavailable); uploaded = await transport.upload(file, signal); uploads.current.set(file.attachmentId, uploaded); } attachments.push(uploaded); }
    await view.api.send(view.group() ?? group, { text, attachments, division, mentions }, attempt.current.id, signal); setText(""); setSelection({ start: 0, end: 0 }); setFiles([]); setDivision(false); uploads.current.clear(); attempt.current = undefined; tracked.current = [];
    if (transport) await Promise.all(files.map(file => transport.remove(file))); onSent();
  });
  const mention = (name: string, partnerId?: string) => { if (!query) return; const result = wire.insertPartnerGroupMention(text, { start: query.start, end: caret }, name); if (partnerId) tracked.current.push({ partnerId, label: name }); setText(result.text); setSelection({ start: result.caret, end: result.caret }); input.current?.focus(); };
  return <View style={[styles.composer, { backgroundColor: colors.background }]}>
    {division && <View style={styles.divisionTagRow}><View style={[styles.divisionTag, { backgroundColor: colors.brandBackground }]}><Text style={[styles.caption, { color: colors.ink }]}>{m.divisionTag}</Text><GroupIconAction label={m.removeDivision} name="close" colors={colors} disabled={disabled} onPress={() => { setDivision(false); input.current?.focus(); }} /></View></View>}
    {files.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"><View style={styles.choices}>{files.map(file => <View key={file.attachmentId} style={styles.choices}>
      {file.kind === "image" && transport && <MobileGroupAction label={file.fileName} colors={colors} disabled={disabled} onPress={() => void view.action(async signal => { const session = await transport.prepareImage(group, file, signal); setImage({ session, attachment: file, transport }); }, false)} />}
      <MobileGroupAction label={`${file.fileName} ×`} colors={colors} disabled={disabled} onPress={() => { setFiles(current => current.filter(item => item.attachmentId !== file.attachmentId)); uploads.current.delete(file.attachmentId); if (transport) void transport.remove(file).catch(() => undefined); }} />
    </View>)}</View></ScrollView>}
    {query && <ScrollView style={styles.mentionPicker} keyboardShouldPersistTaps="handled"><MobileGroupAction label="@all" colors={colors} onPress={() => mention("all")} />{wire.filterPartnerGroupMentionCandidates(query.query, group.members).map(member => <MobileGroupAction key={member.partnerId} label={member.name} colors={colors} onPress={() => mention(member.name, member.partnerId)} />)}</ScrollView>}
    <View style={[styles.composerRow, { backgroundColor: colors.surface, borderColor: colors.border }]}><GroupIconAction label={m.more} name="plus" colors={colors} disabled={disabled} onPress={() => setMore(true)} /><View testID="partnerGroups.composer" style={styles.grow}><MobileComposerRichInput ref={input} draft={draft} selection={selection} locale={locale} editable={!disabled} ownerKey={`${view.api.ownerKey}:${group.id}:composer`}
      accessibilityLabel={m.placeholder} placeholder={m.placeholder} height={inputHeight} maxHeight={180} onHeightChange={setInputHeight} onError={setPickError}
      theme={{ background: colors.surface, border: colors.border, chip: colors.brandBackground, focus: colors.accent, placeholder: colors.muted, text: colors.ink, textSecondary: colors.muted }}
      onEdit={(result, source) => { if (disabled || draftRef.current !== source) return; const next = result.draft.text.slice(0, 8000); setText(next); setSelection({ start: Math.min(next.length, result.selection.start), end: Math.min(next.length, result.selection.end) }); }}
      onSelectionChange={(next, source) => { if (draftRef.current === source) setSelection(next); }}
      onPasteText={request => { void (async () => { const value = request.text ?? await (await import("expo-clipboard")).getStringAsync();
        if (disabled || draftRef.current !== request.draft) return; const result = replaceMobileComposerRange(request.draft, request.selection, value.slice(0, Math.max(0, 8000 - request.draft.text.length + request.selection.end - request.selection.start))); setText(result.draft.text); setSelection(result.selection);
      })().catch(error => setPickError(String(error))); }}
      onPasteImagesStart={request => { if (disabled || !transport || paste.current || request.draft !== draftRef.current || request.count < 1 || files.length + request.count > 20) return false;
        const abort = nativePick.current = new AbortController(); paste.current = { draft: request.draft, count: request.count, transport, abort }; setPicking(true); setPickError(undefined); return true; }}
      onPasteImagesCancel={source => { const pending = paste.current; if (pending?.draft !== source) return; paste.current = undefined; pending.abort.abort(); if (nativePick.current === pending.abort) nativePick.current = undefined; setPicking(false); }}
      onPasteImages={request => { const pending = paste.current; if (!pending || request.draft !== pending.draft || request.images.length !== pending.count) return;
        void pending.transport.paste(group, staged.current, request.images, pending.abort.signal).then(async incoming => {
          if (pending.abort.signal.aborted || paste.current !== pending || draftRef.current !== pending.draft) { await Promise.all(incoming.map(item => pending.transport.remove(item))); return; }
          setFiles(current => [...current, ...incoming]);
        }).catch(error => { if (!pending.abort.signal.aborted) setPickError(String(error)); }).finally(() => {
          if (paste.current === pending) { paste.current = undefined; if (nativePick.current === pending.abort) nativePick.current = undefined; setPicking(false); }
        }); }} /></View><GroupIconAction label={showStop ? m.stop : m.send} name={showStop ? "stop" : "send"} primary colors={colors} disabled={disabled || !showStop && (!text.trim() && !files.length || division && divisionBlocked)} onPress={() => showStop ? void view.action(signal => view.api.stop(group.id, signal)) : send()} /></View>
    {pickError && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{pickError}</Text>}
    <MobileActionSheet visible={more && state.status === "ready"} items={[...(transport ? [
      { id: "files", label: m.attach, disabled: disabled || files.length >= 20 }, { id: "camera", label: mobileMessage(locale, "composer.takePhoto"), disabled: disabled || files.length >= 20 },
      { id: "photos", label: mobileMessage(locale, "attachments.source.photos"), disabled: disabled || files.length >= 20 }
    ] : []), { id: "division", label: m.divide, disabled: disabled || divisionBlocked, separatorBefore: !!transport }]} colors={colors} locale={locale} onClose={() => setMore(false)} onAction={action => {
      if (disabled) return; if (action === "division") { setDivision(true); input.current?.focus(); } else if (action === "photos" && browsable) setPhotos(true); else if (action === "photos" || action === "camera" || action === "files") void pick(action).catch(() => undefined);
    }} />
    {photos && fileOwner.current && <MobilePhotoLibrarySheet visible ownerKey={fileOwner.current.ownerKey} maximumSelection={20 - files.length} colors={colors} locale={locale} library={fileOwner.current.photoLibrary} onAdd={assets => pick("photos", assets)} onClose={() => setPhotos(false)} />}
    {image && <MobileImageLightbox session={image.session} locale={locale} onClose={() => { image.transport.cancelImage(image.session.leaseId); setImage(undefined); }} onSave={async (strokes, burned, signal) => {
      await view.action(async ownedSignal => { signal.throwIfAborted(); const replacement = await image.transport.commitImage(group, image.session.leaseId, image.attachment, strokes, burned, ownedSignal); signal.throwIfAborted();
        setFiles(current => current.map(file => file.attachmentId === image.attachment.attachmentId ? replacement : file)); uploads.current.delete(image.attachment.attachmentId);
        await image.transport.removeReplacedImage(image.attachment, replacement); setImage(undefined); }, false, true);
    }} />}
  </View>;
}
function MobilePartnerGroupSettings({ view, group, partners, colors, locale, onBack, onDeleted }: { view: GroupView; group: wire.PartnerGroupSummary; partners: readonly MobilePartnerDirectoryProfile[]; colors: MobilePartnersColors; locale: MobileSupportedLocale; onBack(): void; onDeleted(): void }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), m = wire.partnerGroupMessages(locale), [name, setName] = useState(group.name), [ids, setIds] = useState(group.members.map(member => member.partnerId));
  const locked = state.busy || state.status !== "ready", current = () => view.group() ?? group;
  const update = (patch: wire.PartnerGroupSettingsPatch) => void view.action(signal => view.api.update(current(), patch, signal));
  return <View style={[styles.screen, { backgroundColor: colors.background }]}><View style={styles.header}><MobileGroupAction label={m.back} colors={colors} onPress={onBack} /><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{m.settings}</Text></View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Text style={{ color: colors.ink }}>{m.name}</Text><TextInput accessibilityLabel={m.name} value={name} onChangeText={setName} maxLength={40} editable={!locked} style={[styles.input, { color: colors.ink, borderColor: colors.border }]} />
      <MobileGroupAction label={m.save} colors={colors} disabled={locked || !name.trim()} onPress={() => update({ name: name.trim() })} />
      <Text style={{ color: colors.ink }}>{m.replyMode}</Text><View style={styles.choices}>{[[wire.PartnerGroupReplyMode.ALL, m.all], [wire.PartnerGroupReplyMode.MENTIONED, m.mentioned]].map(([value, label]) => <MobileGroupAction key={value} label={String(label)} colors={colors} disabled={locked} selected={group.replyMode === value} onPress={() => update({ replyMode: Number(value) })} />)}</View>
      <Text style={{ color: colors.ink }}>{m.speaking}</Text><View style={styles.choices}>{[[wire.PartnerGroupSpeakingMode.AUTO, m.auto], [wire.PartnerGroupSpeakingMode.SEQUENTIAL, m.sequential]].map(([value, label]) => <MobileGroupAction key={value} label={String(label)} colors={colors} disabled={locked} selected={group.speakingMode === value} onPress={() => update({ speakingMode: Number(value) })} />)}</View>
      <Text style={{ color: colors.ink }}>{m.organizer}</Text><View style={styles.choices}><MobileGroupAction label={m.automatic} colors={colors} disabled={locked} selected={!group.organizerPartnerId} onPress={() => update({ organizerSelection: { case: "clearOrganizer", value: true } })} />
        {group.members.map(member => <MobileGroupAction key={member.partnerId} label={member.name} colors={colors} disabled={locked} selected={member.partnerId === group.organizerPartnerId} onPress={() => update({ organizerSelection: { case: "organizerPartnerId", value: member.partnerId } })} />)}</View>
      <Text style={{ color: colors.ink }}>{m.membersHint}</Text><View style={styles.choices}>{partners.filter(partner => partner.lifecycle !== "archived").map(partner => <MobileGroupAction key={partner.partnerId} label={partner.displayName} colors={colors} disabled={locked || ids.length >= 6 && !ids.includes(partner.partnerId)} selected={ids.includes(partner.partnerId)} onPress={() => setIds(current => current.includes(partner.partnerId) ? current.filter(id => id !== partner.partnerId) : [...current, partner.partnerId])} />)}</View>
      <MobileGroupAction label={m.save} colors={colors} disabled={locked || ids.length < 2 || ids.length > 6} onPress={() => void view.action(signal => view.api.members(current(), ids, signal))} />
      {group.projectDirName && <Text style={{ color: colors.muted }}>{m.project} · {group.projectDirName}</Text>}
      {state.error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{state.error}</Text>}<Text style={{ color: colors.muted }}>{m.deleteHint}</Text>
      <MobileGroupAction label={m.delete} colors={colors} disabled={locked} onPress={() => Alert.alert(m.confirmDelete, m.deleteHint, [{ text: m.cancel, style: "cancel" }, { text: m.delete, style: "destructive", onPress: () => void view.action(async signal => { await view.api.remove(current(), signal); onDeleted(); }) }])} />
    </ScrollView></View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth }, title: { fontSize: 18, lineHeight: 26, fontWeight: "600" }, grow: { flex: 1, minWidth: 0 }, content: { padding: 16, gap: 12 },
  action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, justifyContent: "center" }, actionText: { fontSize: 15, lineHeight: 20 }, compactAction: { minHeight: 38, paddingVertical: 8, borderRadius: 999, alignItems: "center" }, iconAction: { width: 38, height: 38, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" }, disabled: { opacity: .45 }, choices: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minHeight: 44, padding: 12, fontSize: 16 }, composerInput: { maxHeight: 180 }, directoryRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  avatars: { width: 60, height: 56, flexDirection: "row", flexWrap: "wrap" }, avatar: { width: 30, height: 28 }, unread: { width: 8, height: 8, borderRadius: 4 },
  field: { gap: 8 }, notice: { padding: 12, gap: 8 }, center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  chatTitle: { fontSize: 16, lineHeight: 22, fontWeight: "500" }, caption: { fontSize: 12, lineHeight: 18 }, body: { fontSize: 17, lineHeight: 26 },
  timeline: { flexGrow: 1, justifyContent: "flex-end", gap: 16, paddingHorizontal: 16, paddingVertical: 12 }, timelineFooter: { gap: 16 }, timelineItem: { gap: 16 }, time: { fontSize: 12, lineHeight: 18, textAlign: "center" }, partnerContinued: { marginTop: -8 }, avatarSpacer: { width: 28 },
  partnerMessage: { flexDirection: "row", alignItems: "flex-start", gap: 10 }, partnerBody: { flex: 1, minWidth: 0, gap: 4 }, authorRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }, authorName: { fontSize: 15, lineHeight: 28, fontWeight: "500" },
  organizerBadge: { borderRadius: 999, paddingHorizontal: 8 }, organizerText: { fontSize: 11, lineHeight: 16, fontWeight: "600" },
  userMessage: { flexDirection: "row", justifyContent: "flex-end" }, userColumn: { flex: 1, minWidth: 0, alignItems: "flex-end", gap: 4 }, userBubble: { maxWidth: "86%", borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  groupNotice: { fontSize: 13, lineHeight: 18, textAlign: "center" }, dividerRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }, dividerLine: { flex: 1, minWidth: 16, height: StyleSheet.hairlineWidth },
  planCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 16, gap: 4, overflow: "hidden" }, planEyebrow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 }, planEyebrowText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "500" }, planTitle: { fontSize: 16, lineHeight: 22, marginTop: 2 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }, stepLead: { width: 16, alignItems: "center", justifyContent: "center" }, stepText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20 }, stepName: { fontWeight: "500" }, runningDot: { width: 8, height: 8, borderRadius: 999 },
  planActions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }, indented: { paddingLeft: 38 }, followUpWho: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 2 },
  fileChip: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32, maxWidth: "100%", paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  composer: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 }, composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth }, divisionTagRow: { flexDirection: "row" }, divisionTag: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, paddingLeft: 8 }, mentionPicker: { maxHeight: 220 }
});
