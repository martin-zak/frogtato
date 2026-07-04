// Balance tables & pure formulas transcribed from DESIGN.md §3-§7.
//
// This file contains ONLY data + pure functions — no game logic, no state,
// no side effects. Server and client both import from here so there is a
// single source of truth for every number in the game.

// ---------------------------------------------------------------------------
// §3 The Frog (player character)
// ---------------------------------------------------------------------------

// TUNING (live playtest 2026-07-04): 2 -> 3 weapon slots.
export const WEAPON_SLOT_COUNT = 3;

export interface FrogBaseStats {
  readonly maxHp: number;
  readonly moveSpeed: number; // px/s
  readonly damagePct: number; // additive multiplier bonus, 0 = +0%
  readonly pickupRadius: number; // px
  /** Flat damage reduction per hit, min 1 damage taken (Phase 2 §2). */
  readonly armor: number;
  /** HP regenerated per 5s during waves (Phase 2 §2). */
  readonly regen: number;
}

export const FROG_BASE_STATS: FrogBaseStats = {
  maxHp: 20,
  moveSpeed: 220,
  damagePct: 0,
  pickupRadius: 60,
  armor: 0,
  regen: 0,
};

// ---------------------------------------------------------------------------
// Phase 2 §1 Frog Classes
// ---------------------------------------------------------------------------

export type FrogClassId = 'bullfrog' | 'treefrog' | 'dartfrog';

/**
 * Stat-modifier bundle applied on top of FROG_BASE_STATS. Units, expressed
 * uniformly:
 *   - maxHp / armor / pickupRadius: flat deltas (added to the base value)
 *   - moveSpeedPct / damagePct: additive % deltas (0.15 = +15%); moveSpeedPct
 *     is applied multiplicatively to base move speed, damagePct is added to
 *     the base additive damage bonus (same convention as the damagePct stat
 *     offer in STAT_SHOP_OFFERS).
 */
export interface FrogClassStatMods {
  readonly maxHp: number;
  readonly moveSpeedPct: number;
  readonly damagePct: number;
  readonly armor: number;
  readonly pickupRadius: number;
}

export interface FrogClassDef {
  readonly id: FrogClassId;
  readonly displayName: string;
  readonly description: string;
  readonly statMods: FrogClassStatMods;
  readonly startingWeapon: WeaponType;
}

export const FROG_CLASSES: Readonly<Record<FrogClassId, FrogClassDef>> = {
  bullfrog: {
    id: 'bullfrog',
    displayName: 'Bullfrog',
    description: 'Tanky bruiser: more Max HP and Armor, slower.',
    statMods: { maxHp: 8, moveSpeedPct: -0.15, damagePct: 0, armor: 1, pickupRadius: 0 },
    startingWeapon: 'croakNova',
  },
  treefrog: {
    id: 'treefrog',
    displayName: 'Tree Frog',
    description: 'Fast skirmisher: quicker with a bigger pickup radius, less Max HP.',
    statMods: { maxHp: -4, moveSpeedPct: 0.15, damagePct: 0, armor: 0, pickupRadius: 20 },
    startingWeapon: 'tongueLash',
  },
  dartfrog: {
    id: 'dartfrog',
    displayName: 'Dart Frog',
    description: 'Glass cannon: hits harder, less Max HP.',
    statMods: { maxHp: -6, moveSpeedPct: 0, damagePct: 0.15, armor: 0, pickupRadius: 0 },
    startingWeapon: 'bubbleBlaster',
  },
};

/** Lobby default when a player never picks a class (Phase 2 §1). */
export const DEFAULT_CLASS: FrogClassId = 'treefrog';

export interface FrogEffectiveStats {
  readonly maxHp: number;
  readonly moveSpeed: number;
  readonly damagePct: number;
  readonly armor: number;
  readonly regen: number;
  readonly pickupRadius: number;
}

/** FROG_BASE_STATS with a class's stat-modifier bundle applied — the stat
 * block a player starts a run with, before any shop purchases. */
