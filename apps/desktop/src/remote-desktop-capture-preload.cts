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

const CHANNELS = Object.freeze({
  ready: "joko:remote-desktop-capture:ready",
  command: "joko:remote-desktop-capture:command",
  reply: "joko:remote-desktop-capture:reply",
  input: "joko:remote-desktop-capture:input",
  nativeFrame: "joko:remote-desktop-capture:native-frame",
  presentationPong: "joko:remote-desktop-capture:presentation-pong",
  stopped: "joko:remote-desktop-capture:stopped"
});

let peer: RTCPeerConnection | undefined;
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
let recoverCapture: (() => void) | undefined;
let latestCursor: DesktopRemoteDesktopCursor | null | undefined;
let cursorTimer: ReturnType<typeof setInterval> | undefined;

function stop(): void {
  generation += 1;
  exchanging = false;
  clearTimeout(disconnectedTimer);
  clearInterval(presentationTimer);
  clearInterval(cursorTimer);
  disconnectedTimer = undefined;
  presentationTimer = undefined;
  cursorTimer = undefined;
  presentationLease = undefined;
  presentationChallenge = undefined;
  inputChannel = undefined;
  latestCursor = undefined;
  native?.stop();
  native = undefined;
  recoverCapture = undefined;
  attempt = undefined;
  candidates = [];
  remoteCandidates = new Set();
  peer?.close();
  peer = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
}

