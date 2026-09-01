import { defineConfig } from "vitest/config";

const isWindowsGithubActions = process.env.GITHUB_ACTIONS === "true" && process.platform === "win32";

export default defineConfig(isWindowsGithubActions
  ? {
      test: {
        // Several smoke files launch nested Node/Pi process trees. Running
        // them together can starve child startup on hosted Windows runners.
        fileParallelism: false
      }
    }
  : {});
