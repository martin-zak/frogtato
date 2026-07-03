// Weapon slots, auto-targeting, and attack resolution (DESIGN §4, PLAN.md T6).
//
// Mirrors the structure of sim/enemies.ts's AI section: one step function per
// player per tick, driven from room.ts. Damage always flows through
// combat.damageEnemy (the single call-in for enemy damage, T5); projectiles are
// spawned through the generic, source-agnostic sim/projectiles.ts (already used
// by snail acid-globs — bubbles are the "player" source it was built to support).

import { ENEMY_DEFS, WEAPON_DEFS, type GameEvent, type WeaponKind } from '@frogtato/shared';
import * as combat from './combat.js';
import { WEAPON_KIND_BY_TYPE, type PlayerState } from './players.js';
import { ENEMY_KIND_BY_TYPE, type EnemyState } from './enemies.js';
import { spawnProjectileTowards, type ProjectileState } from './projectiles.js';

export interface WeaponContext {
  enemies: Map<string, EnemyState>;
  dtSec: number;
  emit: (event: GameEvent) => void;
  spawnProjectile: (p: ProjectileState) => void;
  nextProjectileId: () => string;
  spawnFlies: (x: number, y: number, count: number) => void;
}

/** Nearest living enemy within `range` (center-to-center distance), or undefined. */
function nearestLivingEnemyInRange(
  px: number,
  py: number,
  enemies: Map<string, EnemyState>,
  range: number,
): EnemyState | undefined {
  let best: EnemyState | undefined;
  let bestDist = Infinity;
  for (const e of enemies.values()) {
    const d = Math.hypot(e.x - px, e.y - py);
    if (d <= range && d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/**
 * Segment-circle test: walks the ray from (px,py) in direction (dirx,diry) (unit
 * vector) out to `range`, and returns the enemy whose collision circle it enters
 * first (smallest entry distance along the segment). Enemies the segment starts
 * inside of (player already overlapping the enemy) are treated as hit at t=0.
 */
function firstEnemyOnSegment(
  px: number,
  py: number,
  dirx: number,
  diry: number,
  range: number,
  enemies: Map<string, EnemyState>,
): EnemyState | undefined {
  let best: EnemyState | undefined;
  let bestT = Infinity;
  for (const e of enemies.values()) {
    const radius = combat.ENEMY_RADIUS[ENEMY_KIND_BY_TYPE[e.type]];
    const fx = e.x - px;
    const fy = e.y - py;
    const tClosest = fx * dirx + fy * diry;
    // Quick reject: enemy's closest approach to the infinite ray is behind the
    // segment start by more than its own radius, so it can't reach t=0..range.
    if (tClosest < -radius) continue;

    const closestDistSq = fx * fx + fy * fy - tClosest * tClosest;
    const radiusSq = radius * radius;
    if (closestDistSq > radiusSq) continue;

    const entryOffset = Math.sqrt(Math.max(0, radiusSq - closestDistSq));
    let t = tClosest - entryOffset;
    if (t < 0) t = 0;
    if (t > range) continue;

    if (t < bestT) {
      bestT = t;
      best = e;
    }
  }
  return best;
}

/**
 * Applies `amount` damage to `enemy` via combat.damageEnemy; removes it from
 * `enemies` on death. Also attributes the damage/kill to `player`'s scoreboard
 * counters (DESIGN §8 end-of-run scoreboard).
 */
function hitEnemy(player: PlayerState, enemy: EnemyState, amount: number, ctx: WeaponContext): void {
  const kind = ENEMY_KIND_BY_TYPE[enemy.type];
  const flyDrop = ENEMY_DEFS[enemy.type].flyDrop;
  player.damageDealt += amount;
  const died = combat.damageEnemy(enemy, kind, flyDrop, amount, ctx.emit, ctx.spawnFlies);
  if (died) {
    player.killCount += 1;
    ctx.enemies.delete(enemy.id);
  }
}

/** Tongue Lash: instant hit on the first enemy along the line toward `target`. */
function fireTongue(player: PlayerState, target: EnemyState, range: number, damage: number, ctx: WeaponContext): void {
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const dist = Math.hypot(dx, dy) || 1;
  const dirx = dx / dist;
  const diry = dy / dist;
  const hit = firstEnemyOnSegment(player.x, player.y, dirx, diry, range, ctx.enemies);
  if (hit) hitEnemy(player, hit, damage, ctx);
}

/** Bubble Blaster: spawns a player-source projectile toward the target's current position. */
function fireBubble(
  player: PlayerState,
  target: EnemyState,
  speed: number,
  damage: number,
  ctx: WeaponContext,
): void {
  const projectile = spawnProjectileTowards({
    id: ctx.nextProjectileId(),
    kind: 'bubble',
    x: player.x,
    y: player.y,
    targetX: target.x,
    targetY: target.y,
    speed,
    damage,
    source: 'player',
    ownerId: player.id,
    radius: combat.BUBBLE_PROJECTILE_RADIUS,
  });
  ctx.spawnProjectile(projectile);
}

/** Croak Nova: damages every living enemy within `radius` of the player. Returns whether any was hit. */
function fireCroak(player: PlayerState, radius: number, damage: number, ctx: WeaponContext): boolean {
  let hitAny = false;
  for (const enemy of Array.from(ctx.enemies.values())) {
    const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
    if (d > radius) continue;
    hitAny = true;
    hitEnemy(player, enemy, damage, ctx);
  }
  return hitAny;
}

/**
 * Steps one player's weapon slots for one tick: ticks cooldowns, and on a ready
 * slot acquires a target and fires per archetype (DESIGN §4). A slot that finds
 * no valid target (or, for croak, no enemy in its radius) stays ready — it does
 * not fire into the void and its cooldown is not reset.
 */
export function stepPlayerWeapons(player: PlayerState, ctx: WeaponContext): void {
  if (player.downed || player.spectator || !player.connected) return;

  for (let slot = 0; slot < player.weapons.length; slot++) {
    const slotDef = player.weapons[slot];
    if (!slotDef) continue;

    let cooldown = player.weaponCooldowns[slot] ?? 0;
    if (cooldown > 0) {
      cooldown = Math.max(0, cooldown - ctx.dtSec);
      player.weaponCooldowns[slot] = cooldown;
    }
    if (cooldown > 0) continue;

    const weaponDef = WEAPON_DEFS[slotDef.weapon];
    const levelStats = weaponDef.levels[slotDef.level];
    const kind: WeaponKind = WEAPON_KIND_BY_TYPE[slotDef.weapon];
    const damage = levelStats.damage * (1 + player.stats.damagePct);

    if (weaponDef.archetype === 'aoe') {
      const hitAny = fireCroak(player, levelStats.range, damage, ctx);
      if (!hitAny) continue; // no enemy in radius: stay ready
      player.weaponCooldowns[slot] = levelStats.cooldownSec;
      ctx.emit({ type: 'attack', playerId: player.id, slot, kind, targetX: player.x, targetY: player.y });
      continue;
    }

    const target = nearestLivingEnemyInRange(player.x, player.y, ctx.enemies, levelStats.range);
    if (!target) continue; // no enemy in range: stay ready

    if (weaponDef.archetype === 'melee') {
      fireTongue(player, target, levelStats.range, damage, ctx);
    } else {
      // ranged (bubble): projectileSpeed is always defined for this archetype (constants.ts).
      fireBubble(player, target, levelStats.projectileSpeed ?? 0, damage, ctx);
    }

    player.weaponCooldowns[slot] = levelStats.cooldownSec;
    ctx.emit({ type: 'attack', playerId: player.id, slot, kind, targetX: target.x, targetY: target.y });
  }
}
