import * as filesystem from "node:fs/promises";
import * as moduleApi from "node:module";
import * as paths from "node:path";

/** Inspects the published node-pty layout without loading a target-platform addon. */
export async function auditTerminalRuntimeAssets(runtimeArgument: string, platform: string, arch: string) {
  return inspectTerminalRuntimeAssets(runtimeArgument, platform, arch, { filesystem, moduleApi, paths });
}

// Explicit native helpers keep this function self-contained when serialized into the isolated probe.
async function inspectTerminalRuntimeAssets(runtimeArgument: string, platform: string, arch: string, dependencies: {
  readonly filesystem: typeof filesystem;
  readonly moduleApi: typeof moduleApi;
  readonly paths: typeof paths;
}) {
  const { lstat, readFile, realpath } = dependencies.filesystem;
  const { createRequire } = dependencies.moduleApi;
  const { dirname, isAbsolute, relative, resolve, sep } = dependencies.paths;
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`node-pty does not support the Desktop target ${platform}-${arch}.`);
  }
  if (!isAbsolute(runtimeArgument) || resolve(runtimeArgument) !== runtimeArgument) {
    throw new Error("Terminal runtime audit requires one normalized absolute runtime root.");
  }
  const runtimeRoot = await realpath(runtimeArgument);
  if (!samePath(runtimeRoot, runtimeArgument)) throw new Error("The terminal runtime root is not canonical.");
  const manifestPath = await regularFile(runtimeRoot, resolve(runtimeRoot, "node_modules/node-pty/package.json"));
  const packageRoot = dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string; version?: string; main?: string };
  if (manifest.name !== "node-pty" || manifest.version !== "1.1.0" || manifest.main !== "./lib/index.js") {
    throw new Error("The terminal runtime requires the audited node-pty 1.1.0 package.");
  }
  const runtimeManifest = await regularFile(runtimeRoot, resolve(runtimeRoot, "package.json"));
  const runtimeRequire = createRequire(runtimeManifest);
  const moduleEntry = await regularFile(packageRoot, runtimeRequire.resolve("node-pty"));
  if (!samePath(moduleEntry, resolve(packageRoot, manifest.main))) throw new Error("node-pty resolved an unexpected entry.");
  const providerRoot = resolve(runtimeRoot, "node_modules/@joko/tool-terminal");
  const providerManifestFile = await regularFile(providerRoot, resolve(providerRoot, "package.json"));
  const providerManifest = JSON.parse(await readFile(providerManifestFile, "utf8")) as { name?: string; exports?: Record<string, unknown> };
  if (providerManifest.name !== "@joko/tool-terminal" || providerManifest.exports?.["."] !== "./dist/index.js") {
    throw new Error("The terminal runtime requires the built tool-terminal package entry.");
  }
  const providerEntry = await regularFile(providerRoot, runtimeRequire.resolve("@joko/tool-terminal"));
  const terminalHost = await regularFile(providerRoot, resolve(providerRoot, "dist/terminal-host.mjs"));
  await regularFile(providerRoot, resolve(providerRoot, "dist/host-pty.js"));
  const dependencyEntries: Record<string, string> = {};
  for (const [name, version] of [["@xterm/headless", "6.0.0"], ["@xterm/addon-serialize", "0.14.0"]] as const) {
    const root = resolve(runtimeRoot, "node_modules", name);
    const manifestFile = await regularFile(root, resolve(root, "package.json"));
    const dependency = JSON.parse(await readFile(manifestFile, "utf8")) as { name?: string; version?: string; main?: string };
    if (dependency.name !== name || dependency.version !== version || typeof dependency.main !== "string") {
      throw new Error(`The terminal runtime requires the audited ${name} ${version} package.`);
    }
    const entry = await regularFile(root, runtimeRequire.resolve(name));
    if (!samePath(entry, resolve(root, dependency.main))) throw new Error(`The ${name} runtime resolved an unexpected entry.`);
    dependencyEntries[name] = entry;
  }
  const addonName = platform === "win32" ? "conpty.node" : "pty.node";
  // These are node-pty 1.1.0's current native build/prebuild locations, in loader order.
  const directories = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
  let nativeDirectory: string | undefined;
  for (const directory of directories) {
    const candidate = resolve(packageRoot, directory);
    const info = await lstat(resolve(candidate, addonName)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info !== undefined) { nativeDirectory = candidate; break; }
  }
  if (nativeDirectory === undefined) throw new Error(`The terminal runtime is missing ${platform}-${arch} ${addonName}.`);
  const assets = platform === "win32"
    ? ["conpty.node", "conpty_console_list.node", "pty.node", "winpty-agent.exe", "winpty.dll", "conpty/conpty.dll", "conpty/OpenConsole.exe"]
    : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"];
  const nativeAssets: string[] = [];
  for (const asset of assets) {
    const path = await regularFile(packageRoot, resolve(nativeDirectory, asset));
    if (asset.endsWith(".node")) {
      const binary = await readFile(path);
      let matches = false;
      if (platform === "win32" && binary.length >= 64 && binary.toString("ascii", 0, 2) === "MZ") {
        const peOffset = binary.readUInt32LE(60);
        matches = peOffset + 6 <= binary.length && binary.readUInt32LE(peOffset) === 0x00004550 &&
          binary.readUInt16LE(peOffset + 4) === (arch === "x64" ? 0x8664 : 0xaa64);
      } else if (platform === "darwin" && binary.length >= 8 && binary.readUInt32LE(0) === 0xfeedfacf) {
        matches = binary.readUInt32LE(4) === (arch === "x64" ? 0x01000007 : 0x0100000c);
      } else if (platform === "linux" && binary.length >= 20 && binary.readUInt32BE(0) === 0x7f454c46 && binary[4] === 2 && binary[5] === 1) {
        matches = binary.readUInt16LE(18) === (arch === "x64" ? 62 : 183);
      }
      if (!matches) throw new Error(`The node-pty ${asset} does not contain the requested ${platform}-${arch} native binary.`);
    }
    if (platform === "darwin" && asset === "spawn-helper" && ((await lstat(path)).mode & 0o111) === 0) {
      throw new Error("The terminal spawn-helper is not executable.");
    }
    nativeAssets.push(path);
  }
  return { runtimeRoot, packageRoot, providerEntry, terminalHost, moduleEntry, dependencyEntries, nativeDirectory, nativeAssets, nativeBinary: resolve(nativeDirectory, addonName), version: manifest.version };

  function samePath(left: string, right: string) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }
  async function regularFile(root: string, path: string) {
    const lexical = relative(root, path);
    if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error("A terminal runtime asset escapes its package.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A terminal runtime asset is not a regular file.");
    const canonical = await realpath(path);
    if (!samePath(canonical, path)) throw new Error("A terminal runtime asset is not canonical.");
    return canonical;
  }
}

