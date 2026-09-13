export interface GitIgnoreRule {
  readonly base: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly expression: RegExp;
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
    const containsSlash = line.includes("/");
    const glob = globExpression(line);
    const prefix = base === "" ? "" : `${escapeRegularExpression(base)}/`;
    const body = anchored || containsSlash
      ? `${prefix}${glob}`
      : `${prefix}(?:.*/)?${glob}`;
    rules.push(Object.freeze({
      base,
      negated,
      directoryOnly,
      expression: new RegExp(`^${body}${directoryOnly ? "(?:/.*)?" : ""}$`, "u")
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
    if (!rule.expression.test(relativePath)) continue;
    if (rule.directoryOnly && !isDirectory && !matchesDirectoryDescendant(relativePath, rule)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}

function matchesDirectoryDescendant(relativePath: string, rule: GitIgnoreRule): boolean {
  for (let separator = relativePath.indexOf("/"); separator >= 0; separator = relativePath.indexOf("/", separator + 1)) {
    if (rule.expression.test(relativePath.slice(0, separator))) return true;
  }
  return false;
}

function globExpression(pattern: string): string {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "\\" && index + 1 < pattern.length) {
      expression += escapeRegularExpression(pattern[index + 1] as string);
      index += 1;
      continue;
    }
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          expression += "(?:.*/)?";
          index += 1;
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    if (character === "[") {
      const closing = findCharacterClassEnd(pattern, index + 1);
      if (closing !== -1) {
        const contents = pattern.slice(index + 1, closing);
        const negation = contents.startsWith("!") ? "^" : "";
        const body = (contents.startsWith("!") ? contents.slice(1) : contents)
          .replaceAll("\\", "\\\\")
          .replaceAll("]", "\\]");
        expression += `[${negation}${body}]`;
        index = closing;
        continue;
      }
    }
    expression += escapeRegularExpression(character);
  }
  return expression;
}

function findCharacterClassEnd(pattern: string, start: number): number {
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === "]" && pattern[index - 1] !== "\\") return index;
  }
  return -1;
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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
