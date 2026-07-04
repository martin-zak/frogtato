// Enemy entities: state, spawn-point selection, and per-tick AI (DESIGN §5,
// DESIGN-PHASE2.md §4).
//
// T5's interim spawner (fixed cadence/cap, alternating wasp/snail) lived here
// and has been deleted per PLAN.md T8 — replaced wholesale by
// game/waves.ts's WaveDirector, which reuses `pickEnemySpawnPoint` below (the
// same arena-edge / min-distance-from-players logic the interim spawner used).
//
// Phase 2 §4 (P3) adds two more enemy types here: the heron (circle ->
// telegraph -> swoop state machine) and the Snail King boss (chase + spread
// fire + periodic shell phase). Both stay inside the same EnemyState/
// EnemyTypeInternal shape as wasp/snailSpitter so every existing system
// (damage resolution, debug kill, wave-end cleanup, fly drops) keeps working
// on them for free — only the per-tick AI branches, in stepEnemyAi below.

import { ARENA, ENEMY_DEFS, ENEMY_HIT_STAGGER_SEC, type EnemyKind, type EnemySnap } from '@frogtato/shared';
import { PLAYER_RADIUS, WASP_RADIUS, ACID_PROJECTILE_RADIUS, HERON_RADIUS } from './combat.js';
import { clampToArenaEllipse, type PlayerState } from './players.js';
import { circlesOverlap, spawnProjectileTowards, type ProjectileState } from './projectiles.js';

export type EnemyTypeInternal = 'wasp' | 'snailSpitter' | 'heron' | 'snailKing';

/** Heron-only runtime state (Phase 2 §4): circle -> telegraph -> swoop -> circle. */
interface HeronRuntimeState {
  mode: 'circle' | 'telegraph' | 'swoop';
  /** Fixed per heron at spawn: which way it orbits. */
  direction: 1 | -1;
  /** Current orbit angle (radians) around the targeted player, circle mode only. */
  angle: number;
  /** Seconds remaining in the current mode (circle duration, or the 0.8s telegraph freeze). */
  modeTimer: number;
  /** Swoop-line endpoints, set when telegraph starts, cleared back to undefined on re-circle. */
  telegraph?: { x1: number; y1: number; x2: number; y2: number };
  swoopDirX: number;
  swoopDirY: number;
  /** Players already damaged by the current swoop (each hit at most once per swoop). */
  swoopHitPlayerIds: Set<string>;
}

/** Snail King-only runtime state (Phase 2 §4): chase + spread fire + shell cadence. */
interface BossRuntimeState {
  fireCooldownSec: number;
  /** Seconds until the next shell phase begins (only ticks while not currently shelled). */
  shellCooldownSec: number;
  /** >0 while the boss is in its shell phase (Armor `shellArmor`, EnemySnap.shelled=true). */
  shellRemainingSec: number;
}

export interface EnemyState {
  id: string;
  type: EnemyTypeInternal;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Velocity (px/s) measured from the last sim tick by room.ts — consumed
   * by weapons.ts for projectile intercept lead. */
  vx: number;
  vy: number;
  /** Hit-stagger: while > 0 the enemy is fully inert (movement + attacks). */
  staggerRemainingSec: number;
  /** Wasp only: remaining time before this wasp can deal contact damage again. */
  contactCooldownRemainingSec: number;
  /** Snail only: remaining time before it can fire its next acid glob. */
  spitCooldownRemainingSec: number;
  /** Heron only (Phase 2 §4). */
  heron?: HeronRuntimeState;
  /** Snail King only (Phase 2 §4). */
  boss?: BossRuntimeState;
}

/**
 * The protocol (messages.ts EnemyKind) uses short names ("wasp"/"snail"/
 * "heron"/"snailking") while the balance data (constants.ts EnemyType) uses
 * "wasp"/"snailSpitter"/"heron"/"snailKing" — same split as
 * WEAPON_KIND_BY_TYPE in sim/players.ts. Protocol glue, not balance.
 */
export const ENEMY_KIND_BY_TYPE: Record<EnemyTypeInternal, EnemyKind> = {
  wasp: 'wasp',
  snailSpitter: 'snail',
  heron: 'heron',
  snailKing: 'snailking',
};

