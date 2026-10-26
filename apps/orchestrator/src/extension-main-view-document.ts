import { posix } from "node:path";
import { build, type Loader } from "esbuild";
import { parse as parseJavascript } from "@babel/parser";
import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { EXTENSION_RESOURCE_BOOTSTRAP, extensionSourceSet } from "./extension-main-view-resource.js";

export const ISOLATED_EXTENSION_CSP = "default-src 'none'; script-src data:; style-src data: 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";

/** Materialize the declared local asset graph; the supplied reader retains the
 * original surface authority, canonical-path checks and byte budget. esbuild
 * never receives a filesystem namespace or permission to resolve packages. */
export async function isolatedExtensionDocument(input: {
  readonly html: Buffer;
  readonly entry: string;
  readonly resourceRoot?: string;
  readonly output?: "script" | "module" | "style";
  readonly read: (path: string) => Promise<{ readonly body: Buffer; readonly mimeType: string }>;
  readonly assertCurrent: () => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  const check = async () => { input.signal?.throwIfAborted(); await input.assertCurrent(); input.signal?.throwIfAborted(); };
  const utf8 = (bytes: Buffer) => {
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) throw new Error("Extension document is not valid UTF-8.");
    return value;
  };
  const assetPath = (value: string, base: string): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)|[\\\u0000-\u001f%?#]/iu.test(value)) throw new Error("Extension asset is not a local path.");
    const path = posix.normalize(posix.join(posix.dirname(base), value));
    if (path === ".." || path.startsWith("../")) throw new Error("Extension asset escaped its declared directory.");
    return path;
  };
  const data = (bytes: Buffer | Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const read = async (path: string) => { await check(); const asset = await input.read(path); await check(); return asset; };
  const moduleAssetUrls = async (bytes: Buffer, path: string): Promise<string> => {
    const source = utf8(bytes), edits: Array<{ start: number; end: number; value: string }> = [];
    const ast = parseJavascript(source, { sourceType: "unambiguous", createImportExpressions: false });
    const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const visit = async (value: unknown): Promise<void> => {
      if (Array.isArray(value)) { for (const child of value) await visit(child); return; }
      const node = object(value); if (node === undefined) return;
      const objectNode = object(node["object"]);
      if (node["type"] === "MemberExpression" && object(node["property"])?.["name"] === "url" && objectNode?.["type"] === "MetaProperty"
        && object(objectNode["meta"])?.["name"] === "import" && object(objectNode["property"])?.["name"] === "meta"
        && typeof node["start"] === "number" && typeof node["end"] === "number") {
        const symbol = 'globalThis[Symbol.for("joko.extension.surface.base")]';
        edits.push({ start: node["start"], end: node["end"], value: `(${symbol}?new URL(${JSON.stringify((input.resourceRoot ?? "") + path)},${symbol}).href:import.meta.url)` });
      }
      const args = node["arguments"], callee = object(node["callee"]);
      if (node["type"] === "CallExpression" && callee?.["type"] === "Import" && typeof callee["start"] === "number" && typeof callee["end"] === "number") {
        edits.push({ start: callee["start"], end: callee["end"], value: `globalThis[Symbol.for("joko.extension.surface.import")].bind(null,${JSON.stringify((input.resourceRoot ?? "") + path)})` });
      }
      if (node["type"] === "NewExpression" && callee?.["type"] === "Identifier" && callee["name"] === "URL" && Array.isArray(args) && args.length === 2) {
        const relative = object(args[0]), base = object(args[1]), meta = object(base?.["object"]);
        if (relative?.["type"] === "StringLiteral" && typeof relative["value"] === "string" && typeof relative["start"] === "number" && typeof relative["end"] === "number"
          && base?.["type"] === "MemberExpression" && object(base["property"])?.["name"] === "url" && meta?.["type"] === "MetaProperty"
          && object(meta["meta"])?.["name"] === "import" && object(meta["property"])?.["name"] === "meta") {
          const asset = await read(assetPath(relative["value"], path));
          edits.push({ start: relative["start"], end: relative["end"], value: JSON.stringify(data(asset.body, asset.mimeType)) });
        }
      }
      for (const child of Object.values(node)) await visit(child);
    };
    await visit(ast);
    return edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), source);
  };
  const compile = async (path: string, contents?: string, loader?: Loader): Promise<{ script: string; text: string; css?: string }> => {
    const result = await build({ entryPoints: [path], bundle: true, write: false, outdir: "out", format: "esm", platform: "browser",
      target: "es2022", treeShaking: false, logLevel: "silent", legalComments: "inline", plugins: [{ name: "authorized-surface", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.path.startsWith("data:") && args.kind === "url-token") return { path: args.path, external: true };
          const resolved = args.kind === "entry-point" ? args.path : assetPath(args.path, args.importer);
          return { path: resolved, namespace: "authorized-surface" };
        });
        builder.onLoad({ filter: /.*/, namespace: "authorized-surface" }, async args => {
          const asset = args.path === path && contents !== undefined ? { body: Buffer.from(contents), mimeType: "" } : await read(args.path);
          const extension = posix.extname(args.path).toLowerCase();
          const kind: Loader = args.path === path && loader !== undefined ? loader
            : extension === ".css" ? "css" : [".js", ".mjs"].includes(extension) ? "js" : extension === ".json" ? "json" : "dataurl";
          return { contents: kind === "js" ? await moduleAssetUrls(asset.body, args.path) : asset.body, loader: kind };
        });
      } }] });
    await check();
    const output = result.outputFiles.find(file => file.path.endsWith(loader === "css" || path.endsWith(".css") ? ".css" : ".js"));
    if (output === undefined || result.warnings.length > 0) throw new Error("Extension asset graph could not be materialized.");
    const css = result.outputFiles.find(file => file.path.endsWith(".css") && file !== output);
    return { script: data(output.contents, output.path.endsWith(".css") ? "text/css" : "text/javascript"), text: output.text, ...(css === undefined ? {} : { css: data(css.contents, "text/css") }) };
  };
  if (input.output !== undefined) {
    const output = await compile(input.entry, utf8(input.html), input.output === "style" ? "css" : undefined);
    const styles = output.css === undefined ? "" : `{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(output.css)};document.head.append(link);}\n`;
    await check(); return Buffer.from(styles + output.text);
  }
  const doc = parse(utf8(input.html));
  const nodes = (node: Tree.Node): Tree.Element[] => [ ...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(nodes) : []) ];
  const elements = nodes(doc);
  const head = elements.find(element => element.tagName === "head")!;
  const append = (html: string) => { const fragment = parseFragment(html); for (const child of fragment.childNodes) { child.parentNode = head; head.childNodes.push(child); } };
  for (const element of elements) {
    const attr = (name: string) => element.attrs.find(attribute => attribute.name === name);
    const src = attr("src"), href = attr("href");
    const srcset = attr("srcset");
    if (srcset !== undefined) srcset.value = (await Promise.all(extensionSourceSet(srcset.value).map(async candidate => {
      const asset = candidate.url.startsWith("data:") ? undefined : await read(assetPath(candidate.url, input.entry));
      return `${asset === undefined ? candidate.url : data(asset.body, asset.mimeType)}${candidate.descriptor ? " " + candidate.descriptor : ""}`;
    }))).join(", ");
    const style = attr("style");
    if (style !== undefined && style.value.trim()) {
      const compiled = await compile(input.entry + ".css", `.joko-inline{${style.value}}`, "css");
      style.value = compiled.text.slice(compiled.text.indexOf("{") + 1, compiled.text.lastIndexOf("}"));
    }
    if (element.tagName === "meta" && attr("http-equiv")?.value.toLowerCase() === "content-security-policy") {
      element.parentNode!.childNodes.splice(element.parentNode!.childNodes.indexOf(element), 1); continue;
    }
    if (element.tagName === "script" && src !== undefined) {
      const output = await compile(assetPath(src.value, input.entry)); src.value = output.script;
      element.attrs = element.attrs.filter(attribute => !["integrity", "crossorigin"].includes(attribute.name));
      if (output.css !== undefined) append(`<link rel="stylesheet" href="${output.css}">`);
    } else if (element.tagName === "link" && href !== undefined && attr("rel")?.value === "stylesheet") {
      const path = assetPath(href.value, input.entry);
      element.attrs.push({ name: "data-joko-style-base", value: (input.resourceRoot ?? "") + path });
      href.value = (await compile(path)).script;
      element.attrs = element.attrs.filter(attribute => !["integrity", "crossorigin"].includes(attribute.name));
    } else if (element.tagName === "style") {
      const source = element.childNodes.filter((node): node is Tree.TextNode => node.nodeName === "#text").map(node => node.value).join("");
      if (source.trim()) { const compiled = await compile(input.entry + ".css", source, "css");
        element.childNodes = []; element.tagName = "link"; element.nodeName = "link";
        element.attrs = [{ name: "rel", value: "stylesheet" }, { name: "href", value: compiled.script }]; }
    } else {
      for (const attribute of element.attrs) if (["src", "poster"].includes(attribute.name) && !attribute.value.startsWith("data:") && !attribute.value.startsWith("blob:")) {
        const asset = await read(assetPath(attribute.value, input.entry)); attribute.value = data(asset.body, asset.mimeType);
      }
    }
  }
  const policy = parseFragment(`<meta http-equiv="Content-Security-Policy" content="${ISOLATED_EXTENSION_CSP}">`).childNodes[0]!;
  const bridge = parseFragment(`<script src="${data(Buffer.from(EXTENSION_RESOURCE_BOOTSTRAP), "text/javascript")}"></script>`).childNodes[0]!;
  policy.parentNode = head; bridge.parentNode = head; head.childNodes.unshift(policy, bridge);
  await check();
  return Buffer.from(serialize(doc));
}
