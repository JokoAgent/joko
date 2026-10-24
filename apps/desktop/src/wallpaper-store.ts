import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, renameSync } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DesktopWallpaperSettings, DesktopWallpaperSettingsChange } from "./channels.js";
import { ensurePrivateDirectory, readPrivateFile, readRegularFileSnapshot } from "@joko/device-peer/private-files";
import { DesktopWallpaperError, WALLPAPER_MAXIMUM_BYTES, assertStoredWallpaperImage, desktopWallpaperImageUrl, prepareWallpaperImage, validDimension, validWallpaperImageId } from "./wallpaper-image.js";

type Image = NonNullable<DesktopWallpaperSettings["customImage"]>;
interface PersistedSettings { readonly version: 1; readonly revision: number; readonly mode: "none" | "custom";
  readonly maskOpacity: number; readonly customImage: Omit<Image, "url"> | null }
export interface DesktopWallpaperStoreOptions {
  readonly directory: string;
  /** Private file port: the writer must execute beforeCommit immediately before atomic rename. */
  readonly writeSettings?: (path: string, bytes: Uint8Array, beforeCommit: () => void) => Promise<void>;
}

/** One device-local writer; media and source paths never enter its public projection. */
export class DesktopWallpaperStore {
  readonly #directory: string;
  readonly #mediaDirectory: string;
  readonly #settingsPath: string;
  readonly #writer: NonNullable<DesktopWallpaperStoreOptions["writeSettings"]>;
  readonly #listeners = new Set<(settings: DesktopWallpaperSettings) => void>();
  #tail = Promise.resolve();
  #value: DesktopWallpaperSettings = projection({ version: 1, revision: 1, mode: "none", maskOpacity: 0.2, customImage: null });
  #initialized = false;
  #directoryIdentity: string | undefined;
  #mediaIdentity: string | undefined;

