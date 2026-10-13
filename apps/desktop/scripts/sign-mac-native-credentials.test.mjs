import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createSignHook } = createRequire(import.meta.url)("./sign-mac-native-credentials.cjs");
const names = ["joko-macos-remote-desktop-input", "joko-macos-remote-desktop-capture", "joko-macos-remote-credentials"];

test("final helper receipts enter the manifest immediately before the outer App seal", async () => {
  const fixture = await create();
  try {
    const defaults = { hardenedRuntime: true, entitlements: "/default/Electron.plist", signatureFlags: "runtime" };
    let audits = 0, outerSeals = 0;
    const sign = createSignHook(async options => {
      assert.equal(options.identity, "certificate");
      assert.equal(options.ignore, fixture.ignore);
      for (const name of names) {
        const path = join(fixture.root, name), perFile = await options.optionsForFile(path);
        assert.equal(perFile.hardenedRuntime, true);
        assert.equal(perFile.signatureFlags, "runtime");
        assert.equal(perFile.entitlements.endsWith(name === names[2] ? "credentials.entitlements.plist" : "Electron.plist"), true);
        const bytes = await readFile(path); bytes[63] = 0x73;
        await writeFile(path, bytes);
      }
      const before = JSON.parse(await readFile(join(fixture.root, "manifest.json"), "utf8"));
      assert.equal(before.credentialSha256, fixture.original);
      assert.equal(await options.optionsForFile(fixture.app), defaults);
      assert.equal(audits, 1);
      const final = JSON.parse(await readFile(join(fixture.root, "manifest.json"), "utf8"));
      assert.equal(final.credentialSha256, digest(await readFile(join(fixture.root, names[2]))));
      assert.notEqual(final.credentialSha256, fixture.original);
      outerSeals++;
    }, async (root, platform, architecture) => {
      assert.equal(root, fixture.root); assert.equal(platform, "darwin"); assert.equal(architecture, "x64"); audits++;
    });
    await sign({ platform: "darwin", app: fixture.app, identity: "certificate", ignore: fixture.ignore,
      optionsForFile: () => defaults });
    assert.equal(outerSeals, 1);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("a signer that omits the outer App boundary cannot report sealed success", async () => {
  const fixture = await create();
  try {
    await assert.rejects(createSignHook(async () => {})({ platform: "darwin", app: fixture.app }),
      /not included in the outer App seal/u);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("an invalid exact helper identity blocks the outer seal", async () => {
  const fixture = await create();
  try {
    const path = join(fixture.root, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")); manifest.credentialHelper = "unexpected";
    await writeFile(path, JSON.stringify(manifest));
    let sealed = false;
    const sign = createSignHook(async options => { await options.optionsForFile(fixture.app); sealed = true; });
    await assert.rejects(sign({ platform: "darwin", app: fixture.app }), /identity is invalid/u);
    assert.equal(sealed, false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function create() {
  const directory = await mkdtemp(join(tmpdir(), "joko-native-credential-sign-"));
  const app = join(directory, "Joko.app"), root = join(app, "Contents", "Resources", "native-remote-desktop");
  const bundle = "JokoRemoteCredentials_JokoRemoteCredentials.bundle";
  await mkdir(join(root, bundle), { recursive: true });
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x01000007, 4);
  for (const name of names) { await writeFile(join(root, name), bytes); await chmod(join(root, name), 0o755); }
  const resource = Buffer.from('{}'); await writeFile(join(root, bundle, "credentials.json"), resource);
  const original = digest(bytes);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ protocolVersion: 1, platform: "darwin", architecture: "x64",
    inputHelper: names[0], inputSha256: original, captureHelper: names[1], captureSha256: original,
    credentialHelper: names[2], credentialSha256: original, credentialBundle: bundle,
    clipboardHelper: null, clipboardSha256: null, viewerDisplayScript: null,
    viewerDisplaySha256: null, viewerDisplayInterpreter: null,
    privacyPlugin: null, privacySha256: null, privacyMetadata: null, privacyMetadataSha256: null,
    linuxCredentialDirectory: null, linuxCredentialInterpreter: null, linuxCredentialFiles: null,
    windowsHostService: null, windowsHostServiceSha256: null, windowsHostAddon: null, windowsHostAddonSha256: null,
    windowsHostNodeApiVersion: null,
    credentialBundleSha256: createHash("sha256").update("credentials.json").update("\0").update(resource).digest("hex") }));
  return { directory, root, app, original, ignore: () => false };
}
