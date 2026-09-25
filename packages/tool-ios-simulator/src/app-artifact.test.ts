import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SimulatorCommandRunner } from "./environment.js";
import { inspectSimulatorAppArtifact } from "./app-artifact.js";

it("checks a managed app identity and executable architecture before publishing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-app-inspect-"));
  const appPath = join(root, "Example.app");
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  try {
    await mkdir(appPath);
    await writeFile(join(appPath, "Info.plist"), "fixture");
    await writeFile(join(appPath, "Example"), "fixture");
    const runner: SimulatorCommandRunner = { async run(command, args) {
      commands.push({ command, args });
      return { stdout: command === "/usr/bin/lipo" ? "x86_64 arm64" :
        args[1] === "CFBundleIdentifier" ? "app.joko.example" :
          args[1] === "CFBundleSupportedPlatforms" ? '["iPhoneSimulator"]' : "Example",
        stderr: "", exitCode: 0 };
    } };
    expect(await inspectSimulatorAppArtifact({ appPath, authorizedRoot: root,
      expectedArch: "arm64", runner })).toMatchObject({ appPath, bundleId: "app.joko.example",
      executable: "Example" });
    expect(commands.map(item => item.command)).toEqual(["/usr/bin/plutil", "/usr/bin/plutil",
      "/usr/bin/plutil", "/usr/bin/lipo"]);
    await expect(inspectSimulatorAppArtifact({ appPath, authorizedRoot: root,
      expectedArch: "arm64", runner: { async run(command, args) {
        const value = command === "/usr/bin/lipo" ? "x86_64" :
          args[1] === "CFBundleIdentifier" ? "app.joko.example" :
            args[1] === "CFBundleSupportedPlatforms" ? '["iPhoneSimulator"]' : "Example";
        return { stdout: value, stderr: "", exitCode: 0 };
      } } })).rejects.toMatchObject({ code: "APP_ARCH_MISMATCH" });
    await expect(inspectSimulatorAppArtifact({ appPath, authorizedRoot: root,
      expectedArch: "arm64", runner: { async run(command, args) {
        const value = command === "/usr/bin/lipo" ? "arm64" :
          args[1] === "CFBundleIdentifier" ? "app.joko.example" :
            args[1] === "CFBundleSupportedPlatforms" ? '["MacOSX"]' : "Example";
        return { stdout: value, stderr: "", exitCode: 0 };
      } } })).rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects app bundles outside the authorized root", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-app-authority-"));
  const foreign = await mkdtemp(join(tmpdir(), "joko-app-foreign-"));
  try {
    const appPath = join(foreign, "Foreign.app");
    await mkdir(appPath);
    await expect(inspectSimulatorAppArtifact({ appPath, authorizedRoot: root,
      expectedArch: "x86_64" })).rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});
