import { createHash } from "node:crypto";
import { posix as remotePath } from "node:path";
import { TextDecoder } from "node:util";

import {
  CLAUDE_AGENT_SDK_VERSION,
  loadClaudeRemoteManagerSource
} from "@joko/adapter-claude-code";
import type { RemoteProcessHandle, RemoteProcessTransportPort } from "@joko/remote-ssh";

export const REMOTE_CLAUDE_NODE_VERSION = "22.13.0";
export const REMOTE_CLAUDE_CLI_VERSION = "2.1.259";
export const REMOTE_CLAUDE_MANAGER_VERSION = "1.0.0";
export const REMOTE_CLAUDE_PROTOCOL_VERSION = 1;
export const REMOTE_CLAUDE_EXPECTED_VERSION =
  `sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-${REMOTE_CLAUDE_CLI_VERSION}+manager-${REMOTE_CLAUDE_MANAGER_VERSION}`;
export const REMOTE_CLAUDE_RUNTIME_SUFFIX = ".joko/runtime/v1/claude-code";
export const REMOTE_CLAUDE_SENTINEL_SUFFIX = `${REMOTE_CLAUDE_RUNTIME_SUFFIX}/.joko-runtime-ready-v1`;

const PROBE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const UNINSTALL_TIMEOUT_MS = 10_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 128 * 1024;
const NODE_BASE_URL = `https://nodejs.org/dist/v${REMOTE_CLAUDE_NODE_VERSION}`;
const NODE_CHECKSUMS = Object.freeze({
  "darwin-arm64": "bc1e374e7393e2f4b20e5bbc157d02e9b1fb2c634b2f992136b38fb8ca2023b7",
  "darwin-x64": "cfaaf5edde585a15547f858f5b3b62a292cf5929a23707b6f1e36c29a32487be",
  "linux-arm64": "e0cc088cb4fb2e945d3d5c416c601e1101a15f73e0f024c9529b964d9f6dce5b",
  "linux-x64": "9a33e89093a0d946c54781dcb3ccab4ccf7538a7135286528ca41ca055e9b38f"
} as const);

export type RemoteClaudeInstallPhase = "probing" | "downloading" | "installing" | "validating" | "complete";

export interface RemoteClaudeInstallationProbe {
  readonly state: "ready" | "not_installed";
  readonly workspaceRoot: string;
  readonly runtimeRoot: string;
  readonly nodeExecutable: string;
  readonly managerModule: string;
  readonly managerSha256: string;
  readonly claudeExecutable: string;
  readonly socketPath: string;
  readonly installedVersion?: string;
}

export class RemoteClaudeInstallationError extends Error {
  readonly code: "busy" | "command_failed" | "cancelled";
  readonly stateMayHaveChanged: boolean;

  constructor(
    code: RemoteClaudeInstallationError["code"],
    message: string,
    options?: { readonly stateMayHaveChanged?: boolean }
  ) {
    super(message);
    this.name = "RemoteClaudeInstallationError";
    this.code = code;
    this.stateMayHaveChanged = options?.stateMayHaveChanged === true;
  }
}

