const { createRequire } = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const expoRequire = createRequire(require.resolve("expo/package.json"));
const upstreamTransformer = expoRequire("@expo/metro-config/babel-transformer");
const esbuild = require("esbuild");
const { buildConnectionRuntimeModule, getConnectionRuntimeCacheKey } = require("./connection-runtime-transformer.cjs");
const linkspanSelectionPath = path.resolve(__dirname, 'dist/linkspan-runtime/selected.json');
const sameSourcePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
function linkspanSelection() {
  if (!fs.existsSync(linkspanSelectionPath)) return { relayBackends: [], nativeIroh: false, nativeHttpConnect: false, webRtc: false };
  const value = JSON.parse(fs.readFileSync(linkspanSelectionPath, 'utf8'));
  if (value.schema !== 1 || !Array.isArray(value.relayBackends) || value.relayBackends.length > 2 || new Set(value.relayBackends).size !== value.relayBackends.length
    || value.relayBackends.some(kind => !['iroh', 'tailcat'].includes(kind)) || typeof value.nativeIroh !== 'boolean'
    || typeof value.nativeHttpConnect !== 'boolean' || typeof value.webRtc !== 'boolean') throw new Error('The selected Mobile runtime receipt is invalid.');
  return value;
}
function buildLinkspanAssetModule(filename) {
  if (!sameSourcePath(filename, path.resolve(__dirname, 'src/linkspan-runtime-assets.ts'))) throw new Error('Only the audited Mobile runtime selector may select Asset modules.');
  const selected = linkspanSelection();
  const entries = selected.relayBackends.map(kind => {
    const names = [`${kind}-runtime.lsruntime`, `${kind}.wasm`, `${kind}-notices.lsnotice`];
    for (const name of names) {
      const info = fs.lstatSync(path.resolve(__dirname, `dist/linkspan-runtime/${name}`));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('The selected Mobile runtime asset is unavailable.');
    }
    return `${JSON.stringify(kind)}:Object.freeze([${names.map(name => `require(${JSON.stringify(`../dist/linkspan-runtime/${name}`)})`).join(',')}])`;
  });
  let webRtcAssets = 'undefined';
  if (selected.webRtc) {
    const names = ['webrtc-runtime.lsruntime', 'webrtc-notices.lsnotice'];
    for (const name of names) {
      const info = fs.lstatSync(path.resolve(__dirname, 'dist/linkspan-runtime', name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('The selected WebRTC runtime asset is unavailable.');
    }
    webRtcAssets = `Object.freeze([${names.map(name => `require(${JSON.stringify(`../dist/linkspan-runtime/${name}`)})`).join(',')}])`;
  }
  let httpConnectNotices = 'undefined';
  if (selected.nativeHttpConnect) {
    const name = 'http-connect-notices.lsnotice', path = require('node:path').resolve(__dirname, 'dist/linkspan-runtime', name);
    const info = fs.lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The selected native proxy notices are unavailable.');
    httpConnectNotices = `require(${JSON.stringify(`../dist/linkspan-runtime/${name}`)})`;
  }
  return `module.exports={linkspanRuntimeAssets:Object.freeze({${entries.join(',')}}),linkspanNativeIrohSelected:${selected.nativeIroh === true},linkspanNativeHttpConnectSelected:${selected.nativeHttpConnect === true},linkspanHttpConnectNoticesAsset:${httpConnectNotices},linkspanWebRtcRuntimeAssets:${webRtcAssets}};`;
}
function buildHttpConnectClientModule(src, filename) {
  if (!sameSourcePath(filename, path.resolve(__dirname, 'src/mobile-http-connect-client.ts'))) throw new Error('Only the audited native proxy binding may select CONNECT code.');
  if (linkspanSelection().nativeHttpConnect) return src;
  // Remove the module edges before Metro builds its graph. A runtime boolean
  // around dynamic import still bundles the parser into unselected Hermes apps.
  return `import { LinkspanError } from '@jokoagent/linkspan-core'; export async function connectMobileHttpConnect(){throw new LinkspanError('unavailable','The native proxy transport was not selected for this app build.');}`;
}

const expectedStandardFonts = [
  "FoxitDingbats.pfb",
  "FoxitFixed.pfb",
  "FoxitFixedBold.pfb",
  "FoxitFixedBoldItalic.pfb",
  "FoxitFixedItalic.pfb",
  "FoxitSerif.pfb",
  "FoxitSerifBold.pfb",
  "FoxitSerifBoldItalic.pfb",
  "FoxitSerifItalic.pfb",
  "FoxitSymbol.pfb",
  "LiberationSans-Bold.ttf",
  "LiberationSans-BoldItalic.ttf",
  "LiberationSans-Italic.ttf",
  "LiberationSans-Regular.ttf",
  "LICENSE_FOXIT",
  "LICENSE_LIBERATION"
];

function readEmbeddedDirectory(directory, include) {
  const names = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && include(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const values = {};
  let byteSize = 0;
  const digest = crypto.createHash("sha256");
  for (const name of names) {
    const filePath = path.resolve(directory, name);
    if (path.dirname(filePath) !== directory) throw new Error("The pdf.js resource path is unsafe.");
    const bytes = fs.readFileSync(filePath);
    values[name] = bytes.toString("base64");
    byteSize += bytes.byteLength;
    digest.update(name, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(bytes);
  }
  return { names, values, byteSize, sha256Hex: digest.digest("hex") };
}

function buildPdfJsRuntimeModule(src, filename) {
  if (path.basename(filename) !== "pdfjs-runtime.pdfjs") {
    throw new Error("Only the audited Joko pdf.js runtime entry may use the .pdfjs transformer.");
  }
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageManifest.version !== "5.7.284") throw new Error("The mobile pdf.js runtime version is not pinned.");

  const result = esbuild.buildSync({
    stdin: { contents: src, loader: "js", resolveDir: path.dirname(filename), sourcefile: filename },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome90", "safari15"],
    legalComments: "inline",
    minify: true,
    write: false
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || !script.includes("pdfjsLib") || !script.includes("pdfjsWorker")
    || /<\/script/iu.test(script)) throw new Error("The mobile pdf.js runtime bundle is invalid.");

  const cMaps = readEmbeddedDirectory(path.resolve(packageRoot, "cmaps"), () => true);
  const standardFonts = readEmbeddedDirectory(
    path.resolve(packageRoot, "standard_fonts"),
    () => true
  );
  if (cMaps.names.length !== 169 || cMaps.names.filter((name) => name.endsWith(".bcmap")).length !== 168
    || !cMaps.names.includes("UniGB-UTF16-H.bcmap") || !cMaps.names.includes("LICENSE")) {
    throw new Error("The complete audited pdf.js packed CMap set is unavailable.");
  }
  if (standardFonts.names.length !== expectedStandardFonts.length
    || standardFonts.names.some((name, index) => name !== expectedStandardFonts[index])) {
    throw new Error("The complete audited pdf.js standard-font set is unavailable.");
  }

  return `module.exports = ${JSON.stringify({
    version: packageManifest.version,
    script,
    scriptSha256Hex: crypto.createHash("sha256").update(script, "utf8").digest("hex"),
    cMaps: cMaps.values,
    cMapByteSize: cMaps.byteSize,
    cMapSha256Hex: cMaps.sha256Hex,
    standardFonts: standardFonts.values,
    standardFontByteSize: standardFonts.byteSize,
    standardFontSha256Hex: standardFonts.sha256Hex
  })};`;
}

function nearestPackageManifest(entry) {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8"));
    directory = path.dirname(directory);
  }
  throw new Error("The package manifest is unavailable.");
}

function buildModelViewerRuntimeModule(src, filename) {
  if (path.basename(filename) !== "model-viewer-runtime.modeljs") {
    throw new Error("Only the audited Joko model-viewer runtime entry may use the .modeljs transformer.");
  }
  const modelViewerManifest = JSON.parse(fs.readFileSync(require.resolve("@google/model-viewer/package.json"), "utf8"));
  const threeManifest = nearestPackageManifest(require.resolve("three"));
  if (modelViewerManifest.version !== "4.3.1" || threeManifest.version !== "0.183.2") {
    throw new Error("The mobile model-viewer runtime versions are not pinned.");
  }
  const result = esbuild.buildSync({
    stdin: { contents: src, loader: "js", resolveDir: path.dirname(filename), sourcefile: filename },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome90", "safari15"],
    legalComments: "inline",
    minify: true,
    write: false
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || script.length < 100_000 || !script.includes("jokoModelViewerRuntime")
    || !script.includes("model-viewer") || /<\/script/iu.test(script)) {
    throw new Error("The mobile model-viewer runtime bundle is invalid.");
  }
  return `module.exports = ${JSON.stringify({
    modelViewerVersion: modelViewerManifest.version,
    threeVersion: threeManifest.version,
    script,
    scriptSha256Hex: crypto.createHash("sha256").update(script, "utf8").digest("hex")
  })};`;
}

function buildRichMarkdownRuntimeModule(src, filename) {
  if (path.basename(filename) !== "rich-markdown-runtime.richjs") {
    throw new Error("The mobile rich Markdown runtime entry is invalid.");
  }
  const mermaidManifest = nearestPackageManifest(require.resolve("mermaid"));
  const katexRoot = path.dirname(require.resolve("katex/package.json"));
  const katexManifest = JSON.parse(fs.readFileSync(path.join(katexRoot, "package.json"), "utf8"));
  const highlightManifest = nearestPackageManifest(require.resolve("highlight.js"));
  if (mermaidManifest.version !== "11.16.0" || katexManifest.version !== "0.16.47"
    || highlightManifest.version !== "11.11.1") throw new Error("The mobile rich Markdown runtime versions are not pinned.");
  const result = esbuild.buildSync({
    stdin: { contents: src, loader: "js", resolveDir: path.dirname(filename), sourcefile: filename },
    bundle: true, format: "iife", platform: "browser", target: ["chrome90", "safari15"],
    legalComments: "inline", minify: true, write: false
  });
  const script = result.outputFiles?.[0]?.text;
  if (!script || script.length > 8_000_000 || !script.includes("jokoMermaid")) {
    throw new Error("The mobile rich Markdown runtime bundle is invalid.");
  }
  const katexCss = fs.readFileSync(path.join(katexRoot, "dist", "katex.min.css"), "utf8")
    .replace(/url\(([^)]+)\)/gu, (_match, raw) => {
      const resource = raw.replace(/["']/gu, "");
      if (!/^fonts\/KaTeX_[A-Za-z0-9_-]+\.(woff2?|ttf)$/u.test(resource)) {
        throw new Error("The mobile KaTeX font path is invalid.");
      }
      const extension = path.extname(resource).slice(1);
      const mime = extension === "ttf" ? "font/ttf" : `font/${extension}`;
      return `url(data:${mime};base64,${fs.readFileSync(path.join(katexRoot, "dist", resource)).toString("base64")})`;
    });
  return `module.exports = ${JSON.stringify({
    mermaidVersion: mermaidManifest.version, katexVersion: katexManifest.version,
    highlightVersion: highlightManifest.version, mermaidScript: script,
    katexScript: fs.readFileSync(path.join(katexRoot, "dist", "katex.min.js"), "utf8"), katexCss
  })};`;
}

module.exports.transform = ({ src, filename, options }) => {
  if (filename.endsWith(".connjs")) {
    return buildConnectionRuntimeModule(src, filename)
      .then((transformed) => upstreamTransformer.transform({ src: transformed, filename, options }));
  }
  const transformed = sameSourcePath(filename, path.resolve(__dirname, 'src/mobile-http-connect-client.ts')) ? buildHttpConnectClientModule(src, filename)
    : sameSourcePath(filename, path.resolve(__dirname, 'src/linkspan-runtime-assets.ts')) ? buildLinkspanAssetModule(filename) : filename.endsWith(".svg")
    ? `module.exports = ${JSON.stringify(src)};`
    : filename.endsWith(".pdfjs") ? buildPdfJsRuntimeModule(src, filename)
      : filename.endsWith(".modeljs") ? buildModelViewerRuntimeModule(src, filename)
        : filename.endsWith(".richjs") ? buildRichMarkdownRuntimeModule(src, filename) : src;
  return upstreamTransformer.transform({ src: transformed, filename, options });
};

module.exports.testing = { buildModelViewerRuntimeModule, buildPdfJsRuntimeModule, buildRichMarkdownRuntimeModule, buildLinkspanAssetModule, buildHttpConnectClientModule, expectedStandardFonts };

module.exports.getCacheKey = (options) => crypto.createHash("sha256")
  .update(fs.readFileSync(__filename))
  .update(upstreamTransformer.getCacheKey?.(options) ?? "")
  .update(getConnectionRuntimeCacheKey())
  .update(fs.existsSync(linkspanSelectionPath) ? fs.readFileSync(linkspanSelectionPath) : 'no-selected-Linkspan-assets')
  .digest("hex");
