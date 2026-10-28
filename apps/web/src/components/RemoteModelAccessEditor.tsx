import { useId, useState, type JSX } from "react";
import { Button } from "./ui.js";
import "./provider-sharing.css";

export interface RemoteModelAccessEditorProps {
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly selected: readonly string[] | undefined;
  readonly providerSelected?: readonly string[];
  readonly member?: boolean;
  readonly disabled?: boolean;
  readonly language?: string;
  readonly onSave: (models: readonly string[] | undefined) => Promise<void>;
}

export function RemoteModelAccessEditor({ models, selected, providerSelected, member, disabled, language, onSave }: RemoteModelAccessEditorProps): JSX.Element {
  const zh = language?.startsWith("zh"), id = useId();
  const [draft, setDraft] = useState<readonly string[] | undefined>(selected), [search, setSearch] = useState("");
  const available = [...models, ...(draft ?? []).filter(id => !models.some(model => model.id === id)).map(id => ({ id, name: id }))];
  const allowed = (id: string) => !member || providerSelected === undefined || providerSelected.includes(id);
  const rows = available.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
  const changed = JSON.stringify(draft) !== JSON.stringify(selected);
  return <details className="remote-model-access"><summary>{zh ? "模型访问权限" : "Model access"}</summary>
    <p>{member ? zh ? "此成员可用的模型还受供应方的选择限制。" : "This member can use the intersection with the Provider's selection."
      : zh ? "限制所有远端调用及分享成员可用的模型。" : "Choose models available to remote calls and shared members."}</p>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && changed) void onSave(draft); }}>
      <label><input type="checkbox" checked={draft === undefined} disabled={disabled} onChange={event => setDraft(event.target.checked ? undefined : [])} />
        {member ? zh ? "继承供应方选择" : "Inherit Provider selection" : zh ? "所有当前及未来模型" : "All current and future models"}</label>
      <label htmlFor={`${id}-search`}>{zh ? "搜索模型" : "Search models"}</label>
      <input id={`${id}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} disabled={disabled} />
      <div className="remote-model-access__models">
        {rows.map(model => { const checked = draft === undefined ? allowed(model.id) : draft.includes(model.id);
          return <label key={model.id}><input type="checkbox" checked={checked} disabled={disabled || !allowed(model.id) && !checked} onChange={event => {
            const current = draft ?? models.filter(model => allowed(model.id)).map(model => model.id);
            setDraft(event.target.checked ? [...new Set([...current, model.id])] : current.filter(id => id !== model.id));
          }} /><span>{model.name}{model.name !== model.id && <small>{model.id}</small>}</span>
            {!allowed(model.id) && <small>{zh ? "供应方未开放" : "Not shared by Provider"}</small>}</label>;
        })}
        {!rows.length && <p role="status">{zh ? "没有匹配的模型" : "No matching models"}</p>}
      </div>
      {draft?.length === 0 && <p>{zh ? "当前选择不允许使用任何模型。" : "The current selection allows no models."}</p>}
      <Button type="submit" disabled={disabled || !changed}>{zh ? "保存模型权限" : "Save model access"}</Button>
    </form>
  </details>;
}
