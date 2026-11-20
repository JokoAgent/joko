import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createImportBudget, optionalText } from "./files.js";
import { importedProcessEnvironment, runImportedProcess } from "./process.js";
import { readImportSourceBot, type SourceReaderDeps } from "./sources.js";
import { resolveSourceCli } from "./takeover.js";
import { AgentImportError, object, string, type ImportItem, type ImportSource } from "./types.js";

type SourceSwitch = boolean | "on" | "off" | "true" | "false";
export interface ImportedBotProgress {
  readonly phase: "stopping" | "stopped" | "connecting" | "restoring" | "connected";
  readonly original?: SourceSwitch;
  readonly changed?: boolean;
  readonly restarted?: boolean;
}

export interface ImportedBotTarget {
  preflight(): Promise<"available" | "enabled" | "occupied" | "failed">;
  connect(): Promise<"connected" | "failed" | "unknown">;
  stop(): Promise<boolean>;
}

/** A single source switch and its exact target are resumed from the original import receipt. */
export async function takeOverImportedBot(input: {
  readonly source: ImportSource; readonly item: ImportItem; readonly readers: SourceReaderDeps; readonly target: ImportedBotTarget;
  readonly progress?: ImportedBotProgress; readonly save: (progress: ImportedBotProgress | undefined) => Promise<void>;
  readonly assertOwner: () => void;
}): Promise<string | undefined> {
  const { source, item, readers, target, assertOwner } = input;
  const bot = item.bot;
  if (!bot || source.kind === "package") return "IMPORT_IM_BOT_OWNER_MISSING";
  let progress = input.progress;
  if (progress?.phase === "connected") return undefined;
  const save = async (next: ImportedBotProgress | undefined) => {
    assertOwner();
    await input.save(next);
    assertOwner();
    progress = next;
  };
  const read = () => readImportSourceBot(source, bot, readers);
  let cli: Awaited<ReturnType<typeof resolveSourceCli>> | undefined;
  const run = async (args: string[], stdin?: string, timeoutMs = 15_000) => {
    cli ??= await resolveSourceCli(source, readers.home, readers.env);
    assertOwner();
    const env = importedProcessEnvironment(source.kind === "hermes" ? { HERMES_HOME: source.root }
      : { OPENCLAW_STATE_DIR: source.root, OPENCLAW_CONFIG_PATH: source.configFile }, readers.env);
    try {
      return await runImportedProcess({ command: cli.interpreter ?? cli.executable,
        args: cli.interpreter ? ["/d", "/s", "/c", `""${cli.executable}" ${args.join(" ")}"`] : args,
        windowsVerbatimArguments: cli.interpreter !== undefined, env, cwd: source.root, timeoutMs, maxOutputBytes: 256 * 1024,
        signal: new AbortController().signal, assertOwner, ...(stdin === undefined ? {} : { input: stdin }) });
    } catch { assertOwner(); return undefined; }
  };
  const toggle = (keys: readonly string[], value: SourceSwitch | undefined) => {
    const key = keys.join(".");
    const scalar = typeof value === "string" ? `'${value}'` : String(value);
    return source.kind === "hermes" ? run(value === undefined ? ["config", "unset", key] : ["config", "set", key, scalar])
      : run(["config", "patch", "--stdin"], JSON.stringify(keys.reduceRight<unknown>((nested, key) => ({ [key]: nested }), value ?? null)));
  };
  const runtime = async (): Promise<{ live: boolean; parked?: boolean } | undefined> => {
    if (source.kind === "hermes") return await hermesBotStatus(source, bot.channel, assertOwner);
    const receipt = await run(["gateway", "call", "channels.status", "--json"]);
    if (receipt?.exitCode !== 0) return undefined;
    try {
      const channels = object(object(JSON.parse(receipt.stdout)).channelAccounts);
      const accounts = channels[bot.channel];
      if (!Array.isArray(accounts)) return undefined;
      const matches = accounts.map(object).filter(account => account.accountId === bot.account);
      if (matches.length === 0) return { live: false };
      if (matches.length !== 1 || typeof matches[0]!.running !== "boolean") return undefined;
      return { live: matches[0]!.running === true || matches[0]!.connected === true };
    } catch { return undefined; }
  };
  const restore = async (receipt: ImportedBotProgress) => {
    if (receipt.phase !== "restoring") await save({ ...receipt, phase: "restoring" });
    if (!await target.stop()) return "IMPORT_IM_BOT_TARGET_STOP_UNCONFIRMED";
    if (receipt.changed) {
      const current = await read();
      if (current.switchValue !== false && current.switchValue !== receipt.original) return "IMPORT_IM_BOT_SOURCE_CHANGED";
      if (current.switchValue !== receipt.original) await toggle(current.enabledPath, receipt.original);
      if ((await read()).switchValue !== receipt.original) return "IMPORT_IM_BOT_RESTORE_UNCONFIRMED";
      if (source.kind === "hermes" && receipt.restarted) {
        const status = await runtime();
        if (!status || (!status.parked && (await run(["gateway", "restart"], undefined, 60_000))?.exitCode !== 0)) {
          return "IMPORT_IM_BOT_RESTORE_UNCONFIRMED";
        }
      }
    }
    await save(undefined);
    return "IMPORT_IM_BOT_CONNECT_FAILED";
  };
  if (progress?.phase === "restoring") return restore(progress);
  const targetState = await target.preflight();
  assertOwner();
  if (targetState === "occupied") return "IMPORT_IM_BOT_IN_USE";
  if (targetState === "failed") return progress === undefined ? "IMPORT_IM_BOT_CONNECT_FAILED" : restore(progress);

  let current = await read();
  if (progress === undefined) {
    const original = current.switchValue;
    if (original !== undefined && typeof original !== "boolean" && original !== "on" && original !== "off"
      && original !== "true" && original !== "false") return "IMPORT_IM_BOT_SOURCE_CHANGED";
    if (targetState === "enabled" || await runtime() === undefined) return "IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED";
    await save({ phase: "stopping", ...(original === undefined ? {} : { original }) });
  }
  const receipt = progress!;
  if (current.enabled) {
    if (receipt.phase !== "stopping" || current.switchValue !== receipt.original || targetState === "enabled") {
      return "IMPORT_IM_BOT_SOURCE_CHANGED";
    }
    await save({ ...receipt, changed: true });
    await toggle(current.enabledPath, false);
    current = await read();
  }
  if (current.enabled) return "IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED";
  if (progress!.phase === "stopping") await save({ ...progress!, phase: "stopped" });
  let observed = await runtime();
  if (source.kind === "hermes" && observed?.live && !observed.parked && !progress!.restarted) {
    // Record the intent before asking the native gateway to restart.
    await save({ ...progress!, restarted: true });
    await run(["gateway", "restart"], undefined, 60_000);
  }
  const end = Date.now() + 20_000;
  while (observed?.live !== false && Date.now() < end) {
    await sleep(1_000);
    assertOwner();
    observed = await runtime();
  }
  if (observed?.live !== false || (await read()).enabled) return "IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED";
  await save({ ...progress!, phase: "connecting" });
  const outcome = await target.connect();
  assertOwner();
  if (outcome === "unknown") return "IMPORT_IM_BOT_CONNECT_UNCONFIRMED";
  if (outcome === "failed") return restore(progress!);
  await save({ ...progress!, phase: "connected" });
  return undefined;
}

async function hermesBotStatus(source: ImportSource, platform: string, assertOwner: () => void) {
  const named = source.agentId !== "default" && path.basename(path.dirname(source.root)) === "profiles";
  const budget = createImportBudget(4 * 1024 * 1024, assertOwner);
  const gateways = [[source.root, platform]];
  if (named) gateways.push([path.dirname(path.dirname(source.root)), `${source.agentId}:${platform}`]);
  const parked = named && await optionalText(source.root, path.join(source.root, "gateway.parked"), budget) !== undefined;
  for (const [root, key] of gateways as [string, string][]) {
    const text = await optionalText(root, path.join(root, "gateway_state.json"), budget);
    if (text === undefined) continue;
    const state = object(JSON.parse(text));
    const entry = object(object(state.platforms)[key]);
    if (!["connected", "connecting", "retrying"].includes(string(entry.state))) continue;
    const pid = Number(entry.writer_pid ?? state.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return { live: true, parked };
    try { process.kill(pid, 0); return { live: true, parked }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { live: true, parked }; }
  }
  return { live: false, parked };
}
