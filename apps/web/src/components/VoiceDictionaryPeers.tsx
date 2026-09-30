import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceDictionaryPeerApi, VoiceDictionaryPeerStatusView } from "@joko/contracts";
import type { Translator } from "./types.js";
import { Button, ErrorBanner } from "./ui.js";

type Confirmation = { readonly kind: "grant" | "revoke"; readonly peerId: string; readonly name: string;
  readonly fingerprint: string; readonly revision: bigint; readonly source: VoiceDictionaryPeerApi["getVoiceInputDictionaryPeerStatus"]; readonly epoch: number };

export function VoiceDictionaryPeers({ api, t, enabled }: { readonly api: VoiceDictionaryPeerApi; readonly t: Translator; readonly enabled: boolean }) {
  const source = api.getVoiceInputDictionaryPeerStatus;
  const latest = useRef({ api, source, visible: true });
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  latest.current = { api, source, visible };
  const [projection, setProjection] = useState<{ readonly source: typeof source; readonly value: VoiceDictionaryPeerStatusView }>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [feedback, setFeedback] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const authorityEpoch = useRef(0);
  const pending = useRef(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    if (!latest.current.visible || pending.current) return;
    const owner = latest.current;
    const epoch = ++generation.current;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    try {
      const value = await owner.api.getVoiceInputDictionaryPeerStatus(abort.signal);
      if (epoch === generation.current && latest.current.source === owner.source && latest.current.visible && !abort.signal.aborted) {
        setProjection({ source: owner.source, value }); setError(false);
      }
    } catch {
      if (epoch === generation.current && latest.current.source === owner.source && latest.current.visible && !abort.signal.aborted) setError(true);
    }
  }, []);
  useEffect(() => {
    authorityEpoch.current += 1;
    setProjection(undefined); setConfirmation(undefined); setError(false); setBusy(false); setFeedback(false);
    pending.current = false;
    if (visible) void refresh();
    const timer = visible ? setInterval(() => void refresh(), 5_000) : undefined;
    return () => { authorityEpoch.current += 1; generation.current += 1; request.current?.abort(); if (timer !== undefined) clearInterval(timer); };
  }, [source, visible, enabled, refresh]);
  useEffect(() => {
    if (confirmation) confirmButton.current?.focus();
    else if (returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; }
  }, [confirmation]);
  const status = visible && projection !== undefined && projection.source === source ? projection.value : undefined;
  const currentConfirmation = confirmation?.source === source ? confirmation : undefined;
  const confirmCurrent = currentConfirmation !== undefined && status !== undefined && (currentConfirmation.kind === "grant"
    ? status.configurationRevision === currentConfirmation.revision && status.candidates.some((value) => value.nodeId === currentConfirmation.peerId && value.fingerprint === currentConfirmation.fingerprint && !value.granted && !value.keyChanged)
    : status.peers.some((value) => value.peerId === currentConfirmation.peerId && value.revision === currentConfirmation.revision && value.fingerprint === currentConfirmation.fingerprint));

  const mutate = async (intent?: Confirmation): Promise<void> => {
    if (pending.current || !status?.available || !visible || (intent && (!confirmCurrent || intent.source !== latest.current.source || intent.epoch !== authorityEpoch.current))) return;
    const owner = latest.current;
    const epoch = ++generation.current;
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    pending.current = true; setBusy(true); setError(false); setFeedback(false);
    const current = (): boolean => epoch === generation.current && owner.source === latest.current.source && latest.current.visible && !abort.signal.aborted;
    try {
      const value = intent?.kind === "grant"
        ? await owner.api.grantVoiceInputDictionaryPeer(intent.revision, intent.peerId, intent.fingerprint, abort.signal)
        : intent?.kind === "revoke" ? await owner.api.revokeVoiceInputDictionaryPeer(intent.peerId, intent.revision, abort.signal)
          : await owner.api.syncVoiceInputDictionaryNow(status.configurationRevision, undefined, abort.signal);
      if (current()) { setProjection({ source: owner.source, value }); setConfirmation(undefined); setFeedback(true); }
    } catch { if (current()) setError(true); }
    finally {
      if (current()) { pending.current = false; setBusy(false); if (intent) void refresh(); }
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
        <Button tone="ghost" disabled={busy} onClick={() => void refresh()}>{t("settings.voicePeers.refresh")}</Button>
        <Button disabled={busy || !status.available || !status.enabled} onClick={() => void mutate()}>{t("settings.voicePeers.syncNow")}</Button>
      </div>
      <strong>{t("settings.voicePeers.authorized")}</strong>
      {status.peers.length === 0 && <p className="muted">{t("settings.voicePeers.noPeers")}</p>}
      {status.peers.map((peer) => <article className="setting-row" key={peer.peerId}>
        <div><strong>{peer.displayName}</strong><span>{t(peer.online ? "settings.voicePeers.online" : "settings.voicePeers.offline")}</span>
          <code style={{ overflowWrap: "anywhere" }}>{peer.fingerprint}</code>
          {peer.lastSyncAt !== undefined && <span>{t("settings.voicePeers.lastSync", { time: new Date(peer.lastSyncAt).toLocaleString() })}</span>}
        </div>
        <Button tone="ghost" disabled={busy || !status.available} onClick={() => open({ kind: "revoke", peerId: peer.peerId, name: peer.displayName,
          fingerprint: peer.fingerprint, revision: peer.revision })}>{t("settings.voicePeers.revoke")}</Button>
      </article>)}
      <strong>{t("settings.voicePeers.candidates")}</strong>
      {!status.enabled && <p className="muted">{t("settings.voicePeers.offHint")}</p>}
      {status.enabled && status.candidates.filter((value) => !value.granted).length === 0 && <p className="muted">{t("settings.voicePeers.noCandidates")}</p>}
      {status.candidates.filter((value) => !value.granted).map((peer) => <article className="setting-row" key={peer.nodeId}>
        <div><strong>{peer.displayName}</strong><code style={{ overflowWrap: "anywhere" }}>{peer.fingerprint}</code>
          {peer.keyChanged && <span>{t("settings.voicePeers.keyChanged")}</span>}</div>
        <Button tone="ghost" disabled={busy || !status.available || !status.enabled || peer.keyChanged}
          onClick={() => open({ kind: "grant", peerId: peer.nodeId, name: peer.displayName, fingerprint: peer.fingerprint,
            revision: status.configurationRevision })}>{t("settings.voicePeers.allow")}</Button>
      </article>)}
    </>}
    {!status && error && <Button tone="ghost" onClick={() => void refresh()}>{t("settings.voicePeers.refresh")}</Button>}
    {currentConfirmation && <div role="alertdialog" aria-labelledby="voice-peer-confirm-title" aria-describedby="voice-peer-confirm-body"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setConfirmation(undefined); } }}>
      <strong id="voice-peer-confirm-title">{t(currentConfirmation.kind === "grant" ? "settings.voicePeers.allowTitle" : "settings.voicePeers.revokeTitle", { name: currentConfirmation.name })}</strong>
      <p id="voice-peer-confirm-body">{t(currentConfirmation.kind === "grant" ? "settings.voicePeers.allowBody" : "settings.voicePeers.revokeBody")}</p>
      <code style={{ overflowWrap: "anywhere" }}>{currentConfirmation.fingerprint}</code>
      {!confirmCurrent && <p role="status">{t("settings.voicePeers.changed")}</p>}
      <div className="voice-input-actions">
        <Button tone="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button>
        <button type="button" ref={confirmButton} className="button" disabled={busy || !confirmCurrent} onClick={() => void mutate(currentConfirmation)}>{t("settings.voicePeers.confirm")}</button>
      </div>
    </div>}
    {feedback && <p role="status">{t("settings.voicePeers.saved")}</p>}
  </section>;
}
