import { useEffect, useRef, useState } from "react";
import type { DesktopSpeakerApi, DesktopSpeakerStatus, DesktopSpeakerStrength } from "@joko/contracts";
import { WebAudioVoicePcmCapture } from "../voice-input-pcm.js";
import type { Translator } from "./types.js";
import { Button, SelectControl, SwitchControl } from "./ui.js";

const clipCount = 3;
const clipLimitMs = 30_000;
const clipLimitBytes = 960_000;

export function DesktopSpeakerSettings({ api, profileId, deviceId, t }: {
  readonly api: DesktopSpeakerApi;
  readonly profileId: string;
  readonly deviceId?: string;
  readonly t: Translator;
}) {
  const [status, setStatus] = useState<DesktopSpeakerStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [enrolling, setEnrolling] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const capture = useRef<AbortController | undefined>(undefined);
  const finish = useRef<(() => void) | undefined>(undefined);
  const clips = useRef<Uint8Array[]>([]);

  const clearClips = () => { for (const clip of clips.current) clip.fill(0); clips.current = []; };
  useEffect(() => {
    const controller = lifetime.current = new AbortController();
    void api.status(profileId).then(next => { if (!controller.signal.aborted) setStatus(next); })
      .catch(() => { if (!controller.signal.aborted) setError(t("voice.speaker.error")); });
    return () => { controller.abort(); capture.current?.abort(); clearClips(); };
  }, [api, profileId, t]);

  useEffect(() => {
    const retireRecording = () => {
      if (!capture.current) return;
      capture.current.abort();
      finish.current = undefined;
      setRecording(false);
    };
    const release = window.jokoDesktop?.microphone?.onRelease(retireRecording);
    window.addEventListener("pagehide", retireRecording);
    return () => { release?.(); window.removeEventListener("pagehide", retireRecording); };
  }, []);

  const perform = (action: () => Promise<void>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy || capture.current) return;
    setBusy(true); setError(undefined);
    void action().catch(() => { if (!signal.aborted) setError(t("voice.speaker.error")); })
      .finally(() => { if (!signal.aborted) setBusy(false); });
  };
  const adopt = (next: DesktopSpeakerStatus) => {
    if (!lifetime.current?.signal.aborted) setStatus(next);
  };
  const discard = () => {
    capture.current?.abort();
    finish.current = undefined;
    clearClips(); setRecorded(0); setRecording(false); setEnrolling(false);
  };
  const record = () => {
    if (capture.current || clips.current.length >= clipCount) return;
    const controller = capture.current = new AbortController();
    setError(undefined); setRecording(true);
    void recordSpeakerClip(deviceId, controller.signal, stop => { finish.current = stop; }).then(clip => {
      if (controller.signal.aborted) { clip.fill(0); return; }
      clips.current.push(clip);
      setRecorded(clips.current.length);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(t(error instanceof DOMException && error.name === "NotAllowedError"
        ? "voice.errors.permissionDenied" : "voice.speaker.error"));
    }).finally(() => {
      if (capture.current !== controller) return;
      capture.current = undefined; finish.current = undefined;
      if (!lifetime.current?.signal.aborted) setRecording(false);
    });
  };
  const save = () => perform(async () => {
    const result = await api.enroll(profileId, clips.current);
    if (lifetime.current?.signal.aborted) return;
    if (result.ok) { adopt(result.status); discard(); }
    else {
      const index = result.clipIndex ?? 0;
      for (const clip of clips.current.splice(index)) clip.fill(0);
      setRecorded(clips.current.length);
      setError(t("voice.speaker.retryClip", { clip: index + 1 }));
    }
  });

  return <>
    <div className="setting-row">
      <div><strong>{t("voice.speaker.title")}</strong>
        <span>{t(status?.supported === false ? "voice.speaker.unsupported" : "voice.speaker.description")}</span></div>
      {status?.supported && !status.modelsReady && <Button tone="ghost" disabled={busy}
        onClick={() => perform(async () => adopt(await api.download(profileId)))}>{t(busy ? "voice.speaker.downloading" : "voice.speaker.download")}</Button>}
    </div>
    {status?.enrolled && <div className="setting-row">
      <div><strong>{t("voice.speaker.enable")}</strong><span>{t("voice.speaker.enrolled")}</span></div>
      <SwitchControl aria-label={t("voice.speaker.enable")} checked={status.enabled}
        disabled={busy || enrolling || !status.enabled && !status.modelsReady}
        onChange={event => { const enabled = event.target.checked; perform(async () => adopt(await api.configure(profileId, { enabled }))); }} />
    </div>}
    {status?.enrolled && <div className="setting-row">
      <div><strong>{t("voice.speaker.strength")}</strong></div>
      <SelectControl value={status.strength ?? ""} disabled={busy || enrolling} aria-label={t("voice.speaker.strength")}
        onChange={event => {
          const strength = event.target.value as DesktopSpeakerStrength | "";
          perform(async () => adopt(await api.configure(profileId, { strength: strength || null })));
        }}>
        <option value="">{t("voice.speaker.default")}</option>
        {(["relaxed", "standard", "strict"] as const).map(strength => <option key={strength} value={strength}>{t(`voice.speaker.${strength}`)}</option>)}
      </SelectControl>
    </div>}
    {status?.modelsReady && <div className="setting-row">
      <div><strong>{t("voice.speaker.enroll")}</strong><span>{t("voice.speaker.instructions")}</span></div>
      <div className="voice-input-shortcut-control">
        {!enrolling && <Button tone="ghost" disabled={busy} onClick={() => setEnrolling(true)}>{t(status.enrolled ? "voice.speaker.replace" : "voice.speaker.enroll")}</Button>}
        {enrolling && (recording ? <Button tone="ghost" onClick={() => finish.current?.()}>{t("voice.speaker.stop")}</Button>
          : recorded < clipCount ? <Button tone="ghost" disabled={busy} onClick={record}>{t("voice.speaker.record", { clip: recorded + 1 })}</Button>
            : <Button tone="primary" disabled={busy} onClick={save}>{t("voice.speaker.save")}</Button>)}
        {enrolling && <Button tone="ghost" disabled={busy} onClick={discard}>{t("common.cancel")}</Button>}
        {status.enrolled && !enrolling && <Button tone="ghost" disabled={busy} onClick={() => {
          if (window.confirm(t("voice.speaker.removeConfirm"))) perform(async () => adopt(await api.remove(profileId)));
        }}>{t("voice.speaker.remove")}</Button>}
      </div>
    </div>}
    {error && <p className="composer__error" role="alert">{error}</p>}
  </>;
}

async function recordSpeakerClip(deviceId: string | undefined, signal: AbortSignal,
  onReady: (stop: () => void) => void): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1,
    ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }) }, video: false });
  const capture = new WebAudioVoicePcmCapture(window.AudioContext);
  const buffer = new Uint8Array(clipLimitBytes);
  let written = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const ended = new Promise<void>(resolve => { stop = resolve; });
  const tracks = stream.getTracks();
  for (const track of tracks) track.addEventListener("ended", stop);
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    await capture.start(stream, ({ audio }) => {
      const bytes = audio.subarray(0, buffer.length - written);
      buffer.set(bytes, written);
      written += bytes.length;
      if (written === buffer.length) stop();
    });
    onReady(stop);
    timer = setTimeout(stop, clipLimitMs);
    await ended;
    await capture.stop();
    signal.throwIfAborted();
    return buffer.slice(0, written);
  } finally {
    clearTimeout(timer);
    await capture.stop().catch(() => undefined);
    signal.removeEventListener("abort", stop);
    for (const track of tracks) { track.removeEventListener("ended", stop); track.stop(); }
    buffer.fill(0);
  }
}
