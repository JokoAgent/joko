import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const SESSION_STORE_PLACEHOLDER = "__JOKO_EMBEDDED_CLAUDE_SESSION_STORE_V1__";
const FRESH_CONTEXT_PLACEHOLDER = "__JOKO_EMBEDDED_CLAUDE_FRESH_CONTEXT_OWNER_V1__";

export type ClaudeRemoteManagerSourceMode = "auto" | "compiled" | "source";

/**
 * Loads the audited single-file manager shipped with this exact Adapter build.
 * Source-mode development erases types from the owning sources; compiled
 * products embed the emitted Store and fresh context Owner into the manager.
 */
export async function loadClaudeRemoteManagerSource(
  mode: ClaudeRemoteManagerSourceMode = "auto",
  moduleUrl: URL = new URL(import.meta.url)
): Promise<Buffer> {
  const manager = await loadModuleSource(
    new URL("./remote-manager/manager.mjs", moduleUrl),
    new URL("./remote-manager/manager.mts", moduleUrl),
    mode
  );
  const store = await loadModuleSource(
    new URL("./claude-session-store.js", moduleUrl),
    new URL("./claude-session-store.ts", moduleUrl),
    mode
  );
  const freshContext = await loadModuleSource(
    new URL("./fresh-context-owner.js", moduleUrl),
    new URL("./fresh-context-owner.ts", moduleUrl),
    mode
  );
  return bundleClaudeRemoteManagerSource(manager, store, freshContext);
}

export function bundleClaudeRemoteManagerSource(manager: Buffer, sessionStore: Buffer, freshContext: Buffer): Buffer {
  let source = manager.toString("utf8");
  for (const [marker, module] of [[SESSION_STORE_PLACEHOLDER, sessionStore], [FRESH_CONTEXT_PLACEHOLDER, freshContext]] as const) {
    const first = source.indexOf(marker);
    if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
      throw new Error("The remote Claude manager Owner bundle marker is invalid.");
    }
    const embedded = module.toString("base64");
    if (embedded.length === 0) throw new Error("The remote Claude manager Owner module is unavailable.");
    source = source.replace(marker, embedded);
  }
  return Buffer.from(source, "utf8");
}

async function loadModuleSource(compiled: URL, source: URL, mode: ClaudeRemoteManagerSourceMode): Promise<Buffer> {
  if (mode !== "source") {
    try { return await readFile(compiled); }
    catch (error) { if (mode === "compiled") throw error; }
  }
  const typescript = await readFile(source, "utf8");
  const javascript = stripTypeScriptTypes(typescript, {
    mode: "transform",
    sourceMap: false
  });
  return Buffer.from(javascript, "utf8");
}
