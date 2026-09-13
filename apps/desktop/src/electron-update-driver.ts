import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import electronUpdater, { type AppUpdater, type ProgressInfo } from "electron-updater";

import {
  DesktopUpdateDownloadFailure,
  DesktopUpdateStagedRevocationFailure,
  compareDesktopUpdateVersions,
  type DesktopUpdateDriver,
  type DesktopUpdateDriverProgressInfo
} from "./update-service.js";
import { atomicWritePrivateFile, deletePrivateFile } from "./secure-files.js";

interface InternalDownloadedUpdateHelper {
  readonly cacheDirForPendingUpdate: string;
  _file: string | null;
  _packageFile: string | null;
  versionInfo: unknown;
  fileInfo: unknown;
  _downloadedFileInfo: unknown;
}

interface StagedUpdateSnapshot {
  readonly helper: InternalDownloadedUpdateHelper;
  readonly pendingDirectory: string;
  readonly rollbackDirectory: string;
  readonly file: string | null;
  readonly packageFile: string | null;
  readonly versionInfo: unknown;
  readonly fileInfo: unknown;
  readonly downloadedFileInfo: unknown;
}

const ROLLBACK_DIRECTORY_PREFIX = ".joko-update-rollback-";
const ROLLBACK_MARKER_FILE = ".joko-update-rollback-v1";
const ROLLBACK_MARKER_CONTENT = "joko-electron-updater-pending-v1\n";
const STAGED_UPDATE_INFO_FILE = "joko-staged-update-v1.json";
const STAGED_UPDATE_QUARANTINE_FILE = "joko-staged-update-quarantine-v1";
const ELECTRON_UPDATER_RUNTIME_VERSION = "6.8.9";
const MAXIMUM_STAGED_INFO_BYTES = 8 * 1024;
const MAXIMUM_STAGED_FILE_BYTES = 16 * 1024 * 1024 * 1024;
export const DESKTOP_UPDATE_INSTALL_HANDOFF_TIMEOUT_MS = 30_000;

interface PersistedStagedFile {
  readonly fileName: string;
  readonly sha512: string;
  readonly size: number;
}

interface PersistedStagedUpdate {
  readonly schema: 1;
  readonly electronUpdaterVersion: "6.8.9";
  readonly platform: "win32" | "darwin" | "linux";
  readonly feedSha256: string;
  readonly version: string;
  readonly eligible: boolean;
  readonly installer: PersistedStagedFile & { readonly isAdminRightsRequired: boolean };
  readonly packageFile?: PersistedStagedFile;
}

/** The native Electron updater emits this only after install handoff begins. */
export interface ElectronUpdateInstallSignal {
  readonly once: (event: "before-quit-for-update", listener: () => void) => unknown;
  readonly removeListener: (event: "before-quit-for-update", listener: () => void) => unknown;
  /** Audited macOS native-updater listener access used to revoke a timed-out install attempt. */
  readonly getUpdateDownloadedListeners?: () => Function[];
  readonly removeUpdateDownloadedListener?: (listener: Function) => unknown;
}

export interface ElectronUpdateQuitEvent {
  readonly preventDefault: () => void;
}

/** Ordinary Electron quit preflight used before any native installer spawn. */
export interface ElectronUpdateQuitHandoff {
  readonly once: (
    event: "will-quit",
    listener: (event: ElectronUpdateQuitEvent) => void
  ) => unknown;
  readonly removeListener: (
    event: "will-quit",
    listener: (event: ElectronUpdateQuitEvent) => void
  ) => unknown;
  readonly quit: () => void;
  readonly onQuitBlocked?: (listener: () => void) => () => void;
}

export interface ElectronUpdateDriverOptions {
  readonly platform?: NodeJS.Platform;
  readonly installHandoffTimeoutMs?: number;
  readonly quitHandoff?: ElectronUpdateQuitHandoff;
  readonly writePrivateFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly deletePrivateFile?: (path: string) => Promise<void>;
}

/** electron-updater is CommonJS; destructuring the default import is its documented ESM bridge. */
export function bundledElectronUpdater(): AppUpdater {
  return electronUpdater.autoUpdater;
}

