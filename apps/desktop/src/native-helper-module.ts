import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export interface NativeHelperModuleOptions {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly loadNative?: (path: string) => unknown;
}

export function loadHashedNativeHelper(options: NativeHelperModuleOptions, helper: string, maximumBytes: number): unknown {
  try {
    const directory = resolve(options.directory);
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) return undefined;
    const entries = readdirSync(directory).sort();
    if (entries.length !== 2 || entries[0] !== helper || entries[1] !== "manifest.json") return undefined;
    const manifestPath = resolve(directory, "manifest.json");
    if (!regularFile(manifestPath, 4_096)) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!nativeHelperRecord(manifest) || Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256"
      || manifest.platform !== options.platform || manifest.architecture !== options.architecture
      || manifest.protocolVersion !== 1 || manifest.helper !== helper
      || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) return undefined;
    const helperPath = resolve(directory, helper);
    if (!regularFile(helperPath, maximumBytes)) return undefined;
    if (createHash("sha256").update(readFileSync(helperPath)).digest("hex") !== manifest.sha256) return undefined;
    return (options.loadNative ?? require)(helperPath);
  } catch {
    return undefined;
  }
}

function regularFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximumBytes
    && realpathSync(path) === path;
}

export function nativeHelperRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
