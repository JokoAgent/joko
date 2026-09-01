import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduleHookScriptInstaller,
  extractScheduleHookScript,
  scheduleHookScriptCommand,
  scheduleHookScriptSlug
} from "./schedule-hook-script-installer.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ScheduleHookScriptInstaller", () => {
  it("installs authored ESM in the workspace and self-tests the exit protocol", async () => {
    const workspace = await fixtureDirectory();
    const installer = new ScheduleHookScriptInstaller();
    const result = await installer.install({
      workspaceRoot: workspace,
      scheduleId: "schedule-1",
      scheduleName: "PR Watch",
      script: "process.exit(2)"
    });

    expect(result.filePath).toBe(join(workspace, "scripts", "schedule-checks", "pr-watch.mjs"));
    expect(result.command).toBe(scheduleHookScriptCommand(result.filePath));
    expect(await readFile(result.filePath, "utf8")).toBe("process.exit(2)\n");
    expect(result).toMatchObject({ modified: false, test: { status: "skipped", decision: "skip", exitCode: 2 } });
  });

  it("reuses the managed file for modification and never retargets outside its directory", async () => {
    const workspace = await fixtureDirectory();
    const installer = new ScheduleHookScriptInstaller();
    const first = await installer.install({
      workspaceRoot: workspace,
      scheduleName: "CI Gate",
      script: "process.exit(0)"
    });
    const updated = await installer.install({
      workspaceRoot: workspace,
      scheduleName: "Renamed",
      currentFilePath: first.filePath,
      script: "process.exit(2)"
    });
    expect(updated.filePath).toBe(first.filePath);
    expect(updated.modified).toBe(true);
    expect(updated.test).toMatchObject({ decision: "skip", exitCode: 2 });
    expect(await readFile(first.filePath, "utf8")).toBe("process.exit(2)\n");

    const outside = join(workspace, "outside.mjs");
    await writeFile(outside, "process.exit(0)\n", "utf8");
    await expect(installer.install({
      workspaceRoot: workspace,
      currentFilePath: outside,
      script: "process.exit(0)"
    })).rejects.toThrow(/outside the managed/u);
    expect(await readFile(outside, "utf8")).toBe("process.exit(0)\n");
  });

  it("allocates collision-free deterministic names", async () => {
    const workspace = await fixtureDirectory();
    const directory = join(workspace, "scripts", "schedule-checks");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "check.mjs"), "existing\n", "utf8");
    const installer = new ScheduleHookScriptInstaller();
    const installed = await installer.install({
      workspaceRoot: workspace,
      scheduleName: "检查",
      script: "process.exit(0)"
    });
    expect(installed.filePath).toBe(join(directory, "check-2.mjs"));
    expect(await readFile(join(directory, "check.mjs"), "utf8")).toBe("existing\n");
  });

  it("uses the injected utility generator for descriptions and includes current script context", async () => {
    const workspace = await fixtureDirectory();
    const generate = vi.fn(async () => "Here is the gate:\n```js\nprocess.exit(0)\n```\n");
    const installer = new ScheduleHookScriptInstaller({ generate });
    const first = await installer.install({
      workspaceRoot: workspace,
      scheduleName: "Generated",
      description: "Run only when checks fail",
      providerId: "provider-a",
      modelId: "model-a"
    });
    expect(first.test).toMatchObject({ decision: "run", exitCode: 0 });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      description: "Run only when checks fail",
      workspaceRoot: workspace,
      providerId: "provider-a",
      modelId: "model-a"
    }), undefined);

    generate.mockResolvedValueOnce("```mjs\nprocess.exit(2)\n```");
    await installer.install({
      workspaceRoot: workspace,
      scheduleName: "Generated",
      currentFilePath: first.filePath,
      description: "Change the rule"
    });
    expect(generate).toHaveBeenLastCalledWith(expect.objectContaining({
      currentScript: "process.exit(0)\n"
    }), undefined);
  });

  it("fails explicitly when description generation is unavailable and writes nothing", async () => {
    const workspace = await fixtureDirectory();
    const installer = new ScheduleHookScriptInstaller();
    await expect(installer.install({
      workspaceRoot: workspace,
      scheduleName: "Unavailable",
      description: "Generate a gate"
    })).rejects.toThrow(/generation is unavailable/u);
    await expect(readFile(join(workspace, "scripts", "schedule-checks", "unavailable.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation before any file is installed", async () => {
    const workspace = await fixtureDirectory();
    const controller = new AbortController();
    controller.abort();
    await expect(new ScheduleHookScriptInstaller().install({
      workspaceRoot: workspace,
      scheduleName: "Cancelled",
      script: "process.exit(0)",
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(join(workspace, "scripts", "schedule-checks", "cancelled.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects credential material from authored, described, and generated scripts before persistence", async () => {
    const workspace = await fixtureDirectory();
    const installer = new ScheduleHookScriptInstaller({
      generate: async () => "```js\nconst token = 'sk-abcdefghijklmnop';\nprocess.exit(0);\n```"
    });
    await expect(installer.install({
      workspaceRoot: workspace,
      scheduleName: "Authored secret",
      script: "const token = 'sk-abcdefghijklmnop';\nprocess.exit(token ? 0 : 1);"
    })).rejects.toThrow(/credential material/u);
    await expect(installer.install({
      workspaceRoot: workspace,
      scheduleName: "Description secret",
      description: "Call https://example.test/?token=abcdefghijklmnop"
    })).rejects.toThrow(/credential material/u);
    await expect(installer.install({
      workspaceRoot: workspace,
      scheduleName: "Generated secret",
      description: "Run a local check"
    })).rejects.toThrow(/credential material/u);
    await expect(readFile(join(workspace, "scripts", "schedule-checks", "authored-secret.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("schedule hook script helpers", () => {
  it("extracts fenced JavaScript, accepts code-like text, and rejects prose", () => {
    expect(extractScheduleHookScript("before\n```javascript\nprocess.exit(2)\n```\nafter"))
      .toBe("process.exit(2)\n");
    expect(extractScheduleHookScript("import fs from 'node:fs';\nprocess.exit(fs ? 0 : 1)"))
      .toContain("import fs");
    expect(extractScheduleHookScript("I cannot create the requested script.")).toBeUndefined();
  });

  it("normalizes names and shell-quotes installed paths", () => {
    expect(scheduleHookScriptSlug("Check New PRs")).toBe("check-new-prs");
    expect(scheduleHookScriptSlug("检查新任务", "run when ci fails")).toBe("run-when-ci-fails");
    expect(scheduleHookScriptSlug("检查新任务")).toBe("check");
    expect(scheduleHookScriptCommand("C:\\repo path\\check.mjs", "win32"))
      .toBe('joko-node "C:\\repo path\\check.mjs"');
    expect(scheduleHookScriptCommand("/tmp/a b/check.mjs", "linux"))
      .toBe("joko-node '/tmp/a b/check.mjs'");
  });
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "joko-schedule-hook-"));
  directories.push(directory);
  return directory;
}
