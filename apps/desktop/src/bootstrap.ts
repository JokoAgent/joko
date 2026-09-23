const entry = process.argv.includes("--joko-pdf-render-helper")
  ? "./pdf-render-helper.js"
  : "./main.js";

// Electron readiness must not wait for module evaluation of the selected app entry.
void import(entry).catch((error: unknown) => {
  process.stderr.write(`JOKO_DESKTOP_ENTRY_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
