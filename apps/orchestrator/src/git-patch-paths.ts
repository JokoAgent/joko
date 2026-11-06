const DIFF_HEADER = "diff --git ";

export function readGitPatchPaths(lines: readonly string[], start: number): {
  readonly oldPath: string;
  readonly path: string;
} | undefined {
  const header = lines[start];
  if (header?.startsWith(DIFF_HEADER) !== true) return undefined;
  const paths = readHeaderPaths(header.slice(DIFF_HEADER.length));
  let oldPath = paths?.oldPath;
  let path = paths?.path;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "" || line.startsWith(DIFF_HEADER) || line.startsWith("@@") || line === "GIT binary patch") break;
    const extended = /^(?:rename|copy) (from|to) (.+)$/su.exec(line);
    if (extended?.[1] === "from") oldPath = decodeGitPath(extended[2]!);
    if (extended?.[1] === "to") path = decodeGitPath(extended[2]!);
  }
  return oldPath && path ? { oldPath, path } : undefined;
}

function readHeaderPaths(header: string): { oldPath: string; path: string } | undefined {
  // Git leaves ordinary spaces unquoted. For two equal paths the separator is
  // at the midpoint even when the path itself contains another " b/".
  const separator = Math.floor(header.length / 2);
  if (header.startsWith("a/") && header.startsWith(" b/", separator)) {
    const path = header.slice(2, separator);
    if (path === header.slice(separator + 3)) return { oldPath: path, path };
  }
  const tokens = /^("(?:[^"\\]|\\.)*"|[^ "]+) ("(?:[^"\\]|\\.)*"|[^ "]+)$/su.exec(header);
  if (tokens === null) return undefined;
  const oldPath = decodeGitPath(tokens[1]!);
  const path = decodeGitPath(tokens[2]!);
  if (!oldPath.startsWith("a/") || !path.startsWith("b/")) return undefined;
  return { oldPath: oldPath.slice(2), path: path.slice(2) };
}

const gitEscapeBytes: Readonly<Partial<Record<string, number>>> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d
};

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const content = value.slice(1, -1);
  for (let offset = 0; offset < content.length; offset += 1) {
    if (content[offset] !== "\\") {
      const character = String.fromCodePoint(content.codePointAt(offset)!);
      bytes.push(...Buffer.from(character, "utf8"));
      offset += character.length - 1;
      continue;
    }
    const escaped = content[++offset];
    if (escaped === undefined) return "";
    const octal = /^([0-7]{1,3})/u.exec(content.slice(offset))?.[1];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      offset += octal.length - 1;
    } else {
      bytes.push(gitEscapeBytes[escaped] ?? escaped.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
