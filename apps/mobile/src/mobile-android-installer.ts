import { AppState, Linking, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { DownloadTask, File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MobileAndroidInstallController, type MobileAndroidInstallTarget } from './mobile-android-install-controller';

interface NativeInstaller {
  isSupported(): boolean;
  installerPackageName(): string | null;
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  install(file: string, version: string): Promise<void>;
}
const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeInstaller>('JokoAppInstaller') : null;

/** Installation source belongs to the installed binary, never mutable OTA extras. */
export function isMobileGooglePlayInstallation(): boolean {
  try { return native?.installerPackageName() === 'com.android.vending'; }
  catch { return false; }
}

function abortError(): Error { return new Error('Update download cancelled'); }

const CACHE_LIFETIME_SECONDS = 24 * 60 * 60;
const DOWNLOAD_IDLE_TIMEOUT_MS = 90_000;
let cacheTail: Promise<unknown> = Promise.resolve();

function withUpdateCache<T>(action: () => Promise<T>): Promise<T> {
  const next = cacheTail.then(action);
  cacheTail = next.catch(() => undefined);
  return next;
}

function updateCachePaths(target: MobileAndroidInstallTarget) {
  if (!FileSystem.cacheDirectory) throw new Error('Cache unavailable');
  const directory = `${FileSystem.cacheDirectory}joko-updates/`;
  const key = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([target.installUrl, target.version]))));
  return { directory, partial: `${directory}update-partial-${key}.apk`, ready: `${directory}update-ready-${key}.apk` };
}

async function removeCacheFile(file: string): Promise<void> {
  await FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
}

function cacheFileExpired(modificationTime: number): boolean {
  return Date.now() / 1000 - modificationTime > CACHE_LIFETIME_SECONDS;
}

/** Never raise an installer over another app when a download finishes in the background. */
async function waitForForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (AppState.currentState === 'active') return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { subscription.remove(); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') { cleanup(); resolve(); }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function downloadApk(target: MobileAndroidInstallTarget, signal: AbortSignal, progress: (value: number | null) => void): Promise<string> {
  return withUpdateCache(async () => {
    if (signal.aborted) throw abortError();
    const { directory, partial, ready } = updateCachePaths(target);
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    for (const name of await FileSystem.readDirectoryAsync(directory)) {
      if (signal.aborted) throw abortError();
      if (!/^update-(?:[0-9]+-[a-z0-9]+|(?:partial|ready)-[a-f0-9]{64})\.apk$/.test(name)) continue;
      const file = `${directory}${name}`;
      const info = await FileSystem.getInfoAsync(file);
      if (info.exists && !info.isDirectory && cacheFileExpired(info.modificationTime)) {
        await removeCacheFile(file);
      }
    }

    if (signal.aborted) throw abortError();
    const complete = await FileSystem.getInfoAsync(ready);
    if (!complete.exists || complete.isDirectory || complete.size <= 0 || cacheFileExpired(complete.modificationTime)) {
      if (complete.exists && !complete.isDirectory) await FileSystem.deleteAsync(ready, { idempotent: true });
      await transferApk(target.installUrl, partial, signal, progress);
      await FileSystem.moveAsync({ from: partial, to: ready });
    }

    if (signal.aborted) throw abortError();
    // Android may open this URI after the sheet closes, so every handoff has its own file.
    const handoff = `${directory}update-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`;
    try {
      await FileSystem.copyAsync({ from: ready, to: handoff });
      if (signal.aborted) throw abortError();
      return handoff;
    } catch (error) {
      await removeCacheFile(handoff);
      throw error;
    }
  });
}

async function transferApk(url: string, partial: string, signal: AbortSignal, progress: (value: number | null) => void): Promise<void> {
  const info = await FileSystem.getInfoAsync(partial);
  let offset = 0;
  if (info.exists && !info.isDirectory) {
    if (cacheFileExpired(info.modificationTime)) await FileSystem.deleteAsync(partial, { idempotent: true });
    else if (Number.isSafeInteger(info.size) && info.size > 0) offset = info.size;
  }
  for (;;) {
    if (signal.aborted) throw abortError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pause: Promise<void> | undefined;
    let timedOut = false;
    let finished = false;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; stop(); }, DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    const options = { onProgress: ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) => {
      if (signal.aborted || timedOut || finished) return;
      armTimeout();
      progress(totalBytes > 0 ? Math.min(1, Math.max(0, bytesWritten / totalBytes)) : null);
    } };
    // The pinned Android downloader appends only a 206 and replaces the partial on a full response.
    const task = offset > 0
      ? DownloadTask.fromSavable({ url, fileUri: partial, isDirectory: false, resumeData: String(offset) }, options)
      : new DownloadTask(url, new File(partial), options);
    const stop = () => {
      if (task.state === 'active' && !pause) pause = task.pauseAsync().catch(() => undefined);
    };
    signal.addEventListener('abort', stop, { once: true });
    armTimeout();
    try {
      const result = await (offset > 0 ? task.resumeAsync() : task.downloadAsync());
      if (timedOut) throw new Error('APK download stalled');
      if (!result || result.uri !== partial || result.size <= 0) throw new Error('APK download failed');
      return;
    } catch (error) {
      if (signal.aborted && !timedOut) throw abortError();
      await pause;
      await removeCacheFile(partial);
      if (offset > 0 && /HTTP 416\b/u.test(String(error))) { offset = 0; continue; }
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      // The next opener must observe the disk offset after the previous writer stops.
      await pause;
      task.release();
    }
  }
}

export const mobileAndroidInstaller = new MobileAndroidInstallController({
  supported: () => native?.isSupported() === true,
  hasPermission: () => native!.hasPermission(),
  requestPermission: () => native!.requestPermission(),
  download: downloadApk,
  install: async (file, target, signal) => {
    try {
      await waitForForeground(signal);
      await withUpdateCache(async () => {
        await waitForForeground(signal);
        if (signal.aborted) throw abortError();
        try { await native!.install(file, target.version); }
        catch (error) {
          await removeCacheFile(updateCachePaths(target).ready);
          throw error;
        }
      });
    } catch (error) {
      if (signal.aborted) await removeCacheFile(file);
      throw error;
    }
  },
  remove: (file) => FileSystem.deleteAsync(file, { idempotent: true }),
  openBrowser: (url) => Linking.openURL(url),
});
