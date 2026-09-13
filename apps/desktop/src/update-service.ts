import type {
  DesktopUpdateCheckResult,
  DesktopUpdateErrorKind,
  DesktopUpdateManualDownloadReason,
  DesktopUpdateRelaunchResult,
  DesktopUpdateStatus,
  DesktopUpdateUnavailableReason
} from "./channels.js";
import { resolveDesktopUpdateFeedUrl } from "./update-feed.js";

export interface DesktopUpdateDriverCheckResult {
  readonly available: boolean;
  readonly version?: unknown;
}

export interface DesktopUpdateDriverStagedResult {
  readonly version: unknown;
  /** A verified installer kept only as superseding rollback, never for apply. */
  readonly quarantined?: true;
}

export interface DesktopUpdateDriverPromotionResult {
  readonly promoted: boolean;
  readonly previousReadyPreserved: boolean;
}

/** Raw electron-updater progress telemetry before trusted-host normalization. */
export interface DesktopUpdateDriverProgressInfo {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

/**
 * Driver-level download failure with an explicit staged-installer rollback
 * verdict. Raw updater errors remain attached only inside the trusted host.
 */
export class DesktopUpdateDownloadFailure extends Error {
  constructor(readonly previousReadyPreserved: boolean) {
    super("Desktop update download failed.");
    this.name = "DesktopUpdateDownloadFailure";
  }
}

/** A verified package from another feed could not be durably revoked. */
export class DesktopUpdateStagedRevocationFailure extends Error {
  constructor() {
    super("Desktop staged update revocation failed.");
    this.name = "DesktopUpdateStagedRevocationFailure";
  }
}

class DesktopUpdateFeedChanged extends Error {
  constructor() {
    super("Desktop update feed changed during the operation.");
    this.name = "DesktopUpdateFeedChanged";
  }
}

/** Narrow port around electron-updater so lifecycle policy stays unit-testable. */
export interface DesktopUpdateDriver {
  readonly configure: (feedUrl: string) => void;
  readonly hydrateStagedUpdate: () => Promise<DesktopUpdateDriverStagedResult | null>;
  /** Durably marks the verified staged installer as rollback-only. */
  readonly quarantineStagedUpdate: (version: string) => Promise<boolean>;
  /** Atomically promotes a provisional verified installer to apply-eligible. */
  readonly promoteStagedUpdate: (version: string) => Promise<DesktopUpdateDriverPromotionResult>;
  readonly checkForUpdates: () => Promise<DesktopUpdateDriverCheckResult | null>;
  readonly downloadUpdate: (version: string) => Promise<void>;
  /**
   * Resolves only after the platform updater confirms its update-quit handoff.
   * A platform updater error, including a deferred macOS Squirrel error, rejects.
   */
  readonly relaunchToInstall: () => Promise<void>;
  readonly onProgress: (listener: (progress: DesktopUpdateDriverProgressInfo) => void) => () => void;
  readonly onError: (listener: () => void) => () => void;
  readonly dispose?: () => void;
}

export interface DesktopUpdateServiceOptions {
  readonly driver: DesktopUpdateDriver;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly currentVersion: string;
  readonly appImagePath?: string;
  readonly feedUrl?: string;
  readonly prepareToApply: () => Promise<void>;
  readonly recoverAfterApplyFailure?: () => Promise<void>;
  readonly clock?: DesktopUpdateClock;
  readonly enableBackgroundPolling?: boolean;
  readonly firstCheckDelayMs?: number;
  readonly pollIntervalMs?: number;
}

export interface DesktopUpdateClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface DesktopUpdateService {
  /** Resolves after the verified on-disk staged installer has been hydrated. */
  readonly initialize: () => Promise<void>;
  readonly getStatus: () => DesktopUpdateStatus;
  readonly isRelaunching: () => boolean;
  /** True while hydration/reconfiguration is unresolved, including a
   * fail-closed cross-feed revocation that requires restart/retry. */
  readonly isFeedChangePending: () => boolean;
  /** Quickly accepts one channel selection, synchronously invalidates the old
   * generation, then revokes/reconfigures behind the internal check barrier.
   * A different selection is refused until that durable transition finishes. */
  readonly changeFeed: (feedUrl: string) => Promise<boolean>;
  /** Hides an online-stale installer while preserving it as physical rollback. */
  readonly quarantineReady: (version: string) => Promise<boolean>;
  /** Starts the delayed check/poll lifecycle after the cold-start gate releases. */
  readonly startBackgroundPolling: () => void;
  readonly onStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  readonly check: () => Promise<DesktopUpdateCheckResult>;
  /** Cold-start check pinned to the already fetched bounded manifest version. */
  readonly checkForExpectedVersion: (expectedVersion: string) => Promise<DesktopUpdateCheckResult>;
  readonly relaunch: () => Promise<DesktopUpdateRelaunchResult>;
  readonly dispose: () => void;
}

type UpdateAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: DesktopUpdateUnavailableReason }
  | { readonly kind: "manual-download"; readonly reason: DesktopUpdateManualDownloadReason };

