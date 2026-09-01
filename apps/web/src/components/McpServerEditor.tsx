import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { CirclePlus, Trash2 } from "lucide-react";

import type {
  CredentialView,
  McpCredentialBindingView,
  McpEnvironmentVariableView,
  McpServerDraft,
  McpServerView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Modal, ModalBackButton, CheckboxControl, SelectControl } from "./ui.js";

export interface McpServerEditorProps {
  readonly server?: McpServerView;
  readonly credentials: readonly CredentialView[];
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSave: (draft: McpServerDraft) => Promise<void>;
  readonly onSaved: () => void;
}

export function McpServerEditor({ server, credentials, t, onClose, onSave, onSaved }: McpServerEditorProps): JSX.Element {
  const [draft, setDraft] = useState<McpServerDraft>(() => mcpServerDraft(server));
  const [argumentsText, setArgumentsText] = useState(() => formatMcpArguments(draft.arguments));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const requestEpochRef = useRef(0);
  const editing = server !== undefined;
  const argumentsResult = useMemo(() => parseMcpArguments(argumentsText), [argumentsText]);
  const valid = mcpServerDraftIsValid(draft, argumentsResult);

  useEffect(() => () => { requestEpochRef.current += 1; }, []);

  const close = (): void => {
    requestEpochRef.current += 1;
    onClose();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid || (draft.transport === "stdio" && !argumentsResult.ok) || saving) return;
    const epoch = ++requestEpochRef.current;
    setSaving(true);
    setError(undefined);
    void onSave({
      ...draft,
      arguments: argumentsResult.ok ? argumentsResult.value : draft.arguments
    }).then(() => {
      if (requestEpochRef.current === epoch) onSaved();
    }).catch((cause: unknown) => {
      if (requestEpochRef.current === epoch) setError(messageOf(cause, t("settings.mcpSaveFailed")));
    }).finally(() => {
      if (requestEpochRef.current === epoch) setSaving(false);
    });
  };
  const setTransport = (transport: McpServerDraft["transport"]): void => {
    setDraft((current) => ({
      ...current,
      transport,
      credentialBindings: current.credentialBindings.map((binding) => ({
        ...binding,
        target: transport === "stdio" ? "environment" : "header"
      }))
    }));
  };

  return <Modal
    open
    title={editing ? t("settings.editMcp", { name: server.name }) : t("settings.addMcp")}
    description={t("settings.mcpEditorBody")}
    size="large"
    onClose={close}
    headerLeading={<ModalBackButton label={t("common.back")} onClick={close} />}
    dismissOnBackdrop={!saving}
  >
    <form className="settings-form" aria-busy={saving} onSubmit={submit}>
      {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
      <div className="settings-form__grid">
        <label className="field"><span>{t("settings.serverId")}</span><input
          disabled={editing || saving}
          value={draft.id}
          onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
          placeholder={t("common.generated")}
        /></label>
        <label className="field"><span>{t("settings.displayName")}</span><input
          required
          disabled={saving}
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        /></label>
        <label className="field"><span>{t("settings.transport")}</span><SelectControl
          disabled={saving}
          value={draft.transport}
          onChange={(event) => setTransport(event.target.value as McpServerDraft["transport"])}
        ><option value="https">HTTPS Streamable HTTP</option><option value="stdio">Stdio</option></SelectControl></label>
        {draft.transport === "https" ? <label className="field"><span>{t("settings.endpoint")}</span><input
          type="url"
          required
          disabled={saving}
          value={draft.endpoint}
          onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
          placeholder="https://mcp.example.com"
        /></label> : <>
          <label className="field"><span>{t("settings.command")}</span><input
            required
            disabled={saving}
            value={draft.command}
            onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
          /></label>
          <label className="field"><span>{t("settings.workingDirectory")}</span><input
            disabled={saving}
            value={draft.workingDirectory}
            onChange={(event) => setDraft((current) => ({ ...current, workingDirectory: event.target.value }))}
          /></label>
          <label className="field settings-form__wide"><span>{t("settings.argumentsJson")}</span><input
            disabled={saving}
            value={argumentsText}
            aria-invalid={!argumentsResult.ok}
            onChange={(event) => setArgumentsText(event.target.value)}
            placeholder={'["--flag", "value"]'}
          />{!argumentsResult.ok && <small className="danger-text">{t("settings.invalidArguments")}</small>}</label>
        </>}
      </div>

      {draft.transport === "stdio" && <fieldset className="provider-editor__section">
        <legend>{t("settings.nonSecretEnvironment")}</legend>
        {draft.environment.map((variable, index) => <EnvironmentRow
          key={`environment:${index}`}
          variable={variable}
          disabled={saving}
          t={t}
          onChange={(next) => setDraft((current) => ({
            ...current,
            environment: current.environment.map((item, position) => position === index ? next : item)
          }))}
          onRemove={() => setDraft((current) => ({
            ...current,
            environment: current.environment.filter((_, position) => position !== index)
          }))}
        />)}
        <Button disabled={saving} onClick={() => setDraft((current) => ({
          ...current,
          environment: [...current.environment, { name: "", value: "" }]
        }))}><CirclePlus aria-hidden="true" />{t("settings.addEnvironmentVariable")}</Button>
      </fieldset>}

      <fieldset className="provider-editor__section">
        <legend>{t("settings.credentialBindings")}</legend>
        {draft.credentialBindings.map((binding, index) => <CredentialBindingRow
          key={`binding:${index}`}
          binding={binding}
          credentials={credentials}
          disabled={saving}
          t={t}
          onChange={(next) => setDraft((current) => ({
            ...current,
            credentialBindings: current.credentialBindings.map((item, position) => position === index ? next : item)
          }))}
          onRemove={() => setDraft((current) => ({
            ...current,
            credentialBindings: current.credentialBindings.filter((_, position) => position !== index)
          }))}
        />)}
        <Button disabled={saving} onClick={() => setDraft((current) => ({
          ...current,
          credentialBindings: [...current.credentialBindings, {
            credentialId: "",
            target: current.transport === "stdio" ? "environment" : "header",
            name: current.transport === "stdio" ? "MCP_TOKEN" : "Authorization"
          }]
        }))}><CirclePlus aria-hidden="true" />{t("settings.addCredentialBinding")}</Button>
      </fieldset>

      <div className="settings-form__toggles"><label><CheckboxControl
        disabled={saving}
        checked={draft.enabled}
        onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
      />{t("common.enabled")}</label></div>
      <div className="modal__actions"><Button
        type="submit"
        tone="primary"
        disabled={!valid || saving}
      >{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function CredentialBindingRow({ binding, credentials, disabled, t, onChange, onRemove }: {
  readonly binding: Omit<McpCredentialBindingView, "configured">;
  readonly credentials: readonly CredentialView[];
  readonly disabled: boolean;
  readonly t: Translator;
  readonly onChange: (binding: Omit<McpCredentialBindingView, "configured">) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const known = credentials.some((credential) => credential.id === binding.credentialId);
  return <div className="provider-binding-row">
    <label className="field"><span>{t("settings.injectionTarget")}</span><SelectControl disabled value={binding.target}>
      <option value="header">Header</option><option value="environment">{t("settings.environment")}</option>
    </SelectControl></label>
    <label className="field"><span>{binding.target === "header" ? t("settings.headerName") : t("settings.environmentName")}</span><input
      required
      disabled={disabled}
      value={binding.name}
      onChange={(event) => onChange({ ...binding, name: event.target.value })}
      placeholder={binding.target === "header" ? "Authorization" : "MCP_TOKEN"}
    /></label>
    <label className="field"><span>{t("settings.credentialReference")}</span><SelectControl
      required
      disabled={disabled}
      value={binding.credentialId}
      onChange={(event) => onChange({ ...binding, credentialId: event.target.value })}
    ><option value="">{t("common.none")}</option>{!known && binding.credentialId.length > 0 && <option value={binding.credentialId}>{binding.credentialId} · {t("settings.missing")}</option>}{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name}{credential.configured ? "" : ` · ${t("settings.missing")}`}</option>)}</SelectControl></label>
    <IconButton disabled={disabled} label={t("common.remove")} onClick={onRemove}><Trash2 aria-hidden="true" /></IconButton>
  </div>;
}

function EnvironmentRow({ variable, disabled, t, onChange, onRemove }: {
  readonly variable: McpEnvironmentVariableView;
  readonly disabled: boolean;
  readonly t: Translator;
  readonly onChange: (variable: McpEnvironmentVariableView) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  return <div className="provider-binding-row">
    <label className="field"><span>{t("settings.environmentName")}</span><input required disabled={disabled} value={variable.name} onChange={(event) => onChange({ ...variable, name: event.target.value })} /></label>
    <label className="field"><span>{t("settings.nonSecretValue")}</span><input disabled={disabled} value={variable.value} onChange={(event) => onChange({ ...variable, value: event.target.value })} /></label>
    <span />
    <IconButton disabled={disabled} label={t("common.remove")} onClick={onRemove}><Trash2 aria-hidden="true" /></IconButton>
  </div>;
}

export function mcpServerDraft(server?: McpServerView): McpServerDraft {
  return {
    id: server?.id ?? "",
    revision: server?.revision ?? 0n,
    name: server?.name ?? "",
    transport: server?.transport === "stdio" ? "stdio" : "https",
    endpoint: server?.endpoint ?? "",
    command: server?.command ?? "",
    arguments: [...(server?.arguments ?? [])],
    workingDirectory: server?.workingDirectory ?? "",
    environment: (server?.environment ?? []).map((variable) => ({ ...variable })),
    credentialBindings: (server?.credentialBindings ?? []).map((binding) => ({
      credentialId: binding.credentialId,
      target: binding.target,
      name: binding.name
    })),
    enabled: server?.enabled ?? true
  };
}

export type McpArgumentsResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false };

export function parseMcpArguments(value: string): McpArgumentsResult {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? { ok: true, value: parsed }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function formatMcpArguments(arguments_: readonly string[]): string {
  return JSON.stringify(arguments_);
}

export function mcpServerDraftIsValid(draft: McpServerDraft, argumentsResult: McpArgumentsResult): boolean {
  if (draft.name.trim().length === 0 || (draft.transport === "stdio" && !argumentsResult.ok)) return false;
  if (draft.transport === "https" ? draft.endpoint.trim().length === 0 : draft.command.trim().length === 0) return false;
  const bindingTargets = new Set<string>();
  for (const binding of draft.credentialBindings) {
    if (binding.credentialId.trim().length === 0 || binding.name.trim().length === 0) return false;
    if (binding.target !== (draft.transport === "stdio" ? "environment" : "header")) return false;
    const target = `${binding.target}:${binding.name.trim().toLocaleLowerCase("en-US")}`;
    if (bindingTargets.has(target)) return false;
    bindingTargets.add(target);
  }
  if (draft.transport === "stdio") {
    const environmentNames = new Set<string>();
    for (const variable of draft.environment) {
      if (variable.name.trim().length === 0) return false;
      const name = variable.name.trim().toLocaleLowerCase("en-US");
      if (environmentNames.has(name)) return false;
      environmentNames.add(name);
    }
  }
  return true;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
