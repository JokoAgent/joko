import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Large image buffers and mounted native views share the Windows runner's
    // CPU and memory. Keep their original data and deadlines without overlap.
    ...(process.env.GITHUB_ACTIONS === "true" && process.platform === "win32"
      ? { fileParallelism: false } : {})
  }
});