const MAXIMUM_VERSION_LENGTH = 128;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
export const DESKTOP_UPDATE_PROGRESS_INTERVAL_MS = 200;
export const DESKTOP_UPDATE_FIRST_CHECK_DELAY_MS = 10_000;
export const DESKTOP_UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1_000;

export function resolveDesktopUpdateAvailability(options: Pick<
  DesktopUpdateServiceOptions,
  "isPackaged" | "platform" | "appImagePath" | "feedUrl"
>): UpdateAvailability {
  if (!options.isPackaged) return { kind: "unavailable", reason: "development" };
  if (options.feedUrl === undefined) return { kind: "unavailable", reason: "feed-unconfigured" };
  if (options.platform === "linux") {
    // Joko does not perform an in-app Linux installer handoff. Distribution
    // artifacts remain available, but every Linux host reports manual-only.
    return { kind: "manual-download", reason: "linux-manual-only" };
  }
  if (options.platform !== "win32" && options.platform !== "darwin") {
    return { kind: "manual-download", reason: "unsupported-platform" };
  }
  return { kind: "available" };
}

export function createDesktopUpdateService(options: DesktopUpdateServiceOptions): DesktopUpdateService {
  const resolvedAvailability = resolveDesktopUpdateAvailability(options);
  const availability: UpdateAvailability = options.isPackaged && isVersionlessDesktopBuild(options.currentVersion)
    ? { kind: "unavailable", reason: "versionless-build" }
    : resolvedAvailability;
  const installedVersion = normalizedVersion(options.currentVersion);
  const clock = options.clock ?? systemUpdateClock();
  const listeners = new Set<(status: DesktopUpdateStatus) => void>();
  let currentStatus = initialStatus(availability);
  let readyVersion: string | undefined;
  let readyQuarantined = false;
  let inFlightCheck: Promise<DesktopUpdateCheckResult> | undefined;
  let inFlightRelaunch: Promise<DesktopUpdateRelaunchResult> | undefined;
  let inFlightQuarantine: Promise<boolean> | undefined;
  let inFlightFeedChange: Promise<boolean> | undefined;
  let configuredFeedUrl = availability.kind === "available" ? options.feedUrl : undefined;
  let requestedFeedUrl = configuredFeedUrl;
  let feedGeneration = 0;
  let activePhase: "check" | "download" | "apply" | undefined;
  let activeDriverError: DesktopUpdateErrorKind | undefined;
  let lastProgressPublishedAt = Number.NEGATIVE_INFINITY;
  let latestProgressInfo: DesktopUpdateProgressInfo | undefined;
  let pendingProgress: DesktopUpdateProgressInfo | undefined;
  let progressTimer: unknown;
  let firstCheckTimer: unknown;
  let pollTimer: unknown;
  let backgroundPollingStarted = false;
  let disposed = false;
  let configurationFailed = false;
  let stagedRevocationFailed = false;
  let stagedHydration: Promise<void> | undefined;

  const publish = (status: DesktopUpdateStatus): void => {
    if (disposed) return;
    currentStatus = Object.freeze({ ...status });
    for (const listener of listeners) {
      try {
        listener(currentStatus);
      } catch {
        // Status observers (including a reloading renderer) cannot participate
        // in or roll back the trusted updater transaction.
      }
    }
  };

  if (availability.kind === "available") {
    if (installedVersion === undefined) {
      configurationFailed = true;
      publish({ status: "error", errorKind: "configuration" });
    } else {
      try {
        const feedUrl = resolveDesktopUpdateFeedUrl(options.feedUrl);
        if (feedUrl === undefined) throw new Error("Desktop update feed is unsafe.");
        options.driver.configure(feedUrl);
        configuredFeedUrl = feedUrl;
        requestedFeedUrl = feedUrl;
      } catch {
        configurationFailed = true;
        publish({ status: "error", errorKind: "configuration" });
      }
    }
  }

  if (availability.kind === "available" && !configurationFailed) {
    const hydrationFeedGeneration = feedGeneration;
    stagedHydration = options.driver.hydrateStagedUpdate().then((staged) => {
      if (disposed || hydrationFeedGeneration !== feedGeneration || staged === null) return;
      const version = normalizedVersion(staged.version);
      if (version === undefined || installedVersion === undefined || compareDesktopUpdateVersions(version, installedVersion) !== 1) return;
      readyVersion = version;
      readyQuarantined = staged.quarantined === true;
      publish(readyQuarantined
        ? { status: "idle", availability: "available" }
        : { status: "ready", version });
    }).catch((error: unknown) => {
      if (error instanceof DesktopUpdateStagedRevocationFailure) {
        stagedRevocationFailed = true;
        configurationFailed = true;
        publish({ status: "error", errorKind: "configuration" });
      }
      // A missing/corrupt local cache is not a network check failure. A verified
      // cross-feed package that cannot be durably revoked is distinguished above
      // and keeps every later channel write fail-closed until restart/retry.
    }).finally(() => {
      stagedHydration = undefined;
    });
  }

  const clearProgressTimer = (): void => {
    if (progressTimer === undefined) return;
    clock.clearTimeout(progressTimer);
    progressTimer = undefined;
  };

  const currentPublishedProgress = (): DesktopUpdateProgressInfo | undefined => {
    if (currentStatus.status !== "downloading" && currentStatus.status !== "superseding") return undefined;
    return {
      progress: currentStatus.progress,
      transferred: currentStatus.transferred,
      total: currentStatus.total,
      bytesPerSecond: currentStatus.bytesPerSecond
    };
  };

  const publishProgress = (progress: DesktopUpdateProgressInfo): void => {
    if (currentStatus.status === "downloading") {
      publish({ status: "downloading", version: currentStatus.version, ...progress });
    } else if (currentStatus.status === "superseding") {
      publish({
        status: "superseding",
        version: currentStatus.version,
        nextVersion: currentStatus.nextVersion,
        ...progress
      });
    } else {
      return;
    }
    lastProgressPublishedAt = clock.now();
  };

  const beginProgress = (): void => {
    clearProgressTimer();
    pendingProgress = undefined;
    latestProgressInfo = currentPublishedProgress();
    lastProgressPublishedAt = clock.now();
  };

  const acceptProgress = (rawProgress: DesktopUpdateDriverProgressInfo): void => {
    if (activePhase !== "download") return;
    const published = currentPublishedProgress();
    if (published === undefined) return;
    if (published.progress === 100) return;
    const normalized = normalizeDesktopUpdateProgress(rawProgress);
    const previous = latestProgressInfo ?? published;
    const total = Math.max(previous.total, normalized.total);
    const progress: DesktopUpdateProgressInfo = {
      progress: Math.max(previous.progress, normalized.progress),
      transferred: Math.min(total, Math.max(previous.transferred, normalized.transferred)),
      total,
      bytesPerSecond: normalized.bytesPerSecond
    };
    latestProgressInfo = progress;
    const progressFloor = pendingProgress?.progress ?? published.progress;
    if (progress.progress <= progressFloor) {
      if (pendingProgress !== undefined) pendingProgress = progress;
      return;
    }
    if (progress.progress === 100) {
      clearProgressTimer();
      pendingProgress = undefined;
      publishProgress(progress.total > 0 ? { ...progress, transferred: progress.total } : progress);
      return;
    }
    const elapsed = clock.now() - lastProgressPublishedAt;
    if (elapsed >= DESKTOP_UPDATE_PROGRESS_INTERVAL_MS) {
      pendingProgress = undefined;
      publishProgress(progress);
      return;
    }
    pendingProgress = progress;
    if (progressTimer !== undefined) return;
    progressTimer = clock.setTimeout(() => {
      progressTimer = undefined;
      const queued = pendingProgress;
      pendingProgress = undefined;
      const latest = currentPublishedProgress();
      if (activePhase === "download" && queued !== undefined && latest !== undefined &&
        queued.progress > latest.progress) {
        publishProgress(queued);
      }
    }, Math.max(0, DESKTOP_UPDATE_PROGRESS_INTERVAL_MS - elapsed));
  };

  const stopProgress = options.driver.onProgress((progress) => {
    acceptProgress(progress);
  });
  const stopErrors = options.driver.onError(() => {
    if (activePhase === undefined) return;
    const errorKind: DesktopUpdateErrorKind = activePhase === "apply"
      ? "apply"
      : activePhase === "download" ? "download" : "check";
    activeDriverError = errorKind;
  });

  const performCheck = async (expectedVersion?: string): Promise<DesktopUpdateCheckResult> => {
    const feedGenerationAtStart = feedGeneration;
    const feedUrlAtStart = configuredFeedUrl;
    const feedIsCurrent = (): boolean => feedGenerationAtStart === feedGeneration &&
      feedUrlAtStart === configuredFeedUrl;
    const assertCurrentFeed = (): void => {
      if (!feedIsCurrent()) throw new DesktopUpdateFeedChanged();
    };
    await stagedHydration;
    // changeFeed can invalidate this operation while it is waiting for startup
    // hydration. Resolve as a stale check so the feed-change barrier can drain
    // it and proceed with reconfiguration instead of treating it as a failure.
    if (!feedIsCurrent()) return { status: "failed", errorKind: "check" };
    if (availability.kind === "unavailable") {
      publish(initialStatus(availability));
      return { status: "unavailable", reason: availability.reason };
    }
    if (availability.kind === "manual-download") {
      publish(initialStatus(availability));
      return { status: "manual-download", reason: availability.reason };
    }
    if (configurationFailed) {
      return { status: "failed", errorKind: "configuration" };
    }

    const previousReadyVersion = readyVersion;
    const previousReadyQuarantined = readyQuarantined;
    let previousHiddenForReplacement = false;
    let quarantineCommitFailed = false;
    let committedCandidateVersion: string | undefined;
    activePhase = "check";
    activeDriverError = undefined;
    if (previousReadyVersion === undefined || previousReadyQuarantined) publish({ status: "checking" });
    else if (currentStatus.status !== "ready") publish({ status: "ready", version: previousReadyVersion });
    let version: string | undefined;
    const quarantinePreviousForReplacement = async (): Promise<boolean> => {
      if (previousReadyVersion === undefined || previousReadyQuarantined || previousHiddenForReplacement) return true;
      const persisted = await options.driver.quarantineStagedUpdate(previousReadyVersion).catch(() => false);
      assertCurrentFeed();
      readyQuarantined = true;
      if (!persisted) {
        quarantineCommitFailed = true;
        return false;
      }
      previousHiddenForReplacement = true;
      return true;
    };
    try {
      const result = await options.driver.checkForUpdates();
      assertCurrentFeed();
      if (activeDriverError !== undefined) throw new Error("Updater emitted an error while checking.");
      if (result === null) {
        if (previousReadyVersion === undefined || previousReadyQuarantined) {
          publish({ status: "idle", availability: "unavailable", reason: "updater-disabled" });
        } else {
          publish({ status: "ready", version: previousReadyVersion });
        }
        return { status: "unavailable", reason: "updater-disabled" };
      }
      if (!result.available) {
        const feedVersion = normalizedVersion(result.version);
        if (previousReadyVersion !== undefined && !previousReadyQuarantined &&
          feedVersion !== undefined && feedVersion !== previousReadyVersion) {
          if (!await quarantinePreviousForReplacement()) {
            throw new Error("The withdrawn staged update could not be quarantined.");
          }
          publish({ status: "idle", availability: "available" });
        } else if (previousReadyVersion === undefined || previousReadyQuarantined) {
          publish({ status: "idle", availability: "available" });
        } else {
          // A same-identity ready package remains valid; updater-disabled and
          // transport failures are handled separately from feed withdrawal.
          publish({ status: "ready", version: previousReadyVersion });
        }
        return { status: "up-to-date" };
      }

      version = normalizedVersion(result.version);
      if (version === undefined) throw new Error("Updater returned an invalid version.");
      if (expectedVersion !== undefined && version !== expectedVersion) {
        // The bounded startup manifest and electron-updater's second manifest
        // read must select the exact same build before any installer is written.
        throw new Error("Updater candidate changed during startup selection.");
      }
      const installedPrecedence = compareDesktopUpdateVersions(version, installedVersion as string);
      if (installedPrecedence === undefined) throw new Error("Updater version could not be compared to the installed version.");
      if (installedPrecedence <= 0) {
        if (previousReadyVersion !== undefined && !previousReadyQuarantined &&
          !await quarantinePreviousForReplacement()) {
          throw new Error("The withdrawn staged update could not be quarantined.");
        }
        publish({ status: "idle", availability: "available" });
        return { status: "up-to-date" };
      }
      if (previousReadyVersion !== undefined && !previousReadyQuarantined) {
        if (version === previousReadyVersion) {
          publish({ status: "ready", version: previousReadyVersion });
          return { status: "available", version: previousReadyVersion };
        }
        // The current feed identity remains authoritative even when its
        // SemVer precedence is below a previously staged (not installed) build.
        if (!await quarantinePreviousForReplacement()) {
          throw new Error("The superseded staged update could not be quarantined.");
        }
      }
      activePhase = "download";
      if (previousReadyVersion === undefined || previousReadyQuarantined) {
        publish({ status: "downloading", version, ...emptyDesktopUpdateProgress() });
      } else {
        publish({
          status: "superseding",
          version: previousReadyVersion,
          nextVersion: version,
          ...emptyDesktopUpdateProgress()
        });
      }
      beginProgress();
      await options.driver.downloadUpdate(version);
      assertCurrentFeed();
      if (activeDriverError !== undefined) throw new Error("Updater emitted an error while downloading.");
      const finalProgress = latestProgressInfo ?? currentPublishedProgress();
      if (finalProgress !== undefined) {
        acceptProgress({
          percent: 100,
          transferred: finalProgress.transferred,
          total: finalProgress.total,
          bytesPerSecond: finalProgress.bytesPerSecond
        });
      }
      const promotion = await options.driver.promoteStagedUpdate(version);
      if (!promotion.promoted) {
        throw new DesktopUpdateDownloadFailure(promotion.previousReadyPreserved);
      }
      committedCandidateVersion = version;
      assertCurrentFeed();
      readyVersion = version;
      readyQuarantined = false;
      publish({ status: "ready", version });
      return { status: "available", version };
    } catch (error: unknown) {
      const errorKind = activeDriverError ?? (activePhase === "download" ? "download" : "check");
      clearProgressTimer();
      pendingProgress = undefined;
      latestProgressInfo = undefined;
      if (error instanceof DesktopUpdateFeedChanged || feedGenerationAtStart !== feedGeneration ||
        feedUrlAtStart !== configuredFeedUrl) {
        // changeFeed synchronously revoked the old generation. Never let the
        // stale operation republish it. If promotion crossed the generation
        // boundary, durably quarantine the physical candidate before allowing
        // feed reconfiguration to continue. Keeping it as the hidden ready
        // identity also makes the transition retry the revocation if this first
        // attempt fails.
        if (committedCandidateVersion !== undefined) {
          readyVersion = committedCandidateVersion;
          readyQuarantined = true;
          await options.driver.quarantineStagedUpdate(committedCandidateVersion).catch(() => false);
        }
        return { status: "failed", errorKind };
      }
      const previousReadyPreserved = !(error instanceof DesktopUpdateDownloadFailure)
        || error.previousReadyPreserved;
      if (previousReadyVersion !== undefined && previousReadyPreserved && !quarantineCommitFailed) {
        if (previousHiddenForReplacement) {
          const restoration = await options.driver.promoteStagedUpdate(previousReadyVersion).catch(() => ({
            promoted: false,
            previousReadyPreserved: false
          }));
          if (!feedIsCurrent()) {
            if (restoration.promoted) {
              readyVersion = previousReadyVersion;
              readyQuarantined = true;
              await options.driver.quarantineStagedUpdate(previousReadyVersion).catch(() => false);
            }
            return { status: "failed", errorKind };
          }
          if (!restoration.promoted) {
            readyVersion = previousReadyVersion;
            readyQuarantined = true;
            publish({ status: "error", errorKind, ...(version === undefined ? {} : { version }) });
            return { status: "failed", errorKind };
          }
        }
        readyVersion = previousReadyVersion;
        readyQuarantined = previousReadyQuarantined;
        if (previousReadyQuarantined) {
          publish({
            status: "error",
            errorKind,
            ...(version === undefined ? {} : { version })
          });
          return { status: "failed", errorKind };
        }
        publish({ status: "ready", version: previousReadyVersion });
        if (errorKind === "download") return { status: "available", version: previousReadyVersion };
        return { status: "failed", errorKind };
      }
      if (!previousReadyPreserved) {
        readyVersion = undefined;
        readyQuarantined = false;
      }
      publish({
        status: "error",
        errorKind,
        ...(version === undefined ? {} : { version })
      });
      return { status: "failed", errorKind };
    } finally {
      clearProgressTimer();
      pendingProgress = undefined;
      latestProgressInfo = undefined;
      activePhase = undefined;
      activeDriverError = undefined;
    }
  };

  const checkWithExpectedVersion = (expectedVersion?: string): Promise<DesktopUpdateCheckResult> => {
    if (inFlightFeedChange !== undefined) {
      return inFlightFeedChange.then((changed) => changed
        ? checkWithExpectedVersion(expectedVersion)
        : { status: "failed", errorKind: "configuration" });
    }
    if (inFlightCheck !== undefined) return inFlightCheck;
    if (inFlightQuarantine !== undefined) {
      return inFlightQuarantine.then(() => checkWithExpectedVersion(expectedVersion));
    }
    if (inFlightRelaunch !== undefined && readyVersion !== undefined) {
      return Promise.resolve({ status: "available", version: readyVersion });
    }
    const operation = performCheck(expectedVersion).finally(() => {
      if (inFlightCheck === operation) inFlightCheck = undefined;
    });
    inFlightCheck = operation;
    return operation;
  };
  const check = (): Promise<DesktopUpdateCheckResult> => checkWithExpectedVersion();

  const performRelaunch = async (): Promise<DesktopUpdateRelaunchResult> => {
    const feedGenerationAtStart = feedGeneration;
    const feedUrlAtStart = configuredFeedUrl;
    const version = readyVersion;
    if (version === undefined || currentStatus.status !== "ready" || currentStatus.version !== version ||
      readyQuarantined || configurationFailed || inFlightCheck !== undefined ||
      inFlightQuarantine !== undefined || inFlightFeedChange !== undefined) {
      return { accepted: false, reason: "not-ready" };
    }
    try {
      await options.prepareToApply();
    } catch {
      // The verified installer is still intact. Keep the durable ready state so
      // the renderer can surface the command result and the user can retry.
      return { accepted: false, reason: "orchestrator-shutdown-failed" };
    }
    if (disposed || feedGenerationAtStart !== feedGeneration || feedUrlAtStart !== configuredFeedUrl ||
      readyVersion !== version || readyQuarantined || configurationFailed ||
      currentStatus.status !== "ready" || currentStatus.version !== version ||
      inFlightCheck !== undefined || inFlightQuarantine !== undefined || inFlightFeedChange !== undefined) {
      if (!disposed) {
        try {
          await options.recoverAfterApplyFailure?.();
        } catch {
          // The feed/apply fence remains fail-closed even if recovery fails.
        }
      }
      return { accepted: false, reason: "not-ready" };
    }
    try {
      activePhase = "apply";
      activeDriverError = undefined;
      await options.driver.relaunchToInstall();
      if (activeDriverError === "apply") throw new Error("Updater rejected the install request.");
      return { accepted: true };
    } catch {
      if (!disposed) {
        try {
          await options.recoverAfterApplyFailure?.();
        } catch {
          // Recovery is best-effort. The app remains alive and exposes a retryable status.
        }
      }
      // Native handoff rejection does not invalidate the staged installer.
      // Recovery keeps the app alive; ready makes the same patch retryable.
      return { accepted: false, reason: "apply-failed" };
    } finally {
      activePhase = undefined;
      activeDriverError = undefined;
    }
  };

  const relaunch = (): Promise<DesktopUpdateRelaunchResult> => {
    if (inFlightRelaunch !== undefined) return inFlightRelaunch;
    if (inFlightFeedChange !== undefined) return Promise.resolve({ accepted: false, reason: "not-ready" });
    const operation = performRelaunch().finally(() => {
      if (inFlightRelaunch === operation) inFlightRelaunch = undefined;
    });
    inFlightRelaunch = operation;
    return operation;
  };

  const changeFeed = (rawFeedUrl: string): Promise<boolean> => {
    const feedUrl = resolveDesktopUpdateFeedUrl(rawFeedUrl);
    if (feedUrl === undefined || disposed || availability.kind !== "available" ||
      installedVersion === undefined || stagedRevocationFailed) return Promise.resolve(false);
    if (inFlightFeedChange !== undefined) {
      // The first accepted selection is already persisted by main. Refuse a
      // different second selection until old-package revocation is durable.
      return Promise.resolve(requestedFeedUrl === feedUrl);
    }
    if (configuredFeedUrl === feedUrl && !configurationFailed) {
      return Promise.resolve(true);
    }

    // Advance synchronously so an already-running check/download cannot
    // promote a candidate after the device channel choice starts changing.
    feedGeneration += 1;
    const feedGenerationAtRequest = feedGeneration;
    requestedFeedUrl = feedUrl;
    const readyVersionAtRequest = readyVersion;
    if (readyVersionAtRequest !== undefined) readyQuarantined = true;
    publish({ status: "idle", availability: "available" });
    let tracked!: Promise<boolean>;
    const operation = (async (): Promise<boolean> => {
      await stagedHydration;
      const activeCheck = inFlightCheck;
      if (activeCheck !== undefined) await activeCheck;
      const activeQuarantine = inFlightQuarantine;
      if (activeQuarantine !== undefined) await activeQuarantine;
      const activeRelaunch = inFlightRelaunch;
      if (activeRelaunch !== undefined) await activeRelaunch;
      if (disposed) return false;
      const stillCurrent = (): boolean => feedGenerationAtRequest === feedGeneration &&
        requestedFeedUrl === feedUrl;
      if (!stillCurrent()) return true;

      const versionToQuarantine = readyVersion ?? readyVersionAtRequest;
      if (versionToQuarantine !== undefined) {
        const persisted = await options.driver.quarantineStagedUpdate(versionToQuarantine).catch(() => false);
        if (!stillCurrent()) return true;
        readyQuarantined = true;
        if (!persisted) {
          stagedRevocationFailed = true;
          configurationFailed = true;
          publish({ status: "error", errorKind: "configuration" });
          return false;
        }
      }

      try {
        options.driver.configure(feedUrl);
      } catch {
        if (!stillCurrent()) return true;
        configurationFailed = true;
        publish({ status: "error", errorKind: "configuration" });
        return false;
      }
      if (!stillCurrent()) return true;
      configuredFeedUrl = feedUrl;
      configurationFailed = false;
      readyVersion = undefined;
      readyQuarantined = false;
      publish({ status: "idle", availability: "available" });
      return true;
    })().catch(() => {
      if (!disposed && feedGenerationAtRequest === feedGeneration && requestedFeedUrl === feedUrl) {
        configurationFailed = true;
        publish({ status: "error", errorKind: "configuration" });
      }
      return false;
    });
    tracked = operation.finally(() => {
      if (inFlightFeedChange === tracked) inFlightFeedChange = undefined;
    });
    inFlightFeedChange = tracked;
    // Channel persistence/IPC acknowledges policy selection immediately. The
    // tracked promise remains the internal barrier for later checks/applies.
    return Promise.resolve(true);
  };

  const startBackgroundPolling = (): void => {
    if (backgroundPollingStarted || disposed || availability.kind !== "available" || configurationFailed) return;
    backgroundPollingStarted = true;
    firstCheckTimer = clock.setTimeout(() => {
      firstCheckTimer = undefined;
      if (disposed) return;
      void check();
      pollTimer = clock.setInterval(() => {
        if (!disposed) void check();
      }, options.pollIntervalMs ?? DESKTOP_UPDATE_POLL_INTERVAL_MS);
    }, options.firstCheckDelayMs ?? DESKTOP_UPDATE_FIRST_CHECK_DELAY_MS);
  };

  if (options.enableBackgroundPolling !== false) startBackgroundPolling();

  return Object.freeze({
    initialize: async () => stagedHydration,
    getStatus: () => currentStatus,
    isRelaunching: () => inFlightRelaunch !== undefined,
    isFeedChangePending: () => stagedHydration !== undefined || inFlightFeedChange !== undefined ||
      stagedRevocationFailed,
    changeFeed,
    quarantineReady: (version: string): Promise<boolean> => {
      if (inFlightQuarantine !== undefined) return inFlightQuarantine;
      if (readyVersion !== version || currentStatus.status !== "ready" ||
        inFlightCheck !== undefined || inFlightRelaunch !== undefined ||
        inFlightFeedChange !== undefined) return Promise.resolve(false);
      const operation = options.driver.quarantineStagedUpdate(version).then((persisted) => {
        if (!persisted || disposed || readyVersion !== version || currentStatus.status !== "ready" ||
          inFlightCheck !== undefined || inFlightRelaunch !== undefined) return false;
        readyQuarantined = true;
        publish({ status: "idle", availability: "available" });
        return true;
      }).catch(() => false).finally(() => {
        if (inFlightQuarantine === operation) inFlightQuarantine = undefined;
      });
      inFlightQuarantine = operation;
      return operation;
    },
    startBackgroundPolling,
    onStatus: (listener: (status: DesktopUpdateStatus) => void) => {
      if (typeof listener !== "function") throw new TypeError("Desktop update status listener must be a function.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    checkForExpectedVersion: (expectedVersion: string) => {
      const normalizedExpected = normalizedVersion(expectedVersion);
      if (normalizedExpected === undefined || normalizedExpected !== expectedVersion) {
        return Promise.resolve<DesktopUpdateCheckResult>({ status: "failed", errorKind: "configuration" });
      }
      return checkWithExpectedVersion(normalizedExpected);
    },
    relaunch,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      feedGeneration += 1;
      listeners.clear();
      clearProgressTimer();
      if (firstCheckTimer !== undefined) clock.clearTimeout(firstCheckTimer);
      if (pollTimer !== undefined) clock.clearInterval(pollTimer);
      firstCheckTimer = undefined;
      pollTimer = undefined;
      stopProgress();
      stopErrors();
      options.driver.dispose?.();
    }
  });
}

