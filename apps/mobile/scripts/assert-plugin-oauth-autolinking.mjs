import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const platform = process.argv[2];
if (platform !== "apple" && platform !== "android") throw new Error("Select the original native autolinking platform.");
const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const expoRequire = createRequire(require.resolve("expo/package.json"));
const packageRoot = dirname(expoRequire.resolve("expo-modules-autolinking/package.json"));
const raw = execFileSync(process.execPath, [join(packageRoot, "bin/expo-modules-autolinking.js"), "resolve", "--platform", platform,
  "--project-root", mobileRoot, "--json"], { cwd: mobileRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 ** 2, stdio: ["ignore", "pipe", "inherit"] });
const graph = JSON.parse(raw);
const matches = graph.modules?.filter(module => module.packageName === "joko-plugin-oauth") ?? [];
if (matches.length !== 1) throw new Error("The phone callback receiver is missing or duplicated in the actual Expo module graph.");
const module = matches[0], expected = join(mobileRoot, "modules/joko-plugin-oauth");
if (platform === "android") {
  const projects = module.projects?.filter(project => project.name === "joko-plugin-oauth") ?? [];
  if (projects.length !== 1 || realpathSync(projects[0].sourceDir) !== realpathSync(join(expected, "android"))
    || !projects[0].modules?.includes("app.joko.pluginoauth.JokoPluginOauthModule")) {
    throw new Error("The Android callback receiver is not registered through its original Gradle project and native class.");
  }
} else {
  const pods = module.pods?.filter(pod => pod.podName === "JokoPluginOauth") ?? [];
  if (pods.length !== 1 || realpathSync(pods[0].podspecDir) !== realpathSync(join(expected, "ios"))
    || !module.swiftModuleNames?.includes("JokoPluginOauth") || !module.modules?.some(value => value.class === "JokoPluginOauthModule")) {
    throw new Error("The Apple callback receiver is not registered through its original Pod and native class.");
  }
}
console.log(`Verified original JokoPluginOauth module, ${platform} native source and registration in Expo's actual autolinking graph.`);
