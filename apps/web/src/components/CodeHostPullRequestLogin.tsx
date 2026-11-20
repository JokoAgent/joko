import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import type { CodeHostPullRequestView } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import { CodeHostPullRequestSummary } from "./CodeHostPullRequestSummary.js";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export type CodeHostLoginOwner = Omit<JokoDesktopCodeHostLoginScope, "scopeId" | "referenceKey"> & {
  readonly connectionGeneration?: number;
};

interface PullRequestHeaderProps {
  readonly pullRequests?: readonly CodeHostPullRequestView[];
  readonly t: Translator;
  readonly onOpen?: (url: string) => void;
}

const GITHUB_DEVICE_PAGE = "https://github.com/login/device";

export function CodeHostTaskPullRequest({ owner, ...props }: PullRequestHeaderProps & { readonly owner?: CodeHostLoginOwner }): JSX.Element | null {
  const first = props.pullRequests?.[0];
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (owner === undefined || first?.host !== "github.com" || desktop?.codeHostLogin === undefined) {
    return <CodeHostPullRequestSummary {...props} />;
  }
  const key = JSON.stringify([owner.profileId, owner.serverId, owner.connectionGeneration, owner.sessionId,
    owner.targetId, owner.generation.toString(), first.key, first.webUrl]);
  return <LocalPullRequestLogin key={key} {...props} owner={owner} first={first} api={desktop.codeHostLogin} openExternal={desktop.openExternal} />;
}

function LocalPullRequestLogin({ owner, first, api, openExternal, t, ...props }: PullRequestHeaderProps & {
  readonly owner: CodeHostLoginOwner;
  readonly first: CodeHostPullRequestView;
  readonly api: JokoDesktopCodeHostLogin;
  readonly openExternal: (url: string) => Promise<void>;
}): JSX.Element {
  const { profileId, serverId, sessionId, targetId, generation } = owner;
  const [scopeId] = useState(() => randomUuid());
  const scope = useMemo(() => ({ profileId, serverId, scopeId, sessionId, targetId, generation, referenceKey: first.key }),
    [profileId, serverId, scopeId, sessionId, targetId, generation, first.key]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<JokoDesktopCodeHostLoginState>({ phase: "unavailable" });
  const [notice, setNotice] = useState<string>();
  const action = useRef(0);
  const busy = state.phase === "starting" || state.phase === "authorizing";
  const observed = first.projection !== undefined;

  useLayoutEffect(() => () => {
    action.current += 1;
    void api.cancel(scope).catch(() => undefined);
  }, [api, scope]);

  useEffect(() => {
    if (open ? !busy : observed) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = open ? 400 : 30_000;
    const read = async (): Promise<void> => {
      const next = await api.status(scope).catch((): JokoDesktopCodeHostLoginState => ({ phase: open ? "failed" : "unavailable" }));
      if (!current) return;
      setState(open && (next.phase === "ready" || next.phase === "unavailable") ? { phase: "failed" } : next);
      timer = setTimeout(() => { void read(); }, interval);
    };
    if (open) timer = setTimeout(() => { void read(); }, interval);
    else void read();
    return () => { current = false; clearTimeout(timer); };
  }, [api, scope, open, busy, observed]);

  const close = (): void => {
    action.current += 1;
    void api.cancel(scope).catch(() => undefined);
    setState({ phase: "unavailable" });
    setNotice(undefined);
    setOpen(false);
  };

  const start = (): void => {
    if (busy) return;
    const intent = ++action.current;
    setNotice(undefined);
    setState({ phase: "starting" });
    void api.start(scope).then(next => {
      if (action.current === intent) setState(next);
    }, () => {
      if (action.current === intent) setState({ phase: "failed" });
    });
  };

  const showNotice = (operation: () => Promise<void>, success: string | undefined, failure: string): void => {
    const intent = action.current;
    void Promise.resolve().then(operation).then(() => {
      if (action.current === intent) setNotice(success);
    }, () => {
      if (action.current === intent) setNotice(failure);
    });
  };

  const code = state.phase === "authorizing" ? state.code : undefined;
  return <>
    <CodeHostPullRequestSummary {...props} t={t} onSignIn={!observed && state.phase === "ready" ? () => setOpen(true) : undefined} />
    <Modal open={open} onClose={close} title={t("codeHost.signInTitle")} size="small">
      {state.phase === "ready" && <p>{t("codeHost.signInReason")}</p>}
      {state.phase === "starting" && <p role="status">{t("codeHost.signInStarting")}</p>}
      {code !== undefined && <>
        <p>{t("codeHost.signInDeviceHelp")}</p>
        <code className="code-host-sign-in-code">{code}</code>
        <div className="modal__actions">
          <Button onClick={() => showNotice(() => navigator.clipboard.writeText(code), t("inputHandoff.codeCopied"), t("inputHandoff.copyFailed"))}>{t("inputHandoff.copyCode")}</Button>
          <Button tone="primary" onClick={() => showNotice(() => openExternal(GITHUB_DEVICE_PAGE), undefined, t("codeHost.signInPageFailed"))}>{t("inputHandoff.openLogin")}</Button>
        </div>
      </>}
      {state.phase === "connected" && <p role="status">{t("codeHost.signInConnected")}</p>}
      {state.phase === "failed" && <p role="alert">{t("codeHost.signInFailed")}</p>}
      {notice !== undefined && <p role="status">{notice}</p>}
      <div className="modal__actions">
        {state.phase === "ready" && props.onOpen !== undefined && <Button tone="ghost" onClick={() => { close(); props.onOpen?.(first.webUrl); }}>{t("codeHost.viewPullRequest")}</Button>}
        <Button onClick={close}>{t(busy ? "common.cancel" : "common.close")}</Button>
        {state.phase === "ready" && <Button tone="primary" onClick={start}>{t("codeHost.signInStart")}</Button>}
        {state.phase === "failed" && <Button tone="primary" onClick={start}>{t("common.retry")}</Button>}
      </div>
    </Modal>
  </>;
}
