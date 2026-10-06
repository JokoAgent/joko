/** Shared filename eligibility for bounded text reading and content search. */
export const textFileExtensions = [
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".cs", ".rb", ".php",
  ".swift", ".kt", ".kts", ".scala", ".groovy", ".coffee",
  ".lua", ".dart", ".r", ".pl", ".pm", ".ex", ".exs", ".elm",
  ".clj", ".cljs", ".cljc", ".fs", ".fsi", ".fsx", ".ml", ".mli",
  ".hs", ".erl", ".hrl", ".zig", ".nim", ".vim", ".applescript",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
  ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less", ".styl",
  ".vue", ".svelte", ".astro", ".svg",
  ".json", ".json5", ".jsonc", ".jsonl", ".ndjson", ".geojson",
  ".yaml", ".yml", ".xml", ".toml", ".ini", ".conf", ".cfg", ".properties",
  ".plist", ".tf", ".tfvars", ".hcl", ".gradle", ".cmake", ".mk", ".mak",
  ".lock", ".csv", ".tsv",
  ".md", ".markdown", ".mdx", ".rst", ".tex", ".bib", ".cls", ".sty",
  ".adoc", ".asciidoc", ".org", ".txt", ".text", ".log", ".diff", ".patch",
  ".srt", ".vtt", ".po", ".pot",
  ".sln", ".csproj", ".vbproj", ".fsproj", ".gemspec", ".podspec", ".cabal",
  ".sql", ".graphql", ".proto", ".dockerfile", ".rss", ".atom",
  ".gitignore", ".gitattributes", ".gitconfig", ".gitmodules", ".gitkeep",
  ".dockerignore", ".eslintignore", ".prettierignore", ".npmignore",
  ".editorconfig", ".env", ".env.local", ".env.development", ".env.production", ".env.example",
  ".prettierrc", ".eslintrc", ".babelrc", ".npmrc", ".yarnrc",
  ".stylelintrc", ".huskyrc", ".lintstagedrc", ".browserslistrc",
  ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions",
  ".mdown", ".mkd", ".gql", ".sc", ".makefile"
] as const;

export const textFileNames = [
  "dockerfile", "makefile", "gemfile", "rakefile", "procfile", "vagrantfile", "jenkinsfile", "cmakelists",
  "authors", "changelog", "contributors", "copying", "license", "notice", "readme", "todo"
] as const;

const compoundExtensions = [".env.example", ".env.local", ".env.development", ".env.production"];
const supportedExtensions = new Set<string>(textFileExtensions);
const supportedNames = new Set<string>(textFileNames);

function fileBasename(value: string): string {
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase();
}

/** Accept filenames as given; URL query/fragment and whitespace are not stripped. */
export function filePreviewExtension(value: string): string {
  const name = fileBasename(value);
  for (const extension of compoundExtensions) if (name.endsWith(extension)) return extension;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

export function fileNameSupportsTextPreview(value: string): boolean {
  return supportedExtensions.has(filePreviewExtension(value)) || supportedNames.has(fileBasename(value));
}
