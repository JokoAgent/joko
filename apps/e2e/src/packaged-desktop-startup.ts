import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "playwright-core";

export function createPackagedDesktopStartupEvidence() {
  let resultPath: string | undefined;
  return {
    environment(directory: string) {
      resultPath = join(directory, `launch-${randomUUID()}`);
      return { JOKO_DESKTOP_SMOKE_RESULT: resultPath };
    },
    async snapshot(application: ElectronApplication | undefined) {
      const progress = resultPath === undefined ? ""
        : await readFile(`${resultPath}.progress`, "utf8").catch(() => "");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const nativeState = application === undefined ? undefined : await Promise.race([
        application.evaluate(({ app, BrowserWindow }) => ({
          ready: app.isReady(), windows: BrowserWindow.getAllWindows().length
        })).catch(() => undefined),
        new Promise<undefined>((resolveObservation) => { timer = setTimeout(() => resolveObservation(undefined), 1_000); })
      ]).finally(() => clearTimeout(timer));
      return {
        launcherExitCode: application?.process().exitCode ?? null,
        launcherSignal: application?.process().signalCode ?? null,
        nativeState: nativeState ?? null,
        stages: progress.split(/\r?\n/u).filter(Boolean).slice(0, 16).map((line) => line.split(" ", 1)[0])
      };
    },
    reset() { resultPath = undefined; }
  };
}
