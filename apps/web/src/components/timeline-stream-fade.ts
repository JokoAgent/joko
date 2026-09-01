/** Word-level fade for streaming Markdown. */

type FadeKind = "text" | "inline-code";

interface HastText {
  readonly type: "text";
  value: string;
}

interface HastElement {
  readonly type: "element";
  readonly tagName: string;
  properties?: Record<string, unknown>;
  children: HastContent[];
}

interface HastRoot {
  readonly type: "root";
  children: HastContent[];
}

type HastContent = HastText | HastElement | { readonly type: string; readonly [key: string]: unknown };
type HastParent = HastRoot | HastElement;

interface FadeSegment {
  readonly kind: FadeKind;
  readonly content: string;
}

interface PreviousSegment extends FadeSegment {
  readonly key: string;
}

export interface TimelineWordFadeState {
  nextId: number;
  previous: PreviousSegment[];
  startAtByKey: Map<string, number>;
  settled: Set<string>;
  now?: () => number;
}

export function createTimelineWordFadeState(): TimelineWordFadeState {
  return { nextId: 0, previous: [], startAtByKey: new Map(), settled: new Set() };
}

export function createTimelineWordFadeCandidate(state: TimelineWordFadeState): TimelineWordFadeState {
  return {
    nextId: state.nextId,
    previous: state.previous,
    startAtByKey: new Map(state.startAtByKey),
    settled: new Set(state.settled),
    now: state.now
  };
}

export function commitTimelineWordFadeCandidate(state: TimelineWordFadeState, candidate: TimelineWordFadeState): void {
  state.nextId = candidate.nextId;
  state.previous = candidate.previous;
  state.startAtByKey = new Map(candidate.startAtByKey);
  state.settled = new Set([...state.settled, ...candidate.settled]);
}

const STATE_CACHE_MAXIMUM = 64;
const stateCache = new Map<string, TimelineWordFadeState>();

export function timelineWordFadeState(key?: string): TimelineWordFadeState {
  if (key === undefined || key.length === 0) return createTimelineWordFadeState();
  const existing = stateCache.get(key);
  if (existing !== undefined) {
    stateCache.delete(key);
    stateCache.set(key, existing);
    return existing;
  }
  const state = createTimelineWordFadeState();
  stateCache.set(key, state);
  while (stateCache.size > STATE_CACHE_MAXIMUM) {
    const oldest = stateCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
  return state;
}

export function releaseTimelineWordFadeState(key?: string): void {
  if (key !== undefined) stateCache.delete(key);
}

export function markTimelineWordFadeSettled(
  state: TimelineWordFadeState,
  event: { readonly animationName: string; readonly currentTarget: { readonly dataset: DOMStringMap } }
): void {
  if (event.animationName !== "stream-word-in") return;
  const key = event.currentTarget.dataset.wfKey;
  if (key !== undefined) state.settled.add(key);
}

const SKIP_TAGS = new Set(["pre", "script", "style", "textarea"]);
const splitCache = new Map<string, readonly string[]>();
const SPLIT_CACHE_MAXIMUM = 500;
const wordSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "word" })
  : undefined;

export function splitTimelineFadeWords(text: string): readonly string[] {
  const cached = splitCache.get(text);
  if (cached !== undefined) {
    splitCache.delete(text);
    splitCache.set(text, cached);
    return cached;
  }
  const words: string[] = [];
  const segments = wordSegmenter === undefined
    ? text.split(/(\s+)/u)
    : [...wordSegmenter.segment(text)].map((segment) => segment.segment);
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment.trim().length === 0 && words.length > 0) words[words.length - 1] += segment;
    else words.push(segment);
  }
  splitCache.set(text, words);
  while (splitCache.size > SPLIT_CACHE_MAXIMUM) {
    const oldest = splitCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    splitCache.delete(oldest);
  }
  return words;
}

interface TextSlot {
  readonly kind: "text";
  readonly parent: HastParent;
  readonly index: number;
  readonly words: readonly string[];
  readonly segmentStart: number;
}

interface CodeSlot {
  readonly kind: "inline-code";
  readonly parent: HastParent;
  readonly index: number;
  readonly node: HastElement;
  readonly segmentStart: number;
}

type FadeSlot = TextSlot | CodeSlot;

interface MarkerSlot {
  readonly node: HastElement;
  readonly segmentStart: number;
  segmentEnd: number;
}

interface FadeCollection {
  readonly slots: FadeSlot[];
  readonly segments: FadeSegment[];
  readonly markers: MarkerSlot[];
}

function collectFadeSlots(parent: HastParent, collection: FadeCollection): void {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child?.type === "element") {
      const element = child as HastElement;
      if (SKIP_TAGS.has(element.tagName) || isKatex(element)) continue;
      if (element.tagName === "code") {
        collection.slots.push({ kind: "inline-code", parent, index, node: element, segmentStart: collection.segments.length });
        collection.segments.push({ kind: "inline-code", content: elementText(element) });
        continue;
      }
      if (element.tagName === "li") {
        const marker: MarkerSlot = { node: element, segmentStart: collection.segments.length, segmentEnd: collection.segments.length };
        collection.markers.push(marker);
        collectFadeSlots(element, collection);
        marker.segmentEnd = collection.segments.length;
        continue;
      }
      collectFadeSlots(element, collection);
      continue;
    }
    if (child?.type !== "text") continue;
    const text = child as HastText;
    const words = splitTimelineFadeWords(text.value);
    if (words.length === 0 || words.every((word) => word.trim().length === 0)) continue;
    const segmentStart = collection.segments.length;
    collection.slots.push({ kind: "text", parent, index, words, segmentStart });
    for (const word of words) if (word.trim().length > 0) collection.segments.push({ kind: "text", content: word });
  }
}

