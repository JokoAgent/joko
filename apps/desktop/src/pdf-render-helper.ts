import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 90 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30_000;
const PAGE_SIZES = new Set(["A3", "A4", "A5", "Legal", "Letter", "Tabloid"]);

interface Request {
  readonly html: string;
  readonly pageSize: "A3" | "A4" | "A5" | "Legal" | "Letter" | "Tabloid";
  readonly landscape: boolean;
  readonly printBackground: boolean;
  readonly margins: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };
  readonly fontTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeRequest(value: unknown): Request {
  if (!isRecord(value) || value["version"] !== 1
    || Object.keys(value).sort().join(",") !== "fontTimeoutMs,htmlBase64,landscape,margins,pageSize,printBackground,version"
    || typeof value["htmlBase64"] !== "string" || value["htmlBase64"].length > Math.ceil(MAX_HTML_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value["htmlBase64"])
    || !PAGE_SIZES.has(value["pageSize"] as string)
    || typeof value["landscape"] !== "boolean" || typeof value["printBackground"] !== "boolean"
    || !Number.isSafeInteger(value["fontTimeoutMs"]) || Number(value["fontTimeoutMs"]) < 1
    || Number(value["fontTimeoutMs"]) > 5_000 || !isRecord(value["margins"])
    || Object.keys(value["margins"]).sort().join(",") !== "bottom,left,right,top") {
    throw new Error("PDF helper request is invalid.");
  }
  for (const margin of Object.values(value["margins"])) {
    if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 5) {
      throw new Error("PDF helper margins are invalid.");
    }
  }
  const htmlBytes = Buffer.from(value["htmlBase64"], "base64");
  if (htmlBytes.length === 0 || htmlBytes.length > MAX_HTML_BYTES) throw new Error("PDF helper HTML exceeds its budget.");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(htmlBytes);
  return { html, pageSize: value["pageSize"] as Request["pageSize"],
    landscape: value["landscape"] as boolean, printBackground: value["printBackground"] as boolean,
    margins: value["margins"] as Request["margins"], fontTimeoutMs: value["fontTimeoutMs"] as number };
}

async function readRequest(): Promise<Request> {
  const parts: Buffer[] = [];
  let length = 0;
  const input = createReadStream("", { fd: 3, autoClose: false });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("PDF helper request exceeds its budget.");
    parts.push(bytes);
  }
  return decodeRequest(JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown);
}

function lockWindow(window: BrowserWindow, entryUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", event => event.preventDefault());
  session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:"
        || (details.resourceType === "mainFrame" && details.url === entryUrl);
    } catch { /* Fail closed. */ }
    callback({ cancel: !allowed });
  });
}

async function render(request: Request, directory: string): Promise<{ pdfBase64: string; fontsReady: boolean }> {
  const file = join(directory, "source.html");
  await writeFile(file, request.html, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const entryUrl = pathToFileURL(file).href;
  let window: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    window = new BrowserWindow({
      show: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
      width: 1024, height: 1440,
      webPreferences: {
        partition: `temp:joko-pdf-${randomUUID()}`,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false,
        experimentalFeatures: false, plugins: false,
        navigateOnDragDrop: false, webviewTag: false,
        spellcheck: false, backgroundThrottling: false
      }
    });
    const target = window;
    lockWindow(target, entryUrl);
    const failure = new Promise<never>((_resolve, reject) => {
      target.webContents.once("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame) reject(new Error(`PDF HTML load failed (${code}).`));
      });
      target.webContents.once("render-process-gone", () => reject(new Error("PDF renderer process exited.")));
    });
    const work = (async () => {
      await Promise.race([target.loadFile(file), failure]);
      let fontTimer: ReturnType<typeof setTimeout> | undefined;
      const fontsReady = await Promise.race([
        target.webContents.executeJavaScript("document.fonts.ready.then(() => true)").then(value => value === true, () => false),
        new Promise<false>(resolve => { fontTimer = setTimeout(() => resolve(false), request.fontTimeoutMs); }),
        failure
      ]).finally(() => { if (fontTimer) clearTimeout(fontTimer); });
      const bytes = await Promise.race([target.webContents.printToPDF({
        landscape: request.landscape, printBackground: request.printBackground, pageSize: request.pageSize,
        margins: { top: request.margins.top, bottom: request.margins.bottom,
          left: request.margins.left, right: request.margins.right }
      }), failure]);
      if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) throw new Error("PDF helper output exceeds its budget.");
      return { pdfBase64: Buffer.from(bytes).toString("base64"), fontsReady };
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PDF render timed out.")), RENDER_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "joko-pdf-helper-"));
  let exitCode = 0;
  try {
    app.setPath("userData", directory);
    const request = await readRequest();
    await app.whenReady();
    const result = await render(request, directory);
    await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify({ version: 1, ok: true, ...result })}\n`, () => resolve()));
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : "PDF helper failed.";
    await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify({ version: 1, ok: false, message: message.slice(0, 500) })}\n`, () => resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  app.exit(exitCode);
}

void main().catch(error => {
  process.stderr.write(`JOKO_PDF_HELPER_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
