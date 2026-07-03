// Fly currency entities (DESIGN §7): dropped scattered at an enemy's death
// position, magnet toward a living player once within pickup radius, and are
// collected on contact (each fly entity = +1 to that player's fly count).

import { FROG_BASE_STATS, type FlySnap } from '@frogtato/shared';
import type { PlayerState } from './players.js';

export interface FlyState {
  id: string;
  x: number;
  y: number;
}

// Tuning (not in constants.ts — no magnet-speed number exists there). Picked
// to feel snappy relative to the fixed pickup radius (60px): crosses it in a
// fraction of a second once triggered. Tune here if it feels off.
export const FLY_MAGNET_SPEED = 600; // px/s

export const FLY_RADIUS = 6; // px, collision/visual — tuning, see combat.ts note.
const COLLECT_DISTANCE = FLY_RADIUS + 4; // px; "on contact"

// Flies dropped by one enemy death are scattered this far apart so they don't
// stack exactly on the death point.
const SCATTER_DIST_MIN = 10;
const SCATTER_DIST_MAX = 20;

export function spawnFliesAt(
  nextId: () => string,
  x: number,
  y: number,
  count: number,
  out: Map<string, FlyState>,
): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = SCATTER_DIST_MIN + Math.random() * (SCATTER_DIST_MAX - SCATTER_DIST_MIN);
    const fly: FlyState = { id: nextId(), x: x + Math.cos(angle) * dist, y: y + Math.sin(angle) * dist };
    out.set(fly.id, fly);
  }
}

/**
 * Steps every fly by dtSec: magnets toward the nearest living, non-spectator
 * player if within that player's pickup radius, and is collected (removed +
 * player.flies += 1) on contact. Flies with no player in range hold still.
 */
export function stepFlies(flies: Map<string, FlyState>, players: Iterable<PlayerState>, dtSec: number): void {
  const livingPlayers = Array.from(players).filter((p) => !p.downed && !p.spectator && p.connected);
  if (livingPlayers.length === 0) return;

  for (const fly of Array.from(flies.values())) {
    let target: PlayerState | undefined;
    let bestDist = Infinity;
    for (const p of livingPlayers) {
      const d = Math.hypot(p.x - fly.x, p.y - fly.y);
      if (d <= FROG_BASE_STATS.pickupRadius && d < bestDist) {
        bestDist = d;
        target = p;
      }
    }
    if (!target) continue;

    if (bestDist <= COLLECT_DISTANCE) {
      target.flies += 1;
      target.fliesCollected += 1;
      flies.delete(fly.id);
      continue;
    }

    const dx = target.x - fly.x;
    const dy = target.y - fly.y;
    const dist = Math.hypot(dx, dy) || 1;
    fly.x += (dx / dist) * FLY_MAGNET_SPEED * dtSec;
    fly.y += (dy / dist) * FLY_MAGNET_SPEED * dtSec;
  }
}

export function toFlySnap(f: FlyState): FlySnap {
  return { id: f.id, x: f.x, y: f.y };
}
