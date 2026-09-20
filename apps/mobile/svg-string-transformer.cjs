const { createRequire } = require("node:module");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const expoRequire = createRequire(require.resolve("expo/package.json"));
const upstreamTransformer = expoRequire("@expo/metro-config/babel-transformer");
const esbuild = require("esbuild");

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

module.exports.transform = ({ src, filename, options }) => {
  const transformed = filename.endsWith(".svg")
    ? `module.exports = ${JSON.stringify(src)};`
    : filename.endsWith(".pdfjs") ? buildPdfJsRuntimeModule(src, filename)
      : filename.endsWith(".modeljs") ? buildModelViewerRuntimeModule(src, filename) : src;
  return upstreamTransformer.transform({ src: transformed, filename, options });
};

module.exports.testing = { buildModelViewerRuntimeModule, buildPdfJsRuntimeModule, expectedStandardFonts };
