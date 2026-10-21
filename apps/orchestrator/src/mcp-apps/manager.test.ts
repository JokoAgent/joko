import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { CredentialVault, type EncryptedCredential } from "../credential-vault.js";
import { McpAppsManager, type McpAppCaptureInput } from "./manager.js";
import type { AppServerConfig } from "./connection.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-mcp-app-"));
  const store = new OperationalStore(join(root, "store.db"));
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key"));
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "runtime", displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "task", backendId: "runtime", targetId: "target", title: "Task", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  let config: AppServerConfig | undefined = { id: "server", url: "https://mcp.example.test/rpc", transport: "http", headers: { authorization: "private-header" } };
  const options = { store, vault, config: () => config, redact: (value: string) => value.replaceAll("private-header", "[REDACTED]"),
    authorizeTool: vi.fn(async () => {}), sendMessage: vi.fn(async () => {}) };
  const manager = new McpAppsManager(options);
  cleanups.push(() => manager.dispose());
  const input: McpAppCaptureInput = { sessionId: "task", serverId: "server", tool: { name: "form", inputSchema: { type: "object" } },
    resourceUri: "ui://example/form", arguments: { secret: "private-header" }, assertCurrent: () => {} };
  const cards = () => store.listEvents({ sessionId: "task" }).filter(event => event.payload.type === "mcp_app_changed");
  return { store, vault, manager, input, cards, options, setConfig: (value: AppServerConfig | undefined) => { config = value; } };
}

it("commits public pending and completed cards while sealing View-only data", async () => {
  const f = await fixture();
  const publications: string[] = [];
  const unsubscribe = f.store.subscribe(event => {
    if (event.payload.type !== "mcp_app_changed") return;
    publications.push(event.payload.card.id);
    expect(f.store.findSetting("service", "mcp-app-cards", event.payload.card.id)).toBeDefined();
  });
  const capture = await f.manager.capture(f.input);
  expect(capture).toBeDefined();
  const first = f.cards()[0]!;
  expect(first.payload).toMatchObject({ type: "mcp_app_changed", card: { pending: true } });
  await capture!.complete({ content: [{ type: "text", text: "Public answer" }], structuredContent: { private: "private-structured" }, _meta: { secret: "private-header", privateView: "view-only" } });
  const last = f.cards().at(-1)!;
  expect(last.payload).toMatchObject({ card: { pending: false, text: "Public answer" } });
  expect(JSON.stringify(f.cards().map(event => event.payload))).not.toMatch(/private-header|private-structured|view-only|ui:\/\//u);
  expect(publications).toHaveLength(2);
  if (first.payload.type !== "mcp_app_changed") throw new Error("Missing card");
  const sealed = f.store.getSetting<EncryptedCredential>("service", "mcp-app-cards", first.payload.card.id).value;
  expect(JSON.stringify(sealed)).not.toContain("view-only");
  const saved = JSON.parse(f.vault.open(sealed, first.payload.card.id));
  expect(saved.record.result._meta).toEqual({ secret: "[REDACTED]", privateView: "view-only" });
  unsubscribe();
});

it("keeps the private configuration revision stable across host restarts", async () => {
  const f = await fixture();
  const revision = f.manager.host.serverRevision(f.options.config()!);
  await f.manager.dispose();
  const restarted = new McpAppsManager(f.options);
  cleanups.push(() => restarted.dispose());
  expect(restarted.host.serverRevision(f.options.config()!)).toBe(revision);
  expect(JSON.stringify(f.store.listSettings().map(setting => setting.value))).not.toContain("private-header");
});

it("does not publish a late completion after its task is archived", async () => {
  const f = await fixture();
  const capture = await f.manager.capture(f.input);
  f.store.updateSession("task", { archived: true });
  await expect(capture!.complete({ content: [{ type: "text", text: "Late result" }] })).rejects.toThrow("MCP_APP_CARD_UNAVAILABLE");
  expect(f.cards()).toHaveLength(1);
});

it("rejects a late completion after configuration revocation without rebuilding a card", async () => {
  const f = await fixture();
  const capture = await f.manager.capture(f.input);
  f.setConfig(undefined);
  await expect(capture!.complete({ content: [] })).rejects.toThrow("MCP_APP_SERVER_CHANGED");
  expect(f.cards()).toHaveLength(1);
});
