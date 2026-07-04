// Shop purchase validation & application (DESIGN §7, PLAN.md T9).
//
// Room owns the phase machine and the players map; this module is the
// authoritative "can this buy happen, and what does it do" logic, mirroring
// the sim/*.ts and game/phases.ts style — small pure-ish functions over a
// PlayerState, called from room.ts's `buy` message handler. The client's
// client/src/ui/shop/catalog.ts mirrors these rules for display only; this
// file is the source of truth for what actually gets charged.
//
// Per-player purchase-count bookkeeping (for escalating stat prices) lives
// here as module state, keyed by playerId, since it's shop-specific and has
// no other consumer. It must be cleared on every full run reset; rather than
// reach into game/phases.ts's resetPlayerForNewRun (owned by T8), room.ts
// calls `resetShopCounts(player.id)` alongside it at both reset call sites
// (beginRun, endScoreboard).

import {
  FROG_BASE_STATS,
  MERGE_OFFER_ID,
  mergeResultLevel,
  STAT_SHOP_OFFERS,
  WEAPON_SHOP_OFFERS,
  WEAPON_UPGRADE_PRICES,
  UPGRADE_OFFER_ID,
  type GameEvent,
  type Phase,
} from '@frogtato/shared';
import type { PlayerState } from '../sim/players.js';

type PurchaseResultEvent = Extract<GameEvent, { type: 'purchaseResult' }>;

interface BuyMsg {
  offerId: string;
  slot?: number;
}

// ---------------------------------------------------------------------------
// Per-player, per-run successful-purchase counts (stat offers only — weapon
// buys/upgrades are gated by slot state, not a counter).
// ---------------------------------------------------------------------------

const purchaseCounts = new Map<string, Map<string, number>>();

function getCount(playerId: string, offerId: string): number {
  return purchaseCounts.get(playerId)?.get(offerId) ?? 0;
}

function incrementCount(playerId: string, offerId: string): number {
  let inner = purchaseCounts.get(playerId);
  if (!inner) {
    inner = new Map();
    purchaseCounts.set(playerId, inner);
  }
  const next = (inner.get(offerId) ?? 0) + 1;
  inner.set(offerId, next);
  return next;
}

/** Clears one player's shop purchase-count bookkeeping (call at every full run reset). */
export function resetShopCounts(playerId: string): void {
  purchaseCounts.delete(playerId);
}

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const WEAPON_OFFER_BY_ID = new Map(WEAPON_SHOP_OFFERS.map((o) => [o.id, o]));
const STAT_OFFER_BY_ID = new Map(STAT_SHOP_OFFERS.map((o) => [o.id, o]));

function fail(playerId: string, offerId: string, reason: string): PurchaseResultEvent {
  return { type: 'purchaseResult', playerId, offerId, ok: false, reason };
}

