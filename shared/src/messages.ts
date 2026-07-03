// Protocol message types for the Frogtato client<->server WebSocket contract.
//
// Structural-only: this file contains discriminated unions and their supporting
// types, no logic, no runtime dependencies. It intentionally does NOT import from
// './constants.js' — the constants half of shared/ (owned by a different task) is
// kept independent from the protocol shapes defined here.
//
// See DESIGN.md §8 (Multiplayer) and §9 (Architecture / Netcode) for the source of
// truth this file transcribes.

/** Room/game phase, as broadcast on every snapshot and in `welcome`. */
export type Phase = "lobby" | "wave" | "shop" | "scoreboard";

/** The 3 weapon archetypes (DESIGN §4). */
export type WeaponKind = "tongue" | "bubble" | "croak";

/** The 2 enemy types (DESIGN §5). */
export type EnemyKind = "wasp" | "snail";

/** The 2 server-simulated projectile kinds (DESIGN §4/§5). */
export type ProjectileKind = "acid" | "bubble";

/** Weapon level: I, II, III (DESIGN §4). */
export type WeaponLevel = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/**
 * Dev-only escape hatch used by headless test scripts (see PLAN.md T5/T6/T8/T9).
 * Server must guard handling of this message behind a non-production check.
 */
export interface ClientDebugMsg {
  type: "debug";
  kill?: string;
  give?: { slot: number; weapon: WeaponKind; level: WeaponLevel };
  timescale?: number;
  invincible?: boolean;
  grantFlies?: number;
}

export type ClientMsg =
  | { type: "hello"; token?: string }
  | { type: "input"; seq: number; up: boolean; down: boolean; left: boolean; right: boolean }
  | { type: "start" }
  | { type: "buy"; offerId: string; slot?: number }
  | { type: "ready" }
  | ClientDebugMsg;

// ---------------------------------------------------------------------------
// Server -> Client: snapshot entity shapes
// ---------------------------------------------------------------------------

export interface PlayerSnap {
  id: string;
  name?: string;
  /** Palette index (see constants for the actual color values). */
  color: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  flies: number;
  downed: boolean;
  spectator: boolean;
  /** Index in this array = weapon slot; null = empty slot. */
  weapons: ({ kind: WeaponKind; level: WeaponLevel } | null)[];
  stats: { damagePct: number; moveSpeed: number; maxHp: number };
  /** Shop-phase ready state. */
  ready: boolean;
}

export interface EnemySnap {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export interface ProjectileSnap {
  id: string;
  kind: ProjectileKind;
  x: number;
  y: number;
}

export interface FlySnap {
  id: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Server -> Client: events
// ---------------------------------------------------------------------------

export interface ScoreRow {
  playerId: string;
  name?: string;
  kills: number;
  damageDealt: number;
  fliesCollected: number;
}

export type GameEvent =
  | { type: "waveStart"; wave: number }
  | { type: "waveEnd"; wave: number }
  | { type: "playerDowned"; playerId: string }
  | { type: "enemyDied"; enemyId: string; kind: EnemyKind; x: number; y: number }
  | { type: "attack"; playerId: string; slot: number; kind: WeaponKind; targetX: number; targetY: number }
  | { type: "playerHit"; playerId: string; amount: number }
  | { type: "purchaseResult"; playerId: string; offerId: string; ok: boolean; reason?: string; priceNext?: number }
  | { type: "gameOver"; scoreboard: ScoreRow[] }
  | { type: "victory"; scoreboard: ScoreRow[] }
  | { type: "playerJoined"; playerId: string }
  | { type: "playerLeft"; playerId: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMsg =
  | { type: "welcome"; playerId: string; token: string; phase: Phase }
  | {
      type: "snapshot";
      tick: number;
      phase: Phase;
      wave?: number;
      phaseEndsAt?: number;
      players: PlayerSnap[];
      enemies: EnemySnap[];
      projectiles: ProjectileSnap[];
      flies: FlySnap[];
    }
  | { type: "event"; event: GameEvent };
