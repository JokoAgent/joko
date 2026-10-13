import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
