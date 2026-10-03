import { describe, expect, it } from 'vitest';

import {
  HLC_MAX_WALL_MS,
  MAX_VOICE_DICTIONARY_SYNC_BYTES,
  addManualEntry,
  buildStateVersionVector,
  createDictionaryMap,
  createEmptySyncState,
  createHlcClock,
  deleteTerms,
  dictionaryTermKey,
  findMaxHlc,
  formatHlc,
  gcTombstones,
  isCanonicalHlc,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  observeHlc,
  recordLearningEvent,
  renameTerm,
  replaceTermAliases,
  versionVectorDominates,
  type HlcClock,
  type VoiceDictionarySyncState,
} from './index.js';

interface Device {
  state: VoiceDictionarySyncState;
  clock: HlcClock;
}

function device(nodeId: string, wallMs = 1_000): Device {
  return { state: createEmptySyncState(), clock: createHlcClock(nodeId, wallMs) };
}

function learn(
  target: Device,
  text: string,
  nowMs: number,
  aliases: string[] = [],
  stage: 'candidate' | 'entry' = 'entry',
): void {
  const result = recordLearningEvent(target.state, target.clock, { text, aliases, stage, nowMs });
  target.state = result.state;
  target.clock = result.clock;
}

function cloneState(state: VoiceDictionarySyncState): VoiceDictionarySyncState {
  return JSON.parse(JSON.stringify(state)) as VoiceDictionarySyncState;
}

function firstIncarnation(state: VoiceDictionarySyncState) {
  const record = Object.values(state.records)[0]!;
  return Object.values(record.incarnations)[0]!;
}

describe('voice dictionary sync current-v1 state', () => {
  it('accepts only canonical, bounded state and never emits an invalid local clock', () => {
    const seeded = device('node-a');
    learn(seeded, 'Joko Runtime', 1_000, ['joko run time']);
    expect(isValidSyncState(seeded.state)).toBe(true);

    const extraField = cloneState(seeded.state) as VoiceDictionarySyncState & { legacy?: boolean };
    extraField.legacy = true;
    expect(isValidSyncState(extraField)).toBe(false);

    const wrongRecordKey = cloneState(seeded.state);
    const originalKey = Object.keys(wrongRecordKey.records)[0]!;
    wrongRecordKey.records['another term'] = wrongRecordKey.records[originalKey]!;
    delete wrongRecordKey.records[originalKey];
    expect(isValidSyncState(wrongRecordKey)).toBe(false);

    const fractionalTime = cloneState(seeded.state);
    firstIncarnation(fractionalTime).updatedAt = 1_000.5;
    expect(isValidSyncState(fractionalTime)).toBe(false);

    const reversedTime = cloneState(seeded.state);
    firstIncarnation(reversedTime).createdAt = 2_000;
    expect(isValidSyncState(reversedTime)).toBe(false);

    const unsafeCounter = cloneState(seeded.state);
    firstIncarnation(unsafeCounter).counters['node-a'] = Number.MAX_SAFE_INTEGER + 1;
    expect(isValidSyncState(unsafeCounter)).toBe(false);

    const mismatchedAliasKey = cloneState(seeded.state);
    const incarnation = firstIncarnation(mismatchedAliasKey);
    incarnation.aliases['wrong key'] = incarnation.aliases['joko run time']!;
    delete incarnation.aliases['joko run time'];
    expect(isValidSyncState(mismatchedAliasKey)).toBe(false);

    const oversized = createEmptySyncState();
    for (let index = 0; index < 10_000; index += 1) {
      const nodeId = `node-${index}-${'x'.repeat(92)}`;
      oversized.mutationVector[nodeId] = `0000000001.0000.${nodeId}`;
    }
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength)
      .toBeGreaterThan(MAX_VOICE_DICTIONARY_SYNC_BYTES);
    expect(isValidSyncState(oversized)).toBe(false);

    expect(() => createHlcClock('node-a', -1)).toThrow('hlc wall time is invalid');
    expect(() => createHlcClock('node-a', HLC_MAX_WALL_MS + 1)).toThrow('hlc wall time is invalid');
    expect(() => recordLearningEvent(seeded.state, seeded.clock, {
      text: 'Out of range', stage: 'entry', nowMs: Number.NaN,
    })).toThrow('dictionary mutation time is invalid');
    expect(isCanonicalHlc(formatHlc(createHlcClock('node-a', HLC_MAX_WALL_MS)))).toBe(true);
  });

  it('keeps prototype-member terms and node identities as ordinary dictionary data', () => {
    const target = device('__proto__');
    for (const [index, text] of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ].entries()) {
      const added = addManualEntry(target.state, target.clock, { text, nowMs: 1_000 + index });
      target.state = added.state;
      target.clock = added.clock;
    }

    expect(materializeDictionary(target.state).entries.map((entry) => entry.text).sort()).toEqual([
      '__proto__',
      'constructor',
      'hasOwnProperty',
      'toString',
      'valueOf',
    ]);
    const vector = buildStateVersionVector(target.state);
    expect(Object.getPrototypeOf(vector)).toBeNull();
    expect(vector['__proto__']).toBeTypeOf('string');
    expect(vector['constructor']).toBeUndefined();
    expect(versionVectorDominates(vector, vector)).toBe(true);
    expect(isValidSyncState(cloneState(target.state))).toBe(true);

    const other = device('constructor', 2_000);
    learn(other, 'Ordinary Term', 2_000, ['ordinary alias']);
    const merged = mergeSyncStates(cloneState(target.state), cloneState(other.state));
    expect(materializeDictionary(merged).entries.map((entry) => entry.text).sort()).toEqual([
      'Ordinary Term',
      '__proto__',
      'constructor',
      'hasOwnProperty',
      'toString',
      'valueOf',
    ]);
    expect(isValidSyncState(merged)).toBe(true);
  });
});

