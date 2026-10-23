/**
 * Credential-bearing path patterns shared by every harness permission adapter.
 *
 * Keep the serializable `{ source, flags }` form as the source of truth: the Pi
 * bridge runs in a standalone child process and embeds these specs into its
 * generated extension instead of maintaining a second handwritten regex list.
 */
export const DOTENV_CREDENTIAL_PATH_PATTERN_SPEC = {
  source: String.raw`(?:^|[\\/])\.env(?:\.[^\\/]+)?$`,
  flags: "i",
} as const;


export const SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS = [
  {
    source: String.raw`(?:^|[\\/\s'"~])\.(?:ssh|aws|gnupg|kube|docker|azure|claude|codex)\b`,
    flags: "i",
  },
  {
    source: String.raw`(?:^|[\\/\s'"~])\.(?:netrc|npmrc|pgpass|pypirc|git-credentials)\b`,
    flags: "i",
  },
  DOTENV_CREDENTIAL_PATH_PATTERN_SPEC,
  { source: String.raw`[\\/]\.cargo[\\/]credentials(?:\.toml)?\b`, flags: "i" },
  {
    source: String.raw`[\\/]\.m2[\\/]settings(?:-security)?\.xml\b`,
    flags: "i",
  },
  { source: String.raw`\bapplication_default_credentials\b`, flags: "i" },
  { source: String.raw`\bcredentials\.json\b`, flags: "i" },
  {
    source: String.raw`[\\/](?:codex|claude|gcloud|containers)[\\/]auth\.json\b`,
    flags: "i",
  },
  {
    source: String.raw`[\\/]\.config[\\/](?:gh|hub|glab|op|gcloud)\b`,
    flags: "i",
  },
  { source: String.raw`/proc/[^\s]*/environ\b`, flags: "i" },
  {
    // 轮 30 HIGH-1:补 .key(TLS 私钥标配)与 .pfx(PKCS#12 Windows 习惯)。
    // 自定义命名 SSH 私钥(无扩展名、非 id_*)无法靠文件名可靠区分, 属已知
    // 盲区 —— 依赖 .ssh/ 目录规则与 magic-byte 检测(未来)。
    source: String.raw`\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|\.pem\b|\.p12\b|\.pfx\b|\.key\b`,
    flags: "i",
  },
] as const;


/**
 * File-search deny globs shared by Review harnesses.
 *
 * Path regexes protect explicit reads and symlink targets. Directory-wide
 * Grep/Glob/Find tools need a second, execution/result-level boundary because
 * their input can be only a granted directory with no concrete file selector.
 */
export const SENSITIVE_CREDENTIAL_GLOB_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.docker/**",
  "**/.azure/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.netrc",
  "**/.npmrc",
  "**/.pgpass",
  "**/.pypirc",
  "**/.git-credentials",
  "**/.cargo/credentials",
  "**/.cargo/credentials.toml",
  "**/.m2/settings.xml",
  "**/.m2/settings-security.xml",
  "**/application_default_credentials*",
  "**/credentials.json",
  "**/codex/auth.json",
  "**/claude/auth.json",
  "**/gcloud/auth.json",
  "**/containers/auth.json",
  "**/.config/gh/**",
  "**/.config/hub/**",
  "**/.config/glab/**",
  "**/.config/op/**",
  "**/.config/gcloud/**",
  "**/environ",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/id_dsa",
] as const;


const DOTENV_CREDENTIAL_PATH_PATTERN = new RegExp(
  DOTENV_CREDENTIAL_PATH_PATTERN_SPEC.source,
  DOTENV_CREDENTIAL_PATH_PATTERN_SPEC.flags,
);


export function isDotenvCredentialPath(target: string): boolean {
  return (
    typeof target === "string" && DOTENV_CREDENTIAL_PATH_PATTERN.test(target)
  );
}


export const SENSITIVE_CREDENTIAL_PATH_PATTERNS: readonly RegExp[] =
  SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS.map(
    ({ source, flags }) => new RegExp(source, flags),
  );


export function isSensitiveCredentialPath(target: string): boolean {
  return (
    typeof target === "string" &&
    SENSITIVE_CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(target))
  );
}
