// Balance tables & pure formulas transcribed from DESIGN.md §3-§7.
//
// This file contains ONLY data + pure functions — no game logic, no state,
// no side effects. Server and client both import from here so there is a
// single source of truth for every number in the game.

// ---------------------------------------------------------------------------
// §3 The Frog (player character)
// ---------------------------------------------------------------------------

export const WEAPON_SLOT_COUNT = 2;

export interface FrogBaseStats {
  readonly maxHp: number;
  readonly moveSpeed: number; // px/s
  readonly damagePct: number; // additive multiplier bonus, 0 = +0%
  readonly pickupRadius: number; // px
}

export const FROG_BASE_STATS: FrogBaseStats = {
  maxHp: 20,
  moveSpeed: 220,
  damagePct: 0,
  pickupRadius: 60,
};

export type PlayerColorName = 'green' | 'blue' | 'orange' | 'pink';

export const PLAYER_COLORS: Readonly<Record<PlayerColorName, string>> = {
  green: '#4caf50',
  blue: '#2196f3',
  orange: '#ff9800',
  pink: '#e91e63',
};

export const PLAYER_COLOR_ORDER: readonly PlayerColorName[] = [
  'green',
  'blue',
  'orange',
  'pink',
];

// ---------------------------------------------------------------------------
// §4 Weapons
// ---------------------------------------------------------------------------

export type WeaponType = 'tongueLash' | 'bubbleBlaster' | 'croakNova';
export type WeaponLevel = 1 | 2 | 3;
export type WeaponArchetype = 'melee' | 'ranged' | 'aoe';

export interface WeaponLevelStats {
  readonly damage: number;
  readonly cooldownSec: number;
  /** For melee/ranged weapons: max targeting range (px). For aoe: hit radius (px). */
  readonly range: number;
  /** Only present for the ranged archetype. */
  readonly projectileSpeed?: number;
}

export interface WeaponDef {
  readonly type: WeaponType;
  readonly archetype: WeaponArchetype;
  readonly levels: Readonly<Record<WeaponLevel, WeaponLevelStats>>;
}

// Level scaling rule (DESIGN §4): relative to Lv I —
//   Lv II = +60% damage, -10% cooldown
//   Lv III = +140% damage, -20% cooldown
const LEVEL_SCALING: Readonly<Record<WeaponLevel, { damageMult: number; cooldownMult: number }>> = {
  1: { damageMult: 1, cooldownMult: 1 },
  2: { damageMult: 1.6, cooldownMult: 0.9 },
  3: { damageMult: 2.4, cooldownMult: 0.8 },
};

function scaleWeaponLevels(
  lvIDamage: number,
  lvICooldownSec: number,
  range: number,
  projectileSpeed?: number,
): Record<WeaponLevel, WeaponLevelStats> {
  const levels = {} as Record<WeaponLevel, WeaponLevelStats>;
  for (const levelKey of [1, 2, 3] as WeaponLevel[]) {
    const scale = LEVEL_SCALING[levelKey];
    levels[levelKey] = {
      damage: lvIDamage * scale.damageMult,
      cooldownSec: lvICooldownSec * scale.cooldownMult,
      range,
      ...(projectileSpeed !== undefined ? { projectileSpeed } : {}),
    };
  }
  return levels;
}

export const WEAPON_DEFS: Readonly<Record<WeaponType, WeaponDef>> = {
  tongueLash: {
    type: 'tongueLash',
    archetype: 'melee',
    levels: scaleWeaponLevels(5, 0.8, 120),
  },
  bubbleBlaster: {
    type: 'bubbleBlaster',
    archetype: 'ranged',
    levels: scaleWeaponLevels(3, 1.0, 400, 350),
  },
  croakNova: {
    type: 'croakNova',
    archetype: 'aoe',
    levels: scaleWeaponLevels(2, 2.5, 150),
  },
};

export interface WeaponSlot {
  readonly weapon: WeaponType;
  readonly level: WeaponLevel;
}

export const STARTING_WEAPON_SLOTS: readonly (WeaponSlot | null)[] = [
  { weapon: 'tongueLash', level: 1 },
  null,
];

