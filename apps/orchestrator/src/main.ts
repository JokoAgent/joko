import { createReadStream, createWriteStream, type WriteStream } from "node:fs";

import { DesktopBootstrapGrant } from "@joko/contracts/desktop-bootstrap";
import {
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  createManagedOutboundProxyResolver
} from "@joko/contracts/managed-outbound-proxy";
import type { FastifyInstance } from "fastify";
import { formatTrustedNodeInvitation } from "@joko/connection-transport/trust";

import { createOrchestratorApplication } from "./application.js";
import { loadConfig, readTls } from "./config.js";
import {
  DESKTOP_BOOTSTRAP_REQUEST_FD,
  DESKTOP_BOOTSTRAP_RESPONSE_FD,
  exchangeDesktopBootstrapCommit,
  receiveDesktopBootstrapRequest,
  sendDesktopBootstrapCommitted,
  type ReceivedDesktopBootstrapRequest
} from "./desktop-bootstrap-pipe.js";
import { needsLocalPairingRecovery } from "./local-pairing-recovery.js";
import { createInternalServer, createPublicServer } from "./server.js";
import { createLinkspanIngress } from "./linkspan-server.js";
import { startManagedLinkspanConnector } from "./linkspan-connector.js";
import { linkspanHttpConnectTransport, linkspanMediaUdpEntryId, readLinkspanDeployment } from "./linkspan-deployment.js";
import { startManagedProviderConnector } from "./linkspan-provider-connector.js";
import { startLinkspanSdkIngress } from "./linkspan-sdk-server.js";
import { manageLinkspanResource, resolveManagedLinkspanConnector } from "./linkspan-resource-manager.js";
import { withOfflineLinkspanContext } from "./linkspan-offline-context.js";
import { issuePrivateIrohRelayInvitation } from "./linkspan-iroh-lease.js";
import { recoverOfflineEndpointIdentity } from "./linkspan-recovery.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import { withProviderGroupPeerPort } from "./provider-group-peer.js";
import { OrchestratorServiceLifecycle, OrchestratorStartupInterruptedError } from "./service-lifecycle.js";
import {
  createServiceDevicePeerRuntimeExecutables,
  ServiceDevicePeerAgent
} from "./service-device-peer-agent.js";

