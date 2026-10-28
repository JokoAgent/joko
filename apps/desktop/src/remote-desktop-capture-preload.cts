/// <reference lib="dom" />

import type {
  DesktopRemoteDesktopCaptureCommand,
  DesktopRemoteDesktopCaptureNativeFrame,
  DesktopRemoteDesktopCaptureReply
} from "./remote-desktop-capture-protocol.js";
import type { DesktopRemoteDesktopCursor } from "./remote-desktop-native-capture.js";
import type { RemoteDesktopIceCandidate } from "@joko/device-peer";
import type { IpcRendererEvent } from "electron";

const { ipcRenderer } = require("electron") as typeof import("electron");
const AUDIO_RETRY_MS: typeof import("./remote-desktop-capture-protocol.js").REMOTE_DESKTOP_AUDIO_RETRY_MS
  = [3_000, 10_000, 30_000];

const CHANNELS = Object.freeze({
  ready: "joko:remote-desktop-capture:ready",
  command: "joko:remote-desktop-capture:command",
  reply: "joko:remote-desktop-capture:reply",
  input: "joko:remote-desktop-capture:input",
  request: "joko:remote-desktop-capture:request",
  nativeFrame: "joko:remote-desktop-capture:native-frame",
  nativeAudio: "joko:remote-desktop-capture:native-audio",
  presentationPong: "joko:remote-desktop-capture:presentation-pong",
  stopped: "joko:remote-desktop-capture:stopped"
});

let peer: RTCPeerConnection | undefined;
// Retain the actual UDP socket until Main has confirmed public forwarding
// retirement. Track/input authority is revoked immediately while it is held.
const heldPeers = new Set<RTCPeerConnection>();
let stream: MediaStream | undefined;
let generation = 0;
let attempt: { readonly leaseId: string; readonly attemptId: string } | undefined;
let candidates: RemoteDesktopIceCandidate[] = [];
let remoteCandidates = new Set<string>();
let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
let presentationTimer: ReturnType<typeof setInterval> | undefined;
let presentationLease: string | undefined;
let presentationChallenge: string | undefined;
let inputChannel: RTCDataChannel | undefined;
let exchanging = false;
let native: Awaited<ReturnType<typeof nativeCaptureStream>> | undefined;
let nativeGeneration = 0;
let sourceRevision = 0;
let switchNativeSource: ((revision: number) => Promise<void>) | undefined;
let recoverCapture: (() => void) | undefined;
let latestCursor: DesktopRemoteDesktopCursor | null | undefined;
let cursorTimer: ReturnType<typeof setInterval> | undefined;
let audio: Awaited<ReturnType<typeof nativeAudioStream>> | undefined;
let audioAbort: AbortController | undefined;
let audioDesired: { readonly revision: number; readonly enabled: boolean } | undefined;
let resetAudio: (() => void) | undefined;
let audioRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** Output-monitor PCM enters the existing RTC stream and never the host speakers. */
async function nativeAudioStream(
  read: () => Promise<Uint8Array>, current: () => boolean, signal: AbortSignal
): Promise<{ readonly track: MediaStreamTrack; stop(): void }> {
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  const destination = context.createMediaStreamDestination();
  const sources = new Set<AudioBufferSourceNode>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  const stopAudio = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", stopAudio);
    for (const source of sources) source.stop();
    sources.clear();
    destination.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
    void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", stopAudio, { once: true });
  const poll = async (): Promise<void> => {
    if (stopped || signal.aborted || !current()) return stopAudio();
    try {
      const bytes = await read();
      if (stopped || signal.aborted || !current()) return stopAudio();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 38_400 || bytes.byteLength % 8 !== 0) throw new Error("audio-unavailable");
      if (bytes.length > 0) {
        const frames = bytes.byteLength / 8;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const buffer = context.createBuffer(2, frames, 48_000);
        for (let channel = 0; channel < 2; channel += 1) {
          const output = buffer.getChannelData(channel);
          for (let frame = 0; frame < frames; frame += 1) {
            const value = view.getFloat32(frame * 8 + channel * 4, true);
            output[frame] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
          }
        }
        if (next > context.currentTime + 0.15) {
          for (const source of sources) source.stop();
          sources.clear(); next = 0;
        }
        next = Math.max(context.currentTime + 0.02, next);
        const source = context.createBufferSource();
        source.buffer = buffer; source.connect(destination);
        source.onended = () => { sources.delete(source); source.disconnect(); };
        sources.add(source); source.start(next);
        next += frames / 48_000;
      }
      timer = setTimeout(() => { void poll(); }, 20);
    } catch { stopAudio(); }
  };
  try {
    if (signal.aborted) throw new Error("audio-unavailable");
    await context.resume();
    await poll();
    if (stopped || !current()) throw new Error("audio-unavailable");
    const track = destination.stream.getAudioTracks()[0];
    if (track === undefined) throw new Error("audio-unavailable");
    return { track, stop: stopAudio };
  } catch {
    stopAudio(); throw new Error("audio-unavailable");
  }
}