export function createElectronUpdateDriver(
  updater: AppUpdater,
  installSignal: ElectronUpdateInstallSignal,
  options: ElectronUpdateDriverOptions = {}
): DesktopUpdateDriver {
  // electron-updater defaults to console and includes raw release URLs, paths,
  // and Error stacks. Joko exposes only enumerated lifecycle errors instead.
  updater.logger = null;
  updater.autoDownload = false;
  // Applying a downloaded build is always an explicit, safe-shutdown-gated action.
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  const platform = options.platform ?? process.platform;
  const writePrivateFile = options.writePrivateFile ?? atomicWritePrivateFile;
  const deleteDurablePrivateFile = options.deletePrivateFile ?? deletePrivateFile;
  const installHandoffTimeoutMs = options.installHandoffTimeoutMs ?? DESKTOP_UPDATE_INSTALL_HANDOFF_TIMEOUT_MS;
  if (!Number.isSafeInteger(installHandoffTimeoutMs) || installHandoffTimeoutMs <= 0) {
    throw new TypeError("Desktop update install handoff timeout must be a positive integer.");
  }
  let stagedDownloadInThisProcess = false;
  let feedSha256: string | undefined;
  let activeInstallCancel: (() => void) | undefined;
  let pendingPromotionSnapshot: StagedUpdateSnapshot | undefined;

  return Object.freeze({
    configure: (feedUrl: string): void => {
      updater.setFeedURL({ provider: "generic", url: feedUrl });
      const nextFeedSha256 = createHash("sha256").update(feedUrl, "utf8").digest("hex");
      if (feedSha256 !== undefined && feedSha256 !== nextFeedSha256) {
        // A channel transition invalidates every in-memory claim about the
        // shared pending directory. The next manifest/download must establish
        // a fresh feed-bound sidecar before policy can promote it again.
        stagedDownloadInThisProcess = false;
        pendingPromotionSnapshot = undefined;
      }
      feedSha256 = nextFeedSha256;
    },
    hydrateStagedUpdate: async () => {
      if (feedSha256 === undefined || !isSupportedUpdatePlatform(platform)) return null;
      await recoverInterruptedStagedUpdate(updater);
      const helper = await internalDownloadHelper(updater);
      if (helper === undefined) return null;
      const staged = await readVerifiedStagedUpdate(helper, platform);
      if (staged === undefined) return null;
      if (staged.feedSha256 !== feedSha256) {
        const revoked = await durablyQuarantineStagedUpdate(
          resolve(helper.cacheDirForPendingUpdate),
          staged,
          writePrivateFile,
          deleteDurablePrivateFile
        );
        if (!revoked) throw new DesktopUpdateStagedRevocationFailure();
        return null;
      }
      hydrateDownloadHelper(helper, staged);
      if (platform === "darwin") await hydrateMacUpdateProxy(updater, staged, helper._file as string);
      stagedDownloadInThisProcess = true;
      return { version: staged.version, ...(staged.eligible ? {} : { quarantined: true as const }) };
    },
    quarantineStagedUpdate: async (version: string): Promise<boolean> => {
      if (feedSha256 === undefined || !isSupportedUpdatePlatform(platform)) return false;
      if (pendingPromotionSnapshot !== undefined) return false;
      await recoverInterruptedStagedUpdate(updater);
      const helper = await internalDownloadHelper(updater);
      if (helper === undefined) return false;
      const staged = await readVerifiedStagedUpdate(helper, platform, feedSha256);
      if (staged === undefined || staged.version !== version) return false;
      return durablyQuarantineStagedUpdate(
        resolve(helper.cacheDirForPendingUpdate),
        staged,
        writePrivateFile,
        deleteDurablePrivateFile
      );
    },
    promoteStagedUpdate: async (version: string) => {
      if (feedSha256 === undefined || !isSupportedUpdatePlatform(platform)) {
        return { promoted: false, previousReadyPreserved: false };
      }
      const helper = await internalDownloadHelper(updater);
      if (helper === undefined) return { promoted: false, previousReadyPreserved: false };
      const staged = await readVerifiedStagedUpdate(helper, platform, feedSha256).catch(() => undefined);
      if (staged === undefined || staged.version !== version) {
        return { promoted: false, previousReadyPreserved: false };
      }
      if (staged.eligible && pendingPromotionSnapshot === undefined) {
        return { promoted: true, previousReadyPreserved: false };
      }
      const snapshot = pendingPromotionSnapshot;
      try {
        await writePersistedStagedUpdate(helper.cacheDirForPendingUpdate, {
          ...staged,
          eligible: true
        }, writePrivateFile);
        await rm(resolve(helper.cacheDirForPendingUpdate, STAGED_UPDATE_QUARANTINE_FILE), { force: true });
        if (snapshot !== undefined) {
          // The marker removal commits the new eligible installer. Until this
          // point a crash restores the old, quarantined verified rollback.
          await rm(resolve(snapshot.rollbackDirectory, ROLLBACK_MARKER_FILE), { force: true });
          pendingPromotionSnapshot = undefined;
          await rm(snapshot.rollbackDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        return { promoted: true, previousReadyPreserved: false };
      } catch {
        pendingPromotionSnapshot = undefined;
        if (snapshot === undefined) return { promoted: false, previousReadyPreserved: false };
        const restored = await restoreStagedSnapshot(updater, snapshot, platform, feedSha256);
        stagedDownloadInThisProcess = restored;
        return { promoted: false, previousReadyPreserved: restored };
      }
    },
    checkForUpdates: async () => {
      await recoverInterruptedStagedUpdate(updater);
      const result = await updater.checkForUpdates();
      if (result === null) return null;
      return {
        available: result.isUpdateAvailable,
        version: result.updateInfo.version
      };
    },
    downloadUpdate: async (version: string): Promise<void> => {
      if (feedSha256 === undefined || !isSupportedUpdatePlatform(platform)) {
        throw new DesktopUpdateDownloadFailure(false);
      }
      await recoverInterruptedStagedUpdate(updater);
      let snapshot: StagedUpdateSnapshot | undefined;
      if (stagedDownloadInThisProcess) {
        try {
          snapshot = await preserveStagedUpdate(updater);
        } catch {
          // The old installer has not been touched. Refuse superseding rather
          // than risk invalidating a known-good ready build.
          throw new DesktopUpdateDownloadFailure(true);
        }
        if (snapshot === undefined) throw new DesktopUpdateDownloadFailure(true);
      }
      try {
        await updater.downloadUpdate();
        await persistVerifiedStagedUpdate(updater, version, platform, feedSha256, writePrivateFile);
        stagedDownloadInThisProcess = true;
        pendingPromotionSnapshot = snapshot;
      } catch {
        if (snapshot === undefined) {
          throw new DesktopUpdateDownloadFailure(false);
        }
        const restored = await restoreStagedSnapshot(updater, snapshot, platform, feedSha256);
        pendingPromotionSnapshot = undefined;
        stagedDownloadInThisProcess = restored;
        throw new DesktopUpdateDownloadFailure(restored);
      }
    },
    relaunchToInstall: (): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
      activeInstallCancel?.();
      const quitHandoff = options.quitHandoff;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let macNativeInstallListeners: readonly Function[] = [];
      let stopQuitBlocked: (() => void) | undefined;
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        quitHandoff?.removeListener("will-quit", preflightAccepted);
        installSignal.removeListener("before-quit-for-update", nativeAccepted);
        updater.removeListener("error", failed);
        stopQuitBlocked?.();
        stopQuitBlocked = undefined;
        for (const listener of macNativeInstallListeners) {
          installSignal.removeUpdateDownloadedListener?.(listener);
        }
        macNativeInstallListeners = [];
        if (activeInstallCancel === failed) activeInstallCancel = undefined;
      };
      const nativeAccepted = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise();
      };
      const failed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error("Desktop update install handoff failed."));
      };
      const preflightAccepted = (event: ElectronUpdateQuitEvent): void => {
        if (settled) return;
        // All renderer beforeunload handlers have allowed the ordinary quit.
        // Keep Electron alive while the pinned updater performs its own native
        // handoff; NSIS must not be spawned before this exact boundary.
        event.preventDefault();
        quitHandoff?.removeListener("will-quit", preflightAccepted);
        stopQuitBlocked?.();
        stopQuitBlocked = undefined;
        installSignal.once("before-quit-for-update", nativeAccepted);
        updater.once("error", failed);
        const nativeListenersBefore = platform === "darwin"
          ? new Set(installSignal.getUpdateDownloadedListeners?.() ?? [])
          : undefined;
        let synchronousFailure = false;
        try {
          updater.quitAndInstall(false, true);
        } catch {
          synchronousFailure = true;
        } finally {
          if (nativeListenersBefore !== undefined) {
            macNativeInstallListeners = (installSignal.getUpdateDownloadedListeners?.() ?? [])
              .filter((listener) => !nativeListenersBefore.has(listener));
          }
          // MacUpdater can synchronously emit/throw after adding its anonymous
          // late-install listener. Repeat cleanup after the listener diff.
          if (settled) cleanup();
        }
        if (synchronousFailure) failed();
      };
      timeout = setTimeout(failed, installHandoffTimeoutMs);
      timeout.unref();
      activeInstallCancel = failed;
      if (quitHandoff === undefined) {
        failed();
        return;
      }
      try {
        quitHandoff.once("will-quit", preflightAccepted);
        stopQuitBlocked = quitHandoff.onQuitBlocked?.(failed);
        quitHandoff.quit();
      } catch {
        failed();
      }
    }),
    onProgress: (listener: (progress: DesktopUpdateDriverProgressInfo) => void) => {
      const wrapped = (progress: ProgressInfo): void => listener({
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      });
      updater.on("download-progress", wrapped);
      return () => updater.removeListener("download-progress", wrapped);
    },
    onError: (listener: () => void) => {
      const wrapped = (): void => listener();
      updater.on("error", wrapped);
      return () => updater.removeListener("error", wrapped);
    },
    dispose: (): void => activeInstallCancel?.()
  });
}

