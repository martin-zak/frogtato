// Per-player simulation: input storage, movement integration, arena clamping,
// and translation to the wire-format PlayerSnap. No networking, no timers here —
// this module is pure state + step functions so it can be unit-tested and reused
// by later tasks (weapons, downed/revive) without rewrites.

import {
  ARENA,
  FROG_BASE_STATS,
  STARTING_WEAPON_SLOTS,
  type ClientMsg,
  type PlayerSnap,
  type WeaponKind,
  type WeaponSlot,
} from '@frogtato/shared';

/**
 * The protocol (messages.ts) uses short weapon kind names ("tongue"/"bubble"/"croak")
 * in snapshots, while the balance data (constants.ts) uses full type names
 * ("tongueLash"/"bubbleBlaster"/"croakNova"). Both files are owned upstream (T2) and
 * intentionally kept independent of each other, so this mapping is protocol glue
 * (not a balance number) that has to live somewhere on the server.
 */
const WEAPON_KIND_BY_TYPE: Record<WeaponSlot['weapon'], WeaponKind> = {
  tongueLash: 'tongue',
  bubbleBlaster: 'bubble',
  croakNova: 'croak',
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
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  flies: number;
  downed: boolean;
  spectator: boolean;
  weapons: (WeaponSlot | null)[];
  stats: { damagePct: number; moveSpeed: number; maxHp: number };
  ready: boolean;
  input: PlayerInputState;
}

export function createPlayer(id: string, colorIndex: number, token: string): PlayerState {
  return {
    id,
    token,
    colorIndex,
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    hp: FROG_BASE_STATS.maxHp,
    maxHp: FROG_BASE_STATS.maxHp,
    flies: 0,
    downed: false,
    spectator: false,
    weapons: [...STARTING_WEAPON_SLOTS],
    stats: {
      damagePct: FROG_BASE_STATS.damagePct,
      moveSpeed: FROG_BASE_STATS.moveSpeed,
      maxHp: FROG_BASE_STATS.maxHp,
    },
    ready: false,
    input: { seq: -1, up: false, down: false, left: false, right: false },
  };
}

/** Applies a client `input` message, ignoring it if its seq is stale (<= last applied). */
export function applyInput(player: PlayerState, msg: Extract<ClientMsg, { type: 'input' }>): void {
  if (msg.seq <= player.input.seq) return;
  player.input = { seq: msg.seq, up: msg.up, down: msg.down, left: msg.left, right: msg.right };
}

/** Clamps a point to lie inside (or on) the ARENA ellipse, centered on the arena. */
function clampToArenaEllipse(x: number, y: number): { x: number; y: number } {
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
  if (player.downed || player.spectator) return;

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

/** Converts internal state to the wire-format PlayerSnap. */
export function toPlayerSnap(player: PlayerState): PlayerSnap {
  return {
    id: player.id,
    color: player.colorIndex,
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