/** The original consent stream belongs to the lease; RTC owns only clones. */
class PortalCaptureStream {
  #lease: string | undefined;
  #pending: Promise<MediaStream> | undefined;
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;
  #error: Error | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  prepare(lease: string): void {
    if (this.#lease === lease) return;
    this.stop();
    this.#lease = lease;
    const current = this.#generation;
    const ended = (): void => {
      if (current !== this.#generation) return;
      this.stop();
      void ipcRenderer.invoke(CHANNELS.stopped, lease).catch(() => undefined);
    };
    this.#timer = setTimeout(ended, 120_000);
    this.#pending = navigator.mediaDevices.getDisplayMedia({ audio: false,
      video: { frameRate: { ideal: 30, max: 60 } } }).then((value) => {
      if (current !== this.#generation) {
        value.getTracks().forEach(track => track.stop());
        throw new Error("stopped");
      }
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#stream = value;
      const track = value.getVideoTracks()[0];
      if (track === undefined) {
        value.getTracks().forEach(item => item.stop());
        throw new Error("unavailable");
      }
      track.addEventListener("ended", ended, { once: true });
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = value;
      this.#video = video;
      void video.play().catch(ended);
      return value;
    }).catch((error: unknown) => {
      if (current === this.#generation) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#error = new Error("unavailable");
        this.#stream?.getTracks().forEach(track => track.stop());
        this.#stream = undefined;
      }
      throw error;
    });
    void this.#pending.catch(() => undefined);
  }

  async capture(lease: string): Promise<MediaStream> {
    if (this.#lease !== lease || this.#pending === undefined) throw new Error("stopped");
    const current = this.#generation;
    const value = await this.#pending;
    if (current !== this.#generation || this.#error !== undefined || !value.active) throw new Error("stopped");
    return value.clone();
  }

  frame(lease: string): Extract<DesktopRemoteDesktopCaptureReply, { kind: "frame" }>["frame"] {
    if (this.#lease !== lease || this.#pending === undefined) throw new Error("stopped");
    if (this.#error !== undefined) throw this.#error;
    const video = this.#video;
    const track = this.#stream?.getVideoTracks()[0];
    if (video === undefined || track === undefined || track.muted || track.readyState !== "live"
      || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) return null;
    let scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    for (let index = 0; index < 4; index += 1) {
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const jpeg = canvas.toDataURL("image/jpeg", 0.55).slice("data:image/jpeg;base64,".length);
      if (jpeg.length > 0 && jpeg.length <= 180_000) return { jpeg, width: canvas.width, height: canvas.height };
      scale *= 0.75;
    }
    return null;
  }

  stop(): void {
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#stream?.getTracks().forEach(track => track.stop());
    this.#stream = undefined;
    this.#pending = undefined;
    this.#error = undefined;
    this.#lease = undefined;
    this.#video?.pause();
    if (this.#video !== undefined) this.#video.srcObject = null;
    this.#video = undefined;
  }
}

const portal = new PortalCaptureStream();
window.addEventListener("unload", () => portal.stop(), { once: true });

function stop(notifyMain = true): void {
  const retiringPeer = peer;
  const retiringAttempt = attempt;
  generation += 1;
  nativeGeneration += 1;
  exchanging = false;
  clearTimeout(disconnectedTimer);
  clearTimeout(audioRetryTimer);
  clearInterval(presentationTimer);
  clearInterval(cursorTimer);
  disconnectedTimer = undefined;
  audioRetryTimer = undefined;
  presentationTimer = undefined;
  cursorTimer = undefined;
  presentationLease = undefined;
  presentationChallenge = undefined;
  inputChannel = undefined;
  latestCursor = undefined;
  native?.stop();
  native = undefined;
  audioAbort?.abort();
  audioAbort = undefined;
  audio?.stop();
  audio = undefined;
  audioDesired = undefined;
  resetAudio = undefined;
  recoverCapture = undefined;
  switchNativeSource = undefined;
  attempt = undefined;
  candidates = [];
  remoteCandidates = new Set();
  peer = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  if (retiringPeer !== undefined) {
    heldPeers.add(retiringPeer);
    if (notifyMain && retiringAttempt !== undefined) {
      void ipcRenderer.invoke(CHANNELS.stopped, retiringAttempt.leaseId, retiringAttempt.attemptId).then(() => {
        retiringPeer.close(); heldPeers.delete(retiringPeer);
      }).catch(() => { /* Keep the socket allocated until trusted Main cleanup succeeds. */ });
    }
  }
}

function retireNativeStream(value: MediaStream): void {
  const capture = native;
  if (capture?.stream !== value) return;
  capture.stop();
  if (native === capture) native = undefined;
}

ipcRenderer.on(CHANNELS.command, (_event: IpcRendererEvent, raw: unknown) => {
  const command = raw as DesktopRemoteDesktopCaptureCommand;
  if (command?.op === "preparePortal") {
    portal.prepare(command.leaseId);
    return;
  }
  if (command?.op === "frame") {
    let reply: DesktopRemoteDesktopCaptureReply;
    try { reply = { kind: "frame", frame: portal.frame(command.leaseId) }; }
    catch (error) { reply = { kind: "error", code: error instanceof Error && error.message === "stopped" ? "stopped" : "unavailable" }; }
    void ipcRenderer.invoke(CHANNELS.reply, command.id, reply).catch(() => undefined);
    return;
  }
  if (command?.op === "stop") {
    stop(false);
    for (const retiring of heldPeers) retiring.close(); heldPeers.clear();
    return;
  }
  if (command?.op === "quiesce") {
    stop(false);
    return;
  }
  if (command?.op === "ice") {
    void exchangeIce(command);
    return;
  }
  if (command?.op === "presentation") {
    setPresentation(command);
    return;
  }
  if (command?.op === "nativeSource") {
    void replaceNativeSource(command);
    return;
  }
  if (command?.op === "nativeAudio") {
    if (attempt?.leaseId !== command.leaseId || attempt.attemptId !== command.attemptId
      || !Number.isSafeInteger(command.audioRevision) || command.audioRevision < 1
      || typeof command.enabled !== "boolean" || (audioDesired !== undefined && command.audioRevision < audioDesired.revision)) return;
    audioDesired = { revision: command.audioRevision, enabled: command.enabled };
    resetAudio?.();
    return;
  }
  if (command?.op === "captureReset") {
    if (attempt?.leaseId !== command.leaseId || attempt.attemptId !== command.attemptId
      || !Number.isSafeInteger(command.sourceRevision) || command.sourceRevision < sourceRevision
      || typeof command.resume !== "boolean") return;
    nativeGeneration += 1;
    for (const track of stream?.getVideoTracks() ?? []) { track.onended = null; track.onmute = null; }
    native?.stop(); native = undefined; latestCursor = null;
    if (!command.resume) { sourceRevision = command.sourceRevision; return; }
    const current = generation;
    void switchNativeSource?.(command.sourceRevision).catch(() => {
      if (current === generation) latestCursor = null;
    });
    return;
  }
  if (command?.op !== "offer") return;
  void createAnswer(command);
});

async function createAnswer(command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "offer" }>): Promise<void> {
  stop();
  const current = generation;
  attempt = { leaseId: command.leaseId, attemptId: command.attemptId };
  try {
    if (!Number.isSafeInteger(command.sourceRevision) || command.sourceRevision < 0) throw new Error("unavailable");
    sourceRevision = command.sourceRevision;
    const settings = videoSettings(command.settings);
    if (command.nativeAudio !== undefined && (command.nativeAudio !== true || !settings.audio
      || !command.nativeCapture || command.portalCapture || command.chromiumCapture
      || !Number.isSafeInteger(command.audioRevision) || command.audioRevision! < 1)) throw new Error("unavailable");
    if (command.nativeAudio === true) audioDesired = { revision: command.audioRevision!, enabled: true };
    const profile = videoProfile(command.profile, settings.quality);
    const fps = Math.min(settings.fps, profile.maxFramerate) as 30 | 60;
    let captureSettled: Promise<void> = Promise.resolve();
    let moving = true;
    let videoSender: RTCRtpSender | undefined;
    let preference = Promise.resolve();
    const degradation = (): "maintain-framerate" | "maintain-resolution" => (
      moving ? profile.degradation : "maintain-resolution"
    );
    const onMotion = (next: boolean): void => {
      moving = next;
      preference = preference.then(async () => {
        const sender = videoSender;
        if (sender === undefined || current !== generation) return;
        const parameters = sender.getParameters();
        if (parameters.encodings.length === 0
          || parameters.degradationPreference === degradation()) return;
        parameters.degradationPreference = degradation();
        await sender.setParameters(parameters);
      }).catch(() => undefined);
    };
    const capture = (): Promise<MediaStream> => navigator.mediaDevices.getDisplayMedia({
      audio: settings.audio,
      video: { frameRate: { ideal: fps, max: fps } }
    });
    const boundedCapture = async (): Promise<MediaStream> => {
      if (!command.chromiumCapture) throw new Error("unavailable");
      let abandoned = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = capture().then((value) => {
          if (abandoned || current !== generation) {
            value.getTracks().forEach((track) => track.stop());
            throw new Error("stopped");
          }
          return value;
        });
        // A timeout cannot dismiss an OS permission prompt. Wait for its actual
        // settlement before asking again, and discard a late abandoned stream.
        captureSettled = pending.then(() => undefined, () => undefined);
        return await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              abandoned = true;
              reject(new Error("timeout"));
            }, command.nativeCapture ? 2_000 : 10_000);
          })
        ]);
      } finally {
        clearTimeout(timeout);
      }
    };
    const captureNative = async (): Promise<MediaStream> => {
      const revision = sourceRevision;
      const occurrence = ++nativeGeneration;
      const alive = (): boolean => current === generation && occurrence === nativeGeneration && revision === sourceRevision;
      const result = await nativeCaptureStream(
        () => ipcRenderer.invoke(
          CHANNELS.nativeFrame,
          command.leaseId,
          command.attemptId,
          revision
        ) as Promise<DesktopRemoteDesktopCaptureNativeFrame | null>,
        alive,
        () => {
          if (!alive()) return;
          stop();
        },
        (cursor) => { if (current === generation) latestCursor = cursor; },
        command.cursorOverlay ? fps : 15,
        profile.maxFrameBytes,
        profile.sharpWhenStill ? onMotion : undefined
      );
      if (!alive()) {
        result.stop();
        throw new Error("stopped");
      }
      native = result;
      return result.stream;
    };
    let captured: MediaStream;
    if (command.portalCapture) {
      captured = await portal.capture(command.leaseId);
    } else if (command.nativeVideo) {
      // Chromium exposes no reliable cursor exclusion constraint in this
      // runtime. Native video is always cursor-free; a Chromium stream, when
      // requested, contributes only its loopback audio track.
      let audioSource: MediaStream | undefined;
      try {
        if (settings.audio && command.nativeAudio !== true) {
          try { audioSource = await boundedCapture(); }
          catch (error) { if (current !== generation) throw error; }
        }
        captured = await captureNative();
        if (current !== generation) throw new Error("stopped");
        for (const track of audioSource?.getAudioTracks() ?? []) captured.addTrack(track);
        audioSource?.getVideoTracks().forEach((track) => track.stop());
      } catch (error) {
        audioSource?.getTracks().forEach((track) => track.stop());
        throw error;
      }
    } else {
      try {
        captured = await boundedCapture();
      } catch (error) {
        if (!command.nativeCapture || current !== generation) throw error;
        captured = await captureNative();
      }
    }
    if (current !== generation) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    if (captured.getVideoTracks().length === 0) {
      captured.getTracks().forEach((track) => track.stop());
      throw new Error("unavailable");
    }
    if (!settings.audio) {
      captured.getAudioTracks().forEach((track) => {
        captured.removeTrack(track);
        track.stop();
      });
    }
    stream = captured;
    if (command.iceExpiresAt !== undefined && (!Number.isSafeInteger(command.iceExpiresAt)
      || command.iceExpiresAt <= Date.now() + 120_000 || command.iceExpiresAt > Date.now() + 86_400_000)) {
      throw new Error("unavailable");
    }
    const rtc = new RTCPeerConnection({ iceServers: command.iceServers.map(server => ({ urls: [...server.urls],
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }) })) });
    peer = rtc;
    rtc.onicecandidate = ({ candidate }) => {
      if (current !== generation || candidate?.candidate === undefined || candidate.candidate.length === 0) return;
      if (candidates.length >= 128) {
        stop();
        return;
      }
      candidates.push(Object.freeze({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        ...(candidate.usernameFragment === null ? {} : { usernameFragment: candidate.usernameFragment })
      }));
    };
    rtc.onconnectionstatechange = () => {
      if (current !== generation) return;
      if (rtc.connectionState === "failed" || rtc.connectionState === "closed") {
        stop();
        return;
      }
      if (rtc.connectionState === "disconnected") {
        disconnectedTimer ??= setTimeout(() => {
          if (current === generation && rtc.connectionState === "disconnected") stop();
        }, 5_000);
      } else {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = undefined;
      }
    };
    let recovering = false;
    recoverCapture = () => {
      if (!command.nativeCapture || native !== undefined || recovering || current !== generation) return;
      recovering = true;
      void (async () => {
        const replacement = await captureNative();
        const sender = rtc.getSenders().find((candidate) => candidate.track?.kind === "video");
        const track = replacement.getVideoTracks()[0];
        if (sender === undefined || track === undefined || current !== generation) {
          throw new Error("stopped");
        }
        track.contentHint = profile.contentHint;
        await sender.replaceTrack(track);
        captured.getVideoTracks().forEach((oldTrack) => {
          oldTrack.onended = null;
          oldTrack.onmute = null;
          oldTrack.stop();
          captured.removeTrack(oldTrack);
        });
        captured.addTrack(track);
      })().catch(() => {
        if (current === generation) {
          stop();
        }
      }).finally(() => {
        if (current === generation) recovering = false;
      });
    };
    switchNativeSource = async (revision) => {
      if (!command.nativeCapture || current !== generation || peer !== rtc
        || revision < sourceRevision) throw new Error("stopped");
      sourceRevision = revision;
      const oldNative = native;
      native = undefined;
      const previousTracks = captured.getVideoTracks();
      const previousHandlers = previousTracks.map(track => ({ track, ended: track.onended, muted: track.onmute }));
      for (const oldTrack of previousTracks) {
        oldTrack.onended = null;
        oldTrack.onmute = null;
      }
      oldNative?.stop();
      let replacement: MediaStream | undefined;
      try { replacement = await captureNative(); }
      catch (error) {
        if (current === generation) for (const item of previousHandlers) { item.track.onended = item.ended; item.track.onmute = item.muted; }
        throw error;
      }
      const track = replacement.getVideoTracks()[0];
      const sender = rtc.getSenders().find(candidate => candidate.track?.kind === "video");
      if (sender === undefined || track === undefined || current !== generation || sourceRevision !== revision) {
        retireNativeStream(replacement);
        replacement.getTracks().forEach(item => item.stop());
        throw new Error("stopped");
      }
      try {
        track.contentHint = profile.contentHint;
        await sender.replaceTrack(track);
        if (current !== generation || sourceRevision !== revision) throw new Error("stopped");
        for (const oldTrack of previousTracks) {
          captured.removeTrack(oldTrack);
          oldTrack.stop();
        }
        captured.addTrack(track);
      } catch (error) {
        retireNativeStream(replacement);
        replacement.getTracks().forEach(item => item.stop());
        if (current === generation) for (const item of previousHandlers) { item.track.onended = item.ended; item.track.onmute = item.muted; }
        throw error;
      }
    };
    rtc.ondatachannel = ({ channel }) => {
      if (channel.label !== "input-v1" || channel.ordered !== true) {
        channel.close();
        return;
      }
      inputChannel = channel;
      if (command.cursorOverlay) {
        let previous = "";
        cursorTimer = setInterval(() => {
          if (latestCursor === undefined || current !== generation
            || channel.readyState !== "open" || channel.bufferedAmount > 65_536) return;
          const message = JSON.stringify({ type: "cursor", cursor: latestCursor });
          if (message === previous) return;
          try {
            channel.send(message);
            previous = message;
          } catch { channel.close(); }
        }, 50);
      }
      let pending = 0;
      let pendingRequests = 0;
      let releasing = false;
      channel.onmessage = ({ data }) => {
        if (channel.readyState !== "open") return;
        if (current !== generation || typeof data !== "string" || data.length > 32_768) {
          channel.close();
          return;
        }
        if (presentationChallenge !== undefined && data === presentationChallenge) {
          presentationChallenge = undefined;
          const currentAttempt = attempt;
          if (presentationLease === command.leaseId
            && currentAttempt?.leaseId === command.leaseId
            && currentAttempt.attemptId === command.attemptId) {
            void ipcRenderer.invoke(
              CHANNELS.presentationPong,
              command.leaseId,
              command.attemptId
            ).catch(() => undefined);
          }
          return;
        }
        // A pong already in flight when presentation ends has no authority and
        // must not tear down the input channel after its challenge is retired.
        if (presentationChallenge === undefined && UUID.test(data)) return;
        try {
          const request: unknown = JSON.parse(data);
          if (record(request) && request["type"] === "request" && typeof request["id"] === "string"
            && /^[A-Za-z0-9_-]{1,64}$/u.test(request["id"])) {
            const reply = (value: unknown): void => {
              if (current !== generation || channel.readyState !== "open") return;
              const wire = JSON.stringify(value);
              if (new TextEncoder().encode(wire).byteLength <= 32_768 && channel.bufferedAmount <= 65_536) channel.send(wire);
            };
            if (pendingRequests >= 8) { reply({ type: "reply", id: request["id"], ok: false, error: "REMOTE_DESKTOP_BUSY" }); return; }
            pendingRequests += 1;
            void ipcRenderer.invoke(CHANNELS.request, command.leaseId, command.attemptId, request).then(reply,
              () => reply({ type: "reply", id: request["id"], ok: false, error: "REMOTE_DESKTOP_REQUEST_FAILED" }))
              .finally(() => { pendingRequests -= 1; });
            return;
          }
        } catch { /* Ordinary input validation owns malformed batches. */ }
        try {
          const value: unknown = JSON.parse(data);
          if (!record(value) || !exactKeys(value, ["sequence", "events"])
            || !Number.isSafeInteger(value["sequence"]) || (value["sequence"] as number) < 1
            || !Array.isArray(value["events"]) || value["events"].length < 1
            || value["events"].length > 64 || !value["events"].every(validInput)) {
            throw new Error("invalid");
          }
          if (releasing) return;
          if (pending >= 8) {
            releasing = true;
            void ipcRenderer.invoke(CHANNELS.input, command.leaseId, value["sequence"], [{ kind: "release" }])
              .catch(() => { channel.close(); }).finally(() => { releasing = false; });
            return;
          }
          pending += 1;
          void ipcRenderer.invoke(
            CHANNELS.input,
            command.leaseId,
            value["sequence"],
            value["events"]
          ).catch(() => { channel.close(); }).finally(() => { pending -= 1; });
        } catch {
          channel.close();
        }
      };
    };
    captured.getTracks().forEach((track) => {
      track.onended = () => {
        if (current === generation) {
          if (track.kind === "audio" && command.nativeAudio === true) {
            audio?.stop(); audio = undefined;
            return;
          }
          if (track.kind === "video" && native === undefined && command.nativeCapture) {
            recoverCapture?.();
          } else {
            stop();
          }
        }
      };
      if (track.kind === "video") track.onmute = () => recoverCapture?.();
      if (track.kind === "video") track.contentHint = profile.contentHint;
      rtc.addTrack(track, captured);
    });
    await rtc.setRemoteDescription({ type: "offer", sdp: command.offerSdp });
    const audioTransceiver = settings.audio && captured.getAudioTracks().length === 0
      ? rtc.getTransceivers().find(value => value.receiver.track.kind === "audio") : undefined;
    const audioSender = audioTransceiver?.sender ?? rtc.getSenders().find(value => value.track?.kind === "audio");
    if (audioTransceiver !== undefined && audioSender !== undefined) {
      audioTransceiver.direction = "sendonly";
      audioSender.setStreams(captured);
    }
    if (command.nativeAudio === true) {
      const sender = audioSender;
      if (sender !== undefined) {
        let revision = 0;
        resetAudio = () => {
          const occurrence = ++revision;
          audioAbort?.abort(); audio?.stop(); audio = undefined;
          const controller = new AbortController(); audioAbort = controller;
          const desired = audioDesired;
          const valid = (): boolean => current === generation && occurrence === revision && !controller.signal.aborted
            && desired === audioDesired && peer === rtc;
          if (desired?.enabled !== true) {
            void sender.replaceTrack(null).catch(() => undefined);
            captured.getAudioTracks().forEach(track => { track.onended = null; captured.removeTrack(track); track.stop(); });
            return;
          }
          void (async () => {
            let replacement: Awaited<ReturnType<typeof nativeAudioStream>> | undefined;
            try {
              replacement = await nativeAudioStream(() => ipcRenderer.invoke(CHANNELS.nativeAudio,
                command.leaseId, command.attemptId, desired.revision) as Promise<Uint8Array>, valid, controller.signal);
              if (!valid()) return;
              await sender.replaceTrack(replacement.track);
              if (!valid()) return;
              captured.getAudioTracks().forEach(track => { track.onended = null; captured.removeTrack(track); track.stop(); });
              captured.addTrack(replacement.track);
              const installed = replacement;
              installed.track.onended = () => { if (valid() && audio === installed) { installed.stop(); audio = undefined; } };
              audio = installed; replacement = undefined;
            } catch { /* Optional audio leaves the video peer and input channel alive. */ }
            finally { replacement?.stop(); }
          })();
        };
        resetAudio();
      }
    }
    await rtc.setLocalDescription(await rtc.createAnswer());
    if (current !== generation) return;
    for (const sender of rtc.getSenders()) {
      if (sender.track?.kind !== "video" || command.settings === undefined) continue;
      const parameters = sender.getParameters();
      if (parameters.encodings.length === 0) continue;
      parameters.degradationPreference = degradation();
      videoSender = sender;
      for (const encoding of parameters.encodings) {
        encoding.maxFramerate = fps;
        encoding.maxBitrate = profile.maxBitrate;
      }
      await sender.setParameters(parameters);
    }
    if (current !== generation) return;
    const answerSdp = rtc.localDescription?.sdp;
    if (typeof answerSdp !== "string" || answerSdp.length === 0) throw new Error("unavailable");
    await reply(command.id, { kind: "offer", answerSdp });
    const retryAudio = async (retry: number): Promise<void> => {
      await captureSettled;
      if (audioSender === undefined || current !== generation || peer !== rtc || retry >= AUDIO_RETRY_MS.length) return;
      audioRetryTimer = setTimeout(() => {
        audioRetryTimer = undefined;
        void (async () => {
          let replacement: MediaStream | undefined;
          let retained: MediaStreamTrack | undefined;
          try {
            if (current !== generation || peer !== rtc) return;
            replacement = await boundedCapture();
            const track = replacement.getAudioTracks()[0];
            if (track === undefined || current !== generation || peer !== rtc) return;
            await audioSender.replaceTrack(track);
            if (current !== generation || peer !== rtc) return;
            captured.addTrack(track);
            retained = track;
          } catch { /* Optional audio preserves the established video and data channel. */ }
          finally {
            replacement?.getTracks().forEach(track => { if (track !== retained) track.stop(); });
            if (retained === undefined) void retryAudio(retry + 1);
          }
        })();
      }, AUDIO_RETRY_MS[retry]);
    };
    if (audioTransceiver !== undefined && command.nativeAudio !== true) void retryAudio(0);
  } catch (error) {
    if (current !== generation) return;
    const code = error instanceof Error && error.message === "audio-unavailable"
      ? "audio-unavailable"
      : "unavailable";
    stop();
    await reply(command.id, { kind: "error", code }).catch(() => undefined);
  }
}

