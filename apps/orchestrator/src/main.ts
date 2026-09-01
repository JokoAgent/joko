import { createReadStream, createWriteStream, type WriteStream } from "node:fs";

import { DesktopBootstrapGrant } from "@joko/contracts/desktop-bootstrap";
import {
  MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV,
  createManagedOutboundProxyResolver
} from "@joko/contracts/managed-outbound-proxy";
import type { FastifyInstance } from "fastify";

import { createOrchestratorApplication } from "./application.js";
import { loadConfig } from "./config.js";
import {
  DESKTOP_BOOTSTRAP_REQUEST_FD,
  DESKTOP_BOOTSTRAP_RESPONSE_FD,
  receiveDesktopBootstrapRequest,
  sendDesktopBootstrapCommitted,
  sendDesktopBootstrapResponse,
  type ReceivedDesktopBootstrapRequest
} from "./desktop-bootstrap-pipe.js";
import { needsLocalPairingRecovery } from "./local-pairing-recovery.js";
import { createInternalServer, createPublicServer } from "./server.js";
import { OrchestratorServiceLifecycle, OrchestratorStartupInterruptedError } from "./service-lifecycle.js";

async function main(): Promise<void> {
  const desktopHostedPersistent = process.argv.includes("--desktop-hosted");
  const desktopHostedEphemeral = process.argv.includes("--desktop-hosted-ephemeral");
  if (desktopHostedPersistent && desktopHostedEphemeral) throw new Error("Desktop-hosted Orchestrator mode is ambiguous.");
  const desktopHosted = desktopHostedPersistent || desktopHostedEphemeral;
  const issuePairing = process.argv.includes("--issue-pairing");
  if (desktopHosted && issuePairing) throw new Error("Desktop-hosted Orchestrator cannot issue a CLI pairing challenge.");
  let desktopBootstrap = desktopHosted ? await receiveDesktopBootstrap() : undefined;
  let config;
  let application;
  try {
    config = loadConfig();
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
        expiresAt: new Date(challenge.expiresAt).toISOString()
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
    await internalServer.listen({ host: "127.0.0.1", port: config.internalPort });
    lifecycle.assertStartupActive();
    if (desktopBootstrap !== undefined) {
      const bootstrap = desktopBootstrap;
      const response = bootstrap.grant.exchange({
        serverId: application.serverId,
        origin: config.publicOrigin,
        issueConnection: (input) => application.connections.issueTrustedDesktopConnection(input)
      });
      await sendDesktopBootstrapResponse(bootstrap.responsePipe, response);
      const commit = await bootstrap.lease.receiveCommit();
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