ipcRenderer.on(CHANNELS.command, (_event: IpcRendererEvent, raw: unknown) => {
  const command = raw as DesktopRemoteDesktopCaptureCommand;
  if (command?.op === "stop") {
    stop();
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
  if (command?.op !== "offer") return;
  void createAnswer(command);
});

async function createAnswer(command: Extract<DesktopRemoteDesktopCaptureCommand, { readonly op: "offer" }>): Promise<void> {
  stop();
  const current = generation;
  attempt = { leaseId: command.leaseId, attemptId: command.attemptId };
  try {
    const settings = videoSettings(command.settings);
    const capture = (): Promise<MediaStream> => navigator.mediaDevices.getDisplayMedia({
      audio: settings.audio,
      video: { frameRate: { ideal: settings.fps, max: settings.fps } }
    });
    const boundedCapture = async (): Promise<MediaStream> => {
      if (!command.chromiumCapture) throw new Error("unavailable");
      let abandoned = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          capture().then((value) => {
            if (abandoned || current !== generation) {
              value.getTracks().forEach((track) => track.stop());
              throw new Error("stopped");
            }
            return value;
          }),
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
      const result = await nativeCaptureStream(
        () => ipcRenderer.invoke(
          CHANNELS.nativeFrame,
          command.leaseId,
          command.attemptId
        ) as Promise<DesktopRemoteDesktopCaptureNativeFrame | null>,
        () => current === generation,
        () => {
          stop();
          void ipcRenderer.invoke(CHANNELS.stopped).catch(() => undefined);
        },
        (cursor) => { if (current === generation) latestCursor = cursor; },
        command.cursorOverlay ? settings.fps : 15
      );
      if (current !== generation) {
        result.stop();
        throw new Error("stopped");
      }
      native = result;
      return result.stream;
    };
    let captured: MediaStream;
    if (command.nativeVideo) {
      // Chromium exposes no reliable cursor exclusion constraint in this
      // runtime. Native video is always cursor-free; a Chromium stream, when
      // requested, contributes only its loopback audio track.
      let audioSource: MediaStream | undefined;
      try {
        if (settings.audio) {
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
    if (settings.audio && captured.getAudioTracks().length === 0) {
      captured.getTracks().forEach((track) => track.stop());
      throw new Error("audio-unavailable");
    }
    if (!settings.audio) {
      captured.getAudioTracks().forEach((track) => {
        captured.removeTrack(track);
        track.stop();
      });
    }
    stream = captured;
    const rtc = new RTCPeerConnection({ iceServers: [...command.iceServers] });
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
        await sender.replaceTrack(track);
        captured.getVideoTracks().forEach((oldTrack) => {
          oldTrack.onended = null;
          oldTrack.onmute = null;
          oldTrack.stop();
        });
      })().catch(() => {
        if (current === generation) {
          stop();
          void ipcRenderer.invoke(CHANNELS.stopped).catch(() => undefined);
        }
      }).finally(() => {
        if (current === generation) recovering = false;
      });
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
      channel.onmessage = ({ data }) => {
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
        if (pending >= 8) {
          channel.close();
          return;
        }
        try {
          const value: unknown = JSON.parse(data);
          if (!record(value) || !exactKeys(value, ["sequence", "events"])
            || !Number.isSafeInteger(value["sequence"]) || (value["sequence"] as number) < 1
            || !Array.isArray(value["events"]) || value["events"].length < 1
            || value["events"].length > 64) {
            throw new Error("invalid");
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
          if (track.kind === "video" && native === undefined && command.nativeCapture) {
            recoverCapture?.();
          } else {
            stop();
            void ipcRenderer.invoke(CHANNELS.stopped).catch(() => undefined);
          }
        }
      };
      if (track.kind === "video") track.onmute = () => recoverCapture?.();
      rtc.addTrack(track, captured);
    });
    await rtc.setRemoteDescription({ type: "offer", sdp: command.offerSdp });
    await rtc.setLocalDescription(await rtc.createAnswer());
    if (current !== generation) return;
    for (const sender of rtc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const parameters = sender.getParameters();
      if (parameters.encodings.length === 0) continue;
      for (const encoding of parameters.encodings) {
        encoding.maxFramerate = settings.fps;
        if (settings.bitrate === 0) delete encoding.maxBitrate;
        else encoding.maxBitrate = settings.bitrate;
      }
      await sender.setParameters(parameters);
    }
    if (current !== generation) return;
    const answerSdp = rtc.localDescription?.sdp;
    if (typeof answerSdp !== "string" || answerSdp.length === 0) throw new Error("unavailable");
    await reply(command.id, { kind: "offer", answerSdp });
  } catch (error) {
    if (current !== generation) return;
    const code = error instanceof Error && error.message === "audio-unavailable"
      ? "audio-unavailable"
      : "unavailable";
    stop();
    await reply(command.id, { kind: "error", code }).catch(() => undefined);
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
  readonly bitrate: 0 | 2_000_000 | 8_000_000 | 20_000_000;
  readonly audio: boolean;
} {
  if (value === undefined) return Object.freeze({ fps: 30, bitrate: 0, audio: false });
  if (!record(value) || !exactKeys(value, ["fps", "bitrate", "audio"])
    || (value["fps"] !== 30 && value["fps"] !== 60)
    || (value["bitrate"] !== 0 && value["bitrate"] !== 2_000_000
      && value["bitrate"] !== 8_000_000 && value["bitrate"] !== 20_000_000)
    || typeof value["audio"] !== "boolean") {
    throw new Error("unavailable");
  }
  return Object.freeze({
    fps: value["fps"],
    bitrate: value["bitrate"],
    audio: value["audio"]
  });
}

/** Serial native pulls and image decode to keep IPC and canvas memory bounded. */
async function nativeCaptureStream(
  read: () => Promise<DesktopRemoteDesktopCaptureNativeFrame | null>,
  alive: () => boolean,
  failed: () => void,
  cursor: (value: DesktopRemoteDesktopCursor | null) => void,
  fps: number
): Promise<{ readonly stream: MediaStream; stop(): void }> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("unavailable");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFrame = performance.now();
  const draw = async (): Promise<boolean> => {
    const frame = await read();
    if (frame === null || stopped || !alive()) return false;
    const parsed = nativeFrame(frame);
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
      cursor(parsed.cursor);
      lastFrame = performance.now();
      return true;
    } finally {
      bitmap.close();
    }
  };
  if (!(await draw())) throw new Error("unavailable");
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

function nativeFrame(value: unknown): DesktopRemoteDesktopCaptureNativeFrame {
  if (!record(value) || !exactKeys(value, ["jpeg", "width", "height", "cursor"])
    || typeof value["jpeg"] !== "string" || value["jpeg"].length < 1
    || value["jpeg"].length > 1_333_336 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value["jpeg"])
    || !Number.isSafeInteger(value["width"]) || !Number.isSafeInteger(value["height"])
    || (value["width"] as number) < 1 || (value["width"] as number) > 4_096
    || (value["height"] as number) < 1 || (value["height"] as number) > 4_096
    || (value["cursor"] !== null && !cursorValue(value["cursor"]))) {
    throw new Error("unavailable");
  }
  return value as unknown as DesktopRemoteDesktopCaptureNativeFrame;
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
