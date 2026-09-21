// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PartnerDelegationView, ToolCallView } from "../model.js";
import {
  PartnerDelegationInlineCard
} from "./PartnerDelegationInlineCard.js";
import { readPartnerDelegationCardData } from "./partner-delegation-card-data.js";
import type { Translator } from "./types.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("PartnerDelegationInlineCard", () => {
  it("accepts only the current public Partner delegation tool shape", () => {
    const parsed = readPartnerDelegationCardData(tool());
    expect(parsed).toEqual({ targetName: "Nova", delegation: delegation() });
    expect(readPartnerDelegationCardData(tool({ extra: true }))).toBeUndefined();
    expect(readPartnerDelegationCardData(tool({ status: "invented" }))).toBeUndefined();
    expect(readPartnerDelegationCardData(tool({ status: "completed" }))).toBeUndefined();
    expect(readPartnerDelegationCardData({
      ...tool(),
      name: "mcp__joko_0123456789abcdef01234567__start_delegation"
    })).toEqual(parsed);
    expect(readPartnerDelegationCardData({ ...tool(), name: "mcp__other__start_delegation" })).toBeUndefined();
  });

  it("reconciles live state and revision-fences cancellation from the inline card", async () => {
    const initial = delegation();
    const get = vi.fn(async () => initial);
    const cancelled = { ...initial, revision: 2n, status: "cancelled" as const, completedAt: 9_000 };
    const cancel = vi.fn(async () => cancelled);
    const openSession = vi.fn();
    await act(async () => {
      root.render(<PartnerDelegationInlineCard
        initial={initial}
        targetName="Nova"
        ownerKey="owner-one"
        actions={{ get, cancel, openSession }}
        t={t}
      />);
      await settle();
    });
    expect(get).toHaveBeenCalledWith("partner-one", "delegation-one", expect.any(AbortSignal));

    await act(async () => { button("partners.openDelegatedTask").click(); });
    expect(openSession).toHaveBeenCalledWith("session-two");
    await act(async () => { button("partners.stopDelegation").click(); await settle(); });
    expect(cancel).toHaveBeenCalledWith("partner-one", "delegation-one", 1n);
    expect(host.textContent).toContain("partners.delegationState.cancelled");
  });
});

function tool(overrides: Readonly<Record<string, unknown>> = {}): ToolCallView {
  return {
    id: "tool-one",
    name: "mcp__joko_partners__start_delegation",
    state: "succeeded",
    input: "",
    output: JSON.stringify({
      id: "delegation-one",
      revision: "1",
      requester_partner_id: "partner-one",
      target_partner_id: "partner-two",
      parent_session_id: "session-one",
      target_profile_version: "2",
      target_partner: {
        id: "partner-two",
        display_name: "Nova",
        avatar: "orbit",
        status: "active",
        ready: true
      },
      title: "Research",
      objective: "Find the durable answer",
      status: "running",
      child_session_id: "session-two",
      run_id: "run-one",
      artifact_count: 1,
      created_at: 2_000,
      updated_at: 4_000,
      started_at: 3_000,
      ...overrides
    }),
    isError: false
  };
}

function delegation(): PartnerDelegationView {
  return {
    id: "delegation-one",
    revision: 1n,
    requesterPartnerId: "partner-one",
    targetPartnerId: "partner-two",
    parentSessionId: "session-one",
    targetProfileVersion: 2n,
    title: "Research",
    objective: "Find the durable answer",
    status: "running",
    childSessionId: "session-two",
    runId: "run-one",
    artifactCount: 1,
    createdAt: 2_000,
    updatedAt: 4_000,
    startedAt: 3_000
  };
}

function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(label));
  if (result === undefined) throw new Error(`Missing ${label} action.`);
  return result;
}

const t: Translator = (key) => key;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
