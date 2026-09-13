import { posix as remotePath } from "node:path";
import { TextDecoder } from "node:util";

import type { RemoteProcessHandle, RemoteProcessTransportPort } from "@joko/remote-ssh";

export const REMOTE_CODEX_EXPECTED_VERSION = "0.153.4";
export const REMOTE_CODEX_EXPECTED_VERSION_OUTPUT = `codex-cli ${REMOTE_CODEX_EXPECTED_VERSION}`;
export const REMOTE_CODEX_PROFILE_SUFFIX = ".joko/runtime/v1/codex-home";
export const REMOTE_CODEX_BINARY_SUFFIX = `${REMOTE_CODEX_PROFILE_SUFFIX}/packages/standalone/current/codex`;
export const REMOTE_CODEX_SENTINEL_SUFFIX = `${REMOTE_CODEX_PROFILE_SUFFIX}/.joko-runtime-ready-v1`;

const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const UNINSTALL_TIMEOUT_MS = 10_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 64 * 1_024;
const SENTINEL_VALUE = `joko-codex-runtime-v1:${REMOTE_CODEX_EXPECTED_VERSION}`;
const RELEASE_INSTALLER_URL = `https://github.com/openai/codex/releases/download/rust-v${REMOTE_CODEX_EXPECTED_VERSION}/install.sh`;

const RUNTIME_PROBE_SCRIPT = `set -eu
workspace=$(pwd -P)
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
profile="$home/${REMOTE_CODEX_PROFILE_SUFFIX}"
binary="$home/${REMOTE_CODEX_BINARY_SUFFIX}"
sentinel="$home/${REMOTE_CODEX_SENTINEL_SUFFIX}"
version=""
if [ -x "$binary" ]; then
  version=$("$binary" --version 2>/dev/null || true)
fi
state=not_installed
if [ -f "$sentinel" ] && [ "$(cat "$sentinel" 2>/dev/null || true)" = "${SENTINEL_VALUE}" ] && [ "$version" = "${REMOTE_CODEX_EXPECTED_VERSION_OUTPUT}" ]; then
  state=ready
fi
printf '%s\\0%s\\0%s\\0%s\\0%s\\0' "$workspace" "$profile" "$binary" "$version" "$state"`;

// The upstream installer is run with HOME redirected below the staging tree.
// It therefore cannot append its PATH block to the SSH user's shell profiles.
const INSTALL_SCRIPT = `set -eu
umask 077
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
profile="$home/${REMOTE_CODEX_PROFILE_SUFFIX}"
binary="$home/${REMOTE_CODEX_BINARY_SUFFIX}"
sentinel="$home/${REMOTE_CODEX_SENTINEL_SUFFIX}"
lock="$profile/.joko-install-lock"
stage="$profile/.joko-install-stage"
next="$profile/.joko-next-packages"
previous="$profile/.joko-previous-packages"
reinstall=\${1-0}
mkdir -p "$profile"
if ! mkdir "$lock" 2>/dev/null; then
  lock_pid=$(cat "$lock/pid" 2>/dev/null || true)
  case "$lock_pid" in ''|*[!0-9]*) lock_pid=0 ;; esac
  if [ "$lock_pid" -gt 0 ] && kill -0 "$lock_pid" 2>/dev/null; then
    printf '%s\\n' 'JOKO_BUSY'
    exit 73
  fi
  rm -rf "$lock"
  mkdir "$lock" || { printf '%s\\n' 'JOKO_BUSY'; exit 73; }
fi
printf '%s\\n' "$$" > "$lock/pid"
old_moved=0
new_moved=0
success=0
cleanup() {
  if [ "$success" -ne 1 ]; then
    if [ "$new_moved" -eq 1 ]; then rm -rf "$profile/packages"; fi
    if [ "$old_moved" -eq 1 ] && [ -e "$previous" ]; then mv "$previous" "$profile/packages" 2>/dev/null || true; fi
  fi
  rm -rf "$stage" "$next"
  if [ "$success" -eq 1 ]; then rm -rf "$previous"; fi
  rm -rf "$lock"
}
trap cleanup EXIT HUP INT TERM
printf '%s\\n' 'JOKO_PHASE probing'
current_version=""
if [ -x "$binary" ]; then current_version=$("$binary" --version 2>/dev/null || true); fi
if [ "$reinstall" != "1" ] && [ -f "$sentinel" ] && [ "$(cat "$sentinel" 2>/dev/null || true)" = "${SENTINEL_VALUE}" ] && [ "$current_version" = "${REMOTE_CODEX_EXPECTED_VERSION_OUTPUT}" ]; then
  printf '%s\\n' 'JOKO_PHASE validating'
  printf '%s\\n' 'JOKO_PHASE complete'
  success=1
  exit 0
fi
if [ ! -e "$profile/packages" ] && [ -e "$previous" ]; then mv "$previous" "$profile/packages"; fi
rm -rf "$stage" "$next"
if [ -e "$profile/packages" ]; then rm -rf "$previous"; fi
mkdir -p "$stage/home" "$stage/codex-home" "$stage/bin"
printf '%s\\n' 'JOKO_PHASE downloading'
if ! curl -fsSL --connect-timeout 30 --max-time 120 -o "$stage/install.sh" '${RELEASE_INSTALLER_URL}' >/dev/null 2>&1; then
  exit 41
fi
[ -s "$stage/install.sh" ] || exit 42
printf '%s\\n' 'JOKO_PHASE installing'
if ! env HOME="$stage/home" CODEX_HOME="$stage/codex-home" CODEX_INSTALL_DIR="$stage/bin" CODEX_NON_INTERACTIVE=1 sh "$stage/install.sh" --release '${REMOTE_CODEX_EXPECTED_VERSION}' >/dev/null 2>&1; then
  exit 43
fi
staged_binary="$stage/codex-home/packages/standalone/current/codex"
[ -x "$staged_binary" ] || exit 44
[ "$("$staged_binary" --version 2>/dev/null || true)" = "${REMOTE_CODEX_EXPECTED_VERSION_OUTPUT}" ] || exit 45
mv "$stage/codex-home/packages" "$next"
if [ -e "$profile/packages" ]; then
  mv "$profile/packages" "$previous"
  old_moved=1
fi
mv "$next" "$profile/packages"
new_moved=1
printf '%s\\n' 'JOKO_PHASE validating'
[ -x "$binary" ] || exit 46
[ "$("$binary" --version 2>/dev/null || true)" = "${REMOTE_CODEX_EXPECTED_VERSION_OUTPUT}" ] || exit 47
printf '%s\\n' '${SENTINEL_VALUE}' > "$profile/.joko-runtime-ready-v1.tmp"
mv "$profile/.joko-runtime-ready-v1.tmp" "$sentinel"
printf '%s\\n' 'JOKO_PHASE complete'
success=1`;

