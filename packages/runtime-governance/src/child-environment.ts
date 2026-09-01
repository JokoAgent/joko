export const CHILD_RUNTIME_BASE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "OS",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
] as const);

export interface ChildRuntimeEnvironmentOptions {
  /** Ambient environment to select from. Defaults to the current process. */
  readonly source?: Readonly<NodeJS.ProcessEnv>;
  /** Additional exact names that the child runtime is allowed to inherit. */
  readonly allowedKeys?: readonly string[];
  /** Explicit caller-owned additions. Undefined removes an inherited value. */
  readonly overrides?: Readonly<NodeJS.ProcessEnv>;
  /** Exact names whose resulting values must be treated as sensitive. */
  readonly sensitiveKeys?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

export interface ChildRuntimeEnvironment {
  readonly environment: Readonly<Record<string, string>>;
  readonly sensitiveValues: readonly string[];
}

interface EnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

const SENSITIVE_NAME = /(?:^|_)(?:API_KEY|API_TOKEN|AUTH_TOKEN|AUTHORIZATION_TOKEN|BEARER_TOKEN|OAUTH_TOKEN|OAUTH_REFRESH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|SESSION_ACCESS_TOKEN|IDENTITY_TOKEN|SECRET|SECRET_ACCESS_KEY|PASSWORD|PASSPHRASE|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|CUSTOM_HEADERS)(?:$|_)/iu;

export function createChildRuntimeEnvironment(
  options: ChildRuntimeEnvironmentOptions = {}
): ChildRuntimeEnvironment {
  const platform = options.platform ?? process.platform;
  const source = options.source ?? process.env;
  const entries = new Map<string, EnvironmentEntry>();
  const sourceNames = sourceNameIndex(source, platform);

  for (const name of [...CHILD_RUNTIME_BASE_ENVIRONMENT_KEYS, ...(options.allowedKeys ?? [])]) {
    assertEnvironmentName(name);
    const sourceName = sourceNames.get(normalizedName(name, platform));
    if (sourceName === undefined) continue;
    const value = source[sourceName];
    if (typeof value !== "string" || value.includes("\0")) continue;
    entries.set(normalizedName(name, platform), { name, value });
  }

  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    assertEnvironmentName(name);
    const normalized = normalizedName(name, platform);
    if (value === undefined) {
      entries.delete(normalized);
      continue;
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError(`Child runtime environment value for ${name} is invalid.`);
    }
    entries.set(normalized, { name, value });
  }

  const sensitiveNames = new Set(
    (options.sensitiveKeys ?? []).map((name) => {
      assertEnvironmentName(name);
      return normalizedName(name, platform);
    })
  );
  const sensitiveValues = new Set<string>();
  for (const [normalized, entry] of entries) {
    if (sensitiveNames.has(normalized) || SENSITIVE_NAME.test(entry.name)) {
      if (entry.value.length > 0) sensitiveValues.add(entry.value);
    }
  }

  return {
    environment: Object.freeze(Object.fromEntries([...entries.values()].map(({ name, value }) => [name, value]))),
    sensitiveValues: Object.freeze([...sensitiveValues].sort((left, right) => right.length - left.length))
  };
}

function sourceNameIndex(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const name of Object.keys(environment).sort()) {
    const normalized = normalizedName(name, platform);
    if (!index.has(normalized)) index.set(normalized, name);
  }
  return index;
}

function normalizedName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

function assertEnvironmentName(name: string): void {
  if (name.length === 0 || name.includes("=") || name.includes("\0")) {
    throw new TypeError("Child runtime environment name is invalid.");
  }
}
