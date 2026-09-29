import { pathToFileURL } from "node:url";

import type {
  DevicePeerTerminalHandle,
  DevicePeerTerminalStartRequest,
  DevicePeerTerminalTransportPort
} from "@joko/device-peer";

import { auditTerminalRuntimeAssets } from "./terminal-runtime-probe.js";

interface AuditedTerminalRuntimeModule {
  readonly spawnTerminalHost: (
    executable: string,
    args: string[],
    options: {
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly env: Readonly<Record<string, string>>;
    },
    signal?: AbortSignal
  ) => Promise<DevicePeerTerminalHandle>;
  readonly terminalEnvironment: (
    source?: Readonly<NodeJS.ProcessEnv>
  ) => Record<string, string>;
}

/**
 * Loads the same staged, native-module-audited PTY host used by the service.
 * The module is imported only after its immutable package/native layout has
 * passed the target platform audit.
 */
export async function createAuditedDesktopDevicePeerTerminalPort(options: {
  readonly runtimeRoot: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}): Promise<DevicePeerTerminalTransportPort> {
  const inspected = await auditTerminalRuntimeAssets(
    options.runtimeRoot,
    options.platform ?? process.platform,
    options.arch ?? process.arch
  );
  const loaded: unknown = await import(pathToFileURL(inspected.providerEntry).href);
  if (!isAuditedTerminalRuntimeModule(loaded)) {
    throw new Error("The audited terminal runtime has an invalid provider entry.");
  }
  const environment = Object.freeze(loaded.terminalEnvironment(options.environment ?? process.env));
  return Object.freeze({
    open(request: DevicePeerTerminalStartRequest) {
      return loaded.spawnTerminalHost(request.executable, [...request.args], {
        cwd: request.cwd,
        cols: request.cols,
        rows: request.rows,
        env: environment
      }, request.signal);
    }
  });
}

function isAuditedTerminalRuntimeModule(value: unknown): value is AuditedTerminalRuntimeModule {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Record<string, unknown>;
  return typeof module["spawnTerminalHost"] === "function"
    && typeof module["terminalEnvironment"] === "function";
}