/** Circling duration randomized 3-6s per heron per circle (DESIGN-PHASE2.md §4). */
function randomCircleDurationSec(): number {
  return 3 + Math.random() * 3;
}

export function createEnemy(id: string, type: EnemyTypeInternal, x: number, y: number): EnemyState {
  const def = ENEMY_DEFS[type];
  const enemy: EnemyState = {
    id,
    type,
    x,
    y,
    hp: def.hp,
    maxHp: def.hp,
    vx: 0,
    vy: 0,
    staggerRemainingSec: 0,
    contactCooldownRemainingSec: 0,
    // Start snails on a full cooldown so they don't spit the instant they spawn.
    spitCooldownRemainingSec: type === 'snailSpitter' ? ENEMY_DEFS.snailSpitter.spitIntervalSec : 0,
  };
  if (type === 'heron') {
    enemy.heron = {
      mode: 'circle',
      direction: Math.random() < 0.5 ? 1 : -1,
      angle: Math.random() * Math.PI * 2,
      modeTimer: randomCircleDurationSec(),
      swoopDirX: 0,
      swoopDirY: 0,
      swoopHitPlayerIds: new Set(),
    };
  }
  if (type === 'snailKing') {
    enemy.boss = {
      fireCooldownSec: ENEMY_DEFS.snailKing.spreadIntervalSec,
      shellCooldownSec: ENEMY_DEFS.snailKing.shellIntervalSec,
      shellRemainingSec: 0,
    };
  }
  return enemy;
}

/** Applies the Brotato-style hit-stagger on weapon damage. Boss-immune. */
export function applyHitStagger(enemy: EnemyState): void {
  if (enemy.type === 'snailKing') return;
  enemy.staggerRemainingSec = ENEMY_HIT_STAGGER_SEC;
}

