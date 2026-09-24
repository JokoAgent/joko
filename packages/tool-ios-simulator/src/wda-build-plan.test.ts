import { expect, it } from "vitest";
import { createWdaBuildCacheKey, createWdaBuildPlan } from "./wda-build-plan.js";

const udid = "a0123456-1234-1234-1234-123456789abc";
const owner = "b".repeat(64);

it("pins exact Xcode build and launch argv while withholding unrelated host secrets", () => {
  const plan = createWdaBuildPlan({
    checkoutPath: "/private/joko/cache/source",
    derivedDataPath: "/private/joko/cache/derived",
    simulatorUdid: udid, ownerFingerprint: owner, architecture: "arm64",
    hostEnvironment: { PATH: "/usr/bin:/bin", HOME: "/Users/test", API_TOKEN: "secret", JOKO_CREDENTIAL: "secret" }
  });
  const shared = ["-quiet", "-project", "/private/joko/cache/source/WebDriverAgent.xcodeproj",
    "-scheme", "WebDriverAgentRunner", "-destination",
    `platform=iOS Simulator,id=${udid.toUpperCase()},arch=arm64`,
    "-derivedDataPath", "/private/joko/cache/derived"];
  const settings = ["CODE_SIGNING_ALLOWED=NO", "COMPILER_INDEX_STORE_ENABLE=NO",
    `JOKO_WDA_OWNER_FINGERPRINT=${owner}`, `UPGRADE_TIMESTAMP=${owner}`];
  expect(plan.build).toEqual({ command: "/usr/bin/xcodebuild",
    args: [...shared, "build-for-testing", ...settings], cwd: "/private/joko/cache/source",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/test" } });
  expect(plan.launch).toEqual({ command: "/usr/bin/xcodebuild",
    args: [...shared, "test-without-building", ...settings], cwd: "/private/joko/cache/source",
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/test", USE_PORT: "8100", MJPEG_SERVER_PORT: "9100" } });
  expect(plan.controlPort).toBe(8100);
  expect(plan.mjpegPort).toBe(9100);
  expect(createWdaBuildCacheKey({ sourceRevision: "a".repeat(40), xcodeBuild: "19A1",
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", architecture: "arm64" }))
    .toMatch(/^[0-9a-f]{64}$/u);
});

it("rejects ambiguous simulator identity and conflicting driver ports before planning", () => {
  const base = { checkoutPath: "/private/joko/source", derivedDataPath: "/private/joko/derived",
    simulatorUdid: udid, ownerFingerprint: owner, architecture: "x86_64" as const };
  expect(() => createWdaBuildPlan({ ...base, simulatorUdid: `${udid},id=other` })).toThrow(/simulatorUdid/u);
  expect(() => createWdaBuildPlan({ ...base, ownerFingerprint: "bad" })).toThrow(/ownerFingerprint/u);
  expect(() => createWdaBuildPlan({ ...base, controlPort: 8100, mjpegPort: 8100 })).toThrow(/ports/u);
  expect(() => createWdaBuildPlan({ ...base, checkoutPath: "relative/path" })).toThrow(/checkoutPath/u);
});
