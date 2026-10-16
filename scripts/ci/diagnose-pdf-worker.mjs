import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const timeoutMs = 15_000;
const resourceLimits = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 };
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
  const bootstrap = [
    'import { parentPort } from "node:worker_threads";',
    'parentPort.postMessage({ phase: "worker entry" });',
    ...imports.flatMap(([key, phase]) => [
      `await import(${JSON.stringify(pathToFileURL(files[key]).href)});`,
      `parentPort.postMessage({ phase: ${JSON.stringify(phase)} });`
    ])
  ].join("\n");
  const data = syntheticPdf();
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    workerData: { kind: "inspect", data, pages: [], maxPages: 1 }, transferList: [data.buffer],
    resourceLimits, execArgv: [],
    stdout: true, stderr: true
  });
  // The library may write warnings. Consume them without forwarding content or paths.
  worker.stdout.resume(); worker.stderr.resume();
  let settled = false, terminationRequested = false;
  const outcome = await new Promise(accept => {
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); terminationRequested = true;
      send({ event: "outcome", ...result });
      void worker.terminate().then(() => accept(result), () => accept(result));
    };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    worker.on("message", message => {
      if (settled) return;
      if (phases.includes(message?.phase) && message.phase !== "result ok") { send({ phase: message.phase }); return; }
      const result = message?.result;
      const page = result?.pages?.[0];
      const ok = message?.ok === true && result.numPages === 1 && result.pages.length === 1
        && page.page === 1 && page.width === 612 && page.height === 792
        && page.textChars > 0 && page.blank === false && page.visibilityUnverified === false;
      if (ok) send({ phase: "result ok" });
      finish({ ok, timedOut: false });
    });
    worker.once("error", () => finish({ ok: false, timedOut: false, workerError: true }));
    worker.once("exit", exitCode => {
      send({ event: "worker exit", exitCode, signal: null, terminationRequested });
      if (!settled) finish({ ok: false, timedOut: false, unexpectedExit: true });
    });
  });
  process.exitCode = outcome.ok ? 0 : 1;
  process.disconnect?.();
}

async function observeChild(mode) {
  const started = performance.now();
  const environment = { ...process.env };
  // Keep inherited Node flags from overriding the explicit Worker memory limit.
  delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", mode], {
    cwd: root, env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true
  });
  return await new Promise(accept => {
    let ok = false, observationFailed = false, watchdogExpired = false;
    const watchdog = setTimeout(() => { watchdogExpired = true; child.kill("SIGKILL"); }, timeoutMs + 5_000);
    child.on("message", record => {
      if (!Number.isFinite(record?.elapsedMs) || record.elapsedMs < 0) return;
      if (phases.includes(record.phase)) console.log(JSON.stringify({ mode, phase: record.phase, elapsedMs: record.elapsedMs }));
      else if (record.event === "outcome") {
        ok = record.ok === true;
        console.log(JSON.stringify({ mode, event: "outcome", elapsedMs: record.elapsedMs, ok,
          timedOut: record.timedOut === true, workerError: record.workerError === true, unexpectedExit: record.unexpectedExit === true }));
      } else if (record.event === "worker exit") console.log(JSON.stringify({ mode, event: "worker exit", elapsedMs: record.elapsedMs,
        exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null, signal: null, terminationRequested: record.terminationRequested === true }));
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
  for (const mode of modes) if (!await observeChild(mode)) ok = false;
  process.exitCode = ok ? 0 : 1;
}

await main().catch(() => {
  console.error("PDF Worker diagnosis could not complete its fixed preconditions or observation.");
  process.exitCode = 1;
});
