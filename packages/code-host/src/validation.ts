import {
  CODE_HOST_PULL_REQUEST_HEAD_BRANCH_MAX_LENGTH,
  CODE_HOST_PULL_REQUEST_TITLE_MAX_LENGTH
} from "./types.js";

const UNSAFE_DISPLAY_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UNSAFE_REF_CHARACTER = /[\u0000-\u0020\u007f~^:?*[\\]/u;

export function boundedCodeHostPullRequestTitle(value: unknown): string | undefined {
  return boundedDisplayText(value, CODE_HOST_PULL_REQUEST_TITLE_MAX_LENGTH);
}

export function boundedCodeHostHeadBranch(value: unknown): string | undefined {
  const branch = boundedDisplayText(value, CODE_HOST_PULL_REQUEST_HEAD_BRANCH_MAX_LENGTH);
  if (
    branch === undefined
    || UNSAFE_REF_CHARACTER.test(branch)
    || branch === "@"
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) return undefined;
  return branch;
}

function boundedDisplayText(value: unknown, maximumLength: number): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || UNSAFE_DISPLAY_CHARACTER.test(value)
  ) return undefined;
  return value;
}
