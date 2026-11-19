/** Serialize one selected path without treating backslashes as escape syntax. */
export function serializeComposerMentionPath(path: string, directory = false): string {
  const value = directory ? withDirectorySlash(path) : path;
  return needsMentionQuotes(value)
    ? `@"${value.replace(/"/gu, '\\"')}"`
    : `@${value}`;
}

/** Directory selection stays an open query so the next level can be selected. */
export function composerDirectoryQueryToken(path: string): string {
  const value = withDirectorySlash(path);
  return needsMentionQuotes(value)
    ? `@"${value.replace(/"/gu, '\\"')}`
    : `@${value}`;
}

function needsMentionQuotes(path: string): boolean {
  return /\s/u.test(path) || path.includes('"');
}

export function withDirectorySlash(path: string): string {
  return path.replace(/[\\/]+$/u, "") + "/";
}
