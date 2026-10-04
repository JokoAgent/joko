declare module "*.richjs" {
  interface MobileRichMarkdownRuntime {
    readonly mermaidVersion: string;
    readonly katexVersion: string;
    readonly highlightVersion: string;
    readonly mermaidScript: string;
    readonly katexScript: string;
    readonly katexCss: string;
  }
  const bundle: MobileRichMarkdownRuntime;
  export default bundle;
}
