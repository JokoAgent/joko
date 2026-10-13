import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPackagedDesktopRemoteDesktopBinary, verifyPackagedDesktopRemoteDesktopLinuxCredentials,
  verifyPackagedDesktopRemoteDesktopPrivacy, verifyPackagedDesktopRemoteDesktopWindowsHost } from
  "../src/remote-desktop-native-manifest.js";

const roots: string[] = [];
const { auditNativeRemoteDesktop } = createRequire(import.meta.url)("../scripts/audit-packaged.cjs") as {
  auditNativeRemoteDesktop(root: string, platform: string, architecture: string): Promise<void>;
};

describe("packaged Remote Desktop native manifest", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each(["x64", "arm64"])("accepts the exact Linux %s helper set through runtime and package audit", async (architecture) => {
    const root = await directory();
    const input = "joko-linux-remote-desktop-input", capture = "joko-linux-remote-desktop-capture";
    const bytes = elf(architecture);
    await linuxPair(root, bytes, bytes, architecture);
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", input, "linux", architecture))
      .resolves.toBe(await realpath(join(root, input)));
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "capture", capture, "linux", architecture))
      .resolves.toBe(await realpath(join(root, capture)));
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "clipboard", "joko-linux-remote-desktop-clipboard", "linux", architecture))
      .resolves.toBe(await realpath(join(root, "joko-linux-remote-desktop-clipboard")));
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "viewer-display", "linux-viewer-display.py", "linux", architecture))
      .resolves.toBe(await realpath(join(root, "linux-viewer-display.py")));
    await expect(auditNativeRemoteDesktop(root, "linux", architecture)).resolves.toBeUndefined();
    await expect(verifyPackagedDesktopRemoteDesktopLinuxCredentials(root, "linux", architecture))
      .resolves.toBe(await realpath(join(root, "linux-credentials", "main.py")));
    await expect(verifyPackagedDesktopRemoteDesktopPrivacy(root, "linux", architecture))
      .rejects.toThrow("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "credentials", "joko-macos-remote-credentials", "linux", architecture))
      .rejects.toThrow("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });

  it.each(["main.py", "channel.py", "host.py", "storage.py", "platform_linux.py", "requirements.txt"])(
    "rejects an unrequested tampered Linux credential sibling %s through runtime and package closure", async name => {
      const root = await directory();
      await linuxPair(root, elf("x64"), elf("x64"), "x64");
      await writeFile(join(root, "linux-credentials", name), "changed\n");
      await expect(verifyPackagedDesktopRemoteDesktopLinuxCredentials(root, "linux", "x64")).rejects.toThrow();
      await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", "x64"))
        .rejects.toThrow();
      await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
    });

  it.each(["missing sibling", "extra sibling", "nested directory", "interpreter", "directory", "digest key", "invalid digest",
    "shebang", "invalid UTF8", "NUL"])("rejects a Linux credential package with %s", async defect => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const directoryPath = join(root, "linux-credentials");
    const manifestPath = join(root, "manifest.json");
    const record = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const files = record["linuxCredentialFiles"] as Record<string, string>;
    if (defect === "missing sibling") await rm(join(directoryPath, "storage.py"));
    if (defect === "extra sibling") await writeFile(join(directoryPath, "test_credentials.py"), "pass\n");
    if (defect === "nested directory") await mkdir(join(directoryPath, "__pycache__"));
    if (defect === "interpreter") record["linuxCredentialInterpreter"] = "/usr/bin/env";
    if (defect === "directory") record["linuxCredentialDirectory"] = "../linux-credentials";
    if (defect === "digest key") delete files["storage.py"];
    if (defect === "invalid digest") files["storage.py"] = "F".repeat(64);
    if (["shebang", "invalid UTF8", "NUL"].includes(defect)) {
      const name = defect === "shebang" ? "main.py" : "host.py";
      const bytes = defect === "shebang" ? Buffer.from("#!/usr/bin/env python3\npass\n")
        : defect === "invalid UTF8" ? Buffer.from([0xff]) : Buffer.from("pass\0\n");
      await writeFile(join(directoryPath, name), bytes);
      files[name] = sha256(bytes);
    }
    await writeFile(manifestPath, JSON.stringify(record));
    await expect(verifyPackagedDesktopRemoteDesktopLinuxCredentials(root, "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it("rejects a symlinked Linux credential directory even with the complete declared files", async () => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const directoryPath = join(root, "linux-credentials");
    // Directory junctions can be created without Windows developer-mode privileges.
    const external = await directory();
    for (const name of ["main.py", "channel.py", "host.py", "storage.py", "platform_linux.py", "requirements.txt"]) {
      await writeFile(join(external, name), await readFile(join(directoryPath, name)));
    }
    await rm(directoryPath, { recursive: true });
    await symlink(external, directoryPath, "junction");
    await expect(verifyPackagedDesktopRemoteDesktopLinuxCredentials(root, "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it.each(["x64", "arm64"])("accepts the optional pinned Linux %s privacy plugin through the complete package closure", async architecture => {
    const root = await directory();
    await linuxPair(root, elf(architecture), elf(architecture), architecture);
    await privacyPair(root, elf(architecture));
    await expect(verifyPackagedDesktopRemoteDesktopPrivacy(root, "linux", architecture)).resolves.toEqual({
      path: await realpath(join(root, "joko-hyprland-privacy.so")), metadata: PRIVACY_METADATA
    });
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", architecture))
      .resolves.toBe(await realpath(join(root, "joko-linux-remote-desktop-input")));
    await expect(auditNativeRemoteDesktop(root, "linux", architecture)).resolves.toBeUndefined();
    await expect(verifyPackagedDesktopRemoteDesktopPrivacy(root, "win32", architecture)).rejects.toThrow();
  });

  it.each(["tampered plugin", "wrong target", "executable ELF", "tampered metadata", "invalid commit", "invalid source",
    "wrong version", "extra metadata", "partial identity", "missing plugin"])("rejects privacy %s while resolving any packaged helper", async defect => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const binary = elf(defect === "wrong target" ? "arm64" : "x64");
    if (defect === "executable ELF") binary.writeUInt16LE(2, 16);
    const metadata = { ...PRIVACY_METADATA,
      ...(defect === "invalid commit" ? { hash: "F".repeat(40) } : {}),
      ...(defect === "invalid source" ? { source: "1".repeat(63) } : {}),
      ...(defect === "wrong version" ? { version: "0.56.3" } : {}),
      ...(defect === "extra metadata" ? { extra: true } : {}) };
    await privacyPair(root, binary, metadata);
    if (defect === "tampered plugin") await writeFile(join(root, "joko-hyprland-privacy.so"), elf("arm64"));
    if (defect === "tampered metadata") await writeFile(join(root, "joko-hyprland-privacy.json"), JSON.stringify({ ...metadata, source: "3".repeat(64) }));
    if (defect === "missing plugin") await rm(join(root, "joko-hyprland-privacy.so"));
    if (defect === "partial identity") {
      const record = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
      delete record["privacyMetadataSha256"];
      await writeFile(join(root, "manifest.json"), JSON.stringify(record));
    }
    await expect(verifyPackagedDesktopRemoteDesktopPrivacy(root, "linux", "x64")).rejects.toThrow();
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it("rejects undeclared privacy leftovers without promoting an optional unavailable plugin", async () => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    await writeFile(join(root, "joko-hyprland-privacy.so"), elf("x64"));
    await expect(verifyPackagedDesktopRemoteDesktopPrivacy(root, "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow("unexpected files");
  });

  it.each(["wrong target", "tampered capture", "malformed ELF"])("rejects Linux %s before returning either helper", async (defect) => {
    const root = await directory(), input = elf("x64"), capture = elf("x64");
    if (defect === "wrong target") capture.writeUInt16LE(183, 18);
    if (defect === "malformed ELF") capture[4] = 1;
    await linuxPair(root, input, capture, "x64");
    if (defect === "tampered capture") await writeFile(join(root, "joko-linux-remote-desktop-capture"), elf("arm64"));
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", "x64"))
      .rejects.toThrow("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it.each(["tampered", "missing", "wrong target"])("rejects an unrequested %s Linux clipboard helper", async (defect) => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const path = join(root, "joko-linux-remote-desktop-clipboard");
    if (defect === "missing") await rm(path);
    else if (defect === "tampered") await writeFile(path, elf("arm64"));
    else {
      const bytes = elf("arm64"); await writeFile(path, bytes);
      await manifest(root, { protocolVersion: 1, platform: "linux", architecture: "x64",
        inputHelper: "joko-linux-remote-desktop-input", inputSha256: sha256(elf("x64")),
        captureHelper: "joko-linux-remote-desktop-capture", captureSha256: sha256(elf("x64")),
        clipboardHelper: "joko-linux-remote-desktop-clipboard", clipboardSha256: sha256(bytes) });
    }
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", "x64"))
      .rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it("rejects stale protocol/compiler files in the Linux package directory", async () => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    await writeFile(join(root, "wlr-screencopy-unstable-v1.c"), "compiler intermediate");
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow("unexpected files");
  });

  it.each(["tampered", "missing", "interpreter", "shebang"])("rejects an unrequested %s Linux mirror script", async defect => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const script = join(root, "linux-viewer-display.py");
    if (defect === "missing") await rm(script);
    else if (defect === "tampered") await writeFile(script, "#!/usr/bin/python3\nchanged\n");
    else if (defect === "shebang") {
      const bytes = Buffer.from("#!/usr/bin/env python3\npass\n"); await writeFile(script, bytes);
      await manifest(root, { protocolVersion: 1, platform: "linux", architecture: "x64",
        inputHelper: "joko-linux-remote-desktop-input", inputSha256: sha256(elf("x64")),
        captureHelper: "joko-linux-remote-desktop-capture", captureSha256: sha256(elf("x64")),
        clipboardHelper: "joko-linux-remote-desktop-clipboard", clipboardSha256: sha256(elf("x64")),
        viewerDisplayScript: "linux-viewer-display.py", viewerDisplaySha256: sha256(bytes), viewerDisplayInterpreter: "/usr/bin/python3" });
    } else {
      const bytes = await import("node:fs/promises").then(fs => fs.readFile(join(root, "manifest.json"), "utf8"));
      await writeFile(join(root, "manifest.json"), bytes.replace("/usr/bin/python3", "/usr/bin/python"));
    }
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-linux-remote-desktop-input", "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it("rejects cross-host or cross-architecture Linux build before modifying its output", async () => {
    const moduleUrl = new URL("../scripts/build-native-remote-desktop.mjs", import.meta.url).href;
    const { buildNativeRemoteDesktop, assertLinuxRemoteDesktopElf } = await import(moduleUrl) as {
      buildNativeRemoteDesktop(options: { platform: string; architecture: string; output: string }): void;
      assertLinuxRemoteDesktopElf(bytes: Buffer, architecture: string): void;
    };
    const root = await directory();
    await writeFile(join(root, "manifest.json"), "unchanged");
    expect(() => buildNativeRemoteDesktop({ platform: "linux", architecture: process.arch === "x64" ? "arm64" : "x64", output: root }))
      .toThrow(process.platform === "linux" ? "target architecture" : "target operating system");
    expect(() => assertLinuxRemoteDesktopElf(elf("arm64"), "x64")).toThrow("Linux build target");
    expect(() => assertLinuxRemoteDesktopElf(elf("x64"), "x64")).not.toThrow();
  });

  it.each(["x64", "arm64"])("accepts the exact Windows %s service, Node-API addon and input closure", async architecture => {
    const root = await directory();
    const helper = "joko-windows-remote-desktop-input.exe";
    await windowsPair(root, architecture);
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", helper, "win32", architecture))
      .resolves.toBe(await realpath(join(root, helper)));
    await expect(verifyPackagedDesktopRemoteDesktopWindowsHost(root, "win32", architecture)).resolves.toEqual({
      service: await realpath(join(root, "joko-windows-remote-desktop-host.exe")),
      addon: await realpath(join(root, "joko-windows-remote-desktop-host.node"))
    });
    await expect(auditNativeRemoteDesktop(root, "win32", architecture)).resolves.toBeUndefined();
    await expect(verifyPackagedDesktopRemoteDesktopWindowsHost(root, "linux", architecture)).rejects.toThrow();
  });

  it("checks Windows target architecture and executable versus addon roles before native staging", async () => {
    const moduleUrl = new URL("../scripts/build-native-remote-desktop.mjs", import.meta.url).href;
    const { assertWindowsHostArtifact } = await import(moduleUrl) as {
      assertWindowsHostArtifact(bytes: Buffer, architecture: string, addon: boolean): void;
    };
    for (const architecture of ["x64", "arm64"]) {
      expect(() => assertWindowsHostArtifact(pe(architecture), architecture, false)).not.toThrow();
      expect(() => assertWindowsHostArtifact(pe(architecture, true), architecture, true)).not.toThrow();
      expect(() => assertWindowsHostArtifact(pe(architecture, true), architecture, false)).toThrow("role");
      expect(() => assertWindowsHostArtifact(pe(architecture), architecture, true)).toThrow("role");
    }
    expect(() => assertWindowsHostArtifact(pe("arm64"), "x64", false)).toThrow("Windows build target");
  });

  it.each(["missing service", "missing addon", "tampered service", "tampered addon", "wrong service target",
    "wrong addon target", "DLL service", "EXE addon", "Node-API", "partial identity", "unexpected sibling",
    "uppercase digest"])("rejects Windows %s while resolving either host or input", async defect => {
    const root = await directory();
    await windowsPair(root, "x64");
    const path = join(root, "manifest.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const service = "joko-windows-remote-desktop-host.exe", addon = "joko-windows-remote-desktop-host.node";
    if (defect === "missing service") await rm(join(root, service));
    if (defect === "missing addon") await rm(join(root, addon));
    if (defect === "tampered service") await writeFile(join(root, service), pe("arm64"));
    if (defect === "tampered addon") await writeFile(join(root, addon), pe("arm64", true));
    if (["wrong service target", "wrong addon target", "DLL service", "EXE addon"].includes(defect)) {
      const isAddon = defect.includes("addon");
      const bytes = pe(defect.startsWith("wrong") ? "arm64" : "x64", defect === "DLL service" || defect === "wrong addon target");
      await writeFile(join(root, isAddon ? addon : service), bytes);
      record[isAddon ? "windowsHostAddonSha256" : "windowsHostServiceSha256"] = sha256(bytes);
    }
    if (defect === "Node-API") record["windowsHostNodeApiVersion"] = 10;
    if (defect === "partial identity") delete record["windowsHostAddonSha256"];
    if (defect === "uppercase digest") record["windowsHostServiceSha256"] = "F".repeat(64);
    if (defect === "unexpected sibling") await writeFile(join(root, "joko_windows_remote_desktop_host.dll"), pe("x64", true));
    await writeFile(path, JSON.stringify(record));
    await expect(verifyPackagedDesktopRemoteDesktopWindowsHost(root, "win32", "x64")).rejects.toThrow();
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-windows-remote-desktop-input.exe", "win32", "x64"))
      .rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "win32", "x64")).rejects.toThrow();
  });

  it("does not adopt a Windows host identity on another platform", async () => {
    const root = await directory();
    await linuxPair(root, elf("x64"), elf("x64"), "x64");
    const path = join(root, "manifest.json");
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record["windowsHostNodeApiVersion"] = 6;
    await writeFile(path, JSON.stringify(record));
    await expect(verifyPackagedDesktopRemoteDesktopLinuxCredentials(root, "linux", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "linux", "x64")).rejects.toThrow();
  });

  it("rejects a redirected Windows package root even when all four declared files are present", async () => {
    const root = await directory(), external = await directory();
    await windowsPair(external, "x64");
    await rm(root, { recursive: true });
    await symlink(external, root, "junction");
    await expect(verifyPackagedDesktopRemoteDesktopWindowsHost(root, "win32", "x64")).rejects.toThrow();
    await expect(auditNativeRemoteDesktop(root, "win32", "x64")).rejects.toThrow();
  });

  it("rejects a malformed unused capture identity when resolving Windows input", async () => {
    const root = await directory();
    const helper = "joko-windows-remote-desktop-input.exe";
    const bytes = Buffer.from("bounded helper");
    await writeFile(join(root, helper), bytes);
    await manifest(root, {
      protocolVersion: 1,
      platform: "win32",
      architecture: "x64",
      inputHelper: helper,
      inputSha256: sha256(bytes),
      captureHelper: "unexpected-capture",
      captureSha256: "0".repeat(64)
    });

    await expect(verifyPackagedDesktopRemoteDesktopBinary(
      root, "input", helper, "win32", "x64"
    )).rejects.toThrowError("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });

  it("accepts the exact macOS helper pair while resolving either helper", async () => {
    const root = await directory();
    const input = "joko-macos-remote-desktop-input";
    const capture = "joko-macos-remote-desktop-capture";
    const inputBytes = Buffer.from("bounded input helper");
    const captureBytes = Buffer.from("bounded capture helper");
    await Promise.all([
      writeFile(join(root, input), inputBytes),
      writeFile(join(root, capture), captureBytes)
    ]);
    await manifest(root, {
      protocolVersion: 1,
      platform: "darwin",
      architecture: "arm64",
      inputHelper: input,
      inputSha256: sha256(inputBytes),
      captureHelper: capture,
      captureSha256: sha256(captureBytes)
    });

    await expect(Promise.all([
      verifyPackagedDesktopRemoteDesktopBinary(root, "input", input, "darwin", "arm64"),
      verifyPackagedDesktopRemoteDesktopBinary(root, "capture", capture, "darwin", "arm64"),
      verifyPackagedDesktopRemoteDesktopBinary(root, "credentials", "joko-macos-remote-credentials", "darwin", "arm64")
    ])).resolves.toEqual([
      await realpath(join(root, input)),
      await realpath(join(root, capture)),
      await realpath(join(root, "joko-macos-remote-credentials"))
    ]);
  });

  it("rejects a tampered unrequested macOS capture helper while resolving input", async () => {
    const root = await directory();
    const input = "joko-macos-remote-desktop-input";
    const capture = "joko-macos-remote-desktop-capture";
    const inputBytes = Buffer.from("bounded input helper");
    const captureBytes = Buffer.from("bounded capture helper");
    await Promise.all([
      writeFile(join(root, input), inputBytes),
      writeFile(join(root, capture), captureBytes)
    ]);
    await manifest(root, {
      protocolVersion: 1,
      platform: "darwin",
      architecture: "arm64",
      inputHelper: input,
      inputSha256: sha256(inputBytes),
      captureHelper: capture,
      captureSha256: sha256(Buffer.from("expected capture helper"))
    });

    await expect(verifyPackagedDesktopRemoteDesktopBinary(
      root, "input", input, "darwin", "arm64"
    )).rejects.toThrowError("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });

  it("rejects a changed native password resource even while resolving another helper", async () => {
    const root = await directory();
    const input = "joko-macos-remote-desktop-input", capture = "joko-macos-remote-desktop-capture";
    const bytes = Buffer.from("bounded helper");
    await Promise.all([writeFile(join(root, input), bytes), writeFile(join(root, capture), bytes)]);
    await manifest(root, { protocolVersion: 1, platform: "darwin", architecture: "x64",
      inputHelper: input, inputSha256: sha256(bytes), captureHelper: capture, captureSha256: sha256(bytes) });
    await writeFile(join(root, "JokoRemoteCredentials_JokoRemoteCredentials.bundle", "credentials.json"), "changed");
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", input, "darwin", "x64"))
      .rejects.toThrow("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });

  it("rejects an incomplete manifest without adopting development data", async () => {
    const root = await directory();
    await writeFile(join(root, "manifest.json"), JSON.stringify({ protocolVersion: 1, platform: "win32",
      architecture: "x64", inputHelper: "joko-windows-remote-desktop-input.exe", inputSha256: "0".repeat(64),
      captureHelper: null, captureSha256: null }));
    await expect(verifyPackagedDesktopRemoteDesktopBinary(root, "input", "joko-windows-remote-desktop-input.exe", "win32", "x64"))
      .rejects.toThrow("REMOTE_DESKTOP_NATIVE_UNAVAILABLE");
  });
});

async function directory(): Promise<string> {
  const root = join(tmpdir(), `joko-remote-desktop-manifest-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function manifest(root: string, value: Record<string, unknown>): Promise<void> {
  let credentials: Record<string, unknown> = { credentialHelper: null, credentialSha256: null,
    credentialBundle: null, credentialBundleSha256: null };
  if (value["platform"] === "darwin") {
    const helper = "joko-macos-remote-credentials", bundle = "JokoRemoteCredentials_JokoRemoteCredentials.bundle";
    const bytes = Buffer.from("credential helper"), resource = Buffer.from('{"en":{"title":"Remote Desktop"}}');
    await mkdir(join(root, bundle));
    await Promise.all([writeFile(join(root, helper), bytes), writeFile(join(root, bundle, "credentials.json"), resource)]);
    credentials = { credentialHelper: helper, credentialSha256: sha256(bytes), credentialBundle: bundle,
      credentialBundleSha256: createHash("sha256").update("credentials.json").update("\0").update(resource).digest("hex") };
  }
  const clipboard = value["platform"] === "linux" ? {} : { clipboardHelper: null, clipboardSha256: null };
  const viewer = value["platform"] === "linux" ? { viewerDisplayScript: "linux-viewer-display.py",
    viewerDisplaySha256: sha256(Buffer.from("#!/usr/bin/python3\npass\n")), viewerDisplayInterpreter: "/usr/bin/python3" }
    : { viewerDisplayScript: null, viewerDisplaySha256: null, viewerDisplayInterpreter: null };
  const privacy = { privacyPlugin: null, privacySha256: null, privacyMetadata: null, privacyMetadataSha256: null };
  let linuxCredentials: Record<string, unknown> = {
    linuxCredentialDirectory: null, linuxCredentialInterpreter: null, linuxCredentialFiles: null
  };
  if (value["platform"] === "linux") {
    const directoryPath = join(root, "linux-credentials");
    await mkdir(directoryPath, { recursive: true });
    const files: Record<string, string> = {};
    for (const name of ["main.py", "channel.py", "host.py", "storage.py", "platform_linux.py", "requirements.txt"]) {
      const bytes = Buffer.from(name === "main.py" ? "#!/usr/bin/python3\npass\n" : name === "requirements.txt" ? "jwcrypto==1.6.1\n" : "pass\n");
      await writeFile(join(directoryPath, name), bytes);
      files[name] = sha256(bytes);
    }
    linuxCredentials = { linuxCredentialDirectory: "linux-credentials", linuxCredentialInterpreter: "/usr/bin/python3", linuxCredentialFiles: files };
  }
  const windowsHost = { windowsHostService: null, windowsHostServiceSha256: null,
    windowsHostAddon: null, windowsHostAddonSha256: null, windowsHostNodeApiVersion: null };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ ...viewer, ...privacy, ...linuxCredentials,
    ...windowsHost, ...value, ...credentials, ...clipboard })}\n`, "utf8");
}

async function windowsPair(root: string, architecture: string): Promise<void> {
  const inputHelper = "joko-windows-remote-desktop-input.exe", service = "joko-windows-remote-desktop-host.exe";
  const addon = "joko-windows-remote-desktop-host.node", executable = pe(architecture), library = pe(architecture, true);
  await Promise.all([writeFile(join(root, inputHelper), executable), writeFile(join(root, service), executable),
    writeFile(join(root, addon), library)]);
  await manifest(root, { protocolVersion: 1, platform: "win32", architecture, inputHelper, inputSha256: sha256(executable),
    captureHelper: null, captureSha256: null, windowsHostService: service, windowsHostServiceSha256: sha256(executable),
    windowsHostAddon: addon, windowsHostAddonSha256: sha256(library), windowsHostNodeApiVersion: 6 });
}

function pe(architecture: string, addon = false): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68);
  bytes.writeUInt16LE(addon ? 0x2002 : 2, 86);
  return bytes;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function elf(architecture: string): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(architecture === "x64" ? 62 : 183, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}

async function linuxPair(root: string, input: Buffer, capture: Buffer, architecture: string): Promise<void> {
  const inputHelper = "joko-linux-remote-desktop-input", captureHelper = "joko-linux-remote-desktop-capture";
  const clipboardHelper = "joko-linux-remote-desktop-clipboard", clipboard = elf(architecture);
  const viewer = Buffer.from("#!/usr/bin/python3\npass\n");
  await Promise.all([writeFile(join(root, inputHelper), input), writeFile(join(root, captureHelper), capture),
    writeFile(join(root, clipboardHelper), clipboard), writeFile(join(root, "linux-viewer-display.py"), viewer)]);
  await Promise.all([chmod(join(root, inputHelper), 0o755), chmod(join(root, captureHelper), 0o755),
    chmod(join(root, clipboardHelper), 0o755)]);
  await manifest(root, { protocolVersion: 1, platform: "linux", architecture,
    inputHelper, inputSha256: sha256(input), captureHelper, captureSha256: sha256(capture),
    clipboardHelper, clipboardSha256: sha256(clipboard), viewerDisplayScript: "linux-viewer-display.py",
    viewerDisplaySha256: sha256(viewer), viewerDisplayInterpreter: "/usr/bin/python3" });
}

const PRIVACY_METADATA = Object.freeze({ version: "0.56.2", hash: "1".repeat(40), source: "2".repeat(64) });

async function privacyPair(root: string, binary: Buffer, value: Record<string, unknown> = PRIVACY_METADATA): Promise<void> {
  const metadata = Buffer.from(JSON.stringify(value));
  const plugin = "joko-hyprland-privacy.so", name = "joko-hyprland-privacy.json";
  await Promise.all([writeFile(join(root, plugin), binary), writeFile(join(root, name), metadata)]);
  await chmod(join(root, plugin), 0o755);
  const record = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...record, privacyPlugin: plugin,
    privacySha256: sha256(binary), privacyMetadata: name, privacyMetadataSha256: sha256(metadata) }));
}
