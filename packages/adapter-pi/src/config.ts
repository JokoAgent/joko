import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PermissionMode, PolicySubjectKind, ProviderModel } from "@joko/core";
import { piError } from "./errors.js";

export type PiSupportedApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

export interface PiManagedModel {
  readonly id: string;
  /** Joko-owned identity used to merge route-specific copies in settings. */
  readonly logicalId?: string;
  readonly name?: string;
  readonly api?: PiSupportedApi;
  readonly reasoning?: boolean;
  /** Explicit BYOM declaration; never inferred from an arbitrary endpoint. */
  readonly supportsFastMode?: boolean;
  /** Host-owned picker default; stripped from Pi's models.json. */
  readonly defaultVisible?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly compat?: Readonly<Record<string, unknown>>;
  readonly samplingParams?: Readonly<Record<string, unknown>>;
}

export interface PiManagedProvider {
  readonly id: string;
  readonly baseUrl?: string;
  readonly api?: PiSupportedApi;
  /** Name only. The secret value is supplied to the child through the managed credential channel. */
  readonly apiKeyEnv?: string;
  /** For local servers that require only an auth-presence marker. */
  readonly keyless?: boolean;
  readonly authHeader?: boolean;
  readonly headers?: Readonly<Record<string, { readonly env: string }>>;
  readonly models: readonly PiManagedModel[];
  readonly modelOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly compat?: Readonly<Record<string, unknown>>;
}

export interface PiManagedSettings {
  readonly compaction?: {
    readonly enabled?: boolean;
    readonly reserveTokens?: number;
    readonly keepRecentTokens?: number;
    /** Joko-owned relative trigger; the Adapter evaluates it against the active model window. */
    readonly thresholdPercent?: number;
  };
  readonly retry?: {
    readonly enabled?: boolean;
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
    readonly provider?: {
      readonly timeoutMs?: number;
      readonly maxRetries?: number;
      readonly maxRetryDelayMs?: number;
    };
  };
  readonly steeringMode?: "all" | "one-at-a-time";
  readonly followUpMode?: "all" | "one-at-a-time";
  readonly images?: {
    readonly autoResize?: boolean;
    readonly blockImages?: boolean;
  };
  readonly defaultTools?: readonly string[];
}

/**
 * Compatibility ceiling for routes that do not publish an authoritative
 * output limit. Pi still clamps every request to the remaining context window.
 */
export function piModelOutputTokenLimit(
  explicitLimit: number | undefined,
  contextWindow: number | undefined
): number {
  if (explicitLimit !== undefined && Number.isSafeInteger(explicitLimit) && explicitLimit > 0) {
    return explicitLimit;
  }
  return contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.min(contextWindow, 65_536)
    : 65_536;
}

export interface PiRuntimeControl {
  readonly generation: number;
  readonly policyGeneration: number;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly fastMode: boolean;
  readonly approvedRoots: readonly PiApprovedRoot[];
  readonly runtimePolicy: "standard" | "review_read_only";
  readonly writtenAt: string;
}

export interface PiApprovedRoot {
  readonly path: string;
  readonly access: "read_only" | "read_write";
}

export interface PiMcpToolDescriptor {
  readonly serverId: string;
  readonly name: string;
  /** Optional service-owned direct Pi tool name. User MCP servers never set it. */
  readonly runtimeName?: string;
  /** Capability-neutral policy subject supplied by the service-owned Provider. */
  readonly policySubject?: PolicySubjectKind;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Service-owned policy hint. Only an explicit false is treated as read-only. */
  readonly requiresPermission: boolean;
}

export interface PiMcpBridgeDescriptor {
  readonly endpoint: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly targetId: string;
  readonly tools: readonly PiMcpToolDescriptor[];
  /**
   * Credential-free routing metadata for the host-owned native-auth lease
   * channel. The bearer stays in the process environment and is never written
   * into this descriptor.
   */
  readonly nativeAuthLease?: {
    readonly endpoint: string;
    readonly catalogGeneration: number;
    readonly providerIds: readonly string[];
    readonly authenticatedProviderIds: readonly string[];
  };
}

