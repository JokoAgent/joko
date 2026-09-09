import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";

type MermaidApi = typeof import("mermaid")["default"];
export type MermaidTheme = "dark" | "default";
let moduleFlight: Promise<MermaidApi> | undefined;
let renderTail: Promise<void> = Promise.resolve();
let renderSequence = 0;

async function loadMermaid(): Promise<MermaidApi> {
  moduleFlight ??= import("mermaid").then((module) => module.default).catch((error: unknown) => {
    moduleFlight = undefined;
    throw error;
  });
  return moduleFlight;
}

export function mermaidDocumentTheme(ownerDocument: Document): MermaidTheme {
  const theme = ownerDocument.documentElement.dataset.theme;
  return theme === "dark" || (theme === "system" && ownerDocument.defaultView?.matchMedia("(prefers-color-scheme: dark)").matches === true)
    ? "dark" : "default";
}

/** Configuration, parsing and rendering share one queue because the library keeps global configuration. */
export function renderMermaid(source: string, theme: MermaidTheme, context: BrowserActionContext): Promise<string> {
  const task = renderTail.then(async () => {
    assertBrowserActionCurrent(context);
    const api = await loadMermaid();
    assertBrowserActionCurrent(context);
    const { ownerDocument, signal } = context;
    const staging = ownerDocument.createElement("div");
    staging.setAttribute("aria-hidden", "true");
    staging.inert = true;
    staging.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;";
    staging.style.fontFamily = ownerDocument.defaultView!.getComputedStyle(ownerDocument.body).fontFamily;
    ownerDocument.body.append(staging);
    const retire = (): void => staging.remove();
    signal.addEventListener("abort", retire, { once: true });
    try {
      api.initialize({
        startOnLoad: false, securityLevel: "strict", fontFamily: "inherit", theme,
        flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, class: { useMaxWidth: false },
        state: { useMaxWidth: false }, er: { useMaxWidth: false }, gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false }, pie: { useMaxWidth: false }
      });
      await api.parse(source);
      assertBrowserActionCurrent(context);
      const { svg } = await api.render(`joko-mermaid-${++renderSequence}`, source, staging);
      assertBrowserActionCurrent(context);
      return svg;
    } finally {
      signal.removeEventListener("abort", retire);
      staging.remove();
    }
  });
  renderTail = task.then(() => undefined, () => undefined);
  return new Promise<string>((resolve, reject) => {
    const { signal } = context;
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    task.then((svg) => { cleanup(); resolve(svg); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
