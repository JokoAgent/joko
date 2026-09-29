import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync
} from "node:fs";
import { relative, resolve } from "node:path";

const BUILDER_IGNORED_NAMES = new Set([".DS_Store", ".gitkeep"]);
const COMPARE_BUFFER_BYTES = 128 * 1024;

export async function finalizeSmokeRun(options) {
  let failure;
  let payload;
  try {
    payload = await options.runJourney();
  } catch (error) {
    failure = normalizeError(error);
  }

  const retainFailure = failure !== undefined && options.retainFailure === true;
  if (retainFailure) {
    options.reportRetained();
  } else {
    try {
      await options.cleanupTemporaryDirectory();
    } catch (error) {
      const cleanupError = normalizeError(error);
      failure = failure === undefined
        ? cleanupError
        : new AggregateError(
          [failure, cleanupError],
          "Packaged desktop smoke failed and its temporary directory could not be removed."
        );
    }
  }

  if (failure !== undefined) throw failure;
  await options.emitSuccess(payload);
  return payload;
}

export function canonicalSmokeDirectoryForRemoval(directory, temporaryRoot) {
  if (!existsSync(directory)) return undefined;
  const resolvedDirectory = resolve(directory);
  const lexicalInfo = lstatSync(resolvedDirectory);
  const canonicalTemporaryRoot = realpathSync(resolve(temporaryRoot));
  const canonicalParent = realpathSync(resolve(resolvedDirectory, ".."));
  const canonicalDirectory = realpathSync(resolvedDirectory);
  const relativeDirectory = relative(canonicalTemporaryRoot, canonicalDirectory).replaceAll("\\", "/");
  if (!lexicalInfo.isDirectory() || lexicalInfo.isSymbolicLink() ||
    !samePath(canonicalParent, canonicalTemporaryRoot) ||
    !/^joko-desktop-smoke-[^/]+$/u.test(relativeDirectory) ||
    !pathContained(canonicalTemporaryRoot, canonicalDirectory)) {
    throw new Error(`Refusing to remove an unsafe Desktop smoke directory: ${canonicalDirectory}`);
  }
  return canonicalDirectory;
}

export function compareConfiguredExtraResourceMirrors(options) {
  if (!Array.isArray(options.extraResources)) {
    throw new Error("Desktop builder extraResources must be an array for artifact freshness validation.");
  }
  const expected = new Map();
  const ownedDirectories = [];
  const ownedFiles = [];
  for (const fileSet of options.extraResources) {
    if (typeof fileSet?.from !== "string" || typeof fileSet?.to !== "string" ||
      (fileSet.filter !== undefined && (!Array.isArray(fileSet.filter) ||
        fileSet.filter.some((pattern) => typeof pattern !== "string")))) {
      throw new Error("Desktop builder extraResources contains an unsupported file set.");
    }
    const source = resolve(options.applicationRoot, fileSet.from);
    const artifact = resolve(options.artifactResourcesRoot, fileSet.to);
    if (!pathContained(options.applicationRoot, source) || !pathContained(options.artifactResourcesRoot, artifact)) {
      throw new Error("Desktop builder extraResources contains a path outside its owned root.");
    }
    const sourceInfo = canonicalEntry(source, "source");
    if (sourceInfo.isFile()) {
      const label = normalizedPath(fileSet.to);
      addExpectedFile(expected, label, source);
      ownedFiles.push(label);
      continue;
    }
    if (!sourceInfo.isDirectory()) {
      throw new Error(`Desktop extraResource source is not a file or directory: ${source}`);
    }
    const labelRoot = normalizedPath(fileSet.to).replace(/\/$/u, "");
    ownedDirectories.push(labelRoot);
    for (const path of collectFilteredSourceFiles(source, fileSet.filter ?? [])) {
      addExpectedFile(expected, joinedLabel(labelRoot, path), resolve(source, path));
    }
  }
  const actual = collectOwnedArtifactFiles(
    options.artifactResourcesRoot,
    ownedDirectories,
    ownedFiles
  );
  const report = { missing: [], unexpected: [], changed: [] };
  for (const [label, source] of expected) {
    const artifact = actual.get(label);
    if (artifact === undefined) report.missing.push(label);
    else if (artifact.unsafe || !filesHaveEqualContents(source, artifact.path)) report.changed.push(label);
  }
  for (const label of actual.keys()) {
    if (!expected.has(label)) report.unexpected.push(label);
  }
  report.missing.sort();
  report.unexpected.sort();
  report.changed.sort();
  return report;
}

