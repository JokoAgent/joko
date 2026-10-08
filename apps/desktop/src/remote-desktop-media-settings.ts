export const REMOTE_DESKTOP_VIDEO_FRAME_RATES = Object.freeze([30, 60] as const);
export const REMOTE_DESKTOP_VIDEO_QUALITIES = Object.freeze(["auto", "saver", "hd"] as const);

export type DesktopRemoteDesktopVideoQuality = typeof REMOTE_DESKTOP_VIDEO_QUALITIES[number];

export interface DesktopRemoteDesktopVideoSettings {
  readonly fps: 30 | 60;
  /** Viewer intent only; the host owns concrete capture and encoder parameters. */
  readonly quality: DesktopRemoteDesktopVideoQuality;
  readonly audio: boolean;
}

export function parseDesktopRemoteDesktopVideoSettings(
  value: unknown
): DesktopRemoteDesktopVideoSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Remote Desktop video settings are invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["fps", "quality", "audio"])
    || !REMOTE_DESKTOP_VIDEO_FRAME_RATES.includes(record["fps"] as 30 | 60)
    || !REMOTE_DESKTOP_VIDEO_QUALITIES.includes(
      record["quality"] as DesktopRemoteDesktopVideoQuality
    )
    || typeof record["audio"] !== "boolean") {
    throw new TypeError("Remote Desktop video settings are invalid.");
  }
  return Object.freeze({
    fps: record["fps"] as 30 | 60,
    quality: record["quality"] as DesktopRemoteDesktopVideoQuality,
    audio: record["audio"]
  });
}

export function desktopSupportsSystemAudio(
  platform: NodeJS.Platform,
  systemVersion = ""
): boolean {
  if (platform === "win32") return true;
  if (platform !== "darwin") return false;
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(systemVersion);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    && (major > 14 || (major === 14 && minor >= 2));
}

export function readDesktopSystemAudioSupport(): boolean {
  let systemVersion = "";
  if (process.platform === "darwin") {
    try {
      const getter = (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion;
      systemVersion = typeof getter === "function" ? getter.call(process) : "";
    } catch {
      systemVersion = "";
    }
  }
  return desktopSupportsSystemAudio(process.platform, systemVersion);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
