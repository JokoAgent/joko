import { describe, expect, it, vi } from "vitest";

import type { DesktopOpenFileWithAppIpcRequest } from "../src/channels.js";
import type { NativeFileActionScope } from "../src/native-file-clipboard.js";
import {
  decodeWindowsRegistryOutput,
  expandWindowsEnvironment,
  isLocalWindowsDrivePath,
  parseRegistrySubkeys,
  parseRegistryValues,
  parseWindowsCommandExecutable,
  parseWindowsConsoleCodepage,
  WindowsOpenWithApps,
  type WindowsExecutableSnapshot,
  type WindowsOpenWithAppsOptions
} from "../src/windows-open-with-apps.js";

const DOCUMENT = "00000000-0000-4000-8000-000000000001";
const OTHER_DOCUMENT = "00000000-0000-4000-8000-000000000002";
const LIST = "00000000-0000-4000-8000-000000000003";
const REQUEST = "00000000-0000-4000-8000-000000000004";

const registry: Readonly<Record<string, string>> = Object.freeze({
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.xlsx\\OpenWithList":
    "    a    REG_SZ    EXCEL.EXE\r\n    b    REG_SZ    cmd.exe\r\n    MRUList    REG_SZ    ab\r\n",
  "HKCR\\.xlsx\\OpenWithList": "HKCR\\.xlsx\\OpenWithList\\WPS.EXE\r\n",
  "HKCR\\.xlsx\\OpenWithProgids": "    Duplicate.Excel    REG_NONE    \r\n    Wps.Sheet    REG_NONE    \r\n",
  "HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command":
    "    (Default)    REG_SZ    \"C:\\Office\\EXCEL.EXE\" \"%1\"\r\n",
  "HKCR\\Applications\\EXCEL.EXE": "    FriendlyAppName    REG_SZ    Microsoft Excel\r\n",
  "HKCR\\Applications\\cmd.exe\\shell\\open\\command":
    "    (Default)    REG_SZ    \"C:\\Windows\\System32\\cmd.exe\" /c \"%1\"\r\n",
  "HKCR\\Applications\\WPS.EXE\\shell\\open\\command": "",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WPS.EXE":
    "    (Default)    REG_SZ    %ProgramFiles%\\WPS\\wps.exe\r\n",
  "HKCR\\Applications\\WPS.EXE": "    FriendlyAppName    REG_SZ    @resource.dll,-1\r\n",
  "HKCR\\Duplicate.Excel\\shell\\open\\command":
    "    (Default)    REG_SZ    \"C:\\Office\\EXCEL.EXE\" \"%1\"\r\n",
  "HKCR\\Duplicate.Excel": "    (Default)    REG_SZ    Duplicate label\r\n",
  "HKCR\\Wps.Sheet\\shell\\open\\command":
    "    (Default)    REG_SZ    \"C:\\Program Files\\WPS\\wps.exe\" \"%1\"\r\n",
  "HKCR\\Wps.Sheet": "    (Default)    REG_SZ    WPS 表格\r\n"
});

function scope(id = DOCUMENT): NativeFileActionScope & { current: boolean } {
  const value = { id, current: true, isCurrent: () => value.current };
  return value;
}

function createFixture(overrides: Partial<WindowsOpenWithAppsOptions> = {}): {
  readonly owner: WindowsOpenWithApps;
  readonly options: WindowsOpenWithAppsOptions;
  readonly spawnDetached: ReturnType<typeof vi.fn>;
  readonly inspectExecutable: ReturnType<typeof vi.fn>;
} {
  let identityVersion = 1;
  const inspectExecutable = vi.fn(async (candidate: string): Promise<WindowsExecutableSnapshot | undefined> => {
    if (!/^C:\\/u.test(candidate)) return undefined;
    return { canonicalPath: candidate, identity: `${candidate.toLowerCase()}:${identityVersion}` };
  });
  const spawnDetached = vi.fn(async () => "");
  let nextId = 10;
  const options: WindowsOpenWithAppsOptions = {
    platform: "win32",
    environment: { ProgramFiles: "C:\\Program Files" },
    queryRegistry: async (key) => registry[key] ?? "",
    inspectExecutable,
    getAppIcon: async (candidate) => candidate.includes("EXCEL") ? "data:image/png;base64,AQ==" : null,
    spawnDetached,
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => 1_000,
    ...overrides
  };
  return {
    owner: new WindowsOpenWithApps(options),
    options,
    spawnDetached,
    inspectExecutable: Object.assign(inspectExecutable, {
      replaceIdentity: (): void => { identityVersion += 1; }
    })
  };
}

