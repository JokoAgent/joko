import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const packageRequire = createRequire(import.meta.url);
const packageRoot = dirname(packageRequire.resolve("node-pty/package.json"));
const prebuildScript = readFileSync(join(packageRoot, "scripts/prebuild.js"), "utf8");

describe("pinned terminal prebuild installation", () => {
  test("repairs only the current macOS helper's missing execution bits before accepting the prebuild", () => {
    const fixture = installer();
    fixture.run();
    expect(fixture.filesystem.chmodSync.mock.calls).toEqual([[fixture.helper, 0o755]]);
    expect(fixture.filesystem.accessSync.mock.calls).toEqual([[fixture.helper, fixture.filesystem.constants.X_OK]]);
    expect(fixture.process.exit.mock.calls).toEqual([[0]]);
    expect(fixture.filesystem.accessSync.mock.invocationCallOrder[0]).toBeLessThan(fixture.process.exit.mock.invocationCallOrder[0]!);
  });

  test("checks an already executable helper without changing its mode", () => {
    const fixture = installer();
    fixture.filesystem.lstatSync.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100755 });
    fixture.run();
    expect(fixture.filesystem.chmodSync).not.toHaveBeenCalled();
    expect(fixture.filesystem.accessSync).toHaveBeenCalledWith(fixture.helper, fixture.filesystem.constants.X_OK);
    expect(fixture.process.exit).toHaveBeenCalledWith(0);
  });

  test.each(["symlink", "directory", "noncanonical"])("rejects a %s helper without changing permissions", (kind) => {
    const fixture = installer();
    fixture.filesystem.lstatSync.mockReturnValue({
      isFile: () => kind !== "directory", isSymbolicLink: () => kind === "symlink", mode: 0o100644
    });
    if (kind === "noncanonical") fixture.filesystem.realpathSync.native.mockReturnValue(join(packageRoot, "another-helper"));
    expect(fixture.run).toThrow("The terminal spawn-helper is not a canonical regular file.");
    expect(fixture.filesystem.chmodSync).not.toHaveBeenCalled();
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  test("does not accept a prebuild when its permission repair fails", () => {
    const fixture = installer();
    fixture.filesystem.chmodSync.mockImplementation(() => { throw Object.assign(new Error("Permission denied."), { code: "EACCES" }); });
    expect(fixture.run).toThrow("Permission denied.");
    expect(fixture.filesystem.accessSync).not.toHaveBeenCalled();
    expect(fixture.process.exit).not.toHaveBeenCalled();
  });

  test.each(["linux", "win32"])("does not change native assets on %s", (platform) => {
    const fixture = installer(platform);
    fixture.run();
    expect(fixture.filesystem.lstatSync).not.toHaveBeenCalled();
    expect(fixture.filesystem.chmodSync).not.toHaveBeenCalled();
    expect(fixture.process.exit.mock.calls).toEqual([[0]]);
  });
});

function installer(platform = "darwin") {
  const helper = join(packageRoot, "prebuilds", `${platform}-arm64`, "spawn-helper");
  const filesystem = {
    existsSync: vi.fn(() => true),
    lstatSync: vi.fn(() => ({ isFile: (): boolean => true, isSymbolicLink: (): boolean => false, mode: 0o100644 })),
    realpathSync: { native: vi.fn((path: string) => path) },
    chmodSync: vi.fn(), accessSync: vi.fn(), constants: { X_OK: 1 }
  };
  const process = { platform, arch: "arm64", env: {}, exit: vi.fn() };
  return { helper, filesystem, process, run: () => runInNewContext(prebuildScript, {
    require: (name: string) => name === "fs" ? filesystem : packageRequire(name),
    __dirname: join(packageRoot, "scripts"), console: { log: vi.fn() }, process
  }) };
}
