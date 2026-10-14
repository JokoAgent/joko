import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface DesktopUserDataDirectoryOptions {
  readonly packaged: boolean;
  readonly appDataDirectory: string;
  readonly packagedSmoke: boolean;
  readonly packagedSmokeDirectory?: string;
}

/**
 * Development uses its own persistent Electron profile so unreleased local
 * state never collides with the packaged application's user data.
 */
export function resolveDesktopUserDataDirectory(
  options: DesktopUserDataDirectoryOptions
): string | undefined {
  if (options.packagedSmoke && options.packagedSmokeDirectory !== undefined) {
    return resolve(options.packagedSmokeDirectory);
  }
  return options.packaged
    ? undefined
    : resolve(options.appDataDirectory, "Joko Development");
}

/**
 * Create the selected profile root and resolve Windows package virtualization
 * before Electron derives security-sensitive child paths from it.
 */
export function prepareDesktopUserDataDirectory(directory: string): string {
  const normalized = resolve(directory);
  if (!isAbsolute(directory) || normalized !== directory) {
    throw new Error("The Desktop user-data directory must be normalized and absolute.");
  }
  mkdirSync(normalized, { recursive: true });
  return realpathSync.native(normalized);
}

export function prepareDesktopManagedWorkspaceDirectory(options: {
  readonly packagedSmoke: boolean;
  readonly userDataDirectory: string;
  readonly documentsDirectory: string;
}): string {
  if (!options.packagedSmoke) return options.documentsDirectory;
  const profile = prepareDesktopUserDataDirectory(options.userDataDirectory);
  const workspace = prepareDesktopUserDataDirectory(resolve(profile, "smoke-workspace"));
  const parent = dirname(workspace);
  const contained = process.platform === "win32"
    ? parent.toLowerCase() === profile.toLowerCase()
    : parent === profile;
  if (!contained) throw new Error("The Desktop smoke workspace must remain inside its isolated profile.");
  return workspace;
}
