// Tiny id helpers shared by client and server. No logic beyond a plain counter —
// deterministic and dependency-free (no Date.now()/crypto needed for v0.1 scope).

/**
 * Returns a factory that produces incrementing ids prefixed with `prefix`,
 * e.g. makeIdFactory("enemy") -> "enemy-1", "enemy-2", ...
 */
export function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

/**
 * Fixed shop offer ids (DESIGN §7), matching the `id` fields in
 * shared/src/constants.ts (SHOP_CATALOG / STAT_SHOP_OFFERS). Weapon-slot
 * upgrades have no catalog row (they're priced per target level via
 * WEAPON_UPGRADE_PRICES), so their id lives only here.
 */
export const UPGRADE_OFFER_ID = "upgradeSlot";

/**
 * Phase 2 §3: weapon merging is validated server-side like any purchase, so
 * it reuses the `purchaseResult` event with this offer id (a successful
 * merge additionally emits its own `merged` event — see messages.ts).
 */
export const MERGE_OFFER_ID = "merge";

export const OFFER_IDS = [
  "buyTongueLash",
  "buyBubbleBlaster",
  "buyCroakNova",
  UPGRADE_OFFER_ID,
  "buyMaxHp",
  "buyDamage",
  "buyMoveSpeed",
  "buyArmor",
  "buyRegen",
  "buyPickupRadius",
  MERGE_OFFER_ID,
] as const satisfies readonly string[];

export type OfferId = (typeof OFFER_IDS)[number];
