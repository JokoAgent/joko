import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCodexAdapter, CODEX_MANAGED_PROVIDER_SUPPORT, useCodexHistoryHome, type CodexHostedAuthenticationAuthority, type CodexBackendAdapter } from "@joko/adapter-codex";
import { createChildRuntimeEnvironment, type DurableProcessOwnerOptions } from "@joko/runtime-governance";
import type { ProviderCatalogManager } from "./credential-manager.js";
import type { HostedAgentBackendCreation } from "./hosted-agent-runtime.js";
import { createHostedAgentManagedProviderRuntime } from "./hosted-agent-managed-provider-runtime.js";
import { createHostedAgentCodexTunnel } from "./hosted-agent-codex-tunnel.js";

/** Dedicated Model Host SDK, private account authority and native Source environment. */
export async function createHostedAgentCodexAdapter(options: {
  readonly creation: HostedAgentBackendCreation;
  readonly backendId: string;
  readonly providers: ProviderCatalogManager;
  readonly captureNativeAuthentication?: () => Promise<CodexHostedAuthenticationAuthority>;
  readonly executable: string;
  readonly processOwner?: DurableProcessOwnerOptions;
  /** Exact native-account runtime values, admitted only while its Provider is allowed. */
  readonly nativeEnvironment?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}): Promise<CodexBackendAdapter> {
  const { creation } = options;
  const assertCurrent = () => { creation.signal.throwIfAborted(); creation.execution.assertCurrent(); };
  assertCurrent();
  const home = creation.execution.trust === "guest" ? creation.execution.guestHome : creation.home;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(home) !== resolve(home)) throw new Error("The hosted Codex home is not private.");
  // The original SDK alone owns persistent native credentials. Dedicated SDKs
  // use ephemeral RPC authentication; managed Providers use the per-run proxy.
  const nativeAllowed = creation.providerIds.includes("openai");
  await unlink(join(home, "auth.json")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  assertCurrent();
  const account = nativeAllowed ? await options.captureNativeAuthentication?.() : undefined;
  assertCurrent(); if (nativeAllowed && !account) throw new Error("The original native account authority is unavailable.");
  const provider = await createHostedAgentManagedProviderRuntime({ creation, backendId: options.backendId, providers: options.providers,
    support: CODEX_MANAGED_PROVIDER_SUPPORT, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  try {
    const selectedNative: Record<string, string> = {};
    if (nativeAllowed) for (const name of ["OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_ORG_ID", "OPENAI_PROJECT", "OPENAI_PROJECT_ID"]) {
      const value = options.nativeEnvironment?.[name]; if (value !== undefined) selectedNative[name] = value;
    }
    const environment = useCodexHistoryHome(createChildRuntimeEnvironment({ overrides: { ...selectedNative, CODEX_HOME: home,
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, SSH_AUTH_SOCK: undefined,
      XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state") } }).environment, home);
    const runtime = { ...provider.runtime, secretEnvironmentNames: [...new Set([...provider.runtime.secretEnvironmentNames, ...Object.keys(selectedNative)])] };
    const adapter = createCodexAdapter({ id: options.backendId, instanceGeneration: creation.nativeOwner.backendInstanceGeneration,
      profileDirectory: home, managedProviders: runtime, hostedExecution: { execution: creation.execution, openExecServer: createHostedAgentCodexTunnel,
        ...(creation.sourceMcp ? { openMcpBridge: input => creation.sourceMcp!.codex(input) } : {}) },
      readBlob: async blob => ({ data: await creation.readBlob(blob), mimeType: blob.mimeType }),
      appServer: { requireEphemeralAuth: true,
        ...(account?.kind === "chatgpt" ? { externalAuth: { readTokens: async (refresh: boolean, staleAccessToken?: string) => {
          assertCurrent(); const tokens = await account.readTokens(refresh, staleAccessToken); assertCurrent(); return tokens;
        } } } : account?.kind === "api_key" ? { apiKeyAuth: async () => {
          assertCurrent(); const apiKey = await account.readApiKey(); assertCurrent(); return apiKey;
        } } : {}), transport: { command: options.executable, args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="ephemeral"'], cwd: creation.execution.workspace.root,
        env: environment, ...(options.processOwner === undefined ? {} : { processOwner: options.processOwner }) } } });
    const dispose = adapter.dispose.bind(adapter), forceDispose = adapter.forceDispose.bind(adapter);
    adapter.dispose = async () => { try { await dispose(); } finally { await provider.close(); } };
    adapter.forceDispose = async () => { try { await forceDispose(); } finally { await provider.close(); } };
    assertCurrent(); return adapter;
  } catch (error) { await provider.close(); throw error; }
}
