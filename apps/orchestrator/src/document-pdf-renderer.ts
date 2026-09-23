import { chromium, type BrowserServer } from "playwright-core";
import { PdfRenderError, type PdfRenderer, type PdfRenderRequest, type PdfRenderOutput } from "@joko/tool-document";

let renderChain: Promise<void> = Promise.resolve();

function renderTimeout(): PdfRenderError {
  return new PdfRenderError("RENDER_TIMEOUT", "PDF rendering exceeded 30 seconds.");
}

/** One ephemeral, network-isolated Chromium job at a time. */
export class ChromiumDocumentPdfRenderer implements PdfRenderer {
  constructor(readonly executablePath: string) {}

  render(input: PdfRenderRequest): Promise<PdfRenderOutput> {
    const run = renderChain.then(() => this.#renderOnce(input), () => this.#renderOnce(input));
    renderChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #renderOnce(input: PdfRenderRequest): Promise<PdfRenderOutput> {
    input.signal?.throwIfAborted();
    let server: BrowserServer | undefined;
    let expired = false;
    const deadline = Date.now() + input.timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const work = (async (): Promise<PdfRenderOutput> => {
      server = await chromium.launchServer({
        executablePath: this.executablePath,
        host: "127.0.0.1",
        headless: true,
        chromiumSandbox: true,
        timeout: remaining(),
        args: ["--disable-extensions", "--no-first-run", "--disable-background-networking"]
      });
      if (expired) throw renderTimeout();
      const browser = await chromium.connect(server.wsEndpoint(), { timeout: remaining() });
      const context = await browser.newContext({
        acceptDownloads: false, serviceWorkers: "block", offline: true,
        viewport: { width: 1024, height: 1440 }, permissions: []
      });
      await context.route("**/*", route => route.abort("blockedbyclient"));
      await context.routeWebSocket("**/*", route => route.close({ code: 1008, reason: "PDF rendering is offline" }));
      const page = await context.newPage();
      page.on("popup", popup => { void popup.close().catch(() => undefined); });
      await page.setContent(input.html, { waitUntil: "load", timeout: remaining() });
      if (expired) throw renderTimeout();
      let fontTimer: ReturnType<typeof setTimeout> | undefined;
      const fontsReady = await Promise.race([
        page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false),
        new Promise<false>(resolve => { fontTimer = setTimeout(() => resolve(false), Math.min(input.fontTimeoutMs, remaining())); })
      ]).finally(() => { if (fontTimer) clearTimeout(fontTimer); });
      if (expired) throw renderTimeout();
      const buffer = await page.pdf({
        format: input.pageSize,
        landscape: input.landscape,
        printBackground: input.printBackground,
        margin: { top: `${input.margins.top}in`, bottom: `${input.margins.bottom}in`,
          left: `${input.margins.left}in`, right: `${input.margins.right}in` },
        preferCSSPageSize: false
      });
      return { buffer, fontsReady };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(renderTimeout()); }, input.timeoutMs);
      if (input.signal) {
        abort = () => { expired = true; reject(input.signal?.reason ?? new Error("PDF render cancelled.")); };
        input.signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      return await Promise.race([work, stopped]);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (error instanceof PdfRenderError) throw error;
      throw new PdfRenderError("RENDER_FAILED", "PDF renderer could not complete the document.");
    } finally {
      expired = true;
      if (timer) clearTimeout(timer);
      if (abort && input.signal) input.signal.removeEventListener("abort", abort);
      if (server) {
        const closing = server.close().catch(() => undefined);
        const closure = new Promise<void>(resolve => setTimeout(resolve, 2_000));
        await Promise.race([closing, closure]);
        if (server.process().exitCode === null) await server.kill().catch(() => undefined);
      } else {
        void work.finally(() => {
          if (server) void server.kill().catch(() => undefined);
        }).catch(() => undefined);
      }
    }
  }
}