export async function probeRemoteClaudeInstallation(
  processes: RemoteProcessTransportPort,
  workspaceRoot: string,
  assertCurrent: () => void,
  signal?: AbortSignal
): Promise<RemoteClaudeInstallationProbe> {
  if (!normalizedAbsoluteRemotePath(workspaceRoot)) throw installationFault("The remote Claude workspace path is invalid.");
  const bundle = await managerBundle();
  const expectedSentinel = sentinelValue(bundle.sha256);
  const script = probeScript(expectedSentinel, bundle.sha256);
  assertCurrent();
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: workspaceRoot,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal
  });
  assertCurrent();
  if (result.exitCode !== 0) throw installationFault("The fixed remote Claude runtime probe failed.");
  const fields = nulFields(result.stdout, 9);
  const canonicalWorkspace = fields[0]!;
  const runtimeRoot = fields[1]!;
  const nodeExecutable = fields[2]!;
  const managerModule = fields[3]!;
  const claudeExecutable = fields[4]!;
  const socketPath = fields[5]!;
  const sdkVersion = fields[6]!;
  const cliVersion = fields[7]!;
  const state = fields[8]!;
  if (!normalizedAbsoluteRemotePath(canonicalWorkspace)
    || ![runtimeRoot, nodeExecutable, managerModule, socketPath].every(normalizedAbsoluteRemotePath)
    || (claudeExecutable.length > 0 && !normalizedAbsoluteRemotePath(claudeExecutable))
    || nodeExecutable !== remotePath.join(runtimeRoot, "current", "node", "bin", "node")
    || managerModule !== remotePath.join(runtimeRoot, "current", "manager.mjs")
    || socketPath !== remotePath.join(runtimeRoot, "run", "manager.sock")
    || (state === "ready"
      && !claudeExecutable.startsWith(`${remotePath.join(runtimeRoot, "current", "node_modules", "@anthropic-ai")}/`))
    || (state === "not_installed" && claudeExecutable.length > 0
      && !claudeExecutable.startsWith(`${remotePath.join(runtimeRoot, "current", "node_modules", "@anthropic-ai")}/`))
    || (state !== "ready" && state !== "not_installed")
    || (state === "ready" && (sdkVersion !== CLAUDE_AGENT_SDK_VERSION || cliVersion !== REMOTE_CLAUDE_CLI_VERSION))) {
    throw installationFault("The fixed remote Claude runtime probe returned invalid metadata.");
  }
  return Object.freeze({
    state,
    workspaceRoot: canonicalWorkspace,
    runtimeRoot,
    nodeExecutable,
    managerModule,
    managerSha256: bundle.sha256,
    claudeExecutable,
    socketPath,
    ...(state === "ready" ? { installedVersion: REMOTE_CLAUDE_EXPECTED_VERSION } : {})
  });
}

export async function installRemoteClaude(
  processes: RemoteProcessTransportPort,
  options: {
    readonly reinstall: boolean;
    readonly assertCurrent: () => void;
    readonly signal?: AbortSignal;
    readonly onPhase?: (phase: RemoteClaudeInstallPhase) => void;
  }
): Promise<RemoteClaudeInstallationProbe> {
  const bundle = await managerBundle();
  const script = installScript(bundle.bytes.toString("base64"), bundle.sha256);
  options.assertCurrent();
  let lineBuffer = "";
  const seen = new Set<RemoteClaudeInstallPhase>();
  const acceptOutput = (chunk: Buffer): void => {
    lineBuffer += chunk.toString("utf8");
    if (lineBuffer.length > 2_048) throw installationFault("The remote Claude installer emitted invalid progress.", true);
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^JOKO_PHASE (probing|downloading|installing|validating|complete)$/u.exec(line.trim());
      if (match?.[1] === undefined) continue;
      const phase = match[1] as RemoteClaudeInstallPhase;
      if (seen.has(phase)) continue;
      seen.add(phase);
      options.onPhase?.(phase);
    }
  };
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-s", "--", options.reinstall ? "1" : "0"],
    cwd: "/",
    input: script,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal: options.signal,
    onStdout: acceptOutput
  });
  options.assertCurrent();
  if (result.exitCode === 73 || result.stdout.includes(Buffer.from("JOKO_BUSY", "utf8"))) {
    throw new RemoteClaudeInstallationError("busy", "The remote Claude runtime installer is already active.");
  }
  if (result.exitCode !== 0) throw installationFault("The fixed remote Claude runtime installation failed.", true);
  const installed = await probeRemoteClaudeInstallation(processes, "/", options.assertCurrent, options.signal);
  if (installed.state !== "ready") throw installationFault("The fixed remote Claude runtime did not validate after installation.", true);
  return installed;
}

