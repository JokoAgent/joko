import { createClient, type Transport } from "@connectrpc/connect";
import { CapabilitySupport, TerminalService, TerminalStatus, TerminalUpdateKind, type Terminal } from "@joko/contracts";
import type { OperationApi, TerminalCapabilitiesView, TerminalView } from "./model.js";

type TerminalApi = Pick<OperationApi, "getTerminalCapabilities" | "listTerminals" | "createTerminal" | "getTerminal" | "watchTerminal" | "updateTerminalAppearance" | "writeTerminal" | "resizeTerminal" | "restartTerminal" | "closeTerminal">;

export function createTerminalGateway(transport: Transport, ownerSignal?: AbortSignal): TerminalApi {
  const client = createClient(TerminalService, transport);
  const options = (signal?: AbortSignal) => ({ signal: ownerSignal === undefined ? signal : signal === undefined ? ownerSignal : AbortSignal.any([ownerSignal, signal]) });
  return {
    async getTerminalCapabilities(sessionId, signal) {
      const value = await client.getTerminalCapabilities({ sessionId: sessionId ?? "" }, options(signal));
      return { support: terminalSupport(value.support), ...(value.reason === "" ? {} : { reason: value.reason }), shells: value.shells.map((shell) => ({ id: shell.id, label: shell.label })), defaultShellId: value.defaultShellId, maximumTerminals: value.maximumTerminals, maximumInputBytes: value.maximumInputBytes, maximumColumns: value.maximumColumns, maximumRows: value.maximumRows };
    },
    async listTerminals(sessionId, signal) {
      const result = await client.listTerminals({ sessionId }, options(signal));
      return result.terminals.map((terminal) => terminalView(terminal, sessionId));
    },
    async createTerminal(sessionId, requestId, shellId, columns, rows, initialPalette, signal) {
      const result = await client.createTerminal({ sessionId, requestId, shellId: shellId === "auto" ? "" : shellId, columns, rows, initialPalette: { ...initialPalette, ansiRgb: [...initialPalette.ansiRgb] } }, options(signal));
      return terminalView(result.terminal, sessionId);
    },
    async getTerminal(sessionId, terminalId, generation, signal) {
      const result = await client.getTerminal({ sessionId, terminalId, generation: generation ?? 0n }, options(signal));
      return terminalView(result.terminal, sessionId, terminalId);
    },
    async watchTerminal(sessionId, terminalId, generation, appearance, onUpdate, afterSequence, signal) {
      let cursor = afterSequence;
      for await (const update of client.watchTerminal({ sessionId, terminalId, generation, appearance: { ...appearance, palette: { ...appearance.palette, ansiRgb: [...appearance.palette.ansiRgb] } }, ...(afterSequence === undefined ? {} : { afterSequence }) }, options(signal))) {
        const kind = update.kind === TerminalUpdateKind.RESET ? "reset" : update.kind === TerminalUpdateKind.OUTPUT ? "output" : update.kind === TerminalUpdateKind.STATE ? "state" : undefined;
        if (kind === undefined || cursor === undefined && kind !== "reset" || kind !== "reset" && cursor !== undefined && update.sequence !== cursor + 1n) throw new Error("Terminal stream sequence is inconsistent.");
        if (kind === "reset" && cursor !== undefined && update.sequence < cursor) throw new Error("Terminal checkpoint moved backwards.");
        const terminal = update.terminal === undefined && kind === "output" ? undefined : terminalView(update.terminal, sessionId, terminalId);
        if (terminal !== undefined && terminal.generation !== generation) throw new Error("Terminal stream changed process generation.");
        if (update.appearanceRevision < 1n || kind === "reset" && update.activeColorOverrides === undefined) throw new Error("Terminal appearance snapshot is missing.");
        if (update.activeColorOverrides !== undefined && !validTerminalColorOverrides(update.activeColorOverrides)) throw new Error("Terminal color overrides are invalid.");
        const appearanceState = { appearanceRevision: update.appearanceRevision, ...(update.activeColorOverrides === undefined ? {} : { activeColorOverrides: update.activeColorOverrides }) };
        if (kind === "output") await onUpdate({ ...appearanceState, kind, ...(terminal === undefined ? {} : { terminal }), sequence: update.sequence, data: update.data });
        else await onUpdate({ ...appearanceState, kind, terminal: terminal!, sequence: update.sequence, data: update.data });
        cursor = update.sequence;
      }
    },
    async updateTerminalAppearance(sessionId, terminalId, generation, appearance, claimFocus, expectedAppearanceRevision, signal) {
      const result = await client.updateTerminalAppearance({ sessionId, terminalId, generation, appearance: { ...appearance, palette: { ...appearance.palette, ansiRgb: [...appearance.palette.ansiRgb] } }, claimFocus, expectedAppearanceRevision }, options(signal));
      if (result.appearanceRevision < 1n || result.acceptedViewRevision < 1n || result.accepted && result.acceptedViewRevision !== appearance.viewRevision) throw new Error("Terminal appearance acknowledgement is inconsistent.");
      return result;
    },
    async writeTerminal(sessionId, terminalId, generation, writerId, inputSequence, data, signal) {
      const response = await client.writeTerminal({ sessionId, terminalId, generation, writerId, inputSequence, data }, options(signal));
      if (response.nextInputSequence <= inputSequence) throw new Error("Terminal input acknowledgement is inconsistent.");
    },
    async resizeTerminal(sessionId, terminalId, generation, viewId, columns, rows, signal) {
      const response = await client.resizeTerminal({ sessionId, terminalId, generation, viewId, columns, rows }, options(signal));
      terminalView(response.terminal, sessionId, terminalId);
    },
    async restartTerminal(sessionId, terminalId, generation, requestId, signal) {
      const response = await client.restartTerminal({ sessionId, terminalId, generation, requestId }, options(signal));
      return terminalView(response.terminal, sessionId, terminalId);
    },
    async closeTerminal(sessionId, terminalId, generation, signal) {
      await client.closeTerminal({ sessionId, terminalId, generation }, options(signal));
    }
  };
}

