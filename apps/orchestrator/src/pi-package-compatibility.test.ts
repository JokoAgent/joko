import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzePiExtensionCompatibility,
  evaluatePiRuntimeRequirements,
  inspectPiPackageCompatibility,
  shouldShowPiPackageNotice
} from "./pi-package-compatibility.js";

const temporaryRoots: string[] = [];

async function createFixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-package-compatibility-"));
  temporaryRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi extension compatibility analysis", () => {
  it("separates host-adapted APIs from terminal-only APIs across local imports", async () => {
    const root = await createFixture({
      "index.ts": `
        import { register } from "./nested.js";
        export default function setup(extensionApi: unknown) { return register(extensionApi); }
      `,
      "nested.ts": `
        export function register(pi: any) {
          pi.on("session_start", (_event: unknown, ctx: any) => {
            const { notify, setStatus, setFooter } = ctx.ui;
            notify("ready");
            setStatus("work", "ready");
            setFooter(() => undefined);
            if (ctx.mode === "tui") ctx.ui.custom(() => undefined);
          });
        }
      `
    });

    await expect(analyzePiExtensionCompatibility(join(root, "index.ts"), root)).resolves.toMatchObject({
      compatibility: "partial",
      adaptedApis: ["notify", "setStatus"],
      unsupportedApis: ["setFooter"],
      compatibilityIssues: ["tui-layout"],
      scannedFiles: 2
    });
  });

  it("does not treat strings or comments as calls and reports dynamic access as incomplete", async () => {
    const root = await createFixture({
      "index.ts": `
        export default function setup(pi: any) {
          pi.on("session_start", (_event: unknown, ctx: any) => {
            // ctx.ui.setHeader(() => undefined)
            const sample = "ctx.ui.setTheme('dark')";
            const method = sample.length > 0 ? "notify" : "setStatus";
            ctx.ui[method]("ready");
          });
        }
      `
    });

    await expect(analyzePiExtensionCompatibility(join(root, "index.ts"), root)).resolves.toMatchObject({
      compatibility: "unknown",
      detectedApis: [],
      compatibilityIssues: ["analysis-incomplete"]
    });
  });

  it("distinguishes the supported string widget from a statically visible component factory", async () => {
    const root = await createFixture({
      "index.ts": `
        export default function setup(pi: any) {
          pi.on("session_start", (_event: unknown, ctx: any) => {
            ctx.ui.setWidget("summary", ["one", "two"]);
            ctx.ui.setWidget("interactive", () => ({ render() { return []; } }));
          });
        }
      `
    });

    await expect(analyzePiExtensionCompatibility(join(root, "index.ts"), root)).resolves.toMatchObject({
      compatibility: "partial",
      detectedApis: ["setWidget"],
      adaptedApis: ["setWidget"],
      unsupportedApis: [],
      compatibilityIssues: ["widget-component"]
    });
  });

  it("recognizes command and tool context parameters without relying on their names", async () => {
    const root = await createFixture({
      "index.ts": `
        export default function setup(pi: any) {
          pi.registerCommand("review", {
            handler(_args: unknown, view: any) {
              view.ui.setTitle("Review");
              view.ui.getTheme();
            }
          });
          pi.registerTool({
            name: "inspect",
            execute(_id: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, surface: any) {
              return surface.ui.confirm("Continue?", "Inspect this item?");
            }
          });
        }
      `
    });

    await expect(analyzePiExtensionCompatibility(join(root, "index.ts"), root)).resolves.toMatchObject({
      compatibility: "partial",
      adaptedApis: ["confirm", "setTitle"],
      unsupportedApis: ["getTheme"],
      compatibilityIssues: ["theme-control"]
    });
  });

  it("returns unknown when the source cannot be parsed completely", async () => {
    const root = await createFixture({ "index.ts": "export default function broken( {" });
    await expect(analyzePiExtensionCompatibility(join(root, "index.ts"), root)).resolves.toMatchObject({
      compatibility: "unknown",
      compatibilityIssues: ["analysis-incomplete"]
    });
  });
});

describe("Pi package compatibility details", () => {
  it("evaluates current runtime peer requirements", () => {
    expect(evaluatePiRuntimeRequirements({
      "@earendil-works/pi-coding-agent": ">=0.84.0 <0.85.0",
      unrelated: "^1.0.0"
    }, "0.84.2")).toEqual([
      {
        packageName: "@earendil-works/pi-coding-agent",
        range: ">=0.84.0 <0.85.0",
        currentVersion: "0.84.2",
        compatible: true
      }
    ]);
  });

  it("projects manifest resources, disabled lifecycle hooks, compatibility, and content identity", async () => {
    const root = await createFixture({
      "package.json": JSON.stringify({
        name: "full-package",
        version: "2.1.0",
        peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.0" },
        scripts: { postinstall: "node setup.js" },
        pi: {
          extensions: ["extensions/index.ts"],
          skills: ["skills"],
          prompts: ["prompts"],
          themes: ["themes"]
        }
      }),
      "extensions/index.ts": `
        export default function setup(pi: any) {
          pi.on("session_start", (_event: unknown, ctx: any) => {
            ctx.ui.setStatus("ready", "yes");
            ctx.ui.setHeader(() => undefined);
          });
        }
      `,
      "skills/review/SKILL.md": "# Review\n",
      "prompts/check.md": "Check this.\n",
      "themes/night.json": "{}\n"
    });
    const result = await inspectPiPackageCompatibility(root, {
      currentRuntimeVersion: "0.84.2",
      contentFingerprint: "sha256:package-bytes"
    });

    expect(result).toMatchObject({
      name: "full-package",
      version: "2.1.0",
      canToggle: true,
      compatibilityNotice: true,
      extensionContentFingerprint: "sha256:package-bytes",
      warnings: ["lifecycle-scripts-disabled"],
      disabledLifecycleScripts: ["postinstall"],
      runtimeRequirements: [{ compatible: true }]
    });
    expect(result.resources.map((resource) => resource.kind)).toEqual(["extension", "skill", "prompt", "theme"]);
    expect(result.resources[0]).toMatchObject({
      compatibility: "partial",
      adaptedApis: ["setStatus"],
      unsupportedApis: ["setHeader"],
      compatibilityIssues: ["tui-layout"]
    });
    expect(result.resources[3]).toMatchObject({ compatibility: "unsupported", compatibilityIssues: ["theme-control"] });
    expect(shouldShowPiPackageNotice(result, false)).toBe(true);
  });

  it("keeps theme-only convention packages visible but non-toggleable", async () => {
    const root = await createFixture({
      "package.json": JSON.stringify({ name: "theme-only" }),
      "themes/night.json": "{}\n"
    });
    const result = await inspectPiPackageCompatibility(root);
    expect(result.canToggle).toBe(false);
    expect(result.resources).toMatchObject([{ kind: "theme", name: "night.json", compatibility: "unsupported" }]);
  });

  it("applies additive and subtractive manifest globs with portable separators", async () => {
    const root = await createFixture({
      "package.json": JSON.stringify({
        name: "selected-extension",
        pi: { extensions: ["+extensions\\*.ts", "-extensions\\helper.ts"] }
      }),
      "extensions/index.ts": "export default function setup() {}\n",
      "extensions/helper.ts": "export function helper() {}\n"
    });
    const result = await inspectPiPackageCompatibility(root);
    expect(result.resources).toMatchObject([{ kind: "extension", name: "index.ts", compatibility: "supported" }]);
  });
});
