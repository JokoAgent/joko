/** Private authority for an Agent hosted away from its task's execution node.
 * The endpoint and bearer belong to one live native runtime. They must never
 * enter a product Session, event, workspace or diagnostic. */
export interface HostedExecutionBase {
  readonly workspace: {
    /** Agent-side virtual root, mapped to the task's real root by its executor. */
    readonly root: string;
    readonly additionalRoots: readonly string[];
    /** Source directory identities; paths and current read/write grants stay
     * exclusively with the original executor. */
    readonly additionalDirectoryIds?: readonly string[];
    readonly platform: "win32" | "darwin" | "linux";
    readonly shell: string;
    readonly isGitRepository: boolean;
    readonly personalInstructions?: string;
    readonly memoryInstructions?: string;
    readonly mcpEnabled?: true;
    /** Source-approved instruction snapshots, already using virtual paths. */
    readonly contextFiles?: readonly { readonly path: string; readonly content: string }[];
  };
  readonly channel: { readonly endpoint: string; readonly bearer: string };
  readonly source: { readonly sessionId: string; readonly targetId: string; readonly generation: number };
  readonly assertCurrent: () => void;
}

export type HostedExecution = HostedExecutionBase & (
  | { readonly trust: "owner" }
  | { readonly trust: "guest"; readonly guestHome: string; readonly providerId: string; readonly modelIds: readonly string[] }
);

export function assertHostedExecution(hosted: HostedExecution): void {
  hosted.assertCurrent();
  const endpoint = new URL(hosted.channel.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[a-zA-Z0-9_-]{32,256}$/u.test(hosted.channel.bearer)
    || !hosted.workspace.root || hosted.workspace.root.length > 16_384 || hosted.workspace.root.includes("\0")
    || !Array.isArray(hosted.workspace.additionalRoots) || hosted.workspace.additionalRoots.length > 128
    || hosted.workspace.additionalRoots.some(root => typeof root !== "string" || !root || root.length > 16_384 || root.includes("\0"))
    || hosted.workspace.additionalDirectoryIds !== undefined && (!Array.isArray(hosted.workspace.additionalDirectoryIds)
      || hosted.workspace.additionalDirectoryIds.length > 128 || new Set(hosted.workspace.additionalDirectoryIds).size !== hosted.workspace.additionalDirectoryIds.length
      || hosted.workspace.additionalDirectoryIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)))
    || !["win32", "darwin", "linux"].includes(hosted.workspace.platform)
    || typeof hosted.workspace.shell !== "string" || hosted.workspace.shell.length > 16_384
    || typeof hosted.workspace.isGitRepository !== "boolean"
    || hosted.workspace.personalInstructions !== undefined && (typeof hosted.workspace.personalInstructions !== "string" || hosted.workspace.personalInstructions.length > 1024 * 1024)
    || hosted.workspace.memoryInstructions !== undefined && (typeof hosted.workspace.memoryInstructions !== "string" || hosted.workspace.memoryInstructions.length > 1024 * 1024)
    || hosted.workspace.mcpEnabled !== undefined && hosted.workspace.mcpEnabled !== true
    || hosted.workspace.contextFiles !== undefined && (!Array.isArray(hosted.workspace.contextFiles) || hosted.workspace.contextFiles.length > 512
      || hosted.workspace.contextFiles.some(file => !file || typeof file.path !== "string" || !file.path || file.path.length > 16_384 || file.path.includes("\0")
        || typeof file.content !== "string" || file.content.length > 1024 * 1024))
    || !hosted.source.sessionId || !hosted.source.targetId || !Number.isSafeInteger(hosted.source.generation) || hosted.source.generation < 0
    || !["owner", "guest"].includes(hosted.trust)
    || hosted.trust === "guest" && (!hosted.guestHome || !hosted.providerId || !Array.isArray(hosted.modelIds) || !hosted.modelIds.length
      || hosted.modelIds.length > 10_000 || hosted.modelIds.some(id => typeof id !== "string" || !id || id.length > 512))) {
    throw new Error("Hosted Agent execution authority is invalid.");
  }
  if (new TextEncoder().encode(JSON.stringify({ instructions: hosted.workspace.personalInstructions, memory: hosted.workspace.memoryInstructions, files: hosted.workspace.contextFiles })).byteLength > 6 * 1024 * 1024) {
    throw new Error("Hosted Agent instructions exceed their limit.");
  }
}

export function hostedExecutionEnvironmentNote(hosted: HostedExecution): string {
  assertHostedExecution(hosted);
  return ["# Workspace", `The current workspace is ${JSON.stringify(hosted.workspace.root)} (${hosted.workspace.platform}, shell: ${hosted.workspace.shell}).`,
    "File and shell tools operate in this workspace. Relative paths resolve against its root.",
    ...(hosted.workspace.additionalRoots.length ? [`Additional workspace directories: ${hosted.workspace.additionalRoots.map(root => JSON.stringify(root)).join(", ")}.`] : []),
    `Is a git repository: ${hosted.workspace.isGitRepository ? "yes" : "no"}.`,
    ...(hosted.workspace.personalInstructions?.trim() ? ["", "# The user's personal instructions", hosted.workspace.personalInstructions.trim()] : []),
    ...(hosted.workspace.memoryInstructions?.trim() ? ["", hosted.workspace.memoryInstructions.trim()] : []),
    ...((hosted.workspace.contextFiles?.length ?? 0) ? ["", "# Project Context", "",
      ...hosted.workspace.contextFiles!.map(file => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`)] : [])].join("\n");
}
