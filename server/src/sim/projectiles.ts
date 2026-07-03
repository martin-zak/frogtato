// Generic server-simulated projectile system (DESIGN §4/§5, §9). T5 uses this
// only for enemy acid-globs; T6 reuses it unchanged for player bubbles. This
// module deliberately knows nothing about players or enemies beyond the
// `source` tag — collision resolution (who a projectile is allowed to hit)
// lives in the caller (room.ts today; T6 extends the same pattern for
// player-sourced projectiles hitting enemies).

import { ARENA, type ProjectileKind } from '@frogtato/shared';

export type ProjectileSource = 'enemy' | 'player';

export interface ProjectileState {
  id: string;
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  source: ProjectileSource;
  /** id of the player or enemy that fired this, for future scoring/attribution. */
  ownerId: string;
  radius: number;
}

export interface SpawnProjectileArgs {
  id: string;
  kind: ProjectileKind;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  speed: number;
  damage: number;
  source: ProjectileSource;
  ownerId: string;
  radius: number;
}

/** Spawns a projectile at (x,y) travelling in a straight line toward (targetX,targetY). */
export function spawnProjectileTowards(args: SpawnProjectileArgs): ProjectileState {
  const dx = args.targetX - args.x;
  const dy = args.targetY - args.y;
  const dist = Math.hypot(dx, dy) || 1;
  return {
    id: args.id,
    kind: args.kind,
    x: args.x,
    y: args.y,
    vx: (dx / dist) * args.speed,
    vy: (dy / dist) * args.speed,
    damage: args.damage,
    source: args.source,
    ownerId: args.ownerId,
    radius: args.radius,
  };
}

/** Integrates one fixed sim step of straight-line motion. */
export function stepProjectile(p: ProjectileState, dtSec: number): void {
  p.x += p.vx * dtSec;
  p.y += p.vy * dtSec;
}

/** True if the point lies outside the arena ellipse. */
export function isOutsideArena(x: number, y: number): boolean {
  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;
  const rx = ARENA.width / 2;
  const ry = ARENA.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const norm = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  return norm > 1;
}

/** Circle-vs-circle overlap test, used for all hit detection (contact, projectiles, AoE). */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

export function toProjectileSnap(p: ProjectileState): { id: string; kind: ProjectileKind; x: number; y: number } {
  return { id: p.id, kind: p.kind, x: p.x, y: p.y };
}
