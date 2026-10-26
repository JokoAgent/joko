/** Private, surface-scoped DOM media/navigation bridge. It cannot fetch, open
 * sockets, choose another node or grant access to an application endpoint. */
export function extensionSourceSet(value: string): Array<{ url: string; descriptor: string }> {
  const result: Array<{ url: string; descriptor: string }> = []; let offset = 0;
  while (offset < value.length) {
    while (offset < value.length && /[\t\n\f\r ,]/u.test(value[offset]!)) offset++;
    const start = offset; while (offset < value.length && !/[\t\n\f\r ]/u.test(value[offset]!)) offset++;
    let url = value.slice(start, offset), descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/u, "");
    else { const begin = offset; while (offset < value.length && value[offset] !== ",") offset++; descriptor = value.slice(begin, offset).trim(); offset++; }
    if (url) result.push({ url, descriptor });
  }
  return result;
}

function installExtensionResources(sourceSet: typeof extensionSourceSet): void {
  const host = window as typeof window & { ReactNativeWebView?: { postMessage(value: string): void } };
  const base = Reflect.get(globalThis, Symbol.for("joko.extension.surface.base"));
  if (typeof base !== "string") return;
  const baseUrl = new URL(base);
  const rootMatch = /^(\/v1\/extensions\/main-views\/extension_surface_[a-f0-9]{32}\/[a-f0-9]{64}\/)/u.exec(baseUrl.pathname);
  if (rootMatch === null) return;
  const native = parent === window && host.ReactNativeWebView !== undefined;
  const documentId = Reflect.get(globalThis, Symbol.for("joko.extension.surface.document"));
  if (native && typeof documentId !== "string") return;
  const expectedParent = location.protocol + "//" + location.host;
  const pending = new Map<string, (value: { ok: boolean; blob?: Blob; dataUrl?: string }) => void>();
  const sources = new WeakMap<Element, Map<string, { raw: string; revision: number; objectUrls?: Set<string>; applied?: string }>>();
  const urls = new Set<string>();
  let sequence = 0;
  const resolve = (value: string, from: string | URL = baseUrl): URL | undefined => {
    try {
      const url = new URL(value, new URL(from, baseUrl));
      if (url.origin === baseUrl.origin && url.username === "" && url.password === "" && url.search === "" && url.pathname.startsWith(rootMatch[1]!)) return url;
    } catch { /* Invalid references keep the original element's failure state. */ }
    return undefined;
  };
  const post = (message: unknown) => native ? host.ReactNativeWebView!.postMessage(JSON.stringify(message)) : parent.postMessage(message, "*");
  const request = (kind: "media" | "navigate" | "script" | "module" | "style" | "style-text", url: URL, apply?: (value: { ok: boolean; blob?: Blob; dataUrl?: string }) => void, text?: string) => {
    const id = `resource_${++sequence}`;
    if (apply !== undefined) { if (pending.size >= 64) { apply({ ok: false }); return; } pending.set(id, apply); }
    post({ type: "joko:extension-resource", version: 1, id, kind, url: url.href,
      ...(native ? { documentId } : {}), ...(text === undefined ? {} : { text }) });
  };
  const receive = (event: MessageEvent) => {
    if (!native && (event.source !== parent || event.origin !== expectedParent)) return;
    let value: unknown = event.data;
    if (native && typeof value === "string") try { value = JSON.parse(value); } catch { return; }
    if (value === null || typeof value !== "object") return;
    const message = value as { type?: string; version?: number; id?: string; ok?: boolean; blob?: Blob; dataUrl?: string; documentId?: string };
    if (message.type !== "joko:extension-resource-result" || message.version !== 1 || typeof message.id !== "string" || native && message.documentId !== documentId) return;
    const apply = pending.get(message.id); if (apply === undefined) return;
    pending.delete(message.id); apply({ ok: message.ok === true, blob: message.blob, dataUrl: message.dataUrl });
  };
  addEventListener("message", receive); if (native) document.addEventListener("message", receive as EventListener);
  const originalSet = Element.prototype.setAttribute, originalGet = Element.prototype.getAttribute;
  const watched = (element: Element, name: string): boolean => name === "src" && ["IMG", "AUDIO", "VIDEO", "SOURCE", "INPUT", "SCRIPT"].includes(element.tagName)
    || name === "poster" && element.tagName === "VIDEO" || name === "srcset" && ["IMG", "SOURCE"].includes(element.tagName)
    || name === "href" && element.tagName === "LINK" && ["", "stylesheet"].includes(originalGet.call(element, "rel") ?? "");
  const code = (kind: "script" | "module" | "style" | "style-text", url: URL, text?: string): Promise<string> => new Promise((finish, reject) => request(kind, url, result => {
    if (!result.ok || typeof result.dataUrl !== "string" || !/^data:(?:text\/(?:javascript|css)|application\/javascript)(?:;[^,]*)?;base64,/iu.test(result.dataUrl)) reject(new Error("Surface code is unavailable."));
    else finish(result.dataUrl);
  }, text));
  const imported = new Map<string, Promise<unknown>>();
  Reflect.set(globalThis, Symbol.for("joko.extension.surface.import"), (from: string, value: string, options?: { with?: { type?: string } }) => {
    const url = resolve(String(value), from); if (url === undefined) return Promise.reject(new TypeError("Module is outside its surface."));
    if (options?.with?.type !== undefined && options.with.type !== "json" || options?.with?.type === "json" && !url.pathname.endsWith(".json")) return Promise.reject(new TypeError("Module type does not match its resource."));
    let loading = imported.get(url.href);
    if (loading === undefined) { loading = code("module", url).then(dataUrl => import(dataUrl + url.hash)); imported.set(url.href, loading); }
    return loading;
  });
  const set = (element: Element, name: string, raw: string, apply: (value: string) => void): void => {
    let entries = sources.get(element); if (entries === undefined) { entries = new Map(); sources.set(element, entries); }
    const previous = entries.get(name), entry = { raw, revision: (previous?.revision ?? 0) + 1, objectUrls: previous?.objectUrls, applied: previous?.applied };
    const created = new Set<string>();
    const release = (values: Set<string> | undefined) => { for (const value of values ?? []) { URL.revokeObjectURL(value); urls.delete(value); } };
    entries.set(name, entry);
    const current = () => sources.get(element)?.get(name) === entry;
    const kind = element.tagName === "SCRIPT" ? originalGet.call(element, "type") === "module" ? "module" : "script" : element.tagName === "LINK" ? "style" : "media";
    const one = (value: string): Promise<string> => {
      if (/^(?:data:|blob:|#)/u.test(value) || value === "") return Promise.resolve(value);
      const url = resolve(value); if (url === undefined) return Promise.reject(new Error("Resource is outside its surface."));
      if (kind !== "media") return code(kind, url);
      return new Promise((finish, reject) => request("media", url, result => {
        if (!current()) { reject(new Error("Resource changed.")); return; }
        if (!result.ok) { reject(new Error("Resource is unavailable.")); return; }
        if (result.blob instanceof Blob && /^(?:image|audio|video)\//u.test(result.blob.type)) {
          const objectUrl = URL.createObjectURL(result.blob); urls.add(objectUrl); created.add(objectUrl); finish(objectUrl + url.hash);
        } else if (typeof result.dataUrl === "string" && /^data:(?:image|audio|video)\/[a-z0-9.+-]+(?:;charset=[a-z0-9-]+)?;base64,/iu.test(result.dataUrl)) finish(result.dataUrl + url.hash);
        else reject(new Error("Resource media type is invalid."));
      }));
    };
    const task = name === "srcset" ? Promise.all(sourceSet(raw).map(async candidate => `${await one(candidate.url)}${candidate.descriptor ? " " + candidate.descriptor : ""}`)).then(values => values.join(", ")) : one(raw);
    void task.then(value => {
      if (!current()) { release(created); return; }
      release(entry.objectUrls); entry.objectUrls = created;
      entry.applied = value;
      if (value === "") element.removeAttribute(name); else apply(value);
    }, () => { release(created); if (current()) element.dispatchEvent(new Event("error")); });
  };
  Element.prototype.setAttribute = function(name, value) {
    const key = name.toLowerCase();
    if (key === "style" && "style" in this) {
      const style = Reflect.get(this, "style") as unknown;
      if (style instanceof CSSStyleDeclaration) { style.cssText = String(value); return; }
    }
    if (!watched(this, key)) return originalSet.call(this, name, value);
    set(this, key, String(value), result => originalSet.call(this, name, result));
  };
  Element.prototype.getAttribute = function(name) { return sources.get(this)?.get(name.toLowerCase())?.raw ?? originalGet.call(this, name); };
  for (const [prototype, names] of [[HTMLImageElement.prototype, ["src", "srcset"]], [HTMLMediaElement.prototype, ["src"]],
    [HTMLVideoElement.prototype, ["poster"]], [HTMLSourceElement.prototype, ["src", "srcset"]], [HTMLInputElement.prototype, ["src"]],
    [HTMLScriptElement.prototype, ["src"]], [HTMLLinkElement.prototype, ["href"]]] as const) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name); if (!descriptor?.set || !descriptor.get) continue;
      Object.defineProperty(prototype, name, { ...descriptor, get(this: Element) { const raw = sources.get(this)?.get(name)?.raw;
        return raw === undefined ? descriptor.get!.call(this) : name === "srcset" ? raw : new URL(raw, baseUrl).href; },
      set(this: Element, value: string) { set(this, name, String(value), result => descriptor.set!.call(this, result)); } });
    }
  }
  const cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText")!;
  const rawProperty = CSSStyleDeclaration.prototype.setProperty, rawRemove = CSSStyleDeclaration.prototype.removeProperty;
  const rawReplace = CSSStyleSheet.prototype.replaceSync, rawInsert = CSSStyleSheet.prototype.insertRule, rawDelete = CSSStyleSheet.prototype.deleteRule;
  const rawText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  const nativeStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")!;
  const rawStyles = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  const wrappedStyles = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  const unwrapStyle = (value: CSSStyleDeclaration): CSSStyleDeclaration => rawStyles.get(value) ?? value;
  const scratchStyle = (): CSSStyleDeclaration => nativeStyle.get!.call(document.createElement("span")) as CSSStyleDeclaration;
  const cssEpoch = new WeakMap<object, number>();
  const cssJobs = new WeakMap<object, Map<string, number>>();
  const nextCssJob = (target: object, key: string): number => {
    let jobs = cssJobs.get(target); if (jobs === undefined) { jobs = new Map(); cssJobs.set(target, jobs); }
    const value = (jobs.get(key) ?? 0) + 1; jobs.set(key, value); return value;
  };
  const parsed = (text: string): CSSStyleSheet => { const sheet = new CSSStyleSheet(); rawReplace.call(sheet, text); return sheet; };
  // This routes already parsed CSS to the resource transformer. It does not
  // interpret or rewrite CSS tokens; esbuild and the browser CSSOM do that.
  const needsResources = (text: string): boolean => {
    const lower = text.toLowerCase();
    return lower.includes("url(") || lower.includes("@import") || lower.includes("image-set(") || lower.includes("image(") || text.includes("\\");
  };
  const neutral = (text: string): string => {
    const sheet = parsed(text);
    const clear = (rules: CSSRuleList) => { for (const rule of rules) {
      if ("style" in rule) { const style = unwrapStyle((rule as CSSStyleRule).style);
        for (const name of Array.from(style)) if (needsResources(style.getPropertyValue(name))) rawRemove.call(style, name); }
      if ("cssRules" in rule) clear((rule as CSSGroupingRule).cssRules);
    } };
    clear(sheet.cssRules); return Array.from(sheet.cssRules).filter(rule => rule.type !== CSSRule.IMPORT_RULE).map(rule => rule.cssText).join("\n");
  };
  const cssBase = (target: CSSStyleSheet | CSSStyleDeclaration): URL => {
    const sheet = target instanceof CSSStyleSheet ? target : target.parentRule?.parentStyleSheet;
    const node = sheet?.ownerNode;
    if (node instanceof Element) {
      const value = originalGet.call(node, "data-joko-style-base") ?? sources.get(node)?.get("href")?.raw;
      const url = value === undefined || value === null ? undefined : resolve(value); if (url !== undefined) return url;
    }
    return baseUrl;
  };
  const cssFailure = () => window.dispatchEvent(new ErrorEvent("error", { message: "Extension stylesheet is unavailable." }));
  const materializeCss = (target: object, text: string, from: URL, apply: (value: string) => void, key = "stylesheet"): void => {
    const epoch = cssEpoch.get(target) ?? 0, job = nextCssJob(target, key);
    const current = () => (cssEpoch.get(target) ?? 0) === epoch && cssJobs.get(target)?.get(key) === job;
    void code("style-text", from, text).then(value => {
      if (!current()) return;
      const binary = atob(value.slice(value.indexOf(",") + 1));
      apply(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
    }).catch(() => { if (current()) cssFailure(); });
  };
  const declaration = (text: string): CSSStyleDeclaration => unwrapStyle((parsed(`.joko_inline{${text}}`).cssRules[0] as CSSStyleRule).style);
  Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", { ...cssText, set(this: CSSStyleDeclaration, value: string) {
    const source = String(value), normalized = declaration(source).cssText;
    cssEpoch.set(this, (cssEpoch.get(this) ?? 0) + 1);
    if (!needsResources(normalized)) { cssText.set!.call(this, source); return; }
    cssText.set!.call(this, (parsed(neutral(`.joko_inline{${source}}`)).cssRules[0] as CSSStyleRule).style.cssText);
    materializeCss(this, `.joko_inline{${source}}`, cssBase(this), compiled => cssText.set!.call(this, (parsed(compiled).cssRules[0] as CSSStyleRule).style.cssText));
  } });
  CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
    const scratch = scratchStyle(); rawProperty.call(scratch, name, value, priority);
    const normalized = cssText.get!.call(scratch) as string;
    if (!needsResources(normalized)) { nextCssJob(this, name); rawProperty.call(this, name, value, priority); return; }
    rawRemove.call(this, name);
    materializeCss(this, `.joko_inline{${normalized}}`, cssBase(this), compiled => {
      const result = (parsed(compiled).cssRules[0] as CSSStyleRule).style;
      rawProperty.call(this, name, result.getPropertyValue(name), result.getPropertyPriority(name));
    }, name);
  };
  CSSStyleDeclaration.prototype.removeProperty = function(name) { const target = unwrapStyle(this); nextCssJob(target, name); return rawRemove.call(target, name); };
  const wrapStyle = (target: CSSStyleDeclaration): CSSStyleDeclaration => {
    const previous = wrappedStyles.get(target); if (previous !== undefined) return previous;
    const wrapped = new Proxy(target, { get(value, name) {
      const result: unknown = Reflect.get(value, name, value);
      return typeof result === "function" && name !== "constructor" ? result.bind(value) : result;
    }, set(value, name, input) {
      if (name === "cssText" || typeof name !== "string" || !(name in value)) return Reflect.set(value, name, input, value);
      const scratch = scratchStyle(); Reflect.set(scratch, name, input, scratch);
      const normalized = cssText.get!.call(scratch) as string, key = scratch.item(0) || name;
      if (!needsResources(normalized)) { nextCssJob(value, key); return Reflect.set(value, name, input, value); }
      rawRemove.call(value, key);
      materializeCss(value, `.joko_inline{${normalized}}`, cssBase(value), compiled => {
        const result = unwrapStyle((parsed(compiled).cssRules[0] as CSSStyleRule).style);
        Reflect.set(value, name, Reflect.get(result, name, result), value);
      }, key);
      return true;
    } });
    wrappedStyles.set(target, wrapped); rawStyles.set(wrapped, target); return wrapped;
  };
  for (const name of ["HTMLElement", "SVGElement", "CSSStyleRule", "CSSFontFaceRule", "CSSKeyframeRule", "CSSPageRule"]) {
    const constructor = Reflect.get(window, name) as { prototype?: object } | undefined, prototype = constructor?.prototype;
    if (prototype === undefined) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "style"); if (descriptor?.get === undefined) continue;
    Object.defineProperty(prototype, "style", { ...descriptor, get() { return wrapStyle(descriptor.get!.call(this) as CSSStyleDeclaration); },
      ...(descriptor.set === undefined ? {} : { set(value: unknown) { const style = descriptor.get!.call(this) as CSSStyleDeclaration; style.cssText = String(value); } }) });
  }
  CSSStyleSheet.prototype.insertRule = function(rule, index) {
    if (!needsResources(rule)) return rawInsert.call(this, rule, index);
    // The native parser validates syntax synchronously; the temporary rule keeps
    // its index while the original scoped resources are read asynchronously.
    const safe = neutral(rule), position = rawInsert.call(this, safe || ".joko_pending{}", index), marker = this.cssRules[position]!;
    const declaration = marker instanceof CSSStyleRule ? unwrapStyle(marker.style) : undefined;
    const generation = declaration === undefined ? 0 : cssEpoch.get(declaration) ?? 0;
    const jobs = new Map(declaration === undefined ? [] : cssJobs.get(declaration));
    materializeCss(marker, rule, cssBase(this), compiled => {
      const current = Array.from(this.cssRules).indexOf(marker); if (current < 0) return;
      const replacements = Array.from(parsed(compiled).cssRules);
      if (declaration !== undefined && replacements.length === 1 && replacements[0] instanceof CSSStyleRule) {
        if ((cssEpoch.get(declaration) ?? 0) !== generation) return;
        const result = replacements[0].style;
        for (const name of Array.from(result)) if (cssJobs.get(declaration)?.get(name) === jobs.get(name))
          rawProperty.call(declaration, name, result.getPropertyValue(name), result.getPropertyPriority(name));
        return;
      }
      rawDelete.call(this, current); let offset = 0;
      for (const replacement of replacements) rawInsert.call(this, replacement.cssText, current + offset++);
    });
    return position;
  };
  if (typeof rawReplace === "function") CSSStyleSheet.prototype.replaceSync = function(text) {
    cssEpoch.set(this, (cssEpoch.get(this) ?? 0) + 1);
    if (!needsResources(text)) { rawReplace.call(this, text); return; }
    rawReplace.call(this, neutral(text)); materializeCss(this, text, cssBase(this), compiled => rawReplace.call(this, compiled));
  };
  const originalReplace = CSSStyleSheet.prototype.replace;
  if (typeof originalReplace === "function") CSSStyleSheet.prototype.replace = function(text) {
    if (!needsResources(text)) return originalReplace.call(this, text);
    return new Promise<CSSStyleSheet>((finish, reject) => {
      const epoch = (cssEpoch.get(this) ?? 0) + 1; cssEpoch.set(this, epoch);
      void code("style-text", cssBase(this), text).then(value => {
        if (cssEpoch.get(this) !== epoch) throw new Error("Stylesheet changed.");
        const binary = atob(value.slice(value.indexOf(",") + 1)); rawReplace.call(this, new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))); finish(this);
      }).catch(reject);
    });
  };
  Object.defineProperty(Node.prototype, "textContent", { ...rawText, set(this: Node, value: string | null) {
    if (!(this instanceof HTMLStyleElement) || value === null || !needsResources(value)) { cssEpoch.set(this, (cssEpoch.get(this) ?? 0) + 1); rawText.set!.call(this, value); return; }
    rawText.set!.call(this, neutral(value)); materializeCss(this, value, baseUrl, compiled => rawText.set!.call(this, compiled));
  } });
  const inspect = (element: Element) => {
    for (const name of ["src", "poster", "srcset", "href"]) {
      const raw = originalGet.call(element, name);
      if (raw !== null && watched(element, name) && (name === "srcset" || !/^(?:data:|blob:|#)/u.test(raw)) && sources.get(element)?.get(name)?.raw !== raw
        && sources.get(element)?.get(name)?.applied !== raw)
        set(element, name, raw, result => originalSet.call(element, name, result));
    }
  };
  new MutationObserver(changes => { for (const change of changes) {
    if (change.type === "attributes") inspect(change.target as Element);
    for (const node of change.addedNodes) if (node instanceof Element) { inspect(node); for (const child of node.querySelectorAll("img,video,audio,source,input,script,link")) inspect(child); }
  } }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "poster", "srcset", "href"] });
  addEventListener("click", event => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const raw = anchor === null ? null : originalGet.call(anchor, "href"); if (raw === null || raw.startsWith("#") || anchor!.hasAttribute("download")) return;
    const url = resolve(raw); if (url === undefined || !url.pathname.endsWith(".html")) return;
    event.preventDefault(); request("navigate", url);
  });
  addEventListener("pagehide", () => { pending.clear(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }, { once: true });
}

// Development's TS loader preserves function names through this helper. Keep the
// serialized closure independent of that loader as well as the production build.
export const EXTENSION_RESOURCE_BOOTSTRAP = `(()=>{const __name=value=>value;(${installExtensionResources.toString()})(${extensionSourceSet.toString()});})();`;
