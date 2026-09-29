/** Fixed-width hybrid logical clocks keep local edits monotonic across clock rollback. */
const WALL_RADIX_LENGTH = 10;
export const HLC_MAX_WALL_MS = 36 ** WALL_RADIX_LENGTH - 1;

const COUNTER_RADIX_LENGTH = 4;
const COUNTER_MAX = 36 ** COUNTER_RADIX_LENGTH - 1;

export const HLC_PREFIX_LENGTH = WALL_RADIX_LENGTH + 1 + COUNTER_RADIX_LENGTH + 1;

export type HlcTimestamp = string;

export interface HlcClock {
  wallMs: number;
  counter: number;

  nodeId: string;
}

export function createHlcClock(nodeId: string, wallMs = 0): HlcClock {
  const normalizedNodeId = nodeId.trim();
  if (!isValidHlcNodeId(normalizedNodeId)) throw new Error('hlc nodeId is invalid');
  assertHlcWallMs(wallMs);
  return { wallMs, counter: 0, nodeId: normalizedNodeId };
}

export function isValidHlcNodeId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes('.')
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function formatHlc(clock: HlcClock): HlcTimestamp {
  assertHlcWallMs(clock.wallMs);
  if (!Number.isSafeInteger(clock.counter) || clock.counter < 0 || clock.counter > COUNTER_MAX) {
    throw new Error('hlc counter is invalid');
  }
  if (!isValidHlcNodeId(clock.nodeId)) throw new Error('hlc nodeId is invalid');
  const wall = clock.wallMs.toString(36).padStart(WALL_RADIX_LENGTH, '0');
  const counter = clock.counter.toString(36).padStart(COUNTER_RADIX_LENGTH, '0');
  return `${wall}.${counter}.${clock.nodeId}`;
}

export function isCanonicalHlc(value: unknown): value is HlcTimestamp {
  if (typeof value !== 'string') return false;
  const wallEnd = WALL_RADIX_LENGTH;
  const counterEnd = wallEnd + 1 + COUNTER_RADIX_LENGTH;
  if (value.length < counterEnd + 2) return false;
  if (value[wallEnd] !== '.' || value[counterEnd] !== '.') return false;
  if (!isBase36(value.slice(0, wallEnd)) || !isBase36(value.slice(wallEnd + 1, counterEnd))) {
    return false;
  }
  const nodeId = value.slice(counterEnd + 1);
  return isValidHlcNodeId(nodeId);
}

export function hlcNodeId(stamp: HlcTimestamp): string | null {
  if (!isCanonicalHlc(stamp)) return null;
  return stamp.slice(WALL_RADIX_LENGTH + 1 + COUNTER_RADIX_LENGTH + 1);
}

function isBase36(segment: string): boolean {
  for (const char of segment) {
    const isDigit = char >= '0' && char <= '9';
    const isLower = char >= 'a' && char <= 'z';
    if (!isDigit && !isLower) return false;
  }
  return segment.length > 0;
}

export function hlcWallMs(stamp: HlcTimestamp): number {
  const wall = stamp.slice(0, WALL_RADIX_LENGTH);
  const parsed = Number.parseInt(wall, 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxHlc(a: HlcTimestamp, b: HlcTimestamp): HlcTimestamp {
  return compareHlc(a, b) >= 0 ? a : b;
}

export function minHlc(a: HlcTimestamp, b: HlcTimestamp): HlcTimestamp {
  return compareHlc(a, b) <= 0 ? a : b;
}

export function tickHlc(clock: HlcClock, nowMs: number): { clock: HlcClock; stamp: HlcTimestamp } {
  assertHlcWallMs(nowMs);
  formatHlc(clock);
  const now = nowMs;
  const next: HlcClock = now > clock.wallMs
    ? { wallMs: now, counter: 0, nodeId: clock.nodeId }
    : { wallMs: clock.wallMs, counter: clock.counter + 1, nodeId: clock.nodeId };
  if (next.counter > COUNTER_MAX) {
    if (clock.wallMs >= HLC_MAX_WALL_MS) throw new Error('hlc clock is exhausted');
    const advanced = { wallMs: clock.wallMs + 1, counter: 0, nodeId: clock.nodeId };
    return { clock: advanced, stamp: formatHlc(advanced) };
  }
  return { clock: next, stamp: formatHlc(next) };
}

export function observeHlc(clock: HlcClock, remote: HlcTimestamp, nowMs: number): HlcClock {
  formatHlc(clock);
  if (!isCanonicalHlc(remote)) throw new Error('remote hlc timestamp is invalid');
  assertHlcWallMs(nowMs);
  const remoteWall = hlcWallMs(remote);
  const remoteCounter = readCounter(remote);
  const now = nowMs;
  const wallMs = Math.max(clock.wallMs, remoteWall, now);
  if (wallMs > clock.wallMs && wallMs > remoteWall) {
    return { wallMs, counter: 0, nodeId: clock.nodeId };
  }
  const counter = wallMs === clock.wallMs && wallMs === remoteWall
    ? Math.max(clock.counter, remoteCounter)
    : wallMs === remoteWall
      ? remoteCounter
      : clock.counter;
  return { wallMs, counter, nodeId: clock.nodeId };
}

function readCounter(stamp: HlcTimestamp): number {
  const start = WALL_RADIX_LENGTH + 1;
  const parsed = Number.parseInt(stamp.slice(start, start + COUNTER_RADIX_LENGTH), 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertHlcWallMs(value: number): asserts value is number {
  if (!Number.isSafeInteger(value) || value < 0 || value > HLC_MAX_WALL_MS) {
    throw new Error('hlc wall time is invalid');
  }
}
