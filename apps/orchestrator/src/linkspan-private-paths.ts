import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectKeyDirectoryPermissions } from "@joko/remote-ssh";
import type { OrchestratorConfig } from "./config.js";

/** Provider node keys and environments must not become workspace content. */
export async function prepareLinkspanPrivateProviderPaths<T extends { readonly provider: string }>(config: OrchestratorConfig, entryId: string, serverId: string, selected: T, signal?: AbortSignal): Promise<T> {
  if (!["funnel", "netbird", "zrok"].includes(selected.provider)) return selected;
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(entryId) || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(serverId)) throw new Error("A provider state directory requires its exact node and entrance identity.");
  const value = selected as T & Record<string, unknown>;
  const field = selected.provider === "zrok" ? "environmentDirectory" : "stateDirectory";
  const configured = value[field];
  const path = configured === undefined && field === "stateDirectory"
    ? join(config.dataDirectory, "credentials", "linkspan-provider-state", entryId) : configured;
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new Error("Provider identity state requires an absolute private directory outside source/workspace roots.");
  const excluded = await Promise.all([config.workspace.root, fileURLToPath(new URL("../../../", import.meta.url))].map(root => realpath(root)));
  const missing: string[] = []; let existing = resolve(path); let parent: string;
  for (;;) {
    try { parent = await realpath(existing); break; }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing)); existing = dirname(existing);
    }
  }
  const candidate = resolve(parent!, ...missing);
  if (excluded.some(root => within(root, candidate))) throw new Error("Provider node keys and private environments cannot be stored in a workspace or source tree.");
  const scope = signal === undefined ? AbortSignal.timeout(10000) : AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  await inspectKeyDirectoryPermissions(parent!, scope);
  if (missing.length > 0) {
    if (field === "environmentDirectory") throw new Error("Select the existing private zrok environment; it is never created or modified implicitly.");
    await mkdir(candidate, { recursive: true, mode: 0o700 });
  }
  const canonical = await realpath(candidate);
  if (excluded.some(root => within(root, canonical))) throw new Error("The provider state path changed into a workspace/source tree.");
  await inspectKeyDirectoryPermissions(canonical, scope); scope.throwIfAborted();
  if (field === "stateDirectory") {
    const marker = join(canonical, "linkspan-state-owner.json");
    const expected = { version: 1, provider: selected.provider, entryId, serverId };
    const files = await readdir(canonical);
    if (files.length === 0) {
      await writeFile(marker, JSON.stringify(expected) + "\n", { flag: "wx", mode: 0o600 });
    } else {
      const info = await lstat(marker).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error("The selected directory contains unowned provider state. Select a new private directory; existing network state was preserved.");
      let owner: unknown;
      try { owner = JSON.parse(await readFile(marker, "utf8")); } catch { throw new Error("The provider state ownership marker is invalid."); }
      if (JSON.stringify(owner) !== JSON.stringify(expected)) throw new Error("The provider state directory belongs to another node or entrance.");
    }
  }
  return { ...selected, [field]: canonical };
}
function within(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate)); return !suffix || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
