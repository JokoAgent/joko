import { create } from "@bufbuild/protobuf";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import * as contract from "@joko/contracts";
import type { PartnerWorkbenchView, PartnerWorkbenchOwnerView, PartnerWorkbenchTaskView, PartnerWorkbenchJudgmentView, PartnerWorkbenchProjectBriefView, PartnerWorkbenchDetailView, PartnerWorkbenchTextView } from "./model.js";

const VERDICTS = { unfinished: contract.PartnerWorkbenchVerdict.UNFINISHED, idea: contract.PartnerWorkbenchVerdict.IDEA, done: contract.PartnerWorkbenchVerdict.DONE } as const;
const KINDS = { session: contract.PartnerWorkbenchTaskKind.SESSION, external: contract.PartnerWorkbenchTaskKind.EXTERNAL, item: contract.PartnerWorkbenchTaskKind.ITEM, automation: contract.PartnerWorkbenchTaskKind.AUTOMATION } as const;
const STATES = { running: contract.PartnerWorkbenchTaskState.RUNNING, waiting: contract.PartnerWorkbenchTaskState.WAITING, queued: contract.PartnerWorkbenchTaskState.QUEUED,
  stopped: contract.PartnerWorkbenchTaskState.STOPPED, automation: contract.PartnerWorkbenchTaskState.AUTOMATION, done: contract.PartnerWorkbenchTaskState.DONE } as const;
