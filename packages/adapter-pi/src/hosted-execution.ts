import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertHostedExecution, hostedExecutionEnvironmentNote, type AdapterContext, type HostedExecution } from "@joko/core";
import { atomicWriteJson } from "./config.js";
import type { PiHostedExecutorConfiguration } from "./hosted-executor.js";

export function assertPiHostedModel(hosted: HostedExecution | undefined, providerId: string | undefined, modelId: string | undefined): void {
  if (!hosted) return;
  assertHostedExecution(hosted);
  if (hosted.trust === "guest" && (providerId !== hosted.providerId || !modelId || !hosted.modelIds.includes(modelId))) {
    throw new Error("The shared Provider does not allow this model.");
  }
}

/** Written only below a generation's private runtime directory, never in its
 * workspace. Children inherit this authority explicitly; ordinary shell does not. */
export async function provisionPiHostedExecution(runtimeDirectory: string, context: AdapterContext): Promise<string | undefined> {
  const hosted = context.hostedExecution;
  if (!hosted) return undefined;
  assertHostedExecution(hosted);
  if (context.target.remoteWorkspace || resolve(context.target.workspaceRoot) !== resolve(hosted.workspace.root)) {
    throw new Error("Hosted execution requires its exact local virtual workspace.");
  }
  if (hosted.trust === "guest") {
    const suffix = relative(hosted.guestHome, hosted.workspace.root), info = await lstat(hosted.guestHome);
    if (!isAbsolute(hosted.guestHome) || !info.isDirectory() || info.isSymbolicLink() || await realpath(hosted.guestHome) !== resolve(hosted.guestHome)
      || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Shared Agent workspace is outside its isolated home.");
  }
  const configuration: PiHostedExecutorConfiguration = {
    format: 1, ...hosted.channel, root: hosted.workspace.root, platform: hosted.workspace.platform, shell: hosted.workspace.shell,
    trust: hosted.trust,
    environmentNote: hostedExecutionEnvironmentNote(hosted),
    ...(hosted.trust === "guest" ? { providerId: hosted.providerId, modelIds: [...hosted.modelIds] } : {})
  };
  const path = join(runtimeDirectory, "hosted-execution.json");
  await atomicWriteJson(path, configuration);
  await chmod(path, 0o600);
  assertHostedExecution(hosted);
  return path;
}

/** The shared-user process sees one provider's models and credentials. Native
 * OAuth still uses the pinned provider snapshot and stays on the Agent node. */
export async function restrictPiHostedGuestHome(agentHome: string, hosted: HostedExecution): Promise<void> {
  if (hosted.trust !== "guest") return;
  assertHostedExecution(hosted);
  const path = join(agentHome, "models.json");
  const configuration = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models?: { id: string }[]; modelOverrides?: Record<string, unknown> }> };
  const provider = configuration.providers[hosted.providerId];
  if (provider) {
    provider.models = provider.models?.filter(model => hosted.modelIds.includes(model.id));
    if (provider.modelOverrides) provider.modelOverrides = Object.fromEntries(Object.entries(provider.modelOverrides).filter(([id]) => hosted.modelIds.includes(id)));
  }
  await atomicWriteJson(path, { providers: provider ? { [hosted.providerId]: provider } : {} });
  // These are generated functional settings, rather than native user config.
  // Keep retry, compaction and input behavior while excluding implicit resources.
  const settingsPath = join(agentHome, "settings.json"), settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  const functional = new Set(["compaction", "retry", "steeringMode", "followUpMode", "images", "defaultTools"]);
  await atomicWriteJson(settingsPath, { ...Object.fromEntries(Object.entries(settings).filter(([key]) => functional.has(key))),
    defaultProjectTrust: "never", enableInstallTelemetry: false, enableAnalytics: false });
  assertHostedExecution(hosted);
}
