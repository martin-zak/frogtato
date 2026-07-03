// Pure interpolation utility — no Phaser imports, no side effects.
//
// Client-side smoothing per DESIGN §9: render everything at
// `now - INTERP_DELAY_MS`, lerping between the two snapshots that bracket
// that render time. Works generically over any entity array keyed by `id`
// (players now; enemies/projectiles/flies reuse this in later tasks).
//
// Rules:
//  - An entity present in both bracketing snapshots is lerped between its
//    two positions.
//  - An entity present in only one of the two bracketing snapshots (just
//    appeared / about to disappear) renders at that snapshot's position —
//    no extrapolation.
//  - An entity absent from both bracketing snapshots is omitted.

import type { TimedSnapshot } from "./net.js";

/** Minimal shape required to interpolate an entity's position. */
export interface PositionedEntity {
  id: string;
  x: number;
  y: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolates one entity array between an older and newer snapshot.
 * Non-positional fields (hp, kind, etc.) are taken from whichever bracket
 * has the entity when only one does; when both do, they're taken from the
 * newer snapshot (positions are overwritten with the lerped value).
 */
export function interpolateEntities<T extends PositionedEntity>(
  older: readonly T[],
  newer: readonly T[],
  t: number,
): T[] {
  const olderById = new Map(older.map((e) => [e.id, e] as const));
  const newerById = new Map(newer.map((e) => [e.id, e] as const));

  const ids = new Set<string>();
  for (const id of olderById.keys()) ids.add(id);
  for (const id of newerById.keys()) ids.add(id);

  const result: T[] = [];
  for (const id of ids) {
    const a = olderById.get(id);
    const b = newerById.get(id);
    if (a && b) {
      result.push({ ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
    } else if (b) {
      result.push(b);
    } else if (a) {
      result.push(a);
    }
  }
  return result;
}

interface Bracket {
  older: TimedSnapshot;
  newer: TimedSnapshot;
  /** Interpolation factor in [0, 1]; 0 == older, 1 == newer. */
  t: number;
}

/**
 * Finds the two snapshots bracketing `renderTime`. If `renderTime` falls
 * outside the buffered range, clamps to the nearest edge snapshot (older ==
 * newer, t == 0) rather than extrapolating.
 */
export function findBracket(
  buffer: readonly TimedSnapshot[],
  renderTime: number,
): Bracket | null {
  if (buffer.length === 0) return null;
  if (buffer.length === 1) {
    return { older: buffer[0], newer: buffer[0], t: 0 };
  }

  const first = buffer[0];
  const last = buffer[buffer.length - 1];

  if (renderTime <= first.recvAt) {
    return { older: first, newer: first, t: 0 };
  }
  if (renderTime >= last.recvAt) {
    return { older: last, newer: last, t: 0 };
  }

  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i];
    const b = buffer[i + 1];
    if (renderTime >= a.recvAt && renderTime <= b.recvAt) {
      const span = b.recvAt - a.recvAt;
      const t = span === 0 ? 0 : (renderTime - a.recvAt) / span;
      return { older: a, newer: b, t };
    }
  }

  // Unreachable given the checks above, but keep it total.
  return { older: last, newer: last, t: 0 };
}

export interface InterpolatedState {
  players: import("@frogtato/shared").PlayerSnap[];
  enemies: import("@frogtato/shared").EnemySnap[];
  projectiles: import("@frogtato/shared").ProjectileSnap[];
  flies: import("@frogtato/shared").FlySnap[];
  phase: import("@frogtato/shared").Phase | null;
  wave: number | undefined;
}

/**
 * Full-snapshot convenience wrapper around `interpolateEntities` +
 * `findBracket`: given the client's snapshot ring buffer and a render
 * timestamp, returns every entity array lerped to that instant.
 */
export function interpolateSnapshot(
  buffer: readonly TimedSnapshot[],
  renderTime: number,
): InterpolatedState {
  const bracket = findBracket(buffer, renderTime);
  if (!bracket) {
    return { players: [], enemies: [], projectiles: [], flies: [], phase: null, wave: undefined };
  }
  const { older, newer, t } = bracket;
  return {
    players: interpolateEntities(older.snapshot.players, newer.snapshot.players, t),
    enemies: interpolateEntities(older.snapshot.enemies, newer.snapshot.enemies, t),
    projectiles: interpolateEntities(older.snapshot.projectiles, newer.snapshot.projectiles, t),
    flies: interpolateEntities(older.snapshot.flies, newer.snapshot.flies, t),
    phase: newer.snapshot.phase,
    wave: newer.snapshot.wave,
  };
}
