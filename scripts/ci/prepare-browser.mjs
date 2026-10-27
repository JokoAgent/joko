import { constants } from "node:fs";
import { access, appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/e2e/package.json"));

export async function probeBrowser(executable) {
  const { chromium } = require("playwright-core");
  // WebCodecs requires a secure context; loopback matches the production chain.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Local browser capability probe</title>");
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, accept);
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: executable, headless: true, timeout: 15_000 });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`, { timeout: 10_000 });
    const capabilities = await page.evaluate(async () => {
      if (typeof VideoDecoder === "undefined") return { videoDecoderAvailable: false, requiredH264Supported: false, unrestrictedH264Supported: false };
      const config = { codec: "avc1.4d400a", codedWidth: 64, codedHeight: 64, optimizeForLatency: true };
      return {
        videoDecoderAvailable: true,
        requiredH264Supported: (await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" })).supported === true,
        unrestrictedH264Supported: (await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "no-preference" })).supported === true
      };
    });
    return { executable, version: browser.version(), ...capabilities };
  } finally {
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(accept => server.close(accept));
    }
  }
}

export async function selectBrowser(candidates, probe = probeBrowser) {
  const probes = [];
  for (const executable of candidates) {
    try {
      const result = await probe(executable);
      probes.push(result);
      if (result.requiredH264Supported) return { executable, probes };
    } catch {
      probes.push({ executable, probeFailed: true });
    }
  }
  // Keep the original browser and mandatory test assertions when no available
  // binary supports the required configuration. An unavailable codec never passes.
  return { executable: candidates[0], probes };
}

async function main() {
  const { chromium } = require("playwright-core");
  const installed = await realpath(chromium.executablePath());
  await access(installed, constants.X_OK);
  let selected = { executable: installed, probes: [] };
  if (process.platform === "linux") {
    const chrome = await realpath("/opt/google/chrome/chrome").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (chrome !== undefined) await access(chrome, constants.X_OK);
    selected = await selectBrowser(chrome !== undefined && chrome !== installed ? [installed, chrome] : [installed]);
  }
  const web = await realpath(join(root, "apps/web/dist"));
  await access(join(web, "index.html"));
  const logs = join(process.env.RUNNER_TEMP, "joko-ci-logs");
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, "browser-capabilities.json"), JSON.stringify(selected, null, 2) + "\n");
  await appendFile(process.env.GITHUB_OUTPUT, `executable=${selected.executable}\n`);
  await appendFile(process.env.GITHUB_ENV, [
    `JOKO_BROWSER_EXECUTABLE=${selected.executable}`, `JOKO_MOUNTED_WEB_DIR=${web}`,
    `JOKO_GROUP_EVIDENCE_DIR=${join(process.env.RUNNER_TEMP, "joko-web-evidence/groups")}`,
    `JOKO_QUESTION_EVIDENCE_DIR=${join(process.env.RUNNER_TEMP, "joko-web-evidence/questions")}`,
    `JOKO_DOCUMENT_MOUNTED_CAPTURE_DIR=${join(process.env.RUNNER_TEMP, "joko-web-evidence/documents")}`, ""
  ].join("\n"));
  if (process.platform === "linux") {
    const desktop = join(root, "apps/desktop");
    const electron = createRequire(join(desktop, "package.json"))("electron");
    await access(electron, constants.X_OK);
    await appendFile(process.env.GITHUB_ENV, [
      `JOKO_PDF_ELECTRON_TEST_EXECUTABLE=${electron}`, `JOKO_PDF_ELECTRON_TEST_APP=${desktop}`,
      ""
    ].join("\n"));
  }
  console.log(JSON.stringify(selected));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