function terminalView(value: Terminal | undefined, sessionId: string, terminalId?: string): TerminalView {
  if (value === undefined || value.sessionId !== sessionId || value.id === "" || terminalId !== undefined && value.id !== terminalId || value.generation < 1n) throw new Error("Terminal response has an invalid owner.");
  const status = value.status === TerminalStatus.RUNNING ? "running" : value.status === TerminalStatus.EXITED ? "exited" : value.status === TerminalStatus.FAILED ? "failed" : value.status === TerminalStatus.CLOSED ? "closed" : undefined;
  if (status === undefined) throw new Error("Terminal response has no process status.");
  return { id: value.id, sessionId: value.sessionId, targetId: value.targetId, generation: value.generation, status, exitConfirmed: value.exitConfirmed, ...(value.failureCode === "" ? {} : { failureCode: value.failureCode }), shellId: value.shellId, shellLabel: value.shellLabel, cwd: value.cwd, columns: value.columns, rows: value.rows, ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }), ...(value.exitSignal === undefined ? {} : { exitSignal: value.exitSignal }), createdAt: milliseconds(value.createdAt), updatedAt: milliseconds(value.updatedAt) };
}

function milliseconds(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  return value === undefined ? 0 : Number(value.seconds) * 1_000 + value.nanos / 1_000_000;
}

function terminalSupport(value: CapabilitySupport): TerminalCapabilitiesView["support"] {
  switch (value) {
    case CapabilitySupport.SUPPORTED: return "supported";
    case CapabilitySupport.UPSTREAM_MISSING: return "upstreamMissing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "notImplemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platformLimited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "disabledByPolicy";
    case CapabilitySupport.TEMPORARILY_UNAVAILABLE: return "temporarilyUnavailable";
    default: return "unspecified";
  }
}
/** Only the service's canonical modified-color replay language may enter this channel. */
export function validTerminalColorOverrides(value: string): boolean {
  if (value.length > 16384) return false;
  const color = "rgb:[0-9a-f]{4}/[0-9a-f]{4}/[0-9a-f]{4}";
  const index = "(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])";
  const pair = index + ";" + color;
  const command = new RegExp("\\x1b\\](?:4;" + pair + "(?:;" + pair + ")*|1[012];" + color + ")\\x1b\\\\", "gy");
  let end = 0;
  while (end < value.length) { command.lastIndex = end; const match = command.exec(value); if (match === null) return false; end = command.lastIndex; }
  return true;
}