// ---------------------------------------------------------------------------
// §5 Enemies
// ---------------------------------------------------------------------------

export type EnemyType = 'wasp' | 'snailSpitter';

export interface WaspDef {
  readonly type: 'wasp';
  readonly hp: number;
  readonly speed: number; // px/s
  readonly contactDamage: number;
  readonly contactCooldownSec: number;
  readonly flyDrop: number;
}

export interface SnailSpitterDef {
  readonly type: 'snailSpitter';
  readonly hp: number;
  readonly speed: number; // px/s
  readonly keepDistance: number; // px
  readonly spitIntervalSec: number;
  readonly projectileDamage: number;
  readonly projectileSpeed: number; // px/s
  readonly flyDrop: number;
}

export const ENEMY_DEFS: Readonly<{ wasp: WaspDef; snailSpitter: SnailSpitterDef }> = {
  wasp: {
    type: 'wasp',
    hp: 4,
    speed: 260,
    contactDamage: 2,
    contactCooldownSec: 0.5,
    flyDrop: 1,
  },
  snailSpitter: {
    type: 'snailSpitter',
    hp: 12,
    speed: 60,
    keepDistance: 300,
    spitIntervalSec: 2.5,
    projectileDamage: 3,
    projectileSpeed: 250,
    flyDrop: 3,
  },
};

// ---------------------------------------------------------------------------
// §6 Waves
// ---------------------------------------------------------------------------

export interface SpawnMix {
  readonly wasp: number;
  readonly snailSpitter: number;
}

export interface WaveDef {
  readonly wave: number;
  readonly durationSec: number;
  readonly spawnMix: SpawnMix;
  /** Spawn interval (seconds between enemy spawns) at wave start. */
  readonly spawnIntervalStartSec: number;
  /** Spawn interval (seconds between enemy spawns) at wave end (ramps down = faster). */
  readonly spawnIntervalEndSec: number;
}

export const WAVE_COUNT = 5;

/**
 * Enemy HP multiplier: `1 + 0.25 * (wave - 1)`.
 * enemyHpMultiplier(1) === 1, enemyHpMultiplier(5) === 2.
 */
export function enemyHpMultiplier(wave: number): number {
  return 1 + 0.25 * (wave - 1);
}

/**
 * `playerFactor = 1 + 0.6 * (playerCount - 1)`.
 * playerFactor(4) === 2.8. Applied to spawn cap and spawn rate, never to enemy HP.
 */
export function playerFactor(playerCount: number): number {
  return 1 + 0.6 * (playerCount - 1);
}

/**
 * Concurrent enemy cap: `(8 + 4 * wave) * playerFactor(playerCount)`.
 * enemyCap(5, 1) === 28.
 */
export function enemyCap(wave: number, playerCount: number): number {
  return Math.round((8 + 4 * wave) * playerFactor(playerCount));
}

/**
 * Spawn interval: linearly interpolated from 1.5 s (wave 1) down to 0.5 s (wave 5).
 * spawnInterval(1) === 1.5, spawnInterval(5) === 0.5.
 */
export function spawnInterval(wave: number): number {
  const START_SEC = 1.5;
  const END_SEC = 0.5;
  const t = (wave - 1) / (WAVE_COUNT - 1);
  return START_SEC + (END_SEC - START_SEC) * t;
}

export const WAVES: readonly WaveDef[] = [1, 2, 3, 4, 5].map((wave) => {
  const durationSec = [30, 35, 40, 45, 60][wave - 1];
  const spawnMix: SpawnMix =
    wave === 1
      ? { wasp: 1, snailSpitter: 0 }
      : wave === 2
        ? { wasp: 0.7, snailSpitter: 0.3 }
        : wave === 3
          ? { wasp: 0.5, snailSpitter: 0.5 }
          : wave === 4
            ? { wasp: 0.6, snailSpitter: 0.4 }
            : { wasp: 0.5, snailSpitter: 0.5 };
  return {
    wave,
    durationSec,
    spawnMix,
    spawnIntervalStartSec: spawnInterval(wave),
    spawnIntervalEndSec: spawnInterval(Math.min(wave + 1, WAVE_COUNT)),
  };
});

