import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertJsonResponse, readBoundedJson, type CodeHostSessionAuthorizationPort } from "./authenticated-provider.js";
import { parseCodeHostPullRequestReference } from "./reference.js";
import { CODE_HOST_PULL_REQUEST_CAPABILITY, CodeHostProviderRetryableError, CodeHostProviderUnavailableError,
  CodeHostPullRequestNotFoundError, type CodeHostProvider, type CodeHostProviderResult, type CodeHostPullRequestChecks, type CodeHostPullRequestReference } from "./types.js";
import { boundedCodeHostChecks, boundedCodeHostHeadBranch, boundedCodeHostPullRequestTitle } from "./validation.js";

const QUERY = `query MergeRequest($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      state draft title sourceBranch diffHeadSha resolvableDiscussionsCount resolvedDiscussionsCount hasConflicts
      headPipeline { jobs(retried: false, first: 100) { count nodes { status allowFailure } pageInfo { hasNextPage } } }
    }
  }
}`;

export function createGitLabCodeHostProvider(options: {
  readonly authorization: CodeHostSessionAuthorizationPort;
  readonly readToken?: (host: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
}): CodeHostProvider {
  const readToken = options.readToken ?? readGitLabToken;
  const request = options.fetch ?? fetch;
  return {
    capability: CODE_HOST_PULL_REQUEST_CAPABILITY,
    minimumTimeToLiveMs: 60_000,
    supports: isGitLabReference,
    async getPullRequest(reference, input) {
      if (input.purpose === "follow" || !isGitLabReference(reference)) throw new CodeHostProviderUnavailableError();
      const authorization = options.authorization.authorize(input.sessionOwnerId, reference);
      if (authorization === undefined) throw new CodeHostProviderUnavailableError();
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (!options.authorization.isCurrent(authorization, reference)) throw new CodeHostProviderUnavailableError();
      };
      const token = await readToken(reference.host, signal);
      if (!token || !/^[\x21-\x7e]{1,4096}$/u.test(token)) throw new CodeHostProviderUnavailableError();
      assertCurrent();
      let response: Response;
      try {
        response = await request(`https://${reference.host}/api/graphql`, { method: "POST", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { path: `${reference.repositoryOwner}/${reference.repositoryName}`, iid: String(reference.number) } }) });
      } catch {
        assertCurrent();
        throw new CodeHostProviderRetryableError();
      }
      if (response.status === 401) throw new CodeHostProviderUnavailableError();
      if (response.status === 429 || response.status >= 500) throw new CodeHostProviderRetryableError();
      if (!response.ok && response.status !== 404) throw new CodeHostProviderUnavailableError();
      const raw = response.status === 404 ? undefined : await readGitLabResponse(response);
      const confirmed = await readToken(reference.host, signal);
      assertCurrent();
      if (confirmed !== token) throw new CodeHostProviderUnavailableError();
      return parseMergeRequest(raw);
    }
  };
}

function isGitLabReference(reference: CodeHostPullRequestReference): boolean {
  const parsed = parseCodeHostPullRequestReference(reference.webUrl);
  return parsed !== undefined && parsed.host === reference.host && parsed.webUrl === reference.webUrl && parsed.key === reference.key
    && parsed.number === reference.number && parsed.repositoryOwner === reference.repositoryOwner && parsed.repositoryName === reference.repositoryName
    && parsed.webUrl.includes("/-/merge_requests/");
}

async function readGitLabResponse(response: Response): Promise<unknown> {
  assertJsonResponse(response);
  return readBoundedJson(response, 256 * 1024);
}

function parseMergeRequest(value: unknown): CodeHostProviderResult {
  const envelope = record(value);
  if (Array.isArray(envelope?.["errors"]) && envelope["errors"].length > 0) throw new CodeHostProviderUnavailableError();
  const mr = record(record(record(envelope?.["data"])?.["project"])?.["mergeRequest"]);
  if (mr === undefined) throw new CodeHostPullRequestNotFoundError();
  const state = mr["state"] === "opened" ? "open" : mr["state"] === "merged" ? "merged"
    : mr["state"] === "closed" || mr["state"] === "locked" ? "closed" : undefined;
  const title = boundedCodeHostPullRequestTitle(mr["title"]);
  const headBranch = boundedCodeHostHeadBranch(mr["sourceBranch"]);
  if (!state || typeof mr["draft"] !== "boolean" || title === undefined || headBranch === undefined) throw new CodeHostProviderUnavailableError();
  const total = mr["resolvableDiscussionsCount"], resolved = mr["resolvedDiscussionsCount"];
  const unresolved = typeof total === "number" && typeof resolved === "number" && Number.isSafeInteger(total)
    && Number.isSafeInteger(resolved) && total >= resolved && resolved >= 0 && total - resolved <= 100 ? total - resolved : undefined;
  const checks = gitlabChecks(mr);
  return { state, draft: mr["draft"], title, headBranch,
    ...(typeof mr["hasConflicts"] === "boolean" ? { hasConflicts: mr["hasConflicts"] } : {}),
    ...(unresolved === undefined ? {} : { unresolvedReviewThreadCount: unresolved }), ...(checks === undefined ? {} : { checks }) };
}

const pendingJobs = new Set(["CREATED", "WAITING_FOR_RESOURCE", "PREPARING", "PENDING", "RUNNING", "MANUAL", "SCHEDULED"]);

function gitlabChecks(mr: Record<string, unknown>): CodeHostPullRequestChecks | undefined {
  if (typeof mr["diffHeadSha"] !== "string" || !/^[0-9a-f]{40,64}$/iu.test(mr["diffHeadSha"])) return undefined;
  const pipeline = mr["headPipeline"];
  if (pipeline === null) return { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
  const jobs = record(record(pipeline)?.["jobs"]);
  const nodes = jobs?.["nodes"];
  if (!Array.isArray(nodes) || nodes.length > 100 || jobs?.["count"] !== nodes.length
    || record(jobs?.["pageInfo"])?.["hasNextPage"] !== false) return undefined;
  const checks = { total: nodes.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const node of nodes) {
    const job = record(node);
    const status = typeof job?.["status"] === "string" ? job["status"].toUpperCase() : "";
    if (status === "SUCCESS") checks.passed++;
    else if (status === "FAILED" || status === "CANCELED") checks.failed++;
    else if (status === "SKIPPED" || status === "MANUAL" && job?.["allowFailure"] === true) checks.skipped++;
    else if (pendingJobs.has(status)) checks.pending++;
    else return undefined;
  }
  return boundedCodeHostChecks(checks);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readGitLabToken(host: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const executable = process.platform === "win32" ? "glab.exe" : "glab";
  const candidates = process.platform === "win32" ? [join(process.env["ProgramFiles"] ?? "C:\\Program Files", "glab", executable)]
    : ["/opt/homebrew/bin/glab", "/usr/local/bin/glab", "/usr/bin/glab"];
  const file = [...candidates, join(homedir(), ".local", "bin", executable)].find(path => existsSync(path)) ?? executable;
  const allowed = new Set(["path", "home", "userprofile", "appdata", "localappdata", "systemroot", "systemdrive", "xdg_config_home",
    "glab_config_dir", "dbus_session_bus_address"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())));
  return new Promise(resolve => {
    execFile(file, ["config", "get", "token", "--host", host], { env, timeout: 3_000, maxBuffer: 8_192,
      signal, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout.trim() || undefined : undefined));
  });
}
