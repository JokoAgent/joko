import { create } from "@bufbuild/protobuf";
import {
  SchedulePullRequestChange,
  SchedulePullRequestTriggerSchema,
  type SchedulePullRequestTrigger
} from "./gen/joko/v1/runtime_pb.js";

export const schedulePullRequestChanges = ["any", "merged", "review", "checks"] as const;
export type SchedulePullRequestCondition = typeof schedulePullRequestChanges[number];
export interface SchedulePullRequestRule {
  readonly url: string;
  readonly change: SchedulePullRequestCondition;
}

const changes = {
  any: SchedulePullRequestChange.ANY,
  merged: SchedulePullRequestChange.MERGED,
  review: SchedulePullRequestChange.REVIEW,
  checks: SchedulePullRequestChange.CHECKS
};

export function schedulePullRequestUrl(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const match = /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d][a-z\d._-]{0,99})\/pull\/([1-9]\d{0,9})\/?$/iu.exec(input.trim());
  if (match === null || Number(match[3]) > 2_147_483_647) return undefined;
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/pull/${match[3]}`;
}

export function normalizeSchedulePullRequestRule(input: unknown): SchedulePullRequestRule | undefined {
  if (typeof input !== "object" || input === null || !("url" in input) || typeof input.url !== "string" || !("change" in input)) {
    return undefined;
  }
  const url = schedulePullRequestUrl(input.url);
  const change = schedulePullRequestChanges.find(value => value === input.change);
  return url === undefined || change === undefined ? undefined : { url, change };
}

export function schedulePullRequestRuleFromProto(input: SchedulePullRequestTrigger): SchedulePullRequestRule | undefined {
  return normalizeSchedulePullRequestRule({
    url: input.url,
    change: schedulePullRequestChanges.find(value => changes[value] === input.change)
  });
}

export function schedulePullRequestRuleToProto(rule: SchedulePullRequestRule | null): SchedulePullRequestTrigger {
  return create(SchedulePullRequestTriggerSchema, rule === null ? {} : { url: rule.url, change: changes[rule.change] });
}
