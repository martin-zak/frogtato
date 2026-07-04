// Per-player simulation: input storage, movement integration, arena clamping,
// and translation to the wire-format PlayerSnap. No networking, no timers here —
// this module is pure state + step functions so it can be unit-tested and reused
// by later tasks (weapons, downed/revive) without rewrites.

import {
  ARENA,
  classBaseStats,
  DEFAULT_CLASS,
  FROG_BASE_STATS,
  FROG_CLASSES,
  MAX_NAME_LENGTH,
  STARTING_WEAPON_SLOTS,
  type ClientMsg,
  type FrogClassId,
  type PlayerSnap,
  type WeaponKind,
  type WeaponLevel,
  type WeaponSlot,
} from '@frogtato/shared';

/**
 * The protocol (messages.ts) uses short weapon kind names ("tongue"/"bubble"/"croak")
 * in snapshots, while the balance data (constants.ts) uses full type names
 * ("tongueLash"/"bubbleBlaster"/"croakNova"). Both files are owned upstream (T2) and
 * intentionally kept independent of each other, so this mapping is protocol glue
 * (not a balance number) that has to live somewhere on the server. Exported because
 * weapons.ts (T6) needs it too for attack events.
 */
export const WEAPON_KIND_BY_TYPE: Record<WeaponSlot['weapon'], WeaponKind> = {
  tongueLash: 'tongue',
  bubbleBlaster: 'bubble',
  croakNova: 'croak',
};

/** Reverse of WEAPON_KIND_BY_TYPE — used by the debug `give` message (short kind -> full type). */
export const WEAPON_TYPE_BY_KIND: Record<WeaponKind, WeaponSlot['weapon']> = {
  tongue: 'tongueLash',
  bubble: 'bubbleBlaster',
  croak: 'croakNova',
};

