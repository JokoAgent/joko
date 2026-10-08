import { describe, expect, it, vi } from "vitest";
import type { ComposerDraft, NewSessionDraft, ObjectiveView, SkillLearningRunView } from "./model.js";
import { createDelayedSessionFromFirstInput, createSessionFromFirstInput } from "./new-session-flow.js";

const session: NewSessionDraft = {
  targetId: "target-1",
  name: "New task",
  nativeStart: { kind: "fresh" },
  providerId: "provider-1",
  modelId: "model-1",
  effort: "high",
  fastMode: true,
  permissionMode: "ask",
  planMode: false
};

const input: ComposerDraft = {
  text: "Inspect the repository",
  attachments: [],
  mentions: [],
  deliveryMode: "prompt"
};

describe("lazy new-session dispatch", () => {
  it("reveals a slash Objective task, refreshes its runtime catalog, then sets the application Objective", async () => {
    const order: string[] = [];
    const objective = objectiveView("objective-session", 21n, "Ship the release");
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "objective-session", generation: 21n }; }),
      listCommands: vi.fn(async () => { order.push("commands"); return []; }),
      setObjective: vi.fn(async () => { order.push("objective"); return objective; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const accepted = vi.fn((value) => { order.push(`accepted:${value.kind}`); });

    await expect(createSessionFromFirstInput(api, session, { ...input, text: "/goal Ship the release" }, () => {
      order.push("reveal");
    }, {
      disposition: {
        kind: "objective", source: "slash", requestId: "objective-request", action: "set",
        text: "Ship the release", limits: { noProgressTurnLimit: 3 }
      },
      onAccepted: accepted
    })).resolves.toBe("objective-session");

    expect(order).toEqual(["create", "reveal", "commands", "objective", "accepted:objectiveSet"]);
    expect(api.setObjective).toHaveBeenCalledExactlyOnceWith(
      "objective-session", 21n, "Ship the release", { noProgressTurnLimit: 3 }, undefined
    );
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith({
      kind: "objectiveSet", requestId: "objective-request", sessionId: "objective-session",
      sessionGeneration: 21n, objective
    });
  });

  it("sends the complete slash invocation when the created runtime owns loaded /goal", async () => {
    const attachment = { id: "notes", kind: "file" as const, file: { name: "notes.txt" } as File };
    const invocation: ComposerDraft = { ...input, text: "/goal Runtime owned", attachments: [attachment] };
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "runtime-goal", generation: 22n })),
      listCommands: vi.fn(async () => [{
        id: "runtime-goal-command", name: "/goal", description: "Runtime goal",
        source: "skill" as const, loaded: true
      }]),
      setObjective: vi.fn(async () => objectiveView("runtime-goal", 22n, "unused")),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const accepted = vi.fn();

    await createSessionFromFirstInput(api, session, invocation, vi.fn(), {
      disposition: {
        kind: "objective", source: "slash", requestId: "runtime-goal-request", action: "set",
        text: "Runtime owned", limits: { noProgressTurnLimit: 3 }
      },
      onAccepted: accepted
    });

    expect(api.listCommands).toHaveBeenCalledExactlyOnceWith("runtime-goal", undefined);
    expect(api.send).toHaveBeenCalledExactlyOnceWith("runtime-goal", invocation, { expectedGeneration: 22n });
    expect(api.setObjective).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith({ kind: "sent", sessionId: "runtime-goal" });
  });

  it("installs the complete bare /goal draft before accepting its exact dialog handoff", async () => {
    const invocation: ComposerDraft = {
      ...input,
      text: "/goal",
      attachments: [{ id: "context", kind: "file", file: { name: "context.txt" } as File }]
    };
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "dialog-session", generation: 23n }; }),
      listCommands: vi.fn(async () => { order.push("commands"); return []; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const accepted = vi.fn((value) => { order.push(`accepted:${value.kind}`); });

    await createSessionFromFirstInput(api, session, invocation, () => { order.push("reveal"); }, {
      disposition: { kind: "objective", source: "slash", requestId: "dialog-request", action: "open" },
      onAccepted: accepted
    });

    expect(order).toEqual(["create", "reveal", "commands", "restore", "accepted:objectiveDialog"]);
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("dialog-session", invocation);
    expect(api.send).not.toHaveBeenCalled();
    const acceptance = accepted.mock.calls[0]![0];
    expect(acceptance).toMatchObject({
      kind: "objectiveDialog", requestId: "dialog-request", sessionId: "dialog-session", sessionGeneration: 23n
    });
    expect(acceptance.kind === "objectiveDialog" && acceptance.expectedDraft).toBe(invocation);
  });

  it.each([false, true])("treats application /goal clear as an accepted exact-owner operation; existing=%s", async (existing) => {
    const current = existing ? objectiveView("clear-session", 24n, "Obsolete") : undefined;
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "clear-session", generation: 24n })),
      listCommands: vi.fn(async () => []),
      getObjective: vi.fn(async () => current),
      clearObjective: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const accepted = vi.fn();

    await createSessionFromFirstInput(api, session, { ...input, text: "/goal clear" }, vi.fn(), {
      disposition: { kind: "objective", source: "slash", requestId: "clear-request", action: "clear" },
      onAccepted: accepted
    });

    expect(api.getObjective).toHaveBeenCalledExactlyOnceWith("clear-session", undefined);
    expect(api.clearObjective).toHaveBeenCalledTimes(existing ? 1 : 0);
    if (existing) expect(api.clearObjective).toHaveBeenCalledWith(current, undefined);
    expect(api.send).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith({
      kind: "objectiveCleared", requestId: "clear-request", sessionId: "clear-session",
      sessionGeneration: 24n, cleared: existing
    });
  });

  it("fails closed and restores the invocation when /goal clear observes another Session generation", async () => {
    const invocation = { ...input, text: "/goal clear" };
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "changed-clear-session", generation: 25n })),
      listCommands: vi.fn(async () => []),
      getObjective: vi.fn(async () => objectiveView("changed-clear-session", 26n, "New owner")),
      clearObjective: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };

    await expect(createSessionFromFirstInput(api, session, invocation, vi.fn(), {
      disposition: { kind: "objective", source: "slash", requestId: "changed-clear", action: "clear" }
    })).rejects.toThrow("owner changed");
    expect(api.clearObjective).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("changed-clear-session", invocation);
  });

  it("bypasses runtime command ownership for an explicit dialog and reveals only after Objective acceptance", async () => {
    const order: string[] = [];
    const objective = objectiveView("explicit-dialog", 27n, "Dialog objective");
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "explicit-dialog", generation: 27n }; }),
      listCommands: vi.fn(async () => { order.push("commands"); return []; }),
      setObjective: vi.fn(async () => { order.push("objective"); return objective; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const accepted = vi.fn((value) => { order.push(`accepted:${value.kind}`); });

    await createSessionFromFirstInput(api, session, input, () => { order.push("reveal"); }, {
      disposition: {
        kind: "objective", source: "dialog", requestId: "explicit-dialog-request", action: "set",
        text: "Dialog objective", limits: { maximumTurns: 20 }
      },
      onAccepted: accepted
    });

    expect(order).toEqual(["create", "objective", "reveal", "accepted:objectiveSet"]);
    expect(api.listCommands).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
  });

  it("keeps an explicit dialog owner visible and restores its created task draft once when set fails", async () => {
    const failure = new Error("Objective unavailable");
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "failed-dialog", generation: 28n })),
      listCommands: vi.fn(async () => []),
      setObjective: vi.fn(async () => { throw failure; }),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const revealed = vi.fn();

    await expect(createSessionFromFirstInput(api, session, input, revealed, {
      disposition: {
        kind: "objective", source: "dialog", requestId: "failed-dialog-request", action: "set",
        text: "Keep this goal", limits: {}
      }
    })).rejects.toBe(failure);

    expect(revealed).not.toHaveBeenCalled();
    expect(api.listCommands).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("failed-dialog", input);
  });

  it("does not retry a failed bare-dialog draft installation", async () => {
    const recoveryFailure = new Error("Draft storage unavailable");
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "failed-open", generation: 29n })),
      listCommands: vi.fn(async () => []),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => { throw recoveryFailure; })
    };

    await expect(createSessionFromFirstInput(api, session, { ...input, text: "/goal" }, vi.fn(), {
      disposition: { kind: "objective", source: "slash", requestId: "failed-open-request", action: "open" }
    })).rejects.toBe(recoveryFailure);
    expect(api.restoreFirstInputDraft).toHaveBeenCalledOnce();
  });

  it("allows an explicit Objective for a managed Dialogue while /learn remains Target-only", async () => {
    const order: string[] = [];
    const api = {
      createTarget: vi.fn(async () => { order.push("target"); return "dialogue-target"; }),
      refresh: vi.fn(async () => { order.push("refresh"); }),
      createSession: vi.fn(async () => { order.push("session"); return { sessionId: "dialogue-objective", generation: 30n }; }),
      listCommands: vi.fn(async () => { order.push("commands"); return []; }),
      setObjective: vi.fn(async () => { order.push("objective"); return objectiveView("dialogue-objective", 30n, "Dialogue goal"); }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };

    await createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "dialogue", backendId: "backend-1" }
    }, input, () => { order.push("reveal"); }, undefined, {
      disposition: {
        kind: "objective", source: "dialog", requestId: "dialogue-objective-request", action: "set",
        text: "Dialogue goal", limits: {}
      }
    });

    expect(order).toEqual(["target", "refresh", "session", "objective", "reveal"]);
    expect(api.listCommands).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("validates Objective ownership before creating a managed Dialogue Target", async () => {
    const api = {
      createTarget: vi.fn(async () => "orphan-target"),
      refresh: vi.fn(async () => undefined),
      createSession: vi.fn(async () => ({ sessionId: "orphan-session", generation: 1n })),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };

    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "dialogue", backendId: "backend-1" }
    }, input, vi.fn(), undefined, {
      disposition: {
        kind: "objective", source: "dialog", requestId: "unavailable-objective", action: "set",
        text: "Do not orphan a Target", limits: {}
      }
    })).rejects.toThrow("Objectives are unavailable");
    expect(api.createTarget).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it.each([
    { evidence: "createdSession" as const, instruction: "", sourceSessionId: "learn-source" },
    { evidence: "freeText" as const, instruction: "Preserve the release checklist", sourceSessionId: undefined }
  ])("accepts /learn locally after revealing the new Session; evidence=$evidence", async ({ evidence, instruction, sourceSessionId }) => {
    const order: string[] = [];
    const accepted = vi.fn((value) => { order.push(`accepted:${value.kind}`); });
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "learn-source", generation: 11n }; }),
      listCommands: vi.fn(async () => { order.push("commands"); return []; }),
      startSkillLearning: vi.fn(async () => {
        order.push("learn");
        return learningRun("distilled", evidence === "createdSession"
          ? {}
          : { sourceKind: "text", sourceSessionId: undefined });
      }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };

    await expect(createSessionFromFirstInput(api, session, input, () => { order.push("reveal"); }, {
      disposition: { kind: "learn", requestId: "learn-request", backendId: "backend-1", instruction, evidence, application: { kind: "eligible" } },
      onAccepted: accepted
    })).resolves.toBe("learn-source");

    expect(order).toEqual(["create", "reveal", "commands", "learn", "accepted:learned"]);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(api.startSkillLearning).toHaveBeenCalledExactlyOnceWith({
      requestId: "learn-request",
      targetId: session.targetId,
      instruction,
      ...(sourceSessionId === undefined ? {} : { sourceSessionId })
    }, undefined);
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({
      kind: "learned",
      sessionId: "learn-source",
      run: expect.objectContaining({ distillationSessionId: "distilled" })
    }));
  });

  it("sends the full invocation when the created runtime owns loaded /learn as a Skill command", async () => {
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "runtime-learn", generation: 12n })),
      listCommands: vi.fn(async () => [{
        id: "runtime-learn-command", name: "/learn", description: "Runtime Skill command",
        source: "skill" as const, loaded: true
      }]),
      startSkillLearning: vi.fn(async () => learningRun("unused")),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const accepted = vi.fn();

    await createSessionFromFirstInput(api, session, input, vi.fn(), {
      disposition: {
        kind: "learn", requestId: "runtime-request", backendId: "backend-1", instruction: "Use runtime",
        evidence: "freeText", application: { kind: "rejected", reason: "structured" }
      },
      onAccepted: accepted
    });

    expect(api.listCommands).toHaveBeenCalledExactlyOnceWith("runtime-learn", undefined);
    expect(api.send).toHaveBeenCalledExactlyOnceWith("runtime-learn", input, { expectedGeneration: 12n });
    expect(api.startSkillLearning).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith({ kind: "sent", sessionId: "runtime-learn" });
  });

  it.each([
    { reason: "hub" as const, message: "Catalog Skill identifiers" },
    { reason: "structured" as const, message: "accepts text only" }
  ])("restores an app-ineligible $reason invocation when the fresh runtime does not own /learn", async ({ reason, message }) => {
    const sourceInput = { ...input, text: reason === "hub" ? "/learn hub:catalog" : "/learn preserve" };
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "rejected-app-learn", generation: 16n })),
      listCommands: vi.fn(async () => []),
      startSkillLearning: vi.fn(async () => learningRun("unused")),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    await expect(createSessionFromFirstInput(api, session, sourceInput, vi.fn(), {
      disposition: {
        kind: "learn", requestId: "rejected-app-request", backendId: "backend-1",
        instruction: reason === "hub" ? "hub:catalog" : "preserve", evidence: "freeText",
        application: { kind: "rejected", reason }
      }
    })).rejects.toThrow(message);
    expect(api.listCommands).toHaveBeenCalledOnce();
    expect(api.startSkillLearning).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("rejected-app-learn", sourceInput);
  });

  it.each(["catalog", "learning"] as const)("restores the complete invocation after post-create %s failure without retrying", async (stage) => {
    const failure = new Error(`${stage} unknown`);
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "recover-learn", generation: 13n })),
      listCommands: vi.fn(async () => {
        if (stage === "catalog") throw failure;
        return [];
      }),
      startSkillLearning: vi.fn(async () => {
        if (stage === "learning") throw failure;
        return learningRun("unused");
      }),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };

    await expect(createSessionFromFirstInput(api, session, input, vi.fn(), {
      disposition: {
        kind: "learn", requestId: "recover-request", backendId: "backend-1", instruction: "Keep all input",
        evidence: "freeText", application: { kind: "eligible" }
      }
    })).rejects.toBe(failure);

    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("recover-learn", input);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.listCommands).toHaveBeenCalledOnce();
    expect(api.startSkillLearning).toHaveBeenCalledTimes(stage === "learning" ? 1 : 0);
  });

  it("treats a fulfilled failed learning run as rejection and restores the invocation", async () => {
    const failed = { ...learningRun("partial-distillation"), state: "failed" as const, error: "Learning could not start." };
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "failed-learn", generation: 14n })),
      listCommands: vi.fn(async () => []),
      startSkillLearning: vi.fn(async () => failed),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };

    await expect(createSessionFromFirstInput(api, session, input, vi.fn(), {
      disposition: {
        kind: "learn", requestId: "failed-request", backendId: "backend-1", instruction: "",
        evidence: "createdSession", application: { kind: "eligible" }
      }
    })).rejects.toThrow("Learning could not start.");
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("failed-learn", input);
    expect(api.send).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Target", run: learningRun("wrong-target", { targetId: "other-target" }) },
    { label: "source", run: learningRun("wrong-source", { sourceKind: "text", sourceSessionId: undefined }) }
  ])("rejects a fulfilled learning run with mismatched $label authority", async ({ run }) => {
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "authority-source", generation: 15n })),
      listCommands: vi.fn(async () => []),
      startSkillLearning: vi.fn(async () => run),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const sourceInput = { ...input, text: "/learn" };
    await expect(createSessionFromFirstInput(api, session, sourceInput, vi.fn(), {
      disposition: {
        kind: "learn", requestId: "authority-request", backendId: "backend-1",
        instruction: "", evidence: "createdSession", application: { kind: "eligible" }
      }
    })).rejects.toThrow("did not return an active distillation task");
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("authority-source", sourceInput);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("rejects a local /learn disposition for a managed dialogue before creating an orphan Target", async () => {
    const api = {
      createTarget: vi.fn(async () => "dialogue-target"),
      refresh: vi.fn(async () => undefined),
      createSession: vi.fn(async () => ({ sessionId: "unused", generation: 1n })),
      listCommands: vi.fn(async () => []),
      startSkillLearning: vi.fn(async () => learningRun("unused")),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "dialogue", backendId: "backend" }
    }, input, vi.fn(), undefined, {
      disposition: {
        kind: "learn", requestId: "invalid-dialogue", backendId: "backend-1", instruction: "",
        evidence: "createdSession", application: { kind: "eligible" }
      }
    })).rejects.toThrow("selected task environment");
    expect(api.createTarget).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it.each([true, false])("validates the actual new runtime before first input; valid=%s", async (valid) => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "new-runtime", generation: 2n }; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const accepted = vi.fn(() => { order.push("accepted"); });
    const beforeFirstInput = vi.fn(async (id: string) => { order.push(`validate:${id}`); if (!valid) throw new Error("Extension command changed"); });
    const result = createSessionFromFirstInput(api, session, input, () => { order.push("reveal"); }, { beforeFirstInput, onAccepted: accepted });
    if (valid) {
      await expect(result).resolves.toBe("new-runtime");
      expect(order).toEqual(["create", "reveal", "validate:new-runtime", "send", "accepted"]);
      expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toThrow("Extension command changed");
      expect(order).toEqual(["create", "reveal", "validate:new-runtime", "restore"]);
      expect(api.send).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
      expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("new-runtime", input);
    }
  });
  it("carries only the prepared Target revision into project task creation", async () => {
    const api = {
      createTarget: vi.fn(async () => "unused"),
      refresh: vi.fn(async () => undefined),
      createSession: vi.fn(async () => ({ sessionId: "session-project", generation: 2n })),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    await createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "target", targetId: session.targetId },
      expectedTargetRevision: 7n
    }, input, vi.fn());
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
      targetId: session.targetId,
      expectedTargetRevision: 7n
    }));

    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "target", targetId: session.targetId }
    }, input, vi.fn())).rejects.toThrow("prepared Target revision");
    expect(api.createTarget).not.toHaveBeenCalled();
  });

  it("creates only when invoked, reveals the durable task, then sends its first input", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "session-1", generation: 7n }; }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const onCreated = vi.fn((sessionId: string) => {
      order.push(`navigate:${sessionId}`);
    });

    expect(api.createSession).not.toHaveBeenCalled();
    await expect(createSessionFromFirstInput(api, session, input, onCreated)).resolves.toBe("session-1");

    expect(order).toEqual(["create", "navigate:session-1", "send"]);
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
    expect(api.send).toHaveBeenCalledWith("session-1", input, { expectedGeneration: 7n });
  });

  it("still reveals the created task before a first-input failure escapes", async () => {
    const order: string[] = [];
    const api = {
      createSession: vi.fn(async () => { order.push("create"); return { sessionId: "session-2", generation: 8n }; }),
      send: vi.fn(async () => { order.push("send"); throw new Error("dispatch failed"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };

    await expect(createSessionFromFirstInput(api, session, input, (sessionId) => {
      order.push(`navigate:${sessionId}`);
    })).rejects.toThrow("dispatch failed");
    expect(order).toEqual(["create", "navigate:session-2", "send", "restore"]);
    expect(api.restoreFirstInputDraft).toHaveBeenCalledExactlyOnceWith("session-2", input);
  });

  it("reports both failures when rejected first input cannot be restored", async () => {
    const dispatchFailure = new Error("dispatch failed");
    const recoveryFailure = new Error("recovery failed");
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "session-restore-failed", generation: 9n })),
      send: vi.fn(async () => { throw dispatchFailure; }),
      restoreFirstInputDraft: vi.fn(async () => { throw recoveryFailure; })
    };

    const result = createSessionFromFirstInput(api, session, input, vi.fn());
    await expect(result).rejects.toThrow("The first input was not accepted and could not be restored to the created task draft.");
    await expect(result).rejects.toMatchObject({ errors: [dispatchFailure, recoveryFailure] });
  });

  it("does not navigate or send when session creation itself fails", async () => {
    const api = {
      createSession: vi.fn(async () => { throw new Error("create failed"); }),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const onCreated = vi.fn();

    await expect(createSessionFromFirstInput(api, session, input, onCreated)).rejects.toThrow("create failed");
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.restoreFirstInputDraft).not.toHaveBeenCalled();
  });

  it("preserves accepted first input even if revealing the created task fails", async () => {
    const api = {
      createSession: vi.fn(async () => ({ sessionId: "created", generation: 3n })),
      send: vi.fn(async () => undefined),
      restoreFirstInputDraft: vi.fn(async () => undefined)
    };
    const accepted = vi.fn();
    await expect(createSessionFromFirstInput(api, session, input, () => {
      throw new Error("Navigation failed");
    }, { onAccepted: accepted })).rejects.toThrow("Navigation failed");
    expect(api.send).toHaveBeenCalledExactlyOnceWith("created", input, { expectedGeneration: 3n });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("creates and refreshes a durable managed-dialogue target before Session creation", async () => {
    const order: string[] = [];
    const api = {
      createTarget: vi.fn(async () => { order.push("target"); return "target-dialogue"; }),
      refresh: vi.fn(async () => { order.push("refresh"); }),
      createSession: vi.fn(async (draft: NewSessionDraft) => { order.push(`session:${draft.targetId}`); throw new Error("session failed"); }),
      send: vi.fn(async () => { order.push("send"); }),
      restoreFirstInputDraft: vi.fn(async () => { order.push("restore"); })
    };
    const targetVisible = vi.fn((targetId: string) => {
      order.push(`visible:${targetId}`);
    });

    await expect(createDelayedSessionFromFirstInput(api, {
      ...session,
      selection: { kind: "dialogue", backendId: "backend-1" }
    }, input, vi.fn(), targetVisible)).rejects.toThrow("session failed");

    expect(api.createTarget).toHaveBeenCalledWith({
      backendId: "backend-1",
      name: "New task",
      workspaceKind: "managedDialogue",
      serverPath: "",
      createIfMissing: true
    });
    expect(order).toEqual(["target", "refresh", "visible:target-dialogue", "session:target-dialogue"]);
    expect(api.send).not.toHaveBeenCalled();
  });
});

function learningRun(
  distillationSessionId: string,
  overrides: Partial<SkillLearningRunView> = {}
): SkillLearningRunView {
  return {
    id: "skill_learning_0123456789abcdef0123456789abcdef",
    revision: 1n,
    state: "distilling",
    sourceKind: "session",
    backendId: "backend-1",
    targetId: session.targetId,
    sourceSessionId: "learn-source",
    distillationSessionId,
    summary: "Learning",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...overrides
  };
}

function objectiveView(sessionId: string, sessionGeneration: bigint, text: string): ObjectiveView {
  return {
    sessionId,
    sessionGeneration,
    text,
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    noProgressTurns: 0,
    ownerGeneration: 1n,
    startedAt: 1,
    revision: 1n
  };
}
