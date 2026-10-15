import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { developmentEnvironment, PersonalDevelopmentError, supportedDevelopmentHost, type DevelopmentProcessAuthority } from "@joko/personal-development";
import type { DevelopmentDoctorCheck } from "./personal-development-doctor-types.js";

/** Fixed read-only compiler/SDK probes. Tool downloads remain with the package Owner. */
export function createPersonalDevelopmentDoctorPrerequisites(options: { readonly directory: string; readonly process: DevelopmentProcessAuthority;
  readonly platform?: NodeJS.Platform; readonly arch?: string; readonly environment?: Readonly<NodeJS.ProcessEnv> }) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, source = options.environment ?? process.env;
  const environment = developmentEnvironment(source);
  const accessible = async (path: string) => { try { await access(path); return true; } catch { return false; } };
  const executable = async (name: string): Promise<string | undefined> => {
    const candidates = isAbsolute(name) ? [name] : (environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":")
      .filter(isAbsolute).map(path => join(path.replace(/^"|"$/gu, ""), `${name}${platform === "win32" ? ".exe" : ""}`));
    for (const candidate of candidates) { try { const path = await realpath(candidate); if ((await stat(path)).isFile()) return path; } catch { /* Fixed PATH candidates only. */ } }
    return undefined;
  };
  const probe = async (name: string, args: readonly string[], signal: AbortSignal) => {
    const path = await executable(name); if (!path) return undefined;
    const result = await options.process.run({ executable: path, args, cwd: options.directory, environment, signal, timeoutMs: 15_000, maxOutputBytes: 16_384 });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  };
  const windowsCompiler = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const programFiles = source["ProgramFiles(x86)"] ?? source.ProgramFiles ?? source.PROGRAMFILES;
      if (!programFiles || !isAbsolute(programFiles)) return false;
      const installation = await probe(join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
        ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], signal);
      if (!installation || !isAbsolute(installation) || /[\r\n]/u.test(installation)) return false;
      const version = (await readFile(join(installation, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt"), "utf8")).trim();
      if (!/^\d+\.\d+\.\d+$/u.test(version)) return false;
      if (!await accessible(join(installation, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64", "cl.exe"))
        || !await accessible(join(installation, "MSBuild", "Current", "Bin", "MSBuild.exe"))) return false;
      const sdk = join(programFiles, "Windows Kits", "10");
      for (const name of (await readdir(join(sdk, "Include"))).filter(value => /^10\.0\.\d+\.0$/u.test(value))) {
        signal.throwIfAborted();
        if ((await Promise.all([join(sdk, "Include", name, "um", "Windows.h"), join(sdk, "Include", name, "ucrt", "stdio.h"),
          join(sdk, "Lib", name, "um", "x64", "kernel32.lib"), join(sdk, "Lib", name, "ucrt", "x64", "ucrt.lib")].map(accessible))).every(Boolean)) return true;
      }
      return false;
    } catch (error) {
      if (signal.aborted || error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN") throw error;
      return false;
    }
  };
  const windowsRust = async (signal: AbortSignal): Promise<boolean> => {
    const portable = join(options.directory, "source", ".runtime", "rust-toolchain", "bin", "cargo.exe");
    const cargo = await executable(source.JOKO_CARGO_EXECUTABLE ?? (await accessible(portable) ? portable : "cargo"));
    if (!cargo) return false;
    const rustc = await executable(join(dirname(cargo), "rustc.exe")) ?? await executable("rustc");
    return Boolean(rustc && /^cargo \d+\.\d+\.\d+/u.test(await probe(cargo, ["--version"], signal) ?? "")
      && /^rustc \d+\.\d+\.\d+/u.test(await probe(rustc, ["--version"], signal) ?? ""));
  };
  return {
    platform: (): DevelopmentDoctorCheck => ({ id: "platform", status: supportedDevelopmentHost(platform, arch)
      && !(platform === "linux" && !(process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime) ? "ready" : "unsupported", reason: "platform" }),
    native: async (signal: AbortSignal): Promise<DevelopmentDoctorCheck> => {
      const reason = platform === "win32" ? "nativeWindows" : platform === "darwin" ? "nativeMac" : "nativeLinux";
      const result = (ready: boolean): DevelopmentDoctorCheck => ({ id: "native", status: ready ? "ready" : "missing", reason });
      try {
        signal.throwIfAborted();
        if (platform === "win32") {
          const compiler = await windowsCompiler(signal), rust = await windowsRust(signal);
          return { id: "native", status: compiler && rust ? "ready" : "missing",
            reason: compiler ? rust ? "nativeWindows" : "nativeRust" : rust ? "nativeWindows" : "nativeWindowsRust" };
        }
        if (platform === "darwin") {
          if (!await probe("/usr/bin/xcode-select", ["-p"], signal)) return result(false);
          const compiler = await probe("/usr/bin/xcrun", ["--find", "clang++"], signal);
          if (!compiler || !isAbsolute(compiler) || /[\r\n]/u.test(compiler) || !await probe(compiler, ["--version"], signal)
            || !await probe("/usr/bin/xcrun", ["--show-sdk-path"], signal)) return result(false);
          return result(Boolean(await probe("make", ["--version"], signal)));
        }
        return result(platform === "linux" && Boolean(await probe("g++", ["--version"], signal)) && Boolean(await probe("make", ["--version"], signal)));
      } catch (error) {
        if (signal.aborted || error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN") throw error;
        return { id: "native", status: "failed", reason };
      }
    },
    storage: async (signal: AbortSignal): Promise<DevelopmentDoctorCheck> => {
      signal.throwIfAborted();
      try {
        await access(options.directory, constants.W_OK); const value = await statfs(options.directory); signal.throwIfAborted();
        const freeGiB = Math.floor(value.bavail * value.bsize / 1024 ** 3 * 10) / 10;
        return { id: "storage", status: freeGiB < 10 ? "warning" : "ready", reason: freeGiB < 10 ? "lowDisk" : "storage", freeGiB };
      } catch { signal.throwIfAborted(); return { id: "storage", status: "failed", reason: "storage" }; }
    }
  };
}
