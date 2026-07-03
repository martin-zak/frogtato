// Enemy entities: state, spawn-point selection, and per-tick AI (DESIGN §5).
//
// T5's interim spawner (fixed cadence/cap, alternating wasp/snail) lived here
// and has been deleted per PLAN.md T8 — replaced wholesale by
// game/waves.ts's WaveDirector, which reuses `pickEnemySpawnPoint` below (the
// same arena-edge / min-distance-from-players logic the interim spawner used).

import { ARENA, ENEMY_DEFS, type EnemyKind, type EnemySnap } from '@frogtato/shared';
import { PLAYER_RADIUS, WASP_RADIUS, ACID_PROJECTILE_RADIUS } from './combat.js';
import type { PlayerState } from './players.js';
import { spawnProjectileTowards, type ProjectileState } from './projectiles.js';

export type EnemyTypeInternal = 'wasp' | 'snailSpitter';

export interface EnemyState {
  id: string;
  type: EnemyTypeInternal;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Wasp only: remaining time before this wasp can deal contact damage again. */
  contactCooldownRemainingSec: number;
  /** Snail only: remaining time before it can fire its next acid glob. */
  spitCooldownRemainingSec: number;
}

/**
 * The protocol (messages.ts EnemyKind) uses short names ("wasp"/"snail") while
 * the balance data (constants.ts EnemyType) uses "wasp"/"snailSpitter" — same
 * split as WEAPON_KIND_BY_TYPE in sim/players.ts. Protocol glue, not balance.
 */
export const ENEMY_KIND_BY_TYPE: Record<EnemyTypeInternal, EnemyKind> = {
  wasp: 'wasp',
  snailSpitter: 'snail',
};

export function createEnemy(id: string, type: EnemyTypeInternal, x: number, y: number): EnemyState {
  const def = ENEMY_DEFS[type];
  return {
    id,
    type,
    x,
    y,
    hp: def.hp,
    maxHp: def.hp,
    contactCooldownRemainingSec: 0,
    // Start snails on a full cooldown so they don't spit the instant they spawn.
    spitCooldownRemainingSec: type === 'snailSpitter' ? ENEMY_DEFS.snailSpitter.spitIntervalSec : 0,
  };
}

export function toEnemySnap(e: EnemyState): EnemySnap {
  return { id: e.id, kind: ENEMY_KIND_BY_TYPE[e.type], x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp };
}

// ---------------------------------------------------------------------------
// Spawn-point selection (DESIGN §5/§9): arena-edge points, retried to land
// >= ARENA.minEnemySpawnDistanceFromPlayers from every player.
// ---------------------------------------------------------------------------

function randomPointOnArenaEdge(): { x: number; y: number } {
  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;
  const angle = Math.random() * Math.PI * 2;
  return { x: cx + Math.cos(angle) * cx, y: cy + Math.sin(angle) * cy };
}

function farEnoughFromAllPlayers(x: number, y: number, players: Iterable<PlayerState>): boolean {
  for (const p of players) {
    if (Math.hypot(p.x - x, p.y - y) < ARENA.minEnemySpawnDistanceFromPlayers) return false;
  }
  return true;
}

/**
 * Picks a spawn point on the arena-edge ellipse, retried a few times to land
 * >= ARENA.minEnemySpawnDistanceFromPlayers from every player (falls back to
 * the last sampled point rather than stalling forever when the arena is
 * crowded). Used by game/waves.ts's WaveDirector for every enemy it spawns.
 */
export function pickEnemySpawnPoint(players: Iterable<PlayerState>): { x: number; y: number } {
  const playersArr = Array.from(players);
  let point = randomPointOnArenaEdge();
  for (let attempt = 0; attempt < 20; attempt++) {
    point = randomPointOnArenaEdge();
    if (farEnoughFromAllPlayers(point.x, point.y, playersArr)) break;
  }
  return point;
}

// ---------------------------------------------------------------------------
// AI (DESIGN §5)
// ---------------------------------------------------------------------------

function nearestLivingTarget(x: number, y: number, players: Iterable<PlayerState>): PlayerState | undefined {
  let best: PlayerState | undefined;
  let bestDist = Infinity;
  for (const p of players) {
    if (p.downed || p.spectator || !p.connected) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function moveToward(enemy: EnemyState, tx: number, ty: number, speed: number, dtSec: number): void {
  const dx = tx - enemy.x;
  const dy = ty - enemy.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  enemy.x += (dx / dist) * speed * dtSec;
  enemy.y += (dy / dist) * speed * dtSec;
}

export interface EnemyAiContext {
  players: Iterable<PlayerState>;
  dtSec: number;
  /** Called when a wasp overlaps its target and its contact cooldown allows a hit. */
  onContactDamage: (enemy: EnemyState, target: PlayerState) => void;
  spawnProjectile: (p: ProjectileState) => void;
  nextProjectileId: () => string;
}

/** Steps one enemy's AI + cooldowns for one tick. */
export function stepEnemyAi(enemy: EnemyState, ctx: EnemyAiContext): void {
  if (enemy.contactCooldownRemainingSec > 0) enemy.contactCooldownRemainingSec -= ctx.dtSec;
  if (enemy.spitCooldownRemainingSec > 0) enemy.spitCooldownRemainingSec -= ctx.dtSec;

  const target = nearestLivingTarget(enemy.x, enemy.y, ctx.players);
  if (!target) return; // no living, non-spectator player to target: hold position

  if (enemy.type === 'wasp') {
    stepWasp(enemy, target, ctx);
  } else {
    stepSnail(enemy, target, ctx);
  }
}

function stepWasp(enemy: EnemyState, target: PlayerState, ctx: EnemyAiContext): void {
  const def = ENEMY_DEFS.wasp;
  moveToward(enemy, target.x, target.y, def.speed, ctx.dtSec);

  const dist = Math.hypot(target.x - enemy.x, target.y - enemy.y);
  const overlapping = dist <= WASP_RADIUS + PLAYER_RADIUS;
  if (overlapping && enemy.contactCooldownRemainingSec <= 0) {
    enemy.contactCooldownRemainingSec = def.contactCooldownSec;
    ctx.onContactDamage(enemy, target);
  }
}

// Dead-zone around the snail's keep-distance so it doesn't jitter in/out every
// tick when sitting almost exactly at range. Tuning.
const SNAIL_DISTANCE_DEADZONE = 20; // px

function stepSnail(enemy: EnemyState, target: PlayerState, ctx: EnemyAiContext): void {
  const def = ENEMY_DEFS.snailSpitter;
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy);

  if (dist > def.keepDistance + SNAIL_DISTANCE_DEADZONE) {
    moveToward(enemy, target.x, target.y, def.speed, ctx.dtSec);
  } else if (dist < def.keepDistance - SNAIL_DISTANCE_DEADZONE) {
    // Retreat: move toward the point on the far side of the enemy from the target.
    moveToward(enemy, enemy.x - dx, enemy.y - dy, def.speed, ctx.dtSec);
  }

  if (enemy.spitCooldownRemainingSec <= 0) {
    enemy.spitCooldownRemainingSec = def.spitIntervalSec;
    ctx.spawnProjectile(
      spawnProjectileTowards({
        id: ctx.nextProjectileId(),
        kind: 'acid',
        x: enemy.x,
        y: enemy.y,
        targetX: target.x,
        targetY: target.y,
        speed: def.projectileSpeed,
        damage: def.projectileDamage,
        source: 'enemy',
        ownerId: enemy.id,
        radius: ACID_PROJECTILE_RADIUS,
      }),
    );
  }
}
