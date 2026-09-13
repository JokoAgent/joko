import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPES = ["apps", "packages", "scripts", "proto"] as const;
const ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "buf.gen.yaml",
  "buf.yaml",
  "tsconfig.json"
] as const;
const CHECKED_EXTENSIONS = new Set([
  ".bat", ".c", ".cc", ".cjs", ".cmd", ".cpp", ".cs", ".css", ".cts", ".go", ".h", ".hpp",
  ".html", ".java", ".js", ".json", ".json5", ".kt", ".kts", ".mjs", ".mts", ".ps1", ".py",
  ".rb", ".rs", ".sh", ".swift", ".proto", ".scss", ".svg", ".toml", ".ts", ".tsx", ".yaml", ".yml", ".zig"
]);
const GENERATED_DIRECTORIES = new Set(["build", "coverage", "dist", "node_modules", "out", "release"]);
const IMPORT_SPECIFIER_PATTERN = /\b(?:from\s*|import\s*(?:type\s*)?\(\s*|import\s*)["']([^"']+)["']/gu;

export interface SourcePolicyCheckOptions {
  readonly workspaceRoot: string;
}

export function checkSourcePolicy(options: SourcePolicyCheckOptions): readonly string[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const files = discoverCheckedFiles(workspaceRoot);
  const errors: string[] = [];

  for (const path of files) {
    const displayed = displayPath(workspaceRoot, path);
    const source = readFileSync(path, "utf8");
    if (displayed.startsWith(`apps${sep}web${sep}src${sep}`)) {
      errors.push(...webImportErrors(displayed, source));
    }
  }

  return errors;
}

function discoverCheckedFiles(workspaceRoot: string): readonly string[] {
  const selected = new Set<string>();
  for (const scope of SCOPES) {
    const root = resolve(workspaceRoot, scope);
    if (!existsSync(root)) continue;
    for (const match of globSync(`${scope}/**/*`, { cwd: workspaceRoot })) {
      const path = resolve(workspaceRoot, match);
      if (!statSync(path).isFile() || skippedGeneratedPath(workspaceRoot, path)) continue;
      if (CHECKED_EXTENSIONS.has(extname(path).toLocaleLowerCase("en-US"))) selected.add(path);
    }
  }
  for (const file of ROOT_FILES) {
    const path = resolve(workspaceRoot, file);
    if (existsSync(path) && statSync(path).isFile()) selected.add(path);
  }
  return [...selected].sort((left, right) => left.localeCompare(right, "en"));
}

function skippedGeneratedPath(workspaceRoot: string, path: string): boolean {
  return relative(workspaceRoot, path).split(/[\\/]/u).some((segment) => GENERATED_DIRECTORIES.has(segment));
}

function webImportErrors(displayedPath: string, source: string): readonly string[] {
  const errors: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier?.startsWith("@joko/") === true && specifier !== "@joko/contracts") {
      errors.push(`${displayedPath}: Web UI may import only @joko/contracts from workspace packages (found ${specifier})`);
    }
  }
  return errors;
}

function displayPath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path) || path;
}

function runCli(): void {
  const errors = checkSourcePolicy({ workspaceRoot: resolve(fileURLToPath(new URL("..", import.meta.url))) });
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Source policy boundaries are valid.\n");
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) runCli();
