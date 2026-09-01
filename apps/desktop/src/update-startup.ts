import type { DesktopUpdateCheckResult, DesktopUpdateStatus } from "./channels.js";
import { compareDesktopUpdateVersions } from "./update-service.js";

export type DesktopUpdateStartupCheckResult =
  | { readonly kind: "release" }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "download-failed" };

export interface DesktopUpdateStartupService {
  readonly initialize: () => Promise<void>;
  readonly getStatus: () => DesktopUpdateStatus;
  readonly check: () => Promise<DesktopUpdateCheckResult>;
  readonly checkForExpectedVersion: (expectedVersion: string) => Promise<DesktopUpdateCheckResult>;
  readonly quarantineReady: (version: string) => Promise<boolean>;
}

export interface DesktopUpdateStartupOptions {
  readonly service: DesktopUpdateStartupService;
  readonly isPackaged: boolean;
  readonly currentVersion: string;
  readonly fetchManifestVersion: () => Promise<string | null>;
}

/** Cold-start selection: online auto-apply is allowed only
 * when the verified local installer equals the bounded latest manifest; an
 * offline manifest falls back to any verified newer local installer. */
export async function runDesktopUpdateStartupCheck(
  options: DesktopUpdateStartupOptions
): Promise<DesktopUpdateStartupCheckResult> {
  if (!options.isPackaged) return { kind: "release" };
  await options.service.initialize();
  const localReady = readyVersion(options.service.getStatus());
  const latestVersion = await options.fetchManifestVersion();
  if (latestVersion === null) {
    return localReady === undefined
      ? { kind: "release" }
      : { kind: "ready", version: localReady };
  }
  try {
    if (localReady !== undefined && localReady !== latestVersion &&
      !await options.service.quarantineReady(localReady)) return { kind: "download-failed" };
    const latestVsInstalled = compareDesktopUpdateVersions(latestVersion, options.currentVersion);
    if (latestVsInstalled === undefined) return { kind: "download-failed" };
    if (latestVsInstalled <= 0) return { kind: "release" };
    if (localReady === latestVersion) return { kind: "ready", version: localReady };

    const result = await options.service.checkForExpectedVersion(latestVersion);
    const downloaded = readyVersion(options.service.getStatus());
    if (result.status === "available" && downloaded === latestVersion) {
      return { kind: "ready", version: latestVersion };
    }
    if (downloaded !== undefined && downloaded !== latestVersion) {
      // Defensive fallback for a nonconforming driver. The service's pinned
      // candidate guard normally rejects before any wrong build is downloaded.
      await options.service.quarantineReady(downloaded);
    }
    return { kind: "download-failed" };
  } catch {
    // Once an online candidate is known, every acquisition/persistence failure
    // remains behind the retryable startup gate; it is never treated as offline.
    return { kind: "download-failed" };
  }
}

function readyVersion(status: DesktopUpdateStatus): string | undefined {
  return status.status === "ready" ? status.version : undefined;
}