export function comparePackagedApplicationMirror(sourceRoot, artifactRoot) {
  const expected = new Map();
  for (const path of collectExpectedApplicationFiles(sourceRoot)) {
    expected.set(path, resolve(sourceRoot, path));
  }
  const actual = new Map();
  if (existsSync(artifactRoot)) {
    const info = canonicalEntry(artifactRoot, "packaged application mirror root");
    if (!info.isDirectory()) throw new Error(`Desktop packaged application mirror is not a directory: ${artifactRoot}`);
    collectActualDirectory(actual, artifactRoot, artifactRoot);
  }
  const report = { missing: [], unexpected: [], changed: [] };
  for (const [path, source] of expected) {
    const artifact = actual.get(path);
    if (artifact === undefined) report.missing.push(path);
    else if (artifact.unsafe || !filesHaveEqualContents(source, artifact.path)) report.changed.push(path);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) report.unexpected.push(path);
  }
  report.missing.sort();
  report.unexpected.sort();
  report.changed.sort();
  return report;
}

export function filesHaveEqualContents(leftPath, rightPath) {
  const left = canonicalEntry(leftPath, "freshness input");
  const right = canonicalEntry(rightPath, "freshness input");
  if (!left.isFile() || !right.isFile()) {
    throw new Error("Desktop freshness comparison inputs must be canonical regular files.");
  }
  if (left.size !== right.size) return false;
  let leftDescriptor;
  let rightDescriptor;
  const leftBuffer = Buffer.allocUnsafe(COMPARE_BUFFER_BYTES);
  const rightBuffer = Buffer.allocUnsafe(COMPARE_BUFFER_BYTES);
  try {
    leftDescriptor = openSync(leftPath, "r");
    rightDescriptor = openSync(rightPath, "r");
    let position = 0;
    while (position < left.size) {
      const requested = Math.min(COMPARE_BUFFER_BYTES, left.size - position);
      const leftBytes = readExact(leftDescriptor, leftBuffer, requested, position);
      const rightBytes = readExact(rightDescriptor, rightBuffer, requested, position);
      if (leftBytes !== requested || rightBytes !== requested ||
        !leftBuffer.subarray(0, requested).equals(rightBuffer.subarray(0, requested))) return false;
      position += requested;
    }
    return true;
  } finally {
    if (leftDescriptor !== undefined) closeSync(leftDescriptor);
    if (rightDescriptor !== undefined) closeSync(rightDescriptor);
  }
}

function readExact(descriptor, buffer, requested, position) {
  let total = 0;
  while (total < requested) {
    const count = readSync(descriptor, buffer, total, requested - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return total;
}

export function matchesBuilderFileSet(relativePath, filters) {
  const normalized = normalizedPath(relativePath);
  const positive = filters.filter((pattern) => !pattern.startsWith("!"));
  if (positive.length > 0 && !positive.some((pattern) => matchesGlob(normalized, pattern))) return false;
  return !filters.some((pattern) => pattern.startsWith("!") && matchesGlob(normalized, pattern.slice(1)));
}

export function parseManagedRuntimeProcessMarker(source, currentProcessId = process.pid) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error("Packaged smoke managed Orchestrator runtime process marker is malformed.", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "pid,processIdentity,serverId,version" ||
    value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0xffff_ffff ||
    value.pid === currentProcessId || typeof value.processIdentity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.processIdentity) ||
    typeof value.serverId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value.serverId)) {
    throw new Error("Packaged smoke managed Orchestrator runtime process marker is malformed.");
  }
  return Object.freeze({
    version: 1,
    pid: value.pid,
    processIdentity: value.processIdentity,
    serverId: value.serverId
  });
}

export function primaryChildExitError(options) {
  const code = options.outcome?.code;
  const signal = options.outcome?.signal;
  if (code !== 0 || signal !== null) {
    return new Error(
      `Primary Desktop smoke exited before completion (code=${String(code)}, signal=${String(signal)}).`
    );
  }
  const completed = options.marker === "JOKO_DESKTOP_SMOKE_OK" &&
    options.requiredProgress.every((step) => options.progress.includes(step));
  return completed
    ? undefined
    : new Error("Primary Desktop smoke exited before its required journey evidence was complete.");
}

