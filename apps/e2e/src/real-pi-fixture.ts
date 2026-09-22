import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PiManagedProvider, PiManagedSettings } from "@joko/adapter-pi";
import {
  createOrchestratorApplication,
  createInternalServer,
  createPublicServer,
  type OrchestratorApplication,
  type OrchestratorApplicationDependencies,
  type OrchestratorConfig
} from "@joko/orchestrator";

import {
  createE2eClients,
  type E2eClients,
  type PairedClient
} from "./connect-clients.js";

export const REAL_PI_PROVIDER_ID = "joko-e2e-local";
export const REAL_PI_MODEL_ID = "joko-e2e-model";
export const REAL_PI_RESPONSE_TEXT = "real npm Pi reached Orchestrator over binary Connect";

export interface CapturedProviderRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readonly<Record<string, unknown>>;
}

export type RealPiProviderReply =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly callId?: string;
    };

export type RealPiProviderResponder = (input: {
  readonly request: CapturedProviderRequest;
  readonly requestNumber: number;
}) => RealPiProviderReply | Promise<RealPiProviderReply>;

export interface RealPiSystemFixtureOptions {
  readonly rootDirectory?: string;
  readonly keepRoot?: boolean;
  readonly webDirectory?: string;
  readonly port?: number;
  readonly internalPort?: number;
  readonly enableInternalServer?: boolean;
  readonly holdProviderResponses?: boolean;
  readonly piSettings?: PiManagedSettings;
  readonly overflowRequestNumbers?: readonly number[];
  readonly providerResponder?: RealPiProviderResponder;
  readonly providerSupportsImages?: boolean;
  readonly providerUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  /** Loopback-only endpoint used by the Messaging product-chain fixture. */
  readonly telegramApiBaseUrl?: string;
  /** Loopback-only endpoint used by the Discord Messaging product-chain fixture. */
  readonly discordApiBaseUrl?: string;
  /** Loopback-only endpoints used by the DingTalk Messaging product-chain fixture. */
  readonly dingTalkApiBaseUrl?: string;
  readonly dingTalkOapiBaseUrl?: string;
  readonly createFeishuTransport?: OrchestratorApplicationDependencies["messagingCreateFeishuTransport"];
  readonly createWeComTransport?: OrchestratorApplicationDependencies["messagingCreateWeComTransport"];
  readonly messagingPollTimeoutSeconds?: number;
  readonly messagingRetryDelayMs?: number;
}

/**
 * Full production composition with the real Pi adapter and bundled npm CLI.
 * The only fake is the loopback, OpenAI-compatible model Provider at the
 * outer network boundary; no FakeBackendAdapter participates in this fixture.
 */
export class RealPiSystemFixture {
  readonly rootDirectory: string;
  readonly workspaceDirectory: string;
  readonly baseUrl: string;
  readonly application: OrchestratorApplication;
  readonly anonymous: E2eClients;
  readonly providerRequests: CapturedProviderRequest[];
  readonly #publicServer: Awaited<ReturnType<typeof createPublicServer>>;
  readonly #internalServer: Awaited<ReturnType<typeof createInternalServer>> | undefined;
  readonly #providerServer: Server;
  readonly #pairingCodes: ReadonlyMap<string, string>;
  readonly #removePairingListener: () => void;
  readonly #providerResponseGate: ProviderResponseGate | undefined;
  readonly #removeRootOnClose: boolean;
  #closed = false;

  private constructor(input: {
    readonly rootDirectory: string;
    readonly workspaceDirectory: string;
    readonly baseUrl: string;
    readonly application: OrchestratorApplication;
    readonly publicServer: Awaited<ReturnType<typeof createPublicServer>>;
    readonly internalServer: Awaited<ReturnType<typeof createInternalServer>> | undefined;
    readonly providerServer: Server;
    readonly providerRequests: CapturedProviderRequest[];
    readonly pairingCodes: ReadonlyMap<string, string>;
    readonly removePairingListener: () => void;
    readonly providerResponseGate: ProviderResponseGate | undefined;
    readonly removeRootOnClose: boolean;
  }) {
    this.rootDirectory = input.rootDirectory;
    this.workspaceDirectory = input.workspaceDirectory;
    this.baseUrl = input.baseUrl;
    this.application = input.application;
    this.#publicServer = input.publicServer;
    this.#internalServer = input.internalServer;
    this.#providerServer = input.providerServer;
    this.providerRequests = input.providerRequests;
    this.#pairingCodes = input.pairingCodes;
    this.#removePairingListener = input.removePairingListener;
    this.#providerResponseGate = input.providerResponseGate;
    this.#removeRootOnClose = input.removeRootOnClose;
    this.anonymous = createE2eClients(input.baseUrl, undefined, 60_000);
  }