export function toEnemySnap(e: EnemyState): EnemySnap {
  const snap: EnemySnap = { id: e.id, kind: ENEMY_KIND_BY_TYPE[e.type], x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp };
  if (e.heron?.mode === 'telegraph' && e.heron.telegraph) {
    snap.telegraph = e.heron.telegraph;
  }
  if (e.boss) {
    if (e.boss.shellRemainingSec > 0) snap.shelled = true;
  }
  return snap;
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

/**
 * Snail King spawn point (Phase 2 §4): "the arena edge farthest from the
 * players" — samples points around the arena-edge ellipse and picks the one
 * that maximizes the *minimum* distance to any player (farthest from the
 * nearest player).
 */
export function pickFarthestArenaEdgePoint(players: Iterable<PlayerState>): { x: number; y: number } {
  const playersArr = Array.from(players);
  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;
  const SAMPLE_COUNT = 36;

  let best = randomPointOnArenaEdge();
  let bestScore = -Infinity;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const angle = (i / SAMPLE_COUNT) * Math.PI * 2;
    const point = { x: cx + Math.cos(angle) * cx, y: cy + Math.sin(angle) * cy };
    let minDist = playersArr.length === 0 ? 0 : Infinity;
    for (const p of playersArr) {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestScore) {
      bestScore = minDist;
      best = point;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// AI (DESIGN §5, DESIGN-PHASE2.md §4)
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
  /** Heron swoop damage (Phase 2 §4): applies `amount` to `target` via
   * combat.damagePlayer (armor-respecting), once per player per swoop. */
  onSwoopDamage: (enemy: EnemyState, target: PlayerState, amount: number) => void;
  spawnProjectile: (p: ProjectileState) => void;
  nextProjectileId: () => string;
}

/** Steps one enemy's AI + cooldowns for one tick. */
export function stepEnemyAi(enemy: EnemyState, ctx: EnemyAiContext): void {
  // Hit-stagger (live playtest 2026-07-04): a staggered enemy is fully inert —
  // no movement, no attacks, cooldowns frozen. Snail King never gets staggered
  // (see applyHitStagger), so the boss fight is unaffected.
  if (enemy.staggerRemainingSec > 0) {
    enemy.staggerRemainingSec -= ctx.dtSec;
    return;
  }

  if (enemy.contactCooldownRemainingSec > 0) enemy.contactCooldownRemainingSec -= ctx.dtSec;
  if (enemy.spitCooldownRemainingSec > 0) enemy.spitCooldownRemainingSec -= ctx.dtSec;

  if (enemy.type === 'heron') {
    stepHeron(enemy, ctx);
    return;
  }
  if (enemy.type === 'snailKing') {
    stepSnailKing(enemy, ctx);
    return;
  }

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

  // Snails crawl on the pond floor — retreating must not take them outside
  // the arena (live playtest 2026-07-04). Flying enemies are exempt.
  const clamped = clampToArenaEllipse(enemy.x, enemy.y);
  enemy.x = clamped.x;
  enemy.y = clamped.y;

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

// ---------------------------------------------------------------------------
// Heron (Phase 2 §4): circle at range -> telegraph (0.8s freeze) -> swoop
// (straight line through the target, extended to the arena edge) -> circle.
// ---------------------------------------------------------------------------

// TUNING (live playtest 2026-07-04): 350 -> 280. At 350 the heron orbited
// outside tongue/croak reach at the far edge of bubble range and was
// effectively unhittable while circling; 280 keeps it out of melee range but
// comfortably inside bubble range.
const HERON_ORBIT_RADIUS = 280;

/**
 * Extends a line from (x1,y1) through (targetX,targetY) out to the arena
 * ellipse's far boundary (the swoop line, DESIGN-PHASE2.md §4: "extended to
 * arena edge"). Solves for the ray/ellipse intersection and takes the larger
 * (farther) root so the line continues past the target rather than stopping
 * on it.
 */
function computeSwoopLine(
  x1: number,
  y1: number,
  targetX: number,
  targetY: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = targetX - x1;
  const dy = targetY - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const dirX = dx / dist;
  const dirY = dy / dist;

  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;
  const rx = ARENA.width / 2;
  const ry = ARENA.height / 2;
  const ox = x1 - cx;
  const oy = y1 - cy;
  const a = (dirX * dirX) / (rx * rx) + (dirY * dirY) / (ry * ry);
  const b = 2 * ((ox * dirX) / (rx * rx) + (oy * dirY) / (ry * ry));
  const c = (ox * ox) / (rx * rx) + (oy * oy) / (ry * ry) - 1;
  const disc = b * b - 4 * a * c;

  let t = dist * 4; // fallback: well past the target if the quadratic degenerates
  if (disc >= 0 && a > 1e-9) {
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b + sqrtDisc) / (2 * a);
    const t2 = (-b - sqrtDisc) / (2 * a);
    t = Math.max(t1, t2);
    if (t <= 0) t = dist; // degenerate: just extend to the target itself
  }
  return { x1, y1, x2: x1 + dirX * t, y2: y1 + dirY * t };
}

function startTelegraph(enemy: EnemyState, state: HeronRuntimeState, target: PlayerState): void {
  state.mode = 'telegraph';
  state.modeTimer = ENEMY_DEFS.heron.telegraphSec;
  state.telegraph = computeSwoopLine(enemy.x, enemy.y, target.x, target.y);
}

function startSwoop(state: HeronRuntimeState): void {
  const line = state.telegraph!;
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const dist = Math.hypot(dx, dy) || 1;
  state.mode = 'swoop';
  state.swoopDirX = dx / dist;
  state.swoopDirY = dy / dist;
  state.swoopHitPlayerIds = new Set();
}

function endSwoop(state: HeronRuntimeState): void {
  // Re-circle (DESIGN-PHASE2.md §4). `angle` is left as-is — the next circle
  // tick derives x/y purely from angle+radius+target, so this causes one
  // brief position snap back onto the orbit circle, which is fine (matches
  // "re-circle" — it doesn't need to glide back).
  state.mode = 'circle';
  state.telegraph = undefined;
  state.modeTimer = randomCircleDurationSec();
}

function stepHeron(enemy: EnemyState, ctx: EnemyAiContext): void {
  const state = enemy.heron;
  if (!state) return;
  const def = ENEMY_DEFS.heron;

  if (state.mode === 'circle') {
    const target = nearestLivingTarget(enemy.x, enemy.y, ctx.players);
    if (!target) return; // hold position; don't burn the circle timer without a target

    const angularSpeedRadPerSec = def.circleSpeed / HERON_ORBIT_RADIUS;
    state.angle += state.direction * angularSpeedRadPerSec * ctx.dtSec;
    enemy.x = target.x + Math.cos(state.angle) * HERON_ORBIT_RADIUS;
    enemy.y = target.y + Math.sin(state.angle) * HERON_ORBIT_RADIUS;

    state.modeTimer -= ctx.dtSec;
    if (state.modeTimer <= 0) startTelegraph(enemy, state, target);
    return;
  }

  if (state.mode === 'telegraph') {
    // Freeze in place for telegraphSec (DESIGN-PHASE2.md §4).
    state.modeTimer -= ctx.dtSec;
    if (state.modeTimer <= 0) startSwoop(state);
    return;
  }

  // swoop: travel the recorded line at swoopSpeed, damaging each player
  // crossed once (armor-respecting via ctx.onSwoopDamage -> combat.damagePlayer).
  enemy.x += state.swoopDirX * def.swoopSpeed * ctx.dtSec;
  enemy.y += state.swoopDirY * def.swoopSpeed * ctx.dtSec;

  for (const p of ctx.players) {
    if (p.downed || p.spectator || !p.connected) continue;
    if (state.swoopHitPlayerIds.has(p.id)) continue;
    if (!circlesOverlap(enemy.x, enemy.y, HERON_RADIUS, p.x, p.y, PLAYER_RADIUS)) continue;
    state.swoopHitPlayerIds.add(p.id);
    ctx.onSwoopDamage(enemy, p, def.swoopDamage);
  }

  const line = state.telegraph!;
  const totalDist = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  const traveled = Math.hypot(enemy.x - line.x1, enemy.y - line.y1);
  if (traveled >= totalDist) endSwoop(state);
}

// ---------------------------------------------------------------------------
// Snail King (Phase 2 §4): slow chase, 3-glob aimed spread every
// spreadIntervalSec, periodic shell phase (armor handled by the caller's
// damage-mitigation path — this module only owns the shelled timing/flag).
// ---------------------------------------------------------------------------

const SPREAD_SIDE_ANGLE_RAD = (15 * Math.PI) / 180; // ±15°, DESIGN-PHASE2.md §4

function fireBossSpread(enemy: EnemyState, target: PlayerState, ctx: EnemyAiContext): void {
  const def = ENEMY_DEFS.snailKing;
  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const dist = Math.hypot(dx, dy) || 1;
  const baseAngle = Math.atan2(dy, dx);

  for (const offset of [-SPREAD_SIDE_ANGLE_RAD, 0, SPREAD_SIDE_ANGLE_RAD]) {
    const angle = baseAngle + offset;
    // Aim far along the rotated direction rather than at the player's exact
    // point, so the two side globs actually fan out instead of converging.
    const farX = enemy.x + Math.cos(angle) * dist * 4;
    const farY = enemy.y + Math.sin(angle) * dist * 4;
    ctx.spawnProjectile(
      spawnProjectileTowards({
        id: ctx.nextProjectileId(),
        kind: 'acid',
        x: enemy.x,
        y: enemy.y,
        targetX: farX,
        targetY: farY,
        speed: def.projectileSpeed,
        damage: def.projectileDamage,
        source: 'enemy',
        ownerId: enemy.id,
        radius: ACID_PROJECTILE_RADIUS,
      }),
    );
  }
}

function stepSnailKing(enemy: EnemyState, ctx: EnemyAiContext): void {
  const state = enemy.boss;
  if (!state) return;
  const def = ENEMY_DEFS.snailKing;

  if (state.shellRemainingSec > 0) {
    state.shellRemainingSec -= ctx.dtSec;
  } else {
    state.shellCooldownSec -= ctx.dtSec;
    if (state.shellCooldownSec <= 0) {
      state.shellRemainingSec = def.shellDurationSec;
      state.shellCooldownSec = def.shellIntervalSec;
    }
  }

  const target = nearestLivingTarget(enemy.x, enemy.y, ctx.players);
  if (!target) return;

  moveToward(enemy, target.x, target.y, def.speed, ctx.dtSec);
  // The boss is a crawler like regular snails — keep it inside the pond.
  const clamped = clampToArenaEllipse(enemy.x, enemy.y);
  enemy.x = clamped.x;
  enemy.y = clamped.y;

  state.fireCooldownSec -= ctx.dtSec;
  if (state.fireCooldownSec <= 0) {
    state.fireCooldownSec = def.spreadIntervalSec;
    fireBossSpread(enemy, target, ctx);
  }
}