describe('voice dictionary sync convergence', () => {
  it('is associative, commutative, idempotent, and preserves each learning event exactly once', () => {
    for (const seed of [7, 42, 1_337]) {
      const random = createRandom(seed);
      const devices = Array.from({ length: 4 }, (_, index) => device(`node-${index}`, 10_000));
      const truth = new Map<string, number>();
      const delayed: Array<{ target: number; state: VoiceDictionarySyncState }> = [];
      let nowMs = 10_000;

      for (let step = 0; step < 240; step += 1) {
        nowMs += 1;
        const sourceIndex = Math.floor(random() * devices.length);
        const source = devices[sourceIndex]!;
        const roll = random();
        if (roll < 0.55) {
          const terms = ['Joko', 'Orca', '语音输入', 'device-link'];
          const text = terms[Math.floor(random() * terms.length)]!;
          learn(source, text, nowMs, [`${text} alias`], random() < 0.5 ? 'candidate' : 'entry');
          const key = dictionaryTermKey(text);
          truth.set(key, (truth.get(key) ?? 0) + 1);
        } else if (roll < 0.78) {
          const targetIndex = Math.floor(random() * devices.length);
          if (targetIndex !== sourceIndex) deliver(devices[targetIndex]!, source, nowMs);
        } else if (roll < 0.92) {
          const targetIndex = Math.floor(random() * devices.length);
          if (targetIndex !== sourceIndex) delayed.push({ target: targetIndex, state: source.state });
        } else if (delayed.length > 0) {
          const index = Math.floor(random() * delayed.length);
          const frame = delayed[index]!;
          devices[frame.target]!.state = mergeSyncStates(devices[frame.target]!.state, frame.state);
          if (random() < 0.5) delayed.splice(index, 1);
        }
      }

      const [a, b, c] = devices;
      expect(mergeSyncStates(a!.state, a!.state)).toEqual(a!.state);
      expect(mergeSyncStates(a!.state, b!.state)).toEqual(mergeSyncStates(b!.state, a!.state));
      expect(mergeSyncStates(mergeSyncStates(a!.state, b!.state), c!.state)).toEqual(
        mergeSyncStates(a!.state, mergeSyncStates(b!.state, c!.state)),
      );

      for (let round = 0; round < devices.length + 1; round += 1) {
        for (const target of devices) {
          for (const source of devices) if (target !== source) deliver(target, source, nowMs += 1);
        }
      }

      const expected = materializeDictionary(devices[0]!.state);
      for (const target of devices) {
        expect(materializeDictionary(target.state)).toEqual(expected);
        const totals = new Map([
          ...materializeDictionary(target.state).entries.map((item) => [dictionaryTermKey(item.text), item.frequency] as const),
          ...materializeDictionary(target.state).candidates.map((item) => [dictionaryTermKey(item.text), item.evidenceCount] as const),
        ]);
        expect(totals).toEqual(truth);
      }
    }
  });

  it('saturates counters instead of producing local state that its own ingress rejects', () => {
    const target = device('node-a');
    learn(target, 'Bounded Term', 1_000, ['bounded alias']);
    const incarnation = firstIncarnation(target.state);
    incarnation.counters['node-a'] = Number.MAX_SAFE_INTEGER;
    incarnation.aliases['bounded alias']!.counters['node-a'] = Number.MAX_SAFE_INTEGER;
    expect(isValidSyncState(target.state)).toBe(true);

    learn(target, 'Bounded Term', 1_001, ['bounded alias']);
    const entry = materializeDictionary(target.state).entries[0]!;
    expect(entry.frequency).toBe(Number.MAX_SAFE_INTEGER);
    expect(entry.aliases[0]!.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(isValidSyncState(target.state)).toBe(true);
  });
});

describe('voice dictionary sync deletion and manual intent', () => {
  it('propagates observed deletes without reviving stale evidence and lets a new manual incarnation win', () => {
    const a = device('node-a');
    const b = device('node-b', 2_000);
    learn(a, 'Orca', 1_000, ['okra']);
    b.state = mergeSyncStates(b.state, a.state);

    const removed = deleteTerms(a.state, a.clock, { termKeys: ['orca'], nowMs: 2_000 });
    a.state = removed.state;
    a.clock = removed.clock;
    learn(b, 'Orca', 2_100, ['okra']);

    const deleted = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(deleted).entries).toEqual([]);
    expect(materializeDictionary(deleted).suppressedAutomaticTexts).toEqual(['Orca']);

    const restored = addManualEntry(deleted, a.clock, { text: 'Orca', nowMs: 3_000 });
    expect(materializeDictionary(restored.state).entries).toMatchObject([
      { text: 'Orca', source: 'manual', frequency: 1 },
    ]);
    expect(materializeDictionary(restored.state).suppressedAutomaticTexts).toEqual(['Orca']);
    expect(isValidSyncState(restored.state)).toBe(true);
  });

  it('does not suppress a deleted manual term and permits later automatic learning', () => {
    const target = device('node-a');
    const added = addManualEntry(target.state, target.clock, { text: 'Manual Term', nowMs: 1_000 });
    const removed = deleteTerms(added.state, added.clock, { termKeys: ['manual term'], nowMs: 2_000 });
    expect(materializeDictionary(removed.state).suppressedAutomaticTexts).toEqual([]);

    const relearned = recordLearningEvent(removed.state, removed.clock, {
      text: 'Manual Term', stage: 'entry', nowMs: 3_000,
    });
    expect(materializeDictionary(relearned.state).entries).toMatchObject([
      { text: 'Manual Term', source: 'automatic', frequency: 1 },
    ]);
  });
});