function isVersionlessDesktopBuild(version: string): boolean {
  return /^0\.0\.0(?:-|$)/u.test(version.trim());
}

function initialStatus(availability: UpdateAvailability): DesktopUpdateStatus {
  if (availability.kind === "manual-download") {
    return { status: "manual-download", reason: availability.reason };
  }
  if (availability.kind === "unavailable") {
    return { status: "idle", availability: "unavailable", reason: availability.reason };
  }
  return { status: "idle", availability: "available" };
}

function normalizedVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  if (version.length === 0 || version.length > MAXIMUM_VERSION_LENGTH || parseSemver(version) === undefined) return undefined;
  return version;
}

export function compareDesktopUpdateVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  if (leftVersion === undefined || rightVersion === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumericIdentifier(leftVersion.core[index] as string, rightVersion.core[index] as string);
    if (compared !== 0) return compared;
  }
  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (leftPrerelease === undefined) return rightPrerelease === undefined ? 0 : 1;
  if (rightPrerelease === undefined) return -1;
  const count = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseSemver(value: string): {
  readonly core: readonly [string, string, string];
  readonly prerelease?: readonly string[];
} | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((identifier) => /^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return undefined;
  }
  return {
    core: [match[1] as string, match[2] as string, match[3] as string],
    ...(prerelease === undefined ? {} : { prerelease })
  };
}

function compareNumericIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

interface DesktopUpdateProgressInfo {
  readonly progress: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

function emptyDesktopUpdateProgress(): DesktopUpdateProgressInfo {
  return { progress: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
}

function normalizeDesktopUpdateProgress(value: DesktopUpdateDriverProgressInfo): DesktopUpdateProgressInfo {
  return {
    progress: normalizeProgress(value.percent),
    transferred: normalizeDesktopUpdateCounter(value.transferred),
    total: normalizeDesktopUpdateCounter(value.total),
    bytesPerSecond: normalizeDesktopUpdateCounter(value.bytesPerSecond)
  };
}

function normalizeDesktopUpdateCounter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function systemUpdateClock(): DesktopUpdateClock {
  return {
    now: Date.now,
    setTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, delayMs) => {
      const handle = setInterval(callback, delayMs);
      handle.unref();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
  };
}
