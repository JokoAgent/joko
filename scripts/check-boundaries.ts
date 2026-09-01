import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
] as const;

interface PackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export const WORKSPACE_DEPENDENCY_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  "@joko/contracts": new Set(),
  "@joko/code-host": new Set(),
  "@joko/core": new Set(),
  "@joko/git-safety": new Set(),
  "@joko/outbound-network": new Set(),
  "@joko/local-model-runtime": new Set(),
  "@joko/remote-ssh": new Set(),
  "@joko/runtime-governance": new Set(),
  "@joko/store": new Set(["@joko/core"]),
  "@joko/adapter-claude-code": new Set(["@joko/core", "@joko/runtime-governance"]),
  "@joko/adapter-codex": new Set(["@joko/core", "@joko/runtime-governance"]),
  "@joko/adapter-pi": new Set(["@joko/core", "@joko/runtime-governance"]),
  "@joko/adapter-dictation-refinement": new Set(["@joko/voice-input"]),
  "@joko/adapter-transcription-openai": new Set(["@joko/voice-input"]),
  "@joko/adapter-transcription-realtime": new Set(["@joko/voice-input"]),
  "@joko/tool-android": new Set(),
  "@joko/tool-browser": new Set(["@joko/core"]),
  "@joko/tool-computer": new Set(["@joko/outbound-network"]),
  "@joko/tool-lsp": new Set(),
  "@joko/voice-input": new Set(),
  "@joko/worktree": new Set(),
  "@joko/testkit": new Set(["@joko/contracts", "@joko/core", "@joko/store"]),
  "@joko/e2e": new Set(["@joko/adapter-pi", "@joko/contracts", "@joko/core", "@joko/orchestrator", "@joko/store", "@joko/testkit"]),
  "@joko/orchestrator": new Set(["@joko/code-host", "@joko/contracts", "@joko/core", "@joko/git-safety", "@joko/local-model-runtime", "@joko/outbound-network", "@joko/remote-ssh", "@joko/runtime-governance", "@joko/store", "@joko/adapter-claude-code", "@joko/adapter-codex", "@joko/adapter-dictation-refinement", "@joko/adapter-pi", "@joko/adapter-transcription-openai", "@joko/adapter-transcription-realtime", "@joko/tool-android", "@joko/tool-browser", "@joko/tool-computer", "@joko/tool-lsp", "@joko/voice-input", "@joko/worktree", "@joko/testkit"]),
  "@joko/web": new Set(["@joko/contracts"]),
  "@joko/desktop": new Set(["@joko/contracts", "@joko/web"])
};

export interface BoundaryCheckOptions {
  readonly workspaceRoot: string;
  readonly allowlist?: Readonly<Record<string, ReadonlySet<string>>>;
}

export function checkWorkspaceBoundaries(options: BoundaryCheckOptions): readonly string[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowlist = options.allowlist ?? WORKSPACE_DEPENDENCY_ALLOWLIST;
  const discovery = discoverWorkspaceManifests(workspaceRoot);
  const errors = [...discovery.errors];
  const manifests = new Map<string, { readonly path: string; readonly value: PackageManifest }>();

  for (const manifestPath of discovery.manifestPaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`${displayPath(workspaceRoot, manifestPath)}: invalid package.json (${messageOf(error)})`);
      continue;
    }
    if (!isManifest(parsed)) {
      errors.push(`${displayPath(workspaceRoot, manifestPath)}: invalid package manifest`);
      continue;
    }
    const existing = manifests.get(parsed.name);
    if (existing !== undefined) {
      errors.push(`Duplicate workspace package name ${parsed.name}: ${displayPath(workspaceRoot, existing.path)} and ${displayPath(workspaceRoot, manifestPath)}`);
      continue;
    }
    manifests.set(parsed.name, { path: manifestPath, value: parsed });
  }

  for (const name of Object.keys(allowlist)) {
    if (!manifests.has(name)) errors.push(`Boundary allowlist contains non-workspace package ${name}`);
  }

  for (const [name, entry] of manifests) {
    const allowed = allowlist[name];
    if (allowed === undefined) {
      errors.push(`${displayPath(workspaceRoot, entry.path)}: package ${name} is not present in the dependency boundary map`);
      continue;
    }
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(entry.value[section] ?? {})) {
        if (!dependency.startsWith("@joko/")) continue;
        if (!manifests.has(dependency)) {
          errors.push(`${name} declares unknown workspace dependency ${dependency} in ${section}`);
        } else if (!allowed.has(dependency)) {
          errors.push(`${name} must not depend on ${dependency} in ${section}`);
        }
      }
    }
  }

  return errors;
}

