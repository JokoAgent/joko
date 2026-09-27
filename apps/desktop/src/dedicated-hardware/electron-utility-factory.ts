import { isAbsolute, resolve } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";

import type {
  DedicatedHardwareUtilityConnection,
  DedicatedHardwareUtilityFactory
} from "./host-client.js";

type UtilityFork = typeof utilityProcess.fork;

const UTILITY_ENVIRONMENT_KEYS = [
  "SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"
] as const;

export function createDedicatedHardwareUtilityEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env
): Record<string, string> {
  const environment: Record<string, string> = {};
  const sourceKeys = Object.keys(source);
  for (const key of UTILITY_ENVIRONMENT_KEYS) {
    const sourceKey = sourceKeys.find((candidate) => candidate.toLocaleUpperCase("en-US") === key.toLocaleUpperCase("en-US"));
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
      environment[sourceKey ?? key] = value;
    }
  }
  return environment;
}

export function createElectronDedicatedHardwareUtilityFactory(options: {
  readonly entryPath: string;
  readonly cwd?: string;
  readonly fork?: UtilityFork;
}): DedicatedHardwareUtilityFactory {
  if (!isNormalizedAbsolutePath(options.entryPath)) {
    throw new TypeError("The dedicated hardware utility entry must be a normalized absolute path.");
  }
  if (options.cwd !== undefined && !isNormalizedAbsolutePath(options.cwd)) {
    throw new TypeError("The dedicated hardware utility working directory must be a normalized absolute path.");
  }
  const fork = options.fork ?? utilityProcess.fork;
  const factory: DedicatedHardwareUtilityFactory = {
    spawn: ({ onMessage, onExit }: Parameters<DedicatedHardwareUtilityFactory["spawn"]>[0]) => new Promise<DedicatedHardwareUtilityConnection>((resolveSpawn, rejectSpawn) => {
      let child: UtilityProcess;
      try {
        child = fork(options.entryPath, [], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: createDedicatedHardwareUtilityEnvironment(),
          execArgv: [],
          stdio: "ignore",
          serviceName: "Joko hardware input",
          allowLoadingUnsignedLibraries: false,
          disclaim: false
        });
      } catch {
        rejectSpawn(new Error("The dedicated hardware utility could not start."));
        return;
      }
      let spawned = false;
      let settled = false;
      child.on("message", onMessage);
      child.once("spawn", () => {
        if (settled) return;
        spawned = true;
        settled = true;
        resolveSpawn(Object.freeze({
          send: (request: Parameters<DedicatedHardwareUtilityConnection["send"]>[0]) => child.postMessage(request),
          terminate: () => { child.kill(); }
        }));
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        rejectSpawn(new Error("The dedicated hardware utility could not start."));
      });
      child.once("exit", () => {
        if (!settled) {
          settled = true;
          rejectSpawn(new Error("The dedicated hardware utility exited during startup."));
          return;
        }
        if (spawned) onExit();
      });
    })
  };
  return Object.freeze(factory);
}

function isNormalizedAbsolutePath(value: string): boolean {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}
