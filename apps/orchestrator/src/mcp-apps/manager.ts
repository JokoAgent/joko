import { randomBytes, randomUUID } from "node:crypto";
import type { McpAppCardProjection } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "../credential-vault.js";
import { McpAppsHost } from "./host.js";
import { AppConnection, type AppServerConfig } from "./connection.js";
import type { McpAppMessageGuard } from "./message.js";
import type { McpAppRecord } from "./types.js";

export interface McpAppCapture {
  complete(result: NonNullable<McpAppRecord["result"]>): Promise<void>;
  cancel(aborted: boolean): Promise<void>;
}
export interface McpAppCaptureInput {
  readonly sessionId: string;
  readonly serverId: string;
  readonly tool: McpAppRecord["tool"];
  readonly resourceUri: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly assertCurrent: () => void;
  readonly connection?: AppConnection;
}
interface SavedCard {
  readonly version: 1;
  readonly sessionId: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly anchorEventId: string;
  readonly record: McpAppRecord;
}
interface Options {
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
  readonly config: (serverId: string) => AppServerConfig | undefined;
  readonly redact: (value: string) => string;
  readonly authorizeTool: (sessionId: string, serverId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
  readonly sendMessage: (sessionId: string, serverId: string, content: unknown[], assertCurrent: McpAppMessageGuard) => Promise<void>;
  readonly disposeDocument?: (viewId: string) => void;
}

/** Encrypted private records and public timeline events share the Store's commit boundary. */
export class McpAppsManager {
  readonly host: McpAppsHost;
  readonly #options: Options;
  readonly #owner = {};
  readonly #admissions = new Map<string, Omit<SavedCard, "record">>();
  readonly #nativeViews = new Map<string, () => void>();
  #closed = false;

  constructor(options: Options) {
    this.#options = options;
    const reference = "joko:mcp-apps:revision-key:v1";
    let key = options.store.findSetting<EncryptedCredential>("service", "orchestrator", "mcp_apps_revision_key")?.value;
    if (key === undefined) {
      key = options.vault.seal(randomBytes(32).toString("hex"), reference);
      options.store.setSetting("service", "orchestrator", "mcp_apps_revision_key", key);
    }
    const revisionKey = options.vault.open(key, reference);
    this.host = new McpAppsHost({
      owner: () => this.#closed ? undefined : this.#owner,
      revisionKey: () => revisionKey,
      config: options.config,
      readCard: async (sessionId, cardId) => this.#read(sessionId, cardId).record,
      writeCard: async (sessionId, cardId, record) => this.#write(sessionId, cardId, record),
      authorizeTool: async (sessionId, serverId, tool, args, signal) => {
        await options.authorizeTool(sessionId, serverId, tool.name, redactValue(args, options.redact) as Record<string, unknown>, signal);
      },
      sendMessage: (sessionId, record, content, guard) => options.sendMessage(sessionId, record.serverId, redactValue(content, options.redact) as unknown[], guard),
      sanitizeData: value => redactValue(value, options.redact),
      disposeDocument: viewId => {
        this.#nativeViews.get(viewId)?.(); this.#nativeViews.delete(viewId);
        options.disposeDocument?.(viewId);
      }
    });
  }