export function classBaseStats(classId: FrogClassId): FrogEffectiveStats {
  const mods = FROG_CLASSES[classId].statMods;
  return {
    maxHp: FROG_BASE_STATS.maxHp + mods.maxHp,
    moveSpeed: FROG_BASE_STATS.moveSpeed * (1 + mods.moveSpeedPct),
    damagePct: FROG_BASE_STATS.damagePct + mods.damagePct,
    armor: FROG_BASE_STATS.armor + mods.armor,
    regen: FROG_BASE_STATS.regen,
    pickupRadius: FROG_BASE_STATS.pickupRadius + mods.pickupRadius,
  };
}

/** Lobby name field max length (Phase 2 §5). */
export const MAX_NAME_LENGTH = 12;

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
  null,
];

// ---------------------------------------------------------------------------
// Phase 2 §3 Weapon Merging
// ---------------------------------------------------------------------------

/**
 * Merge rule (Phase 2 §3): two same-kind, same-level weapons in a player's
 * slots combine into ONE weapon of the next level, freeing the other slot.
 * Free (no fly cost). Only levels I and II are mergeable — there is no
 * Lv IV, so two Lv IIIs cannot merge.
 */
export const MERGEABLE_LEVELS: readonly WeaponLevel[] = [1, 2];

/** The level a merge of two `level`-level weapons produces, or null if that
 * level isn't mergeable (Lv III). */
export function mergeResultLevel(level: WeaponLevel): WeaponLevel | null {
  if (level === 1) return 2;
  if (level === 2) return 3;
  return null;
}

// ---------------------------------------------------------------------------
// §5 Enemies
// ---------------------------------------------------------------------------

export type EnemyType = 'wasp' | 'snailSpitter' | 'heron' | 'snailKing';

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

/** Heron (Phase 2 §4, waves 3+): circles at range, telegraphs, then dive-swoops
 * in a straight line through the arena. circleSpeed/swoopSpeed are starting
 * values — TUNING, adjust in P6 playtest. */
export interface HeronDef {
  readonly type: 'heron';
  readonly hp: number;
  readonly circleSpeed: number; // px/s while circling at range — TUNING
  readonly swoopSpeed: number; // px/s during the dive-swoop — TUNING
  readonly telegraphSec: number;
  readonly swoopDamage: number;
  readonly flyDrop: number;
  /** First wave this enemy can spawn in. */
  readonly minWave: number;
}

/** Snail King (Phase 2 §4): wave-5 finale boss. `hp` is the base value —
 * effective spawn HP is `hp * playerFactor(playerCount)` (NOT
 * enemyHpMultiplier — bosses scale with player count like spawn caps do,
 * not with the wave-HP curve, since there's only one wave-5 boss).
 * shellIntervalSec/projectileDamage are not specified numerically in
 * DESIGN-PHASE2.md §4 — starting values, TUNING. */
export interface SnailKingDef {
  readonly type: 'snailKing';
  readonly hp: number;
  readonly speed: number; // px/s
  readonly spreadCount: number;
  readonly spreadIntervalSec: number;
  readonly projectileDamage: number; // TUNING — not specified in DESIGN-PHASE2.md
  readonly projectileSpeed: number; // px/s — TUNING
  readonly shellDurationSec: number;
  readonly shellArmor: number;
  /** How often the shell phase recurs while the boss lives — TUNING (not
   * specified in DESIGN-PHASE2.md beyond "periodically"). */
  readonly shellIntervalSec: number;
  readonly flyDrop: number; // TUNING — boss reward, not specified
  /** Boss appears in the last N seconds of this wave. */
  readonly spawnWave: number;
  readonly spawnAtRemainingSec: number;
  /** Extra seconds granted past the wave timer if the boss is still alive,
   * after which the run ends in victory regardless (DESIGN-PHASE2.md §4). */
  readonly hardCapExtraSec: number;
}