describe('voice dictionary sync rename and alias edits', () => {
  it('deduplicates concurrent moves of the same evidence and preserves aliases', () => {
    const base = device('seed');
    for (let round = 0; round < 5; round += 1) learn(base, 'web coding', 1_000 + round, ['webcoding']);

    const a = renameTerm(base.state, createHlcClock('node-a', 5_000), {
      termKey: 'web coding', nextText: 'Vibe Coding', nowMs: 5_000,
    });
    const b = renameTerm(base.state, createHlcClock('node-b', 6_000), {
      termKey: 'web coding', nextText: 'Vibe Coding', nowMs: 6_000,
    });
    const forward = mergeSyncStates(a.state, b.state);
    const backward = mergeSyncStates(b.state, a.state);
    expect(backward).toEqual(forward);
    expect(materializeDictionary(forward).entries).toMatchObject([
      { text: 'Vibe Coding', frequency: 5, aliases: [{ text: 'webcoding', count: 5 }] },
    ]);
    expect(isValidSyncState(forward)).toBe(true);
  });

  it('keeps alias removals through stale replay, concurrent learning, and a rename chain', () => {
    const base = device('node-a');
    for (let round = 0; round < 4; round += 1) {
      learn(base, 'Vibe Coding', 1_000 + round, round < 3 ? ['web coding'] : ['vibe coating']);
    }

    const aliasesEdited = replaceTermAliases(base.state, createHlcClock('node-a', 3_000), {
      termKey: 'Vibe Coding', aliases: ['vibe coating'], nowMs: 3_000,
    });
    expect(materializeDictionary(mergeSyncStates(aliasesEdited.state, base.state)).entries[0]!.aliases)
      .toEqual([{ text: 'vibe coating', count: 1, lastSeenAt: 1_003 }]);

    const renamedOnce = renameTerm(base.state, createHlcClock('node-b', 4_000), {
      termKey: 'Vibe Coding', nextText: 'VibeCoder', nowMs: 4_000,
    });
    const renamedTwice = renameTerm(renamedOnce.state, renamedOnce.clock, {
      termKey: 'VibeCoder', nextText: 'VC', nowMs: 5_000,
    });
    const learned = recordLearningEvent(base.state, createHlcClock('node-c', 6_000), {
      text: 'Vibe Coding', aliases: ['fresh alias'], stage: 'entry', nowMs: 6_000,
    });

    const left = mergeSyncStates(
      mergeSyncStates(aliasesEdited.state, renamedTwice.state),
      learned.state,
    );
    const right = mergeSyncStates(
      aliasesEdited.state,
      mergeSyncStates(renamedTwice.state, learned.state),
    );
    expect(right).toEqual(left);
    expect(materializeDictionary(left).entries[0]).toMatchObject({
      text: 'VC',
      frequency: 4,
      aliases: expect.arrayContaining([
        expect.objectContaining({ text: 'fresh alias', count: 1 }),
        expect.objectContaining({ text: 'vibe coating', count: 1 }),
      ]),
    });
  });

  it('reuses fixed removal slots across repeated alias removal and re-addition', () => {
    const target = device('node-a');
    learn(target, 'Internal Name', 1_000, ['inside name']);
    for (let round = 0; round < 30; round += 1) {
      const removed = replaceTermAliases(target.state, target.clock, {
        termKey: 'Internal Name', aliases: [], nowMs: 2_000 + round * 2,
      });
      const restored = replaceTermAliases(removed.state, removed.clock, {
        termKey: 'Internal Name', aliases: ['inside name'], nowMs: 2_001 + round * 2,
      });
      target.state = restored.state;
      target.clock = restored.clock;
    }
    const removed = replaceTermAliases(target.state, target.clock, {
      termKey: 'Internal Name', aliases: [], nowMs: 3_000,
    });
    const aliases = firstIncarnation(removed.state).aliases;
    expect(Object.keys(aliases)).toHaveLength(2);
    expect(materializeDictionary(removed.state).entries[0]!.aliases).toEqual([]);

    const collected = gcTombstones(removed.state, { nowMs: 3_001, ttlMs: 0 });
    expect(firstIncarnation(collected).aliases).toEqual({});
    expect(isValidSyncState(collected)).toBe(true);
  });
});

