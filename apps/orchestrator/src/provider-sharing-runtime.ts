import type { HandlerContext } from "@connectrpc/connect";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault } from "./credential-vault.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { ProviderSharingHost } from "./provider-sharing-host.js";
import { ProviderSharingHome, type ProviderSharingHomeAuthority, type ProviderSharingRemote, type ProviderSharingRemoteOptions } from "./provider-sharing-home.js";
import type { ProviderSharingDirectoryPort } from "./provider-sharing-ports.js";
import type { ProviderSharingConnectOptions } from "./provider-sharing-connect-service.js";

export interface ProviderSharingRuntimeOptions {
  readonly store: OperationalStore; readonly directory: string; readonly serverId: string; readonly origin: string | (() => string); readonly endpointPublicKey: string;
  readonly vault: CredentialVault; readonly native: HostedAgentRuntime; readonly connections: ConnectionManager;
  readonly connect?: (options: ProviderSharingRemoteOptions) => ProviderSharingRemote;
  readonly closeNative?: (credentialDigest: string, runId: string) => Promise<void>;
}
/** The service owns foreign credentials for this Home independently of an
 * individual browser Connection. It refreshes authoritative state even while
 * the settings page is closed and retains unknown operations for recovery. */
export class ProviderSharingRuntime {
  readonly host: ProviderSharingHost; readonly home: ProviderSharingHome; readonly directory: ProviderSharingDirectoryPort;
  readonly #lifetime = new AbortController(); readonly #authority: ProviderSharingHomeAuthority;
  #refresh?: Promise<void>; #timer?: ReturnType<typeof setInterval>;
  private constructor(readonly options: ProviderSharingRuntimeOptions) {
    this.host = new ProviderSharingHost(options);
    this.home = new ProviderSharingHome(options); this.directory = this.home;
    this.#authority = { deviceId: options.serverId, signal: this.#lifetime.signal, assertCurrent: () => this.#lifetime.signal.throwIfAborted() };
  }
  static async create(options: ProviderSharingRuntimeOptions): Promise<ProviderSharingRuntime> {
    const runtime = new ProviderSharingRuntime(options);
    try { await runtime.home.initialize(); }
    catch (error) { await runtime.close(); throw error; }
    runtime.#timer = setInterval(() => { void runtime.refresh().catch(() => {}); }, 5_000); runtime.#timer.unref();
    void runtime.refresh().catch(() => {}); return runtime;
  }
  connectOptions(): ProviderSharingConnectOptions { return { host: this.host, home: this.home, connections: this.options.connections }; }
  authenticateGuest(context: HandlerContext) { return this.host.authenticateNative(context); }
  refresh(): Promise<void> {
    return this.#refresh ??= (async () => { this.#lifetime.signal.throwIfAborted(); await this.home.refresh(this.#authority); await this.host.reconcile(); })()
      .finally(() => { this.#refresh = undefined; });
  }
  async close(): Promise<void> {
    clearInterval(this.#timer); this.#lifetime.abort(); await this.#refresh?.catch(() => {}); await this.home.close(); this.host.close();
  }
}
export const createProviderSharingRuntime = ProviderSharingRuntime.create;
