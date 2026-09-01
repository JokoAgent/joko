import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "native", "voice-shortcut");
const outputRoot = join(desktopRoot, "dist", "native-voice-shortcut");
const macOutput = join(outputRoot, "joko-macos-key-listener");
const windowsOutput = join(outputRoot, "joko-windows-function-key-listener.exe");

mkdirSync(outputRoot, { recursive: true });
for (const output of [macOutput, windowsOutput]) {
  if (existsSync(output)) rmSync(output);
}

let helper = null;
if (process.platform === "darwin") {
  run("xcrun", [
    "swiftc",
    join(sourceRoot, "macos-key-listener.swift"),
    "-O",
    "-o",
    macOutput
  ]);
  helper = "joko-macos-key-listener";
} else if (process.platform === "win32") {
  const compiler = resolveWindowsCompiler();
  const temporaryOutput = join(outputRoot, "joko-windows-function-key-listener.build.exe");
  if (existsSync(temporaryOutput)) rmSync(temporaryOutput);
  run(compiler, [
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/platform:anycpu",
    `/out:${temporaryOutput}`,
    join(sourceRoot, "windows-function-key-listener.cs")
  ]);
  copyFileSync(temporaryOutput, windowsOutput);
  rmSync(temporaryOutput);
  helper = "joko-windows-function-key-listener.exe";
}

writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
  architecture: process.arch,
  helper,
  platform: process.platform,
  protocolVersion: 1
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

function resolveWindowsCompiler() {
  const windowsRoot = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  const compiler = candidates.find((candidate) => existsSync(candidate));
  if (compiler === undefined) {
    throw new Error("A .NET Framework C# compiler is required to build the Windows voice shortcut helper.");
  }
  return compiler;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "native build failed").trim();
    throw new Error(detail);
  }
}
