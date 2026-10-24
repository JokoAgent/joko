/* Adapted from the fixed Source instruction collector. SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 XD Inc. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { redactSecrets, type AdapterContext } from "@joko/core";
import type { HostedAgentPeerWorkspace } from "./hosted-agent-peer-workspace.js";
import { mapSourceInstructionImports, sanitizeHostedPermissionSettings, type HostedProjectFile, type SourceProjectFilesOptions } from "./hosted-agent-project-files.js";
import { isShareCredentialPath, textSpellsOutSecret } from "./hosted-agent-credentials.js";

const instructions = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md"];
const trees = [".claude/rules", ".claude/skills", ".claude/agents", ".claude/commands", ".agents/skills", ".codex/skills", ".pi/skills", ".pi/prompts"];
/** Collects only the original task Device's bounded instruction/resource text.
 * The Model Host's HOME and the service node's project tree never substitute. */
export async function snapshotPeerSourceProject(context: AdapterContext, peer: HostedAgentPeerWorkspace, nativeKind: string,
  resourceAllowed?: SourceProjectFilesOptions["resourceAllowed"]): Promise<readonly HostedProjectFile[]> {
  const root = context.target.workspaceRoot, files = new Map<string, HostedProjectFile>(), paths = new Map<string, string>();
  const roots = [root, peer.home, ...(context.extraDirectories ?? []).map(value => value.path)];
  const queue: { actual: string; wire: string; depth: number; content: string }[] = []; let bytes = 0, visited = 0;
  const guard = () => { context.signal.throwIfAborted(); peer.assertCurrent(); };
  const add = async (actual: string, wire: string, depth = 0, permissionSettings = false, exactAncestor = false, nonBlank = false): Promise<string | undefined> => {
    guard(); if (files.size >= 512 || ++visited > 4096 || !wire || wire.length > 1024 || wire.includes("\\") || posix.isAbsolute(wire) || wire.split("/").includes("..")) return;
    const previous = paths.get(actual); if (previous) return previous;
    try {
      const canonical = await peer.canonical(actual, context.signal); guard();
      if (!(roots.some(parent => peer.inside(parent, canonical)) || exactAncestor && peer.same(actual, canonical)) || !permissionSettings && (isShareCredentialPath(actual) || isShareCredentialPath(canonical))) return;
      const info = await peer.info(canonical, context.signal); if (info.kind !== "file" || info.size > 512 * 1024) return;
      const contentBytes = await peer.read(canonical, 512 * 1024, context.signal); guard();
      let content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
      if (nonBlank && !content.trim()) return;
      if (permissionSettings) { const sanitized = sanitizeHostedPermissionSettings(content); if (sanitized === undefined) return; content = sanitized; }
      if (content.includes("\0") || textSpellsOutSecret(content) || redactSecrets(content) !== content || bytes + Buffer.byteLength(content) > 4 * 1024 * 1024) return;
      bytes += Buffer.byteLength(content); paths.set(actual, wire); paths.set(canonical, wire); files.set(wire, { path: wire, content });
      if (!permissionSettings) queue.push({ actual: canonical, wire, depth, content }); return wire;
    } catch { guard(); return; }
  };
  for (const file of instructions) await add(peer.paths.join(root, ...file.split("/")), file);
  for (const file of [".claude/settings.json", ".claude/settings.local.json"]) await add(peer.paths.join(root, ...file.split("/")), file, 0, true);
  const scan = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 6 || visited >= 4096 || files.size >= 512) return;
    const actual = peer.paths.join(root, ...directory.split("/"), ...relative.split("/").filter(Boolean));
    try {
      const canonical = await peer.canonical(actual, context.signal); guard(); if (!peer.inside(root, canonical)) return;
      for (const name of await peer.directory(canonical, context.signal)) {
        guard(); if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/u.test(name) || name === ".git" || name === "node_modules") continue;
        const path = relative ? `${relative}/${name}` : name, absolute = peer.paths.join(actual, name), info = await peer.info(absolute, context.signal);
        if (info.kind === "directory") await scan(directory, path, depth + 1);
        else if (info.kind === "file" && /\.md$/iu.test(name)) {
          const wire = `${directory}/${path}`, realPath = await peer.canonical(absolute, context.signal);
          const allowed = directory === ".claude/rules" || await resourceAllowed?.({ relativePath: wire, absolutePath: absolute, realPath }, context);
          guard(); if (allowed) await add(absolute, wire);
        }
      }
    } catch { guard(); }
  };
  for (const directory of trees) if (directory === ".claude/rules" || resourceAllowed) await scan(directory, "", 0);
  if (nativeKind !== "pi") {
    let ancestor = peer.paths.dirname(root);
    for (let depth = 0; depth < 32; depth++) {
      for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"]) {
        const actual = peer.paths.join(ancestor, name);
        // Ancestors are explicit guidance, never an arbitrary sibling tree.
        await add(actual, `.claude/rules/source-context/${hash(actual)}.md`, 0, false, true);
      }
      const parent = peer.paths.dirname(ancestor); if (parent === ancestor || peer.same(ancestor, peer.home)) break; ancestor = parent;
    }
    for (const name of nativeKind === "codex" ? [".codex/AGENTS.override.md", ".codex/AGENTS.md"] : [".claude/CLAUDE.md", ".claude/CLAUDE.local.md"]) {
      const actual = peer.paths.join(peer.home, ...name.split("/"));
      const selected = await add(actual, `.claude/rules/source-context/${hash(actual)}.md`, 0, false, false, nativeKind === "codex");
      if (nativeKind === "codex" && selected) break;
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]!; if (entry.depth >= 8) continue;
    const imports = new Set<string>(); mapSourceInstructionImports(entry.content, value => { imports.add(value); return ""; });
    const targets = new Map<string, string>();
    for (const value of imports) {
      const expanded = value.startsWith("~/") ? peer.paths.join(peer.home, value.slice(2)) : value;
      const actual = peer.paths.resolve(peer.paths.dirname(entry.actual), expanded), existing = paths.get(actual);
      if (existing) targets.set(value, existing);
      else {
        // Imported files stay inside the task, HOME, or approved extra roots.
        if (![root, peer.home, ...(context.extraDirectories ?? []).map(item => item.path)].some(parent => peer.inside(parent, actual))) continue;
        const wire = await add(actual, `.claude/rules/source-context/${hash(actual)}.md`, entry.depth + 1); if (wire) targets.set(value, wire);
      }
    }
    files.set(entry.wire, { path: entry.wire, content: mapSourceInstructionImports(entry.content, value => {
      const target = targets.get(value); return target ? `@${posix.relative(posix.dirname(entry.wire), target)}` : `\`@${value}\``;
    }) });
  }
  guard(); return [...files.values()];
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
