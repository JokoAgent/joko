import type { AppController } from "./controller.js";
import type { WorkspaceEntryView, WorkspaceView } from "./model.js";

export type ProjectConversionDestination = "codex" | "claude-code";
type Category = "instructions" | "agents" | "hooks" | "mcp";
type Copy = { readonly source: string; readonly path: string };
export type ProjectConversionCandidate = {
  readonly category: Category;
  readonly writes: readonly { readonly path: string; readonly text: string }[];
  readonly copies?: readonly Copy[];
};
export type ProjectConversionPlanner = (
  backend: ProjectConversionDestination,
  files: readonly { readonly path: string; readonly text: string | null }[],
  scripts: readonly Copy[]
) => Promise<readonly ProjectConversionCandidate[]>;

type WorkspaceOperations = Pick<AppController, "listWorkspaceEntries" | "readWorkspaceFile" | "createWorkspaceEntry"
  | "copyWorkspaceEntry" | "writeWorkspaceTextFile">;
type Project = { readonly workspaceId: string; readonly backend: ProjectConversionDestination };
type Plan = Awaited<ReturnType<typeof inspectProjectConfiguration>>;
const listing = { includeHidden: true, policy: "documentTreeShowIgnored" } as const;
const configurationPaths = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".mcp.json"];

export function localProjectConversion(
  workspace: WorkspaceView | undefined, backend: string | undefined, managedLocal: boolean, canWrite: boolean
): Project | undefined {
  if (!managedLocal || !canWrite || workspace?.kind !== "userProject" || !workspace.trusted
    || workspace.remoteWorkspace !== undefined || (backend !== "codex" && backend !== "claude-code")) return undefined;
  return { workspaceId: workspace.id, backend };
}

export async function inspectProjectConfiguration(
  operations: WorkspaceOperations, project: Project, plan: ProjectConversionPlanner, current: () => boolean
) {
  const { workspaceId, backend } = project;
  const files = new Map<string, { readonly text: string; readonly revision: string } | null>();
  const scripts = new Map<string, { readonly copy: Copy; readonly revision: string }>();
  const directories = new Map<string, Promise<readonly WorkspaceEntryView[] | null | undefined>>();
  function list(path: string): Promise<readonly WorkspaceEntryView[] | null | undefined> {
    const pending = directories.get(path);
    if (pending !== undefined) return pending;
    const result = (async () => {
      if (path !== "") {
        const parent = await list(parentPath(path));
        if (parent === undefined) return undefined;
        const entry = parent?.find(value => value.path === path);
        if (entry === undefined) return null;
        if (entry.kind !== "directory") return undefined;
      }
      ensureCurrent(current);
      try { return await operations.listWorkspaceEntries(workspaceId, path, listing); }
      catch (error) { if (path === "") throw error; return undefined; }
    })();
    directories.set(path, result);
    return result;
  }
  async function read(path: string): Promise<void> {
    const parent = await list(parentPath(path));
    if (parent === undefined) return;
    const entry = parent?.find(value => value.path === path);
    if (entry === undefined) { files.set(path, null); return; }
    if (entry.kind !== "file") return;
    ensureCurrent(current);
    try {
      const file = await operations.readWorkspaceFile(workspaceId, path);
      if (file.kind === "text" && file.text !== undefined && file.revision && !file.truncated) {
        files.set(path, { text: file.text, revision: file.revision });
      }
    } catch {
      // An unreadable file is unknown, so it cannot be used or replaced.
    }
  }

  const sourceRoot = backend === "codex" ? ".claude" : ".codex";
  const targetRoot = backend === "codex" ? ".codex" : ".claude";
  const sourceAgent = backend === "codex" ? /^([a-z0-9_-]{1,64})\.md$/iu : /^([a-z0-9_-]{1,64})\.toml$/iu;
  const targetAgentSuffix = backend === "codex" ? ".toml" : ".md";
  const [agents, sourceScripts, targetScripts] = await Promise.all([
    list(sourceRoot + "/agents"), list(sourceRoot + "/hooks"), list(targetRoot + "/hooks")
  ]);
  const agentPaths = (agents ?? []).flatMap(entry => {
    const name = sourceAgent.exec(entry.name)?.[1];
    return entry.kind === "file" && name ? [entry.path, targetRoot + "/agents/" + name + targetAgentSuffix] : [];
  }).slice(0, 120);
  // Bound concurrent preview requests even when a project contains many agent files.
  const paths = [...new Set([...configurationPaths, ...agentPaths])];
  for (let offset = 0; offset < paths.length; offset += 12) await Promise.all(paths.slice(offset, offset + 12).map(read));
  if (targetScripts !== undefined) {
    const existing = new Set((targetScripts ?? []).map(entry => entry.name.toLowerCase()));
    for (const entry of sourceScripts ?? []) {
      if (entry.kind !== "file" || !entry.revision || !/^[a-z0-9_][a-z0-9_.-]{0,127}$/iu.test(entry.name)
        || existing.has(entry.name.toLowerCase())) continue;
      const path = targetRoot + "/hooks/" + entry.name;
      scripts.set(path, { copy: { source: entry.path, path }, revision: entry.revision });
      if (scripts.size === 128) break;
    }
  }
  ensureCurrent(current);
  const candidates = await plan(backend, paths.flatMap(path => files.has(path) ? [{ path, text: files.get(path)?.text ?? null }] : []),
    Array.from(scripts.values(), ({ copy }) => copy));
  ensureCurrent(current);
  return { candidates, files, scripts };
}

