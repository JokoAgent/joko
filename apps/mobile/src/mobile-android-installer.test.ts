import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, { bytes: Uint8Array; modificationTime: number }>();
  const put = (uri: string, bytes: Uint8Array) => files.set(uri, { bytes, modificationTime: Date.now() / 1000 });
  const native = {
    isSupported: vi.fn(() => true),
    installerPackageName: vi.fn<() => string | null>(() => null),
    hasPermission: vi.fn(async () => true),
    requestPermission: vi.fn(async () => true),
    install: vi.fn(async (_uri: string, _version: string) => undefined),
  };
  return {
    native,
    state: { currentState: 'active' },
    appStateListener: undefined as ((state: string) => void) | undefined,
    onProgress: undefined as ((data: { bytesWritten: number; totalBytes: number }) => void) | undefined,
    file: '',
    files, put,
    download: vi.fn<(_url: string, _path: string) => Promise<Uint8Array | null>>(),
    resume: vi.fn<(_url: string, _path: string, _offset: number) => Promise<Uint8Array | null>>(),
    pause: vi.fn<() => void>(),
    release: vi.fn(),
    remove: vi.fn(async (uri: string) => { files.delete(uri); }),
    copy: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const source = files.get(from);
      if (!source) throw new Error('Missing download');
      put(to, source.bytes.slice());
    }),
    move: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const source = files.get(from);
      if (!source) throw new Error('Missing download');
      put(to, source.bytes); files.delete(from);
    }),
    unsubscribe: vi.fn(),
    browser: vi.fn(async () => undefined),
  };
});
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return mocks.state.currentState; },
    addEventListener: (_name: string, callback: (state: string) => void) => {
      mocks.appStateListener = callback;
      return { remove: mocks.unsubscribe };
    },
  },
  Linking: { openURL: mocks.browser },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async (directory: string) => [...mocks.files.keys()].filter(uri => uri.startsWith(directory)).map(uri => uri.slice(directory.length))),
  getInfoAsync: vi.fn(async (uri: string) => {
    const file = mocks.files.get(uri);
    return file ? { exists: true, isDirectory: false, size: file.bytes.byteLength, modificationTime: file.modificationTime } : { exists: false };
  }),
  deleteAsync: mocks.remove,
  copyAsync: mocks.copy,
  moveAsync: mocks.move,
}));
vi.mock('expo-file-system', () => {
  class File {
    constructor(readonly uri: string) {}
    get size() { return mocks.files.get(this.uri)?.bytes.byteLength ?? 0; }
  }
  class DownloadTask {
    state = 'idle';
    private offset = 0;
    private running?: Promise<File | null>;

    constructor(readonly url: string, readonly destination: File, options: { onProgress: typeof mocks.onProgress }) {
      mocks.file = this.destination.uri;
      mocks.onProgress = options.onProgress;
    }
    static fromSavable(state: { url: string; fileUri: string; resumeData: string }, options: { onProgress: typeof mocks.onProgress }) {
      const task = new DownloadTask(state.url, new File(state.fileUri), options);
      task.state = 'paused';
      task.offset = Number(state.resumeData);
      return task;
    }
    downloadAsync() { return this.begin(mocks.download(this.url, this.destination.uri)); }
    resumeAsync() { return this.begin(mocks.resume(this.url, this.destination.uri, this.offset)); }
    async pauseAsync() { mocks.pause(); await this.running; }
    release() { mocks.release(); }

    private begin(body: Promise<Uint8Array | null>) {
      this.state = 'active';
      this.running = body.then(bytes => {
        if (!bytes) { this.state = 'paused'; return null; }
        const before = mocks.files.get(this.destination.uri)?.bytes ?? new Uint8Array();
        mocks.put(this.destination.uri, Uint8Array.from([...before.slice(0, this.offset), ...bytes]));
        this.state = 'completed';
        return this.destination;
      });
      return this.running;
    }
  }
  return { File, DownloadTask };
});
import { isMobileGooglePlayInstallation, mobileAndroidInstaller } from './mobile-android-installer';
const target = { installUrl: 'https://updates.example.invalid/app.apk', version: '1.2.3' };
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function holdDownload() {
  let finish!: (value: Uint8Array | null) => void;
  const pending = new Promise<Uint8Array | null>(resolve => { finish = resolve; });
  mocks.download.mockReturnValueOnce(pending);
  return finish;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.state.currentState = 'active';
  mocks.native.installerPackageName.mockReturnValue(null);
  mocks.download.mockResolvedValue(Uint8Array.of(1, 2, 3));
  mocks.resume.mockResolvedValue(Uint8Array.of(3));
  mocks.pause.mockImplementation(() => undefined);
});
afterEach(async () => {
  mobileAndroidInstaller.close();
  await settle();
  vi.useRealTimers();
});

