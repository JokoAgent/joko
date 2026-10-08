import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";

/** Host-owned meaning of each viewer quality tier. */
export interface DesktopRemoteDesktopVideoProfile {
  /** WebRTC sender ceiling; congestion control chooses the actual rate below it. */
  readonly maxBitrate: number;
  /** Bandwidth-estimate floor and starting point, in kbps. */
  readonly minBitrateKbps: number;
  readonly startBitrateKbps: number;
  readonly maxFramerate: 30 | 60;
  readonly degradation: "maintain-framerate" | "maintain-resolution";
  readonly sharpWhenStill: boolean;
  readonly contentHint: "" | "text";
  readonly jpegQuality: number;
  /** macOS physical-pixel long-edge target; zero keeps logical pixels. */
  readonly physicalMaxEdge: number;
  /** Largest native JPEG frame before helper quality/scale fallback. */
  readonly maxFrameBytes: number;
}

const PROFILES: Readonly<Record<
  DesktopRemoteDesktopVideoSettings["quality"],
  DesktopRemoteDesktopVideoProfile
>> = Object.freeze({
  auto: Object.freeze({
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    maxFramerate: 60,
    degradation: "maintain-framerate",
    sharpWhenStill: true,
    contentHint: "",
    jpegQuality: 0.8,
    physicalMaxEdge: 2_560,
    maxFrameBytes: 1_500_000
  }),
  saver: Object.freeze({
    maxBitrate: 2_000_000,
    minBitrateKbps: 500,
    startBitrateKbps: 1_500,
    maxFramerate: 30,
    degradation: "maintain-framerate",
    sharpWhenStill: true,
    contentHint: "",
    jpegQuality: 0.65,
    physicalMaxEdge: 0,
    maxFrameBytes: 1_000_000
  }),
  hd: Object.freeze({
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    maxFramerate: 60,
    degradation: "maintain-resolution",
    sharpWhenStill: false,
    contentHint: "text",
    jpegQuality: 0.9,
    physicalMaxEdge: 3_840,
    maxFrameBytes: 3_000_000
  })
});

export function desktopRemoteDesktopVideoProfile(
  settings?: DesktopRemoteDesktopVideoSettings
): DesktopRemoteDesktopVideoProfile {
  return PROFILES[settings?.quality ?? "auto"];
}

export function desktopRemoteDesktopVideoFramerate(
  settings?: DesktopRemoteDesktopVideoSettings
): 30 | 60 {
  return Math.min(
    settings?.fps ?? 30,
    desktopRemoteDesktopVideoProfile(settings).maxFramerate
  ) as 30 | 60;
}

const BITRATE_HINTS = Object.freeze([
  "x-google-start-bitrate",
  "x-google-min-bitrate",
  "x-google-max-bitrate"
]);
const MEDIA_CODECS = /^(H264|VP8|VP9|AV1|H265)$/iu;

/** Adds host-owned bandwidth-estimate hints to video media codecs only. */
export function withDesktopRemoteDesktopBitrateHints(
  sdp: string,
  profile: DesktopRemoteDesktopVideoProfile
): string {
  const hints = `x-google-start-bitrate=${profile.startBitrateKbps};`
    + `x-google-min-bitrate=${profile.minBitrateKbps};`
    + `x-google-max-bitrate=${Math.round(profile.maxBitrate / 1_000)}`;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const trailing = lines.at(-1) === "" ? lines.pop() : undefined;
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith("m=")) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  const output = sections.flatMap((section) => {
    if (!section[0]?.startsWith("m=video")) return section;
    const media = new Set<string>();
    for (const line of section) {
      const mapping = /^a=rtpmap:(\d+) ([^/]+)\//u.exec(line);
      if (mapping !== null && MEDIA_CODECS.test(mapping[2]!)) media.add(mapping[1]!);
    }
    const missing = new Set(media);
    const rewritten = section.map((line) => {
      const parameters = /^a=fmtp:(\d+) (.*)$/u.exec(line);
      if (parameters === null || !media.has(parameters[1]!)) return line;
      missing.delete(parameters[1]!);
      const kept = parameters[2]!.split(";").filter((parameter) => {
        if (parameter.length === 0) return false;
        return !BITRATE_HINTS.includes(parameter.split("=")[0]!.trim());
      });
      return `a=fmtp:${parameters[1]} ${[...kept, hints].join(";")}`;
    });
    return [...rewritten, ...[...missing].map((payload) => `a=fmtp:${payload} ${hints}`)];
  });
  if (trailing !== undefined) output.push(trailing);
  return output.join(eol);
}

/** Share of pixels that changed between equally sized RGBA thumbnails. */
export function desktopRemoteDesktopFrameChange(
  previous: Uint8ClampedArray,
  next: Uint8ClampedArray
): number {
  if (previous.length !== next.length || next.length === 0) return 1;
  let changed = 0;
  for (let index = 0; index < next.length; index += 4) {
    if (Math.abs(previous[index]! - next[index]!) > 10
      || Math.abs(previous[index + 1]! - next[index + 1]!) > 10
      || Math.abs(previous[index + 2]! - next[index + 2]!) > 10) {
      changed += 1;
    }
  }
  return changed / (next.length / 4);
}

export const REMOTE_DESKTOP_MOTION = Object.freeze({
  changedShare: 0.02,
  stillAfterMs: 1_000
});
