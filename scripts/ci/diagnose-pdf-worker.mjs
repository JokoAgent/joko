import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const timeoutMs = 15_000;
const phases = ["worker entry", "pdf.worker import", "pdf library import", "original module loaded", "result ok"];
const modes = ["source", "compiled"];

function inputs() {
  const manifestPath = resolve(root, "packages/tool-document/package.json");
  const requireDocument = createRequire(manifestPath);
  const expectedVersion = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies["pdfjs-dist"];
  const actualVersion = JSON.parse(readFileSync(requireDocument.resolve("pdfjs-dist/package.json"), "utf8")).version;
  if (actualVersion !== expectedVersion) throw new Error("Dependency identity mismatch.");
  const selected = {
    source: resolve(root, "packages/tool-document/src/inspectPdf-worker.ts"),
    compiled: resolve(root, "packages/tool-document/dist/inspectPdf-worker.js"),
    pdfWorker: requireDocument.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    pdfLibrary: requireDocument.resolve("pdfjs-dist/legacy/build/pdf.mjs")
  };
  for (const file of Object.values(selected)) {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("A required module is unavailable.");
  }
  return selected;
}

// A fixed, one-page text PDF. Neither its bytes nor parser text are emitted.
function syntheticPdf() {
  const stream = "BT /F1 12 Tf 72 720 Td (Synthetic probe) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(pdf, "latin1"));
}

async function observeWorker(mode, files) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const send = record => process.send?.({ ...record, elapsedMs: elapsed() });
  const imports = [["pdfWorker", "pdf.worker import"], ["pdfLibrary", "pdf library import"], [mode, "original module loaded"]];
  send({ phase: "worker entry" });
  for (const [key, phase] of imports) { await import(pathToFileURL(files[key]).href); send({ phase }); }
  // The actual parser now runs on this isolated process's main thread. Preserve
  // its IPC protocol and natural process exit; never invoke worker_threads.
  process.emit("message", { kind: "inspect", data: syntheticPdf(), pages: [], maxPages: 1 });
}

async function observeChild(mode) {
  const started = performance.now();
  const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  const child = spawn(process.execPath, ["--max-old-space-size=128", "--max-semi-space-size=4", fileURLToPath(import.meta.url), "--child", mode], {
    cwd: root, env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, serialization: "advanced"
  });
  return await new Promise(accept => {
    let ok = false, observationFailed = false, watchdogExpired = false;
    const watchdog = setTimeout(() => { watchdogExpired = true; child.kill("SIGKILL"); }, timeoutMs + 5_000);
    child.on("message", record => {
      if (!record || typeof record !== "object") return;
      if (phases.includes(record.phase) && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) console.log(JSON.stringify({ mode, phase: record.phase, elapsedMs: record.elapsedMs }));
      else if (record.ok === true || record.ok === false) {
        const result = record.result, page = result?.pages?.[0];
        ok = record.ok === true && result?.numPages === 1 && result.pages.length === 1 && page.page === 1
          && page.width === 612 && page.height === 792 && page.textChars > 0 && page.blank === false && page.visibilityUnverified === false;
        if (ok) console.log(JSON.stringify({ mode, phase: "result ok", elapsedMs: Math.round(performance.now() - started) }));
      }
    });
    child.once("error", () => { observationFailed = true; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(watchdog);
      console.log(JSON.stringify({ mode, event: "child exit", elapsedMs: Math.round(performance.now() - started),
        exitCode, signal, watchdogExpired, observationFailed }));
      accept(ok && exitCode === 0 && !watchdogExpired && !observationFailed);
    });
  });
}

async function main() {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
    console.error("PDF Worker diagnosis is limited to Windows GitHub Actions.");
    process.exitCode = 1; return;
  }
  const files = inputs();
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--child" && modes.includes(args[1])) {
    await observeWorker(args[1], files); return;
  }
  if (args.length) throw new Error("Unsupported diagnostic arguments.");
  let ok = true;
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const mode of modes) {
      console.log(JSON.stringify({ mode, repetition, event: "observation start" }));
      if (!await observeChild(mode)) ok = false;
    }
  }
  process.exitCode = ok ? 0 : 1;
}

await main().catch(() => {
  console.error("PDF Worker diagnosis could not complete its fixed preconditions or observation.");
  process.exitCode = 1;
});
