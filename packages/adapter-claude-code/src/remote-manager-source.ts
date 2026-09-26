import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const SESSION_STORE_PLACEHOLDER = "__JOKO_EMBEDDED_CLAUDE_SESSION_STORE_V1__";

export type ClaudeRemoteManagerSourceMode = "auto" | "compiled" | "source";

/**
 * Loads the audited single-file manager shipped with this exact Adapter build.
 * Source-mode development erases types from the owning sources; compiled
 * products embed the emitted Store module into the emitted manager module.
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
  return bundleClaudeRemoteManagerSource(manager, store);
}

export function bundleClaudeRemoteManagerSource(manager: Buffer, sessionStore: Buffer): Buffer {
  const source = manager.toString("utf8");
  const first = source.indexOf(SESSION_STORE_PLACEHOLDER);
  if (first < 0 || source.indexOf(SESSION_STORE_PLACEHOLDER, first + SESSION_STORE_PLACEHOLDER.length) >= 0) {
    throw new Error("The remote Claude manager Store bundle marker is invalid.");
  }
  const embedded = sessionStore.toString("base64");
  if (embedded.length === 0) throw new Error("The remote Claude manager Store module is unavailable.");
  return Buffer.from(source.replace(SESSION_STORE_PLACEHOLDER, embedded), "utf8");
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
