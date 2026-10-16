import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Native host probes and real service bootstraps share the CI runner's
    // process/CPU budget. Keep their original deadlines while avoiding overlap.
    ...(process.env.GITHUB_ACTIONS === "true" ? { fileParallelism: false } : {})
  }
});