export interface ManagedCatalogResult {
  readonly models: readonly ProviderModel[];
  readonly keylessEnvironment: Readonly<Record<string, string>>;
  readonly secretEnvironmentNames: readonly string[];
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^\S{1,256}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const PI_CANONICAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PI_AUTO_COMPACTION_THRESHOLD_PERCENT_DEFAULT = 75;
export const PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM = 50;
export const PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM = 95;

/**
 * Return Pi's supported thinking levels while omitting selectable effort for
 * models that do not support reasoning.
 */
export function supportedPiThinkingLevels(
  reasoning: boolean | undefined,
  thinkingLevelMap?: Readonly<Record<string, string | null>>
): readonly string[] {
  if (reasoning !== true) return [];
  return PI_CANONICAL_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Keep the untrusted RPC projection ordered and inside Pi's public enum. */
export function canonicalPiThinkingLevels(levels: readonly unknown[]): readonly string[] {
  const available = new Set(levels.filter((level): level is string => typeof level === "string"));
  return PI_CANONICAL_THINKING_LEVELS.filter((level) => available.has(level));
}

export async function provisionManagedCatalog(
  agentHome: string,
  providers: readonly PiManagedProvider[],
  settings: PiManagedSettings = {}
): Promise<ManagedCatalogResult> {
  assertAbsoluteManagedPath(agentHome, "agent home");
  validateSettings(settings);
  await mkdir(agentHome, { recursive: true }).catch((error) => {
    throw asProvisionError(error, "PI_AGENT_HOME_CREATE_FAILED", "Failed to create managed Pi Agent Home");
  });
  const agentHomeInfo = await lstat(agentHome).catch((error) => {
    throw asProvisionError(error, "PI_AGENT_HOME_INSPECT_FAILED", "Failed to inspect managed Pi Agent Home");
  });
  if (!agentHomeInfo.isDirectory() || agentHomeInfo.isSymbolicLink()) {
    throw piError("PI_AGENT_HOME_UNSAFE", "Managed Pi Agent Home must be a regular directory, not a symlink or junction", "provision");
  }
  const canonicalAgentHome = await realpath(agentHome).catch((error) => {
    throw asProvisionError(error, "PI_AGENT_HOME_RESOLUTION_FAILED", "Failed to resolve managed Pi Agent Home");
  });
  if (!sameManagedPath(canonicalAgentHome, agentHome)) {
    throw piError("PI_AGENT_HOME_ALIAS_DENIED", "Managed Pi Agent Home contains a path alias or parent junction", "provision", {
      recovery: "Use the canonical service-owned Agent Home path."
    });
  }
  await Promise.all([
    mkdir(join(agentHome, "runtime"), { recursive: true }),
    mkdir(join(agentHome, "managed"), { recursive: true })
  ]);

  const providerObject: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const coreModels: ProviderModel[] = [];
  const keylessEnvironment: Record<string, string> = {};
  const secretEnvironmentNames = new Set<string>();
  const providerIds = new Set<string>();
  const keylessNames = new Set<string>();

  for (const provider of providers) {
    validateProvider(provider);
    if (providerIds.has(provider.id)) throw piError("PI_MODEL_DUPLICATE_PROVIDER", `Duplicate provider '${provider.id}'`, "provision");
    providerIds.add(provider.id);
    const apiKeyEnv = provider.apiKeyEnv ?? (provider.keyless ? keylessEnvName(provider.id) : undefined);
    if (apiKeyEnv) {
      assertEnvironmentName(apiKeyEnv);
      if (provider.keyless && !provider.apiKeyEnv) {
        if (keylessNames.has(apiKeyEnv) || secretEnvironmentNames.has(apiKeyEnv)) {
          throw piError("PI_MODEL_KEYLESS_ENV_COLLISION", `Provider '${provider.id}' collides on managed keyless environment name '${apiKeyEnv}'`, "provision");
        }
        keylessNames.add(apiKeyEnv);
        keylessEnvironment[apiKeyEnv] = "joko-local-provider";
      }
      else {
        if (keylessNames.has(apiKeyEnv)) {
          throw piError("PI_MODEL_AUTH_ENV_COLLISION", `Provider '${provider.id}' reuses managed keyless environment name '${apiKeyEnv}'`, "provision");
        }
        secretEnvironmentNames.add(apiKeyEnv);
      }
    }
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, reference] of Object.entries(provider.headers ?? {})) {
      assertHeaderName(name);
      if (!isPlainObject(reference) || typeof reference.env !== "string") {
        throw piError("PI_MODEL_INVALID_HEADER_REFERENCE", `Provider '${provider.id}' header '${name}' has an invalid environment reference`, "provision");
      }
      assertEnvironmentName(reference.env);
      if (keylessNames.has(reference.env)) {
        throw piError("PI_MODEL_AUTH_ENV_COLLISION", `Provider '${provider.id}' header reuses managed keyless environment name '${reference.env}'`, "provision");
      }
      headers[name] = `$${reference.env}`;
      secretEnvironmentNames.add(reference.env);
    }

    providerObject[provider.id] = compactObject({
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: apiKeyEnv ? `$${apiKeyEnv}` : undefined,
      authHeader: provider.authHeader,
      headers: Object.keys(headers).length === 0 ? undefined : headers,
      compat: provider.compat,
      models: provider.models.map(managedPiModelConfiguration),
      modelOverrides: materializeModelOverrides(provider.modelOverrides, secretEnvironmentNames)
    });

    for (const model of provider.models) coreModels.push(piProviderModel(provider, model));
  }