  static async start(options: RealPiSystemFixtureOptions = {}): Promise<RealPiSystemFixture> {
    const ownsRoot = options.rootDirectory === undefined;
    const requestedRoot = options.rootDirectory ?? await mkdtemp(join(tmpdir(), "joko-real-pi-system-e2e-"));
    await mkdir(requestedRoot, { recursive: true });
    const rootDirectory = process.env.GITHUB_ACTIONS === "true"
      ? await realpath(requestedRoot)
      : requestedRoot;
    const workspaceDirectory = join(rootDirectory, "workspace");
    const dataDirectory = join(rootDirectory, "data");
    const providerRequests: CapturedProviderRequest[] = [];
    let providerServer: Server | undefined;
    let application: OrchestratorApplication | undefined;
    let publicServer: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    let internalServer: Awaited<ReturnType<typeof createInternalServer>> | undefined;
    let removePairingListener: (() => void) | undefined;
    const providerResponseGate = options.holdProviderResponses === true
      ? new ProviderResponseGate()
      : undefined;
    try {
      await mkdir(workspaceDirectory, { recursive: true });
      await writeFile(
        join(workspaceDirectory, "README.md"),
        "# Real Pi system E2E\n\nThis workspace is intentionally local and untrusted.\n"
      );
      const piSettingsFile = join(rootDirectory, "pi-settings.json");
      if (options.piSettings !== undefined) {
        await writeFile(piSettingsFile, `${JSON.stringify(options.piSettings)}\n`, { mode: 0o600 });
      }
      providerServer = await startLocalProvider(
        providerRequests,
        providerResponseGate,
        options.providerUsage,
        options.overflowRequestNumbers,
        options.providerResponder
      );
      const providerAddress = providerServer.address() as AddressInfo;
      const internalPort = options.enableInternalServer === true
        ? options.internalPort ?? await availableLoopbackPort()
        : options.internalPort ?? 4317;
      const provider: PiManagedProvider = {
        id: REAL_PI_PROVIDER_ID,
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{
          id: REAL_PI_MODEL_ID,
          name: "Joko real Pi E2E model",
          contextWindow: 16_384,
          maxTokens: 1_024,
          ...(options.providerSupportsImages === true ? { input: ["text", "image"] as const } : {})
        }]
      };
      const config: OrchestratorConfig = {
        host: "127.0.0.1",
        port: 0,
        internalPort,
        publicOrigin: "http://127.0.0.1",
        internalOrigin: `http://127.0.0.1:${internalPort}`,
        dataDirectory,
        databasePath: join(dataDirectory, "orchestrator.db"),
        allowInsecureLoopback: true,
        allowInsecureLan: false,
        lanDiscoveryEnabled: false,
        piAgentHome: join(dataDirectory, "pi-agent-home"),
        ...(options.piSettings === undefined ? {} : { piSettingsFile }),
        workspace: {
          id: "workspace-real-pi",
          root: workspaceDirectory,
          displayName: "Real Pi E2E workspace",
          trusted: false
        },
        artifactDirectory: join(dataDirectory, "artifacts"),
        webDirectory: options.webDirectory ?? join(rootDirectory, "web-not-used-by-connect-e2e"),
        corsOrigins: []
      };
      application = await createOrchestratorApplication(config, {
        ...(options.telegramApiBaseUrl === undefined
          ? {}
          : { messagingTelegramApiBaseUrl: options.telegramApiBaseUrl }),
        ...(options.discordApiBaseUrl === undefined
          ? {}
          : { messagingDiscordApiBaseUrl: options.discordApiBaseUrl }),
        ...(options.dingTalkApiBaseUrl === undefined
          ? {}
          : { messagingDingTalkApiBaseUrl: options.dingTalkApiBaseUrl }),
        ...(options.dingTalkOapiBaseUrl === undefined
          ? {}
          : { messagingDingTalkOapiBaseUrl: options.dingTalkOapiBaseUrl }),
        ...(options.createFeishuTransport === undefined
          ? {}
          : { messagingCreateFeishuTransport: options.createFeishuTransport }),
        ...(options.createWeComTransport === undefined
          ? {}
          : { messagingCreateWeComTransport: options.createWeComTransport }),
        ...(options.messagingPollTimeoutSeconds === undefined
          ? {}
          : { messagingPollTimeoutSeconds: options.messagingPollTimeoutSeconds }),
        ...(options.messagingRetryDelayMs === undefined
          ? {}
          : { messagingRetryDelayMs: options.messagingRetryDelayMs })
      });
      if (application.providers === undefined || application.refreshPiGeneration === undefined) {
        throw new Error("Production Orchestrator composition did not expose managed Pi Provider generation.");
      }
      await application.providers.upsert({
        backendId: "pi", credentialOrigin: "",
        provider,
        displayName: "Joko local E2E Provider",
        kind: "local_keyless",
        credentialBindings: {},
        enabled: true,
        supportsLogin: false,
        supportsLogout: false,
        supportsRefresh: false
      });
      await application.refreshPiGeneration();

      if (options.enableInternalServer === true) {
        internalServer = await createInternalServer(application);
        internalServer.log.level = "silent";
        await internalServer.listen({ host: "127.0.0.1", port: internalPort });
      }

      const pairingCodes = new Map<string, string>();
      removePairingListener = application.connections.onPairingIssued((challenge) => {
        pairingCodes.set(challenge.id, challenge.code);
      });
      application.connections.openPairingWindow();
      publicServer = await createPublicServer(application);
      publicServer.log.level = "silent";
      await publicServer.listen({ host: "127.0.0.1", port: options.port ?? 0 });
      const orchestratorAddress = publicServer.server.address();
      if (orchestratorAddress === null || typeof orchestratorAddress === "string") {
        throw new Error("Orchestrator did not expose an ephemeral TCP port.");
      }
      return new RealPiSystemFixture({
        rootDirectory,
        workspaceDirectory,
        baseUrl: `http://127.0.0.1:${orchestratorAddress.port}`,
        application,
        publicServer,
        internalServer,
        providerServer,
        providerRequests,
        pairingCodes,
        removePairingListener,
        providerResponseGate,
        removeRootOnClose: ownsRoot && options.keepRoot !== true
      });
    } catch (error) {
      removePairingListener?.();
      await publicServer?.close().catch(() => undefined);
      await internalServer?.close().catch(() => undefined);
      await application?.close().catch(() => undefined);
      if (providerServer !== undefined) await closeHttpServer(providerServer).catch(() => undefined);
      if (ownsRoot) {
        await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
      throw error;
    }
  }

