import { describe, expect, it } from "vitest";
import {
  capturePackagedSmokeProcessBirthIdentitySync,
  deriveLinuxPackagedSmokeProcessBirthIdentity,
  derivePortablePackagedSmokeProcessBirthIdentity
} from "../src/packaged-smoke-process-identity.js";

describe("packaged smoke process birth identity", () => {
  it("captures a stable OS birth proof for the current process without an effect", () => {
    const first = capturePackagedSmokeProcessBirthIdentitySync(process.pid);
    const second = capturePackagedSmokeProcessBirthIdentitySync(process.pid);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("binds Linux identity to boot, start ticks, executable and PID", () => {
    const first = linuxStat(4242, "joko runtime", "987654");
    const identity = deriveLinuxPackagedSmokeProcessBirthIdentity(
      4242,
      first,
      first,
      "/opt/joko/runtime",
      "65c06fe6-9efe-4a0c-b6f7-8e1f77553164\n"
    );
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveLinuxPackagedSmokeProcessBirthIdentity(
      4242,
      first,
      linuxStat(4242, "joko runtime", "987655"),
      "/opt/joko/runtime",
      "65c06fe6-9efe-4a0c-b6f7-8e1f77553164"
    )).toBeUndefined();
    expect(deriveLinuxPackagedSmokeProcessBirthIdentity(
      4243,
      first,
      first,
      "/opt/joko/runtime",
      "65c06fe6-9efe-4a0c-b6f7-8e1f77553164"
    )).not.toBe(identity);
  });

  it("derives distinct bounded Windows and macOS proofs and rejects ambiguous output", () => {
    const windows = derivePortablePackagedSmokeProcessBirthIdentity(
      4242,
      "win32",
      "638946830400000000|C:\\Program Files\\Joko\\Joko.exe\r\n"
    );
    const mac = derivePortablePackagedSmokeProcessBirthIdentity(
      4242,
      "darwin",
      "Sun Sep 27 12:34:56 2026 /Applications/Joko.app/Contents/MacOS/Joko\n"
    );
    expect(windows).toMatch(/^[0-9a-f]{64}$/u);
    expect(mac).toMatch(/^[0-9a-f]{64}$/u);
    expect(windows).not.toBe(mac);
    expect(derivePortablePackagedSmokeProcessBirthIdentity(4242, "darwin", "first\nsecond"))
      .toBeUndefined();
    expect(derivePortablePackagedSmokeProcessBirthIdentity(4242, "win32", "  "))
      .toBeUndefined();
  });
});

function linuxStat(pid: number, name: string, startTicks: string): string {
  const fields: string[] = Array.from({ length: 20 }, (_value, index) => index === 0 ? "S" : "0");
  fields[19] = startTicks;
  return `${pid} (${name}) ${fields.join(" ")}`;
}
