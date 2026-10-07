import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  DesktopListOpenWithAppsIpcRequest,
  DesktopListOpenWithAppsResult,
  DesktopOpenFileWithAppIpcRequest,
  DesktopOpenWithApp,
  DesktopRetireOpenWithAppsIpcRequest
} from "./channels.js";
import type { NativeFileActionScope } from "./native-file-clipboard.js";
import { isSafeNativeFileName } from "./native-file-opener.js";

const MAXIMUM_APPS = 12;
const MAXIMUM_CANDIDATES = 64;
const MAXIMUM_RECENT_LIST_OCCURRENCES = 128;
const LIST_DEADLINE_MS = 12_000;
const LIST_RETENTION_MS = 5 * 60 * 1_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ICON_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;

const HOST_EXECUTABLE_DENYLIST = new Set([
  "cmd.exe",
  "cscript.exe",
  "dllhost.exe",
  "explorer.exe",
  "mshta.exe",
  "openwith.exe",
  "powershell.exe",
  "pwsh.exe",
  "rundll32.exe",
  "wscript.exe"
]);

export interface WindowsExecutableSnapshot {
  readonly canonicalPath: string;
  /** Stable regular-file identity captured by the Desktop filesystem owner. */
  readonly identity: string;
}

export interface WindowsOpenWithAppsOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly queryRegistry: (
    keyPath: string,
    arguments_: readonly string[],
    signal: AbortSignal
  ) => Promise<string>;
  readonly inspectExecutable: (path: string) => Promise<WindowsExecutableSnapshot | undefined>;
  readonly getAppIcon: (path: string) => Promise<string | null>;
  /** Empty string is success; a non-empty string is an explicit pre-dispatch failure. */
  readonly spawnDetached: (executable: string, file: string) => Promise<string>;
  readonly createId?: () => string;
  readonly now?: () => number;
}

interface ResolvedApp {
  readonly executable: WindowsExecutableSnapshot;
  readonly label: string;
}

interface AuthorizedApp extends ResolvedApp, DesktopOpenWithApp {}

interface ListRecord {
  readonly name: string;
  readonly extension: string;
  readonly listOccurrence: string;
  readonly expiresAt: number;
  readonly apps: readonly AuthorizedApp[];
  readonly appById: ReadonlyMap<string, AuthorizedApp>;
}

interface PendingList {
  readonly name: string;
  readonly listOccurrence: string;
  readonly abort: AbortController;
  readonly result: Promise<DesktopListOpenWithAppsResult>;
}

interface RecentListOccurrences {
  readonly values: Set<string>;
  readonly order: string[];
}

/** Windows-only registry enumeration and ephemeral app authority. */
export class WindowsOpenWithApps {
  readonly #options: WindowsOpenWithAppsOptions;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #lists = new Map<string, ListRecord>();
  readonly #pending = new Map<string, PendingList>();
  readonly #usedOccurrences = new Map<string, RecentListOccurrences>();
  #closed = false;