  const managedSettings = compactObject({
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    // Pi exposes only an absolute reserveTokens setting and does not provide an
    // RPC setter for it. A single absolute reserve cannot represent the same
    // percentage across model switches, so leave native threshold compaction at
    // the context boundary (while retaining its overflow recovery) and let the
    // Adapter enforce the relative threshold against the active model window.
    compaction: compactObject({
      enabled: settings.compaction?.enabled,
      reserveTokens: 0,
      keepRecentTokens: settings.compaction?.keepRecentTokens
    }),
    retry: settings.retry,
    steeringMode: settings.steeringMode ?? "one-at-a-time",
    followUpMode: settings.followUpMode ?? "one-at-a-time",
    images: settings.images,
    defaultTools: settings.defaultTools
  });

  await Promise.all([
    atomicWriteJson(join(agentHome, "models.json"), { providers: providerObject }),
    atomicWriteJson(join(agentHome, "settings.json"), managedSettings)
  ]);
  return { models: coreModels, keylessEnvironment, secretEnvironmentNames: [...secretEnvironmentNames].sort() };
}

export async function writeRuntimeControl(path: string, control: Omit<PiRuntimeControl, "writtenAt">): Promise<void> {
  if (!Number.isSafeInteger(control.generation) || control.generation < 0) {
    throw piError("PI_CONTROL_INVALID_GENERATION", "Pi runtime control generation must be a non-negative safe integer", "provision");
  }
  if (!Number.isSafeInteger(control.policyGeneration) || control.policyGeneration < 0) {
    throw piError("PI_CONTROL_INVALID_POLICY_GENERATION", "Pi runtime policy generation must be a non-negative safe integer", "provision");
  }
  if (!(["ask", "auto", "bypassPermissions"] as const).includes(control.permissionMode)) {
    throw piError("PI_CONTROL_INVALID_PERMISSION", "Pi runtime control contains an invalid permission mode", "provision");
  }
  if (typeof control.planMode !== "boolean" || typeof control.fastMode !== "boolean") {
    throw piError("PI_CONTROL_INVALID_MODE", "Pi runtime control contains an invalid Plan or Fast Mode value", "provision");
  }
  if (control.runtimePolicy !== "standard" && control.runtimePolicy !== "review_read_only") {
    throw piError("PI_CONTROL_INVALID_RUNTIME_POLICY", "Pi runtime control contains an invalid immutable runtime policy", "provision");
  }
  const seenRoots = new Set<string>();
  for (const root of control.approvedRoots) {
    if (!isAbsolute(root.path) || resolve(root.path) !== root.path) {
      throw piError("PI_CONTROL_INVALID_ROOT", "Pi runtime control contains a non-canonical approved root", "provision");
    }
    if (root.access !== "read_only" && root.access !== "read_write") {
      throw piError("PI_CONTROL_INVALID_ROOT_ACCESS", "Pi runtime control contains an invalid root access level", "provision");
    }
    const key = process.platform === "win32" ? root.path.toLowerCase() : root.path;
    if (seenRoots.has(key)) throw piError("PI_CONTROL_DUPLICATE_ROOT", "Pi runtime control contains a duplicate approved root", "provision");
    seenRoots.add(key);
  }
  await atomicWriteJson(path, { ...control, writtenAt: new Date().toISOString() } satisfies PiRuntimeControl);
}