describe('Android installer IO', () => {
  it('reads the installed Google Play source independently of JS update configuration', () => {
    expect(isMobileGooglePlayInstallation()).toBe(false);
    mocks.native.installerPackageName.mockReturnValue('com.android.vending');
    expect(isMobileGooglePlayInstallation()).toBe(true);
    mocks.native.installerPackageName.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(isMobileGooglePlayInstallation()).toBe(false);
  });
  it('reuses the exact completed cache after closing and gives each installer its own immutable copy', async () => {
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.file).toMatch(/^file:\/\/\/cache\/joko-updates\/update-partial-[a-f0-9]{64}\.apk$/);
    const first = mocks.native.install.mock.calls[0]?.[0];
    expect(first).toMatch(/^file:\/\/\/cache\/joko-updates\/update-[0-9]+-[a-z0-9]+\.apk$/);
    expect(mocks.native.install).toHaveBeenCalledWith(first, target.version);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('ready');
    mocks.onProgress!({ bytesWritten: 100, totalBytes: 100 });
    expect(vi.getTimerCount()).toBe(0);
    mobileAndroidInstaller.close();
    expect(mocks.remove).not.toHaveBeenCalled();
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.resume).not.toHaveBeenCalled();
    const second = mocks.native.install.mock.calls[1]?.[0];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(mocks.files.get(first!)?.bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(mocks.files.get(second!)?.bytes).toEqual(mocks.files.get(first!)?.bytes);
  });

  it('resumes the original disk bytes only after the cancelled writer has settled', async () => {
    const finish = holdDownload();
    mobileAndroidInstaller.start(target);
    await settle();
    const partial = mocks.file;
    mocks.put(partial, Uint8Array.of(1));
    mobileAndroidInstaller.close();
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.native.install).not.toHaveBeenCalled();

    // The final durable byte can arrive before the native writer finishes pausing.
    mocks.put(partial, Uint8Array.of(1, 2));
    finish(null);
    await settle();
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(target.installUrl, partial, 2);
    expect(mocks.download).toHaveBeenCalledOnce();
    const handoff = mocks.native.install.mock.calls[0]?.[0];
    expect(mocks.files.get(handoff!)?.bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('ready');
  });

  it.each([{ ...target, version: '1.2.4' }, { ...target, installUrl: 'https://updates.example.invalid/mirror.apk' }])(
    'does not attach partial bytes to another update identity (%j)', async replacement => {
      const finish = holdDownload();
      mocks.pause.mockImplementation(() => finish(null));
      mobileAndroidInstaller.start(target);
      await settle();
      const partial = mocks.file;
      mocks.put(partial, Uint8Array.of(7, 8));
      mobileAndroidInstaller.close();
      mobileAndroidInstaller.start(replacement);
      await settle();
      expect(mocks.resume).not.toHaveBeenCalled();
      expect(mocks.download).toHaveBeenNthCalledWith(2, replacement.installUrl, expect.any(String));
      expect(mocks.file).not.toBe(partial);
      expect(mocks.native.install.mock.calls[0]?.[1]).toBe(replacement.version);
    }
  );

  it('restarts once from zero when the server rejects the retained offset', async () => {
    const finish = holdDownload();
    mocks.pause.mockImplementation(() => finish(null));
    mocks.resume.mockRejectedValueOnce(new Error('Unable to download: HTTP 416'));
    mobileAndroidInstaller.start(target);
    await settle();
    const partial = mocks.file;
    mocks.put(partial, Uint8Array.of(9, 8));
    mobileAndroidInstaller.close();
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(target.installUrl, partial, 2);
    expect(mocks.remove).toHaveBeenCalledWith(partial, { idempotent: true });
    expect(mocks.download).toHaveBeenCalledTimes(2);
    const handoff = mocks.native.install.mock.calls[0]?.[0];
    expect(mocks.files.get(handoff!)?.bytes).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('discards a rejected cached archive and checks the new handoff on retry', async () => {
    mocks.native.install.mockRejectedValueOnce(new Error('APK does not match the selected update'));
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('error');
    expect(mocks.remove).toHaveBeenCalledWith(expect.stringMatching(/update-ready-[a-f0-9]{64}\.apk$/), { idempotent: true });
    mobileAndroidInstaller.retry();
    await settle();
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.native.install).toHaveBeenCalledTimes(2);
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('ready');
  });

  it('HTTP failures never launch installation and remove partial bytes', async () => {
    mocks.download.mockRejectedValueOnce(new Error('HTTP 503'));
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('error');
  });

  it('stalled downloads time out, pause the native transfer and expose browser fallback', async () => {
    const finish = holdDownload();
    mocks.pause.mockImplementation(() => finish(null));
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('downloading');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith(mocks.file, { idempotent: true });
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('error');
    await mobileAndroidInstaller.browser();
    expect(mocks.browser).toHaveBeenCalledWith(target.installUrl);
  });

  it('reports unknown length without fake percentages; progress keeps a live download running', async () => {
    const finish = holdDownload();
    mocks.pause.mockImplementation(() => finish(null));
    mobileAndroidInstaller.start(target);
    await settle();
    mocks.onProgress!({ bytesWritten: 20, totalBytes: -1 });
    expect(mobileAndroidInstaller.getSnapshot().progress).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    mocks.onProgress!({ bytesWritten: 50, totalBytes: 100 });
    expect(mobileAndroidInstaller.getSnapshot().progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('downloading');
    mobileAndroidInstaller.close();
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('does not open installation over another app; resuming launches the downloaded update', async () => {
    mocks.state.currentState = 'background';
    mobileAndroidInstaller.start(target);
    await settle();
    expect(mocks.native.install).not.toHaveBeenCalled();
    mocks.state.currentState = 'active';
    mocks.appStateListener!('active');
    await settle();
    expect(mocks.native.install).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('cancelling a background handoff removes the listener and prevents later installation', async () => {
    mocks.state.currentState = 'background';
    mobileAndroidInstaller.start(target);
    await settle();
    mobileAndroidInstaller.close();
    await settle();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.native.install).not.toHaveBeenCalled();
    expect(mobileAndroidInstaller.getSnapshot().phase).toBe('idle');
  });
});
