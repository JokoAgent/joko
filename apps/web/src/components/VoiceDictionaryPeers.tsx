import { useCallback, useEffect, useRef, useState } from "react";
import { readVoiceDictionaryPeerInvitation, readVoiceDictionaryPeerListener, type VoiceDictionaryPeerApi, type VoiceDictionaryPeerStatusView } from "@joko/contracts";
import type { Translator } from "./types.js";
import { Button, ErrorBanner } from "./ui.js";

type Confirmation = { readonly kind: "grant" | "revoke" | "direct"; readonly peerId: string; readonly name: string; readonly invitation?: string;
  readonly fingerprint: string; readonly revision: bigint; readonly source: VoiceDictionaryPeerApi["getVoiceInputDictionaryPeerStatus"]; readonly epoch: number };
type ListenerDraft = { readonly source: VoiceDictionaryPeerApi["getVoiceInputDictionaryPeerStatus"]; readonly revision: bigint;
  readonly listenPort: string; readonly host: string; readonly port: string };

export function VoiceDictionaryPeers({ api, t, enabled }: { readonly api: VoiceDictionaryPeerApi; readonly t: Translator; readonly enabled: boolean }) {
  const source = api.getVoiceInputDictionaryPeerStatus;
  const latest = useRef({ api, source, visible: true });
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  latest.current = { api, source, visible };
  const [projection, setProjection] = useState<{ readonly source: typeof source; readonly value: VoiceDictionaryPeerStatusView }>();
  const [error, setError] = useState(false);
  const [liveFailed, setLiveFailed] = useState(false);
  const [watchRetry, setWatchRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [feedback, setFeedback] = useState(false);
  const [listenerDraft, setListenerDraft] = useState<ListenerDraft>();
  const [inviteDraft, setInviteDraft] = useState("");
  const [invitation, setInvitation] = useState<{ readonly source: typeof source; readonly revision: bigint; readonly text: string }>();
  const [invalidRoute, setInvalidRoute] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const watchRequest = useRef<AbortController | undefined>(undefined);
  const streamFailed = useRef(false);
  const pushEpoch = useRef(0);
  const generation = useRef(0);
  const authorityEpoch = useRef(0);
  const pending = useRef(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const changed = (): void => {
      const visible = document.visibilityState !== "hidden";
      latest.current.visible = visible;
      if (!visible) { request.current?.abort(); watchRequest.current?.abort(); }
      setVisible(visible);
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    if (!latest.current.visible || pending.current) return;
    const owner = latest.current;
    const epoch = ++generation.current;
    const pushed = pushEpoch.current;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const value = await owner.api.getVoiceInputDictionaryPeerStatus(abort.signal);
      if (epoch === generation.current && latest.current.source === owner.source && latest.current.visible && !abort.signal.aborted) {
        setProjection((previous) => previous?.source === owner.source &&
          (previous.value.configurationRevision > value.configurationRevision ||
            (previous.value.configurationRevision === value.configurationRevision && pushed !== pushEpoch.current))
          ? previous : { source: owner.source, value });
        setError(streamFailed.current);
      }
    } catch {
      if (epoch === generation.current && latest.current.source === owner.source && latest.current.visible && !abort.signal.aborted) setError(true);
    }
  }, []);
  useEffect(() => {
    authorityEpoch.current += 1;
    setProjection(undefined); setConfirmation(undefined); setError(false); setBusy(false); setFeedback(false);
    setListenerDraft(undefined); setInviteDraft(""); setInvitation(undefined); setInvalidRoute(false);
    streamFailed.current = false; setLiveFailed(false); pushEpoch.current = 0;
    pending.current = false;
    if (visible) void refresh();
    return () => { authorityEpoch.current += 1; generation.current += 1; request.current?.abort(); };
  }, [source, visible, enabled, refresh]);
  useEffect(() => {
    if (!visible) return;
    const owner = latest.current;
    const abort = watchRequest.current = new AbortController();
    const current = (): boolean => !abort.signal.aborted && latest.current.source === owner.source && latest.current.visible;
    void (async () => {
      try {
        for await (const value of owner.api.watchVoiceInputDictionaryPeerStatus(abort.signal)) {
          if (!current()) return;
          pushEpoch.current += 1;
          setProjection((previous) => previous?.source === owner.source && previous.value.configurationRevision > value.configurationRevision
            ? previous : { source: owner.source, value });
          streamFailed.current = false; setLiveFailed(false); setError(false);
        }
        if (current()) throw new Error("Dictionary sharing updates disconnected.");
      } catch {
        if (current()) { streamFailed.current = true; setLiveFailed(true); setError(true); }
      }
    })();
    return () => abort.abort();
  }, [source, visible, enabled, watchRetry]);
  const reconnect = (): void => { if (streamFailed.current) setWatchRetry((value) => value + 1); void refresh(); };
  useEffect(() => {
    if (confirmation) confirmButton.current?.focus();
    else if (returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; }
  }, [confirmation]);
  const status = visible && projection !== undefined && projection.source === source ? projection.value : undefined;
  const resetListenerDraft = (): void => {
    if (status) setListenerDraft({ source, revision: status.configurationRevision, listenPort: status.listener?.listenPort.toString() ?? "",
      host: status.listener?.host ?? "", port: status.listener?.port.toString() ?? "" });
  };
  useEffect(() => {
    if (status && listenerDraft?.source !== source) resetListenerDraft();
  }, [status, source, listenerDraft?.source]);
  const currentConfirmation = confirmation?.source === source ? confirmation : undefined;
  const confirmCurrent = currentConfirmation !== undefined && status !== undefined && (currentConfirmation.kind === "direct"
    ? status.configurationRevision === currentConfirmation.revision && currentConfirmation.invitation === inviteDraft &&
      !status.peers.some((peer) => peer.peerId === currentConfirmation.peerId && peer.fingerprint !== currentConfirmation.fingerprint)
    : currentConfirmation.kind === "grant"
    ? status.configurationRevision === currentConfirmation.revision && status.candidates.some((value) => value.nodeId === currentConfirmation.peerId && value.fingerprint === currentConfirmation.fingerprint && !value.granted && !value.keyChanged)
    : status.peers.some((value) => value.peerId === currentConfirmation.peerId && value.revision === currentConfirmation.revision && value.fingerprint === currentConfirmation.fingerprint));

  const mutate = async (intent?: Confirmation, operation?: (owner: VoiceDictionaryPeerApi, signal: AbortSignal) => Promise<VoiceDictionaryPeerStatusView | string>): Promise<void> => {
    if (pending.current || streamFailed.current || !status?.available || !visible || (intent && (!confirmCurrent || intent.source !== latest.current.source || intent.epoch !== authorityEpoch.current))) return;
    const owner = latest.current;
    const epoch = ++generation.current;
    const pushed = pushEpoch.current;
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    pending.current = true; setBusy(true); setError(false); setFeedback(false);
    const current = (): boolean => epoch === generation.current && owner.source === latest.current.source && latest.current.visible && !abort.signal.aborted;
    try {
      const value = operation ? await operation(owner.api, abort.signal) : intent?.kind === "direct"
        ? await owner.api.grantVoiceInputDictionaryDirectPeer(intent.revision, intent.invitation!, intent.fingerprint, abort.signal)
        : intent?.kind === "grant"
        ? await owner.api.grantVoiceInputDictionaryPeer(intent.revision, intent.peerId, intent.fingerprint, abort.signal)
        : intent?.kind === "revoke" ? await owner.api.revokeVoiceInputDictionaryPeer(intent.peerId, intent.revision, abort.signal)
          : await owner.api.syncVoiceInputDictionaryNow(status.configurationRevision, undefined, abort.signal);
      if (current()) {
        if (typeof value === "string") {
          const preview = readVoiceDictionaryPeerInvitation(value);
          if (preview.nodeId !== status.nodeId || preview.fingerprint !== status.fingerprint || preview.host !== status.listener?.host || preview.port !== status.listener?.port) throw new Error("Dictionary invitation changed.");
          setInvitation({ source: owner.source, revision: status.configurationRevision, text: value });
        } else setProjection((previous) => previous?.source === owner.source &&
          (previous.value.configurationRevision > value.configurationRevision ||
            (previous.value.configurationRevision === value.configurationRevision && pushed !== pushEpoch.current))
          ? previous : { source: owner.source, value });
        setConfirmation(undefined); setFeedback(true);
      }
    } catch { if (current()) setError(true); }
    finally {
      if (current()) { pending.current = false; setBusy(false); if (intent || operation) void refresh(); }
    }
  };
  const open = (value: Omit<Confirmation, "source" | "epoch">): void => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation({ ...value, source, epoch: authorityEpoch.current }); setError(false); setFeedback(false);
  };
  const phaseKey = status && ({ off: "settings.voicePeers.off", waiting: "settings.voicePeers.waiting", syncing: "settings.voicePeers.syncing",
    up_to_date: "settings.voicePeers.upToDate", error: "settings.voicePeers.failed" } as const)[status.phase];
  return <section className="voice-input-setting-stack" aria-label={t("settings.voicePeers.title")}>
    <div><strong>{t("settings.voicePeers.title")}</strong><p className="muted">{t("settings.voicePeers.hint")}</p></div>
    {!status && !error && <p role="status">{t("settings.voicePeers.loading")}</p>}
    {error && <ErrorBanner message={t("settings.voicePeers.failed")} />}
    {status && <>
      <p role="status">{status.available && phaseKey ? t(phaseKey) : t("settings.voicePeers.unavailable")}</p>
      <div className="setting-row"><div><strong>{t("settings.voicePeers.identity")}</strong><code style={{ overflowWrap: "anywhere" }}>{status.fingerprint || "—"}</code></div></div>
      <div className="voice-input-actions">
        <Button tone="ghost" disabled={busy} onClick={reconnect}>{t("settings.voicePeers.refresh")}</Button>
        <Button disabled={busy || liveFailed || !status.available || !status.enabled} onClick={() => void mutate()}>{t("settings.voicePeers.syncNow")}</Button>
      </div>
      <strong>{t("settings.voicePeers.directTitle")}</strong>
      <p className="muted">{t("settings.voicePeers.directHint")}</p>
      {listenerDraft?.source === source && <>
        <label>{t("settings.voicePeers.listenPort")}<input type="text" inputMode="numeric" value={listenerDraft.listenPort}
          disabled={busy || liveFailed || !status.available} onChange={(event) => setListenerDraft({ ...listenerDraft, listenPort: event.target.value })} /></label>
        <label>{t("settings.voicePeers.publicHost")}<input type="text" value={listenerDraft.host} autoCapitalize="none" autoCorrect="off"
          disabled={busy || liveFailed || !status.available} onChange={(event) => setListenerDraft({ ...listenerDraft, host: event.target.value })} /></label>
        <label>{t("settings.voicePeers.publicPort")}<input type="text" inputMode="numeric" value={listenerDraft.port}
          disabled={busy || liveFailed || !status.available} onChange={(event) => setListenerDraft({ ...listenerDraft, port: event.target.value })} /></label>
        {listenerDraft.revision !== status.configurationRevision && <p role="status">{t("settings.voicePeers.changed")}</p>}
        <div className="voice-input-actions">
          <Button disabled={busy || liveFailed || !status.available || listenerDraft.revision !== status.configurationRevision} onClick={() => {
            try {
              const value = readVoiceDictionaryPeerListener({ listenPort: Number(listenerDraft.listenPort), host: listenerDraft.host, port: Number(listenerDraft.port) });
              setInvalidRoute(false); void mutate(undefined, (api, signal) => api.configureVoiceInputDictionaryListener(listenerDraft.revision, value, signal));
            } catch { setInvalidRoute(true); }
          }}>{t("settings.voicePeers.saveListener")}</Button>
          <Button tone="ghost" disabled={busy || !status.available} onClick={resetListenerDraft}>{t("settings.voicePeers.reviewListener")}</Button>
          <Button tone="ghost" disabled={busy || liveFailed || !status.available || !status.listener} onClick={() => void mutate(undefined,
            (api, signal) => api.configureVoiceInputDictionaryListener(status.configurationRevision, undefined, signal))}>{t("settings.voicePeers.clearListener")}</Button>
        </div>
      </>}
      <Button tone="ghost" disabled={busy || liveFailed || !status.available || !status.listener} onClick={() => void mutate(undefined,
        (api, signal) => api.getVoiceInputDictionaryPeerInvitation(signal))}>{t("settings.voicePeers.exportInvitation")}</Button>
      {invitation?.source === source && invitation.revision === status.configurationRevision && <label>{t("settings.voicePeers.invitation")}
        <textarea readOnly value={invitation.text} rows={4} onFocus={(event) => event.currentTarget.select()} /></label>}
      <label>{t("settings.voicePeers.pasteInvitation")}<textarea value={inviteDraft} rows={4} disabled={busy || liveFailed || !status.available}
        onChange={(event) => { setInviteDraft(event.target.value); setInvalidRoute(false); }} /></label>
      <Button disabled={busy || liveFailed || !status.available || !inviteDraft} onClick={() => {
        try {
          const preview = readVoiceDictionaryPeerInvitation(inviteDraft);
          if (preview.nodeId === status.nodeId || status.peers.some((peer) => peer.peerId === preview.nodeId && peer.fingerprint !== preview.fingerprint)) throw new Error("Dictionary peer identity changed.");
          setInvalidRoute(false); open({ kind: "direct", peerId: preview.nodeId, name: preview.displayName, fingerprint: preview.fingerprint,
            revision: status.configurationRevision, invitation: inviteDraft });
        } catch { setInvalidRoute(true); }
      }}>{t("settings.voicePeers.previewInvitation")}</Button>
      {invalidRoute && <ErrorBanner message={t("settings.voicePeers.invalidRoute")} />}
      <strong>{t("settings.voicePeers.authorized")}</strong>
      {status.peers.length === 0 && <p className="muted">{t("settings.voicePeers.noPeers")}</p>}
      {status.peers.map((peer) => <article className="setting-row" key={peer.peerId}>
        <div><strong>{peer.displayName}</strong><span>{t(peer.online ? "settings.voicePeers.online" : "settings.voicePeers.offline")}</span>
          <code style={{ overflowWrap: "anywhere" }}>{peer.fingerprint}</code>
          {peer.route && <span>{t("settings.voicePeers.configuredRoute", { host: peer.route.host, port: peer.route.port })}</span>}
          {peer.lastSyncAt !== undefined && <span>{t("settings.voicePeers.lastSync", { time: new Date(peer.lastSyncAt).toLocaleString() })}</span>}
        </div>
        {peer.route && <Button tone="ghost" disabled={busy || liveFailed || !status.available} onClick={() => void mutate(undefined,
          (api, signal) => api.clearVoiceInputDictionaryPeerRoute(status.configurationRevision, peer.peerId, signal))}>{t("settings.voicePeers.clearRoute")}</Button>}
        <Button tone="ghost" disabled={busy || liveFailed || !status.available} onClick={() => open({ kind: "revoke", peerId: peer.peerId, name: peer.displayName,
          fingerprint: peer.fingerprint, revision: peer.revision })}>{t("settings.voicePeers.revoke")}</Button>
      </article>)}
      <strong>{t("settings.voicePeers.candidates")}</strong>
      {!status.enabled && <p className="muted">{t("settings.voicePeers.offHint")}</p>}
      {status.enabled && status.candidates.filter((value) => !value.granted).length === 0 && <p className="muted">{t("settings.voicePeers.noCandidates")}</p>}
      {status.candidates.filter((value) => !value.granted).map((peer) => <article className="setting-row" key={peer.nodeId}>
        <div><strong>{peer.displayName}</strong><code style={{ overflowWrap: "anywhere" }}>{peer.fingerprint}</code>
          {peer.keyChanged && <span>{t("settings.voicePeers.keyChanged")}</span>}</div>
        <Button tone="ghost" disabled={busy || liveFailed || !status.available || !status.enabled || peer.keyChanged}
          onClick={() => open({ kind: "grant", peerId: peer.nodeId, name: peer.displayName, fingerprint: peer.fingerprint,
            revision: status.configurationRevision })}>{t("settings.voicePeers.allow")}</Button>
      </article>)}
    </>}
    {!status && error && <Button tone="ghost" onClick={reconnect}>{t("settings.voicePeers.refresh")}</Button>}
    {currentConfirmation && <div role="alertdialog" aria-labelledby="voice-peer-confirm-title" aria-describedby="voice-peer-confirm-body"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setConfirmation(undefined); } }}>
      <strong id="voice-peer-confirm-title">{t(currentConfirmation.kind === "revoke" ? "settings.voicePeers.revokeTitle" : "settings.voicePeers.allowTitle", { name: currentConfirmation.name })}</strong>
      <p id="voice-peer-confirm-body">{t(currentConfirmation.kind === "revoke" ? "settings.voicePeers.revokeBody" : "settings.voicePeers.allowBody")}</p>
      {currentConfirmation.kind === "direct" && <p>{t("settings.voicePeers.configuredRoute", {
        host: readVoiceDictionaryPeerInvitation(currentConfirmation.invitation!).host, port: readVoiceDictionaryPeerInvitation(currentConfirmation.invitation!).port })}</p>}
      <code style={{ overflowWrap: "anywhere" }}>{currentConfirmation.fingerprint}</code>
      {!confirmCurrent && <p role="status">{t("settings.voicePeers.changed")}</p>}
      <div className="voice-input-actions">
        <Button tone="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button>
        <button type="button" ref={confirmButton} className="button" disabled={busy || liveFailed || !confirmCurrent} onClick={() => void mutate(currentConfirmation)}>{t("settings.voicePeers.confirm")}</button>
      </div>
    </div>}
    {feedback && <p role="status">{t("settings.voicePeers.saved")}</p>}
  </section>;
}
