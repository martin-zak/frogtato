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

export const OFFER_IDS = [
  "buyTongueLash",
  "buyBubbleBlaster",
  "buyCroakNova",
  UPGRADE_OFFER_ID,
  "buyMaxHp",
  "buyDamage",
  "buyMoveSpeed",
] as const satisfies readonly string[];

export type OfferId = (typeof OFFER_IDS)[number];
