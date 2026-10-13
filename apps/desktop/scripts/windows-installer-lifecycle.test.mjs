import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = await readFile(new URL("../resources/installer.nsh", import.meta.url), "utf8");
const lifecycle = installer.slice(installer.indexOf("!macro customUnInit"), installer.indexOf("!macroend", installer.indexOf("!macro customUnInit")) + "!macroend".length);
const compiler = findCompiler();
const nsisPlugins = findCached("nsis-resources-3.4.1", "plugins", "x86-unicode");

test("the complete assisted directory and uninstall hooks compile with the pinned builder's NSIS includes", {
  skip: process.platform !== "win32" || compiler === undefined || nsisPlugins === undefined
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-nsis-hooks-"));
  try {
    const source = join(directory, "hooks.nsi");
    const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
    const includes = join(dirname(builder.resolve("app-builder-lib/package.json")), "templates", "nsis", "include");
    const production = new URL("../resources/installer.nsh", import.meta.url);
    await writeFile(source, ["Unicode true", `!addincludedir ${quote(includes)}`, `!addplugindir /x86-unicode ${quote(nsisPlugins)}`,
      "!include LogicLib.nsh", "!include MUI2.nsh", '!define APP_FILENAME "Joko"', '!define APP_EXECUTABLE_FILENAME "Joko.exe"',
      '!define PRODUCT_FILENAME "Joko"', "Var installMode", "Var hasPerUserInstallation", "Var hasPerMachineInstallation",
      "Var HarnessUpdated", "!define isUpdated '$HarnessUpdated == 1'", "RequestExecutionLevel user", "SetCompress off",
      `OutFile ${quote(join(directory, "hooks.exe"))}`, `!include ${quote(fileURLToPath(production))}`,
      "!insertmacro customPageAfterChangeDir", "!insertmacro MUI_PAGE_INSTFILES", '!insertmacro MUI_LANGUAGE "English"',
      "!insertmacro customHeader", "Function .onInit", "!insertmacro customInit", "FunctionEnd", 'Section "compile only"',
      "SectionEnd", "Function un.onInit", "!insertmacro customUnInit", "FunctionEnd", 'Section "Uninstall"', "SectionEnd"
    ].join("\n"));
    const result = spawnSync(compiler, ["/V2", source], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Run only the production macro's NSIS branches. A stack-only stub replaces
// nsExec; no executable, UAC, service, install or uninstall action is performed.
for (const [name, first, second, present, count, continues] of [
  ["direct removal succeeds", 0, 5, true, 1, true],
  ["elevated retry succeeds", 5, 0, true, 2, true],
  ["both removal attempts fail", 5, 5, true, 2, false],
  ["ordinary install has no service image", 5, 5, false, 0, true]
]) {
  test(`NSIS service lifecycle: ${name}`, { skip: process.platform !== "win32" || compiler === undefined }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-nsis-retirement-"));
    try {
      const location = join(directory, "application"), source = join(directory, "lifecycle.nsi");
      const executable = join(directory, "lifecycle.exe"), calls = join(directory, "calls.txt");
      const continuation = join(directory, "continued.txt");
      if (present) {
        const native = join(location, "resources", "native-remote-desktop");
        await mkdir(native, { recursive: true });
        await writeFile(join(native, "joko-windows-remote-desktop-host.exe"), "never executed");
      }
      const macro = lifecycle.replaceAll("nsExec::ExecToStack", "!insertmacro HarnessExec");
      await writeFile(source, [
        "Unicode true", "!include LogicLib.nsh", "RequestExecutionLevel user", "SilentInstall silent",
        "AutoCloseWindow true", "SetCompress off", `OutFile ${quote(executable)}`,
        "Var HarnessCalls", "Var HarnessLog", "!macro HarnessExec COMMAND",
        "  IntOp $HarnessCalls $HarnessCalls + 1", '  FileWrite $HarnessLog "exec$\\r$\\n"',
        '  Push ""', "  ${If} $HarnessCalls == 1", `    Push ${first}`, "  ${Else}", `    Push ${second}`,
        "  ${EndIf}", "!macroend", macro, "Function .onInit", `  StrCpy $INSTDIR ${quote(location)}`,
        "  StrCpy $HarnessCalls 0", `  FileOpen $HarnessLog ${quote(calls)} w`,
        "  !insertmacro customUnInit", "  FileClose $HarnessLog", "FunctionEnd", 'Section "flow"',
        `  FileOpen $0 ${quote(continuation)} w`, '  FileWrite $0 "continued"', "  FileClose $0", "SectionEnd"
      ].join("\n"));
      const compiled = spawnSync(compiler, ["/V2", source], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      const result = spawnSync(executable, ["/S"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, continues ? 0 : 5, result.stdout + result.stderr);
      assert.equal(existsSync(continuation), continues);
      assert.equal((await readFile(calls, "utf8")).split(/\r?\n/u).filter(Boolean).length, count);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

function quote(value) { return `"${value.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`; }
function findCompiler() {
  if (process.env.JOKO_NSIS_EXECUTABLE !== undefined) return process.env.JOKO_NSIS_EXECUTABLE;
  return findCached("nsis-3.0.4.1", "Bin", "makensis.exe");
}
function findCached(version, ...relative) {
  if (process.env.LOCALAPPDATA === undefined) return undefined;
  const cache = join(process.env.LOCALAPPDATA, "electron-builder", "Cache", version);
  if (!existsSync(cache)) return undefined;
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${version}-`)) continue;
    const candidate = join(cache, entry.name, ...relative);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
