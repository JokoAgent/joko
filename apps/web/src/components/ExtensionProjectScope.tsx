import { useEffect, useRef, useState, type JSX } from "react";
import { Folder, FolderUp, RefreshCcw } from "lucide-react";
import type { AppController } from "../controller.js";
import type { ExtensionProjectView, ExtensionProjectStateView, ProjectDirectoryListingView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl } from "./ui.js";

export function useExtensionProjectScope(controller: AppController) {
  const [projects, setProjects] = useState<readonly ExtensionProjectView[]>([]);
  const [project, setProject] = useState<ExtensionProjectView>();
  const [state, setState] = useState<ExtensionProjectStateView>();
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const source = useRef(controller); source.current = controller;
  useEffect(() => {
    const abort = new AbortController();
    if (typeof source.current.listExtensionProjects !== "function") return;
    void source.current.listExtensionProjects(abort.signal).then(value => {
      if (!abort.signal.aborted) { setProjects(value); setListError(undefined); }
    }).catch(cause => { if (!abort.signal.aborted) setListError(cause instanceof Error ? cause.message : String(cause)); });
    return () => abort.abort();
  }, [revision]);
  useEffect(() => {
    const abort = new AbortController();
    setState(undefined); setError(undefined);
    if (!project) { setLoading(false); return; }
    setLoading(true);
    void source.current.getExtensionProjectState(project.id, abort.signal).then(value => {
      if (!abort.signal.aborted && value.project.id === project.id) setState(value);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [project, revision]);
  return { project, projects, state, loading, error, listError,
    ready: project === undefined || !loading && error === undefined && state?.project.id === project.id,
    choose: (value: ExtensionProjectView | undefined) => { setState(undefined); setError(undefined); setProject(value); },
    refresh: () => setRevision(value => value + 1) };
}
export type ExtensionProjectScope = ReturnType<typeof useExtensionProjectScope>;

export function ExtensionProjectScopePicker({ scope, controller, disabled, t }: {
  readonly scope: ExtensionProjectScope; readonly controller: AppController; readonly disabled: boolean; readonly t: Translator;
}): JSX.Element {
  const [browse, setBrowse] = useState(false);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<ProjectDirectoryListingView>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const source = useRef(controller); source.current = controller;
  useEffect(() => () => { ++epoch.current; request.current?.abort(); }, []);
  const close = () => { ++epoch.current; request.current?.abort(); setBrowse(false); setPending(false); setListing(undefined); setError(undefined); };
  const load = (path: string) => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const attempt = ++epoch.current;
    setPending(true); setListing(undefined); setError(undefined); setPath(path);
    void source.current.listExtensionProjectDirectories(path, abort.signal).then(value => {
      if (!abort.signal.aborted && attempt === epoch.current) { setListing(value); setPath(value.path); }
    }).catch(cause => { if (!abort.signal.aborted && attempt === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!abort.signal.aborted && attempt === epoch.current) setPending(false); });
  };
  const chooseDirectory = () => {
    if (!listing || pending) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const attempt = ++epoch.current;
    setPending(true); setError(undefined);
    void source.current.resolveExtensionProject(listing.path, abort.signal).then(project => {
      if (!abort.signal.aborted && attempt === epoch.current) { scope.choose(project); close(); }
    }).catch(cause => { if (!abort.signal.aborted && attempt === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!abort.signal.aborted && attempt === epoch.current) setPending(false); });
  };
  const options = scope.project && !scope.projects.some(value => value.id === scope.project?.id) ? [...scope.projects, scope.project] : scope.projects;
  return <div className="extension-project-scope">
    <label><span>{t("extensions.project.scope")}</span><SelectControl aria-label={t("extensions.project.scope")} value={scope.project?.id ?? "global"} disabled={disabled}
      onChange={event => {
        if (event.target.value === "browse") { setBrowse(true); load(scope.project?.path ?? ""); }
        else scope.choose(options.find(project => project.id === event.target.value));
      }}>
      <option value="global">{t("extensions.project.global")}</option>
      {options.map(project => <option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}
      <option value="browse">{t("extensions.project.browse")}</option>
    </SelectControl></label>
    <p>{scope.project?.path ?? t("extensions.project.globalBody")}</p>
    {(scope.error || scope.listError) && <div role="alert"><span>{scope.error ?? scope.listError}</span><Button tone="ghost" disabled={disabled || scope.loading} onClick={scope.refresh}><RefreshCcw />{t("common.retry")}</Button></div>}
    {scope.project && !scope.ready && !scope.error && <p role="status">{t("extensions.project.loading")}</p>}
    <Modal open={browse} title={t("extensions.project.browse")} onClose={close}>
      <p>{t("extensions.project.browseBody")}</p>
      <form className="extension-project-browser__path" onSubmit={event => { event.preventDefault(); load(path); }}>
        <label><span>{t("extensions.project.path")}</span><input value={path} onChange={event => { ++epoch.current; request.current?.abort(); setPending(false); setPath(event.target.value); setListing(undefined); }} /></label><Button type="submit" disabled={pending}>{t("common.open")}</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {pending && <p role="status">{t("extensions.project.loading")}</p>}
      {listing && <div className="extension-project-browser__directories">
        {listing.parentPath !== listing.path && <Button tone="ghost" onClick={() => load(listing.parentPath)}><FolderUp />{t("extensions.project.parent")}</Button>}
        {listing.directories.map(directory => <Button tone="ghost" key={directory.path} onClick={() => load(directory.path)}><Folder />{directory.name}</Button>)}
        {listing.truncated && <p>{t("extensions.project.truncated")}</p>}
      </div>}
      <div className="modal__actions"><Button onClick={close}>{t("common.cancel")}</Button><Button tone="primary" disabled={pending || !listing} onClick={chooseDirectory}>{t("extensions.project.choose")}</Button></div>
    </Modal>
  </div>;
}