  async pair(displayName = "Real Pi binary Connect E2E"): Promise<PairedClient> {
    const begun = await this.anonymous.connection.beginPairing({ deviceDisplayName: displayName });
    const challenge = begun.challenge;
    if (challenge === undefined) throw new Error("Orchestrator returned no pairing challenge.");
    const code = this.#pairingCodes.get(challenge.challengeId);
    if (code === undefined) throw new Error("The trusted pairing observer did not receive the out-of-band code.");
    const completed = await this.anonymous.connection.completePairing({
      challengeId: challenge.challengeId,
      humanCode: code,
      deviceDisplayName: displayName
    });
    const authKey = completed.result?.authKey;
    const connectionId = completed.result?.connection?.connectionId;
    const deviceId = completed.result?.device?.deviceId;
    if (!authKey || !connectionId || !deviceId) throw new Error("Orchestrator returned no paired Connection credential and Device binding.");
    return {
      authKey,
      connectionId,
      deviceId,
      clients: createE2eClients(this.baseUrl, authKey, 60_000)
    };
  }

  clients(authKey: string): E2eClients {
    return createE2eClients(this.baseUrl, authKey, 60_000);
  }

  pairingCode(challengeId: string): string {
    const code = this.#pairingCodes.get(challengeId);
    if (code === undefined) throw new Error(`The trusted pairing observer did not receive challenge ${challengeId}.`);
    return code;
  }

  releaseProviderResponses(): void {
    this.#providerResponseGate?.release();
  }

  async close(options: { readonly removeRoot?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#providerResponseGate?.release();
    this.#removePairingListener();
    await this.#publicServer.close();
    await this.#internalServer?.close();
    await this.application.close();
    await closeHttpServer(this.#providerServer);
    if (options.removeRoot ?? this.#removeRootOnClose) {
      await rm(this.rootDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

async function startLocalProvider(
  requests: CapturedProviderRequest[],
  responseGate?: ProviderResponseGate,
  usage: RealPiSystemFixtureOptions["providerUsage"] = { promptTokens: 7, completionTokens: 3 },
  overflowRequestNumbers: readonly number[] = [],
  responder?: RealPiProviderResponder
): Promise<Server> {
  const overflowRequests = new Set(overflowRequestNumbers);
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > 1024 * 1024) {
        request.destroy(new Error("Provider request exceeded the E2E limit."));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", async () => {
      let body: Readonly<Record<string, unknown>>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const captured = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body };
      requests.push(captured);
      await responseGate?.wait();
      if (overflowRequests.has(requests.length)) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          error: {
            message: "Requested token count exceeds the model's maximum context length of 16384 tokens",
            type: "invalid_request_error",
            code: "context_length_exceeded"
          }
        }));
        return;
      }
      let reply: RealPiProviderReply;
      try {
        reply = responder === undefined
          ? { kind: "text", text: REAL_PI_RESPONSE_TEXT }
          : await responder({ request: captured, requestNumber: requests.length });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Provider responder failed." } }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const id = `joko-real-pi-${requests.length}`;
      const delta = reply.kind === "text"
        ? { role: "assistant", content: reply.text }
        : {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: reply.callId ?? `call-${requests.length}`,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.arguments) }
            }]
          };
      response.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: REAL_PI_MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: REAL_PI_MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens
        }
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}

class ProviderResponseGate {
  #released = false;
  readonly #waiters = new Set<() => void>();

  wait(): Promise<void> {
    if (this.#released) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      this.#waiters.add(resolvePromise);
    });
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const resolvePromise of this.#waiters) resolvePromise();
    this.#waiters.clear();
  }
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  server.closeAllConnections();
}

async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.off("error", reject);
      resolvePromise();
    });
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(probe).catch(() => undefined);
    throw new Error("The internal MCP bridge probe did not expose a TCP port.");
  }
  const port = address.port;
  await closeHttpServer(probe);
  return port;
}
