/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DesktopManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface DesktopTsConfig {
  readonly compilerOptions?: {
    readonly outDir?: string;
    readonly tsBuildInfoFile?: string;
  };
}

interface BuilderFileSet {
  readonly from: string;
  readonly to: string;
  readonly filter?: readonly string[];
}

interface BuilderConfig {
  readonly asar: boolean;
  readonly electronVersion: string;
  readonly publish: unknown;
  readonly directories: { readonly output: string; readonly buildResources: string };
  readonly files: readonly string[];
  readonly extraResources: readonly BuilderFileSet[];
  readonly afterPack: string;
  readonly win: { readonly icon: string; readonly forceCodeSigning: boolean; readonly target: readonly string[] };
  readonly mac: { readonly icon: string; readonly identity: unknown; readonly target: readonly string[] };
  readonly linux: { readonly icon: string; readonly target: readonly string[] };
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as DesktopManifest;
const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as DesktopTsConfig;
const config = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8")) as BuilderConfig;
const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");

describe("Desktop distribution", () => {
  it("invalidates incremental state whenever compiled Desktop output is removed", () => {
    expect(tsconfig.compilerOptions).toMatchObject({
      outDir: "dist",
      tsBuildInfoFile: "dist/tsconfig.tsbuildinfo"
    });
    expect(manifest.scripts?.["build:runtime-stager"]).toBe("tsc -b tsconfig.json --force");
  });

  it("pins an inert builder toolchain and keeps build-only packages out of production dependencies", () => {
    expect(manifest.dependencies).toEqual({
      "@connectrpc/connect": "2.1.2",
      "@connectrpc/connect-node": "2.1.2",
      "@joko/contracts": "workspace:*",
      "electron-updater": "6.8.9",
      "electron-window-state": "5.0.3",
      loudness: "0.4.2",
      yaml: "2.9.0"
    });
    expect(manifest.devDependencies).toMatchObject({
      "@joko/web": "workspace:*",
      electron: "39.2.7",
      "electron-builder": "26.15.3"
    });
    expect(manifest.scripts?.["package:dir"]).toContain("--dir --publish never");
    expect(manifest.scripts?.["package:artifacts"]).toContain("--publish never");
    expect(config.electronVersion).toBe("39.2.7");
    expect(config.publish).toBeNull();
    expect(workspace).toContain("electron-winstaller: false");
    expect(workspace).not.toContain("electron-winstaller: true");
  });

  it("packages only compiled host/web inputs and an external sanitized Orchestrator runtime", () => {
    expect(config.asar).toBe(false);
    expect(config.files).toEqual(expect.arrayContaining([
      "dist/**/*.js",
      "dist/**/*.cjs",
      "dist/web/**/*",
      "!dist/orchestrator-runtime/**",
      expect.stringContaining("map,ts,tsx,cts,mts,proto,tsbuildinfo,c,cc,cpp"),
      "!**/{test,tests,__tests__,coverage,fixtures,workspace}/**",
      "!**/WORKSPACE",
      "!**/WORKSPACE/**",
      "!**/{.env,.env.*,*.db,*.db-shm,*.db-wal,*.log}"
    ]));
    expect(config.extraResources).toEqual([
      {
        from: "resources/app-update.yml",
        to: "app-update.yml"
      },
      {
        from: "resources/native-task-status-sounds",
        to: "native-task-status-sounds",
        filter: ["*.mp3"]
      },
      {
        from: "dist/native-voice-shortcut",
        to: "native-voice-shortcut",
        filter: [
          "manifest.json",
          "joko-macos-key-listener",
          "joko-windows-function-key-listener.exe"
        ]
      },
      expect.objectContaining({
        from: "dist/orchestrator-runtime",
        to: "orchestrator-runtime",
        filter: expect.arrayContaining(["!node_modules/**", expect.stringContaining("map,ts,tsx,cts,mts,proto,tsbuildinfo,c,cc,cpp")])
      }),
      expect.objectContaining({
        from: "dist/orchestrator-runtime/node_modules",
        to: "orchestrator-runtime/node_modules",
        filter: expect.arrayContaining([
          expect.stringContaining("map,ts,tsx,cts,mts,proto,tsbuildinfo,c,cc,cpp"),
          "!**/{test,tests,__tests__,coverage,fixtures,workspace}/**",
          "!**/WORKSPACE",
          "!**/WORKSPACE/**",
          "!**/{.env,.env.*,*.db,*.db-shm,*.db-wal,*.log}"
        ])
      })
    ]);
    expect(config.afterPack).toBe("scripts/audit-packaged.cjs");
  });

  it("uses the existing Joko-owned vector and emits installable plus unpackable platform targets", () => {
    expect(config.directories).toEqual({ output: "release", buildResources: "../web/src" });
    expect(existsSync(new URL("../../web/src/icon-light.svg", import.meta.url))).toBe(true);
    expect(config.win).toMatchObject({ icon: "icon-light.svg", forceCodeSigning: false, target: ["nsis", "zip"] });
    expect(config.mac).toMatchObject({ icon: "icon-light.svg", identity: null, target: ["dmg", "zip"] });
    expect(config.linux).toMatchObject({ icon: "icon-light.svg", target: ["AppImage", "tar.gz"] });
  });
});