function isKatex(element: HastElement): boolean {
  const className = element.properties?.["className"];
  return Array.isArray(className) && className.some((value) => typeof value === "string" && value.startsWith("katex"));
}

function elementText(element: HastElement): string {
  return element.children.map((child) => child.type === "text"
    ? (child as HastText).value
    : child.type === "element" ? elementText(child as HastElement) : "").join("");
}

function assignFadeKeys(segments: readonly FadeSegment[], state: TimelineWordFadeState): readonly string[] {
  const unmatched = new Set(state.previous.keys());
  const byContent = new Map<string, number[]>();
  for (let index = state.previous.length - 1; index >= 0; index -= 1) {
    const lookup = fadeLookupKey(state.previous[index]!);
    const matches = byContent.get(lookup) ?? [];
    matches.push(index);
    byContent.set(lookup, matches);
  }
  const keys = segments.map((segment, index) => {
    const samePosition = state.previous[index];
    if (samePosition !== undefined
      && unmatched.has(index)
      && samePosition.kind === segment.kind
      && (samePosition.content === segment.content
        || segment.kind === "text" && samePosition.content.length > 0 && segment.content.startsWith(samePosition.content))) {
      unmatched.delete(index);
      return samePosition.key;
    }
    const matches = byContent.get(fadeLookupKey(segment));
    let previousIndex = matches?.pop();
    while (previousIndex !== undefined && !unmatched.has(previousIndex)) previousIndex = matches?.pop();
    if (previousIndex !== undefined) {
      unmatched.delete(previousIndex);
      return state.previous[previousIndex]!.key;
    }
    const key = `wf-${state.nextId}`;
    state.nextId += 1;
    return key;
  });
  state.previous = keys.map((key, index) => ({ ...segments[index]!, key }));
  return keys;
}

function fadeLookupKey(segment: FadeSegment): string {
  return `${segment.kind}\u0000${segment.content}`;
}

function fadeDelay(key: string, state: TimelineWordFadeState, now: number): number {
  const existing = state.startAtByKey.get(key);
  if (existing !== undefined) return Math.round(existing - now);
  state.startAtByKey.set(key, now);
  return 0;
}

function fadeNode(children: HastContent[], key: string, state: TimelineWordFadeState, now: number): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["stream-word"],
      style: `--wf-delay:${fadeDelay(key, state, now)}ms`,
      dataWfKey: key
    },
    children
  };
}

function slotIsSettled(slot: FadeSlot, keys: readonly string[], state: TimelineWordFadeState): boolean {
  if (slot.kind === "inline-code") return state.settled.has(keys[slot.segmentStart] ?? "");
  let segmentIndex = slot.segmentStart;
  for (const word of slot.words) {
    if (word.trim().length === 0) continue;
    if (!state.settled.has(keys[segmentIndex] ?? "")) return false;
    segmentIndex += 1;
  }
  return true;
}

function appendText(nodes: HastContent[], value: string): void {
  if (value.length === 0) return;
  const previous = nodes.at(-1);
  if (previous?.type === "text") (previous as HastText).value += value;
  else nodes.push({ type: "text", value });
}

function slotNodes(slot: FadeSlot, keys: readonly string[], state: TimelineWordFadeState, now: number): HastContent[] {
  if (slot.kind === "inline-code") return [fadeNode([slot.node], keys[slot.segmentStart] ?? "", state, now)];
  const nodes: HastContent[] = [];
  let segmentIndex = slot.segmentStart;
  for (const word of slot.words) {
    if (word.trim().length === 0) {
      appendText(nodes, word);
      continue;
    }
    const key = keys[segmentIndex] ?? "";
    segmentIndex += 1;
    if (state.settled.has(key)) appendText(nodes, word);
    else nodes.push(fadeNode([{ type: "text", value: word }], key, state, now));
  }
  return nodes;
}

/** Rehype attacher. It deliberately mutates only the per-render candidate. */
export function rehypeTimelineStreamFade(state: TimelineWordFadeState): (tree: HastRoot) => void {
  return (tree) => {
    const collection: FadeCollection = { slots: [], segments: [], markers: [] };
    collectFadeSlots(tree, collection);
    if (collection.segments.length === 0 && collection.markers.length === 0) return;
    const keys = assignFadeKeys(collection.segments, state);
    const now = (state.now ?? (() => performance.now()))();
    for (let slotIndex = collection.slots.length - 1; slotIndex >= 0; slotIndex -= 1) {
      const slot = collection.slots[slotIndex]!;
      if (slotIsSettled(slot, keys, state)) continue;
      slot.parent.children.splice(slot.index, 1, ...slotNodes(slot, keys, state, now));
    }
    for (const marker of collection.markers) {
      const key = marker.segmentEnd > marker.segmentStart ? keys[marker.segmentStart] : undefined;
      if (key !== undefined && state.settled.has(key)) continue;
      marker.node.properties = {
        ...marker.node.properties,
        dataStreamMarker: true,
        ...(key === undefined ? {} : { dataWfKey: key }),
        style: `--wf-delay:${key === undefined ? 0 : fadeDelay(key, state, now)}ms`
      };
    }
  };
}

export function timelineStreamFadeActive(streaming: boolean, enabled: boolean, reducedMotion: boolean): boolean {
  return streaming && enabled && !reducedMotion;
}
