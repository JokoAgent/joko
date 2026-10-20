import { preparePersonalVersionBootstrap, runPersonalVersionHelper } from "./personal-development-version-bootstrap.js";

const pdf = process.argv.includes("--joko-pdf-render-helper");
const entry = pdf ? "./pdf-render-helper.js" : "./main.js";

// The entry installs pre-ready paths and protocols. Wait for its imports, but
// leave helpers that await app.whenReady() outside module evaluation.
try {
  const personal = pdf ? { helper: false, redirect: false } : preparePersonalVersionBootstrap();
  const failed = (error: unknown): void => {
    process.stderr.write(personal.helper || personal.redirect ? "JOKO_PERSONAL_STARTUP_FAILED\n"
      : `JOKO_DESKTOP_ENTRY_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  };
  if (personal.helper) void runPersonalVersionHelper().catch(failed);
  else if (!personal.redirect) await import(entry).catch(failed);
} catch {
  process.stderr.write("JOKO_PERSONAL_STARTUP_FAILED\n"); process.exitCode = 1;
}
