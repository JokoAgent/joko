import { PassThrough } from "node:stream";

import {
  spawnPiProcess,
  type PiProcessFactory,
  type PiProcessHandle,
  type PiProcessSpec
} from "@joko/adapter-pi";

export interface ControlledPiPromptDispatch {
  readonly processIndex: number;
  readonly requestId: string;
  readonly message: string;
}

export interface ControlledPiLostAcknowledgement extends ControlledPiPromptDispatch {
  readonly providerObserved: true;
  readonly killAccepted: boolean;
}

interface ArmedPromptFault {
  readonly message: string;
  providerObserved: boolean;
  providerRelease?: () => void;
  dispatch?: ControlledPiPromptDispatch;
  kill?: () => boolean;
  completed: boolean;
}

/**
 * Runs the published Pi CLI and proxies only its JSONL pipes. A fault drops the
 * exact successful prompt response, waits until the local Provider has consumed
 * the matching request, and then kills that exact child. The Adapter therefore
 * observes a real process exit after native input consumption without receiving
 * an acceptance receipt.
 */
export class ControlledPiProcessFactory {
  readonly processes: ControlledPiProcess[] = [];
  readonly promptDispatches: ControlledPiPromptDispatch[] = [];
  readonly lostAcknowledgements: ControlledPiLostAcknowledgement[] = [];
  #armedFault: ArmedPromptFault | undefined;

  readonly create: PiProcessFactory = async (spec: PiProcessSpec) => {
    const native = await spawnPiProcess(spec);
    const processIndex = this.processes.length;
    const controlled = new ControlledPiProcess(
      native,
      processIndex,
      (dispatch) => this.#observePrompt(dispatch),
      (dispatch, kill) => this.#dropAcknowledgement(dispatch, kill)
    );
    this.processes.push(controlled);
    return controlled;
  };

  loseNextPromptAcknowledgement(message: string): void {
    if (message.length === 0) throw new Error("A controlled Pi prompt fault requires exact text.");
    if (this.#armedFault !== undefined) throw new Error("A controlled Pi prompt fault is already armed.");
    this.#armedFault = { message, providerObserved: false, completed: false };
  }

  async gateProviderRequest(body: Readonly<Record<string, unknown>>): Promise<void> {
    const fault = this.#armedFault;
    if (fault === undefined || !JSON.stringify(body).includes(fault.message)) return;
    fault.providerObserved = true;
    const released = new Promise<void>((resolve) => { fault.providerRelease = resolve; });
    this.#completeFaultIfReady(fault);
    await released;
  }

  releaseProviderGates(): void {
    this.#armedFault?.providerRelease?.();
    this.#armedFault = undefined;
  }

  #observePrompt(dispatch: ControlledPiPromptDispatch): boolean {
    this.promptDispatches.push(dispatch);
    const fault = this.#armedFault;
    if (fault === undefined || fault.dispatch !== undefined || dispatch.message !== fault.message) return false;
    fault.dispatch = dispatch;
    return true;
  }

  #dropAcknowledgement(dispatch: ControlledPiPromptDispatch, kill: () => boolean): void {
    const fault = this.#armedFault;
    if (fault === undefined || fault.dispatch?.requestId !== dispatch.requestId || fault.completed) {
      throw new Error("The controlled Pi acknowledgement did not match its armed prompt.");
    }
    fault.kill = kill;
    this.#completeFaultIfReady(fault);
  }

  #completeFaultIfReady(fault: ArmedPromptFault): void {
    if (fault.completed || !fault.providerObserved || fault.dispatch === undefined || fault.kill === undefined) return;
    fault.completed = true;
    const killAccepted = fault.kill();
    this.lostAcknowledgements.push({ ...fault.dispatch, providerObserved: true, killAccepted });
    fault.providerRelease?.();
    if (this.#armedFault === fault) this.#armedFault = undefined;
  }
}