export async function applyProjectConfiguration(
  operations: WorkspaceOperations, project: Project, plan: ProjectConversionPlanner, preview: Plan,
  selected: ReadonlySet<Category>, current: () => boolean
): Promise<void> {
  if (selected.size === 0) return;
  const fresh = await inspectProjectConfiguration(operations, project, plan, current);
  const wanted = preview.candidates.filter(candidate => selected.has(candidate.category));
  const candidates = fresh.candidates.filter(candidate => selected.has(candidate.category));
  if (confirmationReceipt(preview, wanted) !== confirmationReceipt(fresh, candidates)) {
    throw new Error("Project configuration changed while awaiting confirmation.");
  }
  const { workspaceId } = project;
  const prepared = new Set<string>([""]);
  async function prepareDirectory(path: string): Promise<void> {
    if (prepared.has(path)) return;
    const parent = parentPath(path);
    await prepareDirectory(parent);
    ensureCurrent(current);
    const entries = await operations.listWorkspaceEntries(workspaceId, parent, listing);
    const existing = entries.find(entry => entry.path === path);
    ensureCurrent(current);
    if (existing === undefined) await operations.createWorkspaceEntry({ workspaceId, kind: "directory", path });
    else if (existing.kind !== "directory") throw new Error("A configuration folder is no longer available.");
    prepared.add(path);
  }
  for (const candidate of candidates) {
    for (const { source, path } of candidate.copies ?? []) {
      const receipt = fresh.scripts.get(path);
      if (!receipt || receipt.copy.source !== source) throw new Error("A hook script changed before conversion.");
      await prepareDirectory(parentPath(path));
      ensureCurrent(current);
      await operations.copyWorkspaceEntry({ workspaceId, sourcePath: source, destinationPath: path, expectedRevision: receipt.revision });
    }
    for (const { path, text } of candidate.writes) {
      const previous = fresh.files.get(path);
      if (previous === undefined) throw new Error("A configuration file is no longer available.");
      let revision = previous?.revision;
      if (!revision) {
        await prepareDirectory(parentPath(path));
        ensureCurrent(current);
        await operations.createWorkspaceEntry({ workspaceId, kind: "file", path });
        ensureCurrent(current);
        const entry = await operations.readWorkspaceFile(workspaceId, path);
        if (entry.kind !== "text" || entry.text !== "" || !entry.revision) throw new Error("A new configuration file changed before conversion.");
        revision = entry.revision;
      }
      ensureCurrent(current);
      await operations.writeWorkspaceTextFile(workspaceId, { path, text, expectedRevision: revision });
    }
  }
}

function confirmationReceipt(plan: Plan, candidates: readonly ProjectConversionCandidate[]): string {
  return JSON.stringify(candidates.map(candidate => [
    candidate.category,
    candidate.writes.map(write => [write, plan.files.get(write.path)?.revision]),
    candidate.copies?.map(copy => [copy, plan.scripts.get(copy.path)?.revision])
  ]));
}

function parentPath(path: string): string { return path.slice(0, Math.max(path.lastIndexOf("/"), 0)); }

function ensureCurrent(current: () => boolean): void {
  if (!current()) throw new DOMException("The project conversion owner changed.", "AbortError");
}
