import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: runtime.spawnSync }));

const buildUrl = new URL("../scripts/build-native-remote-desktop.mjs", import.meta.url).href;
const { buildNativeRemoteDesktop } = await import(buildUrl) as {
  buildNativeRemoteDesktop(options: { platform: string; architecture: string; output: string }): void;
};
const metadata = { version: "0.56.2", hash: "1".repeat(40), source: "2".repeat(64) };
const roots: string[] = [];

describe("macOS input helper entry", () => {
  beforeEach(() => {
    runtime.spawnSync.mockReset();
    vi.stubGlobal("process", new Proxy(process, { get(target, property) {
      if (property === "platform") return "darwin";
      if (property === "arch") return "arm64";
      return Reflect.get(target, property);
    } }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each(["x64", "arm64"])("compiles the unchanged authenticated entry as main.swift for %s", async architecture => {
    const output = await directory();
    let stagedEntry = "";
    runtime.spawnSync.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe("xcrun");
      if (args.includes("swiftc")) {
        const sources = args.filter(argument => argument.endsWith(".swift"));
        expect(sources).toHaveLength(2);
        const caller = sources.find(path => basename(path) === "macos-caller.swift")!;
        stagedEntry = sources.find(path => basename(path) === "main.swift") ?? "";
        expect(stagedEntry).not.toBe("");
        expect(readFileSync(stagedEntry)).toEqual(readFileSync(new URL("../native/remote-desktop/macos-input.swift", import.meta.url)));
        expect(readFileSync(caller)).toEqual(readFileSync(new URL("../native/remote-desktop/macos-caller.swift", import.meta.url)));
        expect(args[args.indexOf("-target") + 1]).toBe(`${architecture === "x64" ? "x86_64" : "arm64"}-apple-macos11.0`);
        writeFileSync(args[args.indexOf("-o") + 1]!, machO(architecture));
        return { status: 0 };
      }
      expect(args).toContain("clang");
      return { status: 1 };
    });

    expect(() => buildNativeRemoteDesktop({ platform: "darwin", architecture, output }))
      .toThrow("The Remote Desktop capture helper requires the macOS command-line developer tools.");
    expect(stagedEntry).not.toBe("");
    expect(existsSync(stagedEntry)).toBe(false);
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"))).toMatchObject({ inputHelper: null, captureHelper: null });
  });

  it.each(["compiler", "architecture"])("cleans the temporary entry and publishes no helper after an input %s failure", async defect => {
    const output = await directory();
    let stagedEntry = "";
    runtime.spawnSync.mockImplementation((_command: string, args: string[]) => {
      stagedEntry = args.find(argument => basename(argument) === "main.swift") ?? "";
      expect(stagedEntry).not.toBe("");
      if (defect === "compiler") return { status: 1 };
      writeFileSync(args[args.indexOf("-o") + 1]!, machO("x64"));
      return { status: 0 };
    });

    expect(() => buildNativeRemoteDesktop({ platform: "darwin", architecture: "arm64", output }))
      .toThrow(defect === "compiler" ? "The Remote Desktop input helper requires" : "does not match the macOS build target");
    expect(runtime.spawnSync).toHaveBeenCalledOnce();
    expect(existsSync(stagedEntry)).toBe(false);
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"))).toMatchObject({ inputHelper: null, captureHelper: null });
    expect(existsSync(join(output, "joko-macos-remote-desktop-input"))).toBe(false);
  });
});

describe("optional Remote Desktop compositor plugin build", () => {
  beforeEach(() => {
    runtime.spawnSync.mockReset();
    vi.stubGlobal("process", new Proxy(process, { get(target, property) {
      if (property === "platform") return "linux";
      if (property === "arch") return "x64";
      return Reflect.get(target, property);
    } }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each(["missing", "0.56.3"])("cleans stale plugins and packages unavailable when headers are %s", async headers => {
    const output = await directory();
    await stale(output);
    commands(headers);
    buildNativeRemoteDesktop({ platform: "linux", architecture: "x64", output });
    const record = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(record).toMatchObject({ privacyPlugin: null, privacySha256: null, privacyMetadata: null, privacyMetadataSha256: null });
    expect(() => readFileSync(join(output, "joko-hyprland-privacy.so"))).toThrow();
    expect(() => readFileSync(join(output, "joko-hyprland-privacy.json"))).toThrow();
    expect(runtime.spawnSync.mock.calls.some(([_command, args]) => String(args[0]).includes("hyprland-privacy"))).toBe(false);
  });

  it("stages the exact optional plugin and metadata after a matched native build", async () => {
    const output = await directory();
    commands("0.56.2");
    buildNativeRemoteDesktop({ platform: "linux", architecture: "x64", output });
    const record = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(record).toMatchObject({ privacyPlugin: "joko-hyprland-privacy.so", privacySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      privacyMetadata: "joko-hyprland-privacy.json", privacyMetadataSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.parse(readFileSync(join(output, "joko-hyprland-privacy.json"), "utf8"))).toEqual(metadata);
    expect(runtime.spawnSync.mock.calls.find(([_command, args]) => String(args[0]).includes("hyprland-privacy"))?.[0]).toBe(process.execPath);
  });

  it.each(["compiler", "metadata", "architecture", "shared object"])("fails matched headers on invalid %s without shipping stale plugin identity", async defect => {
    const output = await directory();
    await stale(output);
    commands("0.56.2", defect);
    expect(() => buildNativeRemoteDesktop({ platform: "linux", architecture: "x64", output })).toThrow();
    expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"))).toMatchObject({ privacyPlugin: null, privacyMetadata: null });
    expect(() => readFileSync(join(output, "joko-hyprland-privacy.so"))).toThrow();
  });
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-native-privacy-build-"));
  roots.push(root);
  return root;
}

async function stale(root: string): Promise<void> {
  for (const name of ["joko-hyprland-privacy.so", "joko-hyprland-privacy.json"]) writeFileSync(join(root, name), "old build");
}

function commands(headers: string, defect?: string): void {
  runtime.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command === "pkg-config") return { status: headers === "missing" ? 1 : 0, stdout: headers, stderr: "" };
    const source = args[0]!, output = args[1]!;
    mkdirSync(output, { recursive: true });
    const owner = basename(join(source, ".."));
    if (owner === "hyprland-privacy") {
      if (defect === "compiler") return { status: 1, stdout: "", stderr: "compiler rejected" };
      const bytes = elf(defect === "architecture" ? "arm64" : "x64");
      if (defect === "shared object") bytes.writeUInt16LE(2, 16);
      writeFileSync(join(output, "joko-hyprland-privacy.so"), bytes);
      writeFileSync(join(output, "joko-hyprland-privacy.json"), JSON.stringify({ ...metadata,
        ...(defect === "metadata" ? { hash: "1".repeat(39) } : {}) }));
    } else writeFileSync(join(output, `joko-linux-remote-desktop-${owner.slice("linux-".length)}`), elf("x64"));
    return { status: 0, stdout: "", stderr: "" };
  });
}

function elf(architecture: string): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(architecture === "arm64" ? 183 : 62, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  return bytes;
}

function machO(architecture: string): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}