export async function uninstallRemoteClaude(
  processes: RemoteProcessTransportPort,
  assertCurrent: () => void,
  signal?: AbortSignal
): Promise<RemoteClaudeInstallationProbe> {
  const script = `set -eu
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
home=$(cd "$home" 2>/dev/null && pwd -P) || exit 20
root="$home/${REMOTE_CLAUDE_RUNTIME_SUFFIX}"
lock="$root/.joko-install-lock"
if [ ! -e "$root" ] && [ ! -L "$root" ]; then exit 0; fi
[ -d "$root" ] && [ ! -L "$root" ] && [ "$(cd "$root" 2>/dev/null && pwd -P)" = "$root" ] || exit 20
root_uid=$(stat -c %u "$root" 2>/dev/null || stat -f %u "$root" 2>/dev/null || true)
[ -n "$root_uid" ] && [ "$root_uid" = "$(id -u)" ] || exit 20
[ ! -L "$lock" ] && [ ! -L "$root/.joko-runtime-ready-v1" ] || exit 20
if [ -d "$lock" ]; then
  lock_pid=$(cat "$lock/pid" 2>/dev/null || true)
  case "$lock_pid" in ''|*[!0-9]*) lock_pid=0 ;; esac
  lock_birth=$(cat "$lock/birth" 2>/dev/null || true)
  current_birth=""
  if [ "$lock_pid" -gt 0 ] && [ -r "/proc/$lock_pid/stat" ]; then
    current_birth=$(sed 's/^.*) //' "/proc/$lock_pid/stat" 2>/dev/null | awk '{print "linux:" $20}')
  elif [ "$lock_pid" -gt 0 ]; then
    current_birth=$(ps -p "$lock_pid" -o lstart= -o comm= 2>/dev/null | sed 's/^[[:space:]]*/posix:/')
  fi
  if [ -n "$lock_birth" ] && [ "$current_birth" = "$lock_birth" ]; then exit 73; fi
  rm -rf "$lock"
fi
rm -f "$root/.joko-runtime-ready-v1"`;
  assertCurrent();
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: "/",
    timeoutMs: UNINSTALL_TIMEOUT_MS,
    signal
  });
  assertCurrent();
  if (result.exitCode === 73) throw new RemoteClaudeInstallationError("busy", "The remote Claude runtime installer is already active.");
  if (result.exitCode !== 0) throw installationFault("The fixed remote Claude runtime uninstall marker could not be removed.", true);
  const probe = await probeRemoteClaudeInstallation(processes, "/", assertCurrent, signal);
  if (probe.state !== "not_installed") throw installationFault("The fixed remote Claude runtime remained admitted after uninstall.", true);
  return probe;
}