async function preserveStagedUpdate(updater: AppUpdater): Promise<StagedUpdateSnapshot | undefined> {
  const helper = (updater as unknown as { readonly downloadedUpdateHelper?: InternalDownloadedUpdateHelper | null })
    .downloadedUpdateHelper;
  if (helper === undefined || helper === null || helper._file === null) return undefined;
  const pendingDirectory = resolve(helper.cacheDirForPendingUpdate);
  const parentDirectory = dirname(pendingDirectory);
  const rollbackDirectory = resolve(parentDirectory, `${ROLLBACK_DIRECTORY_PREFIX}${randomUUID()}`);
  if (dirname(rollbackDirectory) !== parentDirectory || rollbackDirectory === pendingDirectory) {
    throw new Error("Unsafe Desktop update rollback path.");
  }
  const info = await lstat(pendingDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Desktop update pending path is not a directory.");
  const snapshot: StagedUpdateSnapshot = {
    helper,
    pendingDirectory,
    rollbackDirectory,
    file: helper._file,
    packageFile: helper._packageFile,
    versionInfo: helper.versionInfo,
    fileInfo: helper.fileInfo,
    downloadedFileInfo: helper._downloadedFileInfo
  };
  await writeFile(resolve(pendingDirectory, ROLLBACK_MARKER_FILE), ROLLBACK_MARKER_CONTENT, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await rename(pendingDirectory, rollbackDirectory);
  return snapshot;
}

async function restoreStagedUpdate(snapshot: StagedUpdateSnapshot): Promise<boolean> {
  try {
    await rm(snapshot.pendingDirectory, { recursive: true, force: true });
    await rename(snapshot.rollbackDirectory, snapshot.pendingDirectory);
    snapshot.helper._file = snapshot.file;
    snapshot.helper._packageFile = snapshot.packageFile;
    snapshot.helper.versionInfo = snapshot.versionInfo;
    snapshot.helper.fileInfo = snapshot.fileInfo;
    snapshot.helper._downloadedFileInfo = snapshot.downloadedFileInfo;
    // The directory rename is the recovery commit. A transient marker cleanup
    // failure must not hide the physically restored, already verified update.
    await rm(resolve(snapshot.pendingDirectory, ROLLBACK_MARKER_FILE), { force: true }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function restoreStagedSnapshot(
  updater: AppUpdater,
  snapshot: StagedUpdateSnapshot,
  platform: "win32" | "darwin" | "linux",
  feedSha256: string
): Promise<boolean> {
  let restored = await restoreStagedUpdate(snapshot);
  if (restored) {
    (updater as unknown as { downloadedUpdateHelper?: InternalDownloadedUpdateHelper | null })
      .downloadedUpdateHelper = snapshot.helper;
  }
  if (restored && platform === "darwin") {
    try {
      const staged = await readVerifiedStagedUpdate(snapshot.helper, platform, feedSha256);
      if (staged === undefined) throw new Error("The previous macOS staged update could not be revalidated.");
      hydrateDownloadHelper(snapshot.helper, staged);
      await hydrateMacUpdateProxy(updater, staged, snapshot.helper._file as string);
    } catch {
      // MacUpdater.updateDownloaded replaces the local Squirrel proxy. Physical
      // rollback alone is not installable until the old proxy is rebuilt.
      restored = false;
    }
  }
  return restored;
}

async function persistVerifiedStagedUpdate(
  updater: AppUpdater,
  version: string,
  platform: "win32" | "darwin" | "linux",
  feedSha256: string,
  writePrivateFile: (path: string, bytes: Uint8Array) => Promise<void>
): Promise<void> {
  if (compareDesktopUpdateVersions(version, version) !== 0) {
    throw new Error("Desktop update version is not strict SemVer.");
  }
  const helper = await internalDownloadHelper(updater);
  if (helper === undefined || helper._file === null) throw new Error("Desktop update helper has no verified installer.");
  const versionInfo = asRecord(helper.versionInfo);
  if (versionInfo?.["version"] !== version) {
    throw new Error("Desktop update version does not match electron-updater metadata.");
  }
  const downloadedInfo = asRecord(helper._downloadedFileInfo);
  const expectedFileName = downloadedInfo?.["fileName"];
  const expectedSha512 = downloadedInfo?.["sha512"];
  if (!isSafeStagedFileName(expectedFileName) || !isSha512(expectedSha512)) {
    throw new Error("Desktop update helper metadata is invalid.");
  }
  const pendingDirectory = resolve(helper.cacheDirForPendingUpdate);
  const installer = await inspectVerifiedStagedFile(helper._file, pendingDirectory, expectedSha512);
  if (installer.fileName !== expectedFileName) throw new Error("Desktop update installer metadata does not match its path.");

  const electronInfo = await readSmallJson(resolve(pendingDirectory, "update-info.json"));
  if (electronInfo?.["fileName"] !== expectedFileName || electronInfo["sha512"] !== expectedSha512) {
    throw new Error("Desktop update cache metadata does not match the verified installer.");
  }

  let packageFile: PersistedStagedFile | undefined;
  if (helper._packageFile !== null) {
    const fileInfo = asRecord(helper.fileInfo);
    const packageInfo = asRecord(fileInfo?.["packageInfo"]);
    const packageSha512 = packageInfo?.["sha512"];
    if (!isSha512(packageSha512)) throw new Error("Desktop update package metadata is invalid.");
    packageFile = await inspectVerifiedStagedFile(helper._packageFile, pendingDirectory, packageSha512);
  }

  const staged: PersistedStagedUpdate = {
    schema: 1,
    electronUpdaterVersion: ELECTRON_UPDATER_RUNTIME_VERSION,
    platform,
    feedSha256,
    version,
    eligible: false,
    installer: {
      ...installer,
      isAdminRightsRequired: downloadedInfo?.["isAdminRightsRequired"] === true
    },
    ...(packageFile === undefined ? {} : { packageFile })
  };
  await writePersistedStagedUpdate(pendingDirectory, staged, writePrivateFile);
  await rm(resolve(pendingDirectory, STAGED_UPDATE_QUARANTINE_FILE), { force: true }).catch(() => undefined);
}

async function durablyQuarantineStagedUpdate(
  pendingDirectory: string,
  staged: PersistedStagedUpdate,
  writePrivateFile: (path: string, bytes: Uint8Array) => Promise<void>,
  deleteDurablePrivateFile: (path: string) => Promise<void>
): Promise<boolean> {
  if (!staged.eligible) return true;
  let durablyRevoked = false;
  try {
    await writePrivateFile(
      resolve(pendingDirectory, STAGED_UPDATE_QUARANTINE_FILE),
      quarantineMarkerBytes(staged)
    );
    durablyRevoked = true;
  } catch {
    // The sidecar rewrite below is an independent fail-closed path.
  }
  try {
    await writePersistedStagedUpdate(pendingDirectory, { ...staged, eligible: false }, writePrivateFile);
    durablyRevoked = true;
  } catch {
    // The marker remains authoritative when sidecar replacement fails.
  }
  if (durablyRevoked) return true;
  // Last resort: losing metadata is preferable to hydrating a feed-revoked
  // installer as eligible after restart. The unlink is not durable until the
  // parent directory has been synced, so a failed durable delete must keep the
  // policy result false even if a transient read reports ENOENT.
  try {
    await deleteDurablePrivateFile(resolve(pendingDirectory, STAGED_UPDATE_INFO_FILE));
    return true;
  } catch {
    return false;
  }
}

async function writePersistedStagedUpdate(
  pendingDirectory: string,
  staged: PersistedStagedUpdate,
  writePrivateFile: (path: string, bytes: Uint8Array) => Promise<void>
): Promise<void> {
  await writePrivateFile(
    resolve(pendingDirectory, STAGED_UPDATE_INFO_FILE),
    Buffer.from(`${JSON.stringify(staged)}\n`, "utf8")
  );
}

async function readVerifiedStagedUpdate(
  helper: InternalDownloadedUpdateHelper,
  platform: "win32" | "darwin" | "linux",
  feedSha256?: string
): Promise<PersistedStagedUpdate | undefined> {
  const pendingDirectory = resolve(helper.cacheDirForPendingUpdate);
  const path = resolve(pendingDirectory, STAGED_UPDATE_INFO_FILE);
  const bytes = await readFile(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (bytes === undefined) return undefined;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.byteLength ||
    info.size === 0 || info.size > MAXIMUM_STAGED_INFO_BYTES || !samePath(await realpath(path), path)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const staged = parsePersistedStagedUpdate(value);
  if (staged === undefined || staged.platform !== platform ||
    (feedSha256 !== undefined && staged.feedSha256 !== feedSha256)) return undefined;
  const installer = await inspectVerifiedStagedFile(
    resolve(pendingDirectory, staged.installer.fileName),
    pendingDirectory,
    staged.installer.sha512
  ).catch(() => undefined);
  if (installer === undefined || installer.size !== staged.installer.size) return undefined;
  if (staged.packageFile !== undefined) {
    const packageFile = await inspectVerifiedStagedFile(
      resolve(pendingDirectory, staged.packageFile.fileName),
      pendingDirectory,
      staged.packageFile.sha512
    ).catch(() => undefined);
    if (packageFile === undefined || packageFile.size !== staged.packageFile.size) return undefined;
  }
  const electronInfo = await readSmallJson(resolve(pendingDirectory, "update-info.json")).catch(() => undefined);
  if (electronInfo?.["fileName"] !== staged.installer.fileName || electronInfo["sha512"] !== staged.installer.sha512) {
    return undefined;
  }
  const quarantined = await hasDurableQuarantineMarker(pendingDirectory);
  return quarantined && staged.eligible ? { ...staged, eligible: false } : staged;
}

function quarantineMarkerBytes(staged: Pick<PersistedStagedUpdate, "feedSha256" | "version">): Buffer {
  return Buffer.from(`joko-staged-update-quarantine-v1:${staged.feedSha256}:${staged.version}\n`, "utf8");
}

async function hasDurableQuarantineMarker(
  pendingDirectory: string
): Promise<boolean> {
  const path = resolve(pendingDirectory, STAGED_UPDATE_QUARANTINE_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAXIMUM_STAGED_INFO_BYTES ||
      !samePath(await realpath(path), path)) return true;
    await readFile(path);
    // Any marker is a revocation fence. Malformed or stale content must fail
    // closed rather than re-enable an installer after a partial write.
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function hydrateDownloadHelper(helper: InternalDownloadedUpdateHelper, staged: PersistedStagedUpdate): void {
  const pendingDirectory = resolve(helper.cacheDirForPendingUpdate);
  const installerPath = resolve(pendingDirectory, staged.installer.fileName);
  const packagePath = staged.packageFile === undefined
    ? null
    : resolve(pendingDirectory, staged.packageFile.fileName);
  const resolvedFileInfo = {
    url: new URL(`https://updates.invalid/${encodeURIComponent(staged.installer.fileName)}`),
    info: {
      url: staged.installer.fileName,
      sha512: staged.installer.sha512,
      size: staged.installer.size,
      isAdminRightsRequired: staged.installer.isAdminRightsRequired
    },
    ...(staged.packageFile === undefined ? {} : {
      packageInfo: {
        path: staged.packageFile.fileName,
        sha512: staged.packageFile.sha512
      }
    })
  };
  helper._file = installerPath;
  helper._packageFile = packagePath;
  helper._downloadedFileInfo = {
    fileName: staged.installer.fileName,
    sha512: staged.installer.sha512,
    isAdminRightsRequired: staged.installer.isAdminRightsRequired
  };
  helper.versionInfo = {
    version: staged.version,
    files: [{
      url: staged.installer.fileName,
      sha512: staged.installer.sha512,
      size: staged.installer.size
    }]
  };
  helper.fileInfo = resolvedFileInfo;
}

async function hydrateMacUpdateProxy(
  updater: AppUpdater,
  staged: PersistedStagedUpdate,
  installerPath: string
): Promise<void> {
  const internal = updater as unknown as {
    readonly updateDownloaded?: (fileInfo: unknown, event: unknown) => Promise<unknown>;
    readonly downloadedUpdateHelper?: InternalDownloadedUpdateHelper | null;
  };
  if (typeof internal.updateDownloaded !== "function") {
    throw new Error("The audited macOS updater cannot restore its local install proxy.");
  }
  const helper = internal.downloadedUpdateHelper;
  if (helper === undefined || helper === null) throw new Error("The audited macOS updater helper is unavailable.");
  await internal.updateDownloaded.call(updater, helper.fileInfo, {
    version: staged.version,
    files: [{
      url: staged.installer.fileName,
      sha512: staged.installer.sha512,
      size: staged.installer.size
    }],
    downloadedFile: installerPath
  });
}

async function inspectVerifiedStagedFile(
  path: string,
  pendingDirectory: string,
  expectedSha512: string
): Promise<PersistedStagedFile> {
  const normalizedPath = resolve(path);
  if (!samePath(dirname(normalizedPath), pendingDirectory) || !isSafeStagedFileName(basename(normalizedPath))) {
    throw new Error("Desktop update file escaped its pending directory.");
  }
  const before = await lstat(normalizedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAXIMUM_STAGED_FILE_BYTES) {
    throw new Error("Desktop update file is missing or unsafe.");
  }
  if (!samePath(await realpath(normalizedPath), normalizedPath)) {
    throw new Error("Desktop update file path is not canonical.");
  }
  const digest = await hashFileSha512(normalizedPath);
  const after = await lstat(normalizedPath);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    !samePath(await realpath(normalizedPath), normalizedPath) ||
    !secureStringEqual(digest, expectedSha512)) {
    throw new Error("Desktop update file changed or failed SHA-512 verification.");
  }
  return { fileName: basename(normalizedPath), sha512: expectedSha512, size: after.size };
}

async function hashFileSha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

async function readSmallJson(path: string): Promise<Record<string, unknown> | undefined> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_STAGED_INFO_BYTES) return undefined;
  try {
    return asRecord(JSON.parse(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

function parsePersistedStagedUpdate(value: unknown): PersistedStagedUpdate | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const expectedTopLevel = [
    "electronUpdaterVersion",
    "eligible",
    "feedSha256",
    "installer",
    ...(record["packageFile"] === undefined ? [] : ["packageFile"]),
    "platform",
    "schema",
    "version"
  ];
  if (!hasExactKeys(record, expectedTopLevel) || record["schema"] !== 1 ||
    record["electronUpdaterVersion"] !== ELECTRON_UPDATER_RUNTIME_VERSION ||
    !isSupportedUpdatePlatform(record["platform"]) ||
    typeof record["feedSha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(record["feedSha256"]) ||
    typeof record["eligible"] !== "boolean" ||
    typeof record["version"] !== "string" || compareDesktopUpdateVersions(record["version"], record["version"]) !== 0) {
    return undefined;
  }
  const installer = parsePersistedStagedFile(record["installer"], true);
  const packageFile = record["packageFile"] === undefined
    ? undefined
    : parsePersistedStagedFile(record["packageFile"], false);
  if (installer === undefined || (record["packageFile"] !== undefined && packageFile === undefined)) return undefined;
  return {
    schema: 1,
    electronUpdaterVersion: ELECTRON_UPDATER_RUNTIME_VERSION,
    platform: record["platform"],
    feedSha256: record["feedSha256"],
    version: record["version"],
    eligible: record["eligible"],
    installer,
    ...(packageFile === undefined ? {} : { packageFile })
  };
}

function parsePersistedStagedFile(
  value: unknown,
  installer: true
): PersistedStagedUpdate["installer"] | undefined;
function parsePersistedStagedFile(value: unknown, installer: false): PersistedStagedFile | undefined;
function parsePersistedStagedFile(
  value: unknown,
  installer: boolean
): PersistedStagedUpdate["installer"] | PersistedStagedFile | undefined {
  const record = asRecord(value);
  const keys = installer
    ? ["fileName", "isAdminRightsRequired", "sha512", "size"]
    : ["fileName", "sha512", "size"];
  if (record === undefined || !hasExactKeys(record, keys) || !isSafeStagedFileName(record["fileName"]) ||
    !isSha512(record["sha512"]) || !Number.isSafeInteger(record["size"]) ||
    (record["size"] as number) <= 0 || (record["size"] as number) > MAXIMUM_STAGED_FILE_BYTES ||
    (installer && typeof record["isAdminRightsRequired"] !== "boolean")) return undefined;
  return {
    fileName: record["fileName"],
    sha512: record["sha512"],
    size: record["size"] as number,
    ...(installer ? { isAdminRightsRequired: record["isAdminRightsRequired"] as boolean } : {})
  };
}

function isSupportedUpdatePlatform(value: unknown): value is "win32" | "darwin" | "linux" {
  return value === "win32" || value === "darwin" || value === "linux";
}

function isSafeStagedFileName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    value !== "." && value !== ".." && !/[\\/\0]/u.test(value) && basename(value) === value;
}

function isSha512(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/u.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function recoverInterruptedStagedUpdate(updater: AppUpdater): Promise<void> {
  const helper = await internalDownloadHelper(updater);
  if (helper === undefined) return;
  const pendingDirectory = resolve(helper.cacheDirForPendingUpdate);
  const parentDirectory = dirname(pendingDirectory);
  const entries = await readdir(parentDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const rollbackEntries = entries.filter((entry) => entry.name.startsWith(ROLLBACK_DIRECTORY_PREFIX));
  if (rollbackEntries.length > 1) throw new Error("Multiple interrupted Desktop update rollbacks were found.");
  const rollbackEntry = rollbackEntries[0];
  if (rollbackEntry !== undefined) {
    if (!rollbackEntry.isDirectory() || rollbackEntry.isSymbolicLink()) {
      throw new Error("The interrupted Desktop update rollback is unsafe.");
    }
    const rollbackDirectory = resolve(parentDirectory, rollbackEntry.name);
    if (dirname(rollbackDirectory) !== parentDirectory || rollbackDirectory === pendingDirectory) {
      throw new Error("The interrupted Desktop update rollback path is unsafe.");
    }
    const markerPath = resolve(rollbackDirectory, ROLLBACK_MARKER_FILE);
    const markerInfo = await lstat(markerPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (markerInfo !== undefined && (!markerInfo.isFile() || markerInfo.isSymbolicLink() ||
      !samePath(await realpath(markerPath), markerPath))) {
      throw new Error("The interrupted Desktop update rollback marker is unsafe.");
    }
    const marker = markerInfo === undefined ? undefined : await readFile(markerPath, "utf8");
    if (marker === undefined) {
      // Marker removal is the durable superseding commit point. This is only
      // cleanup debris, possibly partial; keep the authoritative new pending.
      await rm(rollbackDirectory, { recursive: true, force: true });
      await rm(resolve(pendingDirectory, ROLLBACK_MARKER_FILE), { force: true });
      return;
    }
    if (marker !== ROLLBACK_MARKER_CONTENT) throw new Error("The interrupted Desktop update rollback marker is invalid.");
    await rm(pendingDirectory, { recursive: true, force: true });
    await rename(rollbackDirectory, pendingDirectory);
  }
  // A crash between durable marker creation and the directory rename leaves
  // the authoritative pending directory intact; only the marker needs cleanup.
  await rm(resolve(pendingDirectory, ROLLBACK_MARKER_FILE), { force: true }).catch(() => undefined);
}

async function internalDownloadHelper(updater: AppUpdater): Promise<InternalDownloadedUpdateHelper | undefined> {
  const internal = updater as unknown as {
    readonly downloadedUpdateHelper?: InternalDownloadedUpdateHelper | null;
    readonly getOrCreateDownloadHelper?: () => Promise<InternalDownloadedUpdateHelper>;
  };
  if (internal.downloadedUpdateHelper !== undefined && internal.downloadedUpdateHelper !== null) {
    return internal.downloadedUpdateHelper;
  }
  if (typeof internal.getOrCreateDownloadHelper !== "function") return undefined;
  return internal.getOrCreateDownloadHelper.call(updater);
}
