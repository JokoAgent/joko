import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ByteChannel } from "@jokoagent/linkspan-core";
import { formatTrustedNodeInvitation } from "@joko/connection-transport/trust";
import { inspectKeyDirectoryPermissions } from "@joko/remote-ssh";
import type { OrchestratorApplication } from "./application.js";
import type { SdkDeployment } from "./linkspan-deployment.js";
import { serveLinkspanChannel } from "./linkspan-server.js";
import { linkspanProcessIsRetired, ownLinkspanProcessIdentity } from "./linkspan-process-identity.js";
import { operationBodyHash } from "@joko/store";
import { readIceToken } from "./remote-desktop-ice-configuration.js";
import { registerIrohRelayIssuer } from "./linkspan-iroh-lease.js";
import { publishConnectionEntry } from './connection-entries.js';

interface SdkRecord { readonly requestId: string; readonly processId: number; readonly processIdentity: string; readonly state: "starting" | "active" | "closed" }

/** Backend-specific addresses stay in private invitations, never public discovery. */
export async function startLinkspanSdkIngress(application: OrchestratorApplication, entry: { readonly id: string; readonly displayName?: string; readonly connector: SdkDeployment }, input: {
  readonly backendOrigin: string; readonly signal: AbortSignal;
}) {
  const { connector: config } = entry, identity = application.linkspanIdentity;
  if (identity === undefined) throw new Error("The node's trusted identity is unavailable.");
  if (config.provider === "iroh" && (config.servicesApiSecretPath !== undefined || config.servicesApiSecret !== undefined) && (!config.relayUrls || config.relayUrls.length === 0)) {
    throw new Error("An iroh issuer requires explicitly configured relay URLs before starting a paid relay endpoint.");
  }
  if (!isAbsolute(config.invitationDirectory)) throw new Error("SDK invitations require an absolute private directory outside source/workspace roots.");
  const invitationDirectory = await realpath(config.invitationDirectory);
  const excludedRoots = await Promise.all([application.config.workspace.root, fileURLToPath(new URL("../../../", import.meta.url))].map(root => realpath(root)));
  if (excludedRoots.some(root => within(root, invitationDirectory))) throw new Error("SDK invitations must remain outside source/workspace roots.");
  await inspectKeyDirectoryPermissions(invitationDirectory, input.signal);
  const store = application.store, journal = `runtime.linkspan.sdk.${entry.id}`;
  const processIdentity = ownLinkspanProcessIdentity();
  const previous = store.findSetting<SdkRecord>("service", "orchestrator", journal)?.value;
  if (previous !== undefined && previous.state !== "closed") {
    if (!linkspanProcessIsRetired(previous.processId, previous.processIdentity)) throw new Error("The previous SDK endpoint's owning process must be confirmed stopped before replacement.");
    const operation = store.getOperation(previous.requestId);
    if (operation.kind !== "connection.sdk.listen" || operation.connectionId !== undefined || operation.completionMode !== "external_effect"
      || operation.status === "failed" || operation.bodyHash !== operationBodyHash({ entryId: entry.id, provider: config.provider, serverId: application.serverId })) throw new Error("The original SDK endpoint operation conflicts with this recovery.");
    store.completeDeferredEffectOperation(previous.requestId, operation.bodyHash, () => ({ state: "closed", reason: "owning_process_gone" }));
    store.setSetting("service", "orchestrator", journal, { ...previous, state: "closed" });
  }
  const requestId = `linkspan-sdk:${entry.id}:${randomUUID()}`;
  const claim = store.claimDeferredEffectOperation({ id: requestId, kind: "connection.sdk.listen",
    body: { entryId: entry.id, provider: config.provider, serverId: application.serverId } }, current => {
      current.setSetting("service", "orchestrator", journal, { requestId, processId: process.pid, processIdentity, state: "starting" });
    });
  const shutdown = new AbortController(), signal = AbortSignal.any([input.signal, shutdown.signal]);
  const active = new Set<ByteChannel>(), serving = new Set<Promise<void>>();
  let listener: Awaited<ReturnType<typeof import("@jokoagent/linkspan-iroh/node")["listenIroh"]>>
    | Awaited<ReturnType<typeof import("@jokoagent/linkspan-tailcat/node")["listenTailcat"]>> | undefined;
  let closing: Promise<void> | undefined;
  let acceptLoop: Promise<void> | undefined;
  let retireIssuer: (() => void) | undefined;
  let retireEntry: (() => void) | undefined;
  const markClosed = (): void => { store.setSetting("service", "orchestrator", journal, { requestId, processId: process.pid, processIdentity, state: "closed" }); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    const pending = (async () => {
      retireEntry?.(); retireEntry = undefined;
      retireIssuer?.(); retireIssuer = undefined;
      shutdown.abort(); for (const channel of active) channel.abort();
      await listener?.close(); await acceptLoop; await Promise.all(serving); markClosed();
    })();
    closing = pending;
    void pending.catch(() => { if (closing === pending) closing = undefined; });
    return pending;
  };
  try {
    if (config.provider === "iroh") {
      if (!/^[a-f0-9]{64}$/u.test(config.secretKeyHex)) throw new Error("The iroh server requires a private 32-byte identity key in its deployment configuration.");
      const [{ listenIroh, IROH_LIMITS }, { configureIrohRuntime }] = await Promise.all([
        import("@jokoagent/linkspan-iroh/node"), import("@jokoagent/linkspan-iroh-node")
      ]);
      configureIrohRuntime(fileURLToPath(new URL("../dist/linkspan-runtime/iroh", import.meta.url)));
      let servicesApiSecret: string | undefined = config.servicesApiSecret;
      if (config.servicesApiSecretPath !== undefined) {
        if (!isAbsolute(config.servicesApiSecretPath)) throw new Error("The iroh issuer-secret file must be absolute and outside source/workspace roots.");
        const path = await realpath(config.servicesApiSecretPath);
        if (excludedRoots.some(root => within(root, path))) throw new Error("The iroh issuer-secret file must remain outside source/workspace roots.");
        servicesApiSecret = await readIceToken(path, signal);
      }
      listener = await listenIroh({ identity, signal, secretKey: Buffer.from(config.secretKeyHex, "hex"),
        ...(config.relayUrls === undefined ? {} : { relayUrls: config.relayUrls }), ...(config.relayToken === undefined ? {} : { relayToken: config.relayToken }),
        ...(config.relayTokenExpiresAt === undefined ? {} : { relayTokenExpiresAt: config.relayTokenExpiresAt }),
        ...(servicesApiSecret === undefined ? {} : { servicesApiSecret }),
        ...(config.relayLeaseTtlSeconds === undefined ? {} : { servicesTokenTtlSeconds: config.relayLeaseTtlSeconds }) });
      const invitationPath = await saveInvitation({ kind: "iroh", endpointId: listener.endpointId, ticket: "ticket" in listener ? listener.ticket : "",
        ...(config.relayUrls === undefined ? {} : { relayUrls: config.relayUrls }) });
      retireIssuer = registerIrohRelayIssuer(application, { entryId: entry.id, configuration: config, endpointId: listener.endpointId, ticket: "ticket" in listener ? listener.ticket : "" });
      startServing(); return { close, invitationPath, provider: config.provider, limits: IROH_LIMITS };
    }
    if (!/^privkey:[a-f0-9]{64}$/u.test(config.serverKey) || !/^psk:[a-f0-9]{64}$/u.test(config.presharedKey)) throw new Error("Tailcat requires fixed private server and pre-shared keys in its deployment configuration.");
    const [{ listenTailcat, TAILCAT_LIMITS }, { configureTailcatRuntime }] = await Promise.all([
      import("@jokoagent/linkspan-tailcat/node"), import("@jokoagent/linkspan-tailcat-node")
    ]);
    configureTailcatRuntime(fileURLToPath(new URL("../dist/linkspan-runtime/tailcat", import.meta.url)));
    listener = await listenTailcat({ identity, signal, serverKey: config.serverKey, presharedKey: config.presharedKey, allowedClients: config.allowedClients,
      ...(config.allowPrivateAddressPairing === undefined ? {} : { allowPrivateAddressPairing: config.allowPrivateAddressPairing }),
      ...(config.port === undefined ? {} : { port: config.port }), ...(config.derpMapUrl === undefined ? {} : { derpMapUrl: config.derpMapUrl }),
      ...(config.regionId === undefined ? {} : { regionId: config.regionId }) });
    const invitationPath = await saveInvitation({ kind: "tailcat", endpointId: listener.endpointId,
      address: "address" in listener ? listener.address : "", port: "port" in listener ? listener.port : 0 });
    startServing(); return { close, invitationPath, provider: config.provider, limits: TAILCAT_LIMITS };
  } catch (error) {
    await close();
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, () => ({ state: "closed", reason: "startup_failed_and_endpoint_retired" }));
    throw error;
  }

  async function saveInvitation(endpointTransport: Extract<import("@joko/connection-transport/trust").EndpointTransport, { readonly kind: "iroh" | "tailcat" }>): Promise<string> {
    signal.throwIfAborted();
    const invitation = formatTrustedNodeInvitation({ origin: application.config.publicOrigin, serverId: application.serverId,
      endpointPublicKey: identity!.publicKey, endpointTransport });
    const destination = join(invitationDirectory, `${entry.id}-${requestId.split(":").at(-1)}.json`);
    await writeFile(destination, invitation + "\n", { flag: "wx", mode: 0o600 });
    // A new file is exclusive. The surrounding directory has already passed the
    // host's platform-specific private-directory inspection.
    signal.throwIfAborted();
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", journal, { requestId, processId: process.pid, processIdentity, state: "active" });
      return { state: "active", provider: config.provider, endpointId: endpointTransport.endpointId };
    });
    retireEntry = publishConnectionEntry(store, { id: `linkspan:${entry.id}`, provider: config.provider,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      origin: application.config.publicOrigin, transport: endpointTransport,
      ...(config.provider === 'iroh' ? { managedIrohLease: config.servicesApiSecretPath !== undefined || config.servicesApiSecret !== undefined }
        : { allowedClients: config.allowedClients, allowPrivateAddressPairing: config.allowPrivateAddressPairing === true }) });
    return destination;
  }
  function startServing(): void {
    acceptLoop = (async () => {
      while (!signal.aborted) {
        const channel = await listener!.accept({ signal }); if (channel === null) break;
        if (signal.aborted || active.size >= 128) { channel.abort(); continue; }
        active.add(channel);
        const pending = serveLinkspanChannel(application, channel, input.backendOrigin, signal).catch(() => { channel.abort(); })
          .finally(() => { active.delete(channel); serving.delete(pending); });
        serving.add(pending);
      }
    })().catch(() => {
      if (!signal.aborted) {
        process.stderr.write("The selected SDK endpoint stopped accepting connections. Its private invitation and original operation were retained.\n");
        // Do not await this loop's own promise from inside its catch handler.
        void close().catch(() => { process.stderr.write("The SDK endpoint cleanup is unconfirmed; its original operation was retained.\n"); });
      }
    });
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate)); return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