function listRequest(documentOccurrence = DOCUMENT, listOccurrence = LIST, name = "report.xlsx") {
  return { documentOccurrence, listOccurrence, name };
}

function openRequest(appId: string, overrides: Partial<DesktopOpenFileWithAppIpcRequest> = {}): DesktopOpenFileWithAppIpcRequest {
  return {
    documentOccurrence: DOCUMENT,
    listOccurrence: LIST,
    appId,
    requestId: REQUEST,
    file: { name: "report.xlsx", mediaType: "application/octet-stream", bytes: new Uint8Array([1]) },
    ...overrides
  };
}

describe("Windows open-with registry parsing", () => {
  it("parses command executables, environment, registry values and subkeys", () => {
    expect(parseWindowsCommandExecutable('"C:\\Program Files\\App\\app.exe" "%1"')).toBe(
      "C:\\Program Files\\App\\app.exe"
    );
    expect(parseWindowsCommandExecutable("C:\\Program Files\\App\\app.exe /open %1")).toBe(
      "C:\\Program Files\\App\\app.exe"
    );
    expect(parseWindowsCommandExecutable('"unterminated')).toBeUndefined();
    expect(expandWindowsEnvironment("%SYSTEMROOT%\\notepad.exe", { SystemRoot: "C:\\Windows" }))
      .toBe("C:\\Windows\\notepad.exe");
    expect(isLocalWindowsDrivePath("C:\\Program Files\\App\\app.exe")).toBe(true);
    expect(isLocalWindowsDrivePath("C:/Program Files/App/app.exe")).toBe(true);
    expect(isLocalWindowsDrivePath("C:relative\\app.exe")).toBe(false);
    expect(isLocalWindowsDrivePath("\\\\server\\share\\app.exe")).toBe(false);
    expect(isLocalWindowsDrivePath("\\\\?\\C:\\App\\app.exe")).toBe(false);
    expect(isLocalWindowsDrivePath("\\\\.\\C:\\App\\app.exe")).toBe(false);
    expect(isLocalWindowsDrivePath("C:\\App\\app.exe:payload")).toBe(false);
    expect(parseRegistryValues("    Excel.Sheet    REG_NONE    \r\n")).toEqual([
      { name: "Excel.Sheet", data: "" }
    ]);
    expect(parseRegistrySubkeys(
      "HKCR\\.txt\\OpenWithList\\notepad.exe\r\nHKCR\\.txt\\OpenWithList\\code.exe\r\n",
      "HKCR\\.txt\\OpenWithList"
    )).toEqual(["notepad.exe", "code.exe"]);
  });

  it("decodes the active Windows code page and falls back safely", () => {
    expect(parseWindowsConsoleCodepage("Active code page: 936\r\n")).toBe(936);
    expect(parseWindowsConsoleCodepage("")).toBeUndefined();
    expect(decodeWindowsRegistryOutput(new Uint8Array([0xb9, 0xa4, 0xd7, 0xf7, 0xb1, 0xed]), 936))
      .toBe("工作表");
    expect(decodeWindowsRegistryOutput(new TextEncoder().encode("Notepad"), 850)).toBe("Notepad");
  });
});

