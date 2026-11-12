import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { NativeInputHandoffMethod } from "@joko/contracts";
import { expect, it, vi } from "vitest";

import { createMacHandoffDriver } from "./input-handoff-macos-driver.js";
import { executeNativeInputHandoffCommand } from "./input-handoff-native-host.js";
import { executeMacSystemContactsCommand } from "./system-contacts-macos.js";

vi.mock("electron", () => ({ app: {}, nativeImage: {}, screen: {}, systemPreferences: {} }));

it("passes system write fields as data and distinguishes a created anchor from a missing original card", async () => {
  const displayName = "Ada ' \" \\ Hopper";
  const request = create(contract.NativeSystemContactsWriteRequestSchema, { items: [
    { contactId: "new", fields: { displayName, kind: contract.ContactKind.PERSON, emails: [{ value: "ada@example.test" }] } },
    { contactId: "old", nativeId: "original-card", fields: { displayName: "Old", kind: contract.ContactKind.PERSON } }
  ] });
  const run = vi.fn(async (script: string) => {
    const literal = script.split("\n")[0]!.match(/^const input = JSON\.parse\((.+)\);$/u)![1]!;
    const values: unknown = JSON.parse(JSON.parse(literal));
    expect(values).toEqual([
      { contactId: "new", fields: { displayName, kind: contract.ContactKind.PERSON, emails: [{ value: "ada@example.test", label: "" }],
        phones: [], organizationName: "", title: "" } },
      { contactId: "old", nativeId: "original-card", fields: { displayName: "Old", kind: contract.ContactKind.PERSON,
        emails: [], phones: [], organizationName: "", title: "" } }
    ]);
    return [{ contactId: "new", outcome: "created", nativeId: "saved-card" }, { contactId: "old", outcome: "missing" }];
  });
  const receipt = await executeMacSystemContactsCommand({ method: NativeInputHandoffMethod.WRITE_SYSTEM_CONTACTS,
    payload: toBinary(contract.NativeSystemContactsWriteRequestSchema, request) }, new AbortController().signal, run);
  expect(fromBinary(contract.NativeSystemContactsWriteResponseSchema, receipt).receipts).toEqual([
    expect.objectContaining({ contactId: "new", outcome: contract.NativeSystemContactWriteOutcome.CREATED, nativeId: "saved-card" }),
    expect.objectContaining({ contactId: "old", outcome: contract.NativeSystemContactWriteOutcome.MISSING })
  ]);
  expect(run).toHaveBeenCalledOnce();
});

it("runs the signed Main field probe for an exact focus or point and keeps the owner field read", async () => {
  const focusedField = vi.fn(async () => ({ editable: true, secure: false }));
  const driver = { ...createMacHandoffDriver(), focusedField };
  const check = vi.fn(async () => true);
  const run = (value: unknown) => executeNativeInputHandoffCommand({ method: NativeInputHandoffMethod.FOCUSED_FIELD,
    payload: Buffer.from(JSON.stringify(value)) }, driver, check);

  await expect(run({ pid: 7, secureOnly: true })).resolves.toBe(true);
  await expect(run({ pid: 7, secureOnly: true, point: [-10, 24] })).resolves.toBe(true);
  expect(check.mock.calls).toEqual([[{ pid: 7 }], [{ pid: 7, point: { x: -10, y: 24 } }]]);
  expect(focusedField).not.toHaveBeenCalled();

  await expect(run({ pid: 7, secureOnly: true, point: [1] })).rejects.toThrow("invalid");
  await expect(run({ pid: 7, secureOnly: true, text: "unadmitted field" })).rejects.toThrow("invalid");
  await expect(run({ pid: 2 ** 31, secureOnly: true })).rejects.toThrow("invalid");
  expect(check).toHaveBeenCalledTimes(2);

  await expect(run({ pid: 7 })).resolves.toEqual({ editable: true, secure: false });
  expect(focusedField).toHaveBeenCalledWith(7);
});