export const ENEMY_DEFS: Readonly<{
  wasp: WaspDef;
  snailSpitter: SnailSpitterDef;
  heron: HeronDef;
  snailKing: SnailKingDef;
}> = {
  wasp: {
    type: 'wasp',
    hp: 4,
    // TUNING (live playtest 2026-07-04): was 260 — faster than every frog's
    // base 220, which made wasps inescapable. Now slightly slower than the
    // frog so kiting works; pressure comes from numbers, not raw speed.
    speed: 200,
    contactDamage: 2,
    contactCooldownSec: 0.5,
    // TUNING (live playtest 2026-07-04): fly drops increased across the board.
    flyDrop: 2,
  },
  snailSpitter: {
    type: 'snailSpitter',
    hp: 12,
    speed: 60,
    keepDistance: 300,
    spitIntervalSec: 2.5,
    projectileDamage: 3,
    projectileSpeed: 250,
    flyDrop: 5,
  },
  heron: {
    type: 'heron',
    hp: 8,
    circleSpeed: 150,
    swoopSpeed: 500,
    telegraphSec: 0.8,
    swoopDamage: 4,
    flyDrop: 4,
    minWave: 3,
  },
  snailKing: {
    type: 'snailKing',
    hp: 120,
    speed: 40,
    spreadCount: 3,
    spreadIntervalSec: 2,
    projectileDamage: 4,
    projectileSpeed: 250,
    shellDurationSec: 2,
    shellArmor: 5,
    shellIntervalSec: 8,
    flyDrop: 50,
    spawnWave: 5,
    spawnAtRemainingSec: 20,
    hardCapExtraSec: 30,
  },
};

// ---------------------------------------------------------------------------
// §6 Waves
// ---------------------------------------------------------------------------

export interface SpawnMix {
  readonly wasp: number;
  readonly snailSpitter: number;
  /** 0 before heron's minWave (Phase 2 §4: waves 3+). Weights are starting
   * values — TUNING. */
  readonly heron: number;
}

export interface WaveDef {
  readonly wave: number;
  readonly durationSec: number;
  readonly spawnMix: SpawnMix;
  /** Spawn interval (seconds between enemy spawns) at wave start. */
  readonly spawnIntervalStartSec: number;
  /** Spawn interval (seconds between enemy spawns) at wave end (ramps down = faster). */
  readonly spawnIntervalEndSec: number;
  /** True for the wave that spawns the Snail King finale (Phase 2 §4). */
  readonly bossWave: boolean;
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

// Heron enters the mix at its minWave (Phase 2 §4: wave 3+); weights below
// are modest starting values — TUNING, adjust in P6 playtest.
export const WAVES: readonly WaveDef[] = [1, 2, 3, 4, 5].map((wave) => {
  const durationSec = [30, 35, 40, 45, 60][wave - 1];
  const spawnMix: SpawnMix =
    wave === 1
      ? { wasp: 1, snailSpitter: 0, heron: 0 }
      : wave === 2
        ? { wasp: 0.7, snailSpitter: 0.3, heron: 0 }
        : wave === 3
          ? { wasp: 0.45, snailSpitter: 0.45, heron: 0.1 }
          : wave === 4
            ? { wasp: 0.5, snailSpitter: 0.35, heron: 0.15 }
            : { wasp: 0.4, snailSpitter: 0.4, heron: 0.2 };
  return {
    wave,
    durationSec,
    spawnMix,
    spawnIntervalStartSec: spawnInterval(wave),
    spawnIntervalEndSec: spawnInterval(Math.min(wave + 1, WAVE_COUNT)),
    bossWave: wave === ENEMY_DEFS.snailKing.spawnWave,
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
    | { readonly stat: 'moveSpeedPct'; readonly amount: number }
    | { readonly stat: 'armor'; readonly amount: number }
    | { readonly stat: 'regen'; readonly amount: number }
    | { readonly stat: 'pickupRadius'; readonly amount: number };
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
  // Phase 2 §2 — completing the stat sheet.
  {
    id: 'buyArmor',
    kind: 'stat',
    cost: 14,
    priceIncrement: 8,
    maxPurchases: 3,
    effect: { stat: 'armor', amount: 1 },
  },
  {
    id: 'buyRegen',
    kind: 'stat',
    cost: 12,
    priceIncrement: 6,
    maxPurchases: 3,
    effect: { stat: 'regen', amount: 1 },
  },
  {
    id: 'buyPickupRadius',
    kind: 'stat',
    cost: 8,
    priceIncrement: 4,
    maxPurchases: 4,
    effect: { stat: 'pickupRadius', amount: 15 },
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

/**
 * Hit-stagger (live playtest 2026-07-04, Brotato-style): a regular enemy
 * that takes weapon damage fully stops (no movement, no attacks) for this
 * long, giving hits visible impact and the player breathing room. The Snail
 * King is immune — it would be permanently stun-locked by auto-fire.
 * TUNING.
 */
export const ENEMY_HIT_STAGGER_SEC = 0.35;

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
