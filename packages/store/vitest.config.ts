import { defineConfig } from "vitest/config";

export default defineConfig(process.env.GITHUB_ACTIONS === "true"
  ? {
      test: {
        // SQLite-heavy files contended with each other on hosted runners.
        fileParallelism: false
      }
    }
  : {});
