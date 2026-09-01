import { posix, resolve, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { browserCandidates, discoverBrowserExecutable } from "./browser-executable.js";

describe("Browser executable discovery", () => {
  it("prefers a valid explicit owner override", () => {
    const expected = resolve("tools", "browser", "chrome.exe");
    expect(discoverBrowserExecutable({ JOKO_BROWSER_EXECUTABLE: expected }, {
      platform: "win32",
      isExecutableFile: (path) => path === expected
    })).toBe(expected);
  });

  it("fails an explicit invalid executable instead of silently selecting another browser", () => {
    expect(() => discoverBrowserExecutable({
      JOKO_BROWSER_EXECUTABLE: "missing-browser",
      PROGRAMFILES: "C:\\Program Files"
    }, {
      platform: "win32",
      isExecutableFile: () => false
    })).toThrow(/does not point to an executable file/);
  });

  it("discovers deterministic platform and PATH candidates", () => {
    const environment = {
      LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      PATH: ["C:\\Tools", "C:\\More Tools"].join(win32.delimiter)
    };
    const expected = resolve(win32.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"));
    expect(discoverBrowserExecutable(environment, {
      platform: "win32",
      isExecutableFile: (path) => path === expected
    })).toBe(expected);
    expect(browserCandidates(environment, "win32")).toContain(win32.join("C:\\Tools", "chrome.exe"));
  });

  it("accepts the Windows-preserved Program Files environment casing", () => {
    const environment = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)"
    };
    const expected = resolve(win32.join(environment.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"));
    expect(discoverBrowserExecutable(environment, {
      platform: "win32",
      isExecutableFile: (path) => path === expected
    })).toBe(expected);
  });

  it("covers per-user channels and common non-PATH application roots", () => {
    expect(browserCandidates({ LOCALAPPDATA: "C:\\Users\\Owner\\AppData\\Local" }, "win32"))
      .toContain(win32.join("C:\\Users\\Owner\\AppData\\Local", "Google", "Chrome SxS", "Application", "chrome.exe"));
    expect(browserCandidates({ HOME: "/Users/owner" }, "darwin"))
      .toContain(posix.join("/Users/owner", "Applications", "Google Chrome Canary.app", "Contents", "MacOS", "Google Chrome Canary"));
    expect(browserCandidates({}, "linux")).toEqual(expect.arrayContaining([
      "/opt/google/chrome/chrome",
      "/opt/microsoft/msedge/msedge"
    ]));
  });

  it("honors the explicit disabled switch even when a browser exists", () => {
    expect(discoverBrowserExecutable({
      JOKO_BROWSER_ENABLED: "0",
      JOKO_BROWSER_EXECUTABLE: "C:\\Browser\\chrome.exe"
    }, {
      platform: "win32",
      isExecutableFile: () => true
    })).toBeUndefined();
  });
});