// ---------------------------------------------------------------------------
// §7 Shop & Economy
// ---------------------------------------------------------------------------

export const SHOP_DURATION_SEC = 30;
export const WAVE_FULL_HEAL = true;

export interface WeaponShopOffer {
  readonly id: string;
  readonly kind: 'weapon';
  readonly weapon: WeaponType;
  readonly cost: number;
}

export const WEAPON_SHOP_OFFERS: readonly WeaponShopOffer[] = [
  { id: 'buyTongueLash', kind: 'weapon', weapon: 'tongueLash', cost: 12 },
  { id: 'buyBubbleBlaster', kind: 'weapon', weapon: 'bubbleBlaster', cost: 15 },
  { id: 'buyCroakNova', kind: 'weapon', weapon: 'croakNova', cost: 18 },
];

/** Per-slot weapon upgrade prices, keyed by the level being upgraded TO. */
export const WEAPON_UPGRADE_PRICES: Readonly<Record<2 | 3, number>> = {
  2: 20,
  3: 35,
};

export interface StatShopOffer {
  readonly id: string;
  readonly kind: 'stat';
  readonly cost: number;
  /** Flies added to the price of each subsequent purchase of this offer. */
  readonly priceIncrement: number;
  /** Max number of times a single player may purchase this offer, if capped. */
  readonly maxPurchases?: number;
  readonly effect:
    | { readonly stat: 'maxHp'; readonly amount: number; readonly healOnBuy: number }
    | { readonly stat: 'damagePct'; readonly amount: number }
    | { readonly stat: 'moveSpeedPct'; readonly amount: number };
}

export const STAT_SHOP_OFFERS: readonly StatShopOffer[] = [
  {
    id: 'buyMaxHp',
    kind: 'stat',
    cost: 10,
    priceIncrement: 5,
    effect: { stat: 'maxHp', amount: 3, healOnBuy: 3 },
  },
  {
    id: 'buyDamage',
    kind: 'stat',
    cost: 12,
    priceIncrement: 6,
    effect: { stat: 'damagePct', amount: 0.08 },
  },
  {
    id: 'buyMoveSpeed',
    kind: 'stat',
    cost: 12,
    priceIncrement: 6,
    maxPurchases: 3,
    effect: { stat: 'moveSpeedPct', amount: 0.1 },
  },
];

export type ShopOffer = WeaponShopOffer | StatShopOffer;

export const SHOP_CATALOG: readonly ShopOffer[] = [
  ...WEAPON_SHOP_OFFERS,
  ...STAT_SHOP_OFFERS,
];

// ---------------------------------------------------------------------------
// Arena (DESIGN §9)
// ---------------------------------------------------------------------------

export interface ArenaDef {
  readonly width: number;
  readonly height: number;
  /** Enemies never spawn within this distance (px) of any player. */
  readonly minEnemySpawnDistanceFromPlayers: number;
  /** Enemies spawn at random points just outside the arena edge. */
  readonly enemySpawnAtEdge: boolean;
}

export const ARENA: ArenaDef = {
  width: 1600,
  height: 1200,
  minEnemySpawnDistanceFromPlayers: 250,
  enemySpawnAtEdge: true,
};

// ---------------------------------------------------------------------------
// Netcode (DESIGN §8-§9)
// ---------------------------------------------------------------------------

export const SIM_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const INTERP_DELAY_MS = 100;
export const INPUT_HZ = 30;
export const SERVER_PORT = 8080;
export const MAX_PLAYERS = 4;

/** Downed players revive at this fraction of max HP when the next wave starts. */
export const REVIVE_HP_PCT = 0.5;

/** Scoreboard is shown for this long after game over / victory before returning to lobby. */
export const SCOREBOARD_DURATION_SEC = 10;

/** A disconnected player's progress is kept in memory for this long, keyed by client token. */
export const RECONNECT_GRACE_SEC = 120;
