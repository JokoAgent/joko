import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPersonalDevelopmentDoctorConnectMethods, toProtoPersonalDevelopmentDoctorRun } from "./personal-development-doctor-connect.js";
import type { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";
import type { DevelopmentDoctorRun } from "./personal-development-doctor-types.js";

describe("personal-development doctor generated boundary", () => {
  it("echoes the admitted request, keeps progress path-free and rechecks authorization after awaits", async () => {
    const report: DevelopmentDoctorRun = { runId: "doctor-run", sessionId: "origin", mode: "prepare", request: "render", status: "running", stage: "source",
      checks: [{ id: "native", status: "ready", reason: "nativeWindows" }], createdAt: 1, updatedAt: 2, attempt: 1, platform: "win32", arch: "x64",
      operation: { id: "source-operation", kind: "source-prepare", status: "running", inputHash: "private-input-hash", stage: "receiving", startedAt: 1,
        percent: 47, dependencyProgress: { resolved: 4, reused: 2, downloaded: 1, added: 1 }, diagnostics: [{ stage: "git", code: "COMMAND_FAILED", exitCode: 1 }] } };
    const start = vi.fn().mockResolvedValue(report), control = vi.fn().mockResolvedValue(report), authenticateLocal = vi.fn();
    const service = createPersonalDevelopmentDoctorConnectMethods({ doctor: () => ({ start, control }) as unknown as PersonalDevelopmentDoctor, authenticateLocal });
    const context = { signal: new AbortController().signal } as HandlerContext;
    const request = create(contract.StartPersonalDevelopmentDoctorRequestSchema, { operationId: "start-request", mode: "prepare", request: "render", title: "Rendering",
      targetId: "local", permissionMode: "ask" });
    const result = await service.startPersonalDevelopmentDoctor(request, context);
    expect(result).toMatchObject({ $typeName: "joko.v1.StartPersonalDevelopmentDoctorResponse", operationId: "start-request", report: { runId: "doctor-run", sessionId: "origin", operation: { percent: 47,
      dependencyProgress: { resolved: 4n }, diagnostics: [{ code: "COMMAND_FAILED" }] } } });
    expect(toProtoPersonalDevelopmentDoctorRun(report).operation).not.toHaveProperty("inputHash");
    const controlled = await service.controlPersonalDevelopmentDoctor(create(contract.ControlPersonalDevelopmentDoctorRequestSchema,
      { operationId: "cancel-request", runId: "doctor-run", action: "cancel" }), context);
    expect(controlled).toMatchObject({ $typeName: "joko.v1.ControlPersonalDevelopmentDoctorResponse", operationId: "cancel-request" });
    expect(control).toHaveBeenCalledExactlyOnceWith({ operationId: "cancel-request", runId: "doctor-run", action: "cancel" });
    authenticateLocal.mockImplementationOnce(() => { throw new ConnectError("Denied", Code.PermissionDenied); });
    await expect(service.startPersonalDevelopmentDoctor(request, context)).rejects.toMatchObject({ code: Code.PermissionDenied }); expect(start).toHaveBeenCalledOnce();
    authenticateLocal.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new ConnectError("Retired", Code.PermissionDenied); });
    await expect(service.startPersonalDevelopmentDoctor(request, context)).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
});