export async function writeMcpDescriptor(path: string, descriptor: PiMcpBridgeDescriptor): Promise<void> {
  validateMcpEndpoint(descriptor.endpoint);
  if (!Number.isSafeInteger(descriptor.generation) || descriptor.generation < 0) {
    throw piError("PI_MCP_INVALID_GENERATION", "MCP descriptor generation must be a non-negative safe integer", "provision");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(descriptor.sessionId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(descriptor.targetId)) {
    throw piError("PI_MCP_INVALID_SCOPE", "MCP descriptor contains an invalid product Session or Target scope", "provision");
  }
  if (descriptor.nativeAuthLease !== undefined) {
    validateMcpEndpoint(descriptor.nativeAuthLease.endpoint);
    if (!Number.isSafeInteger(descriptor.nativeAuthLease.catalogGeneration) || descriptor.nativeAuthLease.catalogGeneration < 0) {
      throw piError("PI_NATIVE_AUTH_INVALID_GENERATION", "Native auth lease catalog generation is invalid", "provision");
    }
    const providerIds = new Set<string>();
    for (const providerId of descriptor.nativeAuthLease.providerIds) {
      if (!PROVIDER_ID.test(providerId) || providerIds.has(providerId)) {
        throw piError("PI_NATIVE_AUTH_INVALID_PROVIDER", "Native auth lease Provider allowlist is invalid", "provision");
      }
      providerIds.add(providerId);
    }
    const authenticatedProviderIds = new Set<string>();
    for (const providerId of descriptor.nativeAuthLease.authenticatedProviderIds) {
      if (!providerIds.has(providerId) || authenticatedProviderIds.has(providerId)) {
        throw piError("PI_NATIVE_AUTH_INVALID_PROVIDER", "Native auth lease authenticated Provider allowlist is invalid", "provision");
      }
      authenticatedProviderIds.add(providerId);
    }
  }
  const seen = new Set<string>();
  for (const tool of descriptor.tools) {
    if (!PROVIDER_ID.test(tool.serverId)) throw piError("PI_MCP_INVALID_SERVER", `Invalid MCP server id '${tool.serverId}'`, "provision");
    if (!TOOL_NAME.test(tool.name)) throw piError("PI_MCP_INVALID_TOOL", `Invalid MCP tool name '${tool.name}'`, "provision");
    if (tool.runtimeName !== undefined && !TOOL_NAME.test(tool.runtimeName)) {
      throw piError("PI_MCP_INVALID_TOOL", `Invalid managed runtime tool name '${tool.runtimeName}'`, "provision");
    }
    if (tool.policySubject !== undefined && !POLICY_SUBJECTS.has(tool.policySubject)) {
      throw piError("PI_MCP_INVALID_POLICY_SUBJECT", `MCP tool '${tool.name}' has an invalid policy subject`, "provision");
    }
    const fullName = tool.runtimeName ?? `mcp__${tool.serverId}__${tool.name}`;
    if (seen.has(fullName)) throw piError("PI_MCP_DUPLICATE_TOOL", `Duplicate MCP tool '${fullName}'`, "provision");
    seen.add(fullName);
    if (!isPlainObject(tool.inputSchema)) throw piError("PI_MCP_INVALID_SCHEMA", `MCP tool '${fullName}' has an invalid input schema`, "provision");
    if (typeof tool.requiresPermission !== "boolean") {
      throw piError("PI_MCP_INVALID_PERMISSION_HINT", `MCP tool '${fullName}' has an invalid permission hint`, "provision");
    }
  }
  await atomicWriteJson(path, descriptor);
}

const POLICY_SUBJECTS = new Set<PolicySubjectKind>([
  "file_read", "file_write", "command", "network", "mcp", "browser", "resource", "extra_directory"
]);

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw piError("PI_CONFIG_SERIALIZE_FAILED", "Failed to serialize managed Pi configuration", "provision", { cause: error });
  }
  if (serialized === undefined) throw piError("PI_CONFIG_SERIALIZE_FAILED", "Managed Pi configuration is not JSON serializable", "provision");
  await atomicWriteFile(path, `${serialized}\n`);
}

