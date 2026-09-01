import { isAbsolute, resolve } from "node:path";
import ts from "typescript";

import { isLspToolError, LspToolError } from "./errors.js";
import { LspOperationControl, validateTimeout } from "./operation.js";
import type {
  LspBridgeResponse,
  LspCallHierarchySource,
  LspCallOptions,
  LspDefinitionItem,
  LspDefinitionResult,
  LspFileRequest,
  LspHoverItem,
  LspHoverResult,
  LspIncomingCallItem,
  LspIncomingCallsResult,
  LspLocation,
  LspOutlineItem,
  LspOutlineResult,
  LspPositionRequest,
  LspRange,
  LspReferenceItem,
  LspReferencesResult,
  LspToolAction,
  LspToolRequest,
  LspToolResponse,
  LspWorkspaceSymbolItem,
  LspWorkspaceSymbolRequest,
  LspWorkspaceSymbolResult
} from "./types.js";
import {
  MAXIMUM_LSP_OUTPUT_CHARACTERS,
  MAXIMUM_LSP_WORKSPACE_FILES,
  computeLineStarts,
  rangeFromTextSpan,
  splitModifiers,
  TypeScriptWorkspace
} from "./workspace.js";

const DEFAULT_IDLE_DISPOSE_MS = 120_000;
const MAXIMUM_IDLE_DISPOSE_MS = 60 * 60 * 1000;
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
const MAXIMUM_RESULTS = 100_000;
const DEFAULT_DEFINITION_RESULTS = 200;
const DEFAULT_REFERENCE_RESULTS = 1_000;
const DEFAULT_OUTLINE_RESULTS = 5_000;
const DEFAULT_WORKSPACE_SYMBOL_RESULTS = 1_000;
const DEFAULT_INCOMING_CALL_RESULTS = 1_000;
const MAXIMUM_QUERY_CHARACTERS = 1_024;
const MAXIMUM_HOVER_TEXT_CHARACTERS = 40_000;

export interface TypeScriptLspBridgeOptions {
  readonly idleDisposeMs?: number;
  readonly defaultOperationTimeoutMs?: number;
  readonly maximumWorkspaceFiles?: number;
  readonly maximumOutputCharacters?: number;
  readonly now?: () => number;
}

interface WorkspacePoolEntry {
  readonly key: string;
  readonly workspace: TypeScriptWorkspace;
  activeOperations: number;
  idleTimer: NodeJS.Timeout | undefined;
}

interface WorkspaceLease {
  readonly workspace: TypeScriptWorkspace;
  readonly release: () => void;
}

interface WorkspaceSlot {
  readonly key: string;
  readonly entry: Promise<WorkspacePoolEntry>;
}

export class TypeScriptLspBridge {
  readonly #idleDisposeMs: number;
  readonly #defaultOperationTimeoutMs: number;
  readonly #maximumWorkspaceFiles: number;
  readonly #maximumOutputCharacters: number;
  readonly #now: () => number;
  readonly #pool = new Map<string, WorkspaceSlot>();
  #disposed = false;

