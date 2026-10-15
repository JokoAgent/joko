import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DevelopmentProcessInput } from "@joko/personal-development";
import { createPersonalDevelopmentDoctorPrerequisites } from "./personal-development-doctor-environment.js";

describe("personal-development native prerequisites", () => {
  it("requires an actual compiler, build engine and SDK and sends only a fixed sanitized probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-doctor-native-"));
    try {
      const installation = join(root, "VS"), programFiles = join(root, "Program Files"), sdk = join(programFiles, "Windows Kits", "10"), version = "10.0.1.0";
      const files = [join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
        join(installation, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt"),
        join(installation, "VC", "Tools", "MSVC", "14.1.2", "bin", "Hostx64", "x64", "cl.exe"), join(installation, "MSBuild", "Current", "Bin", "MSBuild.exe"),
        join(sdk, "Include", version, "um", "Windows.h"), join(sdk, "Include", version, "ucrt", "stdio.h"),
        join(sdk, "Lib", version, "um", "x64", "kernel32.lib"), join(sdk, "Lib", version, "ucrt", "x64", "ucrt.lib")];
      const cargo = join(root, "source", ".runtime", "rust-toolchain", "bin", "cargo.exe"), rustc = join(dirname(cargo), "rustc.exe");
      await mkdir(dirname(cargo), { recursive: true }); await writeFile(cargo, "fixture"); await writeFile(rustc, "fixture");
      for (const file of files) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, file.endsWith(".txt") ? "14.1.2\n" : "fixture"); }
      let vsOutput = `${installation}\n`;
      const run = vi.fn(async (input: DevelopmentProcessInput) => {
        expect(input.args).toEqual(basename(input.executable) === "vswhere.exe"
          ? ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"] : ["--version"]);
        expect(input.environment).not.toHaveProperty("MODEL_API_TOKEN"); expect(input.maxOutputBytes).toBe(16_384);
        return { stdout: basename(input.executable) === "vswhere.exe" ? vsOutput : basename(input.executable) === "cargo.exe" ? "cargo 1.90.0 (fixture)" : "rustc 1.90.0 (fixture)", exitCode: 0 };
      });
      const checks = createPersonalDevelopmentDoctorPrerequisites({ directory: root, process: { run }, platform: "win32", arch: "x64",
        environment: { "ProgramFiles(x86)": programFiles, MODEL_API_TOKEN: "fixture-private" } });
      expect(checks.platform().status).toBe("ready");
      expect(await checks.native(new AbortController().signal)).toEqual({ id: "native", status: "ready", reason: "nativeWindows" });
      vsOutput = "\n";
      expect(await checks.native(new AbortController().signal)).toEqual({ id: "native", status: "missing", reason: "nativeWindows" });
      vsOutput = `${installation}\n`; await rm(rustc);
      expect(await checks.native(new AbortController().signal)).toEqual({ id: "native", status: "missing", reason: "nativeRust" });
      await rm(files.at(-1)!);
      expect(await checks.native(new AbortController().signal)).toEqual({ id: "native", status: "missing", reason: "nativeWindowsRust" });
      expect(await checks.storage(new AbortController().signal)).toMatchObject({ id: "storage", freeGiB: expect.any(Number) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