const UNINSTALL_SCRIPT = `set -eu
home=\${HOME-}
case "$home" in /*) ;; *) exit 20 ;; esac
profile="$home/${REMOTE_CODEX_PROFILE_SUFFIX}"
sentinel="$home/${REMOTE_CODEX_SENTINEL_SUFFIX}"
[ ! -d "$profile/.joko-install-lock" ] || exit 73
rm -f "$sentinel"`;

export type RemoteCodexInstallPhase = "probing" | "downloading" | "installing" | "validating" | "complete";

export interface RemoteCodexInstallationProbe {
  readonly state: "ready" | "not_installed";
  readonly workspaceRoot: string;
  readonly profileRoot: string;
  readonly executable: string;
  readonly installedVersion?: string;
}

export class RemoteCodexInstallationError extends Error {
  readonly code: "busy" | "command_failed" | "cancelled";
  readonly stateMayHaveChanged: boolean;

  constructor(
    code: RemoteCodexInstallationError["code"],
    message: string,
    options?: { readonly stateMayHaveChanged?: boolean }
  ) {
    super(message);
    this.name = "RemoteCodexInstallationError";
    this.code = code;
    this.stateMayHaveChanged = options?.stateMayHaveChanged === true;
  }
}

export async function probeRemoteCodexInstallation(
  processes: RemoteProcessTransportPort,
  workspaceRoot: string,
  assertCurrent: () => void,
  signal?: AbortSignal
): Promise<RemoteCodexInstallationProbe> {
  if (!normalizedAbsoluteRemotePath(workspaceRoot)) throw installationFault("The remote Codex workspace path is invalid.");
  assertCurrent();
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-c", RUNTIME_PROBE_SCRIPT],
    cwd: workspaceRoot,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal
  });
  assertCurrent();
  if (result.exitCode !== 0) throw installationFault("The fixed remote Codex runtime probe failed.");
  const fields = nulFields(result.stdout, 5);
  const canonicalWorkspace = fields[0]!;
  const profileRoot = fields[1]!;
  const executable = fields[2]!;
  const installedVersion = fields[3]!;
  const state = fields[4]!;
  if (!normalizedAbsoluteRemotePath(canonicalWorkspace)
    || !normalizedAbsoluteRemotePath(profileRoot)
    || !normalizedAbsoluteRemotePath(executable)
    || executable !== remotePath.join(profileRoot, "packages", "standalone", "current", "codex")
    || (state !== "ready" && state !== "not_installed")
    || (state === "ready" && installedVersion !== REMOTE_CODEX_EXPECTED_VERSION_OUTPUT)) {
    throw installationFault("The fixed remote Codex runtime probe returned invalid metadata.");
  }
  return Object.freeze({
    state,
    workspaceRoot: canonicalWorkspace,
    profileRoot,
    executable,
    ...(installedVersion === "" ? {} : { installedVersion: versionValue(installedVersion) })
  });
}

