import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const { inlinePreloadContract } = createRequire(import.meta.url)("../../scripts/inline-preload-contract.cjs") as {
  inlinePreloadContract(preload: string, contract: string): string;
};

/** Use the same self-contained assembly as the product build. */
export function compiledPreloadSource(): string {
  const compile = (name: string, module = ModuleKind.CommonJS) => transpileModule(readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8"), {
    compilerOptions: { module, target: ScriptTarget.ES2023 }
  }).outputText;
  return inlinePreloadContract(compile("preload.cts"), compile("native-task-status-contract.ts", ModuleKind.ESNext));
}
