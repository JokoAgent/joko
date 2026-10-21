import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PartnerImportStatus, PartnerImportCheckStatus, partnerImportMessages, importReasonLabel, type PartnerPackageEntry, type PartnerImportResult } from "@joko/contracts";
import { ArrowLeft, BookOpen, Layers, Plug, Repeat2 } from "lucide-react";
import type { AppController } from "../controller.js";
import { Button, Modal, Spinner } from "./ui.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import "./partner-discovery.css";

export const partnerDiscoveryTitle = (locale: string): string => locale.startsWith("zh") ? "发现伙伴" : "Discover partners";

export function PartnerDiscoveryDialog({ controller, ownerKey, foreground, onClose, onCreated }: {
  readonly controller: AppController; readonly ownerKey: string; readonly foreground: boolean;
  readonly onClose: () => void; readonly onCreated: (result: PartnerImportResult) => void;
}) {
  const locale = controller.state.effectiveLocale;
  const zh = locale.startsWith("zh");
  const messages = partnerImportMessages(locale);
  const failure = (cause: unknown) => {
    const value = cause instanceof Error ? cause.message : "";
    if (value.includes("IMPORT_MODEL_SETTINGS_REQUIRED")) return zh ? "请先在伙伴默认设置中选择可用模型，再邀请伙伴。" : "Choose an available model in Partner defaults, then invite a partner.";
    return importReasonLabel(value, messages);
  };
  const api = useMemo(() => controller.partnerImportApi(ownerKey), [ownerKey]);
  const [entries, setEntries] = useState<readonly PartnerPackageEntry[]>();
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, refresh] = useState(0);
  const heading = useRef<HTMLDivElement>(null);
  const scrollRoot = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  const current = useRef(true);
  const operation = useRef(false);
  const abort = useRef(new AbortController());
  useEffect(() => { current.current = true; abort.current = new AbortController(); return () => { current.current = false; abort.current.abort(); }; }, []);
  useEffect(() => {
    if (!foreground) return;
    const read = new AbortController(); let active = true; setError(undefined);
    void api.packages?.(locale, read.signal).then(rows => { if (active) setEntries(rows); }).catch(cause => {
      if (active && !read.signal.aborted) setError(failure(cause));
    });
    return () => { active = false; read.abort(); };
  }, [api, locale, foreground, revision]);
  const entry = entries?.find(row => row.packageId === selected);
  useLayoutEffect(() => {
    setCompact(false);
    const element = heading.current;
    const body = element?.closest<HTMLElement>(".modal__body") ?? scrollRoot.current;
    scrollRoot.current = body;
    if (body) body.scrollTop = 0;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(records => setCompact(records[0]?.isIntersecting === false), { root: body, threshold: 0 });
    observer.observe(element); return () => observer.disconnect();
  }, [selected]);
  const updateResult = (id: string, result: PartnerImportResult) => setEntries(rows => rows?.map(row => row.packageId === id ? { ...row, installation: result } : row));
  const invite = async (item: PartnerPackageEntry) => {
    if (operation.current || !foreground || !api.invitePackage) return;
    operation.current = true; setPending(item.packageId); setError(undefined);
    try {
      let result = await api.invitePackage(item, locale, abort.current.signal);
      if (!current.current) return; updateResult(item.packageId, result);
      while (result.status === PartnerImportStatus.RUNNING) {
        await new Promise<void>(resolve => {
          const signal = abort.current.signal;
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
          const timer = window.setTimeout(finish, 600); signal.addEventListener("abort", finish, { once: true });
        });
        abort.current.signal.throwIfAborted();
        const next = await api.status(result.requestId, abort.current.signal);
        if (!next) throw new Error(zh ? "保存结果尚未返回，请刷新查看。" : "The save receipt is unavailable. Refresh to check it.");
        result = next; if (!current.current) return; updateResult(item.packageId, result);
      }
      if (result.saved && result.status === PartnerImportStatus.COMPLETE) onCreated(result);
      else setSelected(item.packageId);
    } catch (cause) {
      if (current.current && !abort.current.signal.aborted) setError(failure(cause));
    } finally { operation.current = false; if (current.current) setPending(undefined); }
  };
  const action = (item: PartnerPackageEntry, primary = false) => <Button tone={primary ? "primary" : undefined} disabled={!foreground || pending !== undefined}
    onClick={() => { if (item.installation?.saved) onCreated(item.installation); else void invite(item); }}>
    {pending === item.packageId ? <Spinner /> : null}{item.installation?.saved ? zh ? "打开伙伴" : "Open partner" : zh ? "邀请加入" : "Invite"}</Button>;
  const modules = (title: string, rows: readonly { name: string; description: string }[], icon: ReactNode, paused = false) => rows.length > 0 && <section className="partner-discovery__module">
    <h3>{icon}{title}</h3><div>{rows.map(row => <article key={row.name}><div><strong>{row.name}</strong><p>{row.description}</p></div>{paused && <span>{zh ? "默认关闭" : "Off by default"}</span>}</article>)}</div></section>;
  const failed = entry?.installation?.checks.filter(check => check.status === PartnerImportCheckStatus.NEEDS_ATTENTION);
  return <Modal open title={partnerDiscoveryTitle(locale)} showClose size="large" className="partner-discovery" onClose={onClose}>
    {error && <p role="alert">{error}<Button disabled={pending !== undefined} onClick={() => refresh(value => value + 1)}>{zh ? "重新加载" : "Reload"}</Button></p>}
    {!entries ? <p role="status"><Spinner />{zh ? "正在读取伙伴…" : "Loading partners…"}</p> : entry ? <>
      <div className="partner-discovery__back"><Button onClick={() => setSelected(undefined)}><ArrowLeft aria-hidden="true" />{zh ? "返回列表" : "Back to list"}</Button>
        {compact && <div className="partner-discovery__compact"><PartnerAvatar preset={entry.avatar} /><strong>{entry.name}</strong>{action(entry)}</div>}</div>
      <div className="partner-discovery__identity" ref={heading}><PartnerAvatar preset={entry.avatar} /><h2>{entry.name}</h2>{action(entry, true)}</div>
      <button type="button" className="partner-discovery__bubble" disabled={!foreground || pending !== undefined}
        onClick={() => { if (entry.installation?.saved) onCreated(entry.installation); else void invite(entry); }}>{entry.bubble}<span aria-hidden="true">↗</span></button>
      <ul className="partner-discovery__capabilities">{entry.capabilities.map(capability => <li key={capability.label}>{capability.label}</li>)}</ul>
      <h2 className="partner-discovery__working">{zh ? "一起工作的方式" : "How you work together"}</h2>
      {modules(zh ? "技能" : "Skills", entry.skills, <Layers aria-hidden="true" />)}
      {(entry.knowledge.length > 0 || entry.remembers.length > 0) && <section className="partner-discovery__module"><h3><BookOpen aria-hidden="true" />{zh ? "知识与记忆" : "Knowledge and memory"}</h3>
        <div>{entry.knowledge.map(row => <article key={row.name}><div><strong>{row.name}</strong><p>{row.description}</p></div></article>)}
        {entry.remembers.length > 0 && <article className="partner-discovery__memory"><strong>{zh ? "会记住你的" : "Remembers your"}</strong><ul>{entry.remembers.map(item => <li key={item}>{item}</li>)}</ul></article>}</div></section>}
      {entry.tools.length > 0 && <section className="partner-discovery__module"><h3><Plug aria-hidden="true" />{zh ? "工作工具" : "Work tools"}</h3><div>{entry.tools.map(tool => {
        const installed = controller.state.snapshot?.extensions.find(extension => extension.id === tool.id && extension.installed);
        const name = installed?.name ?? ({ "google-gmail": "Gmail", gitlab: "GitLab", "web-search": "Web Search", "opendesign-trial": "OpenDesign", art: "Art", "google-sheets": "Google Sheets" } as Record<string, string>)[tool.id] ?? tool.id;
        return <article key={tool.id}><div><strong>{name}</strong><p>{tool.purpose}</p></div><span>{installed ? zh ? "已安装" : "Installed" : controller.state.snapshot?.extensionCatalogRecovered ? zh ? "未安装" : "Not installed" : ""}</span></article>;
      })}</div></section>}
      {modules(zh ? "例行任务" : "Routines", entry.routines, <Repeat2 aria-hidden="true" />, true)}
      {!!failed?.length && <section role="status"><p>{zh ? "以下内容尚未保存完成：" : "These items still need attention:"}</p><ul>{failed.map(check => <li key={check.entryId}>{check.name ?? check.entryId} · {importReasonLabel(check.message, messages)}</li>)}</ul>
        <Button disabled={pending !== undefined || !foreground} onClick={() => void invite(entry)}>{zh ? "重新保存" : "Retry save"}</Button></section>}
    </> : <div className="partner-discovery__list">{entries.map(item => <article key={item.packageId}><PartnerAvatar preset={item.avatar} /><div><button type="button" className="partner-discovery__name" onClick={() => setSelected(item.packageId)}>{item.name}</button><p>{item.description}</p></div>{action(item)}</article>)}</div>}
  </Modal>;
}
