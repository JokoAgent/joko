import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, type Stats
} from "node:fs";
import { access, copyFile, lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

interface AppImageReplacement {
  readonly install: (relaunch: (path: string) => boolean) => void;
  readonly dispose: () => Promise<void>;
}

export interface LinuxAppImageInstallation {
  readonly path: string;
  readonly accepts: (path: string) => Promise<boolean>;
  readonly prepare: (file: { path: string; size: number; sha512: string }) => Promise<AppImageReplacement>;
}

/** Opens only the current, user-owned AppImage. Unpacked and system installs stay manual. */
export async function openLinuxAppImageInstallation(options: {
  readonly imagePath?: string;
  readonly mountPath?: string;
  readonly resourcesPath: string;
}): Promise<LinuxAppImageInstallation | undefined> {
  const uid = process.getuid?.();
  const { imagePath, mountPath, resourcesPath } = options;
  if (process.platform !== "linux" || uid === undefined || uid === 0 || imagePath === undefined ||
    mountPath === undefined || !isAbsolute(imagePath) || !isAbsolute(mountPath)) return undefined;

  try {
    const parentPath = dirname(imagePath);
    const [canonical, mount, resources, original, parent] = await Promise.all([
      realpath(imagePath), realpath(mountPath), realpath(resourcesPath), lstat(imagePath), lstat(parentPath)
    ]);
    const relativeResources = relative(mount, resources);
    if (canonical !== imagePath || mount !== mountPath || relativeResources === "" || relativeResources === ".." ||
      relativeResources.startsWith(`..${sep}`) || isAbsolute(relativeResources) ||
      !original.isFile() || original.uid !== uid || (original.mode & 0o6022) !== 0 ||
      !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) return undefined;
    await access(imagePath, constants.R_OK | constants.X_OK);
    await access(parentPath, constants.W_OK | constants.X_OK);

    const executable = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let architecture: number | undefined;
    try {
      if (!sameFile(original, await executable.stat())) return undefined;
      architecture = await readAppImageArchitecture(executable);
    } finally {
      await executable.close();
    }
    if (architecture === undefined) return undefined;
    return {
      path: imagePath,
      accepts: async path => {
        if (!path.endsWith(".AppImage")) return false;
        const candidate = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          return (await candidate.stat()).isFile() && await readAppImageArchitecture(candidate) === architecture;
        } finally {
          await candidate.close();
        }
      },
      prepare: file => prepareReplacement({ imagePath, parentPath, original, parent, architecture }, file)
    };
  } catch {
    return undefined;
  }
}

async function prepareReplacement(
  installation: { imagePath: string; parentPath: string; original: Stats; parent: Stats; architecture: number },
  file: { path: string; size: number; sha512: string }
): Promise<AppImageReplacement> {
  const { imagePath, parentPath, original, parent, architecture } = installation;
  const currentParent = await lstat(parentPath);
  if (!sameDirectory(parent, currentParent) || await realpath(parentPath) !== parentPath ||
    !sameFile(original, await lstat(imagePath))) throw new Error("Desktop AppImage path changed before staging.");
  const directory = await mkdtemp(join(parentPath, ".joko-appimage-update-"));
  const stagingDirectory = await lstat(directory);
  const stagedPath = join(directory, "replacement");
  const rollbackPath = join(directory, "previous");
  let keepRollback = false;
  const dispose = async (): Promise<void> => {
    if (keepRollback) return;
    const current = await lstat(directory).catch(() => undefined);
    if (current === undefined || !sameDirectory(stagingDirectory, current)) return;
    await unlink(stagedPath).catch(() => undefined);
    await unlink(rollbackPath).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  };

  try {
    await copyFile(file.path, stagedPath, constants.COPYFILE_EXCL);
    const staged = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let prepared: Stats;
    try {
      const before = await staged.stat();
      if (before.size !== file.size || await readAppImageArchitecture(staged) !== architecture) {
        throw new Error("Desktop update is not a matching AppImage.");
      }
      const hash = createHash("sha512");
      for await (const chunk of staged.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
      if (hash.digest("base64") !== file.sha512 || !sameFile(before, await staged.stat())) {
        throw new Error("Desktop update AppImage could not be verified.");
      }
      await staged.chmod(original.mode & 0o755);
      await staged.sync();
      prepared = await staged.stat();
    } finally {
      await staged.close();
    }

    return {
      dispose,
      install: relaunch => {
        const parentFd = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (!sameDirectory(parent, fstatSync(parentFd)) || realpathSync(parentPath) !== parentPath ||
            !sameDirectory(stagingDirectory, lstatSync(directory)) ||
            !sameFile(original, lstatSync(imagePath)) || !sameFile(prepared, lstatSync(stagedPath))) {
            throw new Error("Desktop update AppImage path changed before apply.");
          }
          linkSync(imagePath, rollbackPath);
          if (!sameFile(original, lstatSync(rollbackPath)) || !sameFile(original, lstatSync(imagePath))) {
            throw new Error("Desktop AppImage changed before apply.");
          }
          // Both names are on the same filesystem. An interruption can leave
          // either verified executable at the original path, with no missing-file window.
          renameSync(stagedPath, imagePath);
          try {
            fsyncSync(parentFd);
            if (!relaunch(imagePath)) throw new Error("Desktop AppImage relaunch was not accepted.");
          } catch (error) {
            keepRollback = true;
            if (!sameFile(prepared, lstatSync(imagePath))) throw error;
            renameSync(rollbackPath, imagePath);
            keepRollback = false;
            fsyncSync(parentFd);
            throw error;
          }
          // Electron may exit before an asynchronous cleanup can finish.
          try {
            unlinkSync(rollbackPath);
            rmdirSync(directory);
          } catch { /* The staging directory can also be removed by dispose. */ }
        } finally {
          closeSync(parentFd);
        }
      }
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function readAppImageArchitecture(file: FileHandle): Promise<number | undefined> {
  const header = Buffer.alloc(20);
  if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
    header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1 ||
    header.readUInt16BE(8) !== 0x4149 || header[10] !== 2) return undefined;
  return header.readUInt16LE(18);
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && sameInode(left, right) && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.mtimeMs === right.mtimeMs;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return right.isDirectory() && sameInode(left, right) && left.mode === right.mode && left.uid === right.uid;
}
