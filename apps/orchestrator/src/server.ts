import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import Fastify, { type FastifyInstance } from "fastify";

import type { OrchestratorApplication } from "./application.js";
import { isLoopbackHost, isPrivateLanHost, isPrivateLanHttpOrigin, readTls } from "./config.js";
import { registerConnectServices } from "./connect-services.js";
import { ConnectionAuthenticationError } from "./connection-manager.js";
import type { NativeAuthRunnerProof, RemoteNativeAuthRunnerAttestation } from "./native-auth-recovery.js";

export const JOKO_DESKTOP_APP_ORIGIN = "joko://app";
export const ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // The fixed, self-hosted diagram viewer evaluates its internal graph codec.
  // Inline and remote scripts remain forbidden.
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: https: http: ws: wss:"
].join("; ");

export async function createPublicServer(application: OrchestratorApplication): Promise<FastifyInstance> {
  const tls = readTls(application.config);
  const server = Fastify({
    logger: {
      level: process.env.JOKO_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "request.headers.authorization"]
    },
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 16 * 1024 * 1024,
    ...(tls === undefined ? {} : { https: tls })
  });

  server.addContentTypeParser("application/octet-stream", (request, payload, done) => {
    done(null, payload);
  });
  server.addHook("onRequest", async (request, reply) => {
    if (tls !== undefined) return;
    const remote = normalizeSocketAddress(request.ip);
    // Fastify injection has no real local socket; production requests always do.
    const local = normalizeSocketAddress(request.raw.socket.localAddress ?? request.ip);
    const permitted = application.config.allowInsecureLan
      ? isPrivateLanHost(remote) && isPrivateLanHost(local)
      : isLoopbackHost(remote) && isLoopbackHost(local);
    if (!permitted) return reply.code(403).send({ error: "Insecure Orchestrator access is limited to the configured local network." });
  });
  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("cross-origin-resource-policy", "same-site");
    reply.header(
      "content-security-policy",
      ORCHESTRATOR_WEB_CONTENT_SECURITY_POLICY
    );
    if (tls !== undefined) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (
      request.url.startsWith("/joko.v1.") ||
      request.url.startsWith("/v1/") ||
      request.url.startsWith("/internal/")
    ) reply.header("cache-control", "no-store");
    return payload;
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConnectionAuthenticationError) {
      return reply.code(401).send({ error: "Authentication is required or has been revoked." });
    }
    const statusCode = httpStatusCode(error);
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: "The request is invalid." });
    }
    server.log.error({ error }, "Orchestrator HTTP request failed");
    return reply.code(500).send({ error: "Orchestrator could not complete the request." });
  });

  await server.register(cors, {
    credentials: false,
    allowedHeaders: ["authorization", "content-type", "connect-protocol-version", "connect-timeout-ms", "x-joko-client-version"],
    exposedHeaders: ["connect-content-encoding", "connect-accept-encoding", "grpc-status", "grpc-message"],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    origin(origin, callback) {
      const allowed = origin === undefined || origin === JOKO_DESKTOP_APP_ORIGIN ||
        application.config.corsOrigins.includes(origin) ||
        (application.config.allowInsecureLan && origin !== undefined && isPrivateLanHttpOrigin(origin));
      callback(null, allowed);
    }
  });

  server.get("/healthz", async () => ({
    status: "ok",
    version: "0.1.0",
    schemaVersion: application.store.health().schemaVersion
  }));

  server.put<{ Params: { ticketId: string } }>(
    "/v1/credentials/upload/:ticketId",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const connection = application.connections.authenticate(request.headers.authorization);
      if (application.credentials === undefined) return reply.code(404).send({ error: "Credential channel is unavailable." });
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(request.body as Readable, 64 * 1024);
        application.credentials.uploadBytes(request.params.ticketId, bytes, connection.id);
      } catch {
        return reply.code(400).send({ error: "Credential upload ticket or payload is invalid." });
      }
      reply.header("cache-control", "no-store");
      return reply.code(204).send();
    }
  );

  server.put<{ Params: { ticketId: string; secret: string } }>(
    "/v1/blobs/upload/:ticketId/:secret",
    { bodyLimit: 256 * 1024 * 1024 },
    async (request, reply) => {
      authenticateBlobRequest(application, request.headers.authorization);
      const stream = request.body as Readable;
      let artifact: Awaited<ReturnType<OrchestratorApplication["blobTransfers"]["acceptUpload"]>>;
      try {
        artifact = await application.blobTransfers.acceptUpload(
          request.params.ticketId,
          request.params.secret,
          stream
        );
      } catch {
        return reply.code(400).send({ error: "Blob upload ticket or payload is invalid." });
      }
      reply.code(201);
      return { blobId: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength };
    }
  );

  server.get<{ Params: { ticketId: string; secret: string } }>(
    "/v1/blobs/download/:ticketId/:secret",
    async (request, reply) => {
      authenticateBlobRequest(application, request.headers.authorization);
      let download: Awaited<ReturnType<OrchestratorApplication["blobTransfers"]["openDownload"]>>;
      try {
        download = await application.blobTransfers.openDownload(
          request.params.ticketId,
          request.params.secret
        );
      } catch {
        return reply.code(404).send({ error: "Blob download ticket is invalid or unavailable." });
      }
      const { artifact, stream } = download;
      reply.type(artifact.mimeType);
      reply.header("content-length", String(artifact.byteLength));
      reply.header("cache-control", "private, no-store");
      if (artifact.fileName !== undefined) {
        reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
      }
      return reply.send(stream);
    }
  );

  await server.register(fastifyConnectPlugin, {
    routes: (router) => registerConnectServices(router, application),
    grpc: tls !== undefined,
    grpcWeb: true,
    connect: true,
    shutdownTimeoutMs: 10_000
  });

  if (await isDirectory(application.config.webDirectory)) {
    await server.register(fastifyStatic, {
      root: application.config.webDirectory,
      prefix: "/",
      decorateReply: true,
      index: false,
      immutable: true,
      maxAge: "1y"
    });
    server.get("/", async (_request, reply) => {
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    });
    server.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        reply.header("cache-control", "no-cache");
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return server;
}

