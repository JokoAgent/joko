import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPiAdapter } from "./adapter.js";
import { mkdtemp } from "./test-paths.js";

describe("host capability projection", () => {
  it("publishes the host-owned generated-file surface through the Backend descriptor", { timeout: 20_000 }, async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-host-capability-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      versionProbe: async () => "pi 99.1.0",
      hostCapabilities: ["workspace.generated_files"]
    });
    try {
      expect((await adapter.describe()).capabilities.get("workspace.generated_files"))
        .toMatchObject({ supported: true });
    } finally {
      await adapter.dispose();
      await rm(agentHome, { recursive: true, force: true });
    }
  });
});