function discoverWorkspaceManifests(workspaceRoot: string): {
  readonly manifestPaths: readonly string[];
  readonly errors: readonly string[];
} {
  const workspaceFile = join(workspaceRoot, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) {
    return { manifestPaths: [], errors: [`Missing pnpm workspace manifest: ${workspaceFile}`] };
  }
  let patterns: readonly string[];
  try {
    patterns = parseWorkspacePackagePatterns(readFileSync(workspaceFile, "utf8"));
  } catch (error) {
    return { manifestPaths: [], errors: [`${workspaceFile}: ${messageOf(error)}`] };
  }
  const selected = new Map<string, string>();
  const excluded = new Set<string>();
  const errors: string[] = [];
  for (const rawPattern of patterns) {
    const isExclusion = rawPattern.startsWith("!");
    const packagePattern = isExclusion ? rawPattern.slice(1) : rawPattern;
    const manifestPattern = packagePattern.endsWith("package.json")
      ? packagePattern
      : `${packagePattern.replace(/[\\/]+$/u, "")}/package.json`;
    const matches = globSync(manifestPattern, { cwd: workspaceRoot })
      .map((path) => resolve(workspaceRoot, path))
      .sort((left, right) => left.localeCompare(right, "en"));
    if (!isExclusion && matches.length === 0) {
      errors.push(`Workspace package pattern ${rawPattern} matched no package manifests`);
    }
    for (const manifestPath of matches) {
      const key = pathComparisonKey(manifestPath);
      if (isExclusion) excluded.add(key);
      else selected.set(key, manifestPath);
    }
  }
  for (const key of excluded) selected.delete(key);
  return {
    manifestPaths: [...selected.values()].sort((left, right) => left.localeCompare(right, "en")),
    errors
  };
}

function parseWorkspacePackagePatterns(source: string): readonly string[] {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const patterns: string[] = [];
  let packagesIndent: number | undefined;
  for (const line of lines) {
    if (packagesIndent === undefined) {
      const match = /^(\s*)packages\s*:\s*(?:#.*)?$/u.exec(line);
      if (match !== null) packagesIndent = match[1]?.length ?? 0;
      continue;
    }
    if (line.trim() === "" || /^\s*#/u.test(line)) continue;
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (indent <= packagesIndent) break;
    const item = /^\s*-\s*(.+?)\s*$/u.exec(line)?.[1];
    if (item === undefined) throw new Error("packages must be a YAML list of workspace patterns");
    patterns.push(unquoteYamlScalar(item));
  }
  if (packagesIndent === undefined) throw new Error("pnpm-workspace.yaml is missing a packages list");
  if (patterns.length === 0) throw new Error("pnpm-workspace.yaml packages list is empty");
  return patterns;
}

function unquoteYamlScalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    const parsed: unknown = JSON.parse(withoutComment);
    if (typeof parsed !== "string" || parsed === "") throw new Error("workspace package patterns must not be empty");
    return parsed;
  }
  if (withoutComment.startsWith("'") && withoutComment.endsWith("'")) {
    const parsed = withoutComment.slice(1, -1).replace(/''/gu, "'");
    if (parsed === "") throw new Error("workspace package patterns must not be empty");
    return parsed;
  }
  if (withoutComment === "") throw new Error("workspace package patterns must not be empty");
  return withoutComment;
}

function displayPath(workspaceRoot: string, value: string): string {
  const displayed = relative(workspaceRoot, value);
  return displayed === "" || isAbsolute(displayed) ? value : displayed;
}

function pathComparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isManifest(value: unknown): value is PackageManifest {
  if (
    typeof value !== "object" || value === null ||
    !("name" in value) || typeof value.name !== "string" || value.name.trim() === ""
  ) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return DEPENDENCY_SECTIONS.every((section) => {
    if (!(section in record)) return true;
    const dependencies = record[section];
    return typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies) &&
      Object.values(dependencies).every((version) => typeof version === "string");
  });
}

function runCli(): void {
  const errors = checkWorkspaceBoundaries({ workspaceRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Workspace dependency boundaries are valid.\n");
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) runCli();
