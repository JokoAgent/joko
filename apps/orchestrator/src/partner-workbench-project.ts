import { stat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

export class PartnerWorkbenchProjectError extends Error {
  constructor(readonly code: "PROJECT_PATH_INVALID" | "PROJECT_UNAVAILABLE", message: string) {
    super(message);
    this.name = "PartnerWorkbenchProjectError";
  }
}

export interface PartnerWorkbenchProjectEnvironment {
  readonly homeDirectory: string;
  readonly managedDataDirectory: string;
  readonly caseInsensitive: boolean;
}

/** A project grant admits a specific existing directory. Both its literal and
 * resolved identities must stay outside the host's protected data scopes. */
export async function checkPartnerWorkbenchProject(raw: string, env: PartnerWorkbenchProjectEnvironment): Promise<string> {
  const expanded = expandProjectPath(raw, env.homeDirectory);
  if (!isAbsolute(expanded)) throw new PartnerWorkbenchProjectError("PROJECT_PATH_INVALID", "An absolute project directory is required.");
  const path = resolve(expanded);
  let actual: string;
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("Not a directory.");
    actual = await realpath(path);
  } catch {
    throw new PartnerWorkbenchProjectError("PROJECT_UNAVAILABLE", "The project directory is unavailable.");
  }
  const home = resolve(env.homeDirectory);
  const data = resolve(env.managedDataDirectory);
  const [actualHome, actualData] = await Promise.all([realpath(home).catch(() => home), realpath(data).catch(() => data)]);
  for (const candidate of [path, actual]) {
    if (parse(candidate).root === candidate || same(candidate, home, env.caseInsensitive) || same(candidate, actualHome, env.caseInsensitive)) {
      throw new PartnerWorkbenchProjectError("PROJECT_PATH_INVALID", "Choose a specific project instead of a disk root or home directory.");
    }
    if (inside(candidate, data, env.caseInsensitive) || inside(candidate, actualData, env.caseInsensitive)) {
      throw new PartnerWorkbenchProjectError("PROJECT_PATH_INVALID", "Managed application data cannot be granted as a project.");
    }
  }
  return path;
}

export async function findPartnerWorkbenchProject(
  raw: string,
  projects: readonly string[],
  env: Pick<PartnerWorkbenchProjectEnvironment, "homeDirectory" | "caseInsensitive">
): Promise<string | undefined> {
  const expanded = expandProjectPath(raw, env.homeDirectory);
  if (!isAbsolute(expanded)) return undefined;
  const path = resolve(expanded);
  const literal = projects.find((project) => same(resolve(project), path, env.caseInsensitive));
  if (literal !== undefined) return literal;
  const actual = await realpath(path).catch(() => undefined);
  if (actual === undefined) return undefined;
  for (const project of projects) {
    const actualProject = await realpath(project).catch(() => undefined);
    if (actualProject !== undefined && same(actualProject, actual, env.caseInsensitive)) return project;
  }
  return undefined;
}

/** Select the deepest explicitly granted project, using directory boundaries. */
export function partnerWorkbenchProjectForDirectory(directory: string, projects: readonly string[], caseInsensitive: boolean): string | undefined {
  if (!isAbsolute(directory)) return undefined;
  const normalized = resolve(directory);
  return [...projects].sort((left, right) => right.length - left.length)
    .find((project) => inside(normalized, resolve(project), caseInsensitive));
}

export function validatePartnerWorkbenchReference(ref: string, projects: readonly string[], caseInsensitive: boolean): string | undefined {
  const value = ref.trim();
  if (!value || value.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  if (/^https:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
    } catch { return undefined; }
  }
  return partnerWorkbenchProjectForDirectory(value, projects, caseInsensitive) === undefined ? undefined : resolve(value);
}

function expandProjectPath(raw: string, home: string): string {
  const value = raw.trim();
  if (!value || value.length > 32_768 || /[\u0000-\u001f\u007f]/u.test(value)) throw new PartnerWorkbenchProjectError("PROJECT_PATH_INVALID", "A valid project directory is required.");
  return value === "~" || value.startsWith("~/") ? join(home, value.slice(1)) : value;
}
function same(left: string, right: string, insensitive: boolean): boolean { return insensitive ? left.toLowerCase() === right.toLowerCase() : left === right; }
function inside(child: string, parent: string, insensitive: boolean): boolean {
  const part = relative(insensitive ? parent.toLowerCase() : parent, insensitive ? child.toLowerCase() : child);
  return part === "" || part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part);
}
