const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { ModuleKind, ScriptTarget, transpileModule } = require("typescript");

// Main and Vitest load the typed ESM source normally. Convert tsc's emitted
// module to CommonJS only for the self-contained sandbox preload.
function inlinePreloadContract(preload, contract) {
  const request = 'require("./native-task-status-contract.js")';
  const commonJsContract = transpileModule(contract, {
    fileName: "native-task-status-contract.ts",
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2023, removeComments: true }
  }).outputText;
  const start = "/* native-task-status-contract:start */", end = "/* native-task-status-contract:end */";
  const expression = `${start}(() => { const module = { exports: {} }; const exports = module.exports;\n${commonJsContract}\nreturn module.exports; })()${end}`;
  if (preload.split(request).length === 2) return preload.replace(request, () => expression);
  // Incremental tsc may leave an already inlined preload while updating only
  // the contract module. Refresh that exact region on every build.
  if (preload.split(start).length === 2 && preload.split(end).length === 2 && !preload.includes(request)) {
    const begin = preload.indexOf(start), finish = preload.indexOf(end) + end.length;
    if (finish > begin) return preload.slice(0, begin) + expression + preload.slice(finish);
  }
  throw new Error("The preload must include exactly one native task-status contract.");
}

module.exports = { inlinePreloadContract };
if (require.main === module) {
  const root = resolve(__dirname, "..", "dist");
  const path = resolve(root, "preload.cjs");
  writeFileSync(path, inlinePreloadContract(readFileSync(path, "utf8"), readFileSync(resolve(root, "native-task-status-contract.js"), "utf8")));
}
