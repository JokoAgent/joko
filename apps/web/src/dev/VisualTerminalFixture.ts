import type { OperationApi, TerminalCapabilitiesView, TerminalUpdateView, TerminalView } from "../model.js";

interface VisualTerminal {
  descriptor: TerminalView;
  sequence: bigint;
  appearanceRevision: bigint;
  views: Map<string, bigint>;
  screen: string;
  line: string;
  writers: Map<string, bigint>;
  listeners: Set<{ update: (value: TerminalUpdateView) => void | Promise<void>; end: () => void; chain: Promise<void> }>;
}

/** Memory-only display fixture; it never starts a process or reaches the service. */
export class VisualTerminalFixture {
  readonly #terminals = new Map<string, VisualTerminal>();
  readonly #requests = new Map<string, string>();
  readonly #disconnectedSessions = new Set<string>();
  readonly capabilities: TerminalCapabilitiesView = { support: "supported", shells: [{ id: "shell-one", label: "PowerShell" }, { id: "shell-two", label: "Command Prompt" }], defaultShellId: "shell-one", maximumTerminals: 16, maximumInputBytes: 65_536, maximumColumns: 500, maximumRows: 200 };

  readonly getTerminalCapabilities: OperationApi["getTerminalCapabilities"] = async (sessionId) => sessionId !== undefined && this.#disconnectedSessions.has(sessionId)
    ? { ...this.capabilities, support: "platformLimited", reason: "The preview remote host is disconnected. Existing terminal state remains available.", shells: [], defaultShellId: "" }
    : this.capabilities;
  readonly listTerminals: OperationApi["listTerminals"] = async (sessionId) => [...this.#terminals.values()].map((value) => value.descriptor).filter((value) => value.sessionId === sessionId && value.status !== "closed");
  readonly createTerminal: OperationApi["createTerminal"] = async (sessionId, requestId, shellId, columns, rows) => {
    const request = `${sessionId}:${requestId}`;
    const existing = this.#requests.get(request);
    if (existing !== undefined) return this.#require(sessionId, existing).descriptor;
    if (this.#disconnectedSessions.has(sessionId)) throw new Error("The preview remote host is disconnected.");
    const shell = this.capabilities.shells.find((candidate) => candidate.id === shellId) ?? this.capabilities.shells[0]!;
    const id = `visual-terminal-${this.#terminals.size + 1}`;
    const descriptor: TerminalView = { id, sessionId, targetId: "target-local", generation: 1n, status: "running", exitConfirmed: false, shellId: shell.id, shellLabel: shell.label, cwd: "D:\\workspace", columns: columns || 80, rows: rows || 24, createdAt: Date.now(), updatedAt: Date.now() };
    const screen = "\x1b[36mJoko terminal preview\x1b[0m\r\nType text to see input echo.\r\nType exit + Enter to preview natural exit and restart.\r\nType disconnect + Enter to preview an unconfirmed remote exit.\r\nD:\\workspace> ";
    this.#terminals.set(id, { descriptor, sequence: 1n, appearanceRevision: 1n, views: new Map(), screen, line: "", writers: new Map(), listeners: new Set() });
    this.#requests.set(request, id);
    return descriptor;
  };
  readonly getTerminal: OperationApi["getTerminal"] = async (sessionId, terminalId, generation) => this.#require(sessionId, terminalId, generation).descriptor;
  readonly watchTerminal: OperationApi["watchTerminal"] = async (sessionId, terminalId, generation, appearance, update, _afterSequence, signal) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    if (signal?.aborted) return;
    terminal.views.set(appearance.viewId, appearance.viewRevision);
    await update({ appearanceRevision: terminal.appearanceRevision, activeColorOverrides: "", kind: "reset", terminal: terminal.descriptor, sequence: terminal.sequence, data: terminal.screen });
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const listener = { update, chain: Promise.resolve(), end: () => { terminal.views.delete(appearance.viewId); terminal.listeners.delete(listener); signal?.removeEventListener("abort", listener.end); resolve(); } };
      terminal.listeners.add(listener);
      signal?.addEventListener("abort", listener.end, { once: true });
    });
  };
  readonly updateTerminalAppearance: OperationApi["updateTerminalAppearance"] = async (sessionId, terminalId, generation, appearance, claim, expected) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    const previous = terminal.views.get(appearance.viewId);
    if (previous === undefined) throw new Error("Terminal view is no longer watching.");
    const accepted = !claim || expected === terminal.appearanceRevision;
    if (accepted) { terminal.views.set(appearance.viewId, appearance.viewRevision); terminal.appearanceRevision += 1n; }
    return { accepted, acceptedViewRevision: accepted ? appearance.viewRevision : previous, appearanceRevision: terminal.appearanceRevision, ownsDefaults: accepted };
  };
  readonly writeTerminal: OperationApi["writeTerminal"] = async (sessionId, terminalId, generation, writerId, sequence, data) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    if (terminal.descriptor.status !== "running") throw new Error("Terminal has exited.");
    const previous = terminal.writers.get(writerId) ?? 0n;
    if (sequence <= previous) return;
    if (sequence !== previous + 1n) throw new Error("Terminal input is out of order.");
    terminal.writers.set(writerId, sequence);
    let output = "";
    for (const character of data) {
      if (character === "\r" || character === "\n") {
        output += "\r\n";
        const command = terminal.line.trim();
        terminal.line = "";
        if (command === "exit" || command === "disconnect") {
          await this.#output(terminal, output);
          if (command === "disconnect") {
            this.#disconnectedSessions.add(sessionId);
            terminal.descriptor = { ...terminal.descriptor, status: "failed", exitConfirmed: false, failureCode: "TERMINAL_UNKNOWN", updatedAt: Date.now() };
          } else {
            terminal.descriptor = { ...terminal.descriptor, status: "exited", exitConfirmed: true, exitCode: 0, updatedAt: Date.now() };
          }
          await this.#state(terminal);
          return;
        }
        output += "D:\\workspace> ";
      } else if (character === "\u0003") { terminal.line = ""; output += "^C\r\nD:\\workspace> "; }
      else if (character === "\u007f") { terminal.line = terminal.line.slice(0, -1); output += "\b \b"; }
      else { terminal.line += character; output += character; }
    }
    await this.#output(terminal, output);
  };
  readonly resizeTerminal: OperationApi["resizeTerminal"] = async (sessionId, terminalId, generation, columns, rows) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    terminal.descriptor = { ...terminal.descriptor, columns, rows, updatedAt: Date.now() };
    await this.#state(terminal);
  };
  readonly restartTerminal: OperationApi["restartTerminal"] = async (sessionId, terminalId, generation) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    if (!terminal.descriptor.exitConfirmed) throw new Error("The process exit has not been confirmed.");
    if (this.#disconnectedSessions.has(sessionId)) throw new Error("The preview remote host is disconnected.");
    for (const listener of [...terminal.listeners]) listener.end();
    const { exitCode: _exitCode, ...descriptor } = terminal.descriptor;
    terminal.descriptor = { ...descriptor, generation: descriptor.generation + 1n, status: "running", exitConfirmed: false, updatedAt: Date.now() };
    terminal.writers.clear();
    terminal.line = "";
    await this.#output(terminal, "\r\n\x1b[32mShell restarted\x1b[0m\r\nD:\\workspace> ");
    return terminal.descriptor;
  };
  readonly closeTerminal: OperationApi["closeTerminal"] = async (sessionId, terminalId, generation) => {
    const terminal = this.#require(sessionId, terminalId, generation);
    if (terminal.descriptor.status === "failed" && !terminal.descriptor.exitConfirmed) throw new Error("The process exit has not been confirmed.");
    terminal.descriptor = { ...terminal.descriptor, status: "closed", exitConfirmed: true, updatedAt: Date.now() };
    await this.#state(terminal);
    for (const listener of [...terminal.listeners]) listener.end();
  };

  #require(sessionId: string, terminalId: string, generation?: bigint): VisualTerminal {
    const terminal = this.#terminals.get(terminalId);
    if (terminal === undefined || terminal.descriptor.sessionId !== sessionId || generation !== undefined && generation !== 0n && generation !== terminal.descriptor.generation) throw new Error("Terminal is unavailable for this task.");
    return terminal;
  }
  async #output(terminal: VisualTerminal, data: string): Promise<void> {
    if (data === "") return;
    terminal.screen = (terminal.screen + data).slice(-100_000);
    const update = { appearanceRevision: terminal.appearanceRevision, kind: "output" as const, sequence: ++terminal.sequence, data };
    await this.#publish(terminal, update);
  }
  async #state(terminal: VisualTerminal): Promise<void> {
    const update = { appearanceRevision: terminal.appearanceRevision, kind: "state" as const, terminal: terminal.descriptor, sequence: ++terminal.sequence, data: "" };
    await this.#publish(terminal, update);
  }
  async #publish(terminal: VisualTerminal, update: TerminalUpdateView): Promise<void> {
    await Promise.all([...terminal.listeners].map((listener) => {
      listener.chain = listener.chain.then(() => listener.update(update)).catch(listener.end);
      return listener.chain;
    }));
  }
}
