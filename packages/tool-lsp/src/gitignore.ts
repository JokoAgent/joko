import { Minimatch } from "minimatch";

export interface GitIgnoreRule {
  readonly base: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: Minimatch;
}

const HARD_EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

export function isHardExcludedDirectory(name: string): boolean {
  return HARD_EXCLUDED_DIRECTORIES.has(name);
}

export function parseGitIgnore(source: string, base: string): readonly GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of source.replaceAll("\r\n", "\n").split("\n")) {
    let line = trimUnescapedTrailingSpaces(rawLine);
    if (line === "") continue;
    if (line.startsWith("\\#")) line = line.slice(1);
    else if (line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("\\!")) line = line.slice(1);
    else if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line === "") continue;

    const directoryOnly = endsWithUnescapedSlash(line);
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line === "") continue;
    rules.push(Object.freeze({
      base,
      negated,
      directoryOnly,
      matcher: new Minimatch(line, {
        platform: "linux", dot: true, nocomment: true, nonegate: true, nobrace: true, noext: true,
        matchBase: !anchored && !line.includes("/"), optimizationLevel: 0
      })
    }));
  }
  return Object.freeze(rules);
}

export function isGitIgnored(
  relativePath: string,
  isDirectory: boolean,
  rules: readonly GitIgnoreRule[]
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.base !== "" && !relativePath.startsWith(`${rule.base}/`)) continue;
    const path = rule.base === "" ? relativePath : relativePath.slice(rule.base.length + 1);
    if ((!rule.directoryOnly || isDirectory) && rule.matcher.match(path)
      || rule.directoryOnly && matchesDirectoryDescendant(path, rule)) ignored = !rule.negated;
  }
  return ignored;
}

function matchesDirectoryDescendant(relativePath: string, rule: GitIgnoreRule): boolean {
  for (let separator = relativePath.indexOf("/"); separator >= 0; separator = relativePath.indexOf("/", separator + 1)) {
    if (rule.matcher.match(relativePath.slice(0, separator))) return true;
  }
  return false;
}

function trimUnescapedTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let escapes = 0;
    for (let index = end - 2; index >= 0 && value[index] === "\\"; index -= 1) escapes += 1;
    if (escapes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end).replace(/\\ $/u, " ");
}

function endsWithUnescapedSlash(value: string): boolean {
  if (!value.endsWith("/")) return false;
  let escapes = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) escapes += 1;
  return escapes % 2 === 0;
}
