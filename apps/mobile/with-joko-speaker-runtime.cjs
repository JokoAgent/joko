const { withPodfile } = require("expo/config-plugins");

const speakerRuntime = "pod 'onnxruntime-c', :podspec => '../modules/joko-speaker-onnx/ios/onnxruntime-c.podspec.json'";

module.exports = (config) => withPodfile(config, (mod) => {
  const podfile = mod.modResults.contents;
  if (podfile.includes(speakerRuntime)) return mod;
  const expoModules = /^([ \t]*)use_expo_modules![^\r\n]*$/m;
  if (!expoModules.test(podfile)) throw new Error("Could not locate the Expo application target for the speaker runtime.");
  mod.modResults.contents = podfile.replace(expoModules, (line, indent) => `${line}\n${indent}${speakerRuntime}`);
  return mod;
});
