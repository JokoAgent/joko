import { describe, expect, it, vi } from "vitest";

import { discoverCodexExecutable } from "./codex-executable.js";

describe("Codex executable discovery", () => {
  it("prefers the explicit service configuration without scanning", () => {
    const readDirectory = vi.fn();
    const inspectRegularFile = vi.fn(() => ({
      canonicalPath: "D:\\tools\\codex.exe",
      modifiedAtMs: 1
    }));
    expect(discoverCodexExecutable({
      JOKO_CODEX_EXECUTABLE: "D:/tools/codex.exe",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, { platform: "win32", readDirectory, inspectRegularFile })).toBe("D:\\tools\\codex.exe");
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicit path instead of falling back", () => {
    const readDirectory = vi.fn();
    const inspectRegularFile = vi.fn(() => undefined);
    expect(() => discoverCodexExecutable({
      JOKO_CODEX_EXECUTABLE: "codex.exe",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, { platform: "win32", readDirectory, inspectRegularFile })).toThrow(/absolute regular file/u);
    expect(() => discoverCodexExecutable({
      JOKO_CODEX_EXECUTABLE: "C:\\tools\\codex.exe"
    }, { platform: "win32", readDirectory, inspectRegularFile })).toThrow(/absolute regular file/u);
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it("selects the newest regular executable with a stable path tie-break", () => {
    const visitedDirectories: string[] = [];
    const visitedFiles: string[] = [];
    const executable = discoverCodexExecutable({
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, {
      platform: "win32",
      canonicalizePath: (path) => path,
      readDirectory: (path, maximumEntries) => {
        expect(path).toBe("C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin");
        expect(maximumEntries).toBe(128);
        return [
          { name: "release-a", directory: true, symbolicLink: false },
          { name: "release-c", directory: true, symbolicLink: true },
          { name: "..\\outside", directory: true, symbolicLink: false },
          { name: "release-b", directory: true, symbolicLink: false },
          { name: "release-d", directory: true, symbolicLink: false }
        ];
      },
      isRegularDirectory: (path) => {
        visitedDirectories.push(path);
        return true;
      },
      inspectRegularFile: (path) => {
        visitedFiles.push(path);
        return {
          canonicalPath: path,
          modifiedAtMs: path.includes("release-b") ? 10 : 20
        };
      }
    });

    expect(executable).toBe("C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\release-a\\codex.exe");
    expect(visitedDirectories.map((path) => path.split("\\").at(-1)))
      .toEqual(["bin", "release-a", "release-b", "release-d"]);
    expect(visitedFiles.map((path) => path.split("\\").at(-2)))
      .toEqual(["release-a", "release-b", "release-d"]);
  });

  it("rejects automatic discovery when canonical paths leave the installation root", () => {
    const readDirectory = vi.fn();
    expect(discoverCodexExecutable({
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, {
      platform: "win32",
      canonicalizePath: (path) => path.endsWith("\\bin") ? "D:\\redirected\\bin" : path,
      isRegularDirectory: () => true,
      readDirectory
    })).toBeUndefined();
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it("fails closed when the bounded directory scan cannot produce a complete result", () => {
    const readDirectory = vi.fn(() => undefined);
    expect(discoverCodexExecutable({
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
    }, {
      platform: "win32",
      canonicalizePath: (path) => path,
      isRegularDirectory: () => true,
      readDirectory
    })).toBeUndefined();
    expect(readDirectory).toHaveBeenCalledWith(
      "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin",
      128
    );
  });
});
