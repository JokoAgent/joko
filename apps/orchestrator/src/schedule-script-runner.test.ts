import { describe, expect, it, vi } from "vitest";

import {
  ScheduleScriptExecutionError,
  buildScheduleScriptEnvironment,
  executeScheduleScript,
  type ExecuteScheduleScriptInput,
  type ScheduleScriptCapabilityBroker
} from "./schedule-script-runner.js";

const protocol = "joko-schedule-script/1";

describe("executeScheduleScript", () => {
  it("exchanges the start and complete frames and returns the terminal projection", async () => {
    const result = await executeScheduleScript(baseInput(onStart(`
      emit({type:"complete",resultText:[frame.protocol,frame.context.scheduleId,frame.context.runId].join(":"),primarySessionId:"session-1"});
    `)));

    expect(result).toMatchObject({
      resultText: `${protocol}:schedule-1:run-1`,
      primarySessionId: "session-1",
      stderr: "",
      stderrTruncated: false
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards authorized calls with their original id and writes call_result frames", async () => {
    const call = vi.fn(async () => ({ sessionId: "session-created" }));
    const result = await executeScheduleScript(baseInput(onStart(`
      emit({type:"call",id:"dispatch-7",method:"sessions.dispatch",params:{prompt:"inspect"}});
    `, `
      if(frame.type==="call_result") emit({type:"complete",resultText:JSON.stringify(frame),primarySessionId:frame.result.sessionId});
    `), {
      capabilities: ["sessions.dispatch"],
      broker: { call }
    }));

    expect(call).toHaveBeenCalledWith(
      { id: "dispatch-7", method: "sessions.dispatch", params: { prompt: "inspect" } },
      new Set(["sessions.dispatch"]),
      { scheduleId: "schedule-1", runId: "run-1" }
    );
    expect(JSON.parse(result.resultText ?? "{}")).toMatchObject({
      protocol,
      type: "call_result",
      id: "dispatch-7",
      ok: true,
      result: { sessionId: "session-created" }
    });
    expect(result.primarySessionId).toBe("session-created");
  });

  it("returns stable redacted broker errors to the script", async () => {
    const failure = Object.assign(new Error("password=hunter2"), { code: "DENIED" });
    const result = await executeScheduleScript(baseInput(onStart(`
      emit({type:"call",id:"dispatch-8",method:"sessions.dispatch",params:{}});
    `, `
      if(frame.type==="call_result") emit({type:"complete",resultText:JSON.stringify(frame.error)});
    `), {
      capabilities: ["sessions.dispatch"],
      broker: { call: async () => { throw failure; } }
    }));

    expect(result.resultText).toContain("DENIED");
    expect(result.resultText).toContain("[REDACTED]");
    expect(result.resultText).not.toContain("hunter2");
  });

  it("never gives the broker more than 16 concurrent calls", async () => {
    const call = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    const result = await executeScheduleScript(baseInput(onStart(`
      for(let index=1;index<=17;index+=1) emit({type:"call",id:"call-"+index,method:"sessions.dispatch",params:{index}});
    `, `
      if(frame.type==="call_result"){
        globalThis.results=(globalThis.results??0)+1;
        if(frame.error?.code==="TOO_MANY_REQUESTS") globalThis.overloaded=true;
        if(globalThis.results===17) emit({type:"complete",resultText:String(globalThis.overloaded)});
      }
    `), {
      capabilities: ["sessions.dispatch"],
      broker: { call }
    }));

    expect(call).toHaveBeenCalledTimes(16);
    expect(result.resultText).toBe("true");
  });

  it("fails when a call that was in flight at complete ultimately fails", async () => {
    const pending = executeScheduleScript(baseInput(onStart(`
      emit({type:"call",id:"late-call",method:"sessions.dispatch",params:{}});
      emit({type:"complete",resultText:"too early"});
    `), {
      capabilities: ["sessions.dispatch"],
      broker: {
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw Object.assign(new Error("access_token=secret-value"), { code: "WRITE_FAILED" });
        }
      }
    }));

    const error = await captureError(pending);
    expect(error).toMatchObject({ code: "HOST_CALL_FAILED_AFTER_COMPLETE" });
    expect(error.message).not.toContain("secret-value");
  });

  it("accepts an in-flight call that succeeds after the script exits", async () => {
    const result = await executeScheduleScript(baseInput(`
      const emit=(frame)=>process.stdout.write(JSON.stringify({protocol:"${protocol}",...frame})+"\\n");
      emit({type:"call",id:"late-success",method:"sessions.dispatch",params:{}});
      emit({type:"complete",resultText:"done"});
      setTimeout(()=>process.exit(0),10);
    `, {
      capabilities: ["sessions.dispatch"],
      broker: {
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { ok: true };
        }
      },
      postExitCallTimeoutMs: 500
    }));
    expect(result.resultText).toBe("done");
  });

  it("bounds host-call settlement after a script has exited", async () => {
    const finalizeActiveCalls = vi.fn();
    const startedAt = Date.now();
    const pending = executeScheduleScript(baseInput(`
      const emit=(frame)=>process.stdout.write(JSON.stringify({protocol:"${protocol}",...frame})+"\\n");
      emit({type:"call",id:"stuck",method:"sessions.dispatch",params:{}});
      emit({type:"complete"});
      setTimeout(()=>process.exit(0),10);
    `, {
      capabilities: ["sessions.dispatch"],
      broker: { call: async () => new Promise(() => undefined), finalizeActiveCalls },
      postExitCallTimeoutMs: 60,
      timeoutMs: 5_000
    }));

    await expect(pending).rejects.toMatchObject({ code: "HOST_CALL_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(finalizeActiveCalls).toHaveBeenCalledWith("run-1");
  });

  it("fails closed when exit zero has no complete frame", async () => {
    await expect(executeScheduleScript(baseInput("process.exit(0);")))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it.each([
    ["non-JSON stdout", "process.stdout.write('ordinary log\\n');"],
    ["unsupported protocol", "process.stdout.write(JSON.stringify({protocol:'other/1',type:'complete'})+'\\n');"],
    ["invalid UTF-8", "process.stdout.write(Buffer.from([255,10]));"],
    ["oversized frame", "process.stdout.write('x'.repeat(300000));"]
  ])("rejects %s as a protocol violation", async (_label, source) => {
    await expect(executeScheduleScript(baseInput(source)))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it.each([
    ["an empty call id", `{protocol:"${protocol}",type:"call",id:"",method:"sessions.dispatch",params:{}}`],
    ["a repeated call id", `[{protocol:"${protocol}",type:"call",id:"same",method:"sessions.dispatch",params:{}},{protocol:"${protocol}",type:"call",id:"same",method:"sessions.dispatch",params:{}}]`],
    ["a call after complete", `[{protocol:"${protocol}",type:"complete"},{protocol:"${protocol}",type:"call",id:"late",method:"sessions.dispatch",params:{}}]`],
    ["two complete frames", `[{protocol:"${protocol}",type:"complete"},{protocol:"${protocol}",type:"complete"}]`]
  ])("rejects %s", async (_label, expression) => {
    const source = expression.startsWith("[")
      ? `for(const frame of ${expression}) process.stdout.write(JSON.stringify(frame)+'\\n');`
      : `process.stdout.write(JSON.stringify(${expression})+'\\n');`;
    await expect(executeScheduleScript(baseInput(source, {
      capabilities: ["sessions.dispatch"],
      broker: { call: async () => ({ ok: true }) },
      postExitCallTimeoutMs: 100
    }))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it.each([
    ["numeric result text", `{type:"complete",resultText:7}`],
    ["numeric primary session", `{type:"complete",primarySessionId:7}`],
    ["oversized primary session", `{type:"complete",primarySessionId:"s".repeat(513)}`]
  ])("validates %s", async (_label, frame) => {
    await expect(executeScheduleScript(baseInput(`
      process.stdout.write(JSON.stringify({protocol:"${protocol}",...${frame}})+"\\n");
    `))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const result = await executeScheduleScript(baseInput(`
      const output=Buffer.from(JSON.stringify({protocol:"${protocol}",type:"complete",resultText:"你好😀"})+"\\n","utf8");
      const marker=Buffer.from("😀","utf8");
      const split=output.indexOf(marker)+1;
      process.stdout.write(output.subarray(0,split));
      setTimeout(()=>process.stdout.write(output.subarray(split)),20);
    `));
    expect(result.resultText).toBe("你好😀");
  });

  it("caps and redacts result text and stderr without splitting output contracts", async () => {
    const result = await executeScheduleScript(baseInput(`
      process.stderr.write("password=hunter2 "+"错".repeat(40000));
      process.stdout.write(JSON.stringify({protocol:"${protocol}",type:"complete",resultText:"api_key=sk-abcdefghijklmnop "+"界".repeat(9000)})+"\\n");
    `));

    expect(Buffer.byteLength(result.resultText ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(result.resultText).toContain("...[truncated]");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.resultText).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(`${result.resultText}${result.stderr}`).not.toContain("hunter2");
    expect(`${result.resultText}${result.stderr}`).not.toContain("sk-abcdefghijklmnop");
    expect(result.stderrTruncated).toBe(true);
    expect(result.resultText).not.toContain("�");
    expect(result.stderr).not.toContain("�");
  });

  it("reports a redacted nonzero exit", async () => {
    const error = await captureError(executeScheduleScript(baseInput(`
      process.stderr.write("authorization=Bearer-secret password=hunter2 sk-abcdefghijklmnop");
      process.exit(7);
    `)));
    expect(error).toMatchObject({ code: "NONZERO_EXIT", exitCode: 7 });
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("sk-abcdefghijklmnop");
  });

  it("reports spawn failures without hanging", async () => {
    await expect(executeScheduleScript(baseInput("process.exit(0);", {
      cwd: "Z:/joko/path/that/does/not/exist"
    }))).rejects.toMatchObject({ code: "SPAWN_FAILED" });
  });

  it("tree-stops a timed out script", async () => {
    const startedAt = Date.now();
    await expect(executeScheduleScript(baseInput("setInterval(()=>undefined,30000);", {
      timeoutMs: 100
    }))).rejects.toMatchObject({ code: "TIMED_OUT", timedOut: true });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  it("does not spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeScheduleScript(baseInput("this-command-must-not-run", {
      signal: controller.signal
    }))).rejects.toMatchObject({ code: "ABORTED", aborted: true });
  });

  it("tree-stops a running script on abort", async () => {
    const controller = new AbortController();
    const pending = executeScheduleScript(baseInput("setInterval(()=>undefined,30000);", {
      signal: controller.signal,
      timeoutMs: 5_000
    }));
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", aborted: true });
  }, 10_000);

  it("passes only allowlisted non-sensitive environment values", async () => {
    const environment = buildScheduleScriptEnvironment({
      PATH: process.env.PATH,
      HOME: "safe-home",
      API_TOKEN: "hidden-token",
      DATABASE_PASSWORD: "hidden-password",
      CUSTOM_VALUE: "hidden-custom"
    });
    expect(environment).toMatchObject({
      HOME: "safe-home",
      JOKO_SCHEDULE_SCRIPT_PROTOCOL: "1",
      PYTHONUTF8: "1"
    });
    expect(environment).not.toHaveProperty("API_TOKEN");
    expect(environment).not.toHaveProperty("DATABASE_PASSWORD");
    expect(environment).not.toHaveProperty("CUSTOM_VALUE");

    const result = await executeScheduleScript(baseInput(onStart(`
      emit({type:"complete",resultText:JSON.stringify({marker:process.env.JOKO_SCHEDULE_SCRIPT_PROTOCOL,secret:process.env.JOKO_TEST_TOKEN??null,custom:process.env.JOKO_TEST_CUSTOM??null})});
    `), {
      environment: {
        ...process.env,
        JOKO_TEST_TOKEN: "must-not-leak",
        JOKO_TEST_CUSTOM: "must-not-pass"
      }
    }));
    expect(JSON.parse(result.resultText ?? "{}")).toEqual({
      marker: "1",
      secret: null,
      custom: null
    });
  });
});

function baseInput(
  source: string,
  overrides: Partial<ExecuteScheduleScriptInput> = {}
): ExecuteScheduleScriptInput {
  const broker: ScheduleScriptCapabilityBroker = {
    call: async () => {
      throw new Error("Unexpected capability call.");
    }
  };
  return {
    command: nodeEval(source),
    cwd: process.cwd(),
    scheduleId: "schedule-1",
    scheduleName: "Daily inspection",
    runId: "run-1",
    firedAt: 1_700_000_000_000,
    capabilities: [],
    timeoutMs: 5_000,
    broker,
    ...overrides
  };
}

function onStart(startBody: string, otherBody = ""): string {
  return `
    const readline=require("node:readline");
    const emit=(value)=>process.stdout.write(JSON.stringify({protocol:"${protocol}",...value})+"\\n");
    const lines=readline.createInterface({input:process.stdin});
    lines.on("line",line=>{
      const frame=JSON.parse(line);
      if(frame.type==="start"){${startBody}}
      else{${otherBody}}
    });
  `;
}

function nodeEval(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

async function captureError(promise: Promise<unknown>): Promise<ScheduleScriptExecutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleScriptExecutionError);
    return error as ScheduleScriptExecutionError;
  }
  throw new Error("Expected execution to fail.");
}
