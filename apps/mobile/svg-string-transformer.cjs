const { createRequire } = require("node:module");

const expoRequire = createRequire(require.resolve("expo/package.json"));
const upstreamTransformer = expoRequire("@expo/metro-config/babel-transformer");

module.exports.transform = ({ src, filename, options }) => upstreamTransformer.transform({
  src: filename.endsWith(".svg") ? `module.exports = ${JSON.stringify(src)};` : src,
  filename,
  options
});