export class ControlledPiProcess implements PiProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr: PiProcessHandle["stderr"];
  readonly serviceRecovery?: PiProcessHandle["serviceRecovery"];
  readonly #native: PiProcessHandle;
  readonly #processIndex: number;
  readonly #observePrompt: (dispatch: ControlledPiPromptDispatch) => boolean;
  readonly #dropAcknowledgement: (
    dispatch: ControlledPiPromptDispatch,
    kill: () => boolean
  ) => void;
  #inputBuffer: Buffer = Buffer.alloc(0);
  #outputBuffer: Buffer = Buffer.alloc(0);
  #faultedDispatch: ControlledPiPromptDispatch | undefined;

  constructor(
    native: PiProcessHandle,
    processIndex: number,
    observePrompt: (dispatch: ControlledPiPromptDispatch) => boolean,
    dropAcknowledgement: (dispatch: ControlledPiPromptDispatch, kill: () => boolean) => void
  ) {
    this.#native = native;
    this.#processIndex = processIndex;
    this.#observePrompt = observePrompt;
    this.#dropAcknowledgement = dropAcknowledgement;
    this.stderr = native.stderr;
    this.serviceRecovery = native.serviceRecovery;

    this.stdin.on("data", (chunk: Buffer | string) => this.#inspectInput(chunk));
    this.stdin.pipe(native.stdin);
    native.stdout.on("data", (chunk: Buffer | string) => this.#forwardOutput(chunk));
    native.stdout.once("end", () => {
      this.#outputBuffer = Buffer.alloc(0);
      this.stdout.end();
    });
    native.stdout.once("error", (error) => this.stdout.destroy(error));
  }

  get pid(): number | undefined {
    return this.#native.pid;
  }

  get exitCode(): number | null {
    return this.#native.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#native.signalCode;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    return this.#native.kill(signal);
  }

  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit" | "error",
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)
  ): this {
    if (event === "exit") {
      this.#native.once(event, listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.#native.once(event, listener as (error: Error) => void);
    }
    return this;
  }

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit" | "error",
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)
  ): this {
    if (event === "exit") {
      this.#native.on(event, listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.#native.on(event, listener as (error: Error) => void);
    }
    return this;
  }

  #inspectInput(chunk: Buffer | string): void {
    this.#inputBuffer = Buffer.concat([
      this.#inputBuffer,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk
    ]);
    this.#inputBuffer = consumeLines(this.#inputBuffer, (line) => {
      const record = parseRecord(line);
      if (record?.["type"] !== "prompt" || typeof record["id"] !== "string") return;
      const dispatch: ControlledPiPromptDispatch = {
        processIndex: this.#processIndex,
        requestId: record["id"],
        message: typeof record["message"] === "string" ? record["message"] : ""
      };
      if (this.#observePrompt(dispatch)) this.#faultedDispatch = dispatch;
    });
  }

  #forwardOutput(chunk: Buffer | string): void {
    this.#outputBuffer = Buffer.concat([
      this.#outputBuffer,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk
    ]);
    this.#outputBuffer = consumeLines(this.#outputBuffer, (line, framed) => {
      const record = parseRecord(line);
      const dispatch = this.#faultedDispatch;
      if (
        dispatch !== undefined
        && record?.["type"] === "response"
        && record["id"] === dispatch.requestId
        && record["command"] === "prompt"
        && record["success"] === true
      ) {
        this.#faultedDispatch = undefined;
        this.#dropAcknowledgement(dispatch, () => this.#native.kill("SIGKILL"));
        return;
      }
      this.stdout.write(framed);
    });
  }
}

function consumeLines(
  source: Buffer,
  consume: (line: Buffer, framed: Buffer) => void
): Buffer {
  let start = 0;
  while (true) {
    const newline = source.indexOf(0x0a, start);
    if (newline < 0) return source.subarray(start);
    const framed = source.subarray(start, newline + 1);
    const line = source.subarray(start, newline);
    consume(line, framed);
    start = newline + 1;
  }
}

function parseRecord(line: Buffer): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}