async function replaceNativeSource(
  command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "nativeSource" }>
): Promise<void> {
  const current = generation;
  try {
    if (attempt?.leaseId !== command.leaseId || attempt.attemptId !== command.attemptId
      || !Number.isSafeInteger(command.sourceRevision) || command.sourceRevision < sourceRevision
      || switchNativeSource === undefined) throw new Error("stopped");
    await switchNativeSource(command.sourceRevision);
    if (current !== generation || sourceRevision !== command.sourceRevision) throw new Error("stopped");
    await reply(command.id, { kind: "nativeSource", sourceRevision: command.sourceRevision });
  } catch {
    await reply(command.id, { kind: "error", code: "unavailable" }).catch(() => undefined);
  }
}

function setPresentation(
  command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "presentation" }>
): void {
  if (attempt?.leaseId !== command.leaseId) return;
  clearInterval(presentationTimer);
  presentationTimer = undefined;
  presentationChallenge = undefined;
  presentationLease = command.enabled ? command.leaseId : undefined;
  if (!command.enabled) return;
  const current = generation;
  presentationTimer = setInterval(() => {
    const channel = inputChannel;
    if (current !== generation || presentationLease !== command.leaseId
      || channel?.readyState !== "open" || presentationChallenge !== undefined) {
      return;
    }
    presentationChallenge = crypto.randomUUID();
    try {
      channel.send(JSON.stringify({ type: "viewPing", challenge: presentationChallenge }));
    } catch {
      presentationChallenge = undefined;
    }
  }, 2_000);
}

