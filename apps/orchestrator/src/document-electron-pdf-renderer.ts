import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { PdfRenderError, type PdfRenderer, type PdfRenderRequest, type PdfRenderOutput } from "@joko/tool-document";

const MAX_FRAME_BYTES = 90 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
let renderChain: Promise<void> = Promise.resolve();

function helperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "LC_CTYPE"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (source[name] !== undefined) result[name] = source[name];
  return result;
}

/** Launch the packaged Electron PDF entry as an isolated one-shot host. */
export class ElectronDocumentPdfRenderer implements PdfRenderer {
  constructor(readonly executablePath: string, readonly appPath?: string) {}

  render(input: PdfRenderRequest): Promise<PdfRenderOutput> {
    const run = renderChain.then(() => this.#renderOnce(input), () => this.#renderOnce(input));
    renderChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #renderOnce(input: PdfRenderRequest): Promise<PdfRenderOutput> {
    input.signal?.throwIfAborted();
    const args = [...(this.appPath ? [this.appPath] : []), "--joko-pdf-render-helper"];
    const child = spawn(this.executablePath, args, {
      cwd: this.appPath ?? dirname(this.executablePath),
      env: helperEnvironment(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore", "pipe"]
    });
    const request = JSON.stringify({ version: 1,
      htmlBase64: Buffer.from(input.html, "utf8").toString("base64"),
      pageSize: input.pageSize, landscape: input.landscape,
      printBackground: input.printBackground, margins: input.margins,
      fontTimeoutMs: input.fontTimeoutMs
    });
    if (Buffer.byteLength(request, "utf8") > MAX_FRAME_BYTES) {
      child.kill();
      throw new PdfRenderError("FILE_TOO_LARGE", "PDF renderer input exceeds its budget.");
    }
    return await new Promise<PdfRenderOutput>((resolveResult, reject) => {
      const parts: Buffer[] = [];
      let length = 0;
      let settled = false;
      const finish = (result?: PdfRenderOutput, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (error) { child.kill(); reject(error); }
        else resolveResult(result!);
      };
      const abort = (): void => finish(undefined, input.signal?.reason ?? new Error("PDF rendering cancelled."));
      const timer = setTimeout(() => finish(undefined, new PdfRenderError("RENDER_TIMEOUT", "PDF renderer exceeded 30 seconds.")), input.timeoutMs);
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) { abort(); return; }
      child.once("error", () => finish(undefined, new PdfRenderError("RENDER_FAILED", "PDF render helper could not start.")));
      const inputPipe = child.stdio[3];
      const outputPipe = child.stdout;
      if (!inputPipe || !("end" in inputPipe) || !outputPipe) {
        finish(undefined, new PdfRenderError("RENDER_FAILED", "PDF render helper input pipe is unavailable."));
        return;
      }
      inputPipe.on("error", () => finish(undefined, new PdfRenderError("RENDER_FAILED", "PDF render helper rejected input.")));
      outputPipe.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_FRAME_BYTES) {
          finish(undefined, new PdfRenderError("FILE_TOO_LARGE", "PDF render helper output exceeds its budget."));
          return;
        }
        parts.push(chunk);
      });
      child.once("close", code => {
        if (settled) return;
        try {
          const response = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
          if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error();
          const value = response as Record<string, unknown>;
          if (value["version"] !== 1 || value["ok"] !== true || code !== 0
            || typeof value["pdfBase64"] !== "string" || typeof value["fontsReady"] !== "boolean"
            || value["pdfBase64"].length > Math.ceil(MAX_PDF_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value["pdfBase64"])) throw new Error();
          const buffer = Buffer.from(value["pdfBase64"], "base64");
          if (buffer.length === 0 || buffer.length > MAX_PDF_BYTES || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error();
          finish({ buffer, fontsReady: value["fontsReady"] });
        } catch {
          finish(undefined, new PdfRenderError("RENDER_FAILED", "PDF render helper failed or returned invalid content."));
        }
      });
      inputPipe.end(`${request}\n`);
    });
  }
}