export async function atomicWriteFile(path: string, value: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw piError("PI_CONFIG_WRITE_FAILED", `Failed to atomically write managed Pi file '${path}'`, "provision", {
      recovery: "Ensure the Orchestrator service account owns and can write the managed Pi Agent Home.",
      cause: error
    });
  }
}

export function assertAbsoluteManagedPath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw piError("PI_INVALID_MANAGED_PATH", `${label} must be a normalized absolute path`, "provision");
  }
}

export function validateMcpEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw piError("PI_MCP_INVALID_ENDPOINT", "MCP bridge endpoint is not a valid URL", "provision", { cause: error });
  }
  if (url.username || url.password || url.hash) {
    throw piError("PI_MCP_UNSAFE_ENDPOINT", "MCP bridge endpoint must not contain credentials or a fragment", "provision");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw piError("PI_MCP_UNSAFE_ENDPOINT", "MCP bridge must use HTTPS or an HTTP loopback endpoint", "provision");
  }
}

function validateProvider(provider: PiManagedProvider): void {
  if (!hasPlainObjectPrototype(provider)) throw piError("PI_MODEL_INVALID_PROVIDER", "Managed provider must be a plain object", "provision");
  if (!PROVIDER_ID.test(provider.id)) throw piError("PI_MODEL_INVALID_PROVIDER", `Invalid provider id '${provider.id}'`, "provision");
  if (provider.api !== undefined && !["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(provider.api)) {
    throw piError("PI_MODEL_INVALID_API", `Provider '${provider.id}' has an invalid API type`, "provision");
  }
  if (provider.apiKeyEnv && provider.keyless) {
    throw piError("PI_MODEL_AMBIGUOUS_AUTH", `Provider '${provider.id}' cannot set both apiKeyEnv and keyless`, "provision");
  }
  if (provider.baseUrl) {
    let url: URL;
    try {
      url = new URL(provider.baseUrl);
    } catch (error) {
      throw piError("PI_MODEL_INVALID_BASE_URL", `Provider '${provider.id}' has an invalid base URL`, "provision", { cause: error });
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search) {
      throw piError("PI_MODEL_UNSAFE_BASE_URL", `Provider '${provider.id}' base URL must be HTTP(S) without embedded credentials`, "provision");
    }
    const loopback = isLoopbackHostname(url.hostname);
    const overrideHeaders = Object.values(provider.modelOverrides ?? {}).some(
      (override) => isPlainObject(override) && override.headers !== undefined
    );
    const explicitlyCredentialFree = provider.keyless === true &&
      provider.apiKeyEnv === undefined &&
      provider.authHeader !== true &&
      Object.keys(provider.headers ?? {}).length === 0 &&
      !overrideHeaders;
    if (url.protocol === "http:" && !loopback && !explicitlyCredentialFree) {
      throw piError(
        "PI_MODEL_INSECURE_CREDENTIAL_TRANSPORT",
        `Provider '${provider.id}' cannot send credentials to a non-loopback HTTP endpoint`,
        "provision",
        { recovery: "Use HTTPS, an HTTP loopback endpoint, or an explicitly keyless provider without auth headers." }
      );
    }
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw piError("PI_MODEL_EMPTY_PROVIDER", `Provider '${provider.id}' has no models`, "provision");
  }
  if (provider.headers !== undefined && !hasPlainObjectPrototype(provider.headers)) {
    throw piError("PI_MODEL_INVALID_HEADERS", `Provider '${provider.id}' has invalid headers`, "provision");
  }
  if (provider.modelOverrides !== undefined && !hasPlainObjectPrototype(provider.modelOverrides)) {
    throw piError("PI_MODEL_INVALID_OVERRIDE", `Provider '${provider.id}' has invalid model overrides`, "provision");
  }
  const ids = new Set<string>();
  for (const model of provider.models as readonly PiManagedModel[]) {
    if (!hasPlainObjectPrototype(model)) throw piError("PI_MODEL_INVALID", `Provider '${provider.id}' contains an invalid model`, "provision");
    if (!MODEL_ID.test(model.id)) throw piError("PI_MODEL_INVALID_ID", `Invalid model id for provider '${provider.id}'`, "provision");
    if (model.logicalId !== undefined && !MODEL_ID.test(model.logicalId)) {
      throw piError("PI_MODEL_INVALID_LOGICAL_ID", `Invalid logical model id for provider '${provider.id}'`, "provision");
    }
    if (model.api !== undefined && !["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(model.api)) {
      throw piError("PI_MODEL_INVALID_API", `Model '${provider.id}/${model.id}' has an invalid API type`, "provision");
    }
    if (ids.has(model.id)) throw piError("PI_MODEL_DUPLICATE", `Duplicate model '${provider.id}/${model.id}'`, "provision");
    ids.add(model.id);
    if (!isPositiveSafeInteger(model.contextWindow ?? 1) || !isPositiveSafeInteger(model.maxTokens ?? 1)) {
      throw piError("PI_MODEL_INVALID_LIMIT", `Model '${provider.id}/${model.id}' has invalid token limits`, "provision");
    }
    if (model.input && (model.input.length === 0 || model.input.some((input) => input !== "text" && input !== "image"))) {
      throw piError("PI_MODEL_INVALID_INPUT", `Model '${provider.id}/${model.id}' has invalid input modalities`, "provision");
    }
    if (model.thinkingLevelMap !== undefined && !hasPlainObjectPrototype(model.thinkingLevelMap)) {
      throw piError("PI_MODEL_INVALID_THINKING_MAP", `Model '${provider.id}/${model.id}' has an invalid thinking level map`, "provision");
    }
    for (const [level, value] of Object.entries(model.thinkingLevelMap ?? {})) {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level) || (value !== null && typeof value !== "string")) {
        throw piError("PI_MODEL_INVALID_THINKING_MAP", `Model '${provider.id}/${model.id}' has an invalid thinking level map`, "provision");
      }
    }
    if (model.cost !== undefined && !hasPlainObjectPrototype(model.cost)) {
      throw piError("PI_MODEL_INVALID_COST", `Model '${provider.id}/${model.id}' has invalid cost metadata`, "provision");
    }
    for (const value of Object.values(model.cost ?? {})) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw piError("PI_MODEL_INVALID_COST", `Model '${provider.id}/${model.id}' has invalid cost metadata`, "provision");
      }
    }
    if (model.compat !== undefined && !hasPlainObjectPrototype(model.compat)) {
      throw piError("PI_MODEL_INVALID_COMPAT", `Model '${provider.id}/${model.id}' has invalid compatibility metadata`, "provision");
    }
    if (model.samplingParams !== undefined && !hasPlainObjectPrototype(model.samplingParams)) {
      throw piError("PI_MODEL_INVALID_SAMPLING", `Model '${provider.id}/${model.id}' has invalid sampling parameters`, "provision");
    }
    if (model.supportsFastMode !== undefined && typeof model.supportsFastMode !== "boolean") {
      throw piError("PI_MODEL_INVALID_FAST_MODE", `Model '${provider.id}/${model.id}' has invalid Fast Mode metadata`, "provision");
    }
    if (model.defaultVisible !== undefined && typeof model.defaultVisible !== "boolean") {
      throw piError("PI_MODEL_INVALID_VISIBILITY", `Model '${provider.id}/${model.id}' has invalid visibility metadata`, "provision");
    }
    assertNoInlineSecrets(model.compat, `model '${provider.id}/${model.id}' compatibility`);
    assertNoInlineSecrets(model.samplingParams, `model '${provider.id}/${model.id}' sampling parameters`);
  }
  if (provider.compat !== undefined && !hasPlainObjectPrototype(provider.compat)) {
    throw piError("PI_MODEL_INVALID_COMPAT", `Provider '${provider.id}' has invalid compatibility metadata`, "provision");
  }
  assertNoInlineSecrets(provider.compat, `provider '${provider.id}' compatibility`);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function piProviderModel(provider: PiManagedProvider, model: PiManagedModel): ProviderModel {
  const api = model.api ?? provider.api ?? "openai-completions";
  const thinkingLevels = supportedPiThinkingLevels(model.reasoning, model.thinkingLevelMap);
  const contextWindow = model.contextWindow ?? 128_000;
  return {
    providerId: provider.id,
    modelId: model.id,
    logicalId: model.logicalId ?? model.id,
    displayName: model.name ?? model.id,
    api,
    contextWindow,
    maxOutputTokens: piModelOutputTokenLimit(model.maxTokens, contextWindow),
    supportsImages: model.input?.includes("image") ?? false,
    defaultVisible: model.defaultVisible ?? true,
    supportsFastMode: model.supportsFastMode === true,
    thinkingLevels,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(model.cost === undefined ? {} : {
      pricing: {
        source: "upstream" as const,
        currencyCode: "USD",
        cacheReadAvailable: true,
        cacheWriteAvailable: true
      }
    })
  };
}