async function exchangeIce(command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "ice" }>): Promise<void> {
  const rtc = peer;
  const current = generation;
  if (exchanging) {
    await reply(command.id, { kind: "error", code: "stopped" }).catch(() => undefined);
    return;
  }
  exchanging = true;
  try {
    if (rtc === undefined || attempt?.leaseId !== command.leaseId
      || attempt.attemptId !== command.attemptId || !Number.isSafeInteger(command.after)
      || command.after < 0 || command.after > candidates.length || command.candidates.length > 16) {
      throw new Error("stopped");
    }
    for (const candidate of command.candidates) {
      if (current !== generation || !validCandidate(candidate)) throw new Error("stopped");
      const key = JSON.stringify(candidate);
      if (remoteCandidates.has(key)) continue;
      if (remoteCandidates.size >= 128) throw new Error("stopped");
      await rtc.addIceCandidate(candidate);
      remoteCandidates.add(key);
    }
    if (current !== generation) throw new Error("stopped");
    const nextCandidates = candidates.slice(command.after, command.after + 16);
    await reply(command.id, {
      kind: "ice",
      attemptId: command.attemptId,
      candidates: nextCandidates,
      next: command.after + nextCandidates.length,
      complete: rtc.iceGatheringState === "complete"
        && command.after + nextCandidates.length === candidates.length
    });
  } catch {
    await reply(command.id, { kind: "error", code: "stopped" }).catch(() => undefined);
  } finally {
    if (current === generation) exchanging = false;
  }
}