describe("WindowsOpenWithApps authority", () => {
  it("enumerates, resolves, deduplicates, denies host processes and keeps icons optional", async () => {
    const fixture = createFixture();
    const result = await fixture.owner.list(listRequest(), scope());
    expect(result.status).toBe("listed");
    if (result.status !== "listed") throw new Error("Expected listed result.");
    expect(result.apps.map((app) => app.label)).toEqual(["Microsoft Excel", "wps"]);
    expect(result.apps[0]).toMatchObject({ iconDataUrl: "data:image/png;base64,AQ==" });
    expect(result.apps[1]).not.toHaveProperty("iconDataUrl");
    expect(result.apps).toHaveLength(2);
  });

  it("atomically consumes one exact Document/list/app/name claim and dispatches the managed file", async () => {
    const fixture = createFixture();
    const ownerScope = scope();
    const result = await fixture.owner.list(listRequest(), ownerScope);
    if (result.status !== "listed") throw new Error("Expected listed result.");
    const excel = result.apps[0]!;

    const dispatch = fixture.owner.claim(openRequest(excel.appId), ownerScope);
    expect(() => fixture.owner.claim(openRequest(excel.appId, { requestId: "00000000-0000-4000-8000-000000000099" }), ownerScope))
      .toThrow(/expired/u);
    await expect(dispatch("C:\\private\\report.xlsx")).resolves.toBe("");
    expect(fixture.spawnDetached).toHaveBeenCalledExactlyOnceWith(
      "C:\\Office\\EXCEL.EXE",
      "C:\\private\\report.xlsx"
    );
  });

  it("rejects forged, cross-Document, stale-list and same-extension different-name authority", async () => {
    const fixture = createFixture();
    const ownerScope = scope();
    const result = await fixture.owner.list(listRequest(), ownerScope);
    if (result.status !== "listed") throw new Error("Expected listed result.");

    expect(() => fixture.owner.claim(openRequest(OTHER_DOCUMENT), ownerScope)).toThrow(/invalid/u);
    expect(() => fixture.owner.claim(openRequest(result.apps[0]!.appId, {
      documentOccurrence: OTHER_DOCUMENT
    }), ownerScope)).toThrow(/another Document/u);
    expect(() => fixture.owner.claim(openRequest(result.apps[0]!.appId, {
      listOccurrence: OTHER_DOCUMENT
    }), ownerScope)).toThrow(/expired/u);
    expect(() => fixture.owner.claim(openRequest(result.apps[0]!.appId, {
      file: { name: "other.xlsx", mediaType: "application/octet-stream", bytes: new Uint8Array([1]) }
    }), ownerScope)).toThrow(/expired/u);
  });

  it("retires pending/completed lists on dismiss, new list and Document loss", async () => {
    let release!: () => void;
    let holdFirstQuery = true;
    const queryRegistry = vi.fn((_key: string, _arguments: readonly string[], signal: AbortSignal) => {
      if (!holdFirstQuery) return Promise.resolve("");
      holdFirstQuery = false;
      return new Promise<string>((resolve) => {
        release = () => resolve("");
        signal.addEventListener("abort", () => resolve(""), { once: true });
      });
    });
    const fixture = createFixture({ queryRegistry });
    const ownerScope = scope();
    const pending = fixture.owner.list(listRequest(), ownerScope);
    fixture.owner.retire({ documentOccurrence: DOCUMENT, listOccurrence: LIST }, ownerScope);
    release!();
    await expect(pending).resolves.toEqual({ status: "cancelled" });

    const nextList = "00000000-0000-4000-8000-000000000020";
    const listed = await fixture.owner.list(listRequest(DOCUMENT, nextList), ownerScope);
    expect(listed.status).toBe("listed");
    fixture.owner.retireDocument(DOCUMENT);
    if (listed.status === "listed") {
      expect(() => fixture.owner.claim(openRequest(listed.apps[0]?.appId ?? OTHER_DOCUMENT, {
        listOccurrence: nextList
      }), ownerScope)).toThrow(/expired/u);
    }
  });

  it("bounds the whole enumeration even when a registry query ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        queryRegistry: () => new Promise<string>(() => undefined)
      });
      const pending = fixture.owner.list(listRequest(), scope());

      await vi.advanceTimersByTimeAsync(12_000);

      await expect(pending).resolves.toEqual({ status: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not impose a fixed list quota on a long-lived Document", async () => {
    const fixture = createFixture({ queryRegistry: async () => "" });
    const ownerScope = scope();
    for (let index = 0; index < 140; index += 1) {
      const listOccurrence = `00000000-0000-4000-8000-${String(1_000 + index).padStart(12, "0")}`;
      await expect(fixture.owner.list(listRequest(DOCUMENT, listOccurrence), ownerScope)).resolves.toMatchObject({
        status: "listed",
        listOccurrence
      });
    }
  });

  it("revalidates the executable identity immediately before spawn", async () => {
    let identityVersion = 1;
    const fixture = createFixture({
      inspectExecutable: async (candidate) => ({
        canonicalPath: candidate,
        identity: `${candidate.toLowerCase()}:${identityVersion}`
      })
    });
    const ownerScope = scope();
    const result = await fixture.owner.list(listRequest(), ownerScope);
    if (result.status !== "listed") throw new Error("Expected listed result.");
    const dispatch = fixture.owner.claim(openRequest(result.apps[0]!.appId), ownerScope);
    identityVersion += 1;

    await expect(dispatch("C:\\private\\report.xlsx")).resolves.toMatch(/changed/u);
    expect(fixture.spawnDetached).not.toHaveBeenCalled();
  });

  it("does not advertise enumeration on other platforms", async () => {
    const fixture = createFixture({ platform: "darwin" });
    await expect(fixture.owner.list(listRequest(), scope())).resolves.toEqual({ status: "unavailable" });
  });
});