async function managerBundle(): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const bytes = await loadClaudeRemoteManagerSource();
  if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024) {
    throw installationFault("The packaged remote Claude manager is invalid.");
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function sentinelValue(managerSha256: string): string {
  return [
    "joko-claude-runtime-v1",
    `node=${REMOTE_CLAUDE_NODE_VERSION}`,
    `sdk=${CLAUDE_AGENT_SDK_VERSION}`,
    `cli=${REMOTE_CLAUDE_CLI_VERSION}`,
    `manager=${REMOTE_CLAUDE_MANAGER_VERSION}`,
    `protocol=${REMOTE_CLAUDE_PROTOCOL_VERSION}`,
    `sha256=${managerSha256}`
  ].join(":");
}

function probeScript(expectedSentinel: string, managerSha256: string): string {
  return `set -eu
workspace=$(pwd -P)
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
home=$(cd "$home" 2>/dev/null && pwd -P) || exit 20
root="$home/${REMOTE_CLAUDE_RUNTIME_SUFFIX}"
node="$root/current/node/bin/node"
manager="$root/current/manager.mjs"
socket="$root/run/manager.sock"
private_dir() {
  candidate=$1
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(cd "$candidate" 2>/dev/null && pwd -P)" = "$candidate" ] || return 1
  candidate_uid=$(stat -c %u "$candidate" 2>/dev/null || stat -f %u "$candidate" 2>/dev/null || true)
  [ -n "$candidate_uid" ] && [ "$candidate_uid" = "$(id -u)" ] || return 1
  candidate_mode=$(stat -c %a "$candidate" 2>/dev/null || stat -f %Lp "$candidate" 2>/dev/null || true)
  case "$candidate_mode" in *[!0-7]*|'') return 1 ;; ?00|??00) ;; *) return 1 ;; esac
}
root_safe=0
if private_dir "$root" && private_dir "$root/current" && private_dir "$root/profile" \
  && private_dir "$root/tmp" && private_dir "$root/run"; then root_safe=1; fi
claude=""
if [ "$root_safe" -eq 1 ]; then
  set -- "$root/current/node_modules/@anthropic-ai"/claude-agent-sdk-*/claude
  if [ "$#" -eq 1 ] && [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ]; then claude="$1"; fi
fi
sdk=""
cli=""
manager_hash=""
if [ "$root_safe" -eq 1 ] && [ -f "$node" ] && [ ! -L "$node" ] && [ -x "$node" ] \
  && [ -f "$root/current/node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]; then
  sdk=$(cd "$root/current" && env -i HOME="$root/profile" PATH="$root/current/node/bin:/usr/bin:/bin" \
    "$node" -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || true)
fi
if [ -n "$claude" ]; then
  raw_cli=$(env -i HOME="$root/profile" PATH="$root/current/node/bin:/usr/bin:/bin" \
    TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp" CLAUDE_CONFIG_DIR="$root/profile" CLAUDE_CODE_TMPDIR="$root/tmp" \
    "$claude" --version 2>/dev/null || true)
  cli=$(printf '%s' "$raw_cli" | sed -n 's/^\\([0-9][0-9.]*\\) (Claude Code)$/\\1/p')
fi
if [ "$root_safe" -eq 1 ] && [ -f "$manager" ] && [ ! -L "$manager" ]; then
  if command -v sha256sum >/dev/null 2>&1; then manager_hash=$(sha256sum "$manager" | awk '{print $1}');
  elif command -v shasum >/dev/null 2>&1; then manager_hash=$(shasum -a 256 "$manager" | awk '{print $1}'); fi
fi
state=not_installed
if [ "$root_safe" -eq 1 ] && [ -f "$root/.joko-runtime-ready-v1" ] && [ ! -L "$root/.joko-runtime-ready-v1" ] \
  && [ "$(cat "$root/.joko-runtime-ready-v1" 2>/dev/null || true)" = "${expectedSentinel}" ] \
  && [ "$sdk" = "${CLAUDE_AGENT_SDK_VERSION}" ] \
  && [ "$cli" = "${REMOTE_CLAUDE_CLI_VERSION}" ] \
  && [ "$manager_hash" = "${managerSha256}" ] \
  && [ "$(env -i HOME="$root/profile" PATH="$root/current/node/bin:/usr/bin:/bin" "$node" -p 'process.versions.node' 2>/dev/null || true)" = "${REMOTE_CLAUDE_NODE_VERSION}" ] \
  && [ "$(env -i HOME="$root/profile" PATH="$root/current/node/bin:/usr/bin:/bin" TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp" \
    CLAUDE_CONFIG_DIR="$root/profile" CLAUDE_CODE_TMPDIR="$root/tmp" "$node" "$manager" --version 2>/dev/null || true)" = '{"managerVersion":"${REMOTE_CLAUDE_MANAGER_VERSION}","protocolVersion":${REMOTE_CLAUDE_PROTOCOL_VERSION},"managerSha256":"${managerSha256}"}' ]; then
  state=ready
fi
printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' "$workspace" "$root" "$node" "$manager" "$claude" "$socket" "$sdk" "$cli" "$state"`;
}

function installScript(managerBase64: string, managerSha256: string): string {
  const expectedSentinel = sentinelValue(managerSha256);
  const checksumCases = Object.entries(NODE_CHECKSUMS)
    .map(([platform, checksum]) => `${platform}) archive="node-v${REMOTE_CLAUDE_NODE_VERSION}-${platform}.tar.gz"; checksum="${checksum}" ;;`)
    .join("\n");
  return `set -eu
umask 077
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
home=$(cd "$home" 2>/dev/null && pwd -P) || exit 20
root="$home/${REMOTE_CLAUDE_RUNTIME_SUFFIX}"
lock="$root/.joko-install-lock"
stage="$root/.joko-install-stage"
next="$root/.joko-next"
previous="$root/.joko-previous"
sentinel="$root/.joko-runtime-ready-v1"
reinstall=\${1-0}
owned_dir() {
  candidate=$1
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(cd "$candidate" 2>/dev/null && pwd -P)" = "$candidate" ] || return 1
  candidate_uid=$(stat -c %u "$candidate" 2>/dev/null || stat -f %u "$candidate" 2>/dev/null || true)
  [ -n "$candidate_uid" ] && [ "$candidate_uid" = "$(id -u)" ]
}
ensure_private_dir() {
  candidate=$1
  [ ! -L "$candidate" ] || exit 21
  if [ ! -e "$candidate" ]; then mkdir "$candidate" || exit 21; fi
  owned_dir "$candidate" || exit 21
  chmod 700 "$candidate" || exit 21
}
ensure_private_dir "$home/.joko"
ensure_private_dir "$home/.joko/runtime"
ensure_private_dir "$home/.joko/runtime/v1"
ensure_private_dir "$root"
ensure_private_dir "$root/profile"
ensure_private_dir "$root/tmp"
ensure_private_dir "$root/run"
for managed_entry in "$lock" "$stage" "$next" "$previous" "$root/current" "$sentinel"; do
  [ ! -L "$managed_entry" ] || exit 22
done
for managed_directory in "$stage" "$next" "$previous" "$root/current"; do
  [ ! -e "$managed_directory" ] || [ -d "$managed_directory" ] || exit 22
done
process_birth() {
  candidate=$1
  if [ -r "/proc/$candidate/stat" ]; then
    sed 's/^.*) //' "/proc/$candidate/stat" 2>/dev/null | awk '{print "linux:" $20}'
  else
    ps -p "$candidate" -o lstart= -o comm= 2>/dev/null | sed 's/^[[:space:]]*/posix:/'
  fi
}
if ! mkdir "$lock" 2>/dev/null; then
  lock_pid=$(cat "$lock/pid" 2>/dev/null || true)
  case "$lock_pid" in ''|*[!0-9]*) lock_pid=0 ;; esac
  lock_birth=$(cat "$lock/birth" 2>/dev/null || true)
  current_birth=""
  if [ "$lock_pid" -gt 0 ]; then current_birth=$(process_birth "$lock_pid"); fi
  if [ -n "$lock_birth" ] && [ "$current_birth" = "$lock_birth" ]; then printf '%s\\n' JOKO_BUSY; exit 73; fi
  rm -rf "$lock"
  mkdir "$lock" || { printf '%s\\n' JOKO_BUSY; exit 73; }
fi
printf '%s\\n' "$$" > "$lock/pid"
self_birth=$(process_birth "$$")
[ -n "$self_birth" ] || { rm -rf "$lock"; exit 74; }
printf '%s\\n' "$self_birth" > "$lock/birth"
old_moved=0
new_moved=0
success=0
cleanup() {
  if [ "$success" -ne 1 ]; then
    if [ "$new_moved" -eq 1 ]; then rm -rf "$root/current"; fi
    if [ "$old_moved" -eq 1 ] && [ -e "$previous" ]; then mv "$previous" "$root/current" 2>/dev/null || true; fi
  fi
  rm -rf "$stage" "$next"
  if [ "$success" -eq 1 ]; then rm -rf "$previous"; fi
  rm -rf "$lock"
}
trap cleanup EXIT HUP INT TERM
printf '%s\\n' 'JOKO_PHASE probing'
if [ ! -e "$root/current" ] && [ -e "$previous" ]; then mv "$previous" "$root/current"; fi
rm -rf "$stage" "$next"
if [ -e "$root/current" ]; then rm -rf "$previous"; fi
mkdir -p "$stage/current/node" "$stage/home"
os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
arch=$(uname -m 2>/dev/null)
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) exit 31 ;; esac
case "$os" in linux) platform="linux-$arch" ;; darwin) platform="darwin-$arch" ;; *) exit 32 ;; esac
case "$platform" in
${checksumCases}
*) exit 33 ;;
esac
printf '%s\\n' 'JOKO_PHASE downloading'
if ! curl -fsSL --connect-timeout 30 --max-time 240 -o "$stage/node.tar.gz" "${NODE_BASE_URL}/$archive" >/dev/null 2>&1; then exit 41; fi
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/node.tar.gz" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$stage/node.tar.gz" | awk '{print $1}');
else exit 42; fi
[ "$actual" = "$checksum" ] || exit 43
tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/current/node" || exit 44
[ "$(env -i HOME="$stage/home" PATH="$stage/current/node/bin:/usr/bin:/bin" \
  "$stage/current/node/bin/node" -p 'process.versions.node' 2>/dev/null || true)" = "${REMOTE_CLAUDE_NODE_VERSION}" ] || exit 45
printf '%s\\n' 'JOKO_PHASE installing'
printf '%s\\n' '{"private":true,"type":"module","dependencies":{"@anthropic-ai/claude-agent-sdk":"${CLAUDE_AGENT_SDK_VERSION}","@anthropic-ai/sdk":"0.120.0","@modelcontextprotocol/sdk":"1.29.0","zod":"4.4.3"}}' > "$stage/current/package.json"
env -i HOME="$stage/home" PATH="$stage/current/node/bin:/usr/bin:/bin" \
  "$stage/current/node/bin/npm" --prefix "$stage/current" install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact >/dev/null 2>&1 || exit 46
printf '%s' '${managerBase64}' | env -i HOME="$stage/home" PATH="$stage/current/node/bin:/usr/bin:/bin" \
  "$stage/current/node/bin/node" -e \
  "let s='';process.stdin.setEncoding('ascii');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(Buffer.from(s,'base64')))" \
  > "$stage/current/manager.mjs" || exit 47
chmod 600 "$stage/current/manager.mjs"
if command -v sha256sum >/dev/null 2>&1; then manager_hash=$(sha256sum "$stage/current/manager.mjs" | awk '{print $1}');
else manager_hash=$(shasum -a 256 "$stage/current/manager.mjs" | awk '{print $1}'); fi
[ "$manager_hash" = "${managerSha256}" ] || exit 48
set -- "$stage/current/node_modules/@anthropic-ai"/claude-agent-sdk-*/claude
[ "$#" -eq 1 ] && [ -x "$1" ] || exit 49
[ "$(env -i HOME="$stage/home" PATH="$stage/current/node/bin:/usr/bin:/bin" TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp" \
  CLAUDE_CONFIG_DIR="$stage/home" CLAUDE_CODE_TMPDIR="$root/tmp" "$1" --version 2>/dev/null || true)" = "${REMOTE_CLAUDE_CLI_VERSION} (Claude Code)" ] || exit 50
[ "$(cd "$stage/current" && env -i HOME="$stage/home" PATH="$stage/current/node/bin:/usr/bin:/bin" \
  "$stage/current/node/bin/node" -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || true)" = "${CLAUDE_AGENT_SDK_VERSION}" ] || exit 51
[ "$(env -i HOME="$root/profile" PATH="$stage/current/node/bin:/usr/bin:/bin" TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp" \
  CLAUDE_CONFIG_DIR="$root/profile" CLAUDE_CODE_TMPDIR="$root/tmp" JOKO_CLAUDE_RUNTIME_ROOT="$root" JOKO_CLAUDE_EXECUTABLE="$1" \
  "$stage/current/node/bin/node" "$stage/current/manager.mjs" --version 2>/dev/null || true)" = '{"managerVersion":"${REMOTE_CLAUDE_MANAGER_VERSION}","protocolVersion":${REMOTE_CLAUDE_PROTOCOL_VERSION},"managerSha256":"${managerSha256}"}' ] || exit 52
mv "$stage/current" "$next"
if [ -e "$root/current" ]; then old_moved=1; mv "$root/current" "$previous"; fi
new_moved=1
mv "$next" "$root/current"
printf '%s\\n' 'JOKO_PHASE validating'
printf '%s\\n' '${expectedSentinel}' > "$root/.joko-runtime-ready-v1.tmp"
mv "$root/.joko-runtime-ready-v1.tmp" "$sentinel"
chmod 700 "$root" "$root/profile" "$root/tmp" "$root/run"
printf '%s\\n' 'JOKO_PHASE complete'
success=1`;
}

interface RemoteCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input?: string | Buffer;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: Buffer) => void;
}