  constructor(options: DesktopWallpaperStoreOptions) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) throw new DesktopWallpaperError("UNAVAILABLE");
    this.#directory = options.directory; this.#mediaDirectory = join(options.directory, "images");
    this.#settingsPath = join(options.directory, "settings.json"); this.#writer = options.writeSettings ?? writeWallpaperSettings;
  }
  initialize(): Promise<DesktopWallpaperSettings> { return this.#enqueue(async () => { await this.#load(); return this.#value; }); }
  get(): DesktopWallpaperSettings { return this.#value; }
  onChanged(listener: (settings: DesktopWallpaperSettings) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  set(change: DesktopWallpaperSettingsChange, assertCurrent: () => void = () => undefined): Promise<DesktopWallpaperSettings> {
    return this.#enqueue(async () => {
      await this.#admit(change.expectedRevision, assertCurrent);
      if (!exactKeys(change, ["expectedRevision"], ["mode", "maskOpacity"])
        || change.mode !== undefined && change.mode !== "none" && change.mode !== "custom"
        || change.maskOpacity !== undefined && !validOpacity(change.maskOpacity)
        || change.mode === "custom" && this.#value.customImage === null) throw new DesktopWallpaperError("UNAVAILABLE");
      return this.#commit({ ...persisted(this.#value), mode: change.mode ?? this.#value.mode,
        maskOpacity: change.maskOpacity ?? this.#value.maskOpacity }, assertCurrent);
    });
  }
  importFromSelectedFile(path: string, expectedRevision: number, assertCurrent: () => void = () => undefined): Promise<DesktopWallpaperSettings> {
    return this.#enqueue(async () => {
      await this.#admit(expectedRevision, assertCurrent);
      let selected: Uint8Array;
      try { selected = await readRegularFileSnapshot(path, WALLPAPER_MAXIMUM_BYTES); }
      catch { throw new DesktopWallpaperError("INVALID_IMAGE"); }
      assertCurrent();
      const image = await prepareWallpaperImage(selected); assertCurrent(); await this.#assertDirectories(); assertCurrent();
      const id = hash(image.bytes), destination = join(this.#mediaDirectory, `${id}.webp`);
      const existing = await lstat(destination).catch(missing);
      if (existing === undefined) await writeWallpaperSettings(destination, image.bytes, () => { this.#assertDirectoriesSync(); assertCurrent(); });
      else if (!existing.isFile() || existing.isSymbolicLink() || hash(await readRegularFileSnapshot(destination, WALLPAPER_MAXIMUM_BYTES)) !== id) {
        throw new DesktopWallpaperError("UNAVAILABLE");
      }
      await this.#assertDirectories(); assertCurrent();
      const customImage = { id, width: image.width, height: image.height };
      return this.#commit({ ...persisted(this.#value), mode: "custom", customImage }, assertCurrent);
    });
  }
  remove(expectedRevision: number, assertCurrent: () => void = () => undefined): Promise<DesktopWallpaperSettings> {
    return this.#enqueue(async () => { await this.#admit(expectedRevision, assertCurrent);
      return this.#commit({ ...persisted(this.#value), mode: "none", customImage: null }, assertCurrent); });
  }
  reset(expectedRevision: number, assertCurrent: () => void = () => undefined): Promise<DesktopWallpaperSettings> {
    return this.#enqueue(async () => { await this.#admit(expectedRevision, assertCurrent);
      return this.#commit({ ...persisted(this.#value), mode: "none", maskOpacity: 0.2 }, assertCurrent); });
  }
  async readImage(id: string): Promise<Uint8Array> {
    if (!this.#initialized || !validWallpaperImageId(id) || this.#value.customImage?.id !== id) throw new DesktopWallpaperError("UNAVAILABLE");
    const image = this.#value.customImage; await this.#assertDirectories();
    const bytes = await readRegularFileSnapshot(join(this.#mediaDirectory, `${id}.webp`), WALLPAPER_MAXIMUM_BYTES);
    await this.#assertDirectories();
    if (this.#value.customImage?.id !== image.id || hash(bytes) !== id || !isWebp(bytes)) throw new DesktopWallpaperError("UNAVAILABLE");
    return bytes;
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation).catch((error: unknown) => {
      if (error instanceof DesktopWallpaperError) throw error;
      throw new DesktopWallpaperError("UNAVAILABLE");
    });
    this.#tail = result.then(() => undefined, () => undefined); return result;
  }
  async #load(): Promise<void> {
    if (!this.#initialized) {
      await ensurePrivateDirectory(this.#directory); await ensurePrivateDirectory(this.#mediaDirectory);
      this.#directoryIdentity = await directoryIdentity(this.#directory); this.#mediaIdentity = await directoryIdentity(this.#mediaDirectory);
    }
    await this.#assertDirectories();
    const bytes = await readPrivateFile(this.#settingsPath); await this.#assertDirectories();
    if (bytes !== undefined) {
      const parsed = parseSettings(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (parsed.customImage !== null) {
        const media = await readRegularFileSnapshot(join(this.#mediaDirectory, `${parsed.customImage.id}.webp`), WALLPAPER_MAXIMUM_BYTES);
        if (hash(media) !== parsed.customImage.id || !isWebp(media)) throw new DesktopWallpaperError("UNAVAILABLE");
        await assertStoredWallpaperImage(media, parsed.customImage.width, parsed.customImage.height);
      }
      await this.#assertDirectories();
      if (this.#initialized && (parsed.revision < this.#value.revision
        || parsed.revision === this.#value.revision && JSON.stringify(parsed) !== JSON.stringify(persisted(this.#value)))) throw new DesktopWallpaperError("UNAVAILABLE");
      this.#value = projection(parsed);
    } else if (this.#initialized && this.#value.revision !== 1) throw new DesktopWallpaperError("UNAVAILABLE");
    this.#initialized = true;
  }
  async #assertDirectories(): Promise<void> {
    if (this.#directoryIdentity !== await directoryIdentity(this.#directory)
      || this.#mediaIdentity !== await directoryIdentity(this.#mediaDirectory)) throw new DesktopWallpaperError("UNAVAILABLE");
  }
  #assertDirectoriesSync(): void {
    if (this.#directoryIdentity !== directoryIdentitySync(this.#directory)
      || this.#mediaIdentity !== directoryIdentitySync(this.#mediaDirectory)) throw new DesktopWallpaperError("UNAVAILABLE");
  }
  async #admit(expectedRevision: number, assertCurrent: () => void): Promise<void> {
    assertCurrent(); await this.#load(); assertCurrent();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== this.#value.revision) {
      throw new DesktopWallpaperError("REVISION_CONFLICT");
    }
  }
  async #commit(next: PersistedSettings, assertCurrent: () => void): Promise<DesktopWallpaperSettings> {
    if (this.#value.revision >= Number.MAX_SAFE_INTEGER) throw new DesktopWallpaperError("UNAVAILABLE");
    const updated = parseSettings({ ...next, revision: this.#value.revision + 1 });
    const bytes = Buffer.from(`${JSON.stringify(updated)}\n`);
    await this.#assertDirectories(); assertCurrent();
    try {
      await this.#writer(this.#settingsPath, bytes, () => { this.#assertDirectoriesSync(); assertCurrent(); });
    } catch (error) {
      // A post-rename failure cannot silently restore an old in-memory record.
      // Readback may prove publication, while the operation still reports failure.
      const observed = await readPrivateFile(this.#settingsPath).catch(() => undefined);
      if (observed !== undefined && Buffer.from(observed).equals(bytes)) {
        await this.#assertDirectories(); this.#publish(updated);
      }
      throw error;
    }
    const observed = await readPrivateFile(this.#settingsPath); await this.#assertDirectories();
    if (observed === undefined || !Buffer.from(observed).equals(bytes)) throw new DesktopWallpaperError("UNAVAILABLE");
    this.#publish(updated);
    // Cleanup failure cannot reverse the confirmed preference or delete the source.
    await this.#collectUnusedImages().catch(() => undefined);
    return this.#value;
  }
  #publish(settings: PersistedSettings): void {
    this.#value = projection(settings);
    for (const listener of this.#listeners) { try { listener(this.#value); } catch { /* Other current observers still receive the committed value. */ } }
  }
  async #collectUnusedImages(): Promise<void> {
    await this.#assertDirectories();
    for (const name of await readdir(this.#mediaDirectory)) {
      const match = /^([a-f0-9]{64})\.webp$/u.exec(name);
      if (!match || match[1] === this.#value.customImage?.id) continue;
      const path = join(this.#mediaDirectory, name);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) continue;
      const bytes = await readRegularFileSnapshot(path, WALLPAPER_MAXIMUM_BYTES);
      if (hash(bytes) !== match[1] || !isWebp(bytes)) continue;
      await this.#assertDirectories();
      const after = await lstat(path);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.isSymbolicLink()) continue;
      await unlink(path);
    }
  }
}

export async function writeWallpaperSettings(path: string, bytes: Uint8Array, beforeCommit: () => void): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const previous = await lstat(path).catch(missing);
    if (previous !== undefined && (!previous.isFile() || previous.isSymbolicLink())) throw new DesktopWallpaperError("UNAVAILABLE");
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (current !== undefined && (!current.isFile() || current.isSymbolicLink())) throw new DesktopWallpaperError("UNAVAILABLE");
    // The owner proof and rename share one synchronous boundary with no queued await.
    beforeCommit(); renameSync(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await handle?.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
function parseSettings(value: unknown): PersistedSettings {
  if (!exactKeys(value, ["version", "revision", "mode", "maskOpacity", "customImage"])) throw new DesktopWallpaperError("UNAVAILABLE");
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || !Number.isSafeInteger(record["revision"]) || (record["revision"] as number) < 1
    || record["mode"] !== "none" && record["mode"] !== "custom" || !validOpacity(record["maskOpacity"])) throw new DesktopWallpaperError("UNAVAILABLE");
  const image = record["customImage"];
  if (image !== null && (!exactKeys(image, ["id", "width", "height"]) || !validWallpaperImageId((image as Record<string, unknown>)["id"])
    || !validDimension((image as Record<string, unknown>)["width"]) || !validDimension((image as Record<string, unknown>)["height"]))) throw new DesktopWallpaperError("UNAVAILABLE");
  if (record["mode"] === "custom" && image === null) throw new DesktopWallpaperError("UNAVAILABLE");
  return { version: 1, revision: record["revision"] as number, mode: record["mode"] as "none" | "custom",
    maskOpacity: record["maskOpacity"] as number, customImage: image === null ? null : {
      id: (image as Image).id, width: (image as Image).width, height: (image as Image).height
    } };
}
function projection(record: PersistedSettings): DesktopWallpaperSettings {
  return Object.freeze({ ...record, customImage: record.customImage === null ? null
    : Object.freeze({ ...record.customImage, url: desktopWallpaperImageUrl(record.customImage.id) }) });
}
function persisted(settings: DesktopWallpaperSettings): PersistedSettings {
  return { ...settings, customImage: settings.customImage === null ? null
    : { id: settings.customImage.id, width: settings.customImage.width, height: settings.customImage.height } };
}
function validOpacity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 0.6 && Math.abs(value * 20 - Math.round(value * 20)) < 1e-8;
}
function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
async function directoryIdentity(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) throw new DesktopWallpaperError("UNAVAILABLE");
  return `${stat.dev}:${stat.ino}`;
}
function directoryIdentitySync(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(path), path)) throw new DesktopWallpaperError("UNAVAILABLE");
  return `${stat.dev}:${stat.ino}`;
}
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try { handle = await open(path, constants.O_RDONLY); await handle.sync(); }
  catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle?.close(); }
}
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function isWebp(bytes: Uint8Array): boolean { const b = Buffer.from(bytes); return b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"; }
function missing(error: unknown): undefined { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