function reply(id: string, value: DesktopRemoteDesktopCaptureReply): Promise<void> {
  return ipcRenderer.invoke(CHANNELS.reply, id, value).then(() => undefined);
}

function validCandidate(value: RemoteDesktopIceCandidate): boolean {
  return record(value) && typeof value.candidate === "string"
    && value.candidate.startsWith("candidate:") && value.candidate.length <= 2_048
    && (value.sdpMid === null || typeof value.sdpMid === "string")
    && (value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex));
}

function videoSettings(value: unknown): {
  readonly fps: 30 | 60;
  readonly quality: "auto" | "saver" | "hd";
  readonly audio: boolean;
} {
  if (value === undefined) return Object.freeze({ fps: 30, quality: "auto", audio: false });
  if (!record(value) || !exactKeys(value, ["fps", "quality", "audio"])
    || (value["fps"] !== 30 && value["fps"] !== 60)
    || (value["quality"] !== "auto" && value["quality"] !== "saver"
      && value["quality"] !== "hd")
    || typeof value["audio"] !== "boolean") {
    throw new Error("unavailable");
  }
  return Object.freeze({
    fps: value["fps"],
    quality: value["quality"],
    audio: value["audio"]
  });
}

interface CaptureVideoProfile {
  readonly maxBitrate: number;
  readonly minBitrateKbps: number;
  readonly startBitrateKbps: number;
  readonly maxFramerate: 30 | 60;
  readonly degradation: "maintain-framerate" | "maintain-resolution";
  readonly sharpWhenStill: boolean;
  readonly contentHint: "" | "text";
  readonly jpegQuality: number;
  readonly physicalMaxEdge: number;
  readonly maxFrameBytes: number;
}

