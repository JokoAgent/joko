import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { McpAppsHost } from "./host.js";
import type { McpAppDocument } from "./types.js";
import { MCP_APPS_MAX_BYTES } from "./protocol.js";
import { directSandboxDocument } from "./surface-document.js";
import { bindResponseLifetime } from "../http-response-lifetime.js";

interface Surface {
  readonly document: McpAppDocument;
  readonly caller: string;
  readonly sessionId: string;
  readonly proxyToken: string;
  readonly resourceToken: string;
  readonly bridgeToken: string;
  readonly assertCaller: () => void;
  readonly release: () => void;
  readonly lifetime: AbortController;
}
const permissions = "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()";
const token = () => randomBytes(32).toString("hex");

/** HTTP sandbox for the shared Web client. Both documents have enforced opaque origins. */
export class McpAppSurfaces {
  readonly #host: McpAppsHost;
  readonly #origin: string;
  readonly #surfaces = new Map<string, Surface>();
  readonly #proxies = new Map<string, Surface>();
  readonly #resources = new Map<string, Surface>();
  readonly #bridges = new Map<string, Surface>();
  constructor(host: McpAppsHost, origin: string) {
    this.#host = host;
    this.#origin = new URL(origin).origin;
  }
  supply(document: McpAppDocument, caller: string, sessionId: string, assertCaller: () => void, release: () => void): string {
    assertCaller();
    if (this.#surfaces.size >= 256) throw new Error("MCP_APP_VIEW_LIMIT");
    const surface: Surface = { document, caller, sessionId, assertCaller, release, proxyToken: token(), resourceToken: token(), bridgeToken: token(), lifetime: new AbortController() };
    this.#surfaces.set(document.viewId, surface);
    this.#proxies.set(surface.proxyToken, surface);
    this.#resources.set(surface.resourceToken, surface);
    this.#bridges.set(surface.bridgeToken, surface);
    return `${this.#origin}/mcp-apps/proxy/${surface.proxyToken}`;
  }
  remove(viewId: string): void {
    const surface = this.#surfaces.get(viewId);
    if (surface === undefined) return;
    surface.lifetime.abort();
    this.#surfaces.delete(viewId);
    this.#proxies.delete(surface.proxyToken);
    this.#resources.delete(surface.resourceToken);
    this.#bridges.delete(surface.bridgeToken);
    surface.release();
  }
  async #assert(surface: Surface | undefined): Promise<Surface> {
    if (surface === undefined || this.#surfaces.get(surface.document.viewId) !== surface) throw new Error("MCP_APP_VIEW_UNAVAILABLE");
    surface.assertCaller();
    await this.#host.assertViewAuthorized(surface.caller, surface.sessionId, surface.document.viewId);
    surface.assertCaller();
    if (this.#surfaces.get(surface.document.viewId) !== surface) throw new Error("MCP_APP_VIEW_UNAVAILABLE");
    return surface;
  }
  register(app: FastifyInstance): void {
    app.options("/mcp-apps/proxy/:token", { logLevel: "silent", config: { cors: false } }, async (_request, reply) =>
      reply.headers({ "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "x-joko-isolated-document", "cache-control": "no-store" }).code(204).send());
    app.get<{ Params: { kind: string; token: string } }>("/mcp-apps/:kind/:token", { logLevel: "silent", config: { cors: false } }, async (request, reply) => {
      try {
        // This browser-owned header cannot be set by renderer fetch. The response's
        // sandbox directive cannot be removed by changing the parent's iframe flags.
        const isolatedDocument = request.headers["x-joko-isolated-document"] === "1";
        if (!isolatedDocument && request.headers["sec-fetch-dest"] !== "iframe") return reply.code(403).send();
        const kind = request.params.kind;
        const surface = await this.#assert(kind === "proxy" ? this.#proxies.get(request.params.token) : kind === "resource" ? this.#resources.get(request.params.token) : undefined);
        if (!bindResponseLifetime(reply, surface.lifetime.signal)) return reply.code(410).send();
        const resourceUrl = `${this.#origin}/mcp-apps/resource/${surface.resourceToken}`;
        const bridgeUrl = `${this.#origin}/mcp-apps/bridge/${surface.bridgeToken}`;
        if (isolatedDocument) {
          if (kind !== "proxy") return reply.code(403).send();
          return reply.headers({ "cache-control": "no-store", "access-control-allow-origin": "*" }).send({ html: surface.document.html, csp: surface.document.csp,
            bridgeEndpoint: `/mcp-apps/bridge/${surface.bridgeToken}` });
        }
        const csp = kind === "resource" ? `${surface.document.csp}; sandbox allow-scripts`
          : `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${this.#origin}; frame-src ${this.#origin}; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
        return reply.headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
          "content-security-policy": csp, "permissions-policy": permissions, "x-content-type-options": "nosniff" })
          .send(kind === "resource" ? surface.document.html : directSandboxDocument(resourceUrl, bridgeUrl));
      } catch { return reply.code(410).send(); }
    });
    app.options("/mcp-apps/bridge/:token", { logLevel: "silent", config: { cors: false } }, async (request, reply) => {
      const isolated = typeof request.headers["access-control-request-headers"] === "string"
        && request.headers["access-control-request-headers"].toLowerCase().split(/\s*,\s*/u).includes("x-joko-isolated-document");
      if (!isolated && request.headers.origin !== "null") return reply.code(403).send();
      return reply.headers({ "access-control-allow-origin": isolated ? "*" : "null", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type, x-joko-isolated-document", "cache-control": "no-store" }).code(204).send();
    });
    app.post<{ Params: { token: string } }>("/mcp-apps/bridge/:token", { bodyLimit: MCP_APPS_MAX_BYTES, logLevel: "silent", config: { cors: false } }, async (request, reply) => {
      const isolated = request.headers["x-joko-isolated-document"] === "1";
      if ((!isolated && request.headers.origin !== "null") || !request.headers["content-type"]?.startsWith("application/json")) return reply.code(403).send();
      reply.headers({ "access-control-allow-origin": isolated ? "*" : "null", "cache-control": "no-store" });
      try {
        const surface = await this.#assert(this.#bridges.get(request.params.token));
        const { caller, sessionId, document: { viewId } } = surface;
        const body = request.body as { op?: string; message?: unknown; after?: number; linkId?: string; url?: string; success?: boolean };
        let result: unknown = {};
        switch (body?.op) {
          case "message": await this.#host.dispatch(caller, sessionId, viewId, body.message); break;
          case "poll": result = await this.#host.poll(caller, sessionId, viewId, body.after ?? 0); break;
          case "open-link": {
            if (typeof body.linkId !== "string" || typeof body.url !== "string") throw new Error("MCP_APP_INVALID_LINK");
            const grant = await this.#host.authorizeLink(caller, sessionId, viewId, body.linkId, body.url);
            result = { url: body.url, validForMs: grant.validForMs };
            break;
          }
          case "link-result":
            if (typeof body.linkId !== "string" || typeof body.success !== "boolean") throw new Error("MCP_APP_INVALID_LINK");
            this.#host.linkResult(caller, sessionId, viewId, body.linkId, body.success); break;
          default: return reply.code(400).send({ error: "MCP_APP_INVALID_REQUEST" });
        }
        await this.#assert(surface);
        if (!bindResponseLifetime(reply, surface.lifetime.signal)) return reply.code(410).send();
        return reply.send(result);
      } catch { return reply.code(410).send({ error: "MCP_APP_VIEW_UNAVAILABLE" }); }
    });
  }
}
