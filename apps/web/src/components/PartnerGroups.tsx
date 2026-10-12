import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { ArrowLeft, Check, CircleAlert, CircleCheck, CircleDashed, FileText, FolderOpen, Paperclip, Plus, Send, Settings, Sparkles, Square, Users, X } from "lucide-react";
import * as groupWire from "@joko/contracts";
import { findPartnerGroupMentionQuery, filterPartnerGroupMentionCandidates, insertPartnerGroupMention } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ArtifactView, PartnerProfileView } from "../model.js";
import type { Translator } from "./types.js";
import { PartnerAvatar, PartnerAvatarProvider } from "./PartnerAvatar.js";
import { StreamingMarkdown, TimelineImageLightbox } from "./Timeline.js";
import { useTimelineArtifactUrlCache } from "./timeline-artifact-url-cache.js";
import type { TimelineGalleryImage } from "./timeline-image-gallery.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton.js";
import { TimelineTextAttachmentLightbox } from "./TimelineTextAttachmentLightbox.js";
import { timelineArtifactSupportsTextPreview } from "./timeline-text-attachment.js";
import { NativeArtifactFileActionsMenu } from "./NativeFileCopyMenu.js";
import { TimelineLinkMenu } from "./TimelineLinkMenu.js";
import { localProjectPickerOwner, sameProjectPickerOwner } from "./ProjectEditor.js";
import { InteractionDialog } from "./InteractionDialog.js";
import { interactionDecision, mapInteraction } from "../gateway.js";
import { Button, IconButton, Modal, Spinner } from "./ui.js";
import "./partner-groups.css";