export interface PlayerInputState {
  seq: number;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Server-internal player state — a superset of the wire-format PlayerSnap. */
export interface PlayerState {
  id: string;
  token: string;
  colorIndex: number;
  /** Defaults to DEFAULT_CLASS on first join; changeable in the lobby via
   * `pickClass` (P2 §1). classBaseStats() + the class's starting weapon are
   * applied on join/pick/run-reset via applyClassLoadout below. */
  class: FrogClassId;
  /** Lobby `setName` (DESIGN-PHASE2.md §5); undefined until a player sets one.
   * Sanitized (trimmed, control chars stripped, MAX_NAME_LENGTH-capped) server-side. */
  name: string | undefined;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  flies: number;
  downed: boolean;
  spectator: boolean;
  /** False while the underlying websocket is disconnected but the player's
   * state is still held for a possible reconnect (T11 reconnect grace). A
   * disconnected player is excluded from snapshots and every "active
   * player" gameplay check, but keeps weapons/stats/flies intact. */
  connected: boolean;
  weapons: (WeaponSlot | null)[];
  /** Per-slot remaining cooldown (sec), parallel array to `weapons`. T6. */
  weaponCooldowns: number[];
  /** armor/regen/pickupRadius (Phase 2 §2): armor is a flat damage reduction
   * applied in combat.ts's damagePlayer; regen ticks in game/phases.ts's
   * stepRegen (wave phase only); pickupRadius is read by sim/flies.ts. */
  stats: { damagePct: number; moveSpeed: number; maxHp: number; armor: number; regen: number; pickupRadius: number };
  ready: boolean;
  input: PlayerInputState;
  /** Run-lifetime scoreboard counters (DESIGN §8: 10s end-of-run scoreboard). Reset each new run. */
  killCount: number;
  damageDealt: number;
  fliesCollected: number;
  /** Regen accumulator (Phase 2 §2): seconds accrued toward the next +regen
   * HP tick (every 5s during wave phase). Reset on run reset. */
  regenAccumSec: number;
}

export function createPlayer(id: string, colorIndex: number, token: string): PlayerState {
  const player: PlayerState = {
    id,
    token,
    colorIndex,
    class: DEFAULT_CLASS,
    name: undefined,
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    hp: FROG_BASE_STATS.maxHp,
    maxHp: FROG_BASE_STATS.maxHp,
    flies: 0,
    downed: false,
    spectator: false,
    connected: true,
    weapons: [...STARTING_WEAPON_SLOTS],
    // Start ready-to-fire (0 cooldown) so a fresh loadout can act the instant
    // an enemy comes into range, rather than waiting out a full cooldown first.
    weaponCooldowns: STARTING_WEAPON_SLOTS.map(() => 0),
    stats: {
      damagePct: FROG_BASE_STATS.damagePct,
      moveSpeed: FROG_BASE_STATS.moveSpeed,
      maxHp: FROG_BASE_STATS.maxHp,
      armor: FROG_BASE_STATS.armor,
      regen: FROG_BASE_STATS.regen,
      pickupRadius: FROG_BASE_STATS.pickupRadius,
    },
    ready: false,
    input: { seq: -1, up: false, down: false, left: false, right: false },
    killCount: 0,
    damageDealt: 0,
    fliesCollected: 0,
    regenAccumSec: 0,
  };
  // First join uses DEFAULT_CLASS, but still routes through applyClassLoadout
  // so the starting weapon/stat-mod bundle logic has exactly one implementation
  // (P2 task brief: "class starting weapons also apply on FIRST join").
  applyClassLoadout(player, DEFAULT_CLASS);
  return player;
}

/**
 * Applies a class's stat-modifier bundle (classBaseStats) + starting weapon
 * to a player, in place. Used on first join (DEFAULT_CLASS), on `pickClass`
 * in the lobby, and on every full run reset (rematch keeps the player's last
 * class — Phase 2 §5). Resets HP to full at the new maxHp, replaces all
 * weapon slots with [starting weapon Lv1, null, null, ...] (length driven by
 * STARTING_WEAPON_SLOTS, i.e. WEAPON_SLOT_COUNT), and zeroes cooldowns.
 */
export function applyClassLoadout(player: PlayerState, classId: FrogClassId): void {
  player.class = classId;
  const effective = classBaseStats(classId);
  player.stats = {
    damagePct: effective.damagePct,
    moveSpeed: effective.moveSpeed,
    maxHp: effective.maxHp,
    armor: effective.armor,
    regen: effective.regen,
    pickupRadius: effective.pickupRadius,
  };
  player.maxHp = effective.maxHp;
  player.hp = effective.maxHp;
  const startingWeapon = FROG_CLASSES[classId].startingWeapon;
  player.weapons = STARTING_WEAPON_SLOTS.map((_, i) => (i === 0 ? { weapon: startingWeapon, level: 1 } : null));
  player.weaponCooldowns = player.weapons.map(() => 0);
}

/**
 * Sanitizes a client-supplied lobby/shop name (Phase 2 §5): strips ASCII
 * control chars (including DEL), trims surrounding whitespace, and caps at
 * MAX_NAME_LENGTH. Returns undefined for an empty result (treated the same
 * as "never set a name").
 */
export function sanitizeName(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars.
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '');
  const trimmed = stripped.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Clears held keys and rewinds seq tracking. Must be called whenever a socket
 * (re)binds to this player or a run resets: the client's seq counter restarts
 * from 0 in both situations, so a preserved high seq would make applyInput
 * discard every subsequent input as stale while the last held direction keeps
 * applying forever.
 */
export function resetInput(player: PlayerState): void {
  player.input = { seq: -1, up: false, down: false, left: false, right: false };
}

/** Applies a client `input` message, ignoring it if its seq is stale (<= last applied). */
export function applyInput(player: PlayerState, msg: Extract<ClientMsg, { type: 'input' }>): void {
  if (msg.seq <= player.input.seq) return;
  player.input = { seq: msg.seq, up: msg.up, down: msg.down, left: msg.left, right: msg.right };
}

/** Clamps a point to lie inside (or on) the ARENA ellipse, centered on the arena.
 * Exported for sim/enemies.ts: crawling enemies (snails, the boss) are clamped
 * too — flying ones (wasps, herons) may cross the pond edge. */
export function clampToArenaEllipse(x: number, y: number): { x: number; y: number } {
  const cx = ARENA.width / 2;
  const cy = ARENA.height / 2;
  const rx = ARENA.width / 2;
  const ry = ARENA.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const norm = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (norm <= 1) return { x, y };
  const scale = 1 / Math.sqrt(norm);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** Integrates one fixed sim step of movement for a single player, clamped to the arena. */
export function stepPlayerMovement(player: PlayerState, dtSec: number): void {
  if (player.downed || player.spectator || !player.connected) return;

  const { up, down, left, right } = player.input;
  let dx = (right ? 1 : 0) - (left ? 1 : 0);
  let dy = (down ? 1 : 0) - (up ? 1 : 0);
  if (dx !== 0 && dy !== 0) {
    dx *= Math.SQRT1_2;
    dy *= Math.SQRT1_2;
  }

  const speed = player.stats.moveSpeed;
  const nextX = player.x + dx * speed * dtSec;
  const nextY = player.y + dy * speed * dtSec;
  const clamped = clampToArenaEllipse(nextX, nextY);
  player.x = clamped.x;
  player.y = clamped.y;
}

/**
 * Debug-only (T6 `give` message): replaces a slot's weapon outright, regardless
 * of what was there before. Resets that slot's cooldown to 0 (ready to fire) so
 * test scripts and manual debugging get immediate feedback. No-op on an
 * out-of-range slot index.
 */
export function setWeaponSlot(player: PlayerState, slot: number, kind: WeaponKind, level: WeaponLevel): void {
  if (slot < 0 || slot >= player.weapons.length) return;
  player.weapons[slot] = { weapon: WEAPON_TYPE_BY_KIND[kind], level };
  player.weaponCooldowns[slot] = 0;
}

/** Converts internal state to the wire-format PlayerSnap. */
export function toPlayerSnap(player: PlayerState): PlayerSnap {
  return {
    id: player.id,
    ...(player.name !== undefined ? { name: player.name } : {}),
    color: player.colorIndex,
    class: player.class,
    x: player.x,
    y: player.y,
    hp: player.hp,
    maxHp: player.maxHp,
    flies: player.flies,
    downed: player.downed,
    spectator: player.spectator,
    weapons: player.weapons.map((slot) =>
      slot === null ? null : { kind: WEAPON_KIND_BY_TYPE[slot.weapon], level: slot.level },
    ),
    stats: { ...player.stats },
    ready: player.ready,
  };
}
