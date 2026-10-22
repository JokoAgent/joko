import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLAUDE_MANAGED_PROVIDER_SUPPORT, ClaudeCodeAdapter, type ClaudeCodeCredentialPort } from "@joko/adapter-claude-code";
import { createDefaultManagedProcessSupervisor } from "@joko/adapter-pi";
import type { HostedAgentBackendFactory } from "./hosted-agent-runtime.js";
import type { ProviderCatalogManager } from "./credential-manager.js";
import { createHostedAgentManagedProviderRuntime } from "./hosted-agent-managed-provider-runtime.js";
import { createHostedAgentClaudeNativeTransport } from "./hosted-agent-claude-native-transport.js";

export async function createHostedAgentClaudeAdapter(options: {
  readonly creation: Parameters<HostedAgentBackendFactory["create"]>[0];
  readonly backendId: string;
  readonly providers: ProviderCatalogManager;
  readonly credentialPort: ClaudeCodeCredentialPort;
  readonly fetch?: typeof fetch;
  readonly pathToExecutable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ClaudeCodeAdapter> {
  const { creation } = options;
  creation.signal.throwIfAborted(); creation.execution.assertCurrent();
  if (creation.nativeOwner.backendInstanceGeneration !== 1 || !creation.providerIds.includes(creation.providerId)
    || creation.trust === "guest" && (creation.providerIds.length !== 1 || creation.execution.trust !== "guest")) {
    throw new Error("The hosted native Provider scope is invalid.");
  }
  const home = resolve(creation.home), config = join(home, "claude");
  if (await realpath(home) !== home) throw new Error("The hosted native home is not canonical.");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const managed = await createHostedAgentManagedProviderRuntime({ creation, backendId: options.backendId,
    providers: options.providers, support: CLAUDE_MANAGED_PROVIDER_SUPPORT, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const credentials: ClaudeCodeCredentialPort | undefined = creation.providerIds.includes("claude-code") ? {
    async readSerialized() { creation.signal.throwIfAborted(); creation.execution.assertCurrent(); return options.credentialPort.readSerialized(); },
    async compareAndSet(input) { creation.signal.throwIfAborted(); creation.execution.assertCurrent(); return options.credentialPort.compareAndSet(input); },
    // Hosted startup can refresh the pinned account but cannot create login,
    // restore a different identity, or delete the owner's subscription.
    restoreExact: async () => false, deleteExact: async () => false
  } : undefined;
  let nativeTransport: Awaited<ReturnType<typeof createHostedAgentClaudeNativeTransport>> | undefined;
  try {
    if (credentials) nativeTransport = await createHostedAgentClaudeNativeTransport({ creation, credentials, ...(options.fetch ? { fetch: options.fetch } : {}) });
  } catch (error) { managed.runtime.dispose(); await managed.close(); throw error; }
  class DedicatedClaudeAdapter extends ClaudeCodeAdapter {
    override async dispose(): Promise<void> { try { await super.dispose(); } finally { await Promise.all([managed.close(), nativeTransport?.close()]); } }
    override async forceDispose(): Promise<void> { try { await super.forceDispose(); } finally { await Promise.all([managed.close(), nativeTransport?.close()]); } }
  }
  try {
    creation.signal.throwIfAborted(); creation.execution.assertCurrent();
    const isolatedHome = creation.execution.trust === "guest" ? creation.execution.guestHome : home;
    return new DedicatedClaudeAdapter({ id: options.backendId, instanceGeneration: 1, managedProviders: managed.runtime,
      ...(credentials ? { credentialPort: credentials } : {}), ...(options.fetch ? { oauthFetch: options.fetch } : {}),
      ...(nativeTransport ? { hostedSubscriptionTransport: { endpoint: nativeTransport.environment["ANTHROPIC_BASE_URL"]!, bearer: nativeTransport.secret,
        registerModels: nativeTransport.registerModels,
        assertCurrent: () => { creation.signal.throwIfAborted(); creation.execution.assertCurrent(); } } } : {}),
      ...(options.pathToExecutable ? { pathToClaudeCodeExecutable: options.pathToExecutable } : {}),
      probeCwd: creation.execution.workspace.root, settingSources: [],
      ...(creation.sourceMcp ? { mcpBridge: creation.sourceMcp.claude() } : {}),
      readBlob: async blob => ({ data: await creation.readBlob(blob), mimeType: blob.mimeType }),
      processOwner: { rootDirectory: join(home, "processes"), instanceId: options.backendId, generation: 1,
        recoverStale: true, supervisor: createDefaultManagedProcessSupervisor() },
      sessionStoreRootDirectory: join(home, "session-store"),
      environment: { ...options.environment, ...nativeTransport?.environment, HOME: isolatedHome, USERPROFILE: isolatedHome,
        APPDATA: join(home, "config"), LOCALAPPDATA: join(home, "local"), CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_MANAGED_SETTINGS_PATH: undefined, CLAUDE_CODE_REMOTE_SETTINGS_PATH: undefined,
        HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined },
      ...(nativeTransport ? { redactValues: [nativeTransport.secret] } : {}),
      resolveNativeMemoryEnabled: () => false
    });
  } catch (error) { managed.runtime.dispose(); await Promise.all([managed.close(), nativeTransport?.close()]); throw error; }
}
