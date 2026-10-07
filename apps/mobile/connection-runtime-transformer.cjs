const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const mobileRoot = __dirname;
const workspaceRoot = path.resolve(mobileRoot, "../..");
const runtimeEntry = path.join(mobileRoot, "src", "connection-runtime.connjs");
const stylesFile = path.join(workspaceRoot, "apps", "web", "src", "styles.css");
const artworkRoot = path.join(workspaceRoot, "packages", "brand-assets", "src", "landing-artwork");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function connectionBuildOptions(src, filename) {
  const entryFilename = path.resolve(mobileRoot, filename);
  return {
    absWorkingDir: workspaceRoot,
    stdin: { contents: src, loader: "js", resolveDir: path.dirname(entryFilename), sourcefile: entryFilename },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome90", "safari15"],
    outfile: path.join(__dirname, ".connection-runtime", "connection.js"),
    loader: {
      ".svg": "dataurl", ".woff2": "dataurl", ".woff": "dataurl",
      ".ttf": "dataurl", ".otf": "dataurl", ".png": "dataurl",
      ".jpg": "dataurl", ".jpeg": "dataurl", ".webp": "dataurl"
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": '"production"'
    },
    legalComments: "inline",
    minify: true,
    metafile: true,
    write: false
  };
}

function getConnectionRuntimeCacheKey() {
  const result = esbuild.buildSync(connectionBuildOptions(fs.readFileSync(runtimeEntry, "utf8"), runtimeEntry));
  const digest = crypto.createHash("sha256").update(fs.readFileSync(__filename));
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    const filePath = path.resolve(workspaceRoot, name.split("?")[0]);
    digest.update(name, "utf8").update(Buffer.from([0])).update(fs.readFileSync(filePath));
  }
  return digest.digest("hex");
}

async function buildConnectionRuntimeModule(src, filename) {
  const entryFilename = path.resolve(mobileRoot, filename);
  if (entryFilename !== runtimeEntry
    || src.trim() !== 'import "@joko/web/connection-embedded";') {
    throw new Error("Only the Joko shared connection page entry may use the .connjs transformer.");
  }
  const embeddedAssets = new Map();
  function embedAsset(assetPath) {
    const extension = path.extname(assetPath).toLowerCase();
    const mime = {
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    }[extension];
    if (mime === undefined) throw new Error("The shared connection page asset format is unsupported.");
    const bytes = fs.readFileSync(assetPath);
    embeddedAssets.set(assetPath, {
      path: path.relative(workspaceRoot, assetPath).split(path.sep).join("/"),
      byteSize: bytes.byteLength,
      sha256Hex: sha256(bytes)
    });
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  const result = await esbuild.build({
    ...connectionBuildOptions(src, entryFilename),
    plugins: [{
      name: "offline-connection-assets",
      setup(build) {
        build.onLoad({ filter: /\.svg$/ }, ({ path: assetPath }) => ({
          contents: `export default ${JSON.stringify(embedAsset(assetPath))};`,
          loader: "js",
          watchFiles: [assetPath]
        }));
        build.onLoad({ filter: /\.css$/ }, ({ path: cssPath }) => {
          const watchFiles = [cssPath];
          const contents = fs.readFileSync(cssPath, "utf8").replace(/url\(([^)]+)\)/gu, (_match, raw) => {
            const value = raw.trim().replace(/^(["'])(.*)\1$/u, "$2");
            if (value.startsWith("data:")) return `url(${JSON.stringify(value)})`;
            if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(value)) {
              throw new Error("The shared connection page CSS contains an external asset.");
            }
            const assetPath = path.resolve(path.dirname(cssPath), value.split(/[?#]/u)[0]);
            watchFiles.push(assetPath);
            return `url(${JSON.stringify(embedAsset(assetPath))})`;
          });
          return { contents, loader: "css", resolveDir: path.dirname(cssPath), watchFiles };
        });
      }
    }]
  });
  const script = result.outputFiles?.find((file) => file.path.endsWith(".js"))?.text;
  const css = result.outputFiles?.find((file) => file.path.endsWith(".css"))?.text;
  if (!script || !css || !script.includes("jokoConnectionRuntime")
    || /<\/script/iu.test(script) || /<\/style/iu.test(css)
    || Buffer.byteLength(script, "utf8") > 12_000_000
    || Buffer.byteLength(css, "utf8") > 12_000_000) {
    throw new Error("The offline shared connection page bundle is invalid.");
  }
  for (const match of css.matchAll(/url\(([^)]+)\)/gu)) {
    const value = match[1].trim().replace(/^(["'])(.*)\1$/u, "$2");
    if (!value.startsWith("data:")) throw new Error("The shared connection page CSS contains an external asset.");
  }
  if (/@import\b/iu.test(css)) throw new Error("The shared connection page CSS contains an external stylesheet.");

  const inputs = Object.keys(result.metafile.inputs).map((name) => path.resolve(workspaceRoot, name.split("?")[0]));
  if (!inputs.includes(stylesFile)) throw new Error("The shared connection page did not bundle the canonical Web stylesheet.");
  const assets = [...embeddedAssets.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const expectedArtwork = fs.readdirSync(artworkRoot)
    .filter((name) => name.endsWith(".svg"))
    .map((name) => path.join(artworkRoot, name));
  if (expectedArtwork.length !== 12 || expectedArtwork.some((name) => !inputs.includes(name))) {
    throw new Error("The shared connection page did not embed the complete canonical artwork set.");
  }
  const sourceStyles = fs.readFileSync(stylesFile);
  const scriptBytes = Buffer.from(script, "utf8");
  const cssBytes = Buffer.from(css, "utf8");
  return `module.exports = ${JSON.stringify({
    script,
    css,
    scriptByteSize: scriptBytes.byteLength,
    cssByteSize: cssBytes.byteLength,
    scriptSha256Hex: sha256(scriptBytes),
    cssSha256Hex: sha256(cssBytes),
    bundleSha256Hex: sha256(Buffer.concat([scriptBytes, Buffer.from([0]), cssBytes])),
    stylesSourceByteSize: sourceStyles.byteLength,
    stylesSourceSha256Hex: sha256(sourceStyles),
    assets
  })};`;
}

module.exports = { buildConnectionRuntimeModule, getConnectionRuntimeCacheKey };