  async capture(input: McpAppCaptureInput): Promise<McpAppCapture | undefined> {
    input.assertCurrent();
    const config = this.#options.config(input.serverId);
    if (this.#closed || config === undefined) return;
    const session = this.#options.store.getSession(input.sessionId).descriptor;
    if (session.archived || session.deletedAt !== undefined) return;
    const cardId = `mcp-app:${randomUUID()}`;
    const connection = input.connection ?? new AppConnection(config);
    const release = async () => { if (!input.connection) await this.host.releaseConnection(connection); };
    const connectionId = this.host.registerConnection(connection);
    const record: McpAppRecord = {
      version: 1, serverId: input.serverId, serverRevision: this.host.serverRevision(config),
      resourceUri: input.resourceUri, tool: input.tool, arguments: { ...input.arguments }, connectionId
    };
    const admission = {
      version: 1 as const, sessionId: session.id, targetId: session.targetId, backendId: session.backendId,
      generation: session.binding.generation, createdAt: session.createdAt, anchorEventId: `mcp-app-created:${cardId}`
    };
    this.#admissions.set(cardId, admission);
    try { await this.host.updateResult(session.id, cardId, record); input.assertCurrent(); }
    catch (error) { await release(); throw error; }
    finally { this.#admissions.delete(cardId); }
    return {
      complete: async result => {
        try { input.assertCurrent(); await this.host.updateResult(session.id, cardId, { ...record, result }); }
        finally { await release(); }
      },
      cancel: async aborted => {
        try { await this.host.updateResult(session.id, cardId, aborted
          ? { ...record, cancelled: "Tool execution cancelled" }
          : { ...record, result: { isError: true, content: [{ type: "text", text: "MCP App tool execution failed" }] } }); }
        finally { await release(); }
      }
    };
  }

  callerForDevice(connectionId: string, deviceId: string, uiOwnerId: string): string {
    const mobile = this.#options.store.getDevice(deviceId).kind === "mobile";
    return mobile ? `device:${connectionId}` : `window:${connectionId}:${uiOwnerId}`;
  }

  nativeDevice(deviceId: string): boolean {
    const kind = this.#options.store.getDevice(deviceId).kind;
    return kind === "desktop" || kind === "mobile";
  }

  retainNativeView(viewId: string, release: () => void): void { this.#nativeViews.set(viewId, release); }

  #read(sessionId: string, cardId: string): SavedCard {
    if (this.#closed || !/^mcp-app:[a-f0-9-]{36}$/u.test(cardId)) throw new Error("MCP_APP_CARD_UNAVAILABLE");
    const sealed = this.#options.store.findSetting<EncryptedCredential>("service", "mcp-app-cards", cardId)?.value;
    if (sealed === undefined) throw new Error("MCP_APP_CARD_UNAVAILABLE");
    const saved = JSON.parse(this.#options.vault.open(sealed, cardId)) as SavedCard;
    if (saved.version !== 1 || saved.sessionId !== sessionId) throw new Error("MCP_APP_CARD_UNAVAILABLE");
    this.#assertScope(saved);
    const anchor = this.#options.store.findEvent(saved.anchorEventId);
    if (anchor === undefined || this.#options.store.listEvents({ sessionId, activeNativeTimeline: true,
      afterCursor: anchor.globalCursor - 1n, limit: 1 })[0]?.id !== anchor.id) throw new Error("MCP_APP_CARD_UNAVAILABLE");
    return saved;
  }

  #assertScope(saved: Omit<SavedCard, "record">): void {
    const session = this.#options.store.getSession(saved.sessionId).descriptor;
    if (session.targetId !== saved.targetId || session.createdAt !== saved.createdAt || session.archived || session.deletedAt !== undefined
      || this.#options.store.findPendingSessionLifecycleCleanup(session.id) !== undefined) throw new Error("MCP_APP_CARD_UNAVAILABLE");
  }

  #write(sessionId: string, cardId: string, record: McpAppRecord): void {
    const original = this.#admissions.get(cardId) ?? this.#read(sessionId, cardId);
    this.#assertScope(original);
    const config = this.#options.config(record.serverId);
    if (original.sessionId !== sessionId || config === undefined || this.host.serverRevision(config) !== record.serverRevision)
      throw new Error("MCP_APP_SERVER_CHANGED");
    const safeRecord = redactRecord(record, this.#options.redact);
    const saved: SavedCard = { ...original, record: safeRecord };
    const card: McpAppCardProjection = {
      id: cardId, sessionId, title: this.#options.redact(safeRecord.tool.title ?? safeRecord.tool.name),
      text: (safeRecord.result?.content ?? []).flatMap(block => {
        if (!block || typeof block !== "object") return [];
        const value = block as { type?: unknown; text?: unknown };
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      }).join("\n\n"), pending: safeRecord.result === undefined && safeRecord.cancelled === undefined,
      cancelled: safeRecord.cancelled !== undefined, isError: safeRecord.result?.isError === true, updatedAt: Date.now()
    };
    this.#options.store.transaction(store => {
      const session = store.getSession(sessionId).descriptor;
      store.setSetting("service", "mcp-app-cards", cardId, this.#options.vault.seal(JSON.stringify(saved), cardId));
      store.appendEvent({ id: this.#admissions.has(cardId) ? original.anchorEventId : `mcp-app-update:${randomUUID()}`,
        sessionId, backendId: session.backendId, targetId: session.targetId, generation: session.binding.generation,
        traceId: `mcp-app:${cardId}`, payload: { type: "mcp_app_changed", card } });
    });
  }

  async dispose(): Promise<void> { this.#closed = true; await this.host.reset(); }
}

function redactRecord(record: McpAppRecord, redact: (value: string) => string): McpAppRecord {
  return { ...record, arguments: redactValue(record.arguments, redact) as McpAppRecord["arguments"],
    ...(record.result === undefined ? {} : { result: redactValue(record.result, redact) as NonNullable<McpAppRecord["result"]> }) };
}

function redactValue(value: unknown, redact: (value: string) => string): unknown {
  return typeof value === "string" ? redact(value)
    : Array.isArray(value) ? value.map(item => redactValue(item, redact))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactValue(item, redact)])) : value;
}
