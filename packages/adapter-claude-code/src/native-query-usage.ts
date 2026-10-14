import { randomUUID } from "node:crypto";
import type { UsageSnapshot } from "@joko/core";

interface Tokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface ModelUsage extends Tokens {
  readonly costMicros?: number;
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
  #costMicros = 0;
  #previousTotalCost?: number;
  #baselineUnavailable = false;
  #hasContribution = false;
  #hasResult = false;
  #suppressNextMoney = false;

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

  observeResult(envelope: unknown): UsageSnapshot | undefined {
    const value = record(envelope) ?? {};
    const models = record(value["modelUsage"]);
    const observed = this.#observed;
    this.#observed = new Map();
    const totalCost = nativeCostMicros(value["total_cost_usd"]);
    let delta: Tokens = emptyTokens();
    let deltaCost = 0;
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
    this.#previousTotalCost = totalCost;
    this.#previous = next;
    this.#baselineUnavailable = !modelSnapshotValid;
    this.#hasResult = true;
    this.#total = add(this.#total, delta);
    this.#costMicros = safeAdd(this.#costMicros, deltaCost);
    this.#hasContribution ||= tokenKeys.some(key => delta[key] > 0) || deltaCost > 0;
    if (!this.#hasContribution) return undefined;
    return { ...this.#total, totalTokens: safeAdd(this.#total.inputTokens, this.#total.outputTokens), cost: this.#costMicros / 1_000_000,
      nativeAccounting: { sourceId: this.sourceId, tokensComplete, costComplete, costEstimated: true } };
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
