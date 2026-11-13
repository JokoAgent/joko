import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { collectHostResources, prepareSimulatorService } from "./mobile-ios-runtime-diagnostics.mjs";

try {
  const directory = process.env.JOKO_IOS_RUNTIME_EVIDENCE_DIR;
  if (process.platform !== "darwin" || !directory || !isAbsolute(directory)) {
    throw new Error("Simulator service preparation requires macOS and an absolute evidence path.");
  }
  await mkdir(directory, { recursive: true });
  const attempts = [];
  await prepareSimulatorService(execFileSync, async receipt => {
    attempts.push(receipt.result === "passed" ? receipt : { ...receipt, resources: await collectHostResources() });
    await writeFile(join(directory, "simulator-service.json"), `${JSON.stringify({ attempts }, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
  });
} catch {
  process.stderr.write("Simulator service preparation failed. See the simulator-service.json receipt.\n");
  process.exitCode = 1;
}
