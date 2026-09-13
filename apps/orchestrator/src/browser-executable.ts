import { accessSync, constants, statSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

export interface BrowserExecutableDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly isExecutableFile?: (path: string) => boolean;
}

/**
 * Resolve an owner override or discover a supported Chromium-family browser.
 *
 * Discovery is deliberately side-effect free and never downloads a binary.
 * The resolved absolute path is still passed to Playwright's normal launch
 * validation, so an executable replaced after discovery fails explicitly.
 */
export function discoverBrowserExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  options: BrowserExecutableDiscoveryOptions = {}
): string | undefined {
  if (environment.JOKO_BROWSER_ENABLED === "0") return undefined;
  const isExecutable = options.isExecutableFile ?? executableFile;
  const explicit = environment.JOKO_BROWSER_EXECUTABLE;
  if (explicit !== undefined) {
    if (explicit.trim() === "") throw new Error("JOKO_BROWSER_EXECUTABLE must not be empty.");
    const candidate = resolve(explicit);
    if (!isExecutable(candidate)) throw new Error("JOKO_BROWSER_EXECUTABLE does not point to an executable file.");
    return candidate;
  }

  const platform = options.platform ?? process.platform;
  for (const candidate of browserCandidates(environment, platform)) {
    const absolute = resolve(candidate);
    if (isExecutable(absolute)) return absolute;
  }
  return undefined;
}

export function browserCandidates(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const root of compact([
      environment.LOCALAPPDATA,
      environment.PROGRAMFILES ?? environment.ProgramFiles ?? environment.PROGRAMW6432 ?? environment.ProgramW6432,
      environment["PROGRAMFILES(X86)"] ?? environment["ProgramFiles(x86)"]
    ])) {
      candidates.push(
        win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        win32.join(root, "Google", "Chrome SxS", "Application", "chrome.exe"),
        win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        win32.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        win32.join(root, "Chromium", "Application", "chrome.exe")
      );
    }
    candidates.push(...pathCandidates(environment, ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe"], win32));
  } else if (platform === "darwin") {
    const applicationRoots = compact([
      "/Applications",
      environment.HOME === undefined ? undefined : posix.join(environment.HOME, "Applications")
    ]);
    for (const root of applicationRoots) candidates.push(
      posix.join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      posix.join(root, "Google Chrome Beta.app", "Contents", "MacOS", "Google Chrome Beta"),
      posix.join(root, "Google Chrome Canary.app", "Contents", "MacOS", "Google Chrome Canary"),
      posix.join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
      posix.join(root, "Microsoft Edge Beta.app", "Contents", "MacOS", "Microsoft Edge Beta"),
      posix.join(root, "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
      posix.join(root, "Chromium.app", "Contents", "MacOS", "Chromium")
    );
    candidates.push(
      ...pathCandidates(environment, [
        "google-chrome", "google-chrome-beta", "chromium", "chromium-browser",
        "microsoft-edge", "microsoft-edge-beta", "brave-browser"
      ], posix)
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/brave-browser",
      "/snap/bin/chromium",
      "/opt/google/chrome/chrome",
      "/opt/google/chrome-beta/chrome",
      "/opt/microsoft/msedge/msedge",
      ...pathCandidates(environment, [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
        "microsoft-edge-beta",
        "brave-browser"
      ], posix)
    );
  }
  return [...new Set(candidates)];
}

function pathCandidates(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
  flavor: typeof posix | typeof win32
): string[] {
  const path = environment.PATH ?? environment.Path;
  if (path === undefined) return [];
  return path.split(flavor.delimiter).filter((item) => item.trim() !== "").flatMap((directory) =>
    names.map((name) => flavor.join(directory, name))
  );
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compact(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined && value.trim() !== "");
}