function videoProfile(
  value: unknown,
  quality: "auto" | "saver" | "hd"
): CaptureVideoProfile {
  const expected: CaptureVideoProfile = quality === "saver"
    ? {
        maxBitrate: 2_000_000, minBitrateKbps: 500, startBitrateKbps: 1_500,
        maxFramerate: 30, degradation: "maintain-framerate", sharpWhenStill: true,
        contentHint: "", jpegQuality: 0.65, physicalMaxEdge: 0, maxFrameBytes: 1_000_000
      }
    : quality === "hd"
      ? {
          maxBitrate: 20_000_000, minBitrateKbps: 1_000, startBitrateKbps: 4_000,
          maxFramerate: 60, degradation: "maintain-resolution", sharpWhenStill: false,
          contentHint: "text", jpegQuality: 0.9, physicalMaxEdge: 3_840,
          maxFrameBytes: 3_000_000
        }
      : {
          maxBitrate: 20_000_000, minBitrateKbps: 1_000, startBitrateKbps: 4_000,
          maxFramerate: 60, degradation: "maintain-framerate", sharpWhenStill: true,
          contentHint: "", jpegQuality: 0.8, physicalMaxEdge: 2_560,
          maxFrameBytes: 1_500_000
        };
  if (!record(value) || !exactKeys(value, [
    "maxBitrate", "minBitrateKbps", "startBitrateKbps", "maxFramerate", "degradation",
    "sharpWhenStill", "contentHint", "jpegQuality", "physicalMaxEdge", "maxFrameBytes"
  ]) || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new Error("unavailable");
  }
  return Object.freeze(expected);
}

