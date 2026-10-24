import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

const { createSealHook } = createRequire(import.meta.url)("./seal-windows-native-remote-desktop.cjs");
const { auditNativeRemoteDesktop } = createRequire(import.meta.url)("./audit-packaged.cjs");
const { restoreWindowsNativeRemoteDesktop } = createRequire(import.meta.url)("./seal-windows-native-hardware.cjs");
const names = ["joko-windows-remote-desktop-input.exe", "joko-windows-remote-desktop-host.exe", "joko-windows-remote-desktop-host.node"];

test("extraResource signatures are restored from audited build inputs before afterPack audit and final signing", async () => {
  const fixture = await create("x64");
  try {
    const source = join(fixture.directory, "build");
    await cp(fixture.root, source, { recursive: true });
    for (const name of names.slice(0, 2)) {
      const path = join(fixture.root, name), bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from("extraResource-signature")]));
    }
    await assert.rejects(auditNativeRemoteDesktop(fixture.root, "win32", "x64"));
    const context = { electronPlatformName: "win32", arch: 1, appOutDir: fixture.directory, packager: { signIf: async path => {
      assert.deepEqual(await readFile(path), await readFile(join(source, basename(path))));
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("configured-final-signature")]));
    } } };
    await restoreWindowsNativeRemoteDesktop(context, auditNativeRemoteDesktop, source);
    await auditNativeRemoteDesktop(fixture.root, "win32", "x64");
    await createSealHook()(context);
    await auditNativeRemoteDesktop(fixture.root, "win32", "x64");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("configured Windows signing updates final executable receipts and reaudits the complete package", async () => {
  const fixture = await create("x64");
  try {
    const calls = [];
    const audits = [];
    const seal = createSealHook(async (...args) => { audits.push(args); await auditNativeRemoteDesktop(...args); });
    await seal({ electronPlatformName: "win32", arch: 1, appOutDir: fixture.directory, packager: {
      signIf: async path => {
        calls.push(basename(path));
        const bytes = await readFile(path);
        await writeFile(path, Buffer.concat([bytes, Buffer.from("configured-signature")]));
        return true;
      }
    } });
    assert.deepEqual(calls, names.slice(0, 2));
    assert.deepEqual(audits, [[fixture.root, "win32", "x64"], [fixture.root, "win32", "x64"]]);
    const manifest = JSON.parse(await readFile(fixture.manifest, "utf8"));
    assert.notEqual(manifest.inputSha256, fixture.original);
    assert.equal(manifest.inputSha256, digest(await readFile(join(fixture.root, names[0]))));
    assert.equal(manifest.windowsHostServiceSha256, digest(await readFile(join(fixture.root, names[1]))));
    assert.equal(manifest.windowsHostAddonSha256, digest(await readFile(join(fixture.root, names[2]))));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("an explicitly unsigned development artifact retains correct arm64 package receipts", async () => {
  const fixture = await create("arm64");
  try {
    await createSealHook()({ electronPlatformName: "win32", arch: 3, appOutDir: fixture.directory,
      packager: { signIf: async () => false } });
    await auditNativeRemoteDesktop(fixture.root, "win32", "arm64");
    const manifest = JSON.parse(await readFile(fixture.manifest, "utf8"));
    assert.equal(manifest.windowsHostServiceSha256, fixture.original);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a configured signer failure cannot refresh receipts or report a sealed package", async () => {
  const fixture = await create("x64");
  try {
    const before = await readFile(fixture.manifest);
    const signed = [];
    await assert.rejects(createSealHook()({ electronPlatformName: "win32", arch: 1, appOutDir: fixture.directory,
      packager: { signIf: async path => { signed.push(path); throw new Error("configured signing failed"); } } }),
    /configured signing failed/u);
    assert.equal(signed.length, 1);
    assert.deepEqual(await readFile(fixture.manifest), before);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a missing or altered host addon blocks signing before any executable mutation", async () => {
  for (const defect of ["missing", "altered", "unexpected"]) {
    const fixture = await create("x64");
    try {
      if (defect === "missing") await rm(join(fixture.root, names[2]));
      if (defect === "altered") await writeFile(join(fixture.root, names[2]), pe("arm64", true));
      if (defect === "unexpected") await writeFile(join(fixture.root, "stale.dll"), pe("x64", true));
      let signed = false;
      await assert.rejects(createSealHook()({ electronPlatformName: "win32", arch: 1, appOutDir: fixture.directory,
        packager: { signIf: async () => { signed = true; } } }));
      assert.equal(signed, false);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});

test("the Windows seal does not claim another platform or an unsupported architecture", async () => {
  await createSealHook()({ electronPlatformName: "linux" });
  await assert.rejects(createSealHook()({ electronPlatformName: "win32", arch: 0 }), /exact package owner/u);
});

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pe(architecture, addon = false) {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68); bytes.writeUInt16LE(addon ? 0x2002 : 2, 86);
  return bytes;
}
async function create(architecture) {
  const directory = await mkdtemp(join(tmpdir(), "joko-windows-native-seal-"));
  const root = join(directory, "resources", "native-remote-desktop"), manifest = join(root, "manifest.json");
  await mkdir(root, { recursive: true });
  const executable = pe(architecture), addon = pe(architecture, true), original = digest(executable);
  for (const name of names) await writeFile(join(root, name), name.endsWith(".node") ? addon : executable);
  await writeFile(manifest, JSON.stringify({ protocolVersion: 1, platform: "win32", architecture,
    inputHelper: names[0], inputSha256: original, captureHelper: null, captureSha256: null,
    credentialHelper: null, credentialSha256: null, credentialBundle: null, credentialBundleSha256: null,
    clipboardHelper: null, clipboardSha256: null, viewerDisplayScript: null, viewerDisplaySha256: null,
    viewerDisplayInterpreter: null, privacyPlugin: null, privacySha256: null, privacyMetadata: null,
    privacyMetadataSha256: null, linuxCredentialDirectory: null, linuxCredentialInterpreter: null,
    linuxCredentialFiles: null, windowsHostService: names[1], windowsHostServiceSha256: original,
    windowsHostAddon: names[2], windowsHostAddonSha256: digest(addon), windowsHostNodeApiVersion: 6 }));
  return { directory, root, manifest, original };
}