export function claimSmokeJourneyFailure(options) {
  if (!["primary", "second-instance", "timeout", "orchestration"].includes(options.source)) {
    throw new Error(`Unsupported packaged smoke failure source: ${String(options.source)}`);
  }
  const failure = normalizeError(options.failure);
  if (options.abortController.signal.aborted) {
    return {
      failure: authoritativeSmokeJourneyError(options.abortController.signal, failure),
      ownsAbort: false,
      terminatePrimary: false,
      timedOut: false
    };
  }
  options.abortController.abort(failure);
  return {
    failure,
    ownsAbort: true,
    terminatePrimary: options.source === "second-instance" || options.source === "timeout",
    timedOut: options.source === "timeout"
  };
}

export function authoritativeSmokeJourneyError(signal, fallback) {
  if (signal.aborted) return normalizeError(signal.reason);
  return fallback === undefined ? undefined : normalizeError(fallback);
}

export function applyPrimaryChildExitFence(options) {
  const failure = primaryChildExitError(options);
  if (failure === undefined) {
    return { failure, ownsAbort: false };
  }
  const decision = claimSmokeJourneyFailure({
    abortController: options.abortController,
    failure,
    source: "primary"
  });
  return { failure, ownsAbort: decision.ownsAbort };
}

export function observePrimaryChild(child, onExit, drainTimeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let closeFallback;
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      if (closeFallback !== undefined) clearTimeout(closeFallback);
      operation();
    };
    child.once("error", (error) => settle(() => reject(
      new Error("Packaged Desktop smoke could not start.", { cause: error })
    )));
    child.once("exit", (code, signal) => {
      onExit?.({ code, signal });
      // The primary exit is already authoritative at this point. Leave the
      // inherited pipes untouched while Chromium descendants drain them; the
      // caller performs tree cleanup only after close or this bounded wait.
      closeFallback = setTimeout(
        () => settle(() => resolvePromise({ code, signal })),
        drainTimeoutMs
      );
      closeFallback.unref?.();
    });
    child.once("close", (code, signal) => settle(() => resolvePromise({ code, signal })));
  });
}

export function managedRuntimeCleanupDecision(endpoint, processIdentity) {
  if (!["matchedLive", "mismatchedLive", "stopped", "unreachable"].includes(endpoint)) {
    throw new Error(`Unsupported managed runtime endpoint state: ${String(endpoint)}`);
  }
  if (processIdentity === "matched") return "terminate";
  if (processIdentity === "absent") {
    return endpoint === "matchedLive" || endpoint === "mismatchedLive" ? "identityFailure" : "complete";
  }
  if (processIdentity === "mismatched" || processIdentity === "unavailable") return "identityFailure";
  throw new Error(`Unsupported managed runtime process identity state: ${String(processIdentity)}`);
}

/**
 * Performs one externally supplied process effect only after two consecutive
 * synchronous birth-identity checks. Tests inject a harmless effect; the
 * packaged runner injects the platform tree termination primitive.
 */
export async function runIdentityFencedProcessEffect(options) {
  const first = options.captureIdentity(options.pid);
  if (first === undefined) return "notRunning";
  if (first !== options.expectedIdentity) return "identityMismatch";
  const second = options.captureIdentity(options.pid);
  if (second === undefined) return "notRunning";
  if (second !== options.expectedIdentity) return "identityMismatch";
  await options.effect(options.pid);
  return "effectApplied";
}

function collectFilteredSourceFiles(root, filters) {
  const info = canonicalEntry(root, "extraResource mirror root");
  if (!info.isDirectory()) throw new Error(`Desktop extraResource mirror root is not a directory: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (BUILDER_IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      const relativePath = normalizedPath(relative(root, absolutePath));
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          throw new Error(`Desktop extraResource mirror contains a symbolic-link directory: ${absolutePath}`);
        }
        visit(absolutePath);
        continue;
      }
      if (!matchesBuilderFileSet(relativePath, filters)) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !canonicalRegularFileExists(absolutePath)) {
        throw new Error(`Desktop extraResource mirror input is not a canonical regular file: ${absolutePath}`);
      }
      files.push(relativePath);
    }
  };
  visit(root);
  return files.sort();
}

function collectExpectedApplicationFiles(root) {
  const info = canonicalEntry(root, "compiled Desktop application directory");
  if (!info.isDirectory()) throw new Error(`The compiled Desktop application path is not a directory: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (BUILDER_IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      const relativePath = normalizedPath(relative(root, absolutePath));
      const topLevelName = relativePath.split("/", 1)[0];
      if (entry.isDirectory()) {
        if (topLevelName === "orchestrator-runtime" || topLevelName?.startsWith(".orchestrator-runtime-")) continue;
        if (entry.isSymbolicLink()) {
          throw new Error(`Compiled Desktop application contains a symbolic-link directory: ${absolutePath}`);
        }
        visit(absolutePath);
        continue;
      }
      const included = (topLevelName === "web" && !relativePath.endsWith(".map")) || /\.(?:cjs|js)$/u.test(relativePath);
      if (!included) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !canonicalRegularFileExists(absolutePath)) {
        throw new Error(`Compiled Desktop application input is not a canonical regular file: ${absolutePath}`);
      }
      files.push(relativePath);
    }
  };
  visit(root);
  return files.sort();
}

