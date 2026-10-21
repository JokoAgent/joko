import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native parsers and Office writers share the hosted runner's process
    // budget. Keep each original deadline without overlapping whole files.
    ...(process.env.GITHUB_ACTIONS === "true" ? { fileParallelism: false } : {})
  }
});