function ok(playerId: string, offerId: string, priceNext?: number): PurchaseResultEvent {
  return { type: 'purchaseResult', playerId, offerId, ok: true, ...(priceNext !== undefined ? { priceNext } : {}) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Validates and (on success) applies a `buy` message. Always returns a purchaseResult event to broadcast. */
export function handleBuy(phase: Phase, player: PlayerState, msg: BuyMsg): PurchaseResultEvent {
  const { offerId } = msg;

  if (phase !== 'shop' || player.spectator) return fail(player.id, offerId, 'wrong phase');

  const weaponOffer = WEAPON_OFFER_BY_ID.get(offerId);
  if (weaponOffer) return handleWeaponBuy(player, weaponOffer, msg.slot);

  if (offerId === UPGRADE_OFFER_ID) return handleUpgrade(player, msg.slot);

  const statOffer = STAT_OFFER_BY_ID.get(offerId);
  if (statOffer) return handleStatBuy(player, statOffer);

  return fail(player.id, offerId, 'invalid offer');
}

// ---------------------------------------------------------------------------
// Weapon buy (empty slot required)
// ---------------------------------------------------------------------------

function handleWeaponBuy(
  player: PlayerState,
  offer: (typeof WEAPON_SHOP_OFFERS)[number],
  slot: number | undefined,
): PurchaseResultEvent {
  let targetSlot: number;
  if (slot !== undefined) {
    if (slot < 0 || slot >= player.weapons.length) return fail(player.id, offer.id, 'invalid slot');
    if (player.weapons[slot] !== null) return fail(player.id, offer.id, 'slots full');
    targetSlot = slot;
  } else {
    const firstEmpty = player.weapons.findIndex((w) => w === null);
    if (firstEmpty === -1) return fail(player.id, offer.id, 'slots full');
    targetSlot = firstEmpty;
  }

  if (player.flies < offer.cost) return fail(player.id, offer.id, 'not enough flies');

  player.flies -= offer.cost;
  player.weapons[targetSlot] = { weapon: offer.weapon, level: 1 };
  player.weaponCooldowns[targetSlot] = 0;

  // Fixed price (no escalation) — priceNext mirrors the same cost so a
  // client that reads it doesn't misread "undefined" as "no longer buyable".
  return ok(player.id, offer.id, offer.cost);
}

// ---------------------------------------------------------------------------
// Weapon-slot upgrade (level gating, per-target-level prices)
// ---------------------------------------------------------------------------

function handleUpgrade(player: PlayerState, slot: number | undefined): PurchaseResultEvent {
  const offerId = UPGRADE_OFFER_ID;
  const eligible = player.weapons
    .map((w, i) => (w !== null && w.level < 3 ? i : -1))
    .filter((i) => i >= 0);

  if (eligible.length === 0) {
    const anyOccupied = player.weapons.some((w) => w !== null);
    return fail(player.id, offerId, anyOccupied ? 'max level' : 'no upgradeable slot');
  }

  let targetSlot: number;
  if (slot !== undefined) {
    if (slot < 0 || slot >= player.weapons.length) return fail(player.id, offerId, 'invalid slot');
    const weapon = player.weapons[slot];
    if (weapon === null) return fail(player.id, offerId, 'invalid slot');
    if (weapon.level >= 3) return fail(player.id, offerId, 'max level');
    targetSlot = slot;
  } else {
    // Slot is required whenever there are 2 eligible slots (ambiguous otherwise);
    // with exactly one eligible slot it may be omitted.
    if (eligible.length > 1) return fail(player.id, offerId, 'invalid slot');
    targetSlot = eligible[0]!;
  }

  const weapon = player.weapons[targetSlot]!;
  const nextLevel = (weapon.level + 1) as 2 | 3;
  const price = WEAPON_UPGRADE_PRICES[nextLevel];

  if (player.flies < price) return fail(player.id, offerId, 'not enough flies');

  player.flies -= price;
  player.weapons[targetSlot] = { weapon: weapon.weapon, level: nextLevel };

  const priceNext = nextLevel < 3 ? WEAPON_UPGRADE_PRICES[(nextLevel + 1) as 2 | 3] : undefined;
  return ok(player.id, offerId, priceNext);
}

// ---------------------------------------------------------------------------
// Repeatable stat buys (escalating price, move-speed capped)
// ---------------------------------------------------------------------------

function handleStatBuy(player: PlayerState, offer: (typeof STAT_SHOP_OFFERS)[number]): PurchaseResultEvent {
  const count = getCount(player.id, offer.id);

  if (offer.maxPurchases !== undefined && count >= offer.maxPurchases) {
    // Matches the client's disable reason (client/src/ui/shop/catalog.ts) for
    // the move-speed offer, the only capped stat offer today.
    const reason = offer.effect.stat === 'moveSpeedPct' ? 'move-speed cap reached' : 'max purchases reached';
    return fail(player.id, offer.id, reason);
  }

  const price = offer.cost + offer.priceIncrement * count;
  if (player.flies < price) return fail(player.id, offer.id, 'not enough flies');

  player.flies -= price;
  applyStatEffect(player, offer.effect);
  const newCount = incrementCount(player.id, offer.id);

  const capped = offer.maxPurchases !== undefined && newCount >= offer.maxPurchases;
  const priceNext = capped ? undefined : offer.cost + offer.priceIncrement * newCount;
  return ok(player.id, offer.id, priceNext);
}

function applyStatEffect(player: PlayerState, effect: (typeof STAT_SHOP_OFFERS)[number]['effect']): void {
  switch (effect.stat) {
    case 'maxHp':
      player.maxHp += effect.amount;
      player.stats.maxHp += effect.amount;
      player.hp = Math.min(player.hp + effect.healOnBuy, player.maxHp);
      break;
    case 'damagePct':
      player.stats.damagePct += effect.amount;
      break;
    case 'moveSpeedPct':
      // `amount` is a fraction of BASE move speed added per purchase (linear,
      // not compounding) — consistent with maxHp/damagePct above, which add a
      // fixed absolute amount per purchase rather than scaling the current value.
      player.stats.moveSpeed += FROG_BASE_STATS.moveSpeed * effect.amount;
      break;
    case 'armor':
      player.stats.armor += effect.amount;
      break;
    case 'regen':
      player.stats.regen += effect.amount;
      break;
    case 'pickupRadius':
      player.stats.pickupRadius += effect.amount;
      break;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 §3: weapon merge (shop-only, free, validated like any purchase)
// ---------------------------------------------------------------------------

type MergedEvent = Extract<GameEvent, { type: 'merged' }>;

/**
 * Validates and (on success) applies a `merge` message. Success emits a
 * `merged` event; failure emits `purchaseResult` with offerId MERGE_OFFER_ID
 * ("merge") — same shape as every other shop rejection, per DESIGN-PHASE2.md
 * §3 / ids.ts's MERGE_OFFER_ID doc comment. Reason strings are part of the
 * client<->server contract (the client P5 task mirrors them exactly):
 *   "wrong phase"    — not in the shop phase (or spectating)
 *   "nothing to merge" — no two occupied slots share a weapon kind
 *   "levels differ"  — same kind exists in two slots, but at different levels
 *   "max level"      — same kind+level pair, but no merge result exists (Lv III)
 */
export function handleMerge(phase: Phase, player: PlayerState): PurchaseResultEvent | MergedEvent {
  if (phase !== 'shop' || player.spectator) return fail(player.id, MERGE_OFFER_ID, 'wrong phase');

  // First mergeable pair (i < j) of same kind + same level wins. With 3 slots
  // there can be multiple candidates; first-pair is deterministic and matches
  // the client's mergeEligible ordering.
  let sawLevelsDiffer = false;
  let sawMaxLevel = false;
  for (let i = 0; i < player.weapons.length; i++) {
    const a = player.weapons[i];
    if (!a) continue;
    for (let j = i + 1; j < player.weapons.length; j++) {
      const b = player.weapons[j];
      if (!b || a.weapon !== b.weapon) continue;
      if (a.level !== b.level) {
        sawLevelsDiffer = true;
        continue;
      }
      const newLevel = mergeResultLevel(a.level);
      if (newLevel === null) {
        sawMaxLevel = true;
        continue;
      }
      player.weapons[i] = { weapon: a.weapon, level: newLevel };
      player.weapons[j] = null;
      player.weaponCooldowns = player.weapons.map(() => 0);
      return { type: 'merged', playerId: player.id, slot: i, newLevel };
    }
  }

  if (sawMaxLevel) return fail(player.id, MERGE_OFFER_ID, 'max level');
  if (sawLevelsDiffer) return fail(player.id, MERGE_OFFER_ID, 'levels differ');
  return fail(player.id, MERGE_OFFER_ID, 'nothing to merge');
}