function collectOwnedArtifactFiles(artifactResourcesRoot, directoryLabels, fileLabels) {
  const actual = new Map();
  const topLevelDirectories = [...new Set(directoryLabels)].filter((candidate, _index, all) =>
    !all.some((other) => other !== candidate && pathLabelContained(other, candidate))
  );
  for (const labelRoot of topLevelDirectories) {
    const absoluteRoot = resolve(artifactResourcesRoot, labelRoot);
    if (!existsSync(absoluteRoot)) continue;
    const rootInfo = lstatSync(absoluteRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(realpathSync(absoluteRoot), absoluteRoot)) {
      actual.set(labelRoot, { path: absoluteRoot, unsafe: true });
      continue;
    }
    collectActualDirectory(actual, artifactResourcesRoot, absoluteRoot);
  }
  for (const label of new Set(fileLabels)) {
    if (topLevelDirectories.some((directory) => pathLabelContained(directory, label))) continue;
    const absolutePath = resolve(artifactResourcesRoot, label);
    if (!existsSync(absolutePath)) continue;
    actual.set(label, {
      path: absolutePath,
      unsafe: !canonicalRegularFileExists(absolutePath)
    });
  }
  return actual;
}

function collectActualDirectory(actual, artifactResourcesRoot, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    const label = normalizedPath(relative(artifactResourcesRoot, absolutePath));
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectActualDirectory(actual, artifactResourcesRoot, absolutePath);
      continue;
    }
    actual.set(label, {
      path: absolutePath,
      unsafe: !entry.isFile() || entry.isSymbolicLink() || !canonicalRegularFileExists(absolutePath)
    });
  }
}

function addExpectedFile(expected, label, source) {
  const previous = expected.get(label);
  if (previous !== undefined && !filesHaveEqualContents(previous, source)) {
    throw new Error(`Desktop extraResource mappings disagree for destination: ${label}`);
  }
  expected.set(label, source);
}

function pathLabelContained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function canonicalEntry(path, description) {
  if (!existsSync(path)) throw new Error(`Desktop ${description} is missing: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error(`Desktop ${description} is not canonical: ${path}`);
  }
  return info;
}

function canonicalRegularFileExists(path) {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && samePath(realpathSync(path), path);
}

function matchesGlob(path, pattern) {
  return expandBraces(pattern).some((expanded) => globRegularExpression(expanded).test(path));
}

function expandBraces(pattern) {
  const opening = pattern.indexOf("{");
  if (opening < 0) return [pattern];
  const closing = pattern.indexOf("}", opening + 1);
  if (closing < 0) throw new Error(`Unsupported Desktop builder filter: ${pattern}`);
  const choices = pattern.slice(opening + 1, closing).split(",");
  if (choices.length < 2 || choices.some((choice) => choice.length === 0)) {
    throw new Error(`Unsupported Desktop builder filter: ${pattern}`);
  }
  return choices.flatMap((choice) => expandBraces(
    `${pattern.slice(0, opening)}${choice}${pattern.slice(closing + 1)}`
  ));
}

function globRegularExpression(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u");
}

function joinedLabel(root, path) {
  return `${normalizedPath(root).replace(/\/$/u, "")}/${path}`;
}

function normalizedPath(path) {
  return path.replaceAll("\\", "/");
}

function pathContained(root, candidate) {
  const normalizedRoot = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`;
  const normalizedCandidate = resolve(candidate);
  return process.platform === "win32"
    ? normalizedCandidate.toLowerCase().startsWith(normalizedRoot.toLowerCase())
    : normalizedCandidate.startsWith(normalizedRoot);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
