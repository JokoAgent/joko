import { defineConfig } from "vitest/config";

const serializeProcessHeavyTests = process.env.GITHUB_ACTIONS === "true" || process.platform === "win32";

export default defineConfig(serializeProcessHeavyTests
  ? {
      test: {
        // Windows file watching plus SQLite and process-heavy fixtures are not
        // isolated reliably when test files run concurrently.
        fileParallelism: false,
        // Windows process and filesystem startup can exceed Vitest's ordinary
        // five-second test boundary even outside CI.
        ...(process.platform === "win32" ? { testTimeout: 10_000 } : {})
      }
    }
  : {});