export async function installRemoteCodex(
  processes: RemoteProcessTransportPort,
  options: {
    readonly reinstall: boolean;
    readonly assertCurrent: () => void;
    readonly signal?: AbortSignal;
    readonly onPhase?: (phase: RemoteCodexInstallPhase) => void;
  }
): Promise<RemoteCodexInstallationProbe> {
  options.assertCurrent();
  let lineBuffer = "";
  const seen = new Set<RemoteCodexInstallPhase>();
  const acceptOutput = (chunk: Buffer): void => {
    lineBuffer += chunk.toString("utf8");
    if (lineBuffer.length > 1_024) throw installationFault("The remote Codex installer emitted invalid progress.", true);
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^JOKO_PHASE (probing|downloading|installing|validating|complete)$/u.exec(line.trim());
      if (match?.[1] === undefined) continue;
      const phase = match[1] as RemoteCodexInstallPhase;
      if (!seen.has(phase)) {
        seen.add(phase);
        options.onPhase?.(phase);
      }
    }
  };
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-s", "--", options.reinstall ? "1" : "0"],
    cwd: "/",
    input: INSTALL_SCRIPT,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal: options.signal,
    onStdout: acceptOutput
  });
  options.assertCurrent();
  if (result.exitCode === 73 || result.stdout.includes(Buffer.from("JOKO_BUSY", "utf8"))) {
    throw new RemoteCodexInstallationError("busy", "The remote Codex runtime installer is already active.");
  }
  if (result.exitCode !== 0) throw installationFault("The fixed remote Codex runtime installation failed.", true);
  const installed = await probeRemoteCodexInstallation(processes, "/", options.assertCurrent, options.signal);
  if (installed.state !== "ready") throw installationFault("The fixed remote Codex runtime did not validate after installation.", true);
  return installed;
}

export async function uninstallRemoteCodex(
  processes: RemoteProcessTransportPort,
  assertCurrent: () => void,
  signal?: AbortSignal
): Promise<RemoteCodexInstallationProbe> {
  assertCurrent();
  const result = await runRemoteCommand(processes, {
    executable: "/bin/sh",
    args: ["-c", UNINSTALL_SCRIPT],
    cwd: "/",
    timeoutMs: UNINSTALL_TIMEOUT_MS,
    signal
  });
  assertCurrent();
  if (result.exitCode === 73) throw new RemoteCodexInstallationError("busy", "The remote Codex runtime installer is already active.");
  if (result.exitCode !== 0) throw installationFault("The fixed remote Codex runtime uninstall marker could not be removed.", true);
  const probe = await probeRemoteCodexInstallation(processes, "/", assertCurrent, signal);
  if (probe.state !== "not_installed") throw installationFault("The fixed remote Codex runtime remained admitted after uninstall.", true);
  return probe;
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
    throw installationFault("The remote Codex command could not be started.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(installationFault("The remote Codex command timed out.", true)), input.timeoutMs);
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
    const fail = (error: RemoteCodexInstallationError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      lifetime.abort();
      try { handle.kill("SIGTERM"); } catch { /* The channel may already be closed. */ }
      reject(error);
    };
    const abort = (): void => fail(cancelledFault(true));
    const onStreamError = (): void => fail(installationFault("The remote Codex command stream failed.", true));
    const onData = (chunk: Buffer | string): void => {
      const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_COMMAND_OUTPUT_BYTES) {
        fail(installationFault("The remote Codex command exceeded its output limit.", true));
        return;
      }
      chunks.push(Buffer.from(value));
      try {
        input.onStdout?.(value);
      } catch {
        fail(installationFault("The remote Codex installer emitted invalid progress.", true));
      }
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
      resolve(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode }));
    });
    try {
      handle.stdin.end(input.input);
    } catch {
      fail(installationFault("The remote Codex command stream failed.", true));
    }
    if (input.signal?.aborted) abort();
    else if (handle.exitCode !== null) {
      settled = true;
      cleanup();
      resolve(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode: handle.exitCode }));
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
    throw installationFault("The remote Codex runtime probe returned invalid metadata.");
  }
  return fields;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw installationFault("The remote Codex runtime probe returned invalid metadata.");
  }
}

function versionValue(output: string): string {
  const match = /^codex-cli ([0-9A-Za-z][0-9A-Za-z.+-]{0,63})$/u.exec(output);
  if (match?.[1] === undefined) throw installationFault("The fixed remote Codex runtime reported an invalid version.");
  return match[1];
}

function installationFault(message: string, stateMayHaveChanged = false): RemoteCodexInstallationError {
  return new RemoteCodexInstallationError("command_failed", message, { stateMayHaveChanged });
}

function cancelledFault(stateMayHaveChanged: boolean): RemoteCodexInstallationError {
  return new RemoteCodexInstallationError("cancelled", "The remote Codex command was cancelled.", { stateMayHaveChanged });
}
