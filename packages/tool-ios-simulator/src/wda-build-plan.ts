import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path/posix";

const XCODEBUILD = "/usr/bin/xcodebuild";
const SCHEME = "WebDriverAgentRunner";
const SAFE_ENV_KEYS = ["DEVELOPER_DIR", "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER"] as const;

export interface WdaCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface WdaBuildPlan {
  readonly projectPath: string;
  readonly scheme: string;
  readonly build: WdaCommandPlan;
  readonly launch: WdaCommandPlan;
  readonly controlPort: number;
  readonly mjpegPort: number;
}

export interface WdaBuildCacheIdentity {
  readonly sourceRevision: string;
  readonly xcodeBuild: string;
  readonly runtimeIdentifier: string;
  readonly architecture: "arm64" | "x86_64";
}

export interface WdaBuildPlanOptions {
  readonly checkoutPath: string;
  readonly derivedDataPath: string;
  readonly simulatorUdid: string;
  readonly ownerFingerprint: string;
  readonly architecture: "arm64" | "x86_64";
  readonly controlPort?: number;
  readonly mjpegPort?: number;
  readonly hostEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(`${label} must be an absolute path.`);
  return normalize(value);
}

function port(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) throw new Error(`${label} is invalid.`);
  return value;
}

/** Xcode receives only host variables needed by Apple tooling, plus fixed driver ports. */
export function createWdaChildEnvironment(source: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }
  environment.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return environment;
}

/** Deterministic build cache identity without service paths or credentials. */
export function createWdaBuildCacheKey(identity: WdaBuildCacheIdentity): string {
  if (!/^[0-9a-f]{40}$/u.test(identity.sourceRevision) || !identity.xcodeBuild.trim() ||
      !identity.runtimeIdentifier.trim() || !["arm64", "x86_64"].includes(identity.architecture)) {
    throw new Error("WDA build cache identity is invalid.");
  }
  return createHash("sha256").update([
    identity.sourceRevision, identity.xcodeBuild.trim(), identity.runtimeIdentifier.trim(), identity.architecture
  ].join("\0")).digest("hex");
}

/** Produces argv only; the caller owns a bounded child process and durable effect admission. */
export function createWdaBuildPlan(options: WdaBuildPlanOptions): WdaBuildPlan {
  const checkoutPath = absolute(options.checkoutPath, "checkoutPath");
  const derivedDataPath = absolute(options.derivedDataPath, "derivedDataPath");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(options.simulatorUdid)) {
    throw new Error("simulatorUdid is invalid.");
  }
  if (!/^[0-9a-f]{64}$/u.test(options.ownerFingerprint)) throw new Error("ownerFingerprint is invalid.");
  if (options.architecture !== "arm64" && options.architecture !== "x86_64") throw new Error("architecture is invalid.");
  const controlPort = port(options.controlPort ?? 8100, "controlPort");
  const mjpegPort = port(options.mjpegPort ?? 9100, "mjpegPort");
  if (controlPort === mjpegPort) throw new Error("Driver ports must differ.");
  const projectPath = join(checkoutPath, "WebDriverAgent.xcodeproj");
  const sharedArgs = ["-quiet", "-project", projectPath, "-scheme", SCHEME, "-destination",
    `platform=iOS Simulator,id=${options.simulatorUdid.toUpperCase()},arch=${options.architecture}`,
    "-derivedDataPath", derivedDataPath];
  const buildSettings = ["CODE_SIGNING_ALLOWED=NO", "COMPILER_INDEX_STORE_ENABLE=NO",
    `JOKO_WDA_OWNER_FINGERPRINT=${options.ownerFingerprint}`,
    `UPGRADE_TIMESTAMP=${options.ownerFingerprint}`];
  const environment = createWdaChildEnvironment(options.hostEnvironment);
  return {
    projectPath, scheme: SCHEME, controlPort, mjpegPort,
    build: { command: XCODEBUILD, args: [...sharedArgs, "build-for-testing", ...buildSettings],
      cwd: checkoutPath, env: { ...environment } },
    launch: { command: XCODEBUILD, args: [...sharedArgs, "test-without-building", ...buildSettings],
      cwd: checkoutPath, env: { ...environment, USE_PORT: String(controlPort), MJPEG_SERVER_PORT: String(mjpegPort) } }
  };
}
