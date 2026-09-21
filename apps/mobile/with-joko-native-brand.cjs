const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const sharp = require("sharp");

const expoRequire = createRequire(require.resolve("expo/package.json"));
const prebuildRoot = path.dirname(expoRequire.resolve("@expo/prebuild-config/package.json"));
const { setIconAsync: setAndroidIconAsync } = require(path.join(
  prebuildRoot,
  "build/plugins/icons/withAndroidIcons.js"
));
const { setIconsAsync: setIosIconsAsync } = require(path.join(
  prebuildRoot,
  "build/plugins/icons/withIosIcons.js"
));

const lightOutput = "icon-light.png";
const darkOutput = "icon-dark.png";

/**
 * Expo's native icon pipeline accepts raster input only. Keep SVG as the sole
 * checked-in source and materialize its transient platform input outside the
 * workspace. Expo then owns the Android/iOS platform icon catalogs.
 */
function withJokoNativeBrand(config) {
  config = withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application?.$) throw new Error("Joko native branding could not find the Android application manifest.");
    application.$["android:icon"] = "@mipmap/ic_launcher";
    application.$["android:roundIcon"] = "@mipmap/ic_launcher";
    return modConfig;
  });
  config = withDangerousMod(config, ["android", async (modConfig) => {
    if (!modConfig.modRequest.introspect) {
      await withTemporaryJokoNativeBrandAsync(modConfig.modRequest.projectRoot, (generated) =>
        setAndroidIconAsync(modConfig.modRequest.projectRoot, {
          icon: generated.light,
          foregroundImage: null,
          backgroundColor: null,
          backgroundImage: null,
          monochromeImage: null,
          isAdaptive: false
        }));
    }
    return modConfig;
  }]);
  return withDangerousMod(config, ["ios", async (modConfig) => {
    if (!modConfig.modRequest.introspect) {
      await withTemporaryJokoNativeBrandAsync(modConfig.modRequest.projectRoot, (generated) =>
        setIosIconsAsync({
          ...modConfig,
          ios: { ...modConfig.ios, icon: { light: generated.light, dark: generated.dark } }
        }, modConfig.modRequest.projectRoot));
    }
    return modConfig;
  }]);
}

async function withTemporaryJokoNativeBrandAsync(projectRoot, consume) {
  const outputRoot = await fs.mkdtemp(path.join(tmpdir(), "joko-native-brand-"));
  try {
    const generated = await generateJokoNativeBrandAsync(projectRoot, outputRoot);
    return await consume(generated);
  } finally {
    await fs.rm(outputRoot, { recursive: true, force: true });
  }
}

async function generateJokoNativeBrandAsync(projectRoot, outputRoot) {
  if (!outputRoot) throw new Error("Native brand generation requires an explicit temporary output directory.");
  await generate(projectRoot, outputRoot);
  return {
    light: path.resolve(outputRoot, lightOutput),
    dark: path.resolve(outputRoot, darkOutput)
  };
}

async function generate(projectRoot, outputRoot) {
  const sourceRoot = path.resolve(projectRoot, "../../packages/brand-assets/src");
  const outputDirectory = path.resolve(outputRoot);
  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    render(path.join(sourceRoot, "icon-light.svg"), path.join(outputDirectory, "icon-light.png")),
    render(path.join(sourceRoot, "icon-dark.svg"), path.join(outputDirectory, "icon-dark.png"))
  ]);
}

async function render(source, output) {
  const svg = await fs.readFile(source);
  const png = await sharp(svg, { density: 192 })
    .resize(1024, 1024, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(output, png);
}

module.exports = withJokoNativeBrand;
module.exports.generateJokoNativeBrandAsync = generateJokoNativeBrandAsync;
module.exports.nativeBrandFileNames = Object.freeze({ lightOutput, darkOutput });