/** Serial native pulls and image decode to keep IPC and canvas memory bounded. */
async function nativeCaptureStream(
  read: () => Promise<DesktopRemoteDesktopCaptureNativeFrame | null>,
  alive: () => boolean,
  failed: () => void,
  cursor: (value: DesktopRemoteDesktopCursor | null) => void,
  fps: number,
  maxFrameBytes: number,
  onMotion?: (moving: boolean) => void
): Promise<{ readonly stream: MediaStream; stop(): void }> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("unavailable");
  const thumbnail = onMotion === undefined ? undefined : document.createElement("canvas");
  const thumbnailContext = thumbnail?.getContext("2d", { willReadFrequently: true });
  if (thumbnail !== undefined) {
    thumbnail.width = 64;
    thumbnail.height = 36;
  }
  let previousThumbnail: Uint8ClampedArray | undefined;
  let lastMotion = 0;
  let moving = true;
  const observeMotion = (bitmap: ImageBitmap): void => {
    if (thumbnailContext === null || thumbnailContext === undefined || onMotion === undefined) return;
    thumbnailContext.drawImage(bitmap, 0, 0, 64, 36);
    const next = thumbnailContext.getImageData(0, 0, 64, 36).data;
    const now = performance.now();
    if (previousThumbnail === undefined
      || frameChange(previousThumbnail, next) > 0.02) lastMotion = now;
    previousThumbnail = next;
    const nextMoving = now - lastMotion < 1_000;
    if (nextMoving !== moving) {
      moving = nextMoving;
      onMotion(moving);
    }
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = performance.now();
  const draw = async (): Promise<boolean> => {
    const frame = await read();
    if (frame === null || stopped || !alive()) return false;
    const parsed = nativeFrame(frame, maxFrameBytes);
    const bytes = Uint8Array.from(atob(parsed.jpeg), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      if (stopped || !alive()) return false;
      if (bitmap.width !== parsed.width || bitmap.height !== parsed.height
        || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4_096 || bitmap.height > 4_096) {
        throw new Error("unavailable");
      }
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      observeMotion(bitmap);
      cursor(parsed.cursor);
      lastFrame = performance.now();
      return true;
    } finally {
      bitmap.close();
    }
  };
  const initialDeadline = performance.now() + 3_000;
  let initialFrame = false;
  while (!initialFrame && alive() && performance.now() < initialDeadline) {
    initialFrame = await draw();
    if (!initialFrame) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!initialFrame || !alive()) throw new Error("unavailable");
  const captured = canvas.captureStream(fps);
  const stopNative = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    captured.getTracks().forEach((track) => track.stop());
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 1;
    cursor(null);
  };
  const pull = async (): Promise<void> => {
    if (stopped || !alive()) {
      stopNative();
      return;
    }
    try {
      await draw();
      if (performance.now() - lastFrame > 5_000) throw new Error("unavailable");
      if (!stopped && alive()) timer = setTimeout(() => void pull(), Math.round(1_000 / fps));
      else stopNative();
    } catch {
      stopNative();
      if (alive()) failed();
    }
  };
  timer = setTimeout(() => void pull(), Math.round(1_000 / fps));
  return Object.freeze({
    stream: captured,
    stop: stopNative
  });
}