/**
 * Dedicated loopback-only listener for Pi's bearer-authenticated MCP bridge.
 * The public/LAN Fastify listener intentionally does not register this route.
 */
export async function createInternalServer(application: OrchestratorApplication): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: process.env.JOKO_LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "request.headers.authorization",
        "req.headers['x-joko-pi-native-auth-reservation']",
        "request.headers['x-joko-pi-native-auth-reservation']"
      ]
    },
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 16 * 1024 * 1024
  });
  server.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) return reply.code(403).send({ error: "Internal bridge is loopback-only." });
  });
  server.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  server.post<{ Body: unknown }>(
    "/internal/mcp",
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      if (application.mcpRouter === undefined) return reply.code(404).send({ error: "MCP bridge is unavailable." });
      const body = request.body;
      if (!isRecord(body)) return reply.code(400).send({ error: "MCP bridge request must be a JSON object." });
      const requestId = body["requestId"];
      const generation = body["generation"];
      const sessionId = body["sessionId"];
      const targetId = body["targetId"];
      const serverId = body["serverId"];
      const toolName = body["toolName"];
      const argumentsValue = body["arguments"];
      const headerGeneration = request.headers["x-joko-pi-generation"];
      if (
        typeof requestId !== "string" || requestId.length < 1 || requestId.length > 1_024 ||
        requestId.includes("\u0000") || /[\r\n]/u.test(requestId) ||
        !Number.isSafeInteger(generation) || (generation as number) < 0 ||
        typeof sessionId !== "string" || sessionId === "" ||
        typeof targetId !== "string" || targetId === "" ||
        typeof serverId !== "string" || serverId === "" ||
        typeof toolName !== "string" || toolName === "" ||
        (argumentsValue !== undefined && !isRecord(argumentsValue)) ||
        typeof headerGeneration !== "string" || Number(headerGeneration) !== generation
      ) return reply.code(400).send({ error: "MCP bridge request failed its generation or schema fence." });
      try {
        const result = await application.mcpRouter.executeBridgeCall({
          authorization: request.headers.authorization,
          requestId,
          generation: generation as number,
          sessionId,
          targetId,
          serverId,
          toolName,
          ...(argumentsValue === undefined ? {} : { arguments: argumentsValue })
        });
        return result;
      } catch {
        return reply.code(401).send({ error: "MCP bridge authorization or generation is invalid." });
      }
    }
  );
  server.post<{ Body: unknown }>(
    "/internal/pi-native-auth",
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      if (application.mcpRouter === undefined) return reply.code(404).send({ error: "Native auth lease is unavailable." });
      const body = request.body;
      if (!isRecord(body)) return reply.code(400).send({ error: "Native auth lease request must be a JSON object." });
      const action = body["action"];
      const generation = body["generation"];
      const currentRouteGeneration = body["currentRouteGeneration"];
      const runnerProductGeneration = body["runnerProductGeneration"];
      const sessionId = body["sessionId"];
      const targetId = body["targetId"];
      const providerId = body["providerId"];
      const catalogGeneration = body["catalogGeneration"];
      const runId = body["runId"];
      const runnerFence = body["runnerFence"];
      const credential = body["credential"];
      const recoveryProof = body["recoveryProof"];
      const recovery = body["recovery"];
      const runnerRegistration = body["runnerRegistration"];
      const runnerProof = body["runnerProof"];
      const remoteRunnerAttestation = body["remoteRunnerAttestation"];
      const headerGeneration = request.headers["x-joko-pi-generation"];
      const launchAuthorizationHeader = request.headers["x-joko-pi-native-auth-reservation"];
      const launchAuthorization = typeof launchAuthorizationHeader === "string" ? launchAuthorizationHeader : undefined;
      if (
        (action !== "reserve" && action !== "acquire" && action !== "validate" && action !== "release")
        || !Number.isSafeInteger(generation) || (generation as number) < 0
        || (currentRouteGeneration !== undefined && (action !== "reserve"
          || !Number.isSafeInteger(currentRouteGeneration) || Number(currentRouteGeneration) < 0))
        || !Number.isSafeInteger(runnerProductGeneration) || (runnerProductGeneration as number) < 0
        || !Number.isSafeInteger(catalogGeneration) || (catalogGeneration as number) < 0
        || typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 512
        || typeof targetId !== "string" || targetId.length < 1 || targetId.length > 512
        || typeof providerId !== "string" || providerId.length < 1 || providerId.length > 128
        || typeof runId !== "string" || typeof runnerFence !== "string"
        || (credential !== undefined && action !== "release")
        || (action === "reserve"
          ? !isRecord(runnerRegistration) || runnerRegistration["format"] !== 1
            || typeof runnerRegistration["publicKey"] !== "string"
            || runnerRegistration["publicKey"].length < 40 || runnerRegistration["publicKey"].length > 128
            || credential !== undefined || recoveryProof !== undefined || recovery !== undefined
            || runnerProof !== undefined || remoteRunnerAttestation !== undefined
          : runnerRegistration !== undefined)
        || (recoveryProof !== undefined && (action === "acquire" || typeof recoveryProof !== "string"
          || !/^[A-Za-z0-9_-]{43}$/u.test(recoveryProof)))
        || (recovery !== undefined && (action !== "acquire" || !isRecord(recovery)
          || !Number.isSafeInteger(recovery["runnerPid"]) || Number(recovery["runnerPid"]) < 1))
        || (runnerProof !== undefined && !isNativeAuthRunnerProof(runnerProof))
        || (remoteRunnerAttestation !== undefined && !isRemoteNativeAuthRunnerAttestation(remoteRunnerAttestation))
        || typeof headerGeneration !== "string" || !Number.isSafeInteger(Number(headerGeneration))
        || Number(headerGeneration) < 0
        || (runnerProof === undefined && Number(headerGeneration) !== (currentRouteGeneration ?? generation))
        || (action === "reserve"
          ? typeof launchAuthorization !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(launchAuthorization)
          : launchAuthorizationHeader !== undefined)
      ) return reply.code(400).send({ error: "Native auth lease request failed its schema fence." });
      try {
        if (action === "reserve") {
          return await application.mcpRouter.reserveNativeAuthRunner({
            authorization: request.headers.authorization,
            launchAuthorization,
            generation: Number(currentRouteGeneration ?? generation),
            runnerProductGeneration: runnerProductGeneration as number,
            sessionId,
            targetId,
            providerId,
            catalogGeneration: catalogGeneration as number,
            runId,
            runnerFence,
            publicKey: String((runnerRegistration as Record<string, unknown>)["publicKey"])
          });
        }
        return await application.mcpRouter.executeNativeAuthLease({
          authorization: request.headers.authorization,
          action,
          generation: generation as number,
          runnerProductGeneration: runnerProductGeneration as number,
          sessionId,
          targetId,
          providerId,
          catalogGeneration: catalogGeneration as number,
          runId,
          runnerFence,
          ...(credential === undefined ? {} : { credential }),
          ...(recoveryProof === undefined ? {} : { recoveryProof }),
          ...(recovery === undefined ? {} : {
            recovery: {
              runnerPid: Number((recovery as Record<string, unknown>)["runnerPid"])
            }
          }),
          ...(runnerProof === undefined ? {} : { runnerProof }),
          ...(remoteRunnerAttestation === undefined ? {} : { remoteRunnerAttestation })
        });
      } catch {
        return reply.code(401).send({ error: "Native auth lease is invalid, expired, or revoked." });
      }
    }
  );
  return server;
}

