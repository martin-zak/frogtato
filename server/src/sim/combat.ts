// Damage resolution shared by every source of damage in the game: wasp contact,
// snail acid globs (T5), and player weapons (T6). Also owns the collision-radius
// tuning table (DESIGN gives HP/speed/damage numbers but no sprite/collision
// radii, so these are picked here — not in constants.ts — and commented as
// tuning; promote to constants.ts if they need per-balance-pass tweaking later).

import type { EnemyKind, GameEvent } from '@frogtato/shared';
import type { PlayerState } from './players.js';

// Collision/visual radii (px). Roughly matched to the sprite sizes described in
// DESIGN §10 (frog ~48px circle, wasp/snail single sprites). Tune here.
export const PLAYER_RADIUS = 20;
export const WASP_RADIUS = 14;
export const SNAIL_RADIUS = 18;
export const ACID_PROJECTILE_RADIUS = 8;
export const BUBBLE_PROJECTILE_RADIUS = 8;

// Phase 2 P1 mechanical addition: heron/snailking radii, picked to keep this
// Record<EnemyKind, number> exhaustive so tsc -b stays green. Same
// tuning-not-balance status as the rest of this table — P3 (server heron &
// boss) owns getting these right.
export const HERON_RADIUS = 16;
export const SNAIL_KING_RADIUS = 54; // "scaled sprite x3" per DESIGN-PHASE2.md §4 (18 * 3)

export const ENEMY_RADIUS: Readonly<Record<EnemyKind, number>> = {
  wasp: WASP_RADIUS,
  snail: SNAIL_RADIUS,
  heron: HERON_RADIUS,
  snailking: SNAIL_KING_RADIUS,
};

export interface DamagePlayerResult {
  /** False if the hit was ignored entirely (already downed/spectating). */
  applied: boolean;
  newlyDowned: boolean;
}

/**
 * Applies damage to a player: emits `playerHit`, and on hp<=0 sets `downed`
 * and emits `playerDowned` (DESIGN §2: downed = spectates for the rest of the
 * wave; revive is T8's job — this function never revives). No-op on players
 * already downed/spectating. Invincibility (debug-only) is the caller's
 * responsibility to check before calling this, since that flag isn't part of
 * PlayerState.
 */
export function damagePlayer(
  player: PlayerState,
  amount: number,
  emit: (event: GameEvent) => void,
): DamagePlayerResult {
  if (player.downed || player.spectator || !player.connected) return { applied: false, newlyDowned: false };

  player.hp = Math.max(0, player.hp - amount);
  emit({ type: 'playerHit', playerId: player.id, amount });

  if (player.hp <= 0) {
    player.downed = true;
    emit({ type: 'playerDowned', playerId: player.id });
    return { applied: true, newlyDowned: true };
  }
  return { applied: true, newlyDowned: false };
}

/**
 * Entry point for dealing damage to an enemy — T6's weapon hit-resolution
 * calls this too, and the debug `kill` message uses it with amount=Infinity.
 * Mutates `enemy.hp` in place (pass the real EnemyState, not a copy). On
 * death emits `enemyDied` and drops `flyDropCount` fly entities via
 * `spawnFlies`. Returns true if this call killed the enemy.
 *
 * Takes plain fields instead of the enemies.ts EnemyState type so this module
 * has zero dependency on sim/enemies.ts (keeps the dependency graph one-way:
 * enemies.ts -> combat.ts, never the reverse).
 */
export function damageEnemy(
  enemy: { id: string; x: number; y: number; hp: number },
  kind: EnemyKind,
  flyDropCount: number,
  amount: number,
  emit: (event: GameEvent) => void,
  spawnFlies: (x: number, y: number, count: number) => void,
): boolean {
  if (enemy.hp <= 0) return false;
  enemy.hp -= amount;
  if (enemy.hp <= 0) {
    emit({ type: 'enemyDied', enemyId: enemy.id, kind, x: enemy.x, y: enemy.y });
    spawnFlies(enemy.x, enemy.y, flyDropCount);
    return true;
  }
  return false;
}