  constructor(options: WindowsOpenWithAppsOptions) {
    this.#options = options;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  list(value: unknown, scope: NativeFileActionScope): Promise<DesktopListOpenWithAppsResult> {
    const request = parseListRequest(value);
    this.#requireDocument(scope, request.documentOccurrence);
    if (this.#closed || !scope.isCurrent()) return Promise.resolve({ status: "cancelled" });
    if (this.#options.platform !== "win32") return Promise.resolve({ status: "unavailable" });

    const pending = this.#pending.get(scope.id);
    if (pending?.listOccurrence === request.listOccurrence) {
      if (pending.name !== request.name) {
        return Promise.reject(new TypeError("The open-with list occurrence was reused for another file."));
      }
      return pending.result;
    }
    const existing = this.#lists.get(scope.id);
    if (existing?.listOccurrence === request.listOccurrence) {
      if (existing.name !== request.name || existing.expiresAt <= this.#now()) {
        return Promise.reject(new TypeError("The open-with list occurrence has expired or changed."));
      }
      return Promise.resolve(projectList(existing));
    }

    const used = this.#usedOccurrences.get(scope.id) ?? { values: new Set<string>(), order: [] };
    if (used.values.has(request.listOccurrence)) {
      return Promise.reject(new TypeError("The open-with list occurrence cannot be reused."));
    }
    this.#retireActive(scope.id);
    used.values.add(request.listOccurrence);
    used.order.push(request.listOccurrence);
    if (used.order.length > MAXIMUM_RECENT_LIST_OCCURRENCES) {
      const expired = used.order.shift();
      if (expired !== undefined) used.values.delete(expired);
    }
    this.#usedOccurrences.set(scope.id, used);

    const abort = new AbortController();
    const current = (): boolean => !this.#closed && !abort.signal.aborted && scope.isCurrent() &&
      this.#pending.get(scope.id)?.listOccurrence === request.listOccurrence;
    const result = this.#enumerate(request, current, abort.signal).finally(() => {
      if (this.#pending.get(scope.id)?.listOccurrence === request.listOccurrence) {
        this.#pending.delete(scope.id);
      }
    });
    this.#pending.set(scope.id, { name: request.name, listOccurrence: request.listOccurrence, abort, result });
    return result;
  }

  retire(value: unknown, scope: NativeFileActionScope): void {
    const request = parseRetireRequest(value);
    this.#requireDocument(scope, request.documentOccurrence);
    if (this.#pending.get(scope.id)?.listOccurrence === request.listOccurrence) {
      this.#pending.get(scope.id)?.abort.abort();
      this.#pending.delete(scope.id);
    }
    if (this.#lists.get(scope.id)?.listOccurrence === request.listOccurrence) {
      this.#lists.delete(scope.id);
    }
  }

  retireDocument(documentOccurrence: string): void {
    this.#retireActive(documentOccurrence);
    this.#usedOccurrences.delete(documentOccurrence);
  }

