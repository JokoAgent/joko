import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createPiAdapter } from "./adapter.js";

const { prepareProbeDirectory } = vi.hoisted(() => ({ prepareProbeDirectory: vi.fn<() => void>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: (prefix: Parameters<typeof fs.mkdtemp>[0], ...options: unknown[]) => {
      if (typeof prefix === "string" && prefix.endsWith("joko-pi-compatibility-")) prepareProbeDirectory();
      return Reflect.apply(fs.mkdtemp, fs, [prefix, ...options]);
    }
  };
});

it("recovers a retained and replacement bundled Pi Adapter after probe storage becomes available", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-pi-probe-recovery-"));
  const createAdapter = (name: string) => createPiAdapter({
    agentHome: join(root, name),
    sessionRoot: join(root, name, "sessions"),
    versionProbe: async () => "pi 0.85.1"
  });
  const retained = createAdapter("retained");
  const candidate = createAdapter("candidate");
  const failTemporaryWrite = () => {
    throw Object.assign(new Error("ENOSPC: compatibility probe temporary volume is full"), { code: "ENOSPC" });
  };
  prepareProbeDirectory.mockImplementationOnce(failTemporaryWrite).mockImplementationOnce(failTemporaryWrite);
  try {
    const first = await retained.describe();
    expect(first.health).toBe("unavailable");
    expect(first.capabilities.get("input.text")).toMatchObject({ supported: false, reason: "platform_limited" });
    expect(first.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining("PI_EXECUTABLE_PROBE_UNAVAILABLE")]));
    expect((await retained.describe()).health).toBe("unavailable");
    expect(prepareProbeDirectory).toHaveBeenCalledTimes(2);

    const [replacement, refreshed] = await Promise.all([candidate.describe(), retained.describe()]);
    for (const descriptor of [replacement, refreshed]) {
      expect(descriptor.health).not.toBe("unavailable");
      expect(descriptor.capabilities.get("input.text")).toMatchObject({ supported: true });
    }
    expect((await candidate.describe()).health).toBe(replacement.health);
    expect(prepareProbeDirectory).toHaveBeenCalledTimes(3);
  } finally {
    await Promise.all([retained.dispose(), candidate.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