const GROUPS = { waiting: contract.PartnerWorkbenchGroup.WAITING, running: contract.PartnerWorkbenchGroup.RUNNING, todo: contract.PartnerWorkbenchGroup.TODO, done: contract.PartnerWorkbenchGroup.DONE } as const;
function enumKey<T extends string>(map: Readonly<Record<T, number>>, value: number): T {
  const pair = Object.entries<number>(map).find(([, expected]) => expected === value);
  if (pair === undefined) throw new Error("The workbench projection is invalid.");
  return pair[0] as T;
}
function time(value: Timestamp | undefined): number { return value === undefined ? 0 : Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000); }
export function protoWorkbenchOwner(owner: PartnerWorkbenchOwnerView): contract.PartnerWorkbenchOwner { return create(contract.PartnerWorkbenchOwnerSchema, owner); }
export function protoWorkbenchJudgment(item: Omit<PartnerWorkbenchJudgmentView, "updatedAt">): contract.PartnerWorkbenchJudgment {
  return create(contract.PartnerWorkbenchJudgmentSchema, { taskId: item.taskId, project: item.project, title: item.title, verdict: VERDICTS[item.verdict],
    ...(item.next === null ? {} : { next: item.next }), ...(item.ref === undefined ? {} : { ref: item.ref }) });
}
export function sameWorkbenchOwner(left: PartnerWorkbenchOwnerView, right: PartnerWorkbenchOwnerView): boolean {
  return left.partnerId === right.partnerId && left.profileVersion === right.profileVersion && left.sessionId === right.sessionId
    && left.sessionGeneration === right.sessionGeneration && left.targetId === right.targetId;
}
function judgment(value: contract.PartnerWorkbenchJudgment): PartnerWorkbenchJudgmentView {
  return { taskId: value.taskId, project: value.project, title: value.title, verdict: enumKey(VERDICTS, value.verdict), next: value.next ?? null,
    ...(value.ref === undefined ? {} : { ref: value.ref }), updatedAt: time(value.updatedAt) };
}
function role(value: string): "user" | "assistant" { if (value !== "user" && value !== "assistant") throw new Error("The workbench transcript is invalid."); return value; }
function text(value: contract.PartnerWorkbenchText): PartnerWorkbenchTextView {
  const origin = value.privateMessageOrigin;
  return { role: role(value.role), text: value.text, at: time(value.at), ...(origin === undefined ? {} : { privateMessageOrigin: {
    messageId: origin.messageId, threadId: origin.threadId, senderPartnerId: origin.senderPartnerId, recipientPartnerId: origin.recipientPartnerId, senderDisplayName: origin.senderDisplayName
  } }) };
}
function task(value: contract.PartnerWorkbenchTask): PartnerWorkbenchTaskView {
  return { id: value.id, kind: enumKey(KINDS, value.kind), project: value.project, title: value.title, state: enumKey(STATES, value.state), group: enumKey(GROUPS, value.group), updatedAt: time(value.updatedAt),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }), ...(value.scheduleId === undefined ? {} : { scheduleId: value.scheduleId }), sourceLabel: value.sourceLabel,
    ...(value.startedAt === undefined ? {} : { startedAt: time(value.startedAt) }), ...(value.scheduleSummary === undefined ? {} : { scheduleSummary: value.scheduleSummary }),
    ownedBackground: value.ownedBackground, unread: value.unread, ...(value.judgment === undefined ? {} : { judgment: judgment(value.judgment) }),
    digest: { purpose: value.digest?.purpose ?? null, recent: (value.digest?.recent ?? []).map((item) => ({ role: role(item.role), text: item.text })) } };
}
function brief(value: contract.PartnerWorkbenchProjectBrief): PartnerWorkbenchProjectBriefView {
  const unavailable = value.codeHost?.unavailable;
  if (unavailable !== undefined && unavailable !== "not_supported" && unavailable !== "no_credential" && unavailable !== "unavailable") throw new Error("The project source status is invalid.");
  const item = (row: contract.PartnerWorkbenchCodeHostItem): { number: number; title: string; url: string; updatedAt: number } => ({ number: row.number, title: row.title, url: row.url, updatedAt: time(row.updatedAt) });
  return { project: value.project, docs: value.docs, recent: value.recent.map((row) => ({ path: row.path, modifiedAt: time(row.modifiedAt) })),
    ...(value.git === undefined ? {} : { git: { branch: value.git.branch, changes: value.git.changes, commits: value.git.commits.map((row) => ({ sha: row.sha, date: row.date, author: row.author, subject: row.subject })),
      branches: value.git.branches.map((row) => ({ name: row.name, date: row.date })), remotes: value.git.remotes } }),
    codeHost: { repository: value.codeHost?.repository, pullRequests: (value.codeHost?.pullRequests ?? []).map(item), issues: (value.codeHost?.issues ?? []).map(item), ...(unavailable === undefined ? {} : { unavailable }) } };
}
export function mapPartnerWorkbench(value: contract.PartnerWorkbenchSnapshot | undefined): PartnerWorkbenchView {
  if (value?.owner === undefined || value.revision === undefined || value.revision.value < 1n) throw new Error("The workbench owner is unavailable.");
  return { owner: { partnerId: value.owner.partnerId, profileVersion: value.owner.profileVersion, sessionId: value.owner.sessionId, sessionGeneration: value.owner.sessionGeneration, targetId: value.owner.targetId }, revision: value.revision.value,
    projects: value.projects.map((row) => ({ path: row.path, name: row.name, addedAt: time(row.addedAt), exists: row.exists })), judgments: value.judgments.map(judgment),
    projectOptions: value.projectOptions.map((row) => ({ path: row.path, name: row.name, taskCount: row.taskCount, nativeCount: row.nativeCount, automationCount: row.automationCount, repository: row.repository, granted: row.granted })),
    tasks: value.tasks.map(task), candidates: value.candidates.map(task), briefs: value.briefs.map(brief), outputs: value.outputs.map(artifact), olderCount: value.olderCount, truncated: value.truncated, unavailableSources: value.unavailableSources };
}
export function mapPartnerWorkbenchDetail(value: contract.PartnerWorkbenchDetail | undefined): PartnerWorkbenchDetailView {
  if (value?.task === undefined) throw new Error("The workbench detail is unavailable.");
  return { task: task(value.task), transcript: value.transcript.map(text), truncated: value.truncated, artifacts: value.artifacts.map(artifact) };
}
function artifact(item: contract.PartnerWorkbenchArtifact): PartnerWorkbenchDetailView["artifacts"][number] {
  if (item.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The workbench file size is invalid.");
  return { id: item.id, title: item.title, mimeType: item.mimeType, byteSize: Number(item.byteSize), sessionId: item.sessionId };
}
