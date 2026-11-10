import { randomUUID } from "node:crypto";
import type { NativeUsageRequest, UsageSnapshot } from "@joko/core";

interface Tokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface ModelUsage extends Tokens {
  readonly costMicros?: number;
}

interface ModelDelta extends Tokens {
  readonly costMicros: number;
  readonly tokensComplete: boolean;
  readonly costComplete: boolean;
}

interface StreamRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly epoch: number;
  readonly fastMode?: boolean;
  readonly requestedAt: number;
  usage: Record<string, unknown>;
  invalid: boolean;
}

const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const emptyTokens = (): Tokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const counter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
  && !/[\u0000-\u0020\u007f]/u.test(value);

/** Native Query counters exclude any saved transcript prefix. The service owns Run attribution. */
export class NativeQueryUsage {
  readonly sourceId = randomUUID();
  readonly #startsAtZero: boolean;
  #previous = new Map<string, ModelUsage>();
  #uncertainModels = new Set<string>();
  #observed = new Map<string, Tokens>();
  #requests = new Map<string, { readonly model: string; readonly tokens: Tokens }>();
  #total: Tokens = emptyTokens();
  #modelTotals = new Map<string, ModelUsage>();
  #costMicros = 0;
  #previousTotalCost?: number;
  #baselineUnavailable = false;
  #hasContribution = false;
  #hasResult = false;
  #suppressNextMoney = false;
  #epoch = 0;
  #streams = new Map<string, StreamRequest>();
  #closed = new Map<string, NativeUsageRequest>();
  #referenceRequests = new Map<string, NativeUsageRequest>();

  constructor(startsAtZero: boolean) {
    this.#startsAtZero = startsAtZero;
  }

