import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { execServerActions, mapExecServerFileData, mapExecServerParams, mapExecServerResult } from "./hosted-agent-codex-mapping.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";

const machines = [
  { name: "POSIX", style: "posix" as const, agent: "/model/project", source: "/source/project" },
  { name: "Windows", style: "win32" as const, agent: "R:\\model\\project", source: "D:\\source\\project" },
  { name: "Windows UNC", style: "win32" as const, agent: "\\\\model-host\\share\\project", source: "\\\\source-host\\share\\project" }
];
const mappings = machines.flatMap(agent => machines.map(source => ({
  name: `${agent.name} Agent to ${source.name} Source`, agent, source
})));
const pathsFor = (style: "posix" | "win32") => style === "win32" ? win32 : posix;
const uri = (value: string, style: "posix" | "win32") => pathToFileURL(value, { windows: style === "win32" }).href;

describe("native exec-server effects and Source path mapping", () => {
  it.each(machines)("restores a $name executable argument with spaces without adding shell syntax", source => {
    const paths = pathsFor(source.style), executable = paths.join(source.source, "runtime α space", "node.exe");
    const workspace = new ExecutorWorkspace({ workingDir: source.source,
      remote: { pathStyle: source.style, home: source.source, temporary: source.source },
      aliases: [{ from: "/model/project", to: source.source }] });
    workspace.setVirtualRoot("/model/project");
    const input = { argv: ["/model/project/runtime α space/node.exe", "-e", "console.log('literal script');"],
      cwd: "file:///model/project" };
    expect(mapExecServerParams(input, workspace, "process/start", false)).toEqual({
      argv: [executable, "-e", "console.log('literal script');"], cwd: uri(source.source, source.style)
    });
    expect(input.argv[0]).toBe("/model/project/runtime α space/node.exe");
  });

  it.each(mappings)("authorizes every discovered root and maps its nested URI/sandbox for $name", ({ agent, source }) => {
    const workspace = new ExecutorWorkspace({ workingDir: source.source,
      remote: { pathStyle: source.style, home: source.source, temporary: source.source },
      aliases: [{ from: agent.agent, to: source.source }] });
    workspace.setVirtualRoot(agent.agent);
    const agentPaths = pathsFor(agent.style), sourcePaths = pathsFor(source.style);
    const agentRoots = ["skills α space", "plugins"].map(name => agentPaths.join(agent.agent, name));
    const sourceRoots = ["skills α space", "plugins"].map(name => sourcePaths.join(source.source, name));
    const denied = { access: "deny", path: { type: "path", path: uri(sourcePaths.resolve(source.source, "..", "private"), source.style) } };
    const input = { roots: agentRoots.map((root, index) => ({ id: `root-${index}`, path: uri(root, agent.style),
      sandbox: { cwd: uri(agent.agent, agent.style), workspaceRoots: [uri(root, agent.style)],
        policyContext: { cwd: uri(agent.agent, agent.style), workspaceRoots: [uri(root, agent.style)] },
        permissions: { file_system: { entries: [{ access: "read", path: { type: "path", path: uri(root, agent.style) } }, denied] } } }
    })) };
    const original = structuredClone(input);
    const mapped = mapExecServerParams(input, workspace, "capabilityRoots/discoverV1", false) as typeof input;
    expect(input).toEqual(original);
    expect(mapped.roots).toEqual(sourceRoots.map((root, index) => ({ id: `root-${index}`, path: uri(root, source.style),
      sandbox: { cwd: uri(source.source, source.style), workspaceRoots: [uri(root, source.style)],
        policyContext: { cwd: uri(source.source, source.style), workspaceRoots: [uri(root, source.style)] },
        permissions: { file_system: { entries: [{ access: "read", path: { type: "path", path: uri(root, source.style) } }, denied] } } }
    })));
    expect(execServerActions("capabilityRoots/discoverV1", mapped, source.source, source.style))
      .toEqual(sourceRoots.map(root => ({ kind: "read", path: root, scope: "tree" })));
    // The post-approval phase must not reinterpret Source URIs as Agent URIs.
    expect(mapExecServerFileData(mapped, workspace, "capabilityRoots/discoverV1")).toBe(mapped);
    const sourceFile = uri(sourcePaths.join(sourceRoots[0]!, "SKILL.md"), source.style);
    const result = { roots: [{ id: "root-0", path: uri(sourceRoots[0]!, source.style),
      skills: [{ instructions: { path: sourceFile, contents: "Read project instructions." } }] }] };
    expect(mapExecServerResult(result, workspace, "capabilityRoots/discoverV1")).toEqual({ roots: [{ id: "root-0",
      path: uri(agentRoots[0]!, agent.style), skills: [{ instructions: {
        path: uri(agentPaths.join(agentRoots[0]!, "SKILL.md"), agent.style), contents: "Read project instructions."
      } }] }] });
  });

  it.each(machines)("uses $name Source paths for filesystem effects", source => {
    const paths = pathsFor(source.style), root = source.source, file = paths.join(root, "file α.txt"), destination = paths.join(root, "copy α.txt");
    const path = uri(file, source.style);
    for (const mode of [undefined, "read", "write", "readWrite", false]) {
      const open = execServerActions("fs/open", { handleId: "file-1", path, mode }, root, source.style);
      expect(open).toEqual([{ kind: "read", path: file }, ...(mode === undefined || mode === "read" ? [] : [{ kind: "write", path: file }])]);
    }
    for (const recursive of [false, true]) {
      const scope = recursive ? { scope: "tree" } : {};
      expect(execServerActions("fs/copy", { sourcePath: path, destinationPath: uri(destination, source.style), recursive }, root, source.style))
        .toEqual([{ kind: "read", path: file, ...scope }, { kind: "write", path: destination, ...scope }]);
      expect(execServerActions("fs/remove", { path, recursive }, root, source.style)).toEqual([{ kind: "write", path: file, ...scope }]);
    }
    expect(execServerActions("fs/createDirectory", { path, recursive: true }, root, source.style)).toEqual([{ kind: "write", path: file }]);
    expect(execServerActions("fs/writeFile", { path, recursive: true }, root, source.style)).toEqual([{ kind: "write", path: file }]);
    expect(execServerActions("fs/readFile", { path: path.replace(/^file:/u, "FILE:") }, root, source.style)).toEqual([{ kind: "read", path: file }]);
    expect(execServerActions("fs/walk", { path }, root, source.style)).toEqual([{ kind: "read", path: file, scope: "tree" }]);
  });

  it("maps only the authorized file payload in the second phase", () => {
    const workspace = new ExecutorWorkspace({ workingDir: "D:\\source\\project",
      remote: { pathStyle: "win32", home: "D:\\source", temporary: "D:\\temp" },
      aliases: [{ from: "/model/project", to: "D:\\source\\project" }] });
    workspace.setVirtualRoot("/model/project");
    const initial = mapExecServerParams({ path: "file:///model/project/file.txt", dataBase64: Buffer.from("plain text").toString("base64") },
      workspace, "fs/writeFile", false);
    expect(initial).toMatchObject({ path: "file:///D:/source/project/file.txt" });
    const forwarded = mapExecServerFileData(initial, workspace, "fs/writeFile");
    expect(forwarded).toEqual(initial);
  });

  it("keeps POSIX paths with drive-like names and rejects encoded URI separators", () => {
    const workspace = new ExecutorWorkspace({ workingDir: "/source/project", remote: { pathStyle: "posix", home: "/source", temporary: "/tmp" },
      aliases: [{ from: "/C:/model/project", to: "/source/project" }] });
    workspace.setVirtualRoot("/C:/model/project");
    expect(mapExecServerParams({ roots: [{ id: "root", path: "file:///C:/model/project/skills" }] }, workspace, "capabilityRoots/discoverV1", false))
      .toEqual({ roots: [{ id: "root", path: "file:///source/project/skills" }] });
    expect(() => mapExecServerParams({ roots: [{ id: "root", path: "file:///C:/model/project%2Foutside" }] }, workspace, "capabilityRoots/discoverV1", false)).toThrow();
    const denied = { access: "deny", path: { type: "path", path: "file:///private%2Fkey" } };
    const mapped = mapExecServerParams({ roots: [{ id: "root", path: "file:///C:/model/project",
      sandbox: { permissions: { file_system: { entries: [denied] } } } }] }, workspace, "capabilityRoots/discoverV1", false);
    expect(mapped).toMatchObject({ roots: [{ sandbox: { permissions: { file_system: { entries: [denied] } } } }] });
  });

  it("represents executor HTTP as a network effect without borrowing file or command authority", () => {
    const params = { url: "https://mcp.example.invalid/mcp", method: "POST", bodyBase64: "e30=", headers: [{ name: "authorization", value: "private" }] };
    expect(execServerActions("http/request", params, "/project", "posix"))
      .toEqual([{ kind: "network", url: params.url, method: "POST" }]);
    expect(execServerActions("http/request", {}, "/project", "posix"))
      .toEqual([{ kind: "network", url: "<unknown>", method: "<unknown>" }]);
    expect(execServerActions("initialize", {}, "/project", "posix")).toEqual([]);
    expect(execServerActions("environment/info", {}, "/project", "posix")).toEqual([]);
  });
});
