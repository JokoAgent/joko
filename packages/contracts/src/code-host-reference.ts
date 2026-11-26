import type { CodeHostPullRequestReference } from "./gen/joko/v1/code_host_pb.js";

export function isValidCodeHostPullRequestReference(
  reference: CodeHostPullRequestReference,
  number = Number(reference.number)
): boolean {
  const repositoryPart = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
  return !(
    reference.host.length === 0
    || reference.host.length > 255
    || reference.host !== reference.host.toLocaleLowerCase("en-US")
    || /[\u0000-\u0020\u007f]/u.test(reference.host)
    || !reference.repositoryOwner.split("/").every(part => repositoryPart.test(part))
    || !repositoryPart.test(reference.repositoryName)
    || !Number.isSafeInteger(number)
    || number <= 0
    || number > 2_147_483_647
    || reference.referenceKey !== `${reference.host}/${reference.repositoryOwner}/${reference.repositoryName}#${number}`
    || !isCanonicalCodeHostPullRequestWebUrl(reference.webUrl, reference.host, reference.repositoryOwner, reference.repositoryName, number)
  );
}

function isCanonicalCodeHostPullRequestWebUrl(
  value: string,
  host: string,
  repositoryOwner: string,
  repositoryName: string,
  number: number
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.href !== value
    || url.protocol !== "https:"
    || url.host !== host
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) return false;
  const owner = repositoryOwner.split("/").map(encodeURIComponent).join("/");
  const repository = encodeURIComponent(repositoryName);
  return !repositoryOwner.includes("/") && url.pathname === `/${owner}/${repository}/pull/${number}`
    || host !== "github.com" && /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/iu.test(host)
      && url.pathname === `/${owner}/${repository}/-/merge_requests/${number}`;
}