  observeAssistant(envelope: unknown): void {
    const message = record(record(envelope)?.["message"]);
    const model = message?.["model"];
    const requestId = message?.["id"];
    const tokens = nativeTokens(message?.["usage"]);
    if (!identity(model) || !identity(requestId) || tokens === undefined) return;
    const previous = this.#requests.get(requestId);
    if (previous !== undefined && (previous.model !== model || tokenKeys.some(key => tokens[key] < previous.tokens[key]))) return;
    if (this.#requests.size >= 65_536 && previous === undefined) return;
    const delta = difference(tokens, previous?.tokens ?? emptyTokens());
    this.#observed.set(model, add(this.#observed.get(model) ?? emptyTokens(), delta));
    this.#requests.set(requestId, { model, tokens });
  }

  observeStream(envelope: unknown, context: { readonly fastMode?: boolean; readonly requestedAt: number }): void {
    const value = record(envelope), event = record(value?.["event"]);
    const parent = value?.["parent_tool_use_id"];
    if (!event || parent !== undefined && parent !== null && !identity(parent)) return;
    const scope = typeof parent === "string" ? `child:${parent}` : "root";
    if (event["type"] === "message_start") {
      const message = record(event["message"]), requestId = message?.["id"], modelId = message?.["model"], usage = record(message?.["usage"]);
      if (!identity(requestId) || !identity(modelId) || !usage || counter(context.requestedAt) === undefined
        || context.requestedAt > 8_640_000_000_000_000 || this.#referenceRequests.has(requestId) || this.#closed.has(requestId)
        || !this.#streams.has(scope) && this.#streams.size >= 256) return;
      const existing = this.#streams.get(scope);
      if (existing?.requestId === requestId) return;
      this.#streams.set(scope, { requestId, modelId, usage: { ...usage }, epoch: this.#epoch,
        fastMode: context.fastMode, requestedAt: context.requestedAt, invalid: false });
      return;
    }
    const request = this.#streams.get(scope);
    if (!request) return;
    if (event["type"] === "message_delta") {
      const usage = record(event["usage"]);
      if (!usage) return;
      for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
        if (usage[key] !== undefined && (counter(usage[key]) === undefined
          || counter(request.usage[key]) !== undefined && (usage[key] as number) < (request.usage[key] as number))) request.invalid = true;
      }
      request.usage = { ...request.usage, ...usage };
      return;
    }
    if (event["type"] !== "message_stop") return;
    this.#streams.delete(scope);
    const tokens = nativeTokens(request.usage);
    if (request.invalid || !tokens) return;
    // Per-block assistant frames can carry placeholder output counts. The raw
    // closed request supplies the independent final count before Result joins it.
    this.observeAssistant({ message: { id: request.requestId, model: request.modelId, usage: request.usage } });
    const speed = request.usage["speed"], tier = request.usage["service_tier"];
    const fastMode = speed === "fast" ? true : speed === "standard" ? false : request.fastMode;
    if (request.epoch !== this.#epoch || typeof fastMode !== "boolean" || this.#closed.size >= 4096
      || speed !== undefined && speed !== null && speed !== "fast" && speed !== "standard"
      || tier !== undefined && tier !== null && tier !== "standard"
      || ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].some(key => counter(request.usage[key]) === undefined)) return;
    const cache = record(request.usage["cache_creation"]), oneHour = counter(cache?.["ephemeral_1h_input_tokens"]), fiveMinutes = counter(cache?.["ephemeral_5m_input_tokens"]);
    const cacheWrite1hTokens = tokens.cacheWriteTokens === 0 ? 0
      : oneHour !== undefined && fiveMinutes !== undefined && oneHour + fiveMinutes === tokens.cacheWriteTokens ? oneHour : undefined;
    this.#closed.set(request.requestId, { requestId: request.requestId, modelId: request.modelId, ...tokens,
      totalTokens: safeAdd(tokens.inputTokens, tokens.outputTokens), fastMode, requestedAt: request.requestedAt,
      ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }) });
  }

  observeResult(envelope: unknown): UsageSnapshot | undefined {
    const closed = this.#closed;
    this.#closed = new Map();
    this.#epoch += 1;
    const value = record(envelope) ?? {};
    const models = record(value["modelUsage"]);
    const observed = this.#observed;
    this.#observed = new Map();
    const totalCost = nativeCostMicros(value["total_cost_usd"]);
    let delta: Tokens = emptyTokens();
    let deltaCost = 0;
    const modelDeltas = new Map<string, ModelDelta>();
    const modelSnapshotValid = models !== undefined && Object.keys(models).length <= 256;
    let tokensComplete = modelSnapshotValid;
    let costComplete = tokensComplete;
    let firstSnapshotProven = tokensComplete;
    let resetObserved = false;
    let moneyScopeProven = !this.#suppressNextMoney;
    this.#suppressNextMoney = false;
    const next = new Map(this.#previous);
    const included = new Set<string>();
    const observedOwners = new Map<string, string>();
    const ambiguousObserved = new Set<string>();
    const modelNames = modelSnapshotValid ? Object.keys(models!) : [];
    for (const name of observed.keys()) {
      if (modelNames.includes(name)) { observedOwners.set(name, name); continue; }
      const aliases = modelNames.filter(model => model.replace(/\[[^\]]*\]\s*$/u, "") === name);
      if (aliases.length === 1) observedOwners.set(aliases[0]!, name);
      else if (aliases.length > 1) ambiguousObserved.add(name);
    }
    if (ambiguousObserved.size > 0) { tokensComplete = false; costComplete = false; moneyScopeProven = false; }

    if (modelSnapshotValid && models !== undefined) {
      for (const [model, raw] of Object.entries(models)) {
        const current = modelTokens(raw);
        if (!identity(model) || current === undefined) { tokensComplete = false; costComplete = false; firstSnapshotProven = false; continue; }
        const prior = this.#baselineUnavailable ? undefined : this.#previous.get(model);
        const reset = prior !== undefined && (tokenKeys.some(key => current[key] < prior[key])
          || current.costMicros !== undefined && prior.costMicros !== undefined && current.costMicros < prior.costMicros);
        resetObserved ||= reset;
        const unbaselined = prior === undefined || reset;
        const observedKey = observedOwners.get(model);
        const independentlyObserved = observedKey === undefined ? undefined : observed.get(observedKey);
        const matches = independentlyObserved !== undefined && tokenKeys.every(key => current[key] === independentlyObserved[key]);
        const startsAtZero = this.#startsAtZero && !this.#baselineUnavailable;
        // First/resumed or rolled-back snapshots establish a native baseline. Only an
        // actual zero-origin Query or independently matching requests can prove their money.
        const rawContribution = unbaselined
          ? startsAtZero ? current : independentlyObserved ?? emptyTokens()
          : difference(current, prior);
        const scopeMismatch = independentlyObserved !== undefined && tokenKeys.some(key => unbaselined
          ? startsAtZero && rawContribution[key] < independentlyObserved[key]
          : rawContribution[key] !== independentlyObserved[key]);
        if (unbaselined && !startsAtZero && !matches || scopeMismatch) this.#uncertainModels.add(model);
        const contribution = scopeMismatch || !unbaselined && this.#uncertainModels.has(model)
          ? independentlyObserved ?? emptyTokens() : rawContribution;
        const contributionScopeProven = !scopeMismatch && (!this.#uncertainModels.has(model)
          || independentlyObserved !== undefined && tokenKeys.every(key => rawContribution[key] === independentlyObserved[key])
          || tokenKeys.every(key => rawContribution[key] === 0));
        if (!contributionScopeProven) {
          tokensComplete = false;
          moneyScopeProven = false;
          this.#suppressNextMoney = true;
        }
        delta = add(delta, contribution);
        if (observedKey !== undefined) included.add(observedKey);
        next.set(model, current);
        const moneyKnown = contributionScopeProven && current.costMicros !== undefined && (unbaselined
          ? startsAtZero || matches : prior.costMicros !== undefined);
        modelDeltas.set(model, { ...contribution,
          costMicros: moneyKnown ? unbaselined ? current.costMicros! : current.costMicros! - prior.costMicros! : 0,
          tokensComplete: contributionScopeProven && (!unbaselined || startsAtZero || matches), costComplete: moneyKnown });
        if (moneyKnown) deltaCost = safeAdd(deltaCost, unbaselined ? current.costMicros! : current.costMicros! - prior.costMicros!);
        else costComplete = false;
        if (unbaselined && !startsAtZero && !matches) {
          tokensComplete = false;
          firstSnapshotProven = false;
          moneyScopeProven = false;
          this.#suppressNextMoney = true;
        }
        if (!unbaselined) firstSnapshotProven = false;
      }
    } else {
      this.#baselineUnavailable = true;
      firstSnapshotProven = false;
    }
    if (modelSnapshotValid && this.#startsAtZero && !this.#baselineUnavailable) {
      // A zero-origin snapshot already includes these requests even when its
      // variant buckets cannot be individually joined to the assistant model.
      for (const name of ambiguousObserved) included.add(name);
    }
    for (const [model, tokens] of observed) if (!included.has(model)) {
      delta = add(delta, tokens);
      if (this.#modelTotals.has(model) || modelDeltas.has(model) || modelDeltas.size < 256) modelDeltas.set(model, { ...tokens, costMicros: 0, tokensComplete: false, costComplete: false });
      tokensComplete = false;
      costComplete = false;
      firstSnapshotProven = false;
    }
    const fallback = nativeTokens(value["usage"]);
    if (models !== undefined && Object.keys(models).length === 0 && (fallback !== undefined && tokenKeys.some(key => fallback[key] > 0)
      || observed.size > 0)) { tokensComplete = false; costComplete = false; firstSnapshotProven = false; }
    if (tokenKeys.every(key => delta[key] === 0) && observed.size === 0 && fallback !== undefined
      && (models === undefined || !tokensComplete)) {
      // SDK result.usage is a current-turn main-loop observation, not inclusive accounting.
      delta = fallback;
      tokensComplete = false;
      costComplete = false;
    }
    if (totalCost !== undefined && moneyScopeProven && (this.#startsAtZero && !this.#hasResult
      || !this.#hasResult && firstSnapshotProven
      || this.#previousTotalCost !== undefined && !resetObserved && totalCost >= this.#previousTotalCost)) {
      deltaCost = this.#previousTotalCost === undefined ? totalCost : totalCost - this.#previousTotalCost;
      costComplete = true;
    }
    if (!moneyScopeProven) { deltaCost = 0; costComplete = false; }
    const namedCost = [...modelDeltas.values()].reduce((sum, item) => safeAdd(sum, item.costMicros), 0);
    const namedMoneyProven = moneyScopeProven && namedCost <= deltaCost;
    for (const [model, item] of modelDeltas) {
      const previous = this.#modelTotals.get(model);
      if (!previous && this.#modelTotals.size >= 256) continue;
      this.#modelTotals.set(model, { ...add(previous ?? emptyTokens(), item),
        costMicros: safeAdd(previous?.costMicros ?? 0, namedMoneyProven ? item.costMicros : 0) });
    }
    const requestGroups = new Map<string, NativeUsageRequest[]>();
    for (const request of closed.values()) {
      if (ambiguousObserved.has(request.modelId)) continue;
      const candidates = modelDeltas.has(request.modelId) ? [request.modelId]
        : [...modelDeltas.keys()].filter(model => model.replace(/\[[^\]]*\]\s*$/u, "") === request.modelId.replace(/\[[^\]]*\]\s*$/u, ""));
      if (candidates.length !== 1 || this.#referenceRequests.has(request.requestId)) continue;
      const modelId = candidates[0]!, requests = requestGroups.get(modelId) ?? [];
      requests.push({ ...request, modelId }); requestGroups.set(modelId, requests);
    }
    for (const [modelId, requests] of requestGroups) {
      const sum = requests.reduce((sum, request) => add(sum, request), emptyTokens()), contribution = modelDeltas.get(modelId)!;
      if (tokenKeys.some(key => sum[key] > contribution[key]) || !this.#modelTotals.has(modelId)) continue;
      for (const request of requests) {
        if (this.#referenceRequests.size >= 4096) break;
        this.#referenceRequests.set(request.requestId, request);
      }
    }
    this.#previousTotalCost = totalCost;
    this.#previous = next;
    this.#baselineUnavailable = !modelSnapshotValid;
    this.#hasResult = true;
    this.#total = add(this.#total, delta);
    this.#costMicros = safeAdd(this.#costMicros, deltaCost);
    this.#hasContribution ||= tokenKeys.some(key => delta[key] > 0) || deltaCost > 0;
    if (!this.#hasContribution) return undefined;
    return { ...this.#total, totalTokens: safeAdd(this.#total.inputTokens, this.#total.outputTokens), cost: this.#costMicros / 1_000_000,
      nativeAccounting: { sourceId: this.sourceId, tokensComplete, costComplete, costEstimated: true,
        ...(this.#referenceRequests.size === 0 ? {} : { requests: [...this.#referenceRequests.values()] }),
        models: [...this.#modelTotals].map(([modelId, totals]) => ({ modelId, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
          totalTokens: safeAdd(totals.inputTokens, totals.outputTokens), cost: (totals.costMicros ?? 0) / 1_000_000,
          tokensComplete: modelDeltas.get(modelId)?.tokensComplete ?? true,
          costComplete: modelDeltas.has(modelId) ? namedMoneyProven && modelDeltas.get(modelId)!.costComplete : true
        })) } };
  }
}

function nativeTokens(value: unknown): Tokens | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  const inputTokens = counter(usage["input_tokens"]);
  const outputTokens = counter(usage["output_tokens"]);
  const cacheReadTokens = counter(usage["cache_read_input_tokens"] ?? 0);
  const cacheWriteTokens = counter(usage["cache_creation_input_tokens"] ?? 0);
  return inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined
    ? undefined : { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function modelTokens(value: unknown): ModelUsage | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  const inputTokens = counter(usage["inputTokens"]);
  const outputTokens = counter(usage["outputTokens"]);
  const cacheReadTokens = counter(usage["cacheReadInputTokens"] ?? 0);
  const cacheWriteTokens = counter(usage["cacheCreationInputTokens"] ?? 0);
  const costMicros = nativeCostMicros(usage["costUSD"]);
  return inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined
    ? undefined : { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...(costMicros === undefined ? {} : { costMicros }) };
}

function nativeCostMicros(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return counter(Math.round(value * 1_000_000));
}

function difference(current: Tokens, previous: Tokens): Tokens {
  return { inputTokens: current.inputTokens - previous.inputTokens, outputTokens: current.outputTokens - previous.outputTokens,
    cacheReadTokens: current.cacheReadTokens - previous.cacheReadTokens, cacheWriteTokens: current.cacheWriteTokens - previous.cacheWriteTokens };
}

function add(left: Tokens, right: Tokens): Tokens {
  return { inputTokens: safeAdd(left.inputTokens, right.inputTokens), outputTokens: safeAdd(left.outputTokens, right.outputTokens),
    cacheReadTokens: safeAdd(left.cacheReadTokens, right.cacheReadTokens), cacheWriteTokens: safeAdd(left.cacheWriteTokens, right.cacheWriteTokens) };
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Native accounting exceeded its exact display range.");
  return value;
}