function authenticateBlobRequest(application: OrchestratorApplication, authorization: string | undefined): void {
  application.connections.authenticate(authorization);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readBoundedBody(stream: Readable, maximumBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += bytes.byteLength;
    if (byteLength > maximumBytes) throw new Error("Request body exceeds the credential upload limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemoteNativeAuthRunnerAttestation(value: unknown): value is RemoteNativeAuthRunnerAttestation {
  if (!isRecord(value)) return false;
  return value["format"] === 1
    && (value["action"] === "acquire" || value["action"] === "validate" || value["action"] === "release")
    && Number.isSafeInteger(value["issuedAt"]) && Number(value["issuedAt"]) >= 0
    && typeof value["nonce"] === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value["nonce"])
    && Number.isSafeInteger(value["runnerPid"]) && Number(value["runnerPid"]) > 0
    && ["bindingDigest", "processIdentity", "runRootDigest", "runnerScriptDigest", "configDigest",
      "statusDigest", "ownerDigest", "claimDigest"].every((name) =>
      typeof value[name] === "string" && /^[0-9a-f]{64}$/u.test(value[name]))
    && typeof value["mac"] === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value["mac"]);
}

function isNativeAuthRunnerProof(value: unknown): value is NativeAuthRunnerProof {
  if (!isRecord(value)) return false;
  return value["format"] === 1
    && typeof value["reservationId"] === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value["reservationId"])
    && Number.isSafeInteger(value["runnerPid"]) && Number(value["runnerPid"]) > 0
    && typeof value["nonce"] === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value["nonce"])
    && typeof value["signature"] === "string" && /^[A-Za-z0-9_-]{86}$/u.test(value["signature"]);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeSocketAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost" ||
    normalized.startsWith("127.");
}

function normalizeSocketAddress(address: string): string {
  const normalized = address.toLocaleLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function httpStatusCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const statusCode = value["statusCode"];
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : undefined;
}
