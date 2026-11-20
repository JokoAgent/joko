import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./protocol.js";

export const PUBLISHED_PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PUBLISHED_PI_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve(PUBLISHED_PI_PACKAGE_NAME))));
export const PUBLISHED_PI_LOCAL_CLI = join(PUBLISHED_PI_PACKAGE_ROOT, "dist", "cli.js");

/** A configured npm launcher may be a symlink to the published bundle entry. */
export async function resolvePublishedPiBundleRoot(executable: string | undefined): Promise<string | undefined> {
  if (executable === undefined || !isAbsolute(executable)) return undefined;
  try {
    const entry = await realpath(executable);
    const root = dirname(dirname(dirname(entry)));
    if (basename(root) !== "pi-coding-agent" || basename(dirname(root)) !== "@earendil-works"
      || basename(dirname(dirname(root))) !== "node_modules"
      || entry !== join(root, "dist", "bundle", "cli.js")) return undefined;
    if (root === PUBLISHED_PI_PACKAGE_ROOT) return root;
    const manifest = join(root, "package.json");
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    const candidate: unknown = JSON.parse(await readFile(manifest, "utf8"));
    const installed: unknown = JSON.parse(await readFile(join(PUBLISHED_PI_PACKAGE_ROOT, "package.json"), "utf8"));
    return isRecord(candidate) && isRecord(installed) && candidate["name"] === PUBLISHED_PI_PACKAGE_NAME
      && typeof installed["version"] === "string" && candidate["version"] === installed["version"] && isRecord(candidate["bin"])
      && candidate["bin"]["pi"] === "dist/bundle/cli.js" ? root : undefined;
  } catch {
    return undefined;
  }
}
