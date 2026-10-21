import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

// Exercise the built entry in real Electron, including its native ready event.
// A delayed entry dependency reproduces the hosted Windows startup race.
it.skipIf(process.platform !== "win32").each(["main", "pdf", "helper"] as const)(
  "keeps %s bootstrap work on the correct side of Electron readiness",
  { timeout: 20_000 },
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "joko-bootstrap-test-"));
    try {
      await copyFile(resolve(import.meta.dirname, "../dist/bootstrap.js"), join(directory, "bootstrap.js"));
      await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", main: "bootstrap.js" }));
      await writeFile(join(directory, "personal-development-version-bootstrap.js"), `
        import { app } from "electron";
        app.setPath("userData", ${JSON.stringify(directory)});
        export const preparePersonalVersionBootstrap = () => ({ helper: ${mode === "helper"}, redirect: false });
        export async function runPersonalVersionHelper() {
          await app.whenReady();
          process.stdout.write("JOKO_BOOTSTRAP_TEST helper-ready\\n");
          app.exit(0);
        }
      `);
      await writeFile(join(directory, mode === "pdf" ? "pdf-render-helper.js" : "main.js"), `
        import { app } from "electron";
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
        const beforeReady = !app.isReady();
        process.stdout.write("JOKO_BOOTSTRAP_TEST " + (beforeReady ? "entry-before-ready" : "entry-after-ready") + "\\n");
        void app.whenReady().then(() => app.exit(beforeReady ? 0 : 1));
      `);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
        execFile(require("electron") as string,
          [directory, ...(mode === "pdf" ? ["--joko-pdf-render-helper"] : [])],
          { env, windowsHide: true, timeout: 15_000 },
          (error, output) => error ? rejectOutput(error) : resolveOutput(output));
      });
      expect(stdout.trim()).toBe(`JOKO_BOOTSTRAP_TEST ${mode === "helper" ? "helper-ready" : "entry-before-ready"}`);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
);
