import { defineConfig } from "vitest/config";
import { testTimeoutMs } from "./src/test-deadlines.js";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    testTimeout: testTimeoutMs,
    hookTimeout: testTimeoutMs,
    fileParallelism: false,
    sequence: { concurrent: false }
  }
});
