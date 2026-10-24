import { managedRuntimeFactorySource } from "./managed-runtime-factory-source.js";

/** Closure-free rules shared with the isolated, provisioned Pi bridge. */
export function createPiShellPolicy(secretEnvironmentNames: readonly string[] = []) {
  const defaultTimeoutSeconds = 300;
  const maximumTimeoutSeconds = 1_800;
  const denied = new Set(secretEnvironmentNames.map((name) => name.toUpperCase()));
  denied.add("JOKO_PI_MCP_TOKEN");
  return {
    defaultTimeoutSeconds,
    maximumTimeoutSeconds,
    timeout(value: unknown): number {
      if (value === undefined) return defaultTimeoutSeconds;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximumTimeoutSeconds) {
        throw new Error("Invalid bash timeout: expected a finite number of seconds in (0, 1800]");
      }
      return value;
    },
    sanitizeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      const clean: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(environment)) {
        if (denied.has(key.toUpperCase()) || /^JOKO_PI_/i.test(key) || /^PI_CODING_AGENT_/i.test(key)
          || /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) continue;
        clean[key] = value;
      }
      return clean;
    }
  };
}

export const MANAGED_SHELL_POLICY_RUNTIME_SOURCE = managedRuntimeFactorySource("createPiShellPolicy", createPiShellPolicy);
