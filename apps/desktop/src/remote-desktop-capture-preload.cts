/// <reference lib="dom" />

import type {
  DesktopRemoteDesktopCaptureCommand,
  DesktopRemoteDesktopCaptureReply
} from "./remote-desktop-capture-protocol.js";
import type { RemoteDesktopIceCandidate } from "@joko/device-peer";
import type { IpcRendererEvent } from "electron";

const { ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  ready: "joko:remote-desktop-capture:ready",
  command: "joko:remote-desktop-capture:command",
  reply: "joko:remote-desktop-capture:reply",
  input: "joko:remote-desktop-capture:input",
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

function stop(): void {
  generation += 1;
  exchanging = false;
  clearTimeout(disconnectedTimer);
  clearInterval(presentationTimer);
  disconnectedTimer = undefined;
  presentationTimer = undefined;
  presentationLease = undefined;
  presentationChallenge = undefined;
  inputChannel = undefined;
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
    const captured = await navigator.mediaDevices.getDisplayMedia({
      audio: settings.audio,
      video: { frameRate: { ideal: settings.fps, max: settings.fps } }
    });
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
    rtc.ondatachannel = ({ channel }) => {
      if (channel.label !== "input-v1" || channel.ordered !== true) {
        channel.close();
        return;
      }
      inputChannel = channel;
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
          stop();
          void ipcRenderer.invoke(CHANNELS.stopped).catch(() => undefined);
        }
      };
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
