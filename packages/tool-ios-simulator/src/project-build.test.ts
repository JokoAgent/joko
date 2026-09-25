import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNodeSimulatorBuildCommandRunner, SimulatorProjectBuilder,
  type SimulatorBuildCommandRunner } from "./project-build.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";

it("discovers only an unambiguous worktree-contained Xcode container", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-project-discovery-"));
  const outside = await mkdtemp(join(tmpdir(), "joko-project-outside-"));
  try {
    const builder = new SimulatorProjectBuilder({ platform: "darwin" });
    await mkdir(join(root, "ios", "Example.xcodeproj"), { recursive: true });
    expect(await builder.inspect(root)).toMatchObject({ kind: "xcode-project",
      containerPath: join(root, "ios", "Example.xcodeproj") });
    await mkdir(join(root, "ios", "Example.xcworkspace"));
    expect(await builder.inspect(root)).toMatchObject({ kind: "xcode-workspace" });
    await mkdir(join(root, "Other.xcworkspace"));
    await expect(builder.inspect(root)).rejects.toMatchObject({ code: "AMBIGUOUS_XCODE_PROJECT" });
    expect(await builder.inspect(root, "ios/Example.xcodeproj")).toMatchObject({ kind: "xcode-project" });
    await mkdir(join(outside, "Foreign.xcodeproj"));
    await expect(builder.inspect(root, join(outside, "Foreign.xcodeproj")))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("preflights the primary app architecture and builds one exact Debug Simulator destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-project-build-"));
  const container = join(root, "Example.xcodeproj");
  const derived = join(root, "managed-derived");
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  try {
    await mkdir(container);
    await mkdir(derived);
    const runner: SimulatorBuildCommandRunner = { async run(command, args, options) {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      if (args.includes("-list")) return { stdout: JSON.stringify({ project: { schemes: ["Example"] } }), stderr: "", exitCode: 0 };
      if (args.includes("-showBuildSettings")) return { stdout: JSON.stringify([
        { buildSettings: { PRODUCT_TYPE: "com.apple.product-type.framework", ARCHS: "arm64" } },
        { buildSettings: { PRODUCT_TYPE: "com.apple.product-type.application", ARCHS: "x86_64 arm64",
          EXCLUDED_ARCHS: "arm64", TARGET_BUILD_DIR: join(derived, "Build", "Products", "Debug-iphonesimulator"),
          WRAPPER_NAME: "Example.app" } }
      ]), stderr: "", exitCode: 0 };
      if (args.includes("build")) {
        await mkdir(join(derived, "Build", "Products", "Debug-iphonesimulator", "Example.app"), { recursive: true });
        return { stdout: "BUILD SUCCEEDED", stderr: "", exitCode: 0 };
      }
      throw new Error("Unexpected Xcode action");
    } };
    const builder = new SimulatorProjectBuilder({ platform: "darwin", runner });
    await expect(builder.build({ worktreeRoot: root, derivedDataPath: derived,
      simulatorUdid: UDID, expectedArch: "arm64" })).rejects.toMatchObject({ code: "APP_ARCH_MISMATCH" });
    expect(calls.some(call => call.args.includes("build"))).toBe(false);
    const result = await builder.build({ worktreeRoot: root, derivedDataPath: derived,
      simulatorUdid: UDID, expectedArch: "x86_64" });
    expect(result).toMatchObject({ kind: "xcode-project", scheme: "Example",
      appPath: join(derived, "Build", "Products", "Debug-iphonesimulator", "Example.app") });
    expect(calls.find(call => call.args.includes("build"))).toMatchObject({ command: "/usr/bin/xcodebuild",
      timeoutMs: 1_800_000 });
    expect(calls.find(call => call.args.includes("build"))!.args).toEqual(expect.arrayContaining([
      "-configuration", "Debug", "-destination", `platform=iOS Simulator,id=${UDID}`,
      "-derivedDataPath", derived, "-resultBundlePath"
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retries only the missing resolved-file diagnostic with a fresh result bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-project-pin-"));
  const derived = join(root, "derived");
  const bundles: string[] = [];
  try {
    await mkdir(join(root, "Example.xcodeproj"));
    await mkdir(derived);
    const runner: SimulatorBuildCommandRunner = { async run(_command, args) {
      if (args.includes("-list")) return { stdout: JSON.stringify({ project: { schemes: ["Example"] } }), stderr: "", exitCode: 0 };
      if (args.includes("-showBuildSettings")) return { stdout: JSON.stringify([
        { buildSettings: { PRODUCT_TYPE: "com.apple.product-type.application", ARCHS: "x86_64",
          TARGET_BUILD_DIR: join(derived, "Build"), WRAPPER_NAME: "Example.app" } }
      ]), stderr: "", exitCode: 0 };
      const bundle = args[args.indexOf("-resultBundlePath") + 1]!;
      bundles.push(bundle);
      if (bundles.length === 1) return { stdout: "", stderr: "Package.resolved is missing", exitCode: 65 };
      await mkdir(join(derived, "Build", "Example.app"), { recursive: true });
      return { stdout: "BUILD SUCCEEDED", stderr: "", exitCode: 0 };
    } };
    const result = await new SimulatorProjectBuilder({ platform: "darwin", runner }).build({
      worktreeRoot: root, derivedDataPath: derived, simulatorUdid: UDID, expectedArch: "x86_64" });
    expect(result.appPath).toBe(join(derived, "Build", "Example.app"));
    expect(bundles).toHaveLength(2);
    expect(bundles[0]).not.toBe(bundles[1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains a bounded output tail without aborting a successful chatty build process", async () => {
  const result = await createNodeSimulatorBuildCommandRunner().run(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(100000))"],
    { timeoutMs: 5_000, maxBufferBytes: 1_024 });
  expect(result).toMatchObject({ exitCode: 0, outputTruncated: true });
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
});

it("does not pass service-only secrets to an app build process", async () => {
  const runner = createNodeSimulatorBuildCommandRunner({
    HOME: tmpdir(), LANG: "en_US.UTF-8", JOKO_BUILD_PRIVATE_VALUE: "not-for-project-scripts"
  });
  const result = await runner.run(process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({home: process.env.HOME, private: process.env.JOKO_BUILD_PRIVATE_VALUE}))"],
    { timeoutMs: 5_000, maxBufferBytes: 1_024 });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ home: tmpdir() });
});