  cancelPending(): void {
    for (const pending of this.#pending.values()) pending.abort.abort();
    this.#pending.clear();
  }

  dispose(): void {
    this.#closed = true;
    this.cancelPending();
    this.#lists.clear();
    this.#usedOccurrences.clear();
  }

  claim(
    request: DesktopOpenFileWithAppIpcRequest,
    scope: NativeFileActionScope
  ): (managedFilePath: string) => Promise<string> {
    this.#requireDocument(scope, request.documentOccurrence);
    if (this.#closed || !scope.isCurrent() || this.#options.platform !== "win32") {
      throw new Error("Open-with authority is unavailable.");
    }
    const list = this.#lists.get(scope.id);
    const extension = path.win32.extname(request.file.name).toLowerCase();
    if (list === undefined || list.listOccurrence !== request.listOccurrence ||
      list.expiresAt <= this.#now() || list.extension !== extension || list.name !== request.file.name) {
      throw new Error("Open-with application authority expired.");
    }
    const app = list.appById.get(request.appId);
    if (app === undefined) throw new Error("Open-with application authority is invalid.");

    // Consume the entire list occurrence before the external effect. Exact
    // request replay remains owned by NativeFileOpener; another request cannot
    // use the same app mapping after this point.
    this.#lists.delete(scope.id);
    return async (managedFilePath: string): Promise<string> => {
      if (!scope.isCurrent()) return "Open-with Document authority expired.";
      const executable = await this.#options.inspectExecutable(app.executable.canonicalPath).catch(() => undefined);
      if (!scope.isCurrent() || executable === undefined ||
        !sameExecutable(executable, app.executable) || deniedExecutable(executable.canonicalPath)) {
        return "Open-with application changed before dispatch.";
      }
      return this.#options.spawnDetached(executable.canonicalPath, managedFilePath);
    };
  }

  async #enumerate(
    request: DesktopListOpenWithAppsIpcRequest,
    current: () => boolean,
    signal: AbortSignal
  ): Promise<DesktopListOpenWithAppsResult> {
    const extension = path.win32.extname(request.name).toLowerCase();
    const deadline = new AbortController();
    const abortForOwner = (): void => deadline.abort();
    signal.addEventListener("abort", abortForOwner, { once: true });
    if (signal.aborted) deadline.abort();
    const timeout = setTimeout(() => deadline.abort(), LIST_DEADLINE_MS);
    try {
      const resolved = extension === "" ? [] : await abortable(
        this.#listWindowsApps(extension, deadline.signal),
        deadline.signal
      );
      if (!current()) return { status: "cancelled" };
      const apps = await abortable(Promise.all(resolved.map(async (entry): Promise<AuthorizedApp> => {
        const appId = this.#createId();
        if (!UUID.test(appId)) throw new TypeError("Open-with app identity factory returned an invalid identity.");
        const icon = await this.#options.getAppIcon(entry.executable.canonicalPath).catch(() => null);
        const iconDataUrl = validIconDataUrl(icon) ? icon : undefined;
        return Object.freeze({
          ...entry,
          appId,
          ...(iconDataUrl === undefined ? {} : { iconDataUrl })
        });
      })), deadline.signal);
      if (new Set(apps.map((app) => app.appId)).size !== apps.length) {
        throw new Error("Open-with app identity collision.");
      }
      if (!current()) return { status: "cancelled" };
      const record: ListRecord = Object.freeze({
        name: request.name,
        extension,
        listOccurrence: request.listOccurrence,
        expiresAt: this.#now() + LIST_RETENTION_MS,
        apps: Object.freeze(apps),
        appById: new Map(apps.map((app) => [app.appId, app] as const))
      });
      this.#lists.set(request.documentOccurrence, record);
      return projectList(record);
    } catch {
      return current() ? { status: "failed" } : { status: "cancelled" };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortForOwner);
    }
  }

  async #listWindowsApps(extension: string, signal: AbortSignal): Promise<ResolvedApp[]> {
    const fileExtsKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}`;
    const executableNames = new Set<string>();
    const programIds = new Set<string>();

    for (const value of parseRegistryValues(await this.#query(`${fileExtsKey}\\OpenWithList`, [], signal))) {
      if (value.name.toLowerCase() !== "mrulist" && validExecutableName(value.data)) {
        addBounded(executableNames, value.data, MAXIMUM_CANDIDATES);
      }
    }
    const machineListKey = `HKCR\\${extension}\\OpenWithList`;
    for (const name of parseRegistrySubkeys(await this.#query(machineListKey, [], signal), machineListKey)) {
      if (validExecutableName(name)) addBounded(executableNames, name, MAXIMUM_CANDIDATES);
    }
    for (const key of [`${fileExtsKey}\\OpenWithProgids`, `HKCR\\${extension}\\OpenWithProgids`]) {
      for (const value of parseRegistryValues(await this.#query(key, [], signal))) {
        if (value.name !== "(Default)" && validProgramId(value.name)) {
          addBounded(programIds, value.name, MAXIMUM_CANDIDATES);
        }
      }
    }
    const defaultProgramId = parseRegistryValues(await this.#query(`HKCR\\${extension}`, ["/ve"], signal))[0]?.data;
    if (defaultProgramId !== undefined && validProgramId(defaultProgramId)) {
      addBounded(programIds, defaultProgramId, MAXIMUM_CANDIDATES);
    }

    const apps: ResolvedApp[] = [];
    const seen = new Set<string>();
    const append = (entry: ResolvedApp | undefined): void => {
      if (entry === undefined || deniedExecutable(entry.executable.canonicalPath)) return;
      const key = entry.executable.canonicalPath.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      apps.push(entry);
    };
    for (const name of executableNames) {
      if (apps.length >= MAXIMUM_APPS) break;
      append(await this.#resolveExecutableName(name, signal));
    }
    for (const programId of programIds) {
      if (apps.length >= MAXIMUM_APPS) break;
      append(await this.#resolveProgramId(programId, signal));
    }
    return apps;
  }

  async #resolveExecutableName(name: string, signal: AbortSignal): Promise<ResolvedApp | undefined> {
    const applicationKey = `HKCR\\Applications\\${name}`;
    const command = parseRegistryValues(await this.#query(`${applicationKey}\\shell\\open\\command`, ["/ve"], signal))[0]?.data;
    let candidate = command === undefined ? undefined : parseWindowsCommandExecutable(command);
    if (candidate === undefined) {
      const appPath = parseRegistryValues(await this.#query(
        `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`,
        ["/ve"],
        signal
      ))[0]?.data;
      candidate = appPath === undefined ? undefined : stripOuterQuotes(appPath.trim());
    }
    const executable = await this.#inspectCandidate(candidate);
    if (executable === undefined) return undefined;
    const friendly = parseRegistryValues(await this.#query(applicationKey, ["/v", "FriendlyAppName"], signal))[0]?.data;
    return { executable, label: friendlyLabel(friendly, executable.canonicalPath) };
  }

  async #resolveProgramId(programId: string, signal: AbortSignal): Promise<ResolvedApp | undefined> {
    const command = parseRegistryValues(await this.#query(
      `HKCR\\${programId}\\shell\\open\\command`,
      ["/ve"],
      signal
    ))[0]?.data;
    const executable = await this.#inspectCandidate(
      command === undefined ? undefined : parseWindowsCommandExecutable(command)
    );
    if (executable === undefined) return undefined;
    const friendly = parseRegistryValues(await this.#query(`HKCR\\${programId}`, ["/ve"], signal))[0]?.data;
    return { executable, label: friendlyLabel(friendly, executable.canonicalPath) };
  }

  async #inspectCandidate(candidate: string | undefined): Promise<WindowsExecutableSnapshot | undefined> {
    if (candidate === undefined) return undefined;
    const expanded = expandWindowsEnvironment(candidate, this.#options.environment);
    if (!isLocalWindowsDrivePath(expanded) || deniedExecutable(expanded)) return undefined;
    const snapshot = await this.#options.inspectExecutable(expanded).catch(() => undefined);
    return snapshot !== undefined && isLocalWindowsDrivePath(snapshot.canonicalPath) &&
      !deniedExecutable(snapshot.canonicalPath)
      ? snapshot
      : undefined;
  }

  #query(key: string, arguments_: readonly string[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.resolve("");
    return this.#options.queryRegistry(key, arguments_, signal);
  }

  #requireDocument(scope: NativeFileActionScope, occurrence: string): void {
    if (scope.id !== occurrence) throw new Error("Open-with request belongs to another Document occurrence.");
  }

  #retireActive(documentOccurrence: string): void {
    this.#pending.get(documentOccurrence)?.abort.abort();
    this.#pending.delete(documentOccurrence);
    this.#lists.delete(documentOccurrence);
  }
}

export function expandWindowsEnvironment(
  value: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const normalized = new Map<string, string>();
  for (const [name, content] of Object.entries(environment)) {
    if (content !== undefined) normalized.set(name.toLowerCase(), content);
  }
  return value.replace(/%([^%]+)%/gu, (original, name: string) =>
    normalized.get(name.toLowerCase()) ?? original);
}

export function parseWindowsCommandExecutable(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : undefined;
  }
  return trimmed.match(/^(.*?\.exe)(?=\s|$)/iu)?.[1] ?? undefined;
}

/** Reject UNC, device namespaces, drive-relative paths and NTFS ADS before filesystem I/O. */
export function isLocalWindowsDrivePath(value: string): boolean {
  if (value === "" || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  return /^[A-Za-z]:\\$/u.test(root) && !normalized.slice(root.length).includes(":");
}

export function parseWindowsConsoleCodepage(stdout: string): number | undefined {
  const value = stdout.match(/\d+/gu)?.at(-1);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const WINDOWS_CODEPAGE_LABELS: Readonly<Record<number, string>> = Object.freeze({
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gb18030",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8"
});

export function decodeWindowsRegistryOutput(bytes: Uint8Array, codepage: number | undefined): string {
  const label = codepage === undefined ? "utf-8" : WINDOWS_CODEPAGE_LABELS[codepage] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function parseRegistryValues(stdout: string): Array<{ readonly name: string; readonly data: string }> {
  const values: Array<{ readonly name: string; readonly data: string }> = [];
  for (const line of stdout.split(/\r?\n/gu)) {
    const match = line.match(/^\s{2,}(\S(?:.*?\S)?)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/u);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.push({ name: match[1], data: (match[3] ?? "").trim() });
    }
  }
  return values;
}

export function parseRegistrySubkeys(stdout: string, parentKey: string): string[] {
  const prefix = `${parentKey.replace(/\\+$/u, "").toLowerCase()}\\`;
  const values: string[] = [];
  for (const line of stdout.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) values.push(trimmed.slice(prefix.length));
  }
  return values;
}

function parseListRequest(value: unknown): DesktopListOpenWithAppsIpcRequest {
  if (!exactRecord(value, ["documentOccurrence", "listOccurrence", "name"]) ||
    !UUID.test(String(value.documentOccurrence)) || !UUID.test(String(value.listOccurrence)) ||
    typeof value.name !== "string" || !isSafeNativeFileName(value.name)) {
    throw new TypeError("Invalid open-with list request.");
  }
  return value as unknown as DesktopListOpenWithAppsIpcRequest;
}

function parseRetireRequest(value: unknown): DesktopRetireOpenWithAppsIpcRequest {
  if (!exactRecord(value, ["documentOccurrence", "listOccurrence"]) ||
    !UUID.test(String(value.documentOccurrence)) || !UUID.test(String(value.listOccurrence))) {
    throw new TypeError("Invalid open-with retirement request.");
  }
  return value as unknown as DesktopRetireOpenWithAppsIpcRequest;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function projectList(record: ListRecord): DesktopListOpenWithAppsResult {
  return Object.freeze({
    status: "listed",
    listOccurrence: record.listOccurrence,
    apps: Object.freeze(record.apps.map(({ appId, label, iconDataUrl }) => Object.freeze({
      appId,
      label,
      ...(iconDataUrl === undefined ? {} : { iconDataUrl })
    })))
  });
}

function sameExecutable(left: WindowsExecutableSnapshot, right: WindowsExecutableSnapshot): boolean {
  return left.canonicalPath.toLowerCase() === right.canonicalPath.toLowerCase() && left.identity === right.identity;
}

function deniedExecutable(executable: string): boolean {
  return HOST_EXECUTABLE_DENYLIST.has(path.win32.basename(executable).toLowerCase());
}

function validExecutableName(value: string): boolean {
  return value.length <= 255 && /^[^\\/:*?"<>|\u0000-\u001f]+\.exe$/iu.test(value);
}

function validProgramId(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\\\u0000-\u001f\u007f]/u.test(value);
}

function addBounded(values: Set<string>, value: string, maximum: number): void {
  if (values.size < maximum) values.add(value);
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function friendlyLabel(value: string | undefined, executable: string): string {
  const friendly = value?.trim();
  if (friendly !== undefined && friendly.length > 0 && friendly.length <= 256 && !friendly.startsWith("@") &&
    !/[\u0000-\u001f\u007f]/u.test(friendly)) return friendly;
  return path.win32.basename(executable, path.win32.extname(executable)).slice(0, 256) || "Application";
}

function validIconDataUrl(value: string | null): value is string {
  return value !== null && value.length <= 1024 * 1024 && ICON_DATA_URL.test(value);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Open-with operation was retired."));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const aborted = (): void => rejectOperation(new Error("Open-with operation was retired."));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolveOperation, rejectOperation).finally(() => {
      signal.removeEventListener("abort", aborted);
    }).catch(() => undefined);
  });
}
