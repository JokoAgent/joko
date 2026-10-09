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