async function main(): Promise<void> {
  const desktopHostedPersistent = process.argv.includes("--desktop-hosted");
  const desktopHostedEphemeral = process.argv.includes("--desktop-hosted-ephemeral");
  if (desktopHostedPersistent && desktopHostedEphemeral) throw new Error("Desktop-hosted Orchestrator mode is ambiguous.");
  const desktopHosted = desktopHostedPersistent || desktopHostedEphemeral;
  const issuePairing = process.argv.includes("--issue-pairing");
  const resourceIndex = process.argv.indexOf("--linkspan-resource");
  const issueRelayLease = process.argv.includes("--issue-iroh-relay-lease");
  const resourceAction = resourceIndex < 0 ? undefined : process.argv[resourceIndex + 1];
  const mediaResource = process.argv.includes("--linkspan-media-udp");
  if (mediaResource && resourceIndex < 0) throw new Error("--linkspan-media-udp requires an explicit --linkspan-resource action.");
  if (resourceIndex >= 0 && (resourceAction === undefined || !["create", "status", "delete", "adopt"].includes(resourceAction))) throw new Error("--linkspan-resource requires create, status, delete or adopt.");
  if (resourceIndex >= 0 && (desktopHosted || issuePairing)) throw new Error("Linkspan resource management runs independently of Desktop bootstrap and pairing issuance.");
  if (issueRelayLease && (resourceIndex >= 0 || desktopHosted || issuePairing)) throw new Error("Relay invitation issuance runs independently of resource management, Desktop bootstrap and pairing issuance.");
  const recoverEndpoint = process.argv.includes("--recover-endpoint-identity");
  if (recoverEndpoint && (desktopHosted || issuePairing || resourceIndex >= 0 || issueRelayLease)) throw new Error("Endpoint recovery must run independently while the service is stopped.");
  if (recoverEndpoint) {
    const recovered = await recoverOfflineEndpointIdentity(loadConfig());
    process.stdout.write(`${JSON.stringify(recovered)}\n`);
    return;
  }
  if (desktopHosted && issuePairing) throw new Error("Desktop-hosted Orchestrator cannot issue a CLI pairing challenge.");
  let desktopBootstrap = desktopHosted ? await receiveDesktopBootstrap() : undefined;
  let config: ReturnType<typeof loadConfig>;
  let application: Awaited<ReturnType<typeof createOrchestratorApplication>>;
  try {
    config = loadConfig();
    if (resourceAction !== undefined || issueRelayLease) {
      await withOfflineLinkspanContext(config, async context => {
        const entryIndex = process.argv.indexOf("--linkspan-entry"), entryId = entryIndex < 0 ? undefined : process.argv[entryIndex + 1];
        if (config.linkspan?.deploymentPath === undefined || entryId === undefined) throw new Error("Resource management requires the private connectors file and --linkspan-entry <id>.");
        const entries = await readLinkspanDeployment(config.linkspan.deploymentPath, new AbortController().signal, { resolveRuntime: false });
        const entry = entries.find(value => value.id === entryId);
        if (issueRelayLease) {
          const keyIndex = process.argv.indexOf("--linkspan-client-key"), clientEndpointId = keyIndex < 0 ? undefined : process.argv[keyIndex + 1];
          if (entry?.connector?.provider !== "iroh" || clientEndpointId === undefined) throw new Error("Relay invitation issuance requires an explicitly configured iroh entrance and --linkspan-client-key <B-public-key>.");
          const result = await issuePrivateIrohRelayInvitation(context, { entryId, configuration: entry.connector, clientEndpointId });
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }
        const management = mediaResource ? entry?.mediaUdpManagement : entry?.management;
        if (management === undefined) throw new Error("The selected entrance has no explicit resource management configuration for this purpose.");
        const resourceIdIndex = process.argv.indexOf("--linkspan-resource-id");
        const confirmResourceId = resourceIdIndex < 0 ? undefined : process.argv[resourceIdIndex + 1];
        const result = await manageLinkspanResource(context, { action: resourceAction as "create" | "status" | "delete" | "adopt", entryId: mediaResource ? linkspanMediaUdpEntryId(entryId) : entryId,
          configuration: management, ...(confirmResourceId === undefined ? {} : { confirmResourceId }) });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      });
      return;
    }
    if (desktopHosted && config.devicePeerAgent !== undefined) {
      throw new Error("A Desktop-hosted Orchestrator cannot own a Service Device peer identity.");
    }
    const resolveOutboundProxy = createManagedOutboundProxyResolver(
      process.env[MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV]
    );
    application = await createOrchestratorApplication(config, {
      resolveOutboundProxy: (upstreamUrl) => resolveOutboundProxy(upstreamUrl)
    });
  } catch (error) {
    disposeDesktopBootstrap(desktopBootstrap);
    throw error;
  }
  if (issuePairing) {
    try {
      const challenge = application.connections.issuePairing("Orchestrator local CLI");
      process.stdout.write(`${JSON.stringify({
        challengeId: challenge.id,
        humanCode: challenge.code,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        serverId: application.serverId,
        origin: application.advertisedOrigin?.() ?? config.publicOrigin,
        endpointPublicKey: application.linkspanIdentity?.publicKey
      })}\n`);
    } finally {
      await application.close();
    }
    return;
  }
  let bootstrapComplete = false;
  const lifecycle = new OrchestratorServiceLifecycle(application, () => disposeDesktopBootstrap(desktopBootstrap));
  const requestExternalShutdown = (signal: string): void => {
    void lifecycle.requestShutdown(signal).catch(() => {
      process.stderr.write("Orchestrator shutdown could not close all resources.\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => requestExternalShutdown("SIGINT"));
  process.once("SIGTERM", () => requestExternalShutdown("SIGTERM"));
  const desktopParentDisconnected = desktopBootstrap?.lease.parentDisconnected;
  if (desktopParentDisconnected !== undefined) {
    // The pipe owns only the short bootstrap. Once a normal durable
    // Connection has been returned, Desktop is no longer the workload owner
    // and closing it must not stop Session/Run/Queue/Schedule work.
    void desktopParentDisconnected.then(() => {
      if (!bootstrapComplete || desktopHostedEphemeral) {
        requestExternalShutdown("desktop_bootstrap_disconnected");
      }
    });
  }

  let startupError: unknown;
  try {
    const server = lifecycle.registerPublicServer(await createPublicServer(application));
    lifecycle.assertStartupActive();
    const internalServer = lifecycle.registerInternalServer(await createInternalServer(application));
    lifecycle.assertStartupActive();
    lifecycle.registerPairingAnnouncements(application.connections.onPairingIssued((challenge) => {
      // Pairing codes are owner console output, never structured log fields.
      process.stdout.write(`Orchestrator pairing code: ${challenge.code} (expires ${new Date(challenge.expiresAt).toISOString()})\n`);
    }));
    lifecycle.assertStartupActive();
    await server.listen({ host: config.host, port: config.port });
    lifecycle.assertStartupActive();
    const bridge = lifecycle.registerTransport(await createPublicServer(application, { secureBridge: true }));
    const bridgeOrigin = await bridge.listen({ host: "127.0.0.1", port: 0 });
    lifecycle.assertStartupActive();
    lifecycle.registerTransport(createLinkspanIngress(application, { backendOrigin: bridgeOrigin, server: server.server }));
    if (config.linkspan !== undefined) {
      const ingress = lifecycle.registerTransport(createLinkspanIngress(application, { backendOrigin: bridgeOrigin,
        ...(config.tls === undefined ? {} : { tls: readTls(config)! }) }));
      const localOrigin = await ingress.listen({ host: "127.0.0.1", port: config.linkspan.port });
      lifecycle.assertStartupActive();
      if (config.linkspan.cloudflaredExecutable !== undefined) {
        const connector = lifecycle.registerTransport(await startManagedLinkspanConnector(application, {
          executable: config.linkspan.cloudflaredExecutable, localOrigin, signal: lifecycle.signal,
          originCaPool: config.linkspan.originCaPool!, originServerName: config.linkspan.originServerName!
        }));
        lifecycle.assertStartupActive();
        process.stdout.write(`Joko public encrypted endpoint: ${JSON.stringify({ origin: connector.publicOrigin,
          serverId: application.serverId, endpointPublicKey: application.linkspanIdentity?.publicKey,
          provider: "cloudflare", mode: "quick", helperTarget: `${process.platform}-${process.arch}`, limits: connector.limits,
          carrierVerification: { trafficQuota: "not_verified", singleConnectionDuration: "not_verified",
            maximumMessageBytes: "not_verified", idleTimeout: "not_verified" } })}\n`);
      }
      if (config.linkspan.deploymentPath !== undefined) {
        const entries = await readLinkspanDeployment(config.linkspan.deploymentPath, lifecycle.signal);
        lifecycle.assertStartupActive();
        for (const entry of entries) {
          if (entry.connector === undefined) continue;
          if (entry.connector.provider === "iroh" || entry.connector.provider === "tailcat") {
            const sdk = lifecycle.registerTransport(await startLinkspanSdkIngress(application, { id: entry.id, connector: entry.connector }, { backendOrigin: bridgeOrigin, signal: lifecycle.signal }));
            lifecycle.assertStartupActive();
            process.stdout.write(`Joko private SDK invitation: ${JSON.stringify({ entryId: entry.id, provider: sdk.provider, invitationPath: sdk.invitationPath, limits: sdk.limits })}\n`);
            continue;
          }
          const endpointTransport = linkspanHttpConnectTransport(entry.connector);
          if (endpointTransport === undefined && config.tls === undefined) throw new Error("Public HTTP/TCP connectors require the configured JOKO_TLS_CERT and JOKO_TLS_KEY.");
          const selectedConnector = await resolveManagedLinkspanConnector(application, { entryId: entry.id, connector: entry.connector });
          lifecycle.assertStartupActive();
          const encryptedStreamTarget = endpointTransport === undefined ? undefined
            : await lifecycle.registerTransport((await import("./linkspan-tcp-server.js")).createLinkspanTcpIngress(application,
              { backendOrigin: bridgeOrigin, signal: lifecycle.signal })).listen();
          lifecycle.assertStartupActive();
          const connector = lifecycle.registerTransport(await startManagedProviderConnector(application, { id: entry.id, connector: selectedConnector }, {
            ...(encryptedStreamTarget === undefined
              ? { localOrigin, originCaPool: config.linkspan.originCaPool!, originServerName: config.linkspan.originServerName! }
              : { encryptedStreamTarget }), signal: lifecycle.signal
          }));
          lifecycle.assertStartupActive();
          process.stdout.write(`Joko public encrypted endpoint: ${JSON.stringify({ entryId: entry.id, provider: entry.connector.provider,
            origin: connector.publicOrigin, serverId: application.serverId, endpointPublicKey: application.linkspanIdentity?.publicKey,
            ...(connector.endpointTransport === undefined ? {} : { endpointTransport: connector.endpointTransport }), limits: connector.limits })}\n`);
          if (connector.endpointTransport !== undefined) {
            process.stdout.write(`Joko trusted node invitation: ${formatTrustedNodeInvitation({ origin: connector.publicOrigin,
              serverId: application.serverId, endpointPublicKey: application.linkspanIdentity!.publicKey, endpointTransport: connector.endpointTransport })}\n`);
          }
        }
      }
    }
    await internalServer.listen({ host: "127.0.0.1", port: config.internalPort });
    lifecycle.assertStartupActive();
    if (config.devicePeerAgent !== undefined) {
      const serviceDevicePeerAgent = new ServiceDevicePeerAgent({
        config: config.devicePeerAgent,
        ...(application.hostedAgents === undefined ? {} : {
          createNativeAgentPort: () => {
            const native = createHostedAgentPeerPort(application.hostedAgents!, config.devicePeerAgent!.controllerServerId);
            return application.providerGroups ? withProviderGroupPeerPort(native,
              application.providerGroups.connectOptions(() => { throw new Error("A current Device route is required."); })) : native;
          }
        }),
        runtimeExecutables: await createServiceDevicePeerRuntimeExecutables(config)
      });
      const unregister = application.registerServiceCleanup?.(() => serviceDevicePeerAgent.close());
      if (unregister === undefined) {
        throw new Error("The Service Device peer lifecycle owner is unavailable.");
      }
      await serviceDevicePeerAgent.start();
      lifecycle.assertStartupActive();
    }
    if (desktopBootstrap !== undefined) {
      const bootstrap = desktopBootstrap;
      const response = bootstrap.grant.exchange({
        serverId: application.serverId,
        origin: config.publicOrigin,
        endpointPublicKey: application.linkspanIdentity?.publicKey,
        issueConnection: (input) => application.connections.issueTrustedDesktopConnection(input)
      });
      const commit = await exchangeDesktopBootstrapCommit(bootstrap.lease, bootstrap.responsePipe, response);
      const committed = bootstrap.grant.confirmCommit(commit);
      application.connections.confirmTrustedDesktopConnection(response.connectionId, response.authKey);
      // Desktop has durably stored the normal Connection. A confirmation write
      // failure is still handled by startup cleanup; successful persistent
      // hosting then releases the short bootstrap lease without making the UI
      // process the workload owner.
      bootstrapComplete = true;
      await sendDesktopBootstrapCommitted(bootstrap.responsePipe, committed);
      if (!desktopHostedEphemeral) {
        disposeDesktopBootstrap(bootstrap);
        desktopBootstrap = undefined;
      }
      lifecycle.assertStartupActive();
    }
    if (config.lanDiscoveryEnabled) {
      await application.lanDiscovery.start().catch(() => {
        server.log.warn("Orchestrator LAN discovery is unavailable; direct connections remain available.");
      });
      lifecycle.assertStartupActive();
    }
    if (!desktopHosted && needsLocalPairingRecovery(application.store)) {
      process.stdout.write(`Joko trusted endpoint: ${JSON.stringify({ origin: config.publicOrigin, serverId: application.serverId,
        endpointPublicKey: application.linkspanIdentity?.publicKey })}\n`);
      application.connections.openPairingWindow();
      application.connections.issuePairing("Orchestrator service console");
    }
  } catch (error) {
    startupError = error;
    void lifecycle.requestShutdown(error instanceof OrchestratorStartupInterruptedError ? "startup_interrupted" : "startup_failure");
  } finally {
    lifecycle.finishStartup();
    if (lifecycle.shutdownRequested) await lifecycle.requestShutdown("startup_failure");
  }
  if (startupError !== undefined && !(startupError instanceof OrchestratorStartupInterruptedError)) throw startupError;
}

interface DesktopBootstrapState {
  readonly lease: Omit<ReceivedDesktopBootstrapRequest, "request">;
  readonly responsePipe: WriteStream;
  readonly grant: DesktopBootstrapGrant;
}

async function receiveDesktopBootstrap(): Promise<DesktopBootstrapState> {
  const requestPipe = createReadStream("", {
    fd: DESKTOP_BOOTSTRAP_REQUEST_FD,
    autoClose: true
  });
  const responsePipe = createWriteStream("", {
    fd: DESKTOP_BOOTSTRAP_RESPONSE_FD,
    autoClose: true
  });
  try {
    const received = await receiveDesktopBootstrapRequest(requestPipe);
    const grant = DesktopBootstrapGrant.accept(received.request, { expectedParentPid: process.ppid });
    const lease = {
      parentDisconnected: received.parentDisconnected,
      receiveCommit: received.receiveCommit,
      close: received.close
    };
    return { lease, responsePipe, grant };
  } catch (error) {
    requestPipe.destroy();
    responsePipe.destroy();
    throw error;
  }
}

function disposeDesktopBootstrap(state: DesktopBootstrapState | undefined): void {
  state?.grant.dispose();
  state?.responsePipe.destroy();
  state?.lease.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
