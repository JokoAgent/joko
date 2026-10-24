import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: runtime.spawnSync }));
const buildUrl = new URL("../scripts/build-native-menu-bar.mjs", import.meta.url).href;
const { buildNativeMenuBar, nativeMenuBarCompilerTarget } = await import(buildUrl) as {
  buildNativeMenuBar(options: { platform: string; architecture: string; output: string }): void;
  nativeMenuBarCompilerTarget(architecture: string): string;
};
const require = createRequire(import.meta.url);
const { auditNativeMenuBar } = require("../scripts/audit-packaged.cjs") as {
  auditNativeMenuBar(root: string, platform: string, architecture: string): Promise<void>;
};
const { SIMPLE_NATIVE_ARTIFACTS: { menuBar: artifact } } = require("../scripts/native-helper-artifacts.cjs") as {
  SIMPLE_NATIVE_ARTIFACTS: { menuBar: { directory: string; maximumBytes: number; helpers: { darwin: string } } };
};
const roots: string[] = [];

beforeEach(() => { runtime.spawnSync.mockReset(); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("native menu bar artifact", () => {
  it.each(["x64", "arm64"])("compiles the exact %s target with packaged Joko icons and seals only verified bytes", async architecture => {
    stubMacHost();
    const output = await directory();
    let entry = "";
    runtime.spawnSync.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe("xcrun");
      expect(args).toContain("-parse-as-library");
      expect(args[args.indexOf("-target") + 1]).toBe(`${architecture === "x64" ? "x86_64" : "arm64"}-apple-macos14.0`);
      entry = args.find(value => basename(value) === "main.swift")!;
      const generated = readFileSync(entry, "utf8");
      for (const [name, file] of [["Dark", "icon-dark.svg"], ["Light", "icon-light.svg"]]) {
        const encoded = /let jokoMenuBarDarkSvg = "([A-Za-z0-9+/=]+)"/u;
        const pattern = name === "Dark" ? encoded : /let jokoMenuBarLightSvg = "([A-Za-z0-9+/=]+)"/u;
        const bytes = Buffer.from(pattern.exec(generated)![1]!, "base64");
        expect(bytes).toEqual(readFileSync(new URL(`../../../packages/brand-assets/src/${file}`, import.meta.url)));
      }
      expect(generated.endsWith(readFileSync(new URL("../native/menu-bar/macos-menu-bar-helper.swift", import.meta.url), "utf8"))).toBe(true);
      writeFileSync(args[args.indexOf("-o") + 1]!, machO(architecture));
      return { status: 0 };
    });

    buildNativeMenuBar({ platform: "darwin", architecture, output });

    expect(runtime.spawnSync).toHaveBeenCalledOnce();
    expect(existsSync(entry)).toBe(false);
    const bytes = readFileSync(join(output, artifact.helpers.darwin));
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"))).toEqual({ protocolVersion: 1,
      platform: "darwin", architecture, helper: artifact.helpers.darwin, sha256: digest(bytes) });
    vi.unstubAllGlobals();
    await expect(auditNativeMenuBar(output, "darwin", architecture)).resolves.toBeUndefined();
    await expect(auditNativeMenuBar(output, "darwin", architecture === "arm64" ? "x64" : "arm64"))
      .rejects.toThrow("artifact target");
    bytes[32] = 1;
    writeFileSync(join(output, artifact.helpers.darwin), bytes);
    await expect(auditNativeMenuBar(output, "darwin", architecture)).rejects.toThrow("does not match its identity");
  });

  it.each(["compiler", "architecture"])("retires stale output and cleans generated source after a %s failure", async defect => {
    stubMacHost();
    const output = await directory();
    writeFileSync(join(output, artifact.helpers.darwin), "stale helper");
    let entry = "";
    runtime.spawnSync.mockImplementation((_command: string, args: string[]) => {
      entry = args.find(value => basename(value) === "main.swift")!;
      if (defect === "compiler") return { status: 1 };
      writeFileSync(args[args.indexOf("-o") + 1]!, machO("x64"));
      return { status: 0 };
    });
    expect(() => buildNativeMenuBar({ platform: "darwin", architecture: "arm64", output })).toThrow();
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(join(output, artifact.helpers.darwin))).toBe(false);
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")))
      .toMatchObject({ platform: "darwin", architecture: "arm64", helper: null, sha256: null });
  });

  it.each(["win32", "linux"])("admits only a null %s artifact and never invokes the native compiler", async platform => {
    const output = await directory();
    writeFileSync(join(output, artifact.helpers.darwin), "stale helper");
    buildNativeMenuBar({ platform, architecture: "arm64", output });
    expect(runtime.spawnSync).not.toHaveBeenCalled();
    expect(existsSync(join(output, artifact.helpers.darwin))).toBe(false);
    await expect(auditNativeMenuBar(output, platform, "arm64")).resolves.toBeUndefined();
    writeFileSync(join(output, "unexpected"), "not admitted");
    await expect(auditNativeMenuBar(output, platform, "arm64")).rejects.toThrow("unexpected files");
  });

  it("keeps one bounded package resource and explicit build inputs for the native helper", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const config = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8"));
    expect(artifact.maximumBytes).toBe(16 * 1024 * 1024);
    expect(config.extraResources.find((entry: { to: string }) => entry.to === artifact.directory))
      .toEqual({ from: "dist/native-menu-bar", to: artifact.directory, filter: ["manifest.json", artifact.helpers.darwin] });
    expect(manifest.scripts["build:native-menu-bar"]).toBe("node scripts/build-native-menu-bar.mjs");
    expect(manifest.scripts.build).toContain("pnpm build:native-menu-bar");
    for (const command of ["package:dir", "package:artifacts"]) {
      expect(manifest.scripts[command]).toContain("node scripts/build-native-menu-bar.mjs");
    }
    expect(() => nativeMenuBarCompilerTarget("ia32")).toThrow("unsupported");
  });
});

function stubMacHost(): void {
  vi.stubGlobal("process", new Proxy(process, { get(target, property) {
    if (property === "platform") return "darwin";
    if (property === "arch") return "arm64";
    return Reflect.get(target, property);
  } }));
}
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-native-menu-bar-test-"));
  roots.push(root);
  return root;
}
function machO(architecture: string): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