/** Keep Joko-only capability metadata out of Pi's models.json schema. */
function managedPiModelConfiguration(model: PiManagedModel): Record<string, unknown> {
  const {
    supportsFastMode: _supportsFastMode,
    defaultVisible: _defaultVisible,
    logicalId: _logicalId,
    ...piModel
  } = model;
  const contextWindow = model.contextWindow ?? 128_000;
  return compactObject({
    ...piModel,
    contextWindow,
    maxTokens: piModelOutputTokenLimit(model.maxTokens, contextWindow)
  });
}

function assertEnvironmentName(value: string): void {
  if (!ENV_NAME.test(value)) throw piError("PI_INVALID_ENV_REFERENCE", `Invalid managed environment reference '${value}'`, "provision");
}

function assertHeaderName(value: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw piError("PI_INVALID_HEADER", `Invalid provider header name '${value}'`, "provision");
}

function keylessEnvName(providerId: string): string {
  return `JOKO_PI_KEYLESS_${providerId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function materializeModelOverrides(
  overrides: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  secretEnvironmentNames: Set<string>
): Record<string, unknown> | undefined {
  if (!overrides) return undefined;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [modelId, rawOverride] of Object.entries(overrides)) {
    if (!MODEL_ID.test(modelId) || !isPlainObject(rawOverride)) {
      throw piError("PI_MODEL_INVALID_OVERRIDE", `Invalid managed model override '${modelId}'`, "provision");
    }
    const override: Record<string, unknown> = { ...rawOverride };
    if ("apiKey" in override || "oauth" in override || "baseUrl" in override) {
      throw piError("PI_MODEL_UNSAFE_OVERRIDE", `Model override '${modelId}' contains a credential or endpoint field`, "provision");
    }
    if (override.headers !== undefined) {
      if (!isPlainObject(override.headers)) throw piError("PI_MODEL_INVALID_OVERRIDE_HEADERS", `Model override '${modelId}' has invalid headers`, "provision");
      const headers: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [name, rawReference] of Object.entries(override.headers)) {
        assertHeaderName(name);
        const env =
          isPlainObject(rawReference) && typeof rawReference.env === "string"
            ? rawReference.env
            : typeof rawReference === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(rawReference)
              ? rawReference.slice(1)
              : undefined;
        if (!env) {
          throw piError("PI_MODEL_INLINE_SECRET_DENIED", `Model override '${modelId}' header '${name}' must use an environment reference`, "provision");
        }
        assertEnvironmentName(env);
        headers[name] = `$${env}`;
        secretEnvironmentNames.add(env);
      }
      override.headers = headers;
    }
    assertNoInlineSecrets(override, `model override '${modelId}'`);
    result[modelId] = override;
  }
  return result;
}

function assertNoInlineSecrets(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, key: string | undefined): void => {
    if (typeof candidate === "string" && key && /^(?:api[_-]?key|access[_-]?token|authorization|password|secret|credential)$/i.test(key)) {
      if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
        throw piError("PI_MODEL_INLINE_SECRET_DENIED", `${label} contains an inline secret-like field`, "provision");
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (active.has(candidate)) throw piError("PI_CONFIG_CIRCULAR_VALUE", `${label} contains a circular value`, "provision");
      active.add(candidate);
      for (const item of candidate) visit(item, key);
      active.delete(candidate);
      return;
    }
    if (!isPlainObject(candidate)) return;
    if (active.has(candidate)) throw piError("PI_CONFIG_CIRCULAR_VALUE", `${label} contains a circular value`, "provision");
    active.add(candidate);
    for (const [childKey, child] of Object.entries(candidate)) visit(child, childKey);
    active.delete(candidate);
  };
  visit(value, undefined);
}

function validateSettings(settings: PiManagedSettings): void {
  if (!hasPlainObjectPrototype(settings)) throw piError("PI_SETTINGS_INVALID", "Managed Pi settings must be a plain object", "provision");
  if (settings.compaction !== undefined && !hasPlainObjectPrototype(settings.compaction)) {
    throw piError("PI_SETTINGS_INVALID", "Managed Pi compaction settings must be a plain object", "provision");
  }
  if (settings.retry !== undefined && !hasPlainObjectPrototype(settings.retry)) {
    throw piError("PI_SETTINGS_INVALID", "Managed Pi retry settings must be a plain object", "provision");
  }
  if (settings.retry?.provider !== undefined && !hasPlainObjectPrototype(settings.retry.provider)) {
    throw piError("PI_SETTINGS_INVALID", "Managed Pi provider retry settings must be a plain object", "provision");
  }
  if (settings.images !== undefined && !hasPlainObjectPrototype(settings.images)) {
    throw piError("PI_SETTINGS_INVALID", "Managed Pi image settings must be a plain object", "provision");
  }
  if (settings.defaultTools !== undefined && !Array.isArray(settings.defaultTools)) {
    throw piError("PI_SETTINGS_INVALID", "Managed Pi defaultTools must be an array", "provision");
  }
  const nonNegative = (value: number | undefined, label: string): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw piError("PI_SETTINGS_INVALID_NUMBER", `${label} must be a non-negative safe integer`, "provision");
    }
  };
  nonNegative(settings.compaction?.reserveTokens, "compaction.reserveTokens");
  nonNegative(settings.compaction?.keepRecentTokens, "compaction.keepRecentTokens");
  const thresholdPercent = settings.compaction?.thresholdPercent;
  if (thresholdPercent !== undefined && (
    !Number.isSafeInteger(thresholdPercent)
    || thresholdPercent < PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM
    || thresholdPercent > PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM
  )) {
    throw piError(
      "PI_SETTINGS_INVALID_NUMBER",
      `compaction.thresholdPercent must be an integer from ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM} through ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM}`,
      "provision"
    );
  }
  nonNegative(settings.retry?.maxRetries, "retry.maxRetries");
  nonNegative(settings.retry?.baseDelayMs, "retry.baseDelayMs");
  nonNegative(settings.retry?.provider?.maxRetries, "retry.provider.maxRetries");
  nonNegative(settings.retry?.provider?.maxRetryDelayMs, "retry.provider.maxRetryDelayMs");
  const timeoutMs = settings.retry?.provider?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw piError("PI_SETTINGS_INVALID_NUMBER", "retry.provider.timeoutMs must be a positive safe integer", "provision");
  }
  for (const tool of settings.defaultTools ?? []) {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool)) throw piError("PI_SETTINGS_INVALID_TOOL", "Managed Pi defaultTools contains an invalid tool name", "provision");
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameManagedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function asProvisionError(error: unknown, code: string, message: string) {
  return piError(code, message, "provision", {
    retryable: true,
    recovery: "Ensure the Orchestrator service account owns and can access the managed Pi Agent Home.",
    cause: error
  });
}

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return hasPlainObjectPrototype(value);
}

function hasPlainObjectPrototype(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
