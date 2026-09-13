import { useLayoutEffect, useState } from "react";
import { mermaidDocumentTheme, type MermaidTheme } from "./mermaid-render.js";

export function useMermaidTheme(ownerDocument: Document | undefined): MermaidTheme {
  const [state, setState] = useState<{ readonly document: Document; readonly theme: MermaidTheme }>();
  useLayoutEffect(() => {
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerDocument === undefined || ownerWindow == null) return;
    const update = (): void => setState({ document: ownerDocument, theme: mermaidDocumentTheme(ownerDocument) });
    update();
    const observer = new ownerWindow.MutationObserver(update);
    observer.observe(ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const media = ownerWindow.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, [ownerDocument]);
  return ownerDocument === undefined ? "default" : state?.document === ownerDocument ? state.theme : mermaidDocumentTheme(ownerDocument);
}