function frameChange(previous: Uint8ClampedArray, next: Uint8ClampedArray): number {
  if (previous.length !== next.length || next.length === 0) return 1;
  let changed = 0;
  for (let index = 0; index < next.length; index += 4) {
    if (Math.abs(previous[index]! - next[index]!) > 10
      || Math.abs(previous[index + 1]! - next[index + 1]!) > 10
      || Math.abs(previous[index + 2]! - next[index + 2]!) > 10) changed += 1;
  }
  return changed / (next.length / 4);
}

function nativeFrame(value: unknown, maxFrameBytes: number): DesktopRemoteDesktopCaptureNativeFrame {
  const maxEncodedBytes = Math.ceil(maxFrameBytes / 3) * 4;
  if (!record(value) || !exactKeys(value, ["jpeg", "width", "height", "cursor"])
    || typeof value["jpeg"] !== "string" || value["jpeg"].length < 1
    || value["jpeg"].length > maxEncodedBytes || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value["jpeg"])
    || base64ByteLength(value["jpeg"]) > maxFrameBytes
    || !Number.isSafeInteger(value["width"]) || !Number.isSafeInteger(value["height"])
    || (value["width"] as number) < 1 || (value["width"] as number) > 4_096
    || (value["height"] as number) < 1 || (value["height"] as number) > 4_096
    || (value["cursor"] !== null && !cursorValue(value["cursor"]))) {
    throw new Error("unavailable");
  }
  return value as unknown as DesktopRemoteDesktopCaptureNativeFrame;
}

function base64ByteLength(value: string): number {
  if (value.length % 4 === 1) return Number.POSITIVE_INFINITY;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function cursorValue(value: unknown): value is DesktopRemoteDesktopCursor {
  if (!record(value) || !exactKeys(value,
    ["visible", "x", "y", "width", "height", "hotX", "hotY", "png"])) return false;
  return typeof value["visible"] === "boolean"
    && finiteRange(value["x"], 0, 1) && finiteRange(value["y"], 0, 1)
    && finiteRange(value["width"], Number.MIN_VALUE, 256)
    && finiteRange(value["height"], Number.MIN_VALUE, 256)
    && finiteRange(value["hotX"], 0, value["width"] as number)
    && finiteRange(value["hotY"], 0, value["height"] as number)
    && typeof value["png"] === "string"
    && validCursorPng(value["png"]);
}

function validCursorPng(value: string): boolean {
  if (value.length < 44 || value.length > 65_536 || value.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  let decoded: string;
  try { decoded = atob(value); }
  catch { return false; }
  if (decoded.length < 33 || decoded.length > 49_152) return false;
  const expectedSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  if (!expectedSignature.every((byte, index) => decoded.charCodeAt(index) === byte)
    || decoded.charCodeAt(8) !== 0 || decoded.charCodeAt(9) !== 0
    || decoded.charCodeAt(10) !== 0 || decoded.charCodeAt(11) !== 13
    || decoded.slice(12, 16) !== "IHDR") return false;
  const dimension = (offset: number): number => (
    decoded.charCodeAt(offset) * 0x1_00_00_00
    + decoded.charCodeAt(offset + 1) * 0x1_00_00
    + decoded.charCodeAt(offset + 2) * 0x1_00
    + decoded.charCodeAt(offset + 3)
  );
  const width = dimension(16);
  const height = dimension(20);
  return width >= 1 && width <= 512 && height >= 1 && height <= 512;
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

// This preload is self-contained under Electron's sandbox. Main independently
// validates the same v1 input contract before native dispatch.
const INPUT_KEYS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(key => `Key${key}`),
  ..."0123456789".split("").map(key => `Digit${key}`),
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
]);
function validInput(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value["kind"]) {
    case "release": return exactKeys(value, ["kind"]);
    case "move": return exactKeys(value, ["kind", "x", "y"])
      && finiteRange(value["x"], 0, 1) && finiteRange(value["y"], 0, 1);
    case "button": return exactKeys(value, ["kind", "button", "down", "x", "y"])
      && finiteRange(value["x"], 0, 1) && finiteRange(value["y"], 0, 1)
      && [0, 1, 2].includes(value["button"] as number) && typeof value["down"] === "boolean";
    case "scroll": return exactKeys(value, ["kind", "dx", "dy"])
      && finiteRange(value["dx"], -2_000, 2_000) && finiteRange(value["dy"], -2_000, 2_000);
    case "key": return exactKeys(value, ["kind", "code", "down"])
      && typeof value["code"] === "string" && INPUT_KEYS.has(value["code"]) && typeof value["down"] === "boolean";
    case "text": return exactKeys(value, ["kind", "text"])
      && typeof value["text"] === "string" && value["text"].length <= 4_096;
    default: return false;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

void ipcRenderer.invoke(CHANNELS.ready).catch(() => stop());