  constructor(options: TypeScriptLspBridgeOptions = {}) {
    this.#idleDisposeMs = validateIntegerRange(
      options.idleDisposeMs ?? DEFAULT_IDLE_DISPOSE_MS,
      "idleDisposeMs",
      1,
      MAXIMUM_IDLE_DISPOSE_MS
    );
    this.#defaultOperationTimeoutMs = validateTimeout(
      options.defaultOperationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      "defaultOperationTimeoutMs"
    );
    this.#maximumWorkspaceFiles = validateIntegerRange(
      options.maximumWorkspaceFiles ?? MAXIMUM_LSP_WORKSPACE_FILES,
      "maximumWorkspaceFiles",
      1,
      MAXIMUM_LSP_WORKSPACE_FILES
    );
    this.#maximumOutputCharacters = validateIntegerRange(
      options.maximumOutputCharacters ?? MAXIMUM_LSP_OUTPUT_CHARACTERS,
      "maximumOutputCharacters",
      256,
      MAXIMUM_LSP_OUTPUT_CHARACTERS
    );
    this.#now = options.now ?? Date.now;
  }

  get workspaceCount(): number {
    return this.#pool.size;
  }

  hover(request: LspPositionRequest, options?: LspCallOptions): Promise<LspHoverResult> {
    return this.execute({ ...request, action: "hover" }, options).then((result) => result as LspHoverResult);
  }

  gotoDefinition(request: LspPositionRequest, options?: LspCallOptions): Promise<LspDefinitionResult> {
    return this.execute({ ...request, action: "goto_definition" }, options)
      .then((result) => result as LspDefinitionResult);
  }

  findReferences(request: LspPositionRequest, options?: LspCallOptions): Promise<LspReferencesResult> {
    return this.execute({ ...request, action: "find_references" }, options)
      .then((result) => result as LspReferencesResult);
  }

  outline(request: LspFileRequest, options?: LspCallOptions): Promise<LspOutlineResult> {
    return this.execute({ ...request, action: "outline" }, options).then((result) => result as LspOutlineResult);
  }

  workspaceSymbol(
    request: LspWorkspaceSymbolRequest,
    options?: LspCallOptions
  ): Promise<LspWorkspaceSymbolResult> {
    return this.execute({ ...request, action: "workspace_symbol" }, options)
      .then((result) => result as LspWorkspaceSymbolResult);
  }

  incomingCalls(request: LspPositionRequest, options?: LspCallOptions): Promise<LspIncomingCallsResult> {
    return this.execute({ ...request, action: "incoming_calls" }, options)
      .then((result) => result as LspIncomingCallsResult);
  }

  async execute(request: LspToolRequest, options?: LspCallOptions): Promise<LspToolResponse> {
    const control = new LspOperationControl(options, this.#defaultOperationTimeoutMs, this.#now);
    let lease: WorkspaceLease | undefined;
    try {
      control.check();
      const accepted = validateRequest(request);
      lease = await this.acquireWorkspace(accepted.workspaceRoot, control);
      control.check();
      return this.executeInWorkspace(lease.workspace, accepted, control);
    } catch (error) {
      throw normalizeOperationError(error, control);
    } finally {
      lease?.release();
    }
  }

  async call(request: LspToolRequest, options?: LspCallOptions): Promise<LspBridgeResponse> {
    try {
      return Object.freeze({ ok: true, result: await this.execute(request, options) });
    } catch (error) {
      const accepted = isLspToolError(error)
        ? error
        : new LspToolError("INTERNAL", "The LSP operation failed safely.");
      return Object.freeze({ ok: false, error: accepted.toJSON() });
    }
  }

  disposeWorkspace(workspaceRoot: string): boolean {
    if (typeof workspaceRoot !== "string" || workspaceRoot === "") return false;
    const key = poolKey(workspaceRoot);
    const slot = this.#pool.get(key);
    if (slot === undefined) return false;
    this.#pool.delete(key);
    void slot.entry.then((entry) => {
      if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
      entry.workspace.dispose();
    }, () => undefined);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const slot of this.#pool.values()) {
      void slot.entry.then((entry) => {
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        entry.workspace.dispose();
      }, () => undefined);
    }
    this.#pool.clear();
  }

  private executeInWorkspace(
    workspace: TypeScriptWorkspace,
    request: LspToolRequest,
    control: LspOperationControl
  ): LspToolResponse {
    switch (request.action) {
    case "hover": return this.executeHover(workspace, request, control);
    case "goto_definition": return this.executeDefinition(workspace, request, control);
    case "find_references": return this.executeReferences(workspace, request, control);
    case "outline": return this.executeOutline(workspace, request, control);
    case "workspace_symbol": return this.executeWorkspaceSymbol(workspace, request, control);
    case "incoming_calls": return this.executeIncomingCalls(workspace, request, control);
    }
  }

  private executeHover(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "hover" }>,
    control: LspOperationControl
  ): LspHoverResult {
    const position = workspace.resolvePosition(request.file, request.line, request.column, control);
    const quickInfo = workspace.run(control, (service) => service.getQuickInfoAtPosition(position.fileName, position.offset));
    const items: LspHoverItem[] = [];
    if (quickInfo !== undefined) {
      const range = rangeFromTextSpan(position.text, quickInfo.textSpan);
      if (range !== undefined) {
        const tags = quickInfo.tags?.map((tag) => {
          const text = tag.text === undefined ? "" : ts.displayPartsToString(tag.text);
          return text === "" ? `@${tag.name}` : `@${tag.name} ${text}`;
        }).join("\n") ?? "";
        const documentation = [ts.displayPartsToString(quickInfo.documentation ?? []), tags]
          .filter((item) => item !== "")
          .join("\n\n");
        items.push(Object.freeze({
          kind: quickInfo.kind,
          modifiers: splitModifiers(quickInfo.kindModifiers),
          display: truncateText(ts.displayPartsToString(quickInfo.displayParts ?? []), MAXIMUM_HOVER_TEXT_CHARACTERS),
          documentation: truncateText(documentation, MAXIMUM_HOVER_TEXT_CHARACTERS),
          range
        }));
      }
    }
    return this.boundedResult("hover", items, false);
  }

  private executeDefinition(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "goto_definition" }>,
    control: LspOperationControl
  ): LspDefinitionResult {
    const maximum = maximumResults(request.maxResults, DEFAULT_DEFINITION_RESULTS);
    const position = workspace.resolvePosition(request.file, request.line, request.column, control);
    const definitions = workspace.run(
      control,
      (service) => service.getDefinitionAtPosition(position.fileName, position.offset) ?? []
    );
    const projection = new WorkspaceProjection(workspace, control);
    const items: LspDefinitionItem[] = [];
    for (const definition of definitions) {
      control.check();
      const location = projection.location(definition.fileName, definition.textSpan);
      if (location === undefined) continue;
      items.push(Object.freeze({
        name: truncateText(definition.name, 4_096),
        kind: definition.kind,
        ...(definition.containerName === "" ? {} : { container: truncateText(definition.containerName, 4_096) }),
        location
      }));
      if (items.length > maximum) break;
    }
    return this.boundedResult("goto_definition", items.slice(0, maximum), items.length > maximum);
  }

  private executeReferences(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "find_references" }>,
    control: LspOperationControl
  ): LspReferencesResult {
    const maximum = maximumResults(request.maxResults, DEFAULT_REFERENCE_RESULTS);
    const position = workspace.resolvePosition(request.file, request.line, request.column, control);
    const references = workspace.run(
      control,
      (service) => service.getReferencesAtPosition(position.fileName, position.offset) ?? []
    );
    const projection = new WorkspaceProjection(workspace, control);
    const items: LspReferenceItem[] = [];
    for (const reference of references) {
      control.check();
      const location = projection.location(reference.fileName, reference.textSpan);
      if (location === undefined) continue;
      items.push(Object.freeze({
        location,
        isWriteAccess: reference.isWriteAccess,
        isInString: reference.isInString === true
      }));
      if (items.length > maximum) break;
    }
    return this.boundedResult("find_references", items.slice(0, maximum), items.length > maximum);
  }

  private executeOutline(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "outline" }>,
    control: LspOperationControl
  ): LspOutlineResult {
    const maximum = maximumResults(request.maxResults, DEFAULT_OUTLINE_RESULTS);
    const file = workspace.resolveFile(request.file, control);
    const tree = workspace.run(control, (service) => service.getNavigationTree(file.fileName));
    const projection = new WorkspaceProjection(workspace, control);
    const stack = [...(tree.childItems ?? [])].reverse().map((item) => ({ item, depth: 0, parent: undefined as string | undefined }));
    const items: LspOutlineItem[] = [];
    while (stack.length > 0 && items.length <= maximum) {
      control.check();
      const current = stack.pop();
      if (current === undefined) break;
      const span = current.item.spans[0];
      const location = span === undefined ? undefined : projection.location(file.fileName, span);
      if (location !== undefined) {
        const selection = current.item.nameSpan === undefined
          ? undefined
          : projection.range(file.fileName, current.item.nameSpan);
        items.push(Object.freeze({
          name: truncateText(current.item.text, 4_096),
          kind: current.item.kind,
          modifiers: splitModifiers(current.item.kindModifiers),
          depth: current.depth,
          ...(current.parent === undefined ? {} : { parent: truncateText(current.parent, 4_096) }),
          location,
          ...(selection === undefined ? {} : { selection })
        }));
      }
      const children = current.item.childItems ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ item: children[index] as ts.NavigationTree, depth: current.depth + 1, parent: current.item.text });
      }
    }
    return this.boundedResult("outline", items.slice(0, maximum), items.length > maximum || stack.length > 0);
  }

  private executeWorkspaceSymbol(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "workspace_symbol" }>,
    control: LspOperationControl
  ): LspWorkspaceSymbolResult {
    const maximum = maximumResults(request.maxResults, DEFAULT_WORKSPACE_SYMBOL_RESULTS);
    const query = validateQuery(request.query);
    const queryLimit = maximum === MAXIMUM_RESULTS ? maximum : maximum + 1;
    const symbols = workspace.run(
      control,
      (service) => service.getNavigateToItems(query, queryLimit, undefined, false, true)
    );
    const projection = new WorkspaceProjection(workspace, control);
    const items: LspWorkspaceSymbolItem[] = [];
    for (const symbol of symbols) {
      control.check();
      const location = projection.location(symbol.fileName, symbol.textSpan);
      if (location === undefined) continue;
      items.push(Object.freeze({
        name: truncateText(symbol.name, 4_096),
        kind: symbol.kind,
        modifiers: splitModifiers(symbol.kindModifiers),
        matchKind: symbol.matchKind,
        ...(symbol.containerName === "" ? {} : { container: truncateText(symbol.containerName, 4_096) }),
        location
      }));
      if (items.length > maximum) break;
    }
    return this.boundedResult("workspace_symbol", items.slice(0, maximum), items.length > maximum || symbols.length > maximum);
  }

  private executeIncomingCalls(
    workspace: TypeScriptWorkspace,
    request: Extract<LspToolRequest, { readonly action: "incoming_calls" }>,
    control: LspOperationControl
  ): LspIncomingCallsResult {
    const maximum = maximumResults(request.maxResults, DEFAULT_INCOMING_CALL_RESULTS);
    const position = workspace.resolvePosition(request.file, request.line, request.column, control);
    const calls = workspace.run(control, (service) => {
      if (service.prepareCallHierarchy(position.fileName, position.offset) === undefined) return [];
      return service.provideCallHierarchyIncomingCalls(position.fileName, position.offset);
    });
    const projection = new WorkspaceProjection(workspace, control);
    const items: LspIncomingCallItem[] = [];
    for (const call of calls) {
      control.check();
      const from = projection.callHierarchySource(call.from);
      if (from === undefined) continue;
      const callSites = call.fromSpans
        .map((span) => projection.range(call.from.file, span))
        .filter((range): range is LspRange => range !== undefined)
        .slice(0, maximum);
      items.push(Object.freeze({ from, callSites: Object.freeze(callSites) }));
      if (items.length > maximum) break;
    }
    return this.boundedResult("incoming_calls", items.slice(0, maximum), items.length > maximum || calls.length > maximum);
  }

  private boundedResult<TItem, TAction extends LspToolAction>(
    action: TAction,
    candidates: readonly TItem[],
    sourceTruncated: boolean
  ): { readonly action: TAction; readonly items: readonly TItem[]; readonly truncated: boolean } {
    const accepted: TItem[] = [];
    let used = serializedPublicSize(JSON.stringify({ action, items: [], truncated: true }));
    let truncated = sourceTruncated;
    for (const candidate of candidates) {
      const serialized = JSON.stringify(candidate);
      if (serialized === undefined) continue;
      const next = used + serializedPublicSize(serialized) + (accepted.length === 0 ? 0 : 1);
      if (next > this.#maximumOutputCharacters) {
        truncated = true;
        break;
      }
      accepted.push(candidate);
      used = next;
    }
    const result = Object.freeze({ action, items: Object.freeze(accepted), truncated });
    if (serializedPublicSize(JSON.stringify(result)) > this.#maximumOutputCharacters) {
      throw new LspToolError("OUTPUT_LIMIT_EXCEEDED", "The LSP result exceeds its public output limit.", {
        maximumCharacters: this.#maximumOutputCharacters
      });
    }
    return result;
  }

  private async acquireWorkspace(workspaceRoot: string, control: LspOperationControl): Promise<WorkspaceLease> {
    if (this.#disposed) throw new LspToolError("INTERNAL", "The LSP bridge has been disposed.");
    if (typeof workspaceRoot !== "string" || workspaceRoot.length < 1 || workspaceRoot.length > 32_768 ||
      workspaceRoot.includes("\0") || !isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
      throw new LspToolError("INVALID_ARGUMENT", "workspaceRoot must be a normalized absolute path.", {
        field: "workspaceRoot"
      });
    }
    const key = poolKey(workspaceRoot);
    let slot = this.#pool.get(key);
    if (slot === undefined) {
      let entryPromise!: Promise<WorkspacePoolEntry>;
      entryPromise = TypeScriptWorkspace.create(
        workspaceRoot,
        { maximumFiles: this.#maximumWorkspaceFiles },
        control
      ).then((workspace) => ({ key, workspace, activeOperations: 0, idleTimer: undefined }), (error) => {
        if (this.#pool.get(key)?.entry === entryPromise) this.#pool.delete(key);
        throw error;
      });
      slot = { key, entry: entryPromise };
      this.#pool.set(key, slot);
    }
    const entry = await slot.entry;
    control.check();
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.activeOperations += 1;
    let released = false;
    return {
      workspace: entry.workspace,
      release: () => {
        if (released) return;
        released = true;
        entry.activeOperations = Math.max(0, entry.activeOperations - 1);
        if (entry.activeOperations !== 0 || this.#disposed) return;
        const timer = setTimeout(() => this.disposeIdleEntry(entry), this.#idleDisposeMs);
        timer.unref?.();
        entry.idleTimer = timer;
      }
    };
  }

  private disposeIdleEntry(entry: WorkspacePoolEntry): void {
    entry.idleTimer = undefined;
    if (entry.activeOperations !== 0) return;
    const slot = this.#pool.get(entry.key);
    if (slot === undefined) return;
    void slot.entry.then((current) => {
      if (current !== entry || entry.activeOperations !== 0) return;
      if (this.#pool.get(entry.key) === slot) this.#pool.delete(entry.key);
      entry.workspace.dispose();
    }, () => undefined);
  }
}

class WorkspaceProjection {
  readonly #workspace: TypeScriptWorkspace;
  readonly #control: LspOperationControl;
  readonly #texts = new Map<string, string | undefined>();
  readonly #lineStarts = new Map<string, readonly number[]>();

  constructor(workspace: TypeScriptWorkspace, control: LspOperationControl) {
    this.#workspace = workspace;
    this.#control = control;
  }

  text(fileName: string): string | undefined {
    const key = pathKey(fileName);
    if (this.#texts.has(key)) return this.#texts.get(key);
    const text = this.#workspace.indexedText(fileName, this.#control);
    this.#texts.set(key, text);
    return text;
  }

  location(fileName: string, span: ts.TextSpan): LspLocation | undefined {
    const path = this.#workspace.publicPath(fileName);
    const range = this.range(fileName, span);
    if (path === undefined || range === undefined) return undefined;
    return Object.freeze({ path, range });
  }

  range(fileName: string, span: ts.TextSpan): LspRange | undefined {
    const key = pathKey(fileName);
    const text = this.text(fileName);
    if (text === undefined) return undefined;
    let starts = this.#lineStarts.get(key);
    if (starts === undefined) {
      starts = computeLineStarts(text);
      this.#lineStarts.set(key, starts);
    }
    const range = rangeFromTextSpan(text, span, starts);
    return range;
  }

  callHierarchySource(item: ts.CallHierarchyItem): LspCallHierarchySource | undefined {
    const location = this.location(item.file, item.span);
    const text = this.text(item.file);
    if (location === undefined || text === undefined) return undefined;
    const selection = this.range(item.file, item.selectionSpan);
    if (selection === undefined) return undefined;
    return Object.freeze({
      name: truncateText(item.name, 4_096),
      kind: item.kind,
      modifiers: splitModifiers(item.kindModifiers),
      ...(item.containerName === undefined || item.containerName === ""
        ? {}
        : { container: truncateText(item.containerName, 4_096) }),
      location,
      selection
    });
  }
}

function validateRequest(request: LspToolRequest): LspToolRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new LspToolError("INVALID_ARGUMENT", "The LSP request must be an exact object.");
  }
  const candidate = request as unknown as Record<string, unknown>;
  const action = candidate["action"];
  if (!isAction(action)) throw new LspToolError("INVALID_ARGUMENT", "The LSP action is unsupported.", { field: "action" });
  const allowed = new Set(["action", "workspaceRoot", "maxResults"]);
  if (action === "workspace_symbol") allowed.add("query");
  else {
    allowed.add("file");
    if (action !== "outline") {
      allowed.add("line");
      allowed.add("column");
    }
  }
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new LspToolError("INVALID_ARGUMENT", "The LSP request contains unsupported fields.");
  }
  if (typeof candidate["workspaceRoot"] !== "string") {
    throw new LspToolError("INVALID_ARGUMENT", "workspaceRoot must be a string.", { field: "workspaceRoot" });
  }
  if (candidate["maxResults"] !== undefined) maximumResults(candidate["maxResults"], 1);
  if (action === "workspace_symbol") validateQuery(candidate["query"]);
  else {
    if (typeof candidate["file"] !== "string") {
      throw new LspToolError("INVALID_ARGUMENT", "file must be a string.", { field: "file" });
    }
    if (action !== "outline") {
      validateCoordinate(candidate["line"], "line");
      validateCoordinate(candidate["column"], "column");
    }
  }
  return request;
}

function isAction(value: unknown): value is LspToolAction {
  return value === "hover" || value === "goto_definition" || value === "find_references" ||
    value === "outline" || value === "workspace_symbol" || value === "incoming_calls";
}

function validateCoordinate(value: unknown, field: "column" | "line"): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new LspToolError("INVALID_ARGUMENT", `${field} must be a positive one-based integer.`, { field });
  }
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAXIMUM_QUERY_CHARACTERS || value.includes("\0")) {
    throw new LspToolError("INVALID_ARGUMENT", "query must be non-empty and no longer than 1024 characters.", {
      field: "query",
      maximum: MAXIMUM_QUERY_CHARACTERS
    });
  }
  return value;
}

function maximumResults(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return validateIntegerRange(value, "maxResults", 1, MAXIMUM_RESULTS);
}

function validateIntegerRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new LspToolError(
      "INVALID_ARGUMENT",
      `${field} must be an integer from ${minimum} through ${maximum}.`,
      { field, minimum, maximum }
    );
  }
  return value as number;
}

function normalizeOperationError(error: unknown, control: LspOperationControl): LspToolError {
  if (isLspToolError(error)) return error;
  if (control.signal?.aborted === true) return new LspToolError("ABORTED", "The LSP operation was aborted.");
  if (control.cancellationRequested() || error instanceof ts.OperationCanceledException) {
    return new LspToolError("DEADLINE_EXCEEDED", "The LSP operation exceeded its deadline.");
  }
  return new LspToolError("INTERNAL", "The LSP operation failed safely.");
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function serializedPublicSize(value: string): number {
  return Math.max(value.length, Buffer.byteLength(value, "utf8"));
}

function poolKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
