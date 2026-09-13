import type { ResourceAcquisitionDraft, ResourceDraft } from "./model.js";

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu;
const NPM_VERSION_SPEC = /^[A-Za-z0-9*^~<>=|+_. -]+$/u;
const GIT_REF = /^[A-Za-z0-9_./-]+$/u;

export function emptyResourceAcquisitionDraft(kind: ResourceAcquisitionDraft["kind"]): ResourceAcquisitionDraft {
  switch (kind) {
    case "local": return { kind, serverPath: "" };
    case "npm": return { kind, packageName: "", versionSpec: "" };
    case "git": return { kind, repositoryUrl: "", ref: "", subdirectory: "" };
  }
}

export function normalizeResourceDraft(draft: ResourceDraft): ResourceDraft | undefined {
  const backendId = draft.backendId.trim();
  if (backendId.length === 0) return undefined;
  const source = normalizeResourceAcquisitionDraft(draft.kind, draft.source);
  if (source === undefined) return undefined;
  return {
    backendId,
    ...(draft.targetId === undefined ? {} : { targetId: draft.targetId.trim() }),
    kind: draft.kind,
    scope: draft.scope,
    source,
    name: draft.name.trim(),
    version: draft.version.trim()
  };
}

export function resourceDraftIsValid(draft: ResourceDraft): boolean {
  return normalizeResourceDraft(draft) !== undefined;
}

function normalizeResourceAcquisitionDraft(
  resourceKind: ResourceDraft["kind"],
  source: ResourceAcquisitionDraft
): ResourceAcquisitionDraft | undefined {
  switch (source.kind) {
    case "local": {
      const serverPath = source.serverPath.trim();
      return serverPath.length === 0 ? undefined : { kind: "local", serverPath };
    }
    case "npm": {
      if (resourceKind !== "package") return undefined;
      const packageName = source.packageName.trim();
      const versionSpec = source.versionSpec.trim();
      if (!NPM_PACKAGE_NAME.test(packageName)) return undefined;
      if (versionSpec.length > 128 || (versionSpec.length > 0 && !NPM_VERSION_SPEC.test(versionSpec))) return undefined;
      return { kind: "npm", packageName, versionSpec };
    }
    case "git": {
      if (resourceKind !== "package") return undefined;
      const repositoryUrl = source.repositoryUrl.trim();
      const ref = source.ref.trim();
      const subdirectory = normalizeGitSubdirectory(source.subdirectory);
      if (!safeGitRepositoryUrl(repositoryUrl)) return undefined;
      if (ref.length > 256 || (ref.length > 0 && (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("..") || ref.includes("@{") || !GIT_REF.test(ref)))) return undefined;
      if (source.subdirectory.trim().length > 0 && subdirectory === undefined) return undefined;
      return { kind: "git", repositoryUrl, ref, subdirectory: subdirectory ?? "" };
    }
  }
}

function safeGitRepositoryUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048 || value.includes("\0")) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return false;
    if (url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) return false;
    if (url.username.length > 0 && !(url.protocol === "ssh:" && url.username === "git")) return false;
    return url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function normalizeGitSubdirectory(value: string): string | undefined {
  let normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized.length === 0) return undefined;
  if (normalized.length > 1_024 || normalized.startsWith("/") || normalized.includes("\0")) return undefined;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  normalized = segments.join("/");
  return normalized.length === 0 ? undefined : normalized;
}
