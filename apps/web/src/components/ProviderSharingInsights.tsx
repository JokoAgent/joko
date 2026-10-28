import { useEffect, useRef, useState, type JSX } from "react";
import { projectProviderSharingInsights, type ProviderSharingApi, type ProviderSharingInsights as Insights } from "@joko/contracts";
import { Button } from "./ui.js";

export function ProviderSharingInsights({ api, joinId, language, disabled }: {
  readonly api: ProviderSharingApi; readonly joinId: string; readonly language?: string; readonly disabled?: boolean;
}): JSX.Element {
  const zh = language?.startsWith("zh"), [open, setOpen] = useState(false), [usage, setUsage] = useState(false), [retry, setRetry] = useState(0);
  const [value, setValue] = useState<Insights>(), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current; setValue(undefined); setFailed(false);
    if (!open || disabled) { setLoading(false); return; }
    const owner = new AbortController(); setLoading(true);
    void api.insights(joinId, usage, owner.signal).then(response => {
      if (owner.signal.aborted || current !== sequence.current) return;
      if (!response.insights) throw new Error("Missing shared usage.");
      setValue(projectProviderSharingInsights(response.insights));
    }).catch(() => { if (!owner.signal.aborted && current === sequence.current) setFailed(true); })
      .finally(() => { if (!owner.signal.aborted && current === sequence.current) setLoading(false); });
    return () => { owner.abort(); sequence.current++; };
  }, [api, joinId, open, usage, retry, disabled]);
  const state = (name: string) => (zh ? { disabled: "分享者未开放", not_requested: "尚未请求", unavailable: "暂时不可用", offline: "离线", unsupported: "不支持", unlimited: "无限制", ready: "可用" }
    : { disabled: "Not shared", not_requested: "Not requested", unavailable: "Unavailable", offline: "Offline", unsupported: "Unsupported", unlimited: "Unlimited", ready: "Available" })[name as "ready"] ?? name;
  return <div className="provider-sharing-insights">
    <Button disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>{zh ? "额度与使用明细" : "Quota and usage details"}</Button>
    {open && <div>
      <Button disabled={loading || disabled} onClick={() => setRetry(value => value + 1)}>{zh ? "刷新明细" : "Refresh details"}</Button>
      <label><input type="checkbox" checked={usage} disabled={disabled} onChange={event => setUsage(event.target.checked)} />{zh ? "读取我最近 30 天的用量" : "Read my usage for the last 30 days"}</label>
      {loading && <p role="status">{zh ? "正在读取明细…" : "Loading details…"}</p>}
      {failed && <p role="alert">{zh ? "明细读取失败，可以重试。" : "Details could not be loaded. Retry to read them again."}</p>}
      {value && <>
        <p>{zh ? "额度" : "Quota"}: {state(value.quotaStatus)}{value.quotaPartial && (zh ? "（部分结果）" : " (partial)")}</p>
        {value.accounts.map((account, index) => <div key={index}><p>{zh ? `账户 ${index + 1}` : `Account ${index + 1}`}: {state(account.state)}</p>
          {[account.usage?.primaryWindow, account.usage?.secondaryWindow, ...(account.usage?.modelWindows.map(model => model.window) ?? [])].flatMap((window, i) => window ? [<p key={i}>
            {zh ? "剩余" : "Remaining"} {Math.max(0, 100 - window.usedPercent).toFixed(1)}%
            {window.windowMinutes !== undefined && ` · ${window.windowMinutes} min`}
            {window.resetAt && ` · ${new Date(Number(window.resetAt.seconds) * 1000).toLocaleString(language)}`}</p>] : [])}
        </div>)}
        <p>{zh ? "我的用量" : "My usage"}: {state(value.usageStatus)}{value.usagePartial && (zh ? "（部分结果）" : " (partial)")}</p>
        {value.usageStatus === "ready" && <>
          {value.coverageStart && <p>{zh ? "统计起日" : "Coverage starts"}: {value.coverageStart}</p>}
          {!value.days.length && <p>{zh ? "此范围没有已结算的用量。" : "No settled usage in this range."}</p>}
          {value.days.map((day, index) => <p key={index}>{day.day} · {day.modelId} · {day.turns.toString()} {zh ? "轮" : "turns"} · {day.tokensComplete ? `${day.inputTokens} / ${day.outputTokens} tokens` : zh ? "Token 用量不完整" : "Incomplete token usage"}
            {day.costComplete && day.currencyCode && ` · ${(Number(day.costMicros) / 1_000_000).toFixed(4)} ${day.currencyCode}`}{day.estimated && (zh ? "（估算）" : " (estimated)")}</p>)}
        </>}
      </>}
    </div>}
  </div>;
}
