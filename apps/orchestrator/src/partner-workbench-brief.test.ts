import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { PartnerWorkbenchBriefReader } from "./partner-workbench-brief.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await mkdtemp(join(tmpdir(), "joko-workbench-brief-")); roots.push(root); return root; }
it("bounds and caches project facts while retaining scope checks and skipping generated dependencies", async () => {
  const root = await project(); await mkdir(join(root, "docs")); await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "README.md"), "Context"); await writeFile(join(root, "docs", "design.md"), "Design"); await writeFile(join(root, "node_modules", "ignored.md"), "Dependency");
  const read = vi.fn(); const reader = new PartnerWorkbenchBriefReader({ read });
  const first = await reader.read(root, () => undefined);
  expect(first.docs).toEqual([join(root, "README.md"), join(root, "docs", "design.md")]);
  expect(first.recent).toHaveLength(2); expect(read).not.toHaveBeenCalled();
  expect(await reader.read(root, () => undefined)).toBe(first);
  await expect(reader.read(root, () => { throw new Error("Scope withdrawn"); })).rejects.toThrow("Scope withdrawn");
});
it("reads existing repository facts and retires an external project result after withdrawal", async () => {
  const root = await project(); const git = promisify(execFile);
  await git("git", ["-C", root, "init"], { windowsHide: true });
  await git("git", ["-C", root, "remote", "add", "origin", "https://github.com/owner/project.git"], { windowsHide: true });
  await writeFile(join(root, "README.md"), "Context");
  let live = true;
  const reader = new PartnerWorkbenchBriefReader({ read: vi.fn(async () => { live = false; return { pullRequests: [], issues: [] }; }) });
  await expect(reader.read(root, () => { if (!live) throw new Error("Scope withdrawn"); })).rejects.toThrow("Scope withdrawn");
});

it("refreshes the current code-host account and remote within the local project cache interval", async () => {
  const root = await project();
  const git = promisify(execFile);
  await git("git", ["-C", root, "init"]);
  await git("git", ["-C", root, "remote", "add", "origin", "https://github.com/owner/first.git"]);
  let signedIn = false;
  const read = vi.fn(async (repository: string) => signedIn
    ? { pullRequests: [], issues: [{ number: 1, title: repository, url: `https://github.com/${repository}/issues/1`, updatedAt: 0 }] }
    : { pullRequests: [], issues: [], unavailable: "no_credential" as const });
  const reader = new PartnerWorkbenchBriefReader({ read }, () => 1_000);
  expect((await reader.read(root, () => {})).codeHost.unavailable).toBe("no_credential");
  signedIn = true;
  expect((await reader.read(root, () => {})).codeHost.issues.map(issue => issue.title)).toEqual(["owner/first"]);
  await git("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/owner/second.git"]);
  const updated = await reader.read(root, () => {});
  expect(updated.git?.remotes).toEqual(["owner/second"]);
  expect(updated.codeHost.issues.map(issue => issue.title)).toEqual(["owner/second"]);
});
