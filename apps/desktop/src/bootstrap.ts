import { preparePersonalVersionBootstrap, runPersonalVersionHelper } from "./personal-development-version-bootstrap.js";

const pdf = process.argv.includes("--joko-pdf-render-helper");
const entry = pdf ? "./pdf-render-helper.js" : "./main.js";

// Electron readiness must not wait for module evaluation of the selected app entry.
try {
  const personal = pdf ? { helper: false, redirect: false } : preparePersonalVersionBootstrap();
  void (personal.helper ? runPersonalVersionHelper() : personal.redirect ? Promise.resolve() : import(entry)).catch((error: unknown) => {
    process.stderr.write(personal.helper || personal.redirect ? "JOKO_PERSONAL_STARTUP_FAILED\n"
      : `JOKO_DESKTOP_ENTRY_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} catch {
  process.stderr.write("JOKO_PERSONAL_STARTUP_FAILED\n"); process.exitCode = 1;
}
