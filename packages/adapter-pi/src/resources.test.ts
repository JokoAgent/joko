import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotApprovedProjectResources, snapshotManagedRuntimeResources } from "./resources.js";
import { mkdtemp } from "./test-paths.js";

describe("project resource snapshots", () => {
  it("loads nothing from an untrusted project and copies an approved skill immutably", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-pi-resources-workspace-"));
    const skill = join(workspace, ".pi", "skills", "review", "SKILL.md");
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "original\n");

    const deniedDestination = await mkdtemp(join(tmpdir(), "joko-pi-resources-denied-"));
    await expect(
      snapshotApprovedProjectResources({ workspaceRoot: workspace, destinationRoot: deniedDestination, trusted: false })
    ).resolves.toMatchObject({ skillPaths: [], fileCount: 0, byteLength: 0 });

    const trustedButUnapprovedDestination = await mkdtemp(join(tmpdir(), "joko-pi-resources-unapproved-"));
    await expect(snapshotApprovedProjectResources({
      workspaceRoot: workspace,
      destinationRoot: trustedButUnapprovedDestination,
      trusted: true
    })).resolves.toMatchObject({ skillPaths: [], fileCount: 0, byteLength: 0 });

    const approvedDestination = await mkdtemp(join(tmpdir(), "joko-pi-resources-approved-"));
    const snapshot = await snapshotApprovedProjectResources({
      workspaceRoot: workspace,
      destinationRoot: approvedDestination,
      trusted: true,
      approve: async (candidate) => candidate.scope === ".pi"
    });
    await writeFile(skill, "changed after snapshot\n");

    expect(snapshot.skillPaths).toHaveLength(1);
    expect(snapshot.resources).toMatchObject([{ kind: "skill", state: "approved" }]);
    expect(await readFile(join(snapshot.skillPaths[0]!, "review", "SKILL.md"), "utf8")).toBe("original\n");
  });

  it("collects approved agent skills from the working directory through the nearest repository root", async () => {
    const repository = await mkdtemp(join(tmpdir(), "joko-pi-resource-ancestors-"));
    const workspace = join(repository, "packages", "app");
    const skillFiles = [
      join(workspace, ".pi", "skills", "local-pi", "SKILL.md"),
      join(workspace, ".agents", "skills", "local-agent", "SKILL.md"),
      join(repository, "packages", ".agents", "skills", "package-agent", "SKILL.md"),
      join(repository, ".agents", "skills", "root-agent", "SKILL.md"),
      join(repository, ".pi", "skills", "root-pi-not-inherited", "SKILL.md")
    ];
    await Promise.all([
      mkdir(join(repository, ".git"), { recursive: true }),
      ...skillFiles.map((path) => mkdir(join(path, ".."), { recursive: true }))
    ]);
    await Promise.all(skillFiles.map((path, index) => writeFile(path, `skill-${index}\n`)));
    const approvedSources: string[] = [];
    const destination = await mkdtemp(join(tmpdir(), "joko-pi-resource-ancestor-snapshot-"));

    const snapshot = await snapshotApprovedProjectResources({
      workspaceRoot: workspace,
      destinationRoot: destination,
      trusted: true,
      approve: (candidate) => {
        approvedSources.push(candidate.sourcePath);
        return true;
      }
    });

    expect(approvedSources).toEqual([
      join(workspace, ".pi", "skills"),
      join(workspace, ".agents", "skills"),
      join(repository, "packages", ".agents", "skills"),
      join(repository, ".agents", "skills")
    ]);
    expect(snapshot.skillPaths).toHaveLength(4);
    expect(snapshot.resources.map((resource) => resource.id)).toEqual([
      "project:.pi:skills",
      "project:.agents:skills:0",
      "project:.agents:skills:1",
      "project:.agents:skills:2"
    ]);
    expect(snapshot.resources.some((resource) => resource.source === join(repository, ".pi", "skills"))).toBe(false);
  });

  it("materializes only the host-approved snapshot and expands exact package resources", async () => {
    const source = await mkdtemp(join(tmpdir(), "joko-pi-managed-source-"));
    const extension = join(source, "host-extension.ts");
    const skill = join(source, "host-skill");
    const prompt = join(source, "host-prompt.md");
    const packageRoot = join(source, "approved-package");
    await Promise.all([
      writeFile(extension, "export default () => undefined;\n"),
      mkdir(skill, { recursive: true }),
      writeFile(prompt, "host prompt\n"),
      mkdir(join(packageRoot, "extensions"), { recursive: true }),
      mkdir(join(packageRoot, "skills", "review"), { recursive: true }),
      mkdir(join(packageRoot, "prompts"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(skill, "SKILL.md"), "host skill\n"),
      writeFile(join(packageRoot, "extensions", "index.js"), "export default () => undefined;\n"),
      writeFile(join(packageRoot, "skills", "review", "SKILL.md"), "package skill\n"),
      writeFile(join(packageRoot, "prompts", "review.md"), "package prompt\n"),
      writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["extensions"], skills: ["skills"], prompts: ["prompts"] } })
      )
    ]);
    const destination = await mkdtemp(join(tmpdir(), "joko-pi-managed-runtime-"));
    const result = await snapshotManagedRuntimeResources({
      destinationRoot: destination,
      snapshot: {
        extensions: [extension],
        skills: [skill],
        prompts: [prompt],
        packages: [packageRoot],
        resources: [{
          id: "approved-extension",
          kind: "extension",
          name: "host",
          source: "catalog",
          state: "approved",
          revision: "sha256:approved-extension",
          runtimePath: extension
        }]
      }
    });
    await writeFile(extension, "changed after snapshot\n");

    expect(result.extensionPaths).toHaveLength(2);
    expect(result.skillPaths).toHaveLength(2);
    expect(result.promptTemplatePaths).toHaveLength(2);
    expect(await readFile(result.extensionPaths[0]!, "utf8")).toContain("export default");
    expect(result.resources).toMatchObject([{
      id: "approved-extension",
      state: "approved",
      revision: "sha256:approved-extension",
      runtimePath: result.extensionPaths[0]
    }]);
    expect(result.resources[0]?.runtimePath).not.toBe(extension);

  });

  it("expands package globs and applies Pi exclude/force-include/force-exclude filters deterministically", async () => {
    const source = await mkdtemp(join(tmpdir(), "joko-pi-package-pattern-"));
    await mkdir(join(source, "extensions"), { recursive: true });
    await Promise.all([
      writeFile(join(source, "extensions", "one.ts"), "export default () => undefined;\n"),
      writeFile(join(source, "extensions", "two.ts"), "export default () => undefined;\n"),
      writeFile(join(source, "extensions", "three.ts"), "export default () => undefined;\n")
    ]);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ pi: { extensions: ["extensions/*.ts", "!extensions/*.ts", "+extensions/two.ts", "-extensions/three.ts"] } })
    );
    const destination = await mkdtemp(join(tmpdir(), "joko-pi-package-pattern-runtime-"));

    const result = await snapshotManagedRuntimeResources({
      destinationRoot: destination,
      snapshot: { extensions: [], skills: [], prompts: [], packages: [source], resources: [] }
    });

    expect(result.extensionPaths.map((path) => path.split(/[\\/]/u).at(-1))).toEqual(["two.ts"]);
  });

  it("treats an unmatched package manifest glob as an empty Pi resource set", async () => {
    const source = await mkdtemp(join(tmpdir(), "joko-pi-package-empty-pattern-"));
    await mkdir(join(source, "extensions"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/*.ts"] } }));
    const destination = await mkdtemp(join(tmpdir(), "joko-pi-package-empty-pattern-runtime-"));

    await expect(snapshotManagedRuntimeResources({
      destinationRoot: destination,
      snapshot: { extensions: [], skills: [], prompts: [], packages: [source], resources: [] }
    })).resolves.toMatchObject({ extensionPaths: [], skillPaths: [], promptTemplatePaths: [] });
  });

  it("applies the same bounded Pi filters to package skills and prompt templates", async () => {
    const source = await mkdtemp(join(tmpdir(), "joko-pi-package-skill-prompt-pattern-"));
    await Promise.all([
      mkdir(join(source, "skills", "alpha"), { recursive: true }),
      mkdir(join(source, "skills", "beta"), { recursive: true }),
      mkdir(join(source, "prompts"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(source, "skills", "alpha", "SKILL.md"), "alpha\n"),
      writeFile(join(source, "skills", "beta", "SKILL.md"), "beta\n"),
      writeFile(join(source, "prompts", "a.md"), "a\n"),
      writeFile(join(source, "prompts", "b.md"), "b\n"),
      writeFile(join(source, "package.json"), JSON.stringify({
        pi: {
          skills: ["skills/**/SKILL.md", "!skills/**", "+skills/beta", "-skills/alpha"],
          prompts: ["prompts/*.md", "!prompts/b.md"]
        }
      }))
    ]);
    const destination = await mkdtemp(join(tmpdir(), "joko-pi-package-skill-prompt-runtime-"));

    const result = await snapshotManagedRuntimeResources({
      destinationRoot: destination,
      snapshot: { extensions: [], skills: [], prompts: [], packages: [source], resources: [] }
    });

    expect(result.skillPaths.map((path) => path.split(/[\\/]/u).at(-2))).toEqual(["beta"]);
    expect(result.promptTemplatePaths.map((path) => path.split(/[\\/]/u).at(-1))).toEqual(["a.md"]);
  });
});
