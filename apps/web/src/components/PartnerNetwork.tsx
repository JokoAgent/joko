import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { Plus, Users, Settings, Send, Square, ArrowLeft } from "lucide-react";
import type { AppController } from "../controller.js";
import type { PartnerNetworkApi } from "../partner-network-api.js";
import { PartnerNetworkEntryJournal } from "../partner-network-entry-journal.js";
import type { PartnerProfileView, TimelineItemView, AttachmentDraft } from "../model.js";
import type { Translator } from "./types.js";
import { StreamingMarkdown } from "./Timeline.js";
import { Button, IconButton, Modal, Spinner } from "./ui.js";
import { ShareSelectionBar } from "./ShareSelectionBar.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { NetworkPlanCard, NetworkPlanFollowUp, NetworkProjectSetting } from "./PartnerNetworkPlan.js";
import { NetworkOwnerControls } from "./PartnerNetworkOwnerControls.js";
import { readNetworkDraft, writeNetworkDraft, type NetworkComposerDraft } from "../partner-network-drafts.js";
import { usePartnerNetworkFailures } from "../use-partner-network-failures.js";
import "./partner-network.css";
import "./partner-groups.css";

type Copy = ReturnType<typeof wire.partnerNetworkMessages>;
export function partnerNetworkRoute(room: wire.PartnerNetworkRoom): string { return `network:${room.joinId || "host"}:${room.id}`; }
function routeKey(value: string): { roomId: string; joinId: string } {
  const parsed = /^network:(host|[A-Za-z0-9-]+):([A-Za-z0-9-]+)$/u.exec(value);
  if (!parsed) throw new Error("The conversation route is invalid."); return { roomId: parsed[2]!, joinId: parsed[1] === "host" ? "" : parsed[1]! };
}
function errorText(error: unknown, m: Copy): string {
  return error instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(error.code) ? m.denied : m.unavailable;
}
function useDirectory(api: PartnerNetworkApi | undefined) {
  const [rooms, setRooms] = useState<wire.PartnerNetworkRoom[]>(), [error, setError] = useState<unknown>(), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!api) return; const lifetime = new AbortController(); let reading = false;
    const read = async () => { if (reading || lifetime.signal.aborted || document.visibilityState === "hidden") return; reading = true;
      try { const result = await api.listPartnerNetwork({}, { signal: lifetime.signal }); if (!lifetime.signal.aborted) { setRooms(result.rooms); setError(undefined); } }
      catch (reason) { if (!lifetime.signal.aborted) setError(reason); } finally { reading = false; } };
    void read(); const timer = setInterval(() => { void read(); }, 5_000); document.addEventListener("visibilitychange", read);
    return () => { lifetime.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, [api, refresh]);
  return { rooms, error, refresh: () => setRefresh(value => value + 1) };
}
export function PartnerNetworkNavigation({ controller, onClose }: { controller: AppController; onClose(): void }): JSX.Element | null {
  const api = controller.partnerNetwork, { rooms } = useDirectory(api), m = wire.partnerNetworkMessages(controller.state.effectiveLocale);
  if (!api || !rooms?.some(room => !room.removedFromList && room.state === "active")) return null;
  return <section className="partner-groups-navigation" aria-label={m.title}>{rooms.filter(room => !room.removedFromList && room.state === "active").map(room =>
    <button type="button" className="partner-group-directory-row" key={`${room.hostServerId}:${room.id}`} onClick={() => { controller.navigate({ kind: "partners", groupId: partnerNetworkRoute(room) }); onClose(); }}>
      <Users aria-hidden="true" /><span><strong>{room.name}</strong><small>{room.members.filter(member => member.state === "joined").map(member => wire.partnerNetworkActorName(member, room)).join(" · ")}</small></span>
      {room.unread && <span className="partner-group-unread" aria-label={m.unread} />}</button>)}</section>;
}
export function PartnerNetworkSection({ controller, partners }: { controller: AppController; partners: readonly PartnerProfileView[] }): JSX.Element | null {
  const api = controller.partnerNetwork, m = wire.partnerNetworkMessages(controller.state.effectiveLocale), directory = useDirectory(api);
  const [dialog, setDialog] = useState<"create" | "join">(), [search, setSearch] = useState(""), [history, setHistory] = useState(false);
  if (!api) return null;
  const rooms = directory.rooms?.filter(room => !room.removedFromList && (history || room.state === "active") && [room.name, ...room.members.map(member => wire.partnerNetworkActorName(member, room))].some(value => value.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  return <section className="partner-groups-section partner-network-section" aria-label={m.title}>
    <header><h2><Users aria-hidden="true" />{m.title}</h2><div><Button onClick={() => setDialog("create")}><Plus aria-hidden="true" />{m.create}</Button><Button onClick={() => setDialog("join")}>{m.join}</Button></div></header>
    <input aria-label={m.search} placeholder={m.search} value={search} onChange={event => setSearch(event.target.value)} />
    <label className="partner-group-check"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />{m.showArchived}</label>
    {directory.error !== undefined && <p role="alert">{errorText(directory.error, m)} <Button onClick={directory.refresh}>{m.refresh}</Button></p>}
    {!directory.rooms && !directory.error && <Spinner />}
    {rooms?.length === 0 && <p>{m.empty}</p>}
    <div className="partner-group-directory">{rooms?.map(room => <button type="button" key={`${room.hostServerId}:${room.id}`} className="partner-group-directory-row" onClick={() => controller.navigate({ kind: "partners", groupId: partnerNetworkRoute(room) })}>
      <Users aria-hidden="true" /><span><strong>{room.name}</strong><small>{room.state === "archived" ? m.archived : room.state === "dissolved" ? m.dissolved : room.members.filter(member => member.state === "joined").map(member => wire.partnerNetworkActorName(member, room)).join(" · ")}</small></span>{room.unread && <span className="partner-group-unread" aria-label={m.unread} />}</button>)}</div>
    {dialog && <NetworkEntry api={api} m={m} kind={dialog} partners={partners} owner={JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id, controller.state.activeProfile?.deviceId])} onClose={() => setDialog(undefined)} onJoined={room => { setDialog(undefined); directory.refresh(); controller.navigate({ kind: "partners", groupId: partnerNetworkRoute(room) }); }} />}
  </section>;
}
function NetworkEntry({ api, m, kind, partners, owner, onClose, onJoined }: { api: PartnerNetworkApi; m: Copy; kind: "create" | "join"; partners: readonly PartnerProfileView[]; owner: string; onClose(): void; onJoined(room: wire.PartnerNetworkRoom): void }) {
  const [name, setName] = useState(""), [displayName, setDisplayName] = useState(""), [selected, setSelected] = useState<string[]>([]), [invitation, setInvitation] = useState(""), [preview, setPreview] = useState<wire.PreviewPartnerNetworkResponse>(), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  const journal = useMemo(() => new PartnerNetworkEntryJournal(window.localStorage, owner), [owner]);
  useEffect(() => () => lifetime.current.abort(), []);
  const act = async () => {
    if (busy) return; setBusy(true); setError(undefined);
    try {
      const body = JSON.stringify([kind, name, displayName, selected, invitation]), retained = await journal.read(body);
      if (kind === "join" && !preview && !retained) { const result = await api.previewPartnerNetwork({ invitation }, { signal: lifetime.current.signal }); if (!lifetime.current.signal.aborted) setPreview(result); return; }
      const operationId = retained ?? await journal.prepare(body); lifetime.current.signal.throwIfAborted();
      const result = kind === "create" ? await api.createPartnerNetwork({ operationId, name, displayName, partnerIds: selected }, { signal: lifetime.current.signal })
        : await api.joinPartnerNetwork({ operationId, invitation, displayName }, { signal: lifetime.current.signal });
      await journal.confirm(body, operationId);
      if (!lifetime.current.signal.aborted && result.room) onJoined(result.room);
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  return <Modal open showClose closeLabel={m.close} title={kind === "create" ? m.create : m.join} onClose={() => { if (!busy) onClose(); }}><form className="partner-group-form" onSubmit={event => { event.preventDefault(); void act(); }}>
    {kind === "create" ? <><label>{m.name}<input autoFocus value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label><fieldset><legend>{m.addPartner}</legend>{partners.filter(partner => partner.lifecycle === "active" && partner.initializationState === "ready").map(partner =>
      <label className="partner-group-check" key={partner.id}><input type="checkbox" checked={selected.includes(partner.id)} disabled={selected.length >= 6 && !selected.includes(partner.id)} onChange={event => setSelected(value => event.target.checked ? [...value, partner.id] : value.filter(id => id !== partner.id))} />{partner.displayName}</label>)}</fieldset></>
      : <label>{m.invitation}<input autoFocus value={invitation} onChange={event => { setInvitation(event.target.value); setPreview(undefined); }} /></label>}
    <label>{m.yourName}<input value={displayName} maxLength={128} onChange={event => setDisplayName(event.target.value)} /></label>
    {preview?.room && <p>{preview.room.name} · {preview.room.members.map(member => member.name).join(" · ")}</p>}
    {error && <p role="alert">{error}</p>}<Button type="submit" tone="primary" disabled={busy || kind === "create" && (!name.trim() || !displayName.trim()) || kind === "join" && (!invitation.trim() || !!preview && !displayName.trim())}>{busy ? <Spinner /> : kind === "create" ? m.create : preview ? m.accept : m.preview}</Button>
  </form></Modal>;
}
export function PartnerNetworkPage({ controller, route, t, onOpenNavigation }: { controller: AppController; route: string; t: Translator; onOpenNavigation(): void }): JSX.Element {
  const api = controller.partnerNetwork, m = wire.partnerNetworkMessages(controller.state.effectiveLocale), target = routeKey(route);
  if (!api) return <div className="partner-group-empty">{m.unavailable}</div>;
  return <NetworkConversation key={`${route}:${controller.state.activeProfile?.id}:${controller.state.connectionGeneration}`} api={api} target={target} controller={controller} m={m} t={t} onOpenNavigation={onOpenNavigation} />;
}
interface Pending { readonly request: wire.SendPartnerNetworkRequest; readonly createdAt: number; status: "queued" | "sending" | "failed"; messageId?: string; }
function NetworkConversation({ api, target, controller, m, t, onOpenNavigation }: { api: PartnerNetworkApi; target: { roomId: string; joinId: string }; controller: AppController; m: Copy; t: Translator; onOpenNavigation(): void }) {
  const draftScope = JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id, controller.state.activeProfile?.deviceId, target.roomId, target.joinId]), initialDraft = useMemo(() => readNetworkDraft(draftScope, ""), []);
  const [snapshot, setSnapshot] = useState<wire.PartnerNetworkSnapshot>(), [messages, setMessages] = useState<wire.PartnerNetworkMessage[]>([]), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [settings, setSettings] = useState(false), [thread, setThread] = useState("");
  const [draft, setDraft] = useState(initialDraft.text), [mentions, setMentions] = useState<string[]>([...initialDraft.mentions]), [quote, setQuote] = useState(initialDraft.quoteId), [attachments, setAttachments] = useState<wire.PartnerNetworkAttachment[]>([...initialDraft.attachments]), [pending, setPending] = useState<Pending[]>([]), [partners, setPartners] = useState<PartnerProfileView[]>([]);
  const [journalReady, setJournalReady] = useState(false);
  const [division, setDivision] = useState(initialDraft.forcePlan), [mentionAll, setMentionAll] = useState(initialDraft.mentionAll);
  const tracked = useRef<wire.NetworkTrackedMention[]>([...initialDraft.tracked]), activeThread = useRef(""), currentDraft = useRef<NetworkComposerDraft>(initialDraft), selection = useRef({ start: 0, end: 0 });
  currentDraft.current = { text: draft, mentions, mentionAll, forcePlan: division, quoteId: quote, attachments, tracked: tracked.current };
  useEffect(() => { if (activeThread.current === thread) return; writeNetworkDraft(draftScope, activeThread.current, currentDraft.current); const restored = readNetworkDraft(draftScope, thread); activeThread.current = thread;
    setDraft(restored.text); setMentions([...restored.mentions]); setMentionAll(restored.mentionAll); setDivision(restored.forcePlan); setQuote(restored.quoteId); setAttachments([...restored.attachments]); tracked.current = [...restored.tracked]; setPicked([]); attempt.current = undefined; }, [thread]);
  useEffect(() => () => writeNetworkDraft(draftScope, activeThread.current, currentDraft.current), []);
  const [sharing, setSharing] = useState<Record<string, readonly string[]>>({}), [picked, setPicked] = useState<readonly { id: string; file: File }[]>([]);
  const previews = useMemo<readonly AttachmentDraft[]>(() => picked.map(item => ({ ...item, kind: item.file.type.startsWith("image/") ? "image" : "file", ...(item.file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(item.file) } : {}) })), [picked]);
  useEffect(() => () => { for (const item of previews) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }, [previews]);
  const profile = controller.state.activeProfile;
  const journal = useMemo(() => new wire.PartnerNetworkSendJournal({ getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    JSON.stringify([profile?.serverId, profile?.id, profile?.deviceId, target.roomId, target.joinId])), []);
  const lifetime = useRef(new AbortController()), list = useRef<HTMLDivElement>(null), requestTail = useRef(Promise.resolve()), draftRef = useRef(draft), attempt = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  draftRef.current = draft;
  const room = snapshot?.room, self = room?.members.find(member => member.id === room.selfId), allowed = room?.state === "active" && self?.state === "joined";
  const failures = usePartnerNetworkFailures(api, target, messages, () => { setMessages([]); setSnapshot(undefined); setError(m.denied); });
  const mentionMembers = room?.members.filter(actor => actor.id !== room.selfId).map(actor => ({ actorId: actor.id, name: wire.partnerNetworkActorName(actor, room), displayName: actor.name, nickname: actor.nickname })) ?? [];
  const mentionInput = { members: mentionMembers, allLabels: [m.everyone, "all", "everyone", "所有人"], tracked: tracked.current };
  const editDraft = (value: string) => { tracked.current = wire.retainNetworkTrackedMentions(draft, value, { ...mentionInput, editStart: selection.current.start, editEnd: selection.current.end }); const resolved = wire.resolveNetworkMentions(value, { ...mentionInput, tracked: tracked.current }); setDraft(value); setMentions(resolved.actorIds); setMentionAll(resolved.all); };
  const pickMention = (actorId?: string) => { const label = actorId ? mentionMembers.find(member => member.actorId === actorId)?.name : m.everyone; if (!label) return;
    const prefix = draft && !/\s$/u.test(draft) ? `${draft} ` : draft, value = `${prefix}@${label} `;
    if (actorId) tracked.current.push({ actorId, label, start: prefix.length }); const resolved = wire.resolveNetworkMentions(value, { ...mentionInput, tracked: tracked.current }); setDraft(value); setMentions(resolved.actorIds); setMentionAll(resolved.all); };
  const planCopy = wire.partnerGroupMessages(controller.state.effectiveLocale), planAttempt = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const actPlan = async (action: string, plan: wire.PartnerNetworkPlan, position = 0, actorId = "") => {
    if (busy || !allowed) return; const fingerprint = JSON.stringify([action, plan.id, plan.revision.toString(), position, actorId]);
    if (planAttempt.current?.fingerprint !== fingerprint) planAttempt.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true); setError(undefined); try {
      await api.planPartnerNetwork({ ...target, operationId: planAttempt.current.id, action, planId: plan.id, expectedRevision: plan.revision, position, actorId }, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted) { planAttempt.current = undefined; await read(); }
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const readVersion = useRef(0), lastRead = useRef(0n);
  const loadedBefore = useRef<bigint[]>([]);
  const read = async (older = false, signal = lifetime.current.signal) => {
    const requestVersion = ++readVersion.current;
    try {
      const beforeSequence = older ? messages[0]?.sequence : undefined;
      const result = await api.getPartnerNetwork({ ...target, threadRootId: thread, ...(beforeSequence ? { beforeSequence } : {}) }, { signal });
      if (signal.aborted || requestVersion !== readVersion.current || !result.snapshot?.room) return;
      if (beforeSequence && !loadedBefore.current.includes(beforeSequence)) loadedBefore.current.push(beforeSequence);
      const pages = older ? [] : await Promise.all(loadedBefore.current.map(before => api.getPartnerNetwork({ ...target, threadRootId: thread, beforeSequence: before }, { signal })));
      if (signal.aborted || requestVersion !== readVersion.current) return;
      const readMessages = [...result.snapshot.messages, ...pages.flatMap(page => page.snapshot?.messages ?? [])];
      const hasMore = pages.at(-1)?.snapshot?.hasMore ?? result.snapshot.hasMore;
      const plans = [...new Map([...older ? snapshot?.plans ?? [] : [], ...result.snapshot.plans, ...pages.flatMap(page => page.snapshot?.plans ?? [])].map(plan => [plan.id, plan])).values()];
      setSnapshot(create(wire.PartnerNetworkSnapshotSchema, { ...result.snapshot, hasMore, plans }));
      setMessages(previous => [...new Map([...older ? previous : [], ...readMessages].map(message => [message.id, message])).values()].sort((a, b) => a.sequence < b.sequence ? -1 : 1)); setError(undefined);
      const ids = new Set(readMessages.map(message => message.id)); await journal.displayed(ids); if (signal.aborted) return;
      setPending(previous => previous.filter(item => !item.messageId || !ids.has(item.messageId)));
    } catch (reason) { if (!signal.aborted && requestVersion === readVersion.current) { setError(errorText(reason, m)); if (reason instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(reason.code)) { setMessages([]); setSnapshot(undefined); } } }
  };
  useEffect(() => { const signal = lifetime.current.signal; void controller.listPartners(undefined, signal).then(result => { if (!signal.aborted) setPartners([...result.partners]); }).catch(() => {});
    void journal.initialize().then(entries => { if (!signal.aborted) { setPending(entries.map(entry => ({ ...entry, status: "failed" }))); setJournalReady(true); } }).catch(() => { if (!signal.aborted) setError(m.unavailable); });
    return () => lifetime.current.abort(); }, []);
  useEffect(() => { loadedBefore.current = []; setMessages([]); setSnapshot(undefined); const scope = new AbortController(); const update = () => { if (document.visibilityState !== "hidden") void read(false, scope.signal); }; update(); const timer = setInterval(update, 2_000); document.addEventListener("visibilitychange", update);
    return () => { scope.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", update); }; }, [thread]);
  const markVisible = () => {
    const element = list.current, through = messages.at(-1)?.sequence;
    if (!element || document.visibilityState === "hidden" || !document.hasFocus() || element.scrollHeight - element.scrollTop - element.clientHeight > 48 || !through || through <= lastRead.current || !room) return;
    lastRead.current = through; void api.managePartnerNetwork({ ...target, operationId: crypto.randomUUID(), action: "mark-read", throughSequence: through }, { signal: lifetime.current.signal }).catch(() => { lastRead.current = 0n; });
  };
  useEffect(() => { markVisible(); }, [messages]);
  const manage = async (action: string, actorId = "", value = "") => {
    if (!room || busy) return; setBusy(true); setError(undefined);
    try { const result = await api.managePartnerNetwork({ ...target, operationId: crypto.randomUUID(), expectedRevision: room.revision, action, actorId, value }, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted && result.room) { setSnapshot(previous => create(wire.PartnerNetworkSnapshotSchema, { ...(previous ?? create(wire.PartnerNetworkSnapshotSchema)), room: result.room })); if (action === "leave" || action === "remove-list") controller.navigate({ kind: "partners" }); else await read(); } }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const submit = (item: Pending) => {
    const send = async () => {
      if (lifetime.current.signal.aborted) return; setPending(previous => previous.map(old => old.request.operationId === item.request.operationId ? { ...old, status: "sending" } : old));
      try { await journal.prepare(item.request, item.createdAt); lifetime.current.signal.throwIfAborted();
        const result = await api.sendPartnerNetwork(item.request, { signal: lifetime.current.signal }); if (lifetime.current.signal.aborted) return;
        if (!result.message) throw new Error(); await journal.acknowledge(item.request.operationId, result.message.id); lifetime.current.signal.throwIfAborted();
        setPending(previous => previous.map(old => old.request.operationId === item.request.operationId ? { ...old, messageId: result.message?.id } : old)); await read(); }
      catch (reason) { if (!lifetime.current.signal.aborted) { setPending(previous => previous.map(old => old.request.operationId === item.request.operationId ? { ...old, status: "failed" } : old)); setError(errorText(reason, m)); } }
    };
    requestTail.current = requestTail.current.then(send, send);
  };
  const send = async () => {
    if (!allowed || !journalReady || !draft.trim() && !attachments.length) return;
    const resolved = wire.resolveNetworkMentions(draft, mentionInput), targetIds = [...new Set([...mentions, ...resolved.actorIds])], all = mentionAll || resolved.all;
    const fingerprint = JSON.stringify([draft, targetIds, quote, thread, attachments.map(attachment => [attachment.id, attachment.sizeBytes.toString()]), division, all]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    const item: Pending = { request: create(wire.SendPartnerNetworkRequestSchema, { ...target, operationId: attempt.current.id, text: draft, mentions: targetIds, mentionAll: all, forcePlan: division, quoteId: quote, threadRootId: thread, attachments }), createdAt: Date.now(), status: "queued" };
    try { await journal.prepare(item.request, item.createdAt); lifetime.current.signal.throwIfAborted(); } catch { if (!lifetime.current.signal.aborted) setError(m.unavailable); return; }
    setPending(previous => [...previous.filter(old => old.request.operationId !== item.request.operationId), item]); setDraft(""); setMentions([]); setMentionAll(false); setDivision(false); setQuote(""); setAttachments([]); setPicked([]); tracked.current = []; attempt.current = undefined; submit(item);
  };
  const upload = async (files: readonly File[], replacing?: string) => {
    if (!files.length || !allowed || busy || files.length + attachments.length - (replacing ? 1 : 0) > 20) return; setBusy(true);
    try { const added: wire.PartnerNetworkAttachment[] = [], local: { id: string; file: File }[] = [];
      for (const file of files) {
        if (file.size < 1 || file.size > 100 * 1024 * 1024) throw new Error();
        const bytes = new Uint8Array(await file.arrayBuffer()); lifetime.current.signal.throwIfAborted();
        const begun = await api.mediaPartnerNetwork({ ...target, action: "begin", operationId: crypto.randomUUID(), name: file.name, mediaType: file.type || "application/octet-stream", sizeBytes: BigInt(bytes.length) }, { signal: lifetime.current.signal }); if (!begun.attachment) throw new Error();
        for (let offset = Number(begun.offset); offset < bytes.length;) { const response = await api.mediaPartnerNetwork({ ...target, action: "write", mediaId: begun.attachment.id, offset: BigInt(offset), data: bytes.slice(offset, offset + 256 * 1024) }, { signal: lifetime.current.signal });
          if (response.offset !== BigInt(Math.min(offset + 256 * 1024, bytes.length))) throw new Error(); offset = Number(response.offset); } added.push(begun.attachment); local.push({ id: begun.attachment.id, file });
      }
      if (!lifetime.current.signal.aborted) { setAttachments(previous => [...previous.filter(item => item.id !== replacing), ...added]); setPicked(previous => [...previous.filter(item => item.id !== replacing), ...local]); }
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); } finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const shareMode = Object.hasOwn(sharing, thread), shareIds = new Set(sharing[thread] ?? []), timelineId = `${target.roomId}:${thread}`;
  const shareable: TimelineItemView[] = messages.filter(message => !message.deleted && message.kind !== "member-joined").map(message => ({ id: message.id, sequence: message.sequence,
    createdAt: Number(message.createdAtMs), kind: message.authorId === room?.selfId ? "user" : "assistant", text: message.kind === "thread-share" ? message.sharedReply?.text ?? m.sourceUnavailable : message.text || message.task?.title || "" }));
  const toggleShare = (id: string) => setSharing(previous => ({ ...previous, [thread]: (previous[thread] ?? []).includes(id) ? previous[thread]!.filter(value => value !== id) : [...previous[thread] ?? [], id] }));
  const download = async (attachment: wire.PartnerNetworkAttachment) => {
    try { let offset = 0n; const chunks: Uint8Array<ArrayBuffer>[] = [];
      while (offset < attachment.sizeBytes) { const response = await api.mediaPartnerNetwork({ ...target, action: "read", mediaId: attachment.id, offset }, { signal: lifetime.current.signal }); if (response.offset !== offset + BigInt(response.data.byteLength) || !response.data.length) throw new Error(); chunks.push(Uint8Array.from(response.data)); offset = response.offset; }
      const url = URL.createObjectURL(new Blob(chunks, { type: attachment.mediaType })), link = document.createElement("a"); link.href = url; link.download = attachment.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); }
  };
  return <section className="partner-group-page partner-network-page"><header className="partner-group-header"><IconButton label={m.back} onClick={() => thread ? setThread("") : onOpenNavigation()}><ArrowLeft /></IconButton><div><h1>{room?.name || m.title}</h1><small>{thread ? m.replies : room?.members.filter(member => member.state === "joined").length} {m.members}</small></div><IconButton label={m.settings} onClick={() => setSettings(true)} disabled={!room}><Settings /></IconButton></header>
    {error && <p className="partner-group-error" role="alert">{error}<Button onClick={() => { void read(); }}>{m.refresh}</Button></p>}
    {failures.error && !error && <p role="status">{m.unavailable}</p>}
    {room?.state !== "active" && room && <p className="partner-group-error">{room.state === "archived" ? m.archived : m.dissolved}</p>}
    {!snapshot && !error && <Spinner />}
    <div className={`partner-group-timeline${shareMode ? " is-share-selecting" : ""}`} ref={list} data-timeline-session-id={timelineId} onScroll={markVisible}><div className="partner-group-timeline-content">
      {snapshot?.hasMore && <Button onClick={() => { void read(true); }}>{m.older}</Button>}
      {messages.map(message => message.kind === "member-joined" ? <div key={message.id}><p className="partner-group-divider">{message.authorName} {m.joinedEvent}</p><NetworkFailureNotice jobs={failures.bySource.get(message.id)} room={room} locale={controller.state.effectiveLocale} /></div> : <article data-rendered-share-message-id={message.id} className={`partner-group-message${message.authorId === room?.selfId ? " is-user" : ""}`} key={message.id}><div className="partner-group-message-body"><header><strong>{message.authorName}</strong><time dateTime={new Date(Number(message.createdAtMs)).toISOString()}>{new Date(Number(message.createdAtMs)).toLocaleTimeString(controller.state.effectiveLocale, { hour: "2-digit", minute: "2-digit" })}</time></header>
        {shareMode && <label data-rendered-share-exclude=""><input type="checkbox" aria-label={m.selectMessage} checked={shareIds.has(message.id)} onChange={() => toggleShare(message.id)} />{m.selectMessage}</label>}
        {message.quoteId && <blockquote>{messages.find(original => original.id === message.quoteId)?.text.slice(0, 240) || m.quote}</blockquote>}
        {message.kind === "plan" && room && snapshot?.plans.find(plan => plan.id === message.planId) ? <NetworkPlanCard plan={snapshot.plans.find(plan => plan.id === message.planId)!} room={room} locale={controller.state.effectiveLocale} busy={busy || !allowed} action={(...args) => { void actPlan(...args); }} /> : message.kind === "thread-share" ? <blockquote><strong>{message.sharedReply?.authorName ?? m.sourceUnavailable}</strong>{message.sharedReply ? <><StreamingMarkdown text={message.sharedReply.text} streaming={false} t={t} /><Button data-rendered-share-exclude="" onClick={() => setThread(message.sharedReply!.threadRootId)}>{m.replies}</Button></> : null}</blockquote> : <StreamingMarkdown text={wire.partnerNetworkMessageBody(message, controller.state.effectiveLocale)} streaming={false} t={t} />}
        {message.task && <section className="partner-network-task"><strong>{message.task.title}</strong><span>{wire.partnerNetworkTaskStatus(message.task.status, controller.state.effectiveLocale)}</span>{message.task.question && <p>{message.task.question}</p>}{message.task.ownerId === room?.selfId && message.task.homeServerId === profile?.serverId && message.task.sessionId && <Button data-rendered-share-exclude="" onClick={() => controller.navigate({ kind: "session", sessionId: message.task!.sessionId })}>{m.openTask}</Button>}</section>}
        {message.attachments.map(attachment => <NetworkMedia key={attachment.id} api={api} target={target} attachment={attachment} m={m} t={t} owner={journal.scope} download={() => { void download(attachment); }} />)}
        <NetworkFailureNotice jobs={failures.bySource.get(message.id)} room={room} locale={controller.state.effectiveLocale} />
        {message.threadPreview && !thread && <Button data-rendered-share-exclude="" tone="ghost" onClick={() => setThread(message.id)}>{message.threadPreview.replyCount.toString()} {m.replies} · {message.threadPreview.authorName}: {message.threadPreview.text}</Button>}
        <div className="partner-network-message-actions message-actions" data-rendered-share-exclude=""><Button tone="ghost" onClick={() => { void navigator.clipboard.writeText(message.kind === "thread-share" ? message.sharedReply?.text ?? m.sourceUnavailable : message.text); }}>{m.copy}</Button><Button tone="ghost" onClick={() => setSharing(previous => ({ ...previous, [thread]: [message.id] }))}>{m.share}</Button>{!thread && <Button tone="ghost" disabled={!allowed} onClick={() => setQuote(message.id)}>{m.quote}</Button>}<Button tone="ghost" onClick={() => setThread(message.threadRootId || message.id)}>{m.thread}</Button>
          {!!thread && message.threadRootId && <Button tone="ghost" disabled={!allowed} onClick={() => { void manage("share-thread", "", message.id); }}>{m.shareToMain}</Button>}
          <details><summary>{m.reaction}</summary>{["👍", "❤️", "😂", "🎉", "🤔", "🙏"].map(emoji => <Button key={emoji} tone="ghost" disabled={!allowed} onClick={() => { void api.reactPartnerNetwork({ ...target, operationId: crypto.randomUUID(), messageId: message.id, emoji, add: !message.reactions.some(reaction => reaction.emoji === emoji && reaction.actorIds.includes(room!.selfId)) }, { signal: lifetime.current.signal }).then(() => read()).catch(reason => setError(errorText(reason, m))); }}>{emoji}</Button>)}</details>
          {message.reactions.map(reaction => <span className="partner-network-reaction" key={reaction.emoji} aria-label={`${reaction.emoji} ${reaction.actorIds.length <= 3 ? reaction.actorIds.map(id => room?.members.find(member => member.id === id)?.name || "?").join(", ") : reaction.actorIds.length}`}>{reaction.emoji} {reaction.actorIds.length <= 3 ? reaction.actorIds.map(id => <span className="partner-network-initial" key={id} aria-hidden="true">{(room?.members.find(member => member.id === id)?.name || "?").slice(0, 1)}</span>) : reaction.actorIds.length}</span>)}</div>
      </div></article>)}
      {pending.filter(item => item.request.threadRootId === thread && (!item.messageId || !messages.some(message => message.id === item.messageId))).map(item => <article className="partner-group-message is-user" key={item.request.operationId}><div className="partner-group-message-body"><p>{item.request.text}</p><small>{item.status === "failed" ? m.failed : m.sending}</small>{item.status === "failed" && <div><Button onClick={() => submit(item)}>{m.retry}</Button><Button disabled={!!draft || !!attachments.length} onClick={() => { setDraft(item.request.text); setMentions(item.request.mentions); setMentionAll(item.request.mentionAll); setDivision(item.request.forcePlan); setQuote(item.request.quoteId); setAttachments(item.request.attachments); tracked.current = []; attempt.current = { fingerprint: JSON.stringify([item.request.text, item.request.mentions, item.request.quoteId, thread, item.request.attachments.map(attachment => [attachment.id, attachment.sizeBytes.toString()]), item.request.forcePlan, item.request.mentionAll]), id: item.request.operationId }; setPending(previous => previous.filter(old => old !== item)); }}>{m.edit}</Button></div>}</div></article>)}
      {snapshot?.executions.filter(job => ["queued", "running"].includes(job.status)).map(job => <p role="status" key={job.id}>{room?.members.find(actor => actor.id === job.actorId)?.name} · {job.status === "queued" ? m.waiting : m.replying}</p>)}
      {room && snapshot?.plans.filter(plan => plan.status === "waiting").map(plan => <NetworkPlanFollowUp key={plan.id} plan={plan} room={room} locale={controller.state.effectiveLocale} busy={busy || !allowed} action={(...args) => { void actPlan(...args); }} />)}
      {[...failures.bySource.values()].flat().filter(job => job.kind === "plan-decision").map(job => <Button key={job.id} disabled={!allowed || busy} onClick={() => {
        setBusy(true); void api.planPartnerNetwork({ ...target, operationId: `plan-retry:${job.id}`, action: "retry-decision", sourceMessageId: job.sourceMessageId }, { signal: lifetime.current.signal })
          .then(() => read()).catch(reason => { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); }).finally(() => { if (!lifetime.current.signal.aborted) setBusy(false); });
      }}>{planCopy.planFailed} · {m.retry}</Button>)}
      {allowed && <NetworkOwnerControls api={api} target={target} controller={controller} t={t} />}
    </div></div>
    {shareMode && <ShareSelectionBar ownerKey={`${journal.scope}:${thread}`} sessionId={timelineId} sessionName={room?.name ?? m.title} messages={shareable} selectedIds={shareIds} locale={controller.state.effectiveLocale} t={t} getTimelineRoot={() => list.current} onToggleAll={() => setSharing(previous => ({ ...previous, [thread]: shareIds.size === shareable.length ? [] : shareable.map(message => message.id) }))} onCancel={() => setSharing(previous => { const value = { ...previous }; delete value[thread]; return value; })} />}
    <form className="partner-network-composer" onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }} onDragOver={event => event.preventDefault()} onSubmit={event => { event.preventDefault(); void send(); }}>
      {quote && <p>{m.quote}: {messages.find(message => message.id === quote)?.text.slice(0, 120)} <Button type="button" onClick={() => setQuote("")}>{m.clearQuote}</Button></p>}
      {division && <p>{planCopy.divisionTag}<Button type="button" onClick={() => setDivision(false)}>{planCopy.removeDivision}</Button></p>}
      <ComposerAttachmentTray ownerKey={journal.scope} attachments={previews} t={t} removeDisabled={busy} onRemove={item => { setAttachments(previous => previous.filter(value => value.id !== item.id)); setPicked(previous => previous.filter(value => value.id !== item.id)); }} onReplaceImage={(item, file) => upload([file], item.id)} />
      {attachments.filter(attachment => !picked.some(item => item.id === attachment.id)).map(attachment => <span key={attachment.id}>{attachment.name} <Button type="button" onClick={() => setAttachments(previous => previous.filter(item => item.id !== attachment.id))}>×</Button></span>)}
      <textarea aria-label={m.message} value={draft} maxLength={8000} disabled={!allowed} onBeforeInput={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} onSelect={event => { selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void upload(Array.from(event.clipboardData.files)); } }} onChange={event => editDraft(event.target.value)} />
      <details><summary>{m.mentions}</summary>{room?.members.filter(member => member.state === "joined" && member.id !== room.selfId).map(member => <Button type="button" key={member.id} onClick={() => pickMention(member.id)}>{`@${wire.partnerNetworkActorName(member, room)}`}</Button>)}<Button type="button" onClick={() => pickMention()}>{m.everyone}</Button></details>
      {!thread && <Button type="button" disabled={!allowed || busy || snapshot?.plans.some(plan => ["running", "waiting"].includes(plan.status))} onClick={() => setDivision(value => !value)}>{planCopy.divide}</Button>}
      <div><label className="button">{m.upload}<input type="file" multiple disabled={!allowed || busy} onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>{snapshot?.canContinue && <Button type="button" disabled={!allowed || busy} onClick={() => { void manage("continue", "", thread); }}>{m.continue}</Button>}<IconButton type="button" label={m.stop} disabled={!allowed || busy} onClick={() => { void manage("stop"); }}><Square /></IconButton><Button type="submit" tone="primary" disabled={!allowed || !journalReady || busy || !draft.trim() && !attachments.length}><Send aria-hidden="true" />{m.send}</Button></div>
    </form>
    {settings && room && <NetworkSettings api={api} target={target} room={room} partners={partners} m={m} locale={controller.state.effectiveLocale} busy={busy} manage={manage} onClose={() => setSettings(false)} />}
  </section>;
}
function NetworkFailureNotice({ jobs, room, locale }: { jobs?: readonly wire.PartnerNetworkExecution[]; room?: wire.PartnerNetworkRoom; locale: string }) {
  return <>{jobs?.map(job => <p data-rendered-share-exclude="" data-network-execution-failure={job.id} role="status" className="partner-group-error" key={`${job.id}:${job.lease}`}>
    {room?.members.find(actor => actor.id === job.actorId)?.name}: {wire.partnerNetworkFailureMessage(job.failureCode, locale)}</p>)}</>;
}
function NetworkMedia({ api, target, attachment, owner, m, t, download }: { api: PartnerNetworkApi; target: { roomId: string; joinId: string }; attachment: wire.PartnerNetworkAttachment; owner: string; m: Copy; t: Translator; download(): void }) {
  const anchor = useRef<HTMLDivElement>(null), [source, setSource] = useState<string>(), [error, setError] = useState(false), [open, setOpen] = useState(false);
  const image = attachment.mediaType.startsWith("image/");
  useEffect(() => {
    if (!image) return; const scope = new AbortController(); let url: string | undefined, started = false;
    const load = async () => { if (started || scope.signal.aborted) return; started = true;
      try { if (attachment.sizeBytes > 20n * 1024n * 1024n) throw new Error(); const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0n;
        while (offset < attachment.sizeBytes) { const response = await api.mediaPartnerNetwork({ ...target, action: "read", mediaId: attachment.id, offset }, { signal: scope.signal }); scope.signal.throwIfAborted();
          if (response.offset !== offset + BigInt(response.data.length) || !response.data.length || response.offset > attachment.sizeBytes) throw new Error(); chunks.push(Uint8Array.from(response.data)); offset = response.offset; }
        scope.signal.throwIfAborted(); url = URL.createObjectURL(new Blob(chunks, { type: attachment.mediaType })); setSource(url);
      } catch { if (!scope.signal.aborted) setError(true); }
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); } }, { rootMargin: "200px" });
    if (observer && anchor.current) observer.observe(anchor.current); else void load();
    return () => { scope.abort(); observer?.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [api, owner, attachment.id]);
  return <div ref={anchor} className="partner-network-media">{image ? source ? <button type="button" className="partner-network-photo" onClick={() => setOpen(true)}><img src={source} alt={attachment.name} /></button> : <span>{attachment.name} · {error ? m.unavailable : m.loading}</span> : <Button onClick={download}>{attachment.name} · {m.download}</Button>}
    {open && source && <WorkspaceImageLightbox ownerKey={`${owner}:${attachment.id}`} src={source} name={attachment.name} mediaType={attachment.mediaType} showZoomControls onClose={() => setOpen(false)} onDownload={() => download()}
      labels={{ close: m.close, copy: m.copy, copied: t("workspace.imageCopied"), copyFailed: t("workspace.imageCopyFailed"), saveAs: t("workspace.imageSaveAs"), saveFailed: t("workspace.imageSaveFailed"), annotate: t("workspace.imageAnnotate"), discardAnnotation: t("workspace.imageDiscardAnnotation"), undoAnnotation: t("workspace.imageUndoAnnotation"), sendToChat: t("workspace.imageSendToChat"), sendFailed: t("workspace.imageSendFailed"), zoomIn: t("timeline.zoomIn"), zoomOut: t("timeline.zoomOut"), fitImage: t("timeline.fitImage"), actualSize: t("timeline.actualSize"), loading: m.loading, unavailable: m.unavailable }} />}
  </div>;
}
function NetworkSettings({ api, target, room, partners, m, locale, busy, manage, onClose }: { api: PartnerNetworkApi; target: { roomId: string; joinId: string }; room: wire.PartnerNetworkRoom; partners: readonly PartnerProfileView[]; m: Copy; locale: string; busy: boolean; manage(action: string, actorId?: string, value?: string): Promise<void>; onClose(): void }) {
  const self = room.members.find(actor => actor.id === room.selfId), admin = self?.state === "joined" && ["owner", "admin"].includes(self.role), owner = self?.role === "owner";
  const [name, setName] = useState(room.name), [invitation, setInvitation] = useState<wire.InvitePartnerNetworkResponse>(), [reusable, setReusable] = useState(true), [expiry, setExpiry] = useState("0"), [error, setError] = useState<string>(), [inviting, setInviting] = useState(false);
  const inviteAttempt = useRef<wire.InvitePartnerNetworkRequest | undefined>(undefined), revokeAttempt = useRef<wire.ManagePartnerNetworkRequest | undefined>(undefined);
  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const lifetime = useRef(new AbortController()); useEffect(() => () => lifetime.current.abort(), []);
  const invite = async () => { if (inviting) return; const lifetimeMs = BigInt(expiry === "0" && !reusable ? "86400000" : expiry);
    if (!inviteAttempt.current || inviteAttempt.current.reusable !== reusable || inviteAttempt.current.lifetimeMs !== lifetimeMs) inviteAttempt.current = create(wire.InvitePartnerNetworkRequestSchema, { ...target, operationId: crypto.randomUUID(), expectedRevision: room.revision, reusable, lifetimeMs });
    setInviting(true); setError(undefined); try { const result = await api.invitePartnerNetwork(inviteAttempt.current, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted) { setInvitation(result); inviteAttempt.current = undefined; revokeAttempt.current = undefined; } }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); } finally { if (!lifetime.current.signal.aborted) setInviting(false); } };
  const revoke = async () => { if (inviting || !invitation?.link || !window.confirm(m.destructive)) return;
    if (revokeAttempt.current?.value !== invitation.link.id) revokeAttempt.current = create(wire.ManagePartnerNetworkRequestSchema, { ...target, operationId: crypto.randomUUID(), expectedRevision: room.revision, action: "revoke-link", value: invitation.link.id });
    setInviting(true); setError(undefined); try { await api.managePartnerNetwork(revokeAttempt.current, { signal: lifetime.current.signal });
      if (!lifetime.current.signal.aborted) { setInvitation(previous => previous?.link ? create(wire.InvitePartnerNetworkResponseSchema, { ...previous, link: { ...previous.link, state: "revoked" } }) : previous); revokeAttempt.current = undefined; } }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(errorText(reason, m)); } finally { if (!lifetime.current.signal.aborted) setInviting(false); } };
  const validLink = invitation?.link?.state === "active" && (invitation.link.expiresAtMs === 0n || invitation.link.expiresAtMs > BigInt(Date.now()));
  const confirm = (action: string, actorId = "", value = "", warning = m.destructive) => { if (window.confirm(warning)) void manage(action, actorId, value); };
  return <Modal open showClose closeLabel={m.close} title={m.settings} onClose={onClose}><div className="partner-group-form">
    <label>{m.name}<input value={name} disabled={!admin || room.state === "dissolved" || busy} onChange={event => setName(event.target.value)} /></label><Button disabled={!admin || busy || name === room.name} onClick={() => { void manage("rename", "", name); }}>{m.save}</Button>
    {admin && <><label>{m.replyMode}<select value={room.replyMode} disabled={busy} onChange={event => { void manage("reply-mode", "", event.target.value); }}><option value="all">{m.all}</option><option value="mentioned">{m.mentioned}</option></select></label><label>{m.speakingMode}<select value={room.speakingMode} disabled={busy} onChange={event => { void manage("speaking-mode", "", event.target.value); }}><option value="auto">{m.auto}</option><option value="sequential">{m.sequential}</option></select></label></>}
    {admin && <label>{wire.partnerGroupMessages(locale).organizer}<select value={room.organizerId} disabled={busy} onChange={event => { void manage("organizer", "", event.target.value); }}><option value="">{wire.partnerGroupMessages(locale).automatic}</option>{room.members.filter(actor => actor.kind === "partner" && actor.state === "joined").map(actor => <option key={actor.id} value={actor.id}>{wire.partnerNetworkActorName(actor, room)}</option>)}</select></label>}
    {self?.state === "joined" && <NetworkProjectSetting api={api} target={target} locale={locale} room={room} />}
    <h3>{m.members}</h3>{room.members.filter(actor => actor.state === "joined").map(actor => <div className="partner-network-member" key={actor.id}><strong>{wire.partnerNetworkActorName(actor, room)}</strong><small>{actor.role === "owner" ? m.owner : actor.role === "admin" ? m.admin : m.member}</small>
      {(actor.id === room.selfId || actor.ownerId === room.selfId) && <><label>{m.nickname}<input aria-label={`${m.nickname}: ${actor.name}`} maxLength={128} value={nicknames[actor.id] ?? actor.nickname} onChange={event => setNicknames(previous => ({ ...previous, [actor.id]: event.target.value }))} /></label><Button disabled={busy || (nicknames[actor.id] ?? actor.nickname) === actor.nickname} onClick={() => { void manage("nickname", actor.id, nicknames[actor.id] ?? actor.nickname); }}>{m.save}</Button></>}
      {actor.kind === "partner" && <label>{m.access}<select disabled={busy || actor.ownerId !== room.selfId} value={actor.guestAccess} onChange={event => event.target.value === "tools" ? confirm("set-access", actor.id, "tools", m.accessWarning) : void manage("set-access", actor.id, event.target.value)}><option value="none">{m.accessNone}</option><option value="chat">{m.accessChat}</option><option value="tools">{m.accessTools}</option></select></label>}
      {actor.kind === "partner" && actor.ownerId === room.selfId && <Button disabled={busy} onClick={() => confirm("remove-partner", actor.id)}>{m.removePartner}</Button>}
      {actor.kind === "human" && owner && actor.id !== room.selfId && <><Button disabled={busy} onClick={() => confirm("set-role", actor.id, "owner")}>{m.transfer}</Button><Button disabled={busy} onClick={() => { void manage("set-role", actor.id, actor.role === "admin" ? "member" : "admin"); }}>{actor.role === "admin" ? m.member : m.admin}</Button></>}
      {actor.kind === "human" && admin && actor.id !== room.selfId && actor.role !== "owner" && <Button disabled={busy} onClick={() => confirm("remove-member", actor.id)}>{m.remove}</Button>}
    </div>)}
    {self?.state === "joined" && room.state === "active" && <label>{m.addPartner}<select value="" disabled={busy} onChange={event => { if (event.target.value) void manage("add-partner", event.target.value); }}><option value="">—</option>{partners.filter(partner => partner.lifecycle === "active" && partner.initializationState === "ready" && !room.members.some(actor => actor.ownerId === room.selfId && actor.partnerId === partner.id && actor.state === "joined")).map(partner => <option key={partner.id} value={partner.id}>{partner.displayName}</option>)}</select></label>}
    {admin && room.state === "active" && <><label className="partner-group-check"><input type="checkbox" checked={reusable} onChange={event => setReusable(event.target.checked)} />{m.reusable}</label><label>{m.expires}<select value={expiry} onChange={event => setExpiry(event.target.value)}><option value="0" disabled={!reusable}>{m.permanent}</option><option value="86400000">{m.oneDay}</option><option value="2592000000">{m.thirtyDays}</option></select></label><Button disabled={busy || inviting} onClick={() => { void invite(); }}>{m.invite}</Button></>}
    {invitation && <div><label>{m.invitation}<input readOnly value={invitation.invitation} /></label><p>{invitation.link?.state === "revoked" ? m.linkRevoked : `${m.expires}: ${invitation.link?.expiresAtMs === 0n ? m.permanent : new Date(Number(invitation.link?.expiresAtMs)).toLocaleString()}`}</p><Button disabled={!validLink || inviting} onClick={() => { void navigator.clipboard.writeText(invitation.invitation); }}>{m.copy}</Button><Button disabled={!validLink || inviting} onClick={() => { void revoke(); }}>{m.revoke}</Button></div>}
    {error && <p role="alert">{error}</p>}
    {admin && room.state !== "dissolved" && <Button disabled={busy} onClick={() => confirm(room.state === "archived" ? "restore" : "archive")}>{room.state === "archived" ? m.restore : m.archive}</Button>}
    {owner && room.state !== "dissolved" && <Button disabled={busy} onClick={() => confirm("dissolve")}>{m.dissolve}</Button>}
    {self?.state === "joined" && (self.role !== "owner" || room.members.filter(actor => actor.kind === "human" && actor.role === "owner" && actor.state === "joined").length > 1 || room.state === "dissolved") && <Button disabled={busy} onClick={() => confirm("leave")}>{m.leave}</Button>}
    <Button disabled={busy} onClick={() => { void manage("remove-list"); }}>{m.removeList}</Button>
  </div></Modal>;
}
