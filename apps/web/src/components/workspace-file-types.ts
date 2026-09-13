const WORKSPACE_MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown", "mdown", "mkdn", "mkd"]);

/** Markdown aliases shared by the Files body and editor. */
export function isWorkspaceMarkdownPath(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && WORKSPACE_MARKDOWN_EXTENSIONS.has(name.slice(dot + 1));
}
