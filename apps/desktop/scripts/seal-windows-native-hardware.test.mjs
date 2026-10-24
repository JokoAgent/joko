import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { sealWindowsNativeHardware } = require("./seal-windows-native-hardware.cjs");
const { auditNativeHardware } = require("./audit-packaged.cjs");
const { SIMPLE_NATIVE_ARTIFACTS, digest } = require("./native-helper-artifacts.cjs");
const helper = SIMPLE_NATIVE_ARTIFACTS.hardware.helpers.win32;

test("USB extraResources signed before afterPack are resealed from the audited build through the configured signer", async () => {
  for (const architecture of ["x64", "arm64"]) {
    const fixture = await create(architecture);
    try {
      await assert.rejects(auditNativeHardware(fixture.packaged, "win32", architecture));
      let signed = 0;
      const context = { electronPlatformName: "win32", appOutDir: fixture.directory, packager: { signIf: async path => {
        assert.equal(path, join(fixture.packaged, helper));
        assert.deepEqual(await readFile(path), fixture.bytes);
        signed++;
        await writeFile(path, Buffer.concat([fixture.bytes, Buffer.from("configured-final-signature")]));
        return true;
      } } };
      await sealWindowsNativeHardware(context, architecture, auditNativeHardware, fixture.source);
      assert.equal(signed, 1);
      await auditNativeHardware(fixture.packaged, "win32", architecture);
      const manifest = JSON.parse(await readFile(join(fixture.packaged, "manifest.json"), "utf8"));
      assert.equal(manifest.sha256, digest(await readFile(join(fixture.packaged, helper))));
      assert.notEqual(manifest.sha256, digest(fixture.bytes));
      assert.deepEqual(await readFile(join(fixture.source, helper)), fixture.bytes);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});

test("unsigned development packaging still seals the exact audited USB bytes", async () => {
  const fixture = await create("x64");
  try {
    await sealWindowsNativeHardware({ electronPlatformName: "win32", appOutDir: fixture.directory,
      packager: { signIf: async () => false } }, "x64", auditNativeHardware, fixture.source);
    await auditNativeHardware(fixture.packaged, "win32", "x64");
    assert.deepEqual(await readFile(join(fixture.packaged, helper)), fixture.bytes);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("source mutations and signer failures cannot turn arbitrary bytes into a new USB receipt", async () => {
  for (const defect of ["source", "manifest", "signer"]) {
    const fixture = await create("x64");
    try {
      if (defect === "source") await writeFile(join(fixture.source, helper), Buffer.from("untrusted build bytes"));
      if (defect === "manifest") {
        const path = join(fixture.packaged, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.sha256 = "0".repeat(64); await writeFile(path, JSON.stringify(manifest));
      }
      const before = await readFile(join(fixture.packaged, "manifest.json"));
      let signed = 0;
      await assert.rejects(sealWindowsNativeHardware({ electronPlatformName: "win32", appOutDir: fixture.directory,
        packager: { signIf: async () => { signed++; throw new Error("configured signing failed"); } } },
      "x64", auditNativeHardware, fixture.source));
      assert.equal(signed, defect === "signer" ? 1 : 0);
      assert.deepEqual(await readFile(join(fixture.packaged, "manifest.json")), before);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});

async function create(architecture) {
  const directory = await mkdtemp(join(tmpdir(), "joko-usb-signing-"));
  const source = join(directory, "build"), packaged = join(directory, "resources", "native-hardware");
  await mkdir(source); await mkdir(packaged, { recursive: true });
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68);
  const manifest = JSON.stringify({ protocolVersion: 1, platform: "win32", architecture, helper, sha256: digest(bytes) });
  for (const root of [source, packaged]) {
    await writeFile(join(root, "manifest.json"), manifest); await writeFile(join(root, helper), bytes);
  }
  await writeFile(join(packaged, helper), Buffer.concat([bytes, Buffer.from("extraResource-signature")]));
  return { directory, source, packaged, bytes };
}