describe('voice dictionary materialization', () => {
  it('maps deterministically to the bounded local dictionary fields', () => {
    const target = device('node-a');
    for (let term = 0; term < 5; term += 1) {
      for (let count = 0; count <= term; count += 1) {
        learn(target, `Term ${term}`, 1_000 + term * 20 + count, [`alias ${term}`]);
      }
    }
    const materialized = materializeDictionary(target.state, {
      maxEntries: 2,
      maxCandidates: 1,
      maxAliases: 1,
    });
    expect(materialized.entries.map((entry) => entry.text)).toEqual(['Term 4', 'Term 3']);
    expect(materialized.entries.every((entry) => entry.id.startsWith('dict-sync-'))).toBe(true);
    expect(new Set(materialized.entries.map((entry) => entry.id)).size).toBe(2);
    expect(materialized.entries.every((entry) => entry.aliases.length <= 1)).toBe(true);
    expect(materialized).toEqual({
      entries: materialized.entries,
      candidates: [],
      suppressedAutomaticTexts: [],
    });

    const longTerm = addManualEntry(createEmptySyncState(), createHlcClock('long-term', 3_000), {
      text: '词'.repeat(120),
      nowMs: 3_000,
    });
    const longId = materializeDictionary(longTerm.state).entries[0]!.id;
    expect(longId).toMatch(/^dict-sync-[a-f0-9]{64}$/u);
    expect(longId.length).toBeLessThanOrEqual(128);

    let suppressed = target;
    for (let index = 0; index < 3; index += 1) {
      const removed = deleteTerms(suppressed.state, suppressed.clock, {
        termKeys: [`term ${index}`],
        nowMs: 2_000 + index,
      });
      suppressed = { state: removed.state, clock: removed.clock };
    }
    expect(materializeDictionary(suppressed.state, {
      maxEntries: 2,
      maxCandidates: 1,
      maxAliases: 1,
    }).suppressedAutomaticTexts).toHaveLength(2);
  });
});

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deliver(target: Device, source: Device, nowMs: number): void {
  target.state = mergeSyncStates(target.state, source.state);
  const remote = findMaxHlc(source.state);
  if (remote) target.clock = observeHlc(target.clock, remote, nowMs);
}
