import { describe, expect, it, vi } from "vitest";
import type { ApprovedDirectory, TargetDescriptor } from "@joko/core";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { PartnerHomeProjects } from "./partner-home-projects.js";

function fixture() {
  const home: TargetDescriptor = { id: "new-home", backendId: "managed", displayName: "Partner", trusted: true, managed: true,
    workspaceRoot: "/accounts/person/.joko/partner-homes/authority/partner", remoteWorkspace: { kind: "device_peer", controllerDeviceId: "phone", targetDeviceId: "computer",
      workspaceRoot: "/accounts/person/.joko/partner-homes/authority/partner" } };
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error("Device authority changed."); };
  const files = { realpath: vi.fn(async (path: string) => path === "/work/project/link.txt" ? "/outside/private.txt" : path),
    stat: vi.fn(async (path: string) => ({ kind: path === "/work/project" || path === home.workspaceRoot ? "directory" : "file", size: 12, modifiedAt: 1000 })),
    read: vi.fn(async () => Buffer.from("Project text")), list: vi.fn(async () => []) };
  const execution = { files: vi.fn(async () => ({ files, assertCurrent })), processes: vi.fn(async () => { throw new Error("Git is unavailable."); }) };
  const projects = new PartnerHomeProjects({ execution: execution as unknown as RemoteExecutionRouter, home: targetId => targetId === home.id ? home : undefined });
  return { home, projects, files, execution, revoke: () => { current = false; } };
}

describe("Partner home project authority", () => {
  it("checks and reads the execution computer's real directory without probing a same-named service path", async () => {
    const f = fixture();
    expect(await f.projects.check(f.home, "/work/project", () => undefined)).toBe("/work/project");
    expect(await f.projects.read(f.home, "/work/project", "notes.txt", () => undefined)).toMatchObject({ path: "/work/project/notes.txt", text: "Project text" });
    expect(f.execution.files).toHaveBeenCalledWith(f.home.remoteWorkspace);
    expect(await f.projects.executionDirectory(f.home, f.home.workspaceRoot, () => undefined)).toBe(f.home.workspaceRoot);
    await expect(f.projects.check(f.home, "/accounts/person/.joko/private", () => undefined)).rejects.toThrow("managed application data");
    await expect(f.projects.read(f.home, "/work/project", "../private.txt", () => undefined)).rejects.toThrow("outside");
    await expect(f.projects.read(f.home, "/work/project", "link.txt", () => undefined)).rejects.toThrow("outside");
    expect(f.files.read).toHaveBeenCalledOnce();
  });
  it("revalidates native directory grants and refuses a withdrawn transport during a read", async () => {
    const f = fixture(), directory = { id: "project-grant", path: "/work/project", access: "read_write" } as ApprovedDirectory;
    expect(await f.projects.validateDirectories(f.home, [directory], () => undefined)).toEqual([{ path: directory.path, access: "read_write" }]);
    f.files.read.mockImplementation(async () => { f.revoke(); return Buffer.from("must not publish"); });
    await expect(f.projects.read(f.home, directory.path, "notes.txt", () => undefined)).rejects.toThrow("authority changed");
    expect(() => f.projects.normalize(f.home, "C:\\service\\project")).toThrow("absolute project directory");
  });
});