type Copy = ReturnType<typeof groupWire.partnerGroupMessages>;
type View = groupWire.PartnerGroupViewController;
type GroupMenu = { trigger: HTMLButtonElement; position: { x: number; y: number } };
function menuAt(trigger: HTMLButtonElement, above = false): GroupMenu {
  const rect = trigger.getBoundingClientRect();
  return { trigger, position: { x: rect.left, y: above ? rect.top - 120 : rect.bottom + 4 } };
}
function closeMenu(menu: GroupMenu | undefined, restoreFocus: boolean, close: () => void): void {
  close(); if (restoreFocus && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
}
const OFFLINE_GROUP_STATE: groupWire.PartnerGroupViewState = { status: "offline", refreshing: false, busy: false };
const subscribeOffline = () => () => undefined;
function connectionKey(controller: AppController): string {
  const state = controller.state; return JSON.stringify([state.activeProfile?.serverId, state.activeProfile?.id, state.activeProfile?.origin,
    state.activeProfile?.deviceId, state.connectionGeneration, state.connectionState, state.snapshot.generation.toString()]);
}
function connectionScope(controller: AppController): string {
  const profile = controller.state.activeProfile;
  return JSON.stringify([profile?.serverId, profile?.id, profile?.origin, profile?.deviceId]);
}
function useGroups(controller: AppController, groupId?: string) {
  const currentKey = connectionKey(controller), scope = connectionScope(controller), root = useRef<HTMLDivElement>(null);
  const current = useMemo(() => controller.state.ready && controller.state.connectionState === "connected" ? controller.partnerGroupApi(currentKey) : undefined, [controller, currentKey]);
  const retained = useRef<{ scope: string; key: string; api: groupWire.PartnerGroupApi } | undefined>(undefined);
  if (current) retained.current = { scope, key: currentKey, api: current }; else if (retained.current?.scope !== scope) retained.current = undefined;
  const api = retained.current?.api, key = retained.current?.key ?? currentKey;
  const view = useMemo(() => api ? new groupWire.PartnerGroupViewController(api) : undefined, [api]);
  const state = useSyncExternalStore(view?.subscribe ?? subscribeOffline, () => view?.state ?? OFFLINE_GROUP_STATE, () => view?.state ?? OFFLINE_GROUP_STATE);
  useEffect(() => {
    if (!view) return;
    const document = root.current?.ownerDocument ?? window.document;
    const update = () => view.setActive(document.visibilityState !== "hidden" && controller.state.ready && controller.state.connectionState === "connected");
    const hide = () => view.setActive(false); update(); document.addEventListener("visibilitychange", update); document.defaultView?.addEventListener("pagehide", hide);
    return () => { document.removeEventListener("visibilitychange", update); document.defaultView?.removeEventListener("pagehide", hide); view.setActive(false); };
  }, [view, controller, current]);
  useEffect(() => { view?.select(groupId); }, [view, groupId]);
  return { root, view, state, key, scope, m: groupWire.partnerGroupMessages(controller.state.effectiveLocale) };
}
function AvatarPile({ group, partners }: { group: groupWire.PartnerGroupSummary; partners: readonly PartnerProfileView[] }) {
  return <span className="partner-group-avatars" aria-hidden="true">{group.members.slice(0, 4).map(member => {
    const profile = partners.find(partner => partner.id === member.partnerId);
    return <PartnerAvatar key={member.partnerId} preset={profile?.avatar ?? "orbit"} partner={profile} />;
  })}</span>;
}
export function PartnerGroupsNavigation({ controller, t, onClose }: { controller: AppController; t: Translator; onClose(): void }): JSX.Element | null {
  const { root, view, state, key, m } = useGroups(controller), [partners, setPartners] = useState<readonly PartnerProfileView[]>([]), [creating, setCreating] = useState(false);
  useEffect(() => { const abort = new AbortController(); if (view) void controller.listPartners(undefined, abort.signal).then(result => { if (!abort.signal.aborted) setPartners(result.partners); }).catch(() => undefined); return () => abort.abort(); }, [controller, view]);
  if (!view) return null;
  return <PartnerAvatarProvider controller={controller} ownerKey={key}><section className="partner-groups-navigation" ref={root} aria-label={m.groups}>
    <header><span>{m.groups}</span><IconButton label={m.create} disabled={state.status !== "ready"} onClick={() => setCreating(true)}><Plus /></IconButton></header>
    {state.catalog?.groups.map(group => <button type="button" key={group.id} className={`partner-group-directory-row${controller.state.route.kind === "partners" && controller.state.route.groupId === group.id ? " is-active" : ""}`}
      onClick={() => { controller.navigate({ kind: "partners", groupId: group.id }); onClose(); }}><AvatarPile group={group} partners={partners} /><span><strong>{group.name}</strong><small>{group.speakers.length ? m.replying : group.openPlan ? m.plan : group.lastMessage?.content || group.members.map(member => member.name).join(" · ")}</small></span>{group.unread && <span className="partner-group-unread" aria-label={m.unread} />}</button>)}
    {state.error && <p role="alert">{state.error}<Button onClick={() => view.setActive(true)}>{m.refresh}</Button></p>}
    {creating && <GroupCreate key={key} view={view} controller={controller} partners={partners} m={m} onClose={() => setCreating(false)} onCreated={group => { setCreating(false); controller.navigate({ kind: "partners", groupId: group.id }); onClose(); }} ownerDocument={root.current?.ownerDocument} />}
  </section></PartnerAvatarProvider>;
}
export function PartnerGroupsSection({ controller, partners, t }: { controller: AppController; partners: readonly PartnerProfileView[]; t: Translator }): JSX.Element {
  const { root, view, state, key, m } = useGroups(controller), [creating, setCreating] = useState(false);
  if (!view) return <section className="partner-groups-section" ref={root}><h2>{m.groups}</h2><p>{m.unavailable}</p></section>;
  return <section className="partner-groups-section" ref={root} aria-label={m.groups}>
    <header><h2><Users aria-hidden="true" />{m.groups}</h2><Button disabled={state.status !== "ready"} onClick={() => setCreating(true)}><Plus aria-hidden="true" />{m.create}</Button></header>
    {state.error && <p role="alert">{state.error}<Button onClick={() => view.setActive(true)}>{m.refresh}</Button></p>}
    {state.status === "loading" && <Spinner />}
    <div className="partner-group-directory">{state.catalog?.groups.map(group => <button type="button" key={group.id} className="partner-group-directory-row" onClick={() => controller.navigate({ kind: "partners", groupId: group.id })}>
      <AvatarPile group={group} partners={partners} /><span><strong>{group.name}</strong><small>{group.speakers.length ? m.replying : group.openPlan ? m.plan : group.lastMessage?.content || group.members.map(member => member.name).join(" · ")}</small></span>
      {group.unread && <span className="partner-group-unread" aria-label={m.unread} />}
    </button>)}</div>
    {creating && <GroupCreate key={key} view={view} controller={controller} partners={partners} m={m} onClose={() => setCreating(false)} onCreated={group => { setCreating(false); controller.navigate({ kind: "partners", groupId: group.id }); }} ownerDocument={root.current?.ownerDocument} />}
  </section>;
}
function GroupCreate({ view, controller, partners, m, onClose, onCreated, ownerDocument }: {
  view: View; controller: AppController; partners: readonly PartnerProfileView[]; m: Copy; onClose(): void; onCreated(group: groupWire.PartnerGroupSummary): void; ownerDocument?: Document;
}) {
  const [name, setName] = useState(""), [ids, setIds] = useState<string[]>([]), [receipt, setReceipt] = useState<string>(), [storageError, setStorageError] = useState<string>();
  const state = useSyncExternalStore(view.subscribe, () => view.state), storage = (ownerDocument ?? window.document).defaultView?.localStorage;
  const profile = controller.state.activeProfile, receiptKey = `joko.group-creation.v1:${JSON.stringify([profile?.serverId, profile?.id, profile?.origin, profile?.deviceId])}`;
  useEffect(() => { try { const saved = storage?.getItem(receiptKey); if (saved) { if (!/^[A-Za-z0-9_-]{16,100}$/u.test(saved)) throw new Error(m.pendingCreate); setReceipt(saved); } }
    catch (error) { setStorageError(String(error)); } }, [storage, receiptKey, m.pendingCreate]);
  const clear = () => { storage?.removeItem(receiptKey); setReceipt(undefined); };
  const createGroup = () => { void view.action(async signal => {
    if (!state.catalog?.revision || !storage) throw new Error(m.pendingCreate);
    const id = view.api.newRequestId(); storage.setItem(receiptKey, id); if (storage.getItem(receiptKey) !== id) throw new Error(m.pendingCreate); setReceipt(id);
    const group = await view.api.create(state.catalog.revision.value, name.trim(), ids, id, signal); clear(); onCreated(group); return group;
  }); };
  return <Modal open title={m.create} onClose={onClose} closeLabel={m.cancel} showClose ownerDocument={ownerDocument} dismissOnBackdrop={!state.busy}>
    <div className="partner-group-form"><label>{m.name}<input value={name} maxLength={40} onChange={event => setName(event.target.value)} disabled={state.busy || !!receipt} autoFocus /></label>
      <fieldset><legend>{m.membersHint}</legend>{partners.filter(partner => partner.lifecycle !== "archived" && partner.lifecycle !== "deleted").map(partner => <label className="partner-group-check" key={partner.id}>
        <input type="checkbox" checked={ids.includes(partner.id)} disabled={state.busy || !!receipt || ids.length >= 6 && !ids.includes(partner.id)} onChange={() => setIds(current => current.includes(partner.id) ? current.filter(id => id !== partner.id) : [...current, partner.id])} />
        <PartnerAvatar preset={partner.avatar} partner={partner} /><span>{partner.displayName}</span>
      </label>)}</fieldset>
      {state.error && <p role="alert">{state.error}</p>}{storageError && <p role="alert">{storageError}</p>}
      {receipt ? <div role="status"><p>{m.pendingCreate}</p><Button disabled={state.busy} onClick={() => void view.action(async signal => { const result = await view.api.lookup(receipt, signal); if (result.group) { clear(); onCreated(result.group); } else if (result.retired) clear(); })}>{m.checkCreate}</Button>
        <Button disabled={state.busy} onClick={() => void view.action(async signal => { const result = await view.api.retire(receipt, signal); if (result.retired) clear(); else if (result.group) { clear(); onCreated(result.group); } })}>{m.retireCreate}</Button></div>
        : <Button tone="primary" disabled={state.busy || !!storageError || !name.trim() || ids.length < 2 || ids.length > 6} onClick={createGroup}>{state.busy ? <Spinner /> : <Plus aria-hidden="true" />}{m.create}</Button>}
    </div>
  </Modal>;
}

export function PartnerGroupPage({ controller, groupId, t, onOpenNavigation }: { controller: AppController; groupId: string; t: Translator; onOpenNavigation(): void }): JSX.Element {
  const { root, view, state, key, scope, m } = useGroups(controller, groupId), [partners, setPartners] = useState<readonly PartnerProfileView[]>([]), [settings, setSettings] = useState(false);
  const group = state.detail?.detail?.group, detail = state.detail?.detail, timeline = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), last = useRef<HTMLDivElement>(null);
  const retainedGroup = useRef<{ scope: string; id: string; group: groupWire.PartnerGroupSummary } | undefined>(undefined);
  if (group) retainedGroup.current = { scope, id: groupId, group }; else if (retainedGroup.current?.scope !== scope || retainedGroup.current?.id !== groupId || state.status === "ready" && state.catalog && !state.catalog.groups.some(item => item.id === groupId)) retainedGroup.current = undefined;
  const composerGroup = group ?? retainedGroup.current?.group;
  const timeGroups = useMemo(() => groupWire.collectPartnerGroupMessageTimeGroups(detail?.messages ?? []), [detail?.messages]);
  const dropFiles = useRef<((files: readonly File[]) => void) | undefined>(undefined);
  const following = useRef(true), olderScroll = useRef<{ height: number; top: number } | undefined>(undefined);
  useEffect(() => { following.current = true; olderScroll.current = undefined; }, [groupId, key]);
  useLayoutEffect(() => { const host = timeline.current; if (!host || !detail) return;
    if (olderScroll.current) { host.scrollTop = olderScroll.current.top + host.scrollHeight - olderScroll.current.height; olderScroll.current = undefined; }
    else if (following.current) host.scrollTop = host.scrollHeight;
  }, [detail?.messages]);
  useEffect(() => { const host = timeline.current, body = content.current;
    if (!host || !body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (following.current && !olderScroll.current) host.scrollTop = host.scrollHeight; });
    observer.observe(host); observer.observe(body); return () => observer.disconnect();
  }, [view, !!detail]);
  useEffect(() => { const abort = new AbortController(); void controller.listPartners(undefined, abort.signal).then(result => { if (!abort.signal.aborted) setPartners(result.partners); }).catch(() => undefined); return () => abort.abort(); }, [controller, key]);
  useEffect(() => { const element = last.current, host = timeline.current; if (!element || !host || !detail?.messages.length) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) view?.markVisible(detail.messages.at(-1)!.sequence); }, { root: host, threshold: .6 }); observer.observe(element); return () => observer.disconnect();
  }, [view, detail?.messages.at(-1)?.sequence]);
  if (!view) return <main className="partner-group-page" ref={root}><Button onClick={() => controller.navigate({ kind: "partners" })}>{m.back}</Button><p>{m.unavailable}</p></main>;
  return <PartnerAvatarProvider controller={controller} ownerKey={key}><main className="partner-group-page" ref={root}
    onDragOver={event => { if (dropFiles.current && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={event => { if (dropFiles.current && event.dataTransfer.files.length) { event.preventDefault(); dropFiles.current(Array.from(event.dataTransfer.files)); } }}>
    <header className="partner-group-header"><IconButton label={m.back} onClick={() => controller.navigate({ kind: "partners" })}><ArrowLeft /></IconButton>
      {composerGroup && <AvatarPile group={composerGroup} partners={partners} />}<div><h1>{composerGroup?.name ?? m.groups}</h1><small>{composerGroup?.members.map(member => member.name).join(" · ")}</small></div>
      <IconButton label={m.settings} disabled={!group || state.busy} onClick={() => setSettings(true)}><Settings /></IconButton></header>
    {state.error && <div className="partner-group-error" role="alert">{state.error}<Button onClick={() => view.setActive(true)}>{m.refresh}</Button></div>}
    {!detail ? <div className="partner-group-empty">{state.status === "loading" ? <Spinner /> : <Users />}<p>{state.status === "loading" ? m.loading : m.unavailable}</p></div>
      : <><div className="partner-group-timeline" ref={timeline} role="log" aria-label={group!.name} onScroll={event => { const host = event.currentTarget; following.current = host.scrollHeight - host.scrollTop - host.clientHeight < 48; }}><div className="partner-group-timeline-content" ref={content}>
        {detail.hasMoreBefore && <Button disabled={state.busy} onClick={() => { const host = timeline.current; if (host) olderScroll.current = { height: host.scrollHeight, top: host.scrollTop }; following.current = false; void view.older().finally(() => { if (view.state.detail?.detail?.messages === detail.messages) olderScroll.current = undefined; }); }}>{m.older}</Button>}
        {!detail.messages.length && <div className="partner-group-empty"><Users /><p>{m.empty}</p></div>}
        {detail.messages.map(message => <Fragment key={message.id}>{timeGroups.has(message.id) && <time className="partner-group-time">{groupWire.formatPartnerGroupMessageTime(timeGroups.get(message.id)!, controller.state.effectiveLocale)}</time>}
          {!(detail.canContinue && message.id === detail.messages.at(-1)?.id && message.kind === groupWire.PartnerGroupMessageKind.ROUND_END) && <GroupMessage message={message} plans={detail.plans} group={group!} partners={partners} view={view} controller={controller} m={m} t={t} />}
        </Fragment>)}
        {group!.speakers.map(speaker => { const partner = partners.find(item => item.id === speaker.partnerId); return <article className="partner-group-message is-partner" key={`speaking:${speaker.partnerId}`} role="status">
          <PartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} /><div className="partner-group-message-body"><header><strong>{group!.members.find(member => member.partnerId === speaker.partnerId)?.name}</strong></header>
            <div className="partner-group-speaking"><Sparkles aria-hidden="true" />{speaker.activity === groupWire.PartnerGroupSpeakerActivity.PLANNING ? m.planning : speaker.activity === groupWire.PartnerGroupSpeakerActivity.STEP ? m.running : m.replying}</div>
          </div></article>; })}
        {detail.plans.filter(plan => plan.status === groupWire.PartnerGroupPlanStatus.WAITING && plan.id === (group!.openPlan?.id ?? detail.plans.at(-1)?.id)).map(plan => <GroupPlanFollowUp key={plan.id} plan={plan} group={group!} partners={partners} view={view} m={m} />)}
        {detail.canContinue && <div className="partner-group-divider"><span>{m.roundEnd}</span><Button disabled={state.busy} onClick={() => void view.action(signal => view.api.continue(groupId, signal))}>{m.continue}</Button></div>}
        <div ref={last} className="partner-group-last" aria-hidden="true" />
      </div></div>
      {state.detail?.interactions.flatMap(context => context.interactions).map(interaction => <GroupDecision key={`${interaction.interactionId}:${interaction.generation}`} interaction={interaction} view={view} groupId={groupId} controller={controller} t={t} />)}
    </>}
    {composerGroup && <GroupComposer key={`${scope}:${groupId}`} view={view} group={composerGroup} partners={partners} controller={controller} m={m} t={t} dropFiles={dropFiles}
      running={detail?.roundRunning ?? false}
      onSent={() => { following.current = true; const host = timeline.current; if (host) host.scrollTop = host.scrollHeight; }} />}
    {settings && group && <GroupSettings key={group.id} group={group} partners={partners} view={view} controller={controller} m={m} onClose={() => setSettings(false)} ownerDocument={root.current?.ownerDocument} />}
  </main></PartnerAvatarProvider>;
}
function GroupMessage({ message, plans, group, partners, view, controller, m, t }: { message: groupWire.PartnerGroupMessage; plans: groupWire.PartnerGroupPlan[]; group: groupWire.PartnerGroupSummary;
  partners: readonly PartnerProfileView[]; view: View; controller: AppController; m: Copy; t: Translator }) {
  const plan = plans.find(item => item.id === message.planId), isPlan = message.kind === groupWire.PartnerGroupMessageKind.PLAN && !!plan;
  const partner = partners.find(item => item.id === (isPlan ? plan?.organizerPartnerId : message.authorPartnerId));
  const notice = ["", m.memberFailed, m.memberTimeout, m.memberUnavailable, m.planFailed, m.planStopped, m.workdirUnavailable][message.noticeCode];
  if (!isPlan && message.authorKind === groupWire.PartnerGroupAuthorKind.SYSTEM) return <div className="partner-group-divider" role="status"><span>{message.kind === groupWire.PartnerGroupMessageKind.ROUND_END ? m.roundEnd : message.kind === groupWire.PartnerGroupMessageKind.PLAN_END ? m.planEnd : `${message.authorName} ${notice || message.content}`}</span></div>;
  if (message.authorKind === groupWire.PartnerGroupAuthorKind.USER) return <article className="partner-group-message is-user"><div className="partner-group-user-stack">
    {message.attachments.length > 0 && <GroupAttachments key={view.api.ownerKey} message={message} view={view} controller={controller} m={m} t={t} />}
    {message.content && <div className="partner-group-user-bubble">{groupWire.splitPartnerGroupMentionSegments(message.content, ["all", "所有人", ...group.members.map(member => member.name)]).map((segment, index) => segment.mention ? <span key={index} className="partner-group-mention">{segment.text}</span> : segment.text)}</div>}
  </div></article>;
  return <article className="partner-group-message is-partner">
    <PartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} /><div className="partner-group-message-body"><header><strong>{isPlan ? plan!.organizerName : message.authorName}</strong>{isPlan && <span className="partner-group-organizer">{m.organizer}</span>}</header>
      {isPlan ? <GroupPlan plan={plan!} group={group} partners={partners} view={view} m={m} /> : <StreamingMarkdown text={message.content} streaming={false} t={t} />}
      {message.attachments.length > 0 && <GroupAttachments key={view.api.ownerKey} message={message} view={view} controller={controller} m={m} t={t} />}
      {message.files.length > 0 && <div className="partner-group-handoffs" aria-label={m.handoff}>{message.files.map(path => <ArtifactDownloadButton key={path} ownerKey={`${view.api.ownerKey}:${message.id}:${path}`} connectionOwner={controller.state.activeProfile} label={path} errorLabel={m.unavailable}
        action={async context => { const blob = await view.api.file(group.id, message.id, path, context.signal); const result = await controller.openArtifactFile(blob.blobId, blob.fileName, Number(blob.byteSize), context);
          if (result.status === "unavailable") return controller.downloadArtifact(blob.blobId, blob.fileName, context); if (result.status !== "opened") throw new Error(m.unavailable); return result; }}><FileText aria-hidden="true" /><span title={path}>{path.split(/[\\/]/u).at(-1)}</span></ArtifactDownloadButton>)}</div>}
    </div>
  </article>;
}
function GroupAttachments({ message, view, controller, m, t }: { message: groupWire.PartnerGroupMessage; view: View; controller: AppController; m: Copy; t: Translator }) {
  const ownerKey = `${view.api.ownerKey}:${message.id}`, load = useTimelineArtifactUrlCache(ownerKey, controller.getArtifactUrl, controller.releaseArtifactUrl);
  const [open, setOpen] = useState<{ id: string; trigger: HTMLElement }>();
  const [textPreview, setTextPreview] = useState<{ artifact: ArtifactView; trigger: HTMLElement }>();
  const actions = { copyFile: controller.copyArtifactFile, openFile: controller.openArtifactFile, openFileWithApplication: controller.openArtifactFileWithApplication };
  const images: TimelineGalleryImage[] = message.attachments.filter(item => item.category === groupWire.PartnerGroupAttachmentCategory.IMAGE && item.blob).map(item => ({
    id: item.id, artifactId: item.id, blobId: item.blob!.blobId, sourceRevealAvailable: false, title: item.name, fileName: item.name, byteSize: Number(item.blob!.byteSize) }));
  return <div className="partner-group-attachments">{message.attachments.map(item => { const artifact: ArtifactView = { id: item.id, blobId: item.blob!.blobId, sourceRevealAvailable: false,
    title: item.name, fileName: item.name, byteSize: Number(item.blob!.byteSize), mediaType: item.blob!.mediaType,
    kind: item.category === groupWire.PartnerGroupAttachmentCategory.IMAGE ? "image" : "file" };
    return <div key={item.id}>
    {images.some(image => image.id === item.id) && <GroupImageThumbnail item={item} load={load} t={t} onOpen={trigger => setOpen({ id: item.id, trigger })} />}
    {timelineArtifactSupportsTextPreview(artifact) && <IconButton label={`${t("workspace.preview")}: ${item.name}`} onClick={event => setTextPreview({ artifact, trigger: event.currentTarget })}><FileText /></IconButton>}
    <ArtifactDownloadButton ownerKey={`${ownerKey}:${item.id}`} connectionOwner={controller.state.activeProfile} label={item.name} errorLabel={m.unavailable}
      action={context => controller.downloadArtifact(item.blob!.blobId, item.name, context)}><Paperclip />{item.name}</ArtifactDownloadButton>
    <NativeArtifactFileActionsMenu actions={actions} artifact={artifact} ownerKey={`${ownerKey}:${item.id}:native-file`} t={t} />
  </div>; })}{open && <TimelineImageLightbox ownerKey={ownerKey} images={images} startImageId={open.id} returnFocus={open.trigger} t={t} loadUrl={load} onDownload={controller.downloadArtifact} onClose={() => setOpen(undefined)} />}
    {textPreview && <TimelineTextAttachmentLightbox ownerKey={`${ownerKey}:${textPreview.artifact.id}`} artifact={textPreview.artifact} returnFocus={textPreview.trigger}
      loadUrl={load} onDownload={controller.downloadArtifact} onClose={() => setTextPreview(undefined)}
      toolbarActions={<NativeArtifactFileActionsMenu actions={actions} artifact={textPreview.artifact} ownerKey={`${ownerKey}:${textPreview.artifact.id}:preview-file`} t={t} />}
      labels={{ preview: t("workspace.preview"), loading: t("workspace.loadingPreview"), unavailable: t("workspace.filePreviewUnavailable"), tooLarge: t("workspace.previewTruncated"),
        copy: t("timeline.copy"), copied: t("timeline.blockCopied"), copyFailed: t("timeline.blockCopyFailed"), download: t("workspace.downloadFile"), close: t("common.close") }} />}
  </div>;
}
function GroupImageThumbnail({ item, load, t, onOpen }: { item: groupWire.PartnerGroupAttachment; load(id: string): Promise<string>; t: Translator; onOpen(trigger: HTMLElement): void }) {
  const [src, setSrc] = useState<string>(), [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; void load(item.blob!.blobId).then(url => { if (active) setSrc(url); }).catch(() => { if (active) setFailed(true); }); return () => { active = false; }; }, [item.blob!.blobId, load]);
  return failed ? <small role="status">{t("timeline.imageUnavailable")}</small> : <button type="button" className="partner-group-image" disabled={!src} aria-label={t("timeline.openImage", { name: item.name })} onClick={event => onOpen(event.currentTarget)}>
    {src ? <img src={src} alt={item.name} loading="lazy" onError={() => setFailed(true)} /> : <Spinner />}</button>;
}
export function GroupPlan({ plan, group, partners = [], view, m }: { plan: groupWire.PartnerGroupPlan; group: groupWire.PartnerGroupSummary; partners?: readonly PartnerProfileView[]; view: View; m: Copy }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), proposed = plan.status === groupWire.PartnerGroupPlanStatus.PROPOSED, waiting = plan.status === groupWire.PartnerGroupPlanStatus.WAITING;
  const [menu, setMenu] = useState<(GroupMenu & { step: groupWire.PartnerGroupPlanStep }) | undefined>();
  useEffect(() => setMenu(undefined), [plan.revision?.value, state.status, group.id]);
  const act = (action: groupWire.PartnerGroupPlanAction) => void view.action(signal => view.api.planAction(group.id, plan, action, signal));
  const edit = (action: groupWire.PartnerGroupPlanEditAction, partnerId?: string) => { if (!menu) return; const step = menu.step; closeMenu(menu, true, () => setMenu(undefined));
    void view.action(signal => view.api.planEdit(group.id, plan, step.position, action, partnerId, signal)); };
  const muted = plan.status === groupWire.PartnerGroupPlanStatus.DISMISSED || plan.status === groupWire.PartnerGroupPlanStatus.SUPERSEDED;
  return <section className={`partner-group-plan${muted ? " is-muted" : ""}`} aria-label={m.plan}>
    <p className="partner-group-plan-intro">{m.planIntro.replace("{count}", String(plan.steps.length))}</p>
    <div className="partner-group-plan-card"><ol>{plan.steps.map(item => {
      const profile = partners.find(partner => partner.id === item.partnerId), editable = proposed || waiting && (item.status === groupWire.PartnerGroupStepStatus.PENDING || item.status === groupWire.PartnerGroupStepStatus.FAILED);
      const content = <><span className="partner-group-step-lead">{proposed || muted ? item.position + 1 : item.status === groupWire.PartnerGroupStepStatus.DONE ? <CircleCheck aria-hidden="true" /> : item.status === groupWire.PartnerGroupStepStatus.RUNNING ? <Sparkles aria-hidden="true" /> : item.status === groupWire.PartnerGroupStepStatus.FAILED ? <CircleAlert aria-hidden="true" /> : <CircleDashed aria-label={m.pending} />}</span>
        <PartnerAvatar preset={profile?.avatar ?? "orbit"} partner={profile} /><span className="partner-group-step-task"><strong>{item.partnerName}</strong>{" "}<span>{item.task}</span></span>
        {!proposed && !muted && item.status !== groupWire.PartnerGroupStepStatus.PENDING && <span className="partner-group-step-status">{["", m.pending, m.running, m.done, m.failed][item.status]}</span>}</>;
      return <li key={item.position} className={item.status === groupWire.PartnerGroupStepStatus.RUNNING ? "is-running" : item.status === groupWire.PartnerGroupStepStatus.FAILED ? "is-failed" : ""}>
        {editable ? <button type="button" className="partner-group-step" aria-label={`${m.reassign} ${item.position + 1}`} aria-haspopup="menu" aria-expanded={menu?.step.position === item.position} disabled={state.busy || state.status !== "ready"} onClick={event => setMenu({ ...menuAt(event.currentTarget), step: item })}>{content}</button> : <div className="partner-group-step">{content}</div>}
      </li>; })}</ol>
      {proposed && <footer><Button tone="primary" disabled={state.busy || state.status !== "ready"} onClick={() => act(groupWire.PartnerGroupPlanAction.START)}>{m.start}</Button><Button tone="ghost" disabled={state.busy || state.status !== "ready"} onClick={() => act(groupWire.PartnerGroupPlanAction.DISMISS)}>{m.dismiss}</Button><span>{m.editHint}</span></footer>}
    </div>
    {proposed ? <p className="partner-group-plan-note">{m.pauseNote}</p> : (muted || plan.status === groupWire.PartnerGroupPlanStatus.STOPPED) && <p className="partner-group-plan-note">{["", m.proposed, m.running, m.waiting, m.done, m.stopped, m.dismissed, m.superseded][plan.status]}</p>}
    {plan.workDir && <p className="partner-group-plan-note" title={plan.workDir}><FolderOpen aria-hidden="true" />{plan.branch ?? plan.workDir.split(/[\\/]/u).at(-1)}</p>}
    {menu && state.status === "ready" && <TimelineLinkMenu trigger={menu.trigger} position={menu.position} label={`${m.reassign} ${menu.step.position + 1}`} onClose={restore => closeMenu(menu, restore, () => setMenu(undefined))}>
      <span className="partner-group-menu-label">{m.reassign}</span>{group.members.filter(member => member.status === groupWire.PartnerGroupMemberStatus.ACTIVE).map(member => { const profile = partners.find(partner => partner.id === member.partnerId); return <button type="button" role="menuitem" key={member.partnerId} disabled={state.busy} onClick={() => { if (member.partnerId === menu.step.partnerId) closeMenu(menu, true, () => setMenu(undefined)); else edit(groupWire.PartnerGroupPlanEditAction.REASSIGN, member.partnerId); }}>
        <span className="partner-group-menu-avatar"><PartnerAvatar preset={profile?.avatar ?? "orbit"} partner={profile} /></span><span className="partner-group-menu-name">{member.name}</span>{member.partnerId === menu.step.partnerId && <Check aria-hidden="true" />}</button>; })}
      {proposed && <><span role="separator" /><button type="button" role="menuitem" disabled={state.busy || plan.steps.length <= 1} onClick={() => edit(groupWire.PartnerGroupPlanEditAction.REMOVE)}>{m.remove}{plan.steps.length <= 1 && <small>{m.keepOneStep}</small>}</button></>}
    </TimelineLinkMenu>}
  </section>;
}
function GroupPlanFollowUp({ plan, group, partners, view, m }: { plan: groupWire.PartnerGroupPlan; group: groupWire.PartnerGroupSummary; partners: readonly PartnerProfileView[]; view: View; m: Copy }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), current = plan.currentStep === undefined ? undefined : plan.steps[plan.currentStep];
  const failed = current?.status === groupWire.PartnerGroupStepStatus.FAILED, next = failed ? current : plan.steps[(plan.currentStep ?? -1) + 1];
  if (!next || !failed && current?.status !== groupWire.PartnerGroupStepStatus.DONE) return null;
  const partner = partners.find(item => item.id === next.partnerId), act = (action: groupWire.PartnerGroupPlanAction) => void view.action(signal => view.api.planAction(group.id, plan, action, signal));
  return <div className="partner-group-divider partner-group-follow-up"><span className="partner-group-follow-up-task">{failed ? <span>{next.partnerName} · {m.failed}</span> : <><span>{m.nextStep}</span><PartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} /><strong>{next.partnerName}</strong><span className="partner-group-follow-up-description">{next.task}</span></>}</span>
    <span className="partner-group-follow-up-actions"><Button disabled={state.busy || state.status !== "ready"} onClick={() => act(failed ? groupWire.PartnerGroupPlanAction.RETRY : groupWire.PartnerGroupPlanAction.CONTINUE)}>{failed ? m.retry : m.next}</Button><Button tone="ghost" disabled={state.busy || state.status !== "ready"} onClick={() => act(groupWire.PartnerGroupPlanAction.DISMISS)}>{m.stop}</Button></span>
  </div>;
}
function GroupComposer({ view, group, partners, controller, m, t, running, dropFiles, onSent }: { view: View; group: groupWire.PartnerGroupSummary; partners: readonly PartnerProfileView[]; controller: AppController; m: Copy; t: Translator; running: boolean; dropFiles: { current: ((files: readonly File[]) => void) | undefined }; onSent(): void }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), [text, setText] = useState(""), [files, setFiles] = useState<Array<{ id: string; file: File; annotated?: boolean }>>([]), [query, setQuery] = useState<{ start: number; query: string; end: number } | null>(null);
  const [division, setDivision] = useState(false), [menu, setMenu] = useState<GroupMenu>(), [highlight, setHighlight] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), pending = useRef<{ id: string; signature: string } | undefined>(undefined);
  const uploads = useRef(new Map<string, groupWire.BlobRef>());
  const tracked = useRef<groupWire.PartnerGroupTrackedMention[]>([]), [fileError, setFileError] = useState<string>();
  const previews = useMemo(() => files.map(item => ({ ...item, kind: item.file.type.startsWith("image/") ? "image" as const : "file" as const, previewUrl: item.file.type.startsWith("image/") ? URL.createObjectURL(item.file) : undefined })), [files]);
  useEffect(() => () => { for (const item of previews) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }, [previews]);
  useLayoutEffect(() => { const element = editor.current; if (element) { element.style.height = "auto"; element.style.height = `${Math.min(240, element.scrollHeight)}px`; } }, [text]);
  const send = () => { void view.action(async signal => {
    const mentions = groupWire.resolvePartnerGroupMentions(text, { members: group.members, allLabels: ["all", "所有人"], tracked: tracked.current });
    const signature = JSON.stringify([text, division, files.map(item => item.id), mentions]);
    if (pending.current?.signature !== signature) pending.current = { id: view.api.newRequestId(), signature };
    const id = pending.current.id, attachments = [];
    for (const item of files) { let blob = uploads.current.get(item.id); if (!blob) { blob = await controller.uploadPartnerGroupFile(item.file, signal); uploads.current.set(item.id, blob); } attachments.push({ id: item.id, name: item.file.name, blob,
      category: blob.mediaType.startsWith("image/") ? groupWire.PartnerGroupAttachmentCategory.IMAGE : blob.mediaType === "application/pdf" ? groupWire.PartnerGroupAttachmentCategory.PDF : blob.mediaType.startsWith("text/") ? groupWire.PartnerGroupAttachmentCategory.TEXT : groupWire.PartnerGroupAttachmentCategory.FILE, annotated: item.annotated ?? false }); }
    const result = await view.api.send(view.group() ?? group, { text, attachments, division, mentions }, id, signal); pending.current = undefined; uploads.current.clear(); tracked.current = []; setText(""); setFiles([]); setDivision(false); setQuery(null); onSent(); return result;
  }); };
  const mention = (name: string, partnerId?: string) => { if (!query) return; const inserted = insertPartnerGroupMention(text, { start: query.start, end: query.end }, name); if (partnerId) tracked.current.push({ partnerId, label: name }); setText(inserted.text); setQuery(null); queueMicrotask(() => { editor.current?.focus(); editor.current?.setSelectionRange(inserted.caret, inserted.caret); }); };
  const disabled = state.busy || state.status !== "ready" || state.detail?.detail?.group?.id !== group.id || group.deleting;
  const divisionBlocked = !!group.openPlan && group.openPlan.status !== groupWire.PartnerGroupPlanStatus.PROPOSED, showStop = running && !text.trim() && !files.length;
  const candidates = query ? [
    ...("all".startsWith(query.query.toLowerCase()) || "所有人".startsWith(query.query) ? [{ name: "all", partnerId: undefined }] : []),
    ...filterPartnerGroupMentionCandidates(query.query, group.members).map(member => ({ name: member.name, partnerId: member.partnerId }))
  ] : [];
  const activeIndex = candidates.length ? highlight % candidates.length : 0, pickerId = `partner-group-mentions-${group.id}`;
  const syncQuery = (value: string, caret: number) => { const found = findPartnerGroupMentionQuery(value, caret); setQuery(found ? { ...found, end: caret } : null); setHighlight(0); };
  const addFiles = (incoming: readonly File[]) => { if (files.length + incoming.length > 20) { setFileError(m.attachmentsLimit); return; } setFileError(undefined); pending.current = undefined; setFiles(current => [...current, ...incoming.map(file => ({ file, id: crypto.randomUUID() }))]); };
  useLayoutEffect(() => { dropFiles.current = disabled ? undefined : addFiles; return () => { dropFiles.current = undefined; }; });
  return <div className="partner-group-composer"><div className="partner-group-composer-frame">
    {division && <span className="partner-group-division-tag"><Users aria-hidden="true" />{m.divisionTag}<IconButton label={m.removeDivision} disabled={disabled} onClick={() => { setDivision(false); pending.current = undefined; editor.current?.focus(); }}><X /></IconButton></span>}
    <ComposerAttachmentTray ownerKey={view.api.ownerKey} attachments={previews} removeDisabled={disabled} t={t} onRemove={item => { pending.current = undefined; uploads.current.delete(item.id); setFiles(current => current.filter(file => file.id !== item.id)); }}
      onReplaceImage={(item, file) => { pending.current = undefined; uploads.current.delete(item.id); setFiles(current => current.map(existing => existing.id === item.id ? { id: crypto.randomUUID(), file, annotated: true } : existing)); }} />
    {query && candidates.length > 0 && <div id={pickerId} className="partner-group-mention-picker" role="listbox">{candidates.map((member, index) => { const partner = partners.find(item => item.id === member.partnerId); return <button type="button" role="option" id={`${pickerId}-${index}`} aria-selected={index === activeIndex} key={member.partnerId ?? "all"} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => mention(member.name, member.partnerId)}>
      {member.partnerId ? <PartnerAvatar preset={partner?.avatar ?? "orbit"} partner={partner} /> : <Users aria-hidden="true" />}<span>{member.partnerId ? member.name : "@all"}</span></button>; })}</div>}
    <textarea ref={editor} value={text} rows={1} maxLength={8000} placeholder={m.placeholder} aria-label={m.placeholder} aria-autocomplete="list" aria-controls={query && candidates.length ? pickerId : undefined} aria-activedescendant={query && candidates.length ? `${pickerId}-${activeIndex}` : undefined} disabled={disabled} onChange={event => { setText(event.target.value); pending.current = undefined; syncQuery(event.target.value, event.target.selectionStart); }}
      onSelect={event => syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
      onPaste={event => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); addFiles(pasted); } }}
      onKeyDown={event => { if (event.nativeEvent.isComposing) return;
        if (query && candidates.length) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlight((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const member = candidates[activeIndex]!; mention(member.name, member.partnerId); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(null); return; } }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!disabled && (text.trim() || files.length)) send(); }
        if (event.key === "Backspace" && division && !text) { event.preventDefault(); setDivision(false); pending.current = undefined; }
      }} />
    {fileError && <p role="alert">{fileError}</p>}
    <footer><input ref={fileInput} type="file" multiple hidden disabled={disabled} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <div className="partner-group-composer-tools"><IconButton label={m.more} aria-haspopup="menu" aria-expanded={!!menu} disabled={disabled} onClick={event => setMenu(menuAt(event.currentTarget, true))}><Plus /></IconButton><span>{group.replyMode === groupWire.PartnerGroupReplyMode.MENTIONED ? m.mentioned : m.all}</span></div>
      <Button tone="primary" className="partner-group-send" aria-label={showStop ? m.stop : m.send} disabled={disabled || !showStop && (!text.trim() && !files.length || division && divisionBlocked)} onClick={() => showStop ? void view.action(signal => view.api.stop(group.id, signal)) : send()}>{showStop ? <Square aria-hidden="true" /> : <Send aria-hidden="true" />}</Button>
    </footer>
    {menu && state.status === "ready" && <TimelineLinkMenu trigger={menu.trigger} position={menu.position} label={m.more} onClose={restore => closeMenu(menu, restore, () => setMenu(undefined))}>
      <button type="button" role="menuitem" disabled={disabled || files.length >= 20} onClick={() => { setMenu(undefined); fileInput.current?.click(); editor.current?.focus(); }}><Paperclip aria-hidden="true" />{m.attach}</button>
      <button type="button" role="menuitem" disabled={disabled || divisionBlocked} onClick={() => { setMenu(undefined); setDivision(true); pending.current = undefined; editor.current?.focus(); }}><Users aria-hidden="true" /><span className="partner-group-composer-menu-label">{m.divide}<small>{divisionBlocked ? m.divisionBusy : m.divisionDescription}</small></span></button>
    </TimelineLinkMenu>}
  </div></div>;
}
function GroupSettings({ group, partners, view, controller, m, onClose, ownerDocument }: { group: groupWire.PartnerGroupSummary; partners: readonly PartnerProfileView[]; view: View; controller: AppController; m: Copy; onClose(): void; ownerDocument?: Document }) {
  const state = useSyncExternalStore(view.subscribe, () => view.state), [name, setName] = useState(group.name), [path, setPath] = useState(group.projectDir ?? ""), [ids, setIds] = useState(group.members.map(member => member.partnerId));
  const [remove, setRemove] = useState(false), current = () => view.group() ?? group;
  const update = (patch: groupWire.PartnerGroupSettingsPatch) => void view.action(signal => view.api.update(current(), patch, signal));
  return <Modal open title={m.settings} onClose={onClose} closeLabel={m.cancel} showClose ownerDocument={ownerDocument}><div className="partner-group-form">
    <label>{m.name}<input value={name} maxLength={40} disabled={state.busy} onChange={event => setName(event.target.value)} onBlur={() => { if (name.trim() && name !== current().name) update({ name }); }} /></label>
    <label>{m.replyMode}<select aria-label={m.replyMode} value={group.replyMode} disabled={state.busy} onChange={event => update({ replyMode: Number(event.target.value) })}><option value={groupWire.PartnerGroupReplyMode.ALL}>{m.all}</option><option value={groupWire.PartnerGroupReplyMode.MENTIONED}>{m.mentioned}</option></select></label>
    <label>{m.speaking}<select aria-label={m.speaking} value={group.speakingMode} disabled={state.busy} onChange={event => update({ speakingMode: Number(event.target.value) })}><option value={groupWire.PartnerGroupSpeakingMode.AUTO}>{m.auto}</option><option value={groupWire.PartnerGroupSpeakingMode.SEQUENTIAL}>{m.sequential}</option></select></label>
    <label>{m.organizer}<select aria-label={m.organizer} value={group.organizerPartnerId ?? ""} disabled={state.busy} onChange={event => update({ organizerSelection: event.target.value ? { case: "organizerPartnerId", value: event.target.value } : { case: "clearOrganizer", value: true } })}><option value="">{m.automatic}</option>{group.members.map(member => <option key={member.partnerId} value={member.partnerId}>{member.name}</option>)}</select></label>
    <fieldset><legend>{m.membersHint}</legend>{partners.filter(partner => partner.lifecycle !== "archived" && partner.lifecycle !== "deleted").map(partner => <label className="partner-group-check" key={partner.id}><input type="checkbox" checked={ids.includes(partner.id)} disabled={state.busy || ids.length >= 6 && !ids.includes(partner.id)} onChange={() => setIds(current => current.includes(partner.id) ? current.filter(id => id !== partner.id) : [...current, partner.id])} />{partner.displayName}</label>)}
      <Button disabled={state.busy || ids.length < 2 || ids.length > 6} onClick={() => void view.action(signal => view.api.members(current(), ids, signal))}>{m.save}</Button></fieldset>
    <label>{m.project}<input value={path} disabled={state.busy} onChange={event => setPath(event.target.value)} /></label><small>{m.folderHint}</small>
    {localProjectPickerOwner(controller) && <Button disabled={state.busy} onClick={() => void view.action(async signal => { const owner = localProjectPickerOwner(controller), picker = ownerDocument?.defaultView?.jokoDesktop?.projects?.pickDirectory ?? window.jokoDesktop?.projects?.pickDirectory; if (!owner || !picker) return;
      const result = await picker(owner); signal.throwIfAborted(); if (!result.cancelled && sameProjectPickerOwner(localProjectPickerOwner(controller), owner)) setPath(result.path); }, false)}><FolderOpen />{m.project}</Button>}
    <Button disabled={state.busy} onClick={() => update({ projectSelection: path.trim() ? { case: "projectDir", value: path.trim() } : { case: "clearProjectDir", value: true } })}>{m.save}</Button>
    <Button disabled={state.busy} onClick={() => { setPath(""); update({ projectSelection: { case: "clearProjectDir", value: true } }); }}>{m.clearProject}</Button>
    {state.error && <p role="alert">{state.error}</p>}
    <div className="partner-group-delete"><p>{m.deleteHint}</p>{remove ? <><p>{m.confirmDelete}</p><Button disabled={state.busy} onClick={() => void view.action(async signal => { await view.api.remove(current(), signal); onClose(); controller.navigate({ kind: "partners" }); })}>{m.delete}</Button><Button onClick={() => setRemove(false)}>{m.cancel}</Button></> : <Button onClick={() => setRemove(true)}>{m.delete}</Button>}</div>
  </div></Modal>;
}
function GroupDecision({ interaction, view, groupId, controller, t }: { interaction: groupWire.Interaction; view: View; groupId: string; controller: AppController; t: Translator }) {
  return <InteractionDialog controller={controller} interaction={mapInteraction(interaction)} remaining={0} inline t={t}
    runAction={(_key, action) => { void action().catch(() => undefined); }}
    onResolve={async draft => { await view.action(async signal => {
      const decision = await interactionDecision(interaction, draft); await view.api.respond(groupId, interaction, decision, signal);
    }, true, true); }}
    onDismiss={async () => { await view.action(signal => view.api.respond(groupId, interaction, { case: "dismissal", value: { reason: "" } }, signal), true, true); }} />;
}
