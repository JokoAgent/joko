import {
  existsSync,
  readFileSync,
  statSync
} from "node:fs";
import { join, resolve } from "node:path";

const MAXIMUM_PACKAGE_JSON_BYTES = 1024 * 1024;
const MONOREPO_MARKERS = Object.freeze([
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json"
]);

const cache = new Map<string, boolean>();

/** Synchronously samples the project shape when a new runtime tool snapshot is
 * frozen. Results are cached by normalized root so an existing Session cannot
 * gain or lose language tools as files change underneath it. */
export function detectTypeScriptProject(workspaceRoot: string): boolean {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "" || workspaceRoot.includes("\0")) {
    return false;
  }
  const normalized = resolve(workspaceRoot);
  const cached = cache.get(normalized);
  if (cached !== undefined) return cached;
  const detected = detect(normalized);
  cache.set(normalized, detected);
  return detected;
}

function detect(workspaceRoot: string): boolean {
  try {
    if (existsSync(join(workspaceRoot, "tsconfig.json"))) return true;
    if (MONOREPO_MARKERS.some((marker) => existsSync(join(workspaceRoot, marker)))) return true;

    const packageJsonPath = join(workspaceRoot, "package.json");
    if (!existsSync(packageJsonPath)) return false;
    const info = statSync(packageJsonPath);
    if (!info.isFile() || info.size > MAXIMUM_PACKAGE_JSON_BYTES) return false;
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly workspaces?: unknown;
      readonly dependencies?: Readonly<Record<string, unknown>>;
      readonly devDependencies?: Readonly<Record<string, unknown>>;
      readonly peerDependencies?: Readonly<Record<string, unknown>>;
    };
    if (parsed.workspaces !== undefined && parsed.workspaces !== null && parsed.workspaces !== false) return true;
    return parsed.dependencies?.["typescript"] !== undefined
      || parsed.devDependencies?.["typescript"] !== undefined
      || parsed.peerDependencies?.["typescript"] !== undefined;
  } catch {
    return false;
  }
}