async function runRemoteCommand(
  processes: RemoteProcessTransportPort,
  input: RemoteCommandInput
): Promise<{ readonly stdout: Buffer; readonly exitCode: number | null }> {
  if (input.signal?.aborted) throw cancelledFault(false);
  const lifetime = new AbortController();
  const onOpenAbort = (): void => lifetime.abort();
  input.signal?.addEventListener("abort", onOpenAbort, { once: true });
  let handle: RemoteProcessHandle;
  try {
    handle = await processes.open({
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      signal: lifetime.signal
    });
  } catch {
    input.signal?.removeEventListener("abort", onOpenAbort);
    if (input.signal?.aborted) throw cancelledFault(false);
    throw installationFault("The remote Claude command could not be started.");
  }
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(installationFault("The remote Claude command timed out.", true)), input.timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      input.signal?.removeEventListener("abort", onOpenAbort);
      handle.stdout.removeListener("data", onData);
      handle.stdout.removeListener("error", onStreamError);
      handle.stderr.removeListener("error", onStreamError);
      handle.stdin.removeListener("error", onStreamError);
    };
    const fail = (error: RemoteClaudeInstallationError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      lifetime.abort();
      try { handle.kill("SIGTERM"); } catch { /* The channel may already be closed. */ }
      reject(error);
    };
    const abort = (): void => fail(cancelledFault(true));
    const onStreamError = (): void => fail(installationFault("The remote Claude command stream failed.", true));
    const onData = (chunk: Buffer | string): void => {
      const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_COMMAND_OUTPUT_BYTES) return fail(installationFault("The remote Claude command exceeded its output limit.", true));
      chunks.push(Buffer.from(value));
      try { input.onStdout?.(value); }
      catch { fail(installationFault("The remote Claude installer emitted invalid progress.", true)); }
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    handle.stdout.on("data", onData);
    handle.stdout.once("error", onStreamError);
    handle.stderr.once("error", onStreamError);
    handle.stdin.once("error", onStreamError);
    handle.stderr.resume();
    handle.once("error", onStreamError);
    handle.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode }));
    });
    try { handle.stdin.end(input.input); }
    catch { fail(installationFault("The remote Claude command stream failed.", true)); }
    if (input.signal?.aborted) abort();
    else if (handle.exitCode !== null) {
      settled = true;
      cleanup();
      resolvePromise(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode: handle.exitCode }));
    }
  });
}

function normalizedAbsoluteRemotePath(value: string): boolean {
  return value.length > 0
    && value.length <= 16_384
    && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && remotePath.isAbsolute(value)
    && remotePath.normalize(value) === value;
}

function nulFields(value: Buffer, count: number): string[] {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(decodeUtf8(value.subarray(offset, index)));
    offset = index + 1;
  }
  if (fields.length !== count || offset !== value.byteLength) {
    throw installationFault("The remote Claude runtime probe returned invalid metadata.");
  }
  return fields;
}

function decodeUtf8(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw installationFault("The remote Claude runtime probe returned invalid metadata."); }
}

function installationFault(message: string, stateMayHaveChanged = false): RemoteClaudeInstallationError {
  return new RemoteClaudeInstallationError("command_failed", message, { stateMayHaveChanged });
}

function cancelledFault(stateMayHaveChanged: boolean): RemoteClaudeInstallationError {
  return new RemoteClaudeInstallationError("cancelled", "The remote Claude command was cancelled.", { stateMayHaveChanged });
}