/** Runs the actual native PTY with the same Electron-Node executable as the managed service. */
export function terminalElectronSmokeSource(platform: string, arch: string): string {
  const readyCommand = platform === "win32"
    ? "mode.com con >nul && echo JOKO_PTY_READY\r"
    : "test -t 0 && test -t 1 && printf '\\nJOKO_PTY_READY\\n'\n";
  const completeCommand = platform === "win32"
    ? "mode.com con & echo JOKO_PTY_COMPLETE:joko-pty-input & exit 0\r"
    : "stty size; printf '\\nJOKO_PTY_COMPLETE:joko-pty-input\\n'; exit 0\n";
  return `
import * as filesystem from "node:fs/promises";
import * as moduleApi from "node:module";
import * as paths from "node:path";
import { pathToFileURL } from "node:url";
const expected = ${JSON.stringify({ platform, arch })};
const inspectTerminalRuntimeAssets = ${inspectTerminalRuntimeAssets.toString()};
if (!process.versions.electron || process.platform !== expected.platform || process.arch !== expected.arch) {
  throw new Error("The terminal native smoke requires the matching Electron-Node target.");
}
const inspected = await inspectTerminalRuntimeAssets(process.argv[2], expected.platform, expected.arch, { filesystem, moduleApi, paths });
const { TerminalProvider } = await import(pathToFileURL(inspected.providerEntry).href);
if (process.platform === "win32" && !process.env.SystemRoot) throw new Error("The Windows terminal smoke requires SystemRoot.");
const shell = {
  id: "runtime-smoke", label: "Runtime smoke shell", isDefault: true,
  executable: process.platform === "win32" ? paths.resolve(process.env.SystemRoot, "System32/cmd.exe") : "/bin/sh",
  args: process.platform === "win32" ? ["/d", "/q"] : []
};
const provider = new TerminalProvider({
  shells: async () => [shell],
  environment: { ...process.env, PATH: process.platform === "win32" ? paths.resolve(process.env.SystemRoot, "System32") : "/usr/bin:/bin" }
});
const scope = { sessionId: "runtime-smoke-session", targetId: "runtime-smoke-target", workspaceRoot: inspected.runtimeRoot };
const palette = { ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111), foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };
const reference = (terminal) => ({ ...scope, id: terminal.id, generation: terminal.generation });
try {
  const terminal = await provider.create({ ...scope, initialPalette: palette, id: "runtime-smoke", shellId: shell.id, cols: 80, rows: 24 });
  const current = reference(terminal);
  const stream = provider.stream({ ...current, appearance: { viewId: "runtime-smoke-view", viewRevision: 1, palette } });
  await stream.next();
  await stream.return();
  await provider.input({ ...current, data: ${JSON.stringify(readyCommand)} });
  await waitForSnapshot(current, (snapshot) => snapshot.serialized.includes("\\nJOKO_PTY_READY"));
  await provider.resize({ ...current, cols: 91, rows: 31 });
  await provider.input({ ...current, data: ${JSON.stringify(completeCommand)} });
  const completed = await waitForSnapshot(current, (snapshot) => snapshot.terminal.status === "exited");
  if (completed.terminal.exitCode !== 0 || !completed.serialized.includes("\\nJOKO_PTY_COMPLETE:joko-pty-input")) {
    throw new Error("The terminal host failed its TTY/input/exit handshake.");
  }
  if (process.platform === "win32") {
    const sizes = [...completed.serialized.matchAll(/[:：]\\s+(\\d+)\\s*$/gmu)].map((match) => Number(match[1]));
    if (sizes[0] !== 31 || sizes[1] !== 91) throw new Error("The terminal host did not report the requested console size.");
  } else if (!completed.serialized.includes("31 91")) {
    throw new Error("The terminal host did not report the requested PTY size.");
  }
  await provider.close(current);
  const running = await provider.create({ ...scope, initialPalette: palette, id: "runtime-close-smoke", shellId: shell.id });
  await provider.close(reference(running));
  if (provider.hasActiveTerminals()) throw new Error("The terminal provider retained an active host after close.");
} finally {
  await provider.dispose();
}
process.stdout.write(JSON.stringify({ ok: true, ...inspected, electronVersion: process.versions.electron,
  nodeVersion: process.versions.node, modulesVersion: process.versions.modules, tty: true, input: true, resized: true, exitCode: 0, hostCleanup: true }));

async function waitForSnapshot(current, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const snapshot = await provider.snapshot(current);
    if (predicate(snapshot)) return snapshot;
    if (snapshot.terminal.status === "failed") throw new Error("The terminal host failed during the native smoke.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The terminal host native smoke timed out.");
}
`;
}
